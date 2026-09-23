import { ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { BidsService } from './bids.service.js';

describe('BidsService', () => {
  const activeRound = (bidderId = 'alice', amount = 10) => ({ id: 'round', status: 'ACTIVE', bids: [{ bidderId, amount: new Prisma.Decimal(amount) }] });
  it('releases the previous leader after accepting a superior bid', async () => {
    const prisma = { round: { findUnique: vi.fn().mockResolvedValue(activeRound()) }, bid: { upsert: vi.fn().mockResolvedValue({ id: 'bid' }) } };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 15)).resolves.toEqual({ id: 'bid' });
    expect(wallet.hold).toHaveBeenCalledWith('bob', 'bid:round:bob', 15);
    expect(wallet.release).toHaveBeenCalledWith('alice', 'bid:round:alice', 10);
  });
  it('keeps only the caller hold when the leader improves their own bid', async () => {
    const prisma = { round: { findUnique: vi.fn().mockResolvedValue(activeRound('alice', 10)) }, bid: { upsert: vi.fn().mockResolvedValue({ id: 'bid' }) } };
    const wallet = { hold: vi.fn().mockResolvedValue(true), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await service.place('round', 'alice', 15);
    expect(wallet.hold).toHaveBeenCalledWith('alice', 'bid:round:alice', 15);
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it('does not reserve or release funds for a rejected bid', async () => {
    const prisma = { round: { findUnique: vi.fn().mockResolvedValue(activeRound('alice', 10)) }, bid: { upsert: vi.fn() } };
    const wallet = { hold: vi.fn(), release: vi.fn() };
    const service = new BidsService(prisma as never, wallet as never);
    await expect(service.place('round', 'bob', 10)).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.hold).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });
});
