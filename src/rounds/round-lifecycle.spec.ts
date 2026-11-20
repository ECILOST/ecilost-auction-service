import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma, RoomStatus, RoundMode } from '../generated/prisma/client.js';
import { closeRoundAndAdvance, enqueueRoundEvent, resolveSealedRound, type RoundEventSnapshot } from './round-lifecycle.js';

const round: RoundEventSnapshot = {
  id: 'round', roomId: 'room', position: 1, currentPrice: new Prisma.Decimal(150),
  currentBidderId: null, startedAt: null, endsAt: null, maximumEndsAt: null, entries: [],
  mode: RoundMode.DUTCH, dutchStartPrice: new Prisma.Decimal(200), dutchFloorPrice: new Prisma.Decimal(100),
  dutchStep: new Prisma.Decimal(10), dutchIntervalSeconds: 15,
};

describe('round lifecycle', () => {
  it('includes Dutch pricing in an activation event and preserves missing timestamps', async () => {
    const create = vi.fn();
    await enqueueRoundEvent({ outboxEvent: { create } } as unknown as Prisma.TransactionClient,
      'auction.round.activated.v1', round, RoomStatus.ACTIVE);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: round.id, routingKey: 'auction.round.activated.v1',
        payload: expect.objectContaining({
          roundId: round.id, roomStatus: 'ACTIVE', startedAt: null, endsAt: null, maximumEndsAt: null,
          dutch: { startPrice: '200', floorPrice: '100', step: '10', intervalSeconds: 15 },
        }),
      }),
    });
    expect(create.mock.calls[0][0].data.payload).not.toHaveProperty('winnerId');
  });

  it('leaves a sealed round without bids unchanged', async () => {
    const sealed = { ...round, mode: RoundMode.SEALED };
    const findFirst = vi.fn().mockResolvedValue(null);
    const update = vi.fn();
    const tx = { sealedBid: { findFirst }, round: { update } } as unknown as Prisma.TransactionClient;

    await expect(resolveSealedRound(tx, sealed)).resolves.toBe(sealed);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { roundId: sealed.id },
      orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }));
    expect(update).not.toHaveBeenCalled();
  });
});

describe('round advancement', () => {
  it('does not announce the next round when the conditional activation updates no rows', async () => {
    const update = vi.fn();
    const findFirst = vi.fn().mockResolvedValue({ id: 'next-round' });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn();
    const roomUpdate = vi.fn();
    const create = vi.fn();
    const tx = {
      round: { update, findFirst, updateMany, findUnique },
      room: { updateMany: roomUpdate },
      outboxEvent: { create },
    } as unknown as Prisma.TransactionClient;
    const now = new Date('2030-01-01T00:00:00Z');
    const closing = { result: 'DESERTED', winnerId: null, closeReason: 'EXPIRED' } as const;

    await closeRoundAndAdvance(tx, round, now, closing, new Logger('round-test'));

    expect(update).toHaveBeenCalledWith({
      where: { id: round.id }, data: { status: 'CLOSED', closedAt: now, ...closing },
    });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'next-round', status: 'SCHEDULED' },
      data: expect.objectContaining({ status: 'ACTIVE', startedAt: now }),
    }));
    expect(findUnique).not.toHaveBeenCalled();
    expect(roomUpdate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        routingKey: 'auction.round.closed.v1',
        payload: expect.objectContaining({ roomStatus: 'ACTIVE', winnerId: null }),
      }),
    });
  });

  it('promotes the selected sealed bid to the current price and bidder', async () => {
    const sealed = { ...round, mode: RoundMode.SEALED };
    const highest = { bidderId: 'student', amount: new Prisma.Decimal(210) };
    const result = { ...sealed, currentBidderId: highest.bidderId, currentPrice: highest.amount };
    const findFirst = vi.fn().mockResolvedValue(highest);
    const update = vi.fn().mockResolvedValue(result);
    const tx = { sealedBid: { findFirst }, round: { update } } as unknown as Prisma.TransactionClient;

    await expect(resolveSealedRound(tx, sealed)).resolves.toBe(result);
    expect(update).toHaveBeenCalledWith({
      where: { id: round.id },
      data: { currentPrice: highest.amount, currentBidderId: highest.bidderId },
      select: expect.objectContaining({ currentPrice: true, currentBidderId: true }),
    });
  });
});
