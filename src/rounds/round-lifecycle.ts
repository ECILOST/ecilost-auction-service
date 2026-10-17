import { randomUUID } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import { Prisma, RoomStatus, RoundCloseReason, RoundMode, RoundResult, RoundStatus } from '../generated/prisma/client.js';

const ROUND_DURATION_MS = 3 * 60 * 1000;
const MAX_ROUND_DURATION_MS = 8 * 60 * 1000;

export function roundTiming(startedAt: Date) {
  return {
    startedAt,
    endsAt: new Date(startedAt.getTime() + ROUND_DURATION_MS),
    maximumEndsAt: new Date(startedAt.getTime() + MAX_ROUND_DURATION_MS),
  };
}

export type RoundEventSnapshot = {
  id: string;
  roomId: string;
  position: number;
  currentPrice: Prisma.Decimal;
  currentBidderId: string | null;
  startedAt: Date | null;
  endsAt: Date | null;
  maximumEndsAt: Date | null;
  entries: Array<{ kind: string; catalogId: string }>;
  /** Subastas dinamicas (ADR-0003). Las rondas que no pasaron por la ruleta son CLASSIC. */
  mode: RoundMode;
  dutchStartPrice: Prisma.Decimal | null;
  dutchFloorPrice: Prisma.Decimal | null;
  dutchStep: Prisma.Decimal | null;
  dutchIntervalSeconds: number | null;
};

export const ROUND_EVENT_SELECT = {
  id: true, roomId: true, position: true, currentPrice: true, currentBidderId: true,
  startedAt: true, endsAt: true, maximumEndsAt: true,
  entries: { select: { kind: true, catalogId: true } },
  mode: true, dutchStartPrice: true, dutchFloorPrice: true, dutchStep: true, dutchIntervalSeconds: true,
} as const;

/** Con que resultado se cierra una ronda: quien la gana, si alguien la gana, y que la cerro. */
export type RoundClosing = { result: RoundResult; winnerId: string | null; closeReason: RoundCloseReason };

export async function enqueueRoundEvent(
  tx: Prisma.TransactionClient,
  eventType: 'auction.round.activated.v1' | 'auction.round.closed.v1',
  round: RoundEventSnapshot,
  roomStatus: RoomStatus,
  closing?: RoundClosing & { closedAt: Date },
) {
  const eventId = randomUUID();
  await tx.outboxEvent.create({
    data: {
      id: eventId,
      eventType,
      routingKey: eventType,
      aggregateId: round.id,
      payload: {
        eventId,
        eventType,
        occurredAt: new Date().toISOString(),
        roomId: round.roomId,
        roundId: round.id,
        position: round.position,
        // Estado de la sala tras la transicion: la ultima ronda cerrada deja la sala CLOSED.
        roomStatus,
        currentPrice: round.currentPrice.toString(),
        currentBidderId: round.currentBidderId,
        startedAt: round.startedAt?.toISOString() ?? null,
        endsAt: round.endsAt?.toISOString() ?? null,
        maximumEndsAt: round.maximumEndsAt?.toISOString() ?? null,
        entries: round.entries.map((entry) => ({ kind: entry.kind, catalogId: entry.catalogId })),
        // Campos agregados (ADR-0003). Los consumidores anteriores los ignoran.
        mode: round.mode,
        dutch: round.mode === RoundMode.DUTCH && round.dutchStartPrice && round.dutchFloorPrice && round.dutchStep
          ? {
              startPrice: round.dutchStartPrice.toString(),
              floorPrice: round.dutchFloorPrice.toString(),
              step: round.dutchStep.toString(),
              intervalSeconds: round.dutchIntervalSeconds,
            }
          : null,
        // Wallet cobra y libera, y catalog vende o devuelve, a partir de estos tres campos.
        ...(closing
          ? {
              closedAt: closing.closedAt.toISOString(),
              result: closing.result,
              winnerId: closing.winnerId,
              winningAmount: closing.winnerId ? round.currentPrice.toString() : null,
              // Campo agregado (HU-24): EXPIRED, BUY_NOW o DUTCH_CLAIM. Los consumidores anteriores lo ignoran.
              closeReason: closing.closeReason,
            }
          : {}),
      },
    },
  });
}

/**
 * Cierra una ronda y encadena la sala, todo dentro de la transaccion de quien llama (HU-18,
 * HU-19, HU-28). Es el unico lugar que cierra rondas: el vencimiento del reloj y cualquier
 * otro cierre comparten la misma secuencia y los mismos eventos.
 *
 * Quien llama ya bloqueo la fila de la ronda (`FOR UPDATE`) y leyo `round` despues de ese
 * bloqueo, asi que el lider leido es definitivo.
 *
 * - La ronda pasa a CLOSED con su resultado y su ganador.
 * - Si era la ultima, la sala pasa a CLOSED; si no, la siguiente se abre en el mismo instante.
 * - Los eventos se encolan en el outbox: se publican solo si la transaccion confirma.
 */
export async function closeRoundAndAdvance(
  tx: Prisma.TransactionClient,
  round: RoundEventSnapshot,
  now: Date,
  closing: RoundClosing,
  logger: Logger,
) {
  const { result, winnerId, closeReason } = closing;
  await tx.round.update({
    where: { id: round.id },
    data: { status: RoundStatus.CLOSED, result, winnerId, closedAt: now, closeReason },
  });
  logger.log(
    `room=${round.roomId} round=${round.id} position=${round.position} ACTIVE -> CLOSED result=${result} reason=${closeReason} price=${round.currentPrice.toString()} at=${now.toISOString()}`,
  );

  const nextRound = await tx.round.findFirst({
    where: { roomId: round.roomId, position: { gt: round.position }, status: RoundStatus.SCHEDULED },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  if (!nextRound) {
    await tx.room.updateMany({
      where: { id: round.roomId, status: RoomStatus.ACTIVE },
      data: { status: RoomStatus.CLOSED },
    });
    logger.log(`room=${round.roomId} ACTIVE -> CLOSED (ultima ronda) at=${now.toISOString()}`);
  }
  await enqueueRoundEvent(tx, 'auction.round.closed.v1', round, nextRound ? RoomStatus.ACTIVE : RoomStatus.CLOSED, {
    ...closing, closedAt: now,
  });
  if (!nextRound) return;

  const activated = await tx.round.updateMany({
    where: { id: nextRound.id, status: RoundStatus.SCHEDULED },
    data: { status: RoundStatus.ACTIVE, ...roundTiming(now) },
  });
  if (activated.count === 1) {
    const activatedRound = await tx.round.findUnique({ where: { id: nextRound.id }, select: ROUND_EVENT_SELECT });
    if (activatedRound) {
      await enqueueRoundEvent(tx, 'auction.round.activated.v1', activatedRound, RoomStatus.ACTIVE);
      logger.log(
        `room=${activatedRound.roomId} round=${activatedRound.id} position=${activatedRound.position} SCHEDULED -> ACTIVE endsAt=${activatedRound.endsAt?.toISOString()}`,
      );
    }
  }
}

/**
 * Sobre cerrado (ADR-0003): al vencer la ronda, la puja sellada mas alta pasa a ser el precio
 * y el lider, y en empate gana la que se sello primero. Asi el cierre comun
 * (`closeRoundAndAdvance`) adjudica, publica `winningAmount` y wallet cobra al ganador y
 * libera a los demas exactamente como en cualquier ronda.
 *
 * Quien llama ya bloqueo la fila de la ronda: una puja sellada que llega a la vez espera ese
 * bloqueo y, al obtenerlo, la ronda ya no esta ACTIVE y se rechaza.
 */
export async function resolveSealedRound(tx: Prisma.TransactionClient, round: RoundEventSnapshot): Promise<RoundEventSnapshot> {
  if (round.mode !== RoundMode.SEALED) return round;
  const best = await tx.sealedBid.findFirst({
    where: { roundId: round.id },
    orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { bidderId: true, amount: true },
  });
  if (!best) return round;
  return tx.round.update({
    where: { id: round.id },
    data: { currentPrice: best.amount, currentBidderId: best.bidderId },
    select: ROUND_EVENT_SELECT,
  });
}
