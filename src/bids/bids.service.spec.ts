import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { BidStatus, Prisma, RoundStatus } from '../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { BidsService, minimumBid } from './bids.service.js';

describe('BidsService', () => {
  // El candado por estudiante corre en una transaccion; aqui la transaccion solo ejecuta el trabajo.
  const inTransaction = (work: (tx: unknown) => unknown) => work({ $queryRaw: vi.fn() });
  const activeRound = (currentPrice = 1000, currentBidderId: string | null = 'alice', startingPrice = 500) => ({
    id: 'round', status: RoundStatus.ACTIVE, startingPrice: new Prisma.Decimal(startingPrice), currentPrice: new Prisma.Decimal(currentPrice), currentBidderId,
    room: { participants: [{ id: 'participant' }] },
  });
  const placed = (previousBidderId: string | null = 'alice', previousPrice = 1000, status: BidStatus = BidStatus.ACCEPTED) => [{ id: 'bid', roundId: 'round', bidderId: 'bob', amount: new Prisma.Decimal(1100), sequence: 1n, status, previousBidderId, previousPrice: previousBidderId ? new Prisma.Decimal(previousPrice) : null, endsAt: '2030-01-01T10:03:00.000Z', extended: false }];
  it('releases the previous leader after accepting a superior bid', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn().mockResolvedValue(placed()) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) };
    const service = new BidsService(prisma as never, wallet as never);
    const result = await service.place('round', 'bob', 1100);
    expect(result).toMatchObject({ id: 'bid', roundId: 'round', bidderId: 'bob', sequence: '1' });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(wallet.hold).toHaveBeenCalledWith('bob', 'bid:round:bob', 1100);
    expect(wallet.release).toHaveBeenCalledWith('alice', 'bid:round:alice', 1000);
  });
  it('keeps only the caller hold when the leader improves their own bid', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn().mockResolvedValue([{ ...placed('alice')[0], bidderId: 'alice' }]) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await service.place('round', 'alice', 1100);
    expect(wallet.hold).toHaveBeenCalledWith('alice', 'bid:round:alice', 1100);
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it('does not reserve or release funds for a bid below the 100 increment', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn() };
    const wallet = { hold: vi.fn(), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 1099)).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.hold).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it('accepts any amount the student types above the minimum', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn().mockResolvedValue(placed()) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) };
    const service = new BidsService(prisma as never, wallet as never);
    await service.place('round', 'bob', 73250);
    expect(wallet.hold).toHaveBeenCalledWith('bob', 'bid:round:bob', 73250);
  });
  it('requires the first bid to reach the starting price', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue(activeRound(500, null, 500)) }, $queryRaw: vi.fn().mockResolvedValue(placed(null)) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 499)).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.hold).not.toHaveBeenCalled();
    await service.place('round', 'bob', 500);
    expect(wallet.hold).toHaveBeenCalledWith('bob', 'bid:round:bob', 500);
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it('rejects fractional amounts: ECICoin has no cents', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn() }, $queryRaw: vi.fn() };
    const wallet = { hold: vi.fn(), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 1100.5)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.round.findUnique).not.toHaveBeenCalled();
  });
  it('persists and compensates a rejected simultaneous bid', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn().mockResolvedValue(placed('alice', 1100, BidStatus.REJECTED)) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 1100)).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.release).toHaveBeenCalledWith('bob', 'bid:round:bob', 1100);
  });
  it('restores the hold of a leader whose own improvement was rejected instead of freeing it', async () => {
    // alice lidera con 1100 y su segunda puja de 1100, enviada a la vez, llega tarde: sigue liderando.
    const findUnique = vi.fn()
      .mockResolvedValueOnce(activeRound(1000, 'alice'))
      .mockResolvedValueOnce({ currentBidderId: 'alice', currentPrice: new Prisma.Decimal(1100) });
    const prisma = { $transaction: inTransaction, round: { findUnique }, $queryRaw: vi.fn().mockResolvedValue([{ ...placed('alice', 1100, BidStatus.REJECTED)[0], bidderId: 'alice' }]) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'alice', 1200)).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.release).not.toHaveBeenCalled();
    expect(wallet.hold).toHaveBeenLastCalledWith('alice', 'bid:round:alice', 1100);
  });
  it('reports the anti-sniping extension returned by the serialized placement', async () => {
    const extended = [{ ...placed()[0], endsAt: '2030-01-01T10:04:00.000Z', extended: true }];
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn().mockResolvedValue(extended) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) };
    const result = await new BidsService(prisma as never, wallet as never).place('round', 'bob', 1100);
    expect(result).toMatchObject({ extended: true, endsAt: new Date('2030-01-01T10:04:00.000Z') });
  });
  it('rejects an inactive round without reserving funds', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue({ ...activeRound(), status: RoundStatus.SCHEDULED }) }, $queryRaw: vi.fn() };
    const wallet = { hold: vi.fn(), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 1100)).rejects.toThrow('La ronda no esta activa.');
    expect(wallet.hold).not.toHaveBeenCalled();
  });
  it('rejects a student who was not admitted before the room started, without reserving funds', async () => {
    const prisma = { $transaction: inTransaction, round: { findUnique: vi.fn().mockResolvedValue({ ...activeRound(), room: { participants: [] } }) }, $queryRaw: vi.fn() };
    const wallet = { hold: vi.fn(), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'intruso', 1100)).rejects.toBeInstanceOf(ForbiddenException);
    expect(wallet.hold).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('minimumBid', () => {
  it('is the starting price while the round has no leader', () => {
    expect(minimumBid({ startingPrice: new Prisma.Decimal(50000), currentPrice: new Prisma.Decimal(50000), currentBidderId: null }).toString()).toBe('50000');
  });
  it('is the current price plus 100 once someone leads', () => {
    expect(minimumBid({ startingPrice: new Prisma.Decimal(50000), currentPrice: new Prisma.Decimal(50000), currentBidderId: 'alice' }).toString()).toBe('50100');
  });
});
