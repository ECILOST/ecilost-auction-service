import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BidStatus, Prisma, RoundStatus } from '../generated/prisma/client.js';
import { AutoBidsService } from './auto-bids.service.js';

const decimal = (value: number) => new Prisma.Decimal(value);

const activeRound = (overrides: Record<string, unknown> = {}) => ({
  status: RoundStatus.ACTIVE, startingPrice: decimal(1000), currentPrice: decimal(2000), currentBidderId: 'bob',
  room: { participants: [{ id: 'participant' }] },
  autoBids: [] as unknown[],
  ...overrides,
});

function setup(round = activeRound()) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ priority: 7n }]),
    autoBid: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
  };
  const prisma = {
    round: { findUnique: vi.fn().mockResolvedValue(round) },
    autoBid: { findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const wallet = { availableBalance: vi.fn().mockResolvedValue(10000), hold: vi.fn().mockResolvedValue(true), release: vi.fn() };
  const bids = {
    placeAutomatic: vi.fn(), restoreHold: vi.fn(), releaseOutbid: vi.fn(), logAccepted: vi.fn(),
    withBidderLock: (_roundId: string, _bidderId: string, work: () => unknown) => work(),
  };
  const service = new AutoBidsService(prisma as never, wallet as never, bids as never);
  return { service, prisma, tx, wallet, bids };
}

describe('AutoBidsService.configure (HU-22)', () => {
  it('registra el limite con el turno que asigna la base bajo el bloqueo de la ronda', async () => {
    const { service, tx, wallet } = setup();
    await service.configure('round', 'alice', { enabled: true, maximumAmount: 5000 });
    expect(wallet.availableBalance).toHaveBeenCalledWith('alice');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.autoBid.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ roundId: 'round', bidderId: 'alice', maximumAmount: decimal(5000), priority: 7n, enabled: true, stoppedReason: null }),
    }));
  });

  it('rechaza un limite mayor que el saldo disponible sin registrar nada ni reservar fondos', async () => {
    const { service, tx, wallet } = setup();
    wallet.availableBalance.mockResolvedValue(4999);
    await expect(service.configure('round', 'alice', { enabled: true, maximumAmount: 5000 })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.autoBid.upsert).not.toHaveBeenCalled();
    expect(wallet.hold).not.toHaveBeenCalled();
  });

  it('a quien lidera le cuenta lo que ya tiene reservado en la ronda', async () => {
    const { service, tx, wallet } = setup(activeRound({ currentBidderId: 'alice', currentPrice: decimal(2000) }));
    wallet.availableBalance.mockResolvedValue(3000);
    await service.configure('round', 'alice', { enabled: true, maximumAmount: 5000 });
    expect(tx.autoBid.upsert).toHaveBeenCalled();
  });

  it('exige que el limite alcance la puja minima', async () => {
    const { service } = setup();
    await expect(service.configure('round', 'alice', { enabled: true, maximumAmount: 2099 })).rejects.toThrow('al menos 2100');
  });

  it('valida limite entero, ronda existente, participante y ronda activa', async () => {
    await expect(setup().service.configure('round', 'alice', { enabled: true, maximumAmount: 2500.5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup().service.configure('round', 'alice', { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    const missing = setup();
    missing.prisma.round.findUnique.mockResolvedValue(null);
    await expect(missing.service.configure('round', 'alice', { enabled: true, maximumAmount: 5000 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup(activeRound({ room: { participants: [] } })).service.configure('round', 'x', { enabled: true, maximumAmount: 5000 }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(setup(activeRound({ status: RoundStatus.CLOSED })).service.configure('round', 'alice', { enabled: true, maximumAmount: 5000 }))
      .rejects.toThrow('La ronda no esta activa.');
  });

  it('repetir la misma declaracion no le hace perder el turno', async () => {
    const { service, tx } = setup();
    tx.autoBid.findUnique.mockResolvedValue({ enabled: true, stoppedReason: null, maximumAmount: decimal(5000) });
    await service.configure('round', 'alice', { enabled: true, maximumAmount: 5000 });
    expect(tx.autoBid.upsert).not.toHaveBeenCalled();
  });

  it('desactivar no consulta saldo ni toca la ronda', async () => {
    const { service, prisma, wallet, tx } = setup();
    await service.configure('round', 'alice', { enabled: false });
    expect(prisma.autoBid.updateMany).toHaveBeenCalledWith({ where: { roundId: 'round', bidderId: 'alice' }, data: { enabled: false } });
    expect(wallet.availableBalance).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('AutoBidsService.resolve (HU-22)', () => {
  const placed = (bidderId: string, amount: number) => ({
    id: 'bid', roundId: 'round', bidderId, amount: decimal(amount), sequence: 3n, status: BidStatus.ACCEPTED,
    previousBidderId: 'bob', previousPrice: decimal(2000), endsAt: new Date(), extended: false,
  });

  it('puja por el estudiante cuando otro lo supera, reservando solo el monto de esa puja', async () => {
    const { service, prisma, wallet, bids } = setup();
    const autoBids = [{ id: 'auto-a', bidderId: 'alice', maximumAmount: decimal(5000), priority: 1n }];
    prisma.round.findUnique
      .mockResolvedValueOnce(activeRound({ autoBids }))
      .mockResolvedValueOnce(activeRound({ autoBids, currentBidderId: 'alice', currentPrice: decimal(2100) }));
    bids.placeAutomatic.mockResolvedValue(placed('alice', 2100));
    await service.resolve('round');
    expect(wallet.hold).toHaveBeenCalledWith('alice', 'bid:round:alice', 2100);
    expect(bids.placeAutomatic).toHaveBeenCalledWith('round', 'alice', decimal(2100), { price: decimal(2000), leaderId: 'bob' });
    expect(bids.releaseOutbid).toHaveBeenCalledWith(expect.objectContaining({ bidderId: 'alice', previousBidderId: 'bob' }));
  });

  it('un disparo sin saldo se rechaza, no compromete fondos y detiene esa puja automatica', async () => {
    const { service, prisma, wallet, bids } = setup();
    const autoBids = [{ id: 'auto-a', bidderId: 'alice', maximumAmount: decimal(5000), priority: 1n }];
    prisma.round.findUnique.mockResolvedValueOnce(activeRound({ autoBids })).mockResolvedValueOnce(activeRound({ autoBids: [] }));
    wallet.hold.mockResolvedValue(false);
    await service.resolve('round');
    expect(bids.placeAutomatic).not.toHaveBeenCalled();
    expect(prisma.autoBid.updateMany).toHaveBeenCalledWith({
      where: { id: 'auto-a', priority: 1n, stoppedReason: null },
      data: { stoppedReason: 'INSUFFICIENT_FUNDS' },
    });
  });

  it('si otra puja se adelanta, deshace la reserva y recalcula sobre el estado nuevo', async () => {
    const { service, prisma, bids } = setup();
    const autoBids = [{ id: 'auto-a', bidderId: 'alice', maximumAmount: decimal(5000), priority: 1n }];
    prisma.round.findUnique
      .mockResolvedValueOnce(activeRound({ autoBids }))
      .mockResolvedValueOnce(activeRound({ autoBids, currentPrice: decimal(3000), currentBidderId: 'carol' }))
      .mockResolvedValueOnce(activeRound({ autoBids, currentPrice: decimal(3100), currentBidderId: 'alice' }));
    bids.placeAutomatic.mockResolvedValueOnce(null).mockResolvedValueOnce(placed('alice', 3100));
    await service.resolve('round');
    expect(bids.restoreHold).toHaveBeenCalledWith('round', 'alice', 2100);
    expect(bids.placeAutomatic).toHaveBeenLastCalledWith('round', 'alice', decimal(3100), { price: decimal(3000), leaderId: 'carol' });
  });

  it('detiene por limite las automaticas que ya no alcanzan la puja minima', async () => {
    const { service, prisma } = setup();
    prisma.round.findUnique.mockResolvedValueOnce(activeRound({ autoBids: [] }));
    await service.resolve('round');
    expect(prisma.autoBid.updateMany).toHaveBeenCalledWith({
      where: { roundId: 'round', enabled: true, stoppedReason: null, maximumAmount: { lt: 2100 }, NOT: { bidderId: 'bob' } },
      data: { stoppedReason: 'LIMIT_REACHED' },
    });
  });

  it('no puja en una ronda que ya no esta activa (sala cerrada)', async () => {
    const { service, prisma, wallet } = setup();
    prisma.round.findUnique.mockResolvedValue(activeRound({ status: RoundStatus.CLOSED, autoBids: [{ id: 'a', bidderId: 'alice', maximumAmount: decimal(9000), priority: 1n }] }));
    await service.resolve('round');
    expect(wallet.hold).not.toHaveBeenCalled();
  });

  it('funde las resoluciones simultaneas de la misma ronda en este proceso', async () => {
    const { service, prisma } = setup();
    prisma.round.findUnique.mockResolvedValue(activeRound());
    await Promise.all([service.resolve('round'), service.resolve('round'), service.resolve('round')]);
    // Una resolucion y, como llegaron mas mientras corria, una sola repeticion.
    expect(prisma.round.findUnique).toHaveBeenCalledTimes(2);
  });
});
