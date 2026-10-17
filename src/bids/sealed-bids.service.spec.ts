import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma, RoundMode, RoundStatus } from '../generated/prisma/client.js';
import { SealedBidsService } from './sealed-bids.service.js';

const decimal = (value: number) => new Prisma.Decimal(value);
const sealedRound = (overrides: Record<string, unknown> = {}) => ({
  mode: RoundMode.SEALED, status: RoundStatus.ACTIVE, startingPrice: decimal(3000),
  room: { participants: [{ id: 'p' }] }, ...overrides,
});

function setup({ round = sealedRound() as Record<string, unknown>, existing = null as unknown, open = [{ roomId: 'room', position: 1 }] as unknown[], holds = true } = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(open),
    sealedBid: { create: vi.fn().mockResolvedValue({ amount: decimal(4750), createdAt: new Date('2030-01-01T10:00:00Z') }), count: vi.fn().mockResolvedValue(7) },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    round: { findUnique: vi.fn().mockResolvedValue(round) },
    sealedBid: { findUnique: vi.fn().mockResolvedValue(existing), findMany: vi.fn() },
    $transaction: (work: (client: unknown) => unknown) => work(tx),
  };
  const wallet = { hold: vi.fn().mockResolvedValue(holds), release: vi.fn().mockResolvedValue(true) };
  const bids = { withBidderLock: (_round: string, _bidder: string, work: () => unknown) => work() };
  return { tx, prisma, wallet, service: new SealedBidsService(prisma as never, bids as never, wallet as never) };
}

describe('SealedBidsService (ADR-0003)', () => {
  it('reserva el monto, guarda el sobre y publica solo cuantos sobres hay', async () => {
    const { service, wallet, tx } = setup();
    await expect(service.seal('round', 'ana', 4750)).resolves.toMatchObject({ roundId: 'round', sealedCount: 7 });
    expect(wallet.hold).toHaveBeenCalledWith('ana', 'bid:round:ana', 4750);
    const payload = tx.outboxEvent.create.mock.calls[0][0].data.payload;
    expect(payload).toMatchObject({ eventType: 'auction.round.sealed-bid.placed.v1', roundId: 'round', sealedCount: 7 });
    // Ni el monto ni quien sello salen mientras la ronda esta abierta.
    expect(JSON.stringify(payload)).not.toContain('ana');
    expect(JSON.stringify(payload)).not.toContain('4750');
  });

  it('una sola puja por estudiante: la segunda se rechaza sin tocar wallet', async () => {
    const { service, wallet } = setup({ existing: { id: 'sealed' } });
    await expect(service.seal('round', 'ana', 5000)).rejects.toThrow('Ya sellaste');
    expect(wallet.hold).not.toHaveBeenCalled();
  });

  it('valida monto entero, precio minimo, modalidad y participacion antes de reservar', async () => {
    await expect(setup().service.seal('round', 'ana', 10.5)).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup().service.seal('round', 'ana', 2999)).rejects.toThrow('al menos 3000');
    await expect(setup({ round: sealedRound({ mode: RoundMode.CLASSIC }) }).service.seal('round', 'ana', 4000)).rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ round: sealedRound({ room: { participants: [] } }) }).service.seal('round', 'ana', 4000)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin saldo no guarda el sobre', async () => {
    const { service, tx } = setup({ holds: false });
    await expect(service.seal('round', 'ana', 4000)).rejects.toThrow('No tienes ECICoin');
    expect(tx.sealedBid.create).not.toHaveBeenCalled();
  });

  it('si la ronda cerro mientras se reservaba, devuelve la reserva', async () => {
    const { service, wallet, tx } = setup({ open: [] });
    await expect(service.seal('round', 'ana', 4000)).rejects.toThrow('ya cerro');
    expect(wallet.release).toHaveBeenCalledWith('ana', 'bid:round:ana', 4000);
    expect(tx.sealedBid.create).not.toHaveBeenCalled();
  });

  it('abre los sobres al cerrar: ranking completo, el propio marcado y sin nombres ajenos', async () => {
    const { prisma, service } = setup({ round: sealedRound({ status: RoundStatus.CLOSED, winnerId: 'bob', room: { scheduledBy: 'owner', participants: [{ id: 'p' }] } }) });
    prisma.sealedBid.findMany.mockResolvedValue([
      { bidderId: 'bob', amount: decimal(5200) },
      { bidderId: 'carl', amount: decimal(4900) },
      { bidderId: 'ana', amount: decimal(4750) },
    ]);
    const results = await service.results('round', 'ana');
    expect(results.myRank).toBe(3);
    expect(results.ranking.map(({ rank, mine, winner }) => ({ rank, mine, winner }))).toEqual([
      { rank: 1, mine: false, winner: true },
      { rank: 2, mine: false, winner: false },
      { rank: 3, mine: true, winner: false },
    ]);
    expect(JSON.stringify(results)).not.toContain('bob');
  });

  it('no abre los sobres de una ronda abierta', async () => {
    const { service } = setup({ round: sealedRound({ room: { scheduledBy: 'owner', participants: [{ id: 'p' }] } }) });
    await expect(service.results('round', 'ana')).rejects.toThrow('cuando la ronda cierra');
  });

  it('el dueño de la sala ve la apertura aunque no participe; un extraño no', async () => {
    const closed = sealedRound({ status: RoundStatus.CLOSED, winnerId: null, room: { scheduledBy: 'owner', participants: [] } });
    const owner = setup({ round: closed });
    owner.prisma.sealedBid.findMany.mockResolvedValue([]);
    await expect(owner.service.results('round', 'owner')).resolves.toMatchObject({ sealedCount: 0, myRank: null });
    await expect(setup({ round: closed }).service.results('round', 'extraño')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
