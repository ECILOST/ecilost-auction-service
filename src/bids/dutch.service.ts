import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, RoundCloseReason, RoundMode, RoundResult, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WalletHoldClient } from '../events/wallet-hold.client.js';
import { closeRoundAndAdvance, ROUND_EVENT_SELECT } from '../rounds/round-lifecycle.js';
import { BidsService, holdReference } from './bids.service.js';

export type DutchClaimResult = {
  roundId: string;
  roomId: string;
  buyerId: string;
  price: Prisma.Decimal;
  closedAt: Date;
  /** El mismo estudiante ya lo habia pedido: se responde igual, sin cobrar de nuevo. */
  replayed: boolean;
};

/**
 * Precio holandes vigente segun el reloj de PostgreSQL, el mismo que abre y cierra rondas: baja
 * un escalon cada intervalo desde que la ronda se abrio y nunca pasa del minimo.
 */
const DUTCH_PRICE = Prisma.sql`GREATEST(
  "dutchFloorPrice",
  "dutchStartPrice" - "dutchStep" * FLOOR(
    EXTRACT(EPOCH FROM ((clock_timestamp() AT TIME ZONE 'UTC') - "startedAt")) / "dutchIntervalSeconds"
  )
)`;

/**
 * Subasta holandesa (ADR-0003): el precio baja y el primero que pulsa "Lo quiero" se lleva el
 * objeto al precio de ese instante.
 *
 * Es la compra inmediata (ADR-0002) con un precio que cambia: se reserva en wallet el precio
 * vigente, se cierra la ronda bajo el bloqueo de su fila con el precio que diga PostgreSQL en
 * ese momento y, si otro llego antes, se deshace la reserva. Como el precio solo baja, el del
 * cierre nunca supera lo reservado: wallet cobra `winningAmount` y devuelve el excedente.
 */
@Injectable()
export class DutchService {
  private readonly logger = new Logger(DutchService.name);

  constructor(private readonly prisma: PrismaService, private readonly bids: BidsService, private readonly wallet: WalletHoldClient) {}

  async claim(roundId: string, buyerId: string): Promise<DutchClaimResult> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: { mode: true, room: { select: { participants: { where: { userId: buyerId }, select: { id: true }, take: 1 } } } },
    });
    if (!round) throw new NotFoundException('La ronda no existe.');
    if (round.room.participants.length === 0) throw new ForbiddenException('Debes estar admitido en la sala para participar.');
    if (round.mode !== RoundMode.DUTCH) throw new ConflictException('Esta ronda no es holandesa.');

    const result = await this.bids.withBidderLock(roundId, buyerId, async () => {
      const state = await this.prisma.round.findUniqueOrThrow({
        where: { id: roundId },
        select: { roomId: true, status: true, currentPrice: true, winnerId: true, closedAt: true, closeReason: true },
      });
      if (state.status === RoundStatus.CLOSED && state.closeReason === RoundCloseReason.DUTCH_CLAIM && state.winnerId === buyerId && state.closedAt) {
        return { roundId, roomId: state.roomId, buyerId, price: state.currentPrice, closedAt: state.closedAt, replayed: true };
      }
      if (state.status !== RoundStatus.ACTIVE) throw new ConflictException('La ronda no esta activa.');

      const [quote] = await this.prisma.$queryRaw<Array<{ price: string }>>`
        SELECT (${DUTCH_PRICE})::text AS price FROM "rounds" WHERE id = ${roundId}
      `;
      if (!quote) throw new ConflictException('La ronda no esta activa.');
      const quoted = Number(quote.price);
      const reference = holdReference(roundId, buyerId);
      let accepted: boolean;
      try {
        accepted = await this.wallet.hold(buyerId, reference, quoted);
      } catch (error) {
        await this.bids.restoreHold(roundId, buyerId, quoted).catch(() => undefined);
        throw error;
      }
      if (!accepted) throw new ConflictException('No tienes ECICoin disponibles suficientes para llevartelo a este precio.');

      let closed: Omit<DutchClaimResult, 'replayed'> | null;
      try {
        closed = await this.closeByClaim(roundId, buyerId);
      } catch (error) {
        await this.bids.restoreHold(roundId, buyerId, quoted).catch(() => undefined);
        throw error;
      }
      if (!closed) {
        // Otro estudiante lo pidio primero o la ronda vencio.
        await this.bids.restoreHold(roundId, buyerId, quoted);
        throw new ConflictException('Alguien lo pidio antes que tu.');
      }
      return { ...closed, replayed: false };
    });

    this.logger.log(`round=${roundId} buyer=${buyerId} price=${result.price.toString()} dutch-claim${result.replayed ? ' replayed' : ''}`);
    return result;
  }

  /** Cierra a favor de quien pulso, si la fila bloqueada sigue siendo una holandesa abierta. */
  private closeByClaim(roundId: string, buyerId: string) {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ price: string; now: string }>>`
        SELECT (${DUTCH_PRICE})::text AS price,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
        FROM "rounds"
        WHERE id = ${roundId}
          AND status = CAST(${RoundStatus.ACTIVE} AS "RoundStatus")
          AND mode = CAST(${RoundMode.DUTCH} AS "RoundMode")
          AND "endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        FOR UPDATE
      `;
      if (!locked) return null;
      const now = new Date(locked.now);
      const round = await tx.round.update({
        where: { id: roundId },
        data: { currentPrice: new Prisma.Decimal(locked.price), currentBidderId: buyerId },
        select: ROUND_EVENT_SELECT,
      });
      await closeRoundAndAdvance(tx, round, now, {
        result: RoundResult.AWARDED, winnerId: buyerId, closeReason: RoundCloseReason.DUTCH_CLAIM,
      }, this.logger);
      return { roundId, roomId: round.roomId, buyerId, price: round.currentPrice, closedAt: now };
    });
  }
}
