import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, RoundCloseReason, RoundStatus } from '../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { BidsService } from './bids.service.js';
import { BuyNowService } from './buy-now.service.js';

describe('BuyNowService (HU-24)', () => {
  const closedAt = '2030-01-01T10:01:00.000Z';
  const state = (overrides: Record<string, unknown> = {}) => ({
    roomId: 'room', status: RoundStatus.ACTIVE, currentPrice: new Prisma.Decimal(60000), buyNowPrice: new Prisma.Decimal(80000),
    winnerId: null, closedAt: null, closeReason: null, ...overrides,
  });
  const snapshot = () => ({
    id: 'round', roomId: 'room', position: 1, currentPrice: new Prisma.Decimal(80000), currentBidderId: 'bob',
    startedAt: new Date('2030-01-01T10:00:00.000Z'), endsAt: new Date('2030-01-01T10:03:00.000Z'), maximumEndsAt: new Date('2030-01-01T10:08:00.000Z'),
    entries: [{ kind: 'ITEM', catalogId: 'item' }],
  });
  // Transaccion del cierre: bloquea la fila (si sigue admitiendo compra) y cierra la ronda.
  const closeTx = (locked: unknown[] = [{ buyNowPrice: '80000', now: closedAt }]) => ({
    $queryRaw: vi.fn().mockResolvedValue(locked),
    round: {
      update: vi.fn().mockResolvedValue(snapshot()),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    room: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    outboxEvent: { create: vi.fn() },
  });
  /**
   * La primera transaccion es el candado del estudiante (solo ejecuta el trabajo); la segunda
   * es el cierre. `afterLoss` es lo que lee `restoreHold` si hay que deshacer la reserva.
   */
  const setup = (options: {
    round?: unknown; current?: unknown; tx?: ReturnType<typeof closeTx>; hold?: () => Promise<boolean>;
    afterLoss?: { currentBidderId: string | null; currentPrice: Prisma.Decimal };
  } = {}) => {
    const tx = options.tx ?? closeTx();
    let transactions = 0;
    const findUnique = vi.fn().mockResolvedValueOnce(options.round === undefined ? { room: { participants: [{ id: 'p' }] } } : options.round);
    if (options.afterLoss) findUnique.mockResolvedValueOnce(options.afterLoss);
    const prisma = {
      $transaction: vi.fn((work: (transaction: unknown) => unknown) => work(transactions++ === 0 ? { $queryRaw: vi.fn() } : tx)),
      round: { findUnique, findUniqueOrThrow: vi.fn().mockResolvedValue(options.current ?? state()) },
    };
    const wallet = { hold: vi.fn(options.hold ?? (() => Promise.resolve(true))), release: vi.fn().mockResolvedValue(true) };
    const service = new BuyNowService(prisma as never, new BidsService(prisma as never, wallet as never), wallet as never);
    return { service, prisma, wallet, tx };
  };
  const enqueued = (tx: ReturnType<typeof closeTx>) =>
    tx.outboxEvent.create.mock.calls.map(([{ data }]) => data.payload as Record<string, unknown>);

  it('reserva el precio de compra, cierra la ronda a favor del comprador y publica el cierre', async () => {
    const { service, wallet, tx } = setup();
    const result = await service.buy('round', 'bob');
    expect(result).toMatchObject({ roundId: 'round', roomId: 'room', buyerId: 'bob', closedAt: new Date(closedAt), replayed: false });
    expect(result.price.toString()).toBe('80000');
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(wallet.hold).toHaveBeenCalledWith('bob', 'bid:round:bob', 80000);
    expect(wallet.release).not.toHaveBeenCalled();
    expect(tx.round.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'round' }, data: { currentPrice: new Prisma.Decimal(80000), currentBidderId: 'bob' },
    }));
    expect(tx.round.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'round' },
      data: { status: 'CLOSED', result: 'AWARDED', winnerId: 'bob', closedAt: new Date(closedAt), closeReason: 'BUY_NOW' },
    });
    expect(enqueued(tx)).toEqual([expect.objectContaining({
      eventType: 'auction.round.closed.v1', roundId: 'round', result: 'AWARDED', winnerId: 'bob', currentBidderId: 'bob',
      winningAmount: '80000', closeReason: 'BUY_NOW', roomStatus: 'CLOSED',
    })]);
  });
  it('el cierre solo ocurre si la fila bloqueada sigue activa, a tiempo y bajo el precio de compra', async () => {
    const { service, tx } = setup();
    await service.buy('round', 'bob');
    const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('"endsAt" > (clock_timestamp() AT TIME ZONE \'UTC\')');
    expect(sql).toContain('"currentPrice" < "buyNowPrice"');
    expect(sql).toContain('FOR UPDATE');
  });
  it('rechaza con saldo insuficiente: no cierra la ronda ni publica nada', async () => {
    const { service, prisma, wallet, tx } = setup({ hold: () => Promise.resolve(false) });
    await expect(service.buy('round', 'bob')).rejects.toThrow('No tienes ECICoin disponibles suficientes para la compra inmediata.');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.round.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it.each([
    ['ronda finalizada', { status: RoundStatus.CLOSED, closeReason: RoundCloseReason.EXPIRED, winnerId: 'alice' }, 'La ronda no esta activa.'],
    ['ronda finalizada por la compra de otro', { status: RoundStatus.CLOSED, closeReason: RoundCloseReason.BUY_NOW, winnerId: 'alice', closedAt: new Date(closedAt) }, 'La ronda no esta activa.'],
    ['ronda sin precio de compra', { buyNowPrice: null }, 'Esta ronda no ofrece compra inmediata.'],
    ['precio alcanzado por las pujas', { currentPrice: new Prisma.Decimal(80000) }, 'Las pujas ya alcanzaron el precio de compra inmediata.'],
  ])('rechaza (%s) sin tocar wallet ni la ronda', async (_case, overrides, message) => {
    const { service, wallet, tx } = setup({ current: state(overrides) });
    await expect(service.buy('round', 'bob')).rejects.toThrow(message);
    expect(wallet.hold).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('rechaza a quien no fue admitido en la sala, sin reservar', async () => {
    const { service, prisma, wallet } = setup({ round: { room: { participants: [] } } });
    await expect(service.buy('round', 'intruso')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(wallet.hold).not.toHaveBeenCalled();
  });
  it('responde 404 para una ronda inexistente', async () => {
    const { service, wallet } = setup({ round: null });
    await expect(service.buy('round', 'bob')).rejects.toBeInstanceOf(NotFoundException);
    expect(wallet.hold).not.toHaveBeenCalled();
  });
  it('repetir una compra ya hecha responde la misma compra sin volver a reservar', async () => {
    const { service, wallet, tx } = setup({
      current: state({ status: RoundStatus.CLOSED, closeReason: RoundCloseReason.BUY_NOW, winnerId: 'bob', currentPrice: new Prisma.Decimal(80000), closedAt: new Date(closedAt) }),
    });
    const result = await service.buy('round', 'bob');
    expect(result).toMatchObject({ buyerId: 'bob', closedAt: new Date(closedAt), replayed: true });
    expect(result.price.toString()).toBe('80000');
    expect(wallet.hold).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('si pierde la carrera libera la reserva de la compra y no publica nada', async () => {
    const { service, wallet, tx } = setup({ tx: closeTx([]), afterLoss: { currentBidderId: 'alice', currentPrice: new Prisma.Decimal(80000) } });
    await expect(service.buy('round', 'bob')).rejects.toThrow('La ronda ya no admite compra inmediata.');
    expect(wallet.release).toHaveBeenCalledWith('bob', 'bid:round:bob', 80000);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('si lideraba y la ronda vencio antes, devuelve su reserva al monto con que lidera', async () => {
    const { service, wallet } = setup({ tx: closeTx([]), afterLoss: { currentBidderId: 'bob', currentPrice: new Prisma.Decimal(60000) } });
    await expect(service.buy('round', 'bob')).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.hold).toHaveBeenLastCalledWith('bob', 'bid:round:bob', 60000);
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it('deshace una reserva cuya respuesta nunca llego, sin cerrar la ronda', async () => {
    const { service, wallet, tx } = setup({
      hold: () => Promise.reject(new Error('La billetera no respondio.')),
      afterLoss: { currentBidderId: 'alice', currentPrice: new Prisma.Decimal(60000) },
    });
    await expect(service.buy('round', 'bob')).rejects.toThrow('La billetera no respondio.');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(wallet.release).toHaveBeenCalledWith('bob', 'bid:round:bob', 80000);
  });
  it('si la base falla al cerrar, deshace la reserva y propaga el error', async () => {
    const tx = closeTx();
    tx.round.update.mockRejectedValue(new Error('conexion perdida'));
    const { service, wallet } = setup({ tx, afterLoss: { currentBidderId: 'alice', currentPrice: new Prisma.Decimal(60000) } });
    await expect(service.buy('round', 'bob')).rejects.toThrow('conexion perdida');
    expect(wallet.release).toHaveBeenCalledWith('bob', 'bid:round:bob', 80000);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('si no es la ultima ronda, abre la siguiente en el mismo instante', async () => {
    const tx = closeTx();
    tx.round.findFirst.mockResolvedValue({ id: 'round-2' });
    tx.round.findUnique.mockResolvedValue({ ...snapshot(), id: 'round-2', position: 2, currentBidderId: null });
    const { service } = setup({ tx });
    await service.buy('round', 'bob');
    expect(tx.room.updateMany).not.toHaveBeenCalled();
    expect(enqueued(tx).map((payload) => [payload.eventType, payload.roomStatus])).toEqual([
      ['auction.round.closed.v1', 'ACTIVE'],
      ['auction.round.activated.v1', 'ACTIVE'],
    ]);
  });
});
