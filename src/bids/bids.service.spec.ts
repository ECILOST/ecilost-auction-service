import { ConflictException } from '@nestjs/common';
import { Prisma, RoundStatus } from '../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { BidsService } from './bids.service.js';

describe('BidsService', () => {
  const activeRound = (amount = 10) => ({ id: 'round', status: RoundStatus.ACTIVE, currentPrice: new Prisma.Decimal(amount) });
  const placed = (previousBidderId: string | null = 'alice', previousPrice = 10) => [{ id: 'bid', roundId: 'round', bidderId: 'bob', amount: new Prisma.Decimal(15), previousBidderId, previousPrice: previousBidderId ? new Prisma.Decimal(previousPrice) : null }];
  it('releases the previous leader after accepting a superior bid', async () => {
    const prisma = { round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn().mockResolvedValue(placed()) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 15)).resolves.toMatchObject({ id: 'bid', roundId: 'round', bidderId: 'bob' });
    expect(wallet.hold).toHaveBeenCalledWith('bob', 'bid:round:bob', 15);
    expect(wallet.release).toHaveBeenCalledWith('alice', 'bid:round:alice', 10);
  });
  it('keeps only the caller hold when the leader improves their own bid', async () => {
    const prisma = { round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn().mockResolvedValue(placed('alice')) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await service.place('round', 'alice', 15);
    expect(wallet.hold).toHaveBeenCalledWith('alice', 'bid:round:alice', 15);
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it('does not reserve or release funds for a rejected bid', async () => {
    const prisma = { round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, $queryRaw: vi.fn() };
    const wallet = { hold: vi.fn(), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 10)).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.hold).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it('compensates the hold when a simultaneous superior bid wins the price compare-and-set', async () => {
    const prisma = { round: { findUnique: vi.fn().mockResolvedValue(activeRound(10)) }, $queryRaw: vi.fn().mockResolvedValue([]) };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 15)).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.release).toHaveBeenCalledWith('bob', 'bid:round:bob', 15);
  });
  it('rejects an inactive round without reserving funds', async () => {
    const prisma = { round: { findUnique: vi.fn().mockResolvedValue({ status: RoundStatus.SCHEDULED, currentPrice: new Prisma.Decimal(0) }) }, $queryRaw: vi.fn() };
    const wallet = { hold: vi.fn(), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 15)).rejects.toThrow('Round is not active.');
    expect(wallet.hold).not.toHaveBeenCalled();
  });
});
