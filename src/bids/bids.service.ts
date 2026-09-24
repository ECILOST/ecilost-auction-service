import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BidStatus, Prisma, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WalletHoldClient } from '../events/wallet-hold.client.js';

type PlacedBid = {
  id: string;
  roundId: string;
  bidderId: string;
  amount: Prisma.Decimal;
  sequence: bigint;
  previousBidderId: string | null;
  previousPrice: Prisma.Decimal | null;
  status: BidStatus;
};

@Injectable()
export class BidsService {
  constructor(private readonly prisma: PrismaService, private readonly wallet: WalletHoldClient) {}
  async place(roundId: string, bidderId: string, amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Bid amount must be positive.');
    const bidAmount = new Prisma.Decimal(amount);
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, select: { status: true, currentPrice: true } });
    if (!round) throw new NotFoundException('Round does not exist.');
    if (round.status !== RoundStatus.ACTIVE) throw new ConflictException('Round is not active.');
    if (bidAmount.lte(round.currentPrice)) throw new ConflictException('Bid must improve the current price.');
    const accepted = await this.wallet.hold(bidderId, `bid:${roundId}:${bidderId}`, amount);
    if (!accepted) throw new ConflictException('Insufficient available ECICoin.');

    const placed = await this.compareAndPlace(roundId, bidderId, bidAmount);
    if (!placed) {
      await this.wallet.release(bidderId, `bid:${roundId}:${bidderId}`, amount);
      throw new ConflictException('Round is not active.');
    }
    if (placed.status === BidStatus.REJECTED) {
      // El intento se conserva en el historial, pero la reserva previa se revierte.
      await this.wallet.release(bidderId, `bid:${roundId}:${bidderId}`, amount);
      throw new ConflictException('Bid must improve the current price.');
    }
    if (placed.previousBidderId && placed.previousBidderId !== bidderId && placed.previousPrice) {
      const released = await this.wallet.release(placed.previousBidderId, `bid:${roundId}:${placed.previousBidderId}`, Number(placed.previousPrice));
      if (!released) throw new ConflictException('The previous bid could not be released.');
    }
    return { id: placed.id, roundId: placed.roundId, bidderId: placed.bidderId, amount: placed.amount, sequence: placed.sequence };
  }

  /**
   * Bloquea únicamente la fila de la ronda, asigna una secuencia total e inserta
   * el intento (aceptado o rechazado) en una sola sentencia local. La fila de la
   * ronda, no el proceso Nest ni el WebSocket, serializa el precio.
   */
  private async compareAndPlace(roundId: string, bidderId: string, amount: Prisma.Decimal): Promise<PlacedBid | null> {
    const rows = await this.prisma.$queryRaw<PlacedBid[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id, "roomId", position, "currentBidderId", "currentPrice"
        FROM "rounds"
        WHERE id = ${roundId}
          AND status = CAST(${RoundStatus.ACTIVE} AS "RoundStatus")
          AND "endsAt" > CURRENT_TIMESTAMP
        FOR UPDATE
      ), sequenced AS (
        UPDATE "rounds" AS round
        SET
          "nextBidSequence" = round."nextBidSequence" + 1,
          "currentPrice" = CASE WHEN candidate."currentPrice" < ${amount} THEN ${amount} ELSE round."currentPrice" END,
          "currentBidderId" = CASE WHEN candidate."currentPrice" < ${amount} THEN ${bidderId} ELSE round."currentBidderId" END,
          "endsAt" = CASE WHEN candidate."currentPrice" < ${amount} AND round."endsAt" < round."maximumEndsAt" THEN LEAST(round."endsAt" + INTERVAL '10 seconds', round."maximumEndsAt") ELSE round."endsAt" END
        FROM candidate
        WHERE round.id = candidate.id
        RETURNING candidate."currentBidderId" AS "previousBidderId", candidate."currentPrice" AS "previousPrice", candidate."roomId" AS "roomId", candidate.position AS position, round."currentPrice" AS "currentPrice", round."currentBidderId" AS "currentBidderId", round."endsAt" AS "endsAt", round."nextBidSequence" AS sequence
      ), placed_bid AS (
        INSERT INTO "bids" (id, "roundId", "bidderId", amount, sequence, status, "createdAt", "updatedAt")
        SELECT ${randomUUID()}, ${roundId}, ${bidderId}, ${amount}, sequenced.sequence,
          CASE WHEN sequenced."previousPrice" < ${amount} THEN CAST('ACCEPTED' AS "BidStatus") ELSE CAST('REJECTED' AS "BidStatus") END,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM sequenced
        RETURNING id, "roundId", "bidderId", amount, sequence, status
      ),
      outbox_event AS (
        INSERT INTO "outbox_events" ("id", "eventType", "routingKey", "aggregateId", "aggregateSequence", "payload")
        SELECT
          placed_bid.id,
          'auction.bid.accepted.v1',
          'auction.bid.accepted.v1',
          placed_bid."roundId",
          placed_bid.sequence,
          jsonb_build_object(
            'eventId', placed_bid.id,
            'eventType', 'auction.bid.accepted.v1',
            'occurredAt', to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'roomId', sequenced."roomId",
            'roundId', placed_bid."roundId",
            'position', sequenced.position,
            'bidId', placed_bid.id,
            'bidderId', placed_bid."bidderId",
            'amount', placed_bid.amount::text,
            'previousBidderId', sequenced."previousBidderId",
            'previousPrice', sequenced."previousPrice"::text,
            'currentBidderId', sequenced."currentBidderId",
            'currentPrice', sequenced."currentPrice"::text,
            'endsAt', to_char(sequenced."endsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'sequence', placed_bid.sequence::text
          )
        FROM placed_bid CROSS JOIN sequenced
        WHERE placed_bid.status = CAST('ACCEPTED' AS "BidStatus")
        RETURNING id
      )
      SELECT placed_bid.*, sequenced."previousBidderId", sequenced."previousPrice"
      FROM placed_bid CROSS JOIN sequenced
    `);
    return rows[0] ?? null;
  }
}
