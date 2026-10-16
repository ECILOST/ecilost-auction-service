import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, RoundMode, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WalletHoldClient } from '../events/wallet-hold.client.js';
import { BidsService, holdReference } from './bids.service.js';

const SEALED_PLACED = 'auction.round.sealed-bid.placed.v1';

export type SealedBidReceipt = { roundId: string; amount: Prisma.Decimal; sealedAt: Date; sealedCount: number };

export type SealedResults = {
  roundId: string;
  sealedCount: number;
  /** Todos los sobres abiertos, del mas alto al mas bajo; en empate, el que se sello primero. */
  ranking: Array<{ rank: number; amount: Prisma.Decimal; mine: boolean; winner: boolean }>;
  myRank: number | null;
};

/**
 * Sobre cerrado (ADR-0003): cada estudiante puja una sola vez y a ciegas; al vencer la ronda
 * gana la puja mas alta (`resolveSealedRound`).
 *
 * El monto se reserva en wallet al sellar, con la misma referencia que una puja normal: al
 * liquidar la ronda wallet cobra al ganador y libera a los demas sin saber que fue sellada.
 * Mientras la ronda esta abierta nadie ve los montos, ni siquiera el funcionario: solo cuantos
 * sobres hay.
 */
@Injectable()
export class SealedBidsService {
  private readonly logger = new Logger(SealedBidsService.name);

  constructor(private readonly prisma: PrismaService, private readonly bids: BidsService, private readonly wallet: WalletHoldClient) {}

  async seal(roundId: string, bidderId: string, amount: number): Promise<SealedBidReceipt> {
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('La puja debe ser un numero entero positivo.');
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: {
        mode: true, status: true, startingPrice: true,
        room: { select: { participants: { where: { userId: bidderId }, select: { id: true }, take: 1 } } },
      },
    });
    if (!round) throw new NotFoundException('La ronda no existe.');
    if (round.room.participants.length === 0) throw new ForbiddenException('Debes estar admitido en la sala para pujar.');
    if (round.mode !== RoundMode.SEALED) throw new ConflictException('Esta ronda no es de sobre cerrado.');
    if (round.status !== RoundStatus.ACTIVE) throw new ConflictException('La ronda no esta activa.');
    if (round.startingPrice.gt(amount)) throw new ConflictException(`La puja debe ser de al menos ${round.startingPrice.toString()} ECICoin.`);

    const receipt = await this.bids.withBidderLock(roundId, bidderId, async () => {
      const existing = await this.prisma.sealedBid.findUnique({ where: { roundId_bidderId: { roundId, bidderId } }, select: { id: true } });
      if (existing) throw new ConflictException('Ya sellaste tu puja en esta ronda: no se puede cambiar.');

      const reference = holdReference(roundId, bidderId);
      let accepted: boolean;
      try {
        accepted = await this.wallet.hold(bidderId, reference, amount);
      } catch (error) {
        await this.wallet.release(bidderId, reference, amount).catch(() => undefined);
        throw error;
      }
      if (!accepted) throw new ConflictException('No tienes ECICoin disponibles suficientes para esta puja.');

      try {
        const stored = await this.store(roundId, bidderId, amount);
        if (stored) return stored;
      } catch (error) {
        await this.wallet.release(bidderId, reference, amount).catch(() => undefined);
        throw error;
      }
      // La ronda cerro mientras se reservaba: el sobre no entra y la reserva se devuelve.
      await this.wallet.release(bidderId, reference, amount);
      throw new ConflictException('La ronda ya cerro.');
    });
    this.logger.log(`round=${roundId} bidder=${bidderId} sealed amount=${amount} count=${receipt.sealedCount}`);
    return receipt;
  }

  /**
   * Guarda el sobre si la ronda sigue abierta, bajo el bloqueo de su fila: un sobre entra antes
   * del cierre (que bloquea la misma fila) o no entra. El bloqueo tambien ordena los sobres
   * entre si, asi que el conteo publicado es exacto: con `FOR SHARE` dos sobres simultaneos
   * contaban cada uno sin ver al otro y publicaban el mismo numero.
   */
  private store(roundId: string, bidderId: string, amount: number) {
    return this.prisma.$transaction(async (tx) => {
      const [open] = await tx.$queryRaw<Array<{ roomId: string; position: number }>>`
        SELECT "roomId", position FROM "rounds"
        WHERE id = ${roundId}
          AND status = CAST(${RoundStatus.ACTIVE} AS "RoundStatus")
          AND mode = CAST(${RoundMode.SEALED} AS "RoundMode")
          AND "endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        FOR UPDATE
      `;
      if (!open) return null;
      const sealed = await tx.sealedBid.create({
        data: { id: randomUUID(), roundId, bidderId, amount: new Prisma.Decimal(amount) },
        select: { amount: true, createdAt: true },
      });
      const sealedCount = await tx.sealedBid.count({ where: { roundId } });
      const eventId = randomUUID();
      // Solo el conteo: ni el monto ni quien sello salen de auction mientras la ronda esta abierta.
      await tx.outboxEvent.create({
        data: {
          id: eventId, eventType: SEALED_PLACED, routingKey: SEALED_PLACED, aggregateId: roundId,
          payload: {
            eventId, eventType: SEALED_PLACED, occurredAt: new Date().toISOString(),
            roomId: open.roomId, roundId, position: open.position, sealedCount,
          },
        },
      });
      return { roundId, amount: sealed.amount, sealedAt: sealed.createdAt, sealedCount };
    });
  }

  /**
   * Apertura de sobres: solo cuando la ronda ya cerro. La ven quienes participaron en la sala y
   * su dueño. Los demas sobres van sin nombre: se sabe el puesto y el monto, no de quien es.
   */
  async results(roundId: string, viewerId: string): Promise<SealedResults> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: {
        mode: true, status: true, winnerId: true,
        room: { select: { scheduledBy: true, participants: { where: { userId: viewerId }, select: { id: true }, take: 1 } } },
      },
    });
    if (!round) throw new NotFoundException('La ronda no existe.');
    if (round.room.participants.length === 0 && round.room.scheduledBy !== viewerId) {
      throw new ForbiddenException('Solo los participantes de la sala ven la apertura de sobres.');
    }
    if (round.mode !== RoundMode.SEALED) throw new ConflictException('Esta ronda no es de sobre cerrado.');
    if (round.status !== RoundStatus.CLOSED) throw new ConflictException('Los sobres se abren cuando la ronda cierra.');

    const sealed = await this.prisma.sealedBid.findMany({
      where: { roundId },
      orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { bidderId: true, amount: true },
    });
    const ranking = sealed.map((bid, index) => ({
      rank: index + 1,
      amount: bid.amount,
      mine: bid.bidderId === viewerId,
      winner: index === 0 && bid.bidderId === round.winnerId,
    }));
    return { roundId, sealedCount: sealed.length, ranking, myRank: ranking.find((row) => row.mine)?.rank ?? null };
  }
}
