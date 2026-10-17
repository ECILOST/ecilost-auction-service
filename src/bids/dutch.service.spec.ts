import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma, RoundCloseReason, RoundMode, RoundStatus } from '../generated/prisma/client.js';
import { DutchService } from './dutch.service.js';

const decimal = (value: number) => new Prisma.Decimal(value);
const closedAt = '2030-01-01T10:01:00.000Z';
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 'round', roomId: 'room', position: 1, currentPrice: decimal(6200), currentBidderId: 'ana',
  startedAt: new Date('2030-01-01T10:00:00Z'), endsAt: new Date('2030-01-01T10:03:00Z'), maximumEndsAt: null,
  entries: [{ kind: 'ITEM', catalogId: 'item' }], mode: RoundMode.DUTCH,
  dutchStartPrice: decimal(8000), dutchFloorPrice: decimal(2000), dutchStep: decimal(300), dutchIntervalSeconds: 5, ...overrides,
});

function setup({ mode = RoundMode.DUTCH as RoundMode, state = { roomId: 'room', status: RoundStatus.ACTIVE, currentPrice: decimal(8000), winnerId: null, closedAt: null, closeReason: null } as Record<string, unknown>, quote = '6400', locked = [{ price: '6200', now: closedAt }] as unknown[], holds = true } = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(locked),
    round: { update: vi.fn().mockResolvedValue(snapshot()), findFirst: vi.fn().mockResolvedValue({ id: 'next' }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn().mockResolvedValue(snapshot({ id: 'next', position: 2 })) },
    room: { updateMany: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    round: { findUnique: vi.fn().mockResolvedValue({ mode, room: { participants: [{ id: 'p' }] } }), findUniqueOrThrow: vi.fn().mockResolvedValue(state) },
    $queryRaw: vi.fn().mockResolvedValue([{ price: quote }]),
    $transaction: (work: (client: unknown) => unknown) => work(tx),
  };
  const wallet = { hold: vi.fn().mockResolvedValue(holds) };
  const bids = { withBidderLock: (_r: string, _b: string, work: () => unknown) => work(), restoreHold: vi.fn().mockResolvedValue(undefined) };
  return { tx, prisma, wallet, bids, service: new DutchService(prisma as never, bids as never, wallet as never) };
}

describe('DutchService (ADR-0003)', () => {
  it('reserva el precio vigente y cierra la ronda al precio que diga la base al bloquearla', async () => {
    const { service, wallet, tx } = setup();
    const result = await service.claim('round', 'ana');
    expect(wallet.hold).toHaveBeenCalledWith('ana', 'bid:round:ana', 6400);
    expect(result).toMatchObject({ buyerId: 'ana', replayed: false });
    expect(result.price.toString()).toBe('6200');
    expect(tx.round.update).toHaveBeenCalledWith(expect.objectContaining({ data: { currentPrice: decimal(6200), currentBidderId: 'ana' } }));
    const closed = tx.outboxEvent.create.mock.calls.map(([args]) => args.data.payload).find((p) => p.eventType === 'auction.round.closed.v1');
    expect(closed).toMatchObject({ result: 'AWARDED', winnerId: 'ana', winningAmount: '6200', closeReason: RoundCloseReason.DUTCH_CLAIM, mode: 'DUTCH' });
  });

  it('si otro lo pidio primero, deshace la reserva y responde 409', async () => {
    const { service, bids, tx } = setup({ locked: [] });
    await expect(service.claim('round', 'ana')).rejects.toThrow('antes que tu');
    expect(bids.restoreHold).toHaveBeenCalledWith('round', 'ana', 6400);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('sin saldo no cierra la ronda', async () => {
    const { service, tx } = setup({ holds: false });
    await expect(service.claim('round', 'ana')).rejects.toThrow('No tienes ECICoin');
    expect(tx.round.update).not.toHaveBeenCalled();
  });

  it('repetir el pedido ya ganado responde lo mismo sin volver a cobrar', async () => {
    const { service, wallet } = setup({
      state: { roomId: 'room', status: RoundStatus.CLOSED, currentPrice: decimal(6200), winnerId: 'ana', closedAt: new Date(closedAt), closeReason: RoundCloseReason.DUTCH_CLAIM },
    });
    await expect(service.claim('round', 'ana')).resolves.toMatchObject({ replayed: true });
    expect(wallet.hold).not.toHaveBeenCalled();
  });

  it('solo en rondas holandesas y para participantes', async () => {
    await expect(setup({ mode: RoundMode.CLASSIC }).service.claim('round', 'ana')).rejects.toBeInstanceOf(ConflictException);
    const outsider = setup();
    outsider.prisma.round.findUnique.mockResolvedValue({ mode: RoundMode.DUTCH, room: { participants: [] } });
    await expect(outsider.service.claim('round', 'ana')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
