import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma, RoomStatus, RoundMode, RoundStatus } from '../generated/prisma/client.js';
import { SpinSegment, spinRoulette } from '../rounds/round-modes.js';
import { DynamicModesService } from './dynamic-modes.service.js';

vi.mock('../rounds/round-modes.js', async (original) => ({ ...(await original<typeof import('../rounds/round-modes.js')>()), spinRoulette: vi.fn() }));

const decimal = (value: number) => new Prisma.Decimal(value);

function fakeTx({
  room = { scheduledBy: 'owner', status: RoomStatus.SCHEDULED, dynamicModesEnabled: true } as Record<string, unknown> | null,
  locked = [{ id: 'round', position: 2, status: RoundStatus.SCHEDULED, wildcardSpins: 0, modeLockedAt: null }] as unknown[],
} = {}) {
  return {
    room: { findUnique: vi.fn().mockResolvedValue(room), update: vi.fn() },
    round: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ startingPrice: decimal(2000), buyNowPrice: decimal(8000), entries: [{ kind: 'ITEM', catalogId: 'item' }] }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    outboxEvent: { create: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue(locked),
    $executeRaw: vi.fn(),
  };
}

const serviceWith = (tx: ReturnType<typeof fakeTx>) =>
  new DynamicModesService({ $transaction: (work: (client: unknown) => unknown) => work(tx) } as never);

const published = (tx: ReturnType<typeof fakeTx>) => tx.outboxEvent.create.mock.calls.map(([args]) => args.data.payload);

describe('DynamicModesService (ADR-0003)', () => {
  afterEach(() => vi.mocked(spinRoulette).mockReset());

  it('solo quien programo la sala puede girar la ruleta', async () => {
    const tx = fakeTx();
    await expect(serviceWith(tx).spin('room', 'round', 'otro-funcionario')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.round.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('exige que la sala tenga activas las subastas dinamicas', async () => {
    const tx = fakeTx({ room: { scheduledBy: 'owner', status: RoomStatus.SCHEDULED, dynamicModesEnabled: false } });
    await expect(serviceWith(tx).spin('room', 'round', 'owner')).rejects.toBeInstanceOf(ConflictException);
  });

  it('responde 404 si la sala no existe', async () => {
    await expect(serviceWith(fakeTx({ room: null })).spin('room', 'round', 'owner')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fija la modalidad una sola vez y la publica para la sala y para catalog', async () => {
    vi.mocked(spinRoulette).mockReturnValue(SpinSegment.MYSTERY);
    const tx = fakeTx();
    const result = await serviceWith(tx).spin('room', 'round', 'owner');
    expect(result).toMatchObject({ segment: 'MYSTERY', mode: RoundMode.MYSTERY, canSpinAgain: false, position: 2 });
    expect(tx.round.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mode: RoundMode.MYSTERY, modeLockedAt: expect.any(Date) }),
    }));
    expect(published(tx)).toEqual([expect.objectContaining({
      eventType: 'auction.round.mode-selected.v1', roundId: 'round', mode: 'MYSTERY', segment: 'MYSTERY',
      entries: [{ kind: 'ITEM', catalogId: 'item' }],
    })]);
  });

  it('la holandesa guarda sus precios y arranca mostrando el de salida', async () => {
    vi.mocked(spinRoulette).mockReturnValue(SpinSegment.DUTCH);
    const tx = fakeTx();
    await serviceWith(tx).spin('room', 'round', 'owner');
    const { data } = tx.round.update.mock.calls[0][0];
    expect(data.mode).toBe(RoundMode.DUTCH);
    expect(data.dutchStartPrice.toString()).toBe('8000');
    expect(data.dutchFloorPrice.toString()).toBe('2000');
    expect(data.currentPrice.toString()).toBe('8000');
  });

  it('el comodin no fija modalidad y deja girar otra vez', async () => {
    vi.mocked(spinRoulette).mockReturnValue(SpinSegment.WILDCARD);
    const tx = fakeTx();
    const result = await serviceWith(tx).spin('room', 'round', 'owner');
    expect(result).toMatchObject({ segment: 'WILDCARD', mode: null, wildcardSpins: 1, canSpinAgain: true });
    expect(tx.round.update).toHaveBeenCalledWith({ where: { id: 'round' }, data: { wildcardSpins: 1 } });
    expect(published(tx)[0]).toMatchObject({ segment: 'WILDCARD', mode: null });
  });

  it('no gira una ronda que ya tiene modalidad ni una que ya empezo', async () => {
    const decided = fakeTx({ locked: [{ id: 'round', position: 2, status: RoundStatus.SCHEDULED, wildcardSpins: 0, modeLockedAt: new Date() }] });
    await expect(serviceWith(decided).spin('room', 'round', 'owner')).rejects.toThrow('ya decidio');
    const started = fakeTx({ locked: [{ id: 'round', position: 2, status: RoundStatus.ACTIVE, wildcardSpins: 0, modeLockedAt: null }] });
    await expect(serviceWith(started).spin('room', 'round', 'owner')).rejects.toThrow('ya empezo');
    expect(decided.round.update).not.toHaveBeenCalled();
    expect(started.round.update).not.toHaveBeenCalled();
  });

  it('desactivarlas devuelve a clasica las rondas pendientes y avisa a catalog', async () => {
    const tx = fakeTx();
    tx.round.findMany.mockResolvedValue([{ id: 'round', position: 2, entries: [{ kind: 'ITEM', catalogId: 'item' }] }]);
    await expect(serviceWith(tx).setEnabled('room', 'owner', false)).resolves.toEqual({ roomId: 'room', dynamicModesEnabled: false });
    expect(tx.room.update).toHaveBeenCalledWith({ where: { id: 'room' }, data: { dynamicModesEnabled: false } });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(published(tx)).toEqual([expect.objectContaining({ roundId: 'round', mode: RoundMode.CLASSIC })]);
  });

  it('activarlas no toca las rondas', async () => {
    const tx = fakeTx({ room: { scheduledBy: 'owner', status: RoomStatus.ACTIVE, dynamicModesEnabled: false } });
    await serviceWith(tx).setEnabled('room', 'owner', true);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('no se activan en una sala que ya termino, ni por otro funcionario', async () => {
    await expect(serviceWith(fakeTx({ room: { scheduledBy: 'owner', status: RoomStatus.CLOSED, dynamicModesEnabled: false } })).setEnabled('room', 'owner', true))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(serviceWith(fakeTx()).setEnabled('room', 'otro', true)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
