import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, RoundCloseReason, RoundMode, RoundResult, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WalletHoldClient } from '../events/wallet-hold.client.js';
import { closeRoundAndAdvance, ROUND_EVENT_SELECT } from '../rounds/round-lifecycle.js';
import { acceptsAscendingBids } from '../rounds/round-modes.js';
import { BidsService, holdReference } from './bids.service.js';

/** Lo que responde una compra inmediata. Sale de lo persistido, nunca de lo que mando el cliente. */
export type BuyNowResult = {
  roundId: string;
  roomId: string;
  buyerId: string;
  price: Prisma.Decimal;
  closedAt: Date;
  /** La compra ya estaba hecha por este mismo estudiante: se responde igual, sin cobrar de nuevo. */
  replayed: boolean;
};

const PURCHASE_STATE_SELECT = {
  roomId: true, status: true, currentPrice: true, buyNowPrice: true, winnerId: true, closedAt: true, closeReason: true, mode: true,
} as const;

/**
 * Compra inmediata (HU-24, F4.4): el estudiante se lleva el objeto de la ronda por el precio
 * que fijo el funcionario y la ronda se cierra en el acto.
 *
 * No hay transaccion distribuida: el cobro sale de la misma liquidacion que cualquier ronda
 * adjudicada. Primero se reserva en wallet el precio de compra (la reserva unica del
 * estudiante en la ronda), luego se cierra la ronda bajo el bloqueo de su fila y, si ya no se
 * puede, se deshace la reserva. Al publicarse el cierre, wallet debita la reserva del
 * comprador y libera las de los demas; catalog marca vendido el objeto.
 */
@Injectable()
export class BuyNowService {
  private readonly logger = new Logger(BuyNowService.name);

  constructor(private readonly prisma: PrismaService, private readonly bids: BidsService, private readonly wallet: WalletHoldClient) {}

  async buy(roundId: string, buyerId: string): Promise<BuyNowResult> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: { room: { select: { participants: { where: { userId: buyerId }, select: { id: true }, take: 1 } } } },
    });
    if (!round) throw new NotFoundException('La ronda no existe.');
    // HU-17: solo compra quien se registro antes del inicio, igual que para pujar.
    if (round.room.participants.length === 0) throw new ForbiddenException('Debes estar admitido en la sala para comprar.');

    // El mismo candado que sus pujas: un doble clic, su puja automatica o la liberacion de una
    // puja superada no pueden pisar la reserva mientras se decide la compra.
    const result = await this.bids.withBidderLock(roundId, buyerId, async () => {
      const state = await this.prisma.round.findUniqueOrThrow({ where: { id: roundId }, select: PURCHASE_STATE_SELECT });
      if (
        state.status === RoundStatus.CLOSED && state.closeReason === RoundCloseReason.BUY_NOW &&
        state.winnerId === buyerId && state.closedAt
      ) {
        // Reintento de una compra que ya se hizo (respuesta perdida, reconexion): no se toca wallet.
        return { roundId, roomId: state.roomId, buyerId, price: state.currentPrice, closedAt: state.closedAt, replayed: true };
      }
      // Todo lo que se puede rechazar se rechaza antes de reservar: una ronda cerrada nunca
      // vuelve a recibir una reserva, que wallet ya no liberaria al liquidar.
      if (state.status !== RoundStatus.ACTIVE) throw new ConflictException('La ronda no esta activa.');
      // ADR-0003: en holandesa y sobre cerrado el precio de compra no aplica.
      if (!state.buyNowPrice || !acceptsAscendingBids(state.mode)) throw new ConflictException('Esta ronda no ofrece compra inmediata.');
      if (state.currentPrice.gte(state.buyNowPrice)) {
        throw new ConflictException('Las pujas ya alcanzaron el precio de compra inmediata.');
      }

      const price = Number(state.buyNowPrice);
      const reference = holdReference(roundId, buyerId);
      let accepted: boolean;
      try {
        // Fija la reserva en el precio de compra: si ya lideraba, wallet solo reserva la diferencia.
        accepted = await this.wallet.hold(buyerId, reference, price);
      } catch (error) {
        // Sin respuesta no se sabe si wallet alcanzo a reservar: se deshace por si acaso.
        await this.bids.restoreHold(roundId, buyerId, price).catch(() => undefined);
        throw error;
      }
      if (!accepted) throw new ConflictException('No tienes ECICoin disponibles suficientes para la compra inmediata.');

      let closed: Omit<BuyNowResult, 'replayed'> | null;
      try {
        closed = await this.closeByPurchase(roundId, buyerId);
      } catch (error) {
        await this.bids.restoreHold(roundId, buyerId, price).catch(() => undefined);
        throw error;
      }
      if (!closed) {
        // Otra compra, una puja que alcanzo el precio o el vencimiento llegaron primero.
        await this.bids.restoreHold(roundId, buyerId, price);
        throw new ConflictException('La ronda ya no admite compra inmediata.');
      }
      return { ...closed, replayed: false };
    });

    this.logger.log(
      `round=${roundId} buyer=${buyerId} price=${result.price.toString()} buy-now${result.replayed ? ' replayed' : ''} closedAt=${result.closedAt.toISOString()}`,
    );
    return result;
  }

  /**
   * Cierra la ronda a favor del comprador si, sobre la fila bloqueada, todavia admite compra
   * inmediata. La fila de la ronda es el arbitro: dos compras, una compra y una puja, o una
   * compra y el vencimiento se ordenan por ella, y solo la primera encuentra la ronda ACTIVE.
   * La hora la pone PostgreSQL, como en el resto del ciclo de vida.
   */
  private closeByPurchase(roundId: string, buyerId: string) {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ buyNowPrice: string; now: string }>>`
        SELECT "buyNowPrice"::text AS "buyNowPrice",
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
        FROM "rounds"
        WHERE id = ${roundId}
          AND status = CAST(${RoundStatus.ACTIVE} AS "RoundStatus")
          AND "endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
          AND "buyNowPrice" IS NOT NULL
          AND "currentPrice" < "buyNowPrice"
          AND mode IN (CAST(${RoundMode.CLASSIC} AS "RoundMode"), CAST(${RoundMode.MYSTERY} AS "RoundMode"))
        FOR UPDATE
      `;
      if (!locked) return null;
      const now = new Date(locked.now);
      // El comprador queda como lider al precio de compra: es lo que wallet cobra y lo que ve la sala.
      const round = await tx.round.update({
        where: { id: roundId },
        data: { currentPrice: new Prisma.Decimal(locked.buyNowPrice), currentBidderId: buyerId },
        select: ROUND_EVENT_SELECT,
      });
      await closeRoundAndAdvance(tx, round, now, {
        result: RoundResult.AWARDED, winnerId: buyerId, closeReason: RoundCloseReason.BUY_NOW,
      }, this.logger);
      return { roundId, roomId: round.roomId, buyerId, price: round.currentPrice, closedAt: now };
    });
  }
}
