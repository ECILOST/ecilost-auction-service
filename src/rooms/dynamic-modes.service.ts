import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, RoomStatus, RoundMode, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { dutchSchedule, MAX_WILDCARD_SPINS, modeOfSegment, SpinSegment, spinRoulette } from '../rounds/round-modes.js';

export type SpinResult = {
  roomId: string;
  roundId: string;
  position: number;
  /** Lo que marco la ruleta. WILDCARD obliga a girar otra vez. */
  segment: SpinSegment;
  /** El modo con que se jugara la ronda, o `null` si salio comodin. */
  mode: RoundMode | null;
  wildcardSpins: number;
  /** Si todavia se puede girar: solo tras un comodin. */
  canSpinAgain: boolean;
};

const MODE_SELECTED = 'auction.round.mode-selected.v1';

/**
 * Subastas dinamicas (ADR-0003): el dueño de la sala las activa y, antes de cada ronda, gira la
 * ruleta que decide como se juega.
 *
 * "Dueño" es quien programo la sala (`rooms.scheduledBy`): ningun otro funcionario puede
 * activarlas ni girar. La ruleta solo actua sobre rondas que aun no empezaron, bajo el
 * bloqueo de su fila: el ciclo de vida, que abre la ronda con la misma fila, espera a que el
 * giro confirme y la abre ya con su modo.
 */
@Injectable()
export class DynamicModesService {
  private readonly logger = new Logger(DynamicModesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Activa o desactiva la ruleta de la sala. Desactivarla devuelve a CLASSIC las rondas que aun
   * no empezaron, aunque ya tuvieran modo: lo que se anuncio deja de valer y se publica para
   * que catalog vuelva a mostrar un lote que se habia ocultado como misterioso.
   */
  async setEnabled(roomId: string, ownerId: string, enabled: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const room = await this.ownedRoom(tx, roomId, ownerId);
      if (room.status !== RoomStatus.SCHEDULED && room.status !== RoomStatus.ACTIVE) {
        throw new ConflictException('La sala ya termino.');
      }
      await tx.room.update({ where: { id: roomId }, data: { dynamicModesEnabled: enabled } });
      if (!enabled) {
        const reverted = await tx.round.findMany({
          where: { roomId, status: RoundStatus.SCHEDULED, modeLockedAt: { not: null } },
          select: { id: true, position: true, entries: { select: { kind: true, catalogId: true } } },
        });
        // El precio vuelve al minimo: una ronda que iba a ser holandesa arrancaba en su precio de salida.
        await tx.$executeRaw`
          UPDATE "rounds"
          SET mode = CAST(${RoundMode.CLASSIC} AS "RoundMode"), "modeLockedAt" = NULL, "wildcardSpins" = 0,
            "dutchStartPrice" = NULL, "dutchFloorPrice" = NULL, "dutchStep" = NULL, "dutchIntervalSeconds" = NULL,
            "currentPrice" = "startingPrice"
          WHERE "roomId" = ${roomId} AND status = CAST(${RoundStatus.SCHEDULED} AS "RoundStatus")
        `;
        for (const round of reverted) {
          await this.enqueueModeSelected(tx, { roomId, roundId: round.id, position: round.position, segment: null, mode: RoundMode.CLASSIC, wildcardSpins: 0, entries: round.entries });
        }
      }
      this.logger.log(`room=${roomId} owner=${ownerId} dynamicModes=${enabled}`);
      return { roomId, dynamicModesEnabled: enabled };
    });
  }

  /** Gira la ruleta de una ronda que aun no empezo. El azar es del servidor. */
  async spin(roomId: string, roundId: string, ownerId: string): Promise<SpinResult> {
    return this.prisma.$transaction(async (tx) => {
      const room = await this.ownedRoom(tx, roomId, ownerId);
      if (!room.dynamicModesEnabled) throw new ConflictException('Activa las subastas dinamicas de la sala para girar la ruleta.');

      const [round] = await tx.$queryRaw<Array<{ id: string; position: number; status: RoundStatus; wildcardSpins: number; modeLockedAt: Date | null }>>`
        SELECT id, position, status, "wildcardSpins", "modeLockedAt" FROM "rounds"
        WHERE id = ${roundId} AND "roomId" = ${roomId}
        FOR UPDATE
      `;
      if (!round) throw new NotFoundException('La ronda no existe en esta sala.');
      if (round.status !== RoundStatus.SCHEDULED) throw new ConflictException('La ronda ya empezo: la ruleta solo se gira antes.');
      if (round.modeLockedAt) throw new ConflictException('La ruleta ya decidio la modalidad de esta ronda.');

      const segment = spinRoulette(round.wildcardSpins);
      const mode = modeOfSegment(segment);
      const details = await tx.round.findUniqueOrThrow({
        where: { id: roundId },
        select: { startingPrice: true, buyNowPrice: true, entries: { select: { kind: true, catalogId: true } } },
      });

      let wildcardSpins = round.wildcardSpins;
      if (!mode) {
        wildcardSpins += 1;
        await tx.round.update({ where: { id: roundId }, data: { wildcardSpins } });
      } else {
        const dutch = mode === RoundMode.DUTCH ? dutchSchedule(details) : null;
        await tx.round.update({
          where: { id: roundId },
          data: {
            mode,
            modeLockedAt: new Date(),
            dutchStartPrice: dutch?.startPrice ?? null,
            dutchFloorPrice: dutch?.floorPrice ?? null,
            dutchStep: dutch?.step ?? null,
            dutchIntervalSeconds: dutch?.intervalSeconds ?? null,
            // En holandesa la ronda arranca mostrando su precio de salida.
            ...(dutch ? { currentPrice: dutch.startPrice } : {}),
          },
        });
      }
      await this.enqueueModeSelected(tx, { roomId, roundId, position: round.position, segment, mode, wildcardSpins, entries: details.entries });
      this.logger.log(`room=${roomId} round=${roundId} spin=${segment} mode=${mode ?? 'pending'} wildcards=${wildcardSpins}`);
      return {
        roomId, roundId, position: round.position, segment, mode, wildcardSpins,
        canSpinAgain: mode === null,
      };
    });
  }

  private async ownedRoom(tx: Prisma.TransactionClient, roomId: string, ownerId: string) {
    const room = await tx.room.findUnique({ where: { id: roomId }, select: { scheduledBy: true, status: true, dynamicModesEnabled: true } });
    if (!room) throw new NotFoundException('La sala no existe.');
    if (room.scheduledBy !== ownerId) throw new ForbiddenException('Solo quien programo la sala puede usar las subastas dinamicas.');
    return room;
  }

  /**
   * Engagement anima la ruleta en la sala con este evento y catalog oculta los objetos de un
   * lote misterioso (o los vuelve a mostrar si la ronda dejo de serlo).
   */
  private async enqueueModeSelected(
    tx: Prisma.TransactionClient,
    event: {
      roomId: string; roundId: string; position: number; segment: SpinSegment | null; mode: RoundMode | null;
      wildcardSpins: number; entries: Array<{ kind: string; catalogId: string }>;
    },
  ) {
    const eventId = randomUUID();
    await tx.outboxEvent.create({
      data: {
        id: eventId,
        eventType: MODE_SELECTED,
        routingKey: MODE_SELECTED,
        aggregateId: event.roundId,
        payload: {
          eventId,
          eventType: MODE_SELECTED,
          occurredAt: new Date().toISOString(),
          roomId: event.roomId,
          roundId: event.roundId,
          position: event.position,
          segment: event.segment,
          mode: event.mode,
          wildcardSpins: event.wildcardSpins,
          maxWildcardSpins: MAX_WILDCARD_SPINS,
          entries: event.entries.map(({ kind, catalogId }) => ({ kind, catalogId })),
        },
      },
    });
  }
}
