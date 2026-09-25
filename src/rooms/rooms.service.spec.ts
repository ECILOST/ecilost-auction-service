import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { RoomsService } from './rooms.service.js';
import { AuctionableKindDto } from './dto/schedule-room.dto.js';

const item = '11111111-1111-4111-8111-111111111111';
const valid = { name: 'Sala de prueba', maximumCapacity: 30, startsAt: '2030-01-01T10:00:00.000Z', rounds: [{ entries: [{ kind: AuctionableKindDto.ITEM, catalogId: item }], startingPrice: 50000 }] };
const catalog = { reserve: vi.fn().mockResolvedValue(true) };

describe('RoomsService', () => {
  it('crea una sala SCHEDULED con rondas encadenadas', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'room', status: 'SCHEDULED', participants: [], rounds: [] });
    const service = new RoomsService({ room: { create } } as never, catalog as never);
    await expect(service.schedule(valid, 'staff')).resolves.toMatchObject({ status: 'SCHEDULED' });
    expect(create).toHaveBeenCalledOnce();
  });
  it.each([0, -1])('rechaza aforo %i', async (maximumCapacity) => {
    const service = new RoomsService({ room: { create: vi.fn() } } as never, catalog as never);
    await expect(service.schedule({ ...valid, maximumCapacity }, 'staff')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rechaza una sala sin rondas o una ronda vacia', async () => {
    const service = new RoomsService({ room: { create: vi.fn() } } as never, catalog as never);
    await expect(service.schedule({ ...valid, rounds: [] }, 'staff')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.schedule({ ...valid, rounds: [{ entries: [], startingPrice: 50000 }] }, 'staff')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('guarda el nombre y arranca cada ronda con su precio minimo como precio vigente', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'room', participants: [], rounds: [] });
    const service = new RoomsService({ room: { create } } as never, catalog as never);
    await service.schedule(valid, 'staff');
    const { data } = create.mock.calls[0][0];
    expect(data.name).toBe('Sala de prueba');
    expect(data.rounds.create[0].startingPrice.toString()).toBe('50000');
    expect(data.rounds.create[0].currentPrice.toString()).toBe('50000');
  });
  it('responde la sala sin columnas BigInt, que JSON no sabe serializar', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'room', participants: [], rounds: [] });
    const service = new RoomsService({ room: { create } } as never, catalog as never);
    const room = await service.schedule(valid, 'staff');
    expect(() => JSON.stringify(room)).not.toThrow();
    expect(create.mock.calls[0][0].select.rounds.select).not.toHaveProperty('nextBidSequence');
    expect(create.mock.calls[0][0]).not.toHaveProperty('include');
  });
  it.each([0, -100, 1500.5])('rechaza el precio minimo %s sin reservar en Catalog', async (startingPrice) => {
    const reserve = vi.fn();
    const service = new RoomsService({ room: { create: vi.fn() } } as never, { reserve } as never);
    await expect(service.schedule({ ...valid, rounds: [{ ...valid.rounds[0], startingPrice }] }, 'staff')).rejects.toBeInstanceOf(BadRequestException);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('lista las salas indicando si quien consulta ya esta registrado', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'a', name: 'Sala A', participants: [{ id: 'p' }], _count: { rounds: 3 } },
      { id: 'b', name: 'Sala B', participants: [], _count: { rounds: 1 } },
    ]);
    const service = new RoomsService({ room: { findMany } } as never, catalog as never);
    await expect(service.listRooms('student')).resolves.toEqual([
      { id: 'a', name: 'Sala A', roundCount: 3, isParticipant: true },
      { id: 'b', name: 'Sala B', roundCount: 1, isParticipant: false },
    ]);
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ startsAt: 'asc' });
  });
  it('entrega el detalle de la sala con sus rondas', async () => {
    const round = { id: 'round-1', position: 1, startingPrice: new Prisma.Decimal(50000), entries: [{ kind: 'ITEM', catalogId: item }] };
    const findUnique = vi.fn().mockResolvedValue({ id: 'room', name: 'Sala A', participants: [], rounds: [{ ...round, currentBidderId: null }] });
    const service = new RoomsService({ room: { findUnique } } as never, catalog as never);
    await expect(service.getRoom('room', 'staff')).resolves.toEqual({
      id: 'room', name: 'Sala A', isParticipant: false, rounds: [{ ...round, hasBids: false, isLeading: false }],
    });
  });
  it('dice si hay pujas y si quien consulta lidera, sin publicar el id del lider', async () => {
    const rounds = [
      { id: 'round-1', position: 1, currentBidderId: 'student', entries: [] },
      { id: 'round-2', position: 2, currentBidderId: 'otro', entries: [] },
    ];
    const findUnique = vi.fn().mockResolvedValue({ id: 'room', participants: [{ id: 'p' }], rounds });
    const service = new RoomsService({ room: { findUnique } } as never, catalog as never);
    const room = await service.getRoom('room', 'student');
    expect(room.isParticipant).toBe(true);
    expect(room.rounds.map(({ hasBids, isLeading }) => ({ hasBids, isLeading }))).toEqual([
      { hasBids: true, isLeading: true },
      { hasBids: true, isLeading: false },
    ]);
    expect(JSON.stringify(room)).not.toContain('otro');
  });
  it('responde 404 al pedir una sala inexistente', async () => {
    const service = new RoomsService({ room: { findUnique: vi.fn().mockResolvedValue(null) } } as never, catalog as never);
    await expect(service.getRoom('room', 'staff')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('convierte la restriccion unica concurrente en conflicto', async () => {
    const service = new RoomsService({ room: { create: vi.fn().mockRejectedValue({ code: 'P2002' }) } } as never, catalog as never);
    await expect(service.schedule(valid, 'staff')).rejects.toBeInstanceOf(ConflictException);
  });

  it('admite un estudiante y consume exactamente un cupo', async () => {
    const participant = { id: 'participant', roomId: 'room', userId: 'student' };
    const tx = {
      room: {
        findUnique: vi.fn().mockResolvedValue({ id: 'room', status: 'SCHEDULED', maximumCapacity: 2, admittedCount: 0 }),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      roomParticipant: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(participant) },
    };
    const service = new RoomsService({ $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as never, catalog as never);
    await expect(service.admitParticipant('room', 'student')).resolves.toEqual({ participant, alreadyAdmitted: false });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
  });
  it('no consume otro cupo cuando el estudiante ya esta admitido', async () => {
    const participant = { id: 'participant', roomId: 'room', userId: 'student' };
    const tx = {
      room: { findUnique: vi.fn().mockResolvedValue({ id: 'room', status: 'SCHEDULED', maximumCapacity: 2, admittedCount: 1 }), updateMany: vi.fn() },
      roomParticipant: { findUnique: vi.fn().mockResolvedValue(participant), create: vi.fn() },
    };
    const service = new RoomsService({ $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as never, catalog as never);
    await expect(service.admitParticipant('room', 'student')).resolves.toEqual({ participant, alreadyAdmitted: true });
    expect(tx.room.updateMany).not.toHaveBeenCalled();
    expect(tx.roomParticipant.create).not.toHaveBeenCalled();
  });
  it('permite reconectar a un participante cuando la sala ya inicio', async () => {
    const participant = { id: 'participant', roomId: 'room', userId: 'student' };
    const tx = {
      room: { findUnique: vi.fn().mockResolvedValue({ id: 'room', status: 'ACTIVE', maximumCapacity: 2, admittedCount: 2 }), updateMany: vi.fn() },
      roomParticipant: { findUnique: vi.fn().mockResolvedValue(participant), create: vi.fn() },
    };
    const service = new RoomsService({ $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as never, catalog as never);
    await expect(service.admitParticipant('room', 'student')).resolves.toEqual({ participant, alreadyAdmitted: true });
    expect(tx.room.updateMany).not.toHaveBeenCalled();
    expect(tx.roomParticipant.create).not.toHaveBeenCalled();
  });
  it('rechaza a un estudiante nuevo cuando la sala ya inicio', async () => {
    const tx = {
      room: { findUnique: vi.fn().mockResolvedValue({ id: 'room', status: 'ACTIVE', maximumCapacity: 2, admittedCount: 1 }), updateMany: vi.fn() },
      roomParticipant: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    };
    const service = new RoomsService({ $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as never, catalog as never);
    await expect(service.admitParticipant('room', 'student')).rejects.toThrow('Sala cerrada.');
    expect(tx.room.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    ['sala llena', { id: 'room', status: 'SCHEDULED', maximumCapacity: 1, admittedCount: 1 }, ConflictException],
    ['sala cancelada', { id: 'room', status: 'CANCELLED', maximumCapacity: 2, admittedCount: 0 }, ConflictException],
    ['sala inexistente', null, NotFoundException],
  ])('rechaza %s', async (_scenario, room, exception) => {
    const tx = { room: { findUnique: vi.fn().mockResolvedValue(room), updateMany: vi.fn() }, roomParticipant: { findUnique: vi.fn(), create: vi.fn() } };
    const service = new RoomsService({ $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as never, catalog as never);
    await expect(service.admitParticipant('room', 'student')).rejects.toBeInstanceOf(exception);
  });
  it('rechaza cuando otra solicitud consume el cupo antes de la actualizacion', async () => {
    const tx = {
      room: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ id: 'room', status: 'SCHEDULED', maximumCapacity: 1, admittedCount: 0 })
          .mockResolvedValueOnce({ status: 'SCHEDULED', maximumCapacity: 1, admittedCount: 1 }),
      },
      $executeRaw: vi.fn().mockResolvedValue(0),
      roomParticipant: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    };
    const service = new RoomsService({ $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as never, catalog as never);
    await expect(service.admitParticipant('room', 'student')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.roomParticipant.create).not.toHaveBeenCalled();
  });
  it('mantiene la admision idempotente si dos solicitudes del mismo estudiante se cruzan', async () => {
    const participant = { id: 'participant', roomId: 'room', userId: 'student' };
    const tx = {
      room: {
        findUnique: vi.fn().mockResolvedValue({ id: 'room', status: 'SCHEDULED', maximumCapacity: 2, admittedCount: 0 }),
      },
      $executeRaw: vi.fn().mockResolvedValue(0),
      roomParticipant: { findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(participant), create: vi.fn() },
    };
    const service = new RoomsService({ $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as never, catalog as never);
    await expect(service.admitParticipant('room', 'student')).resolves.toEqual({ participant, alreadyAdmitted: true });
    expect(tx.roomParticipant.create).not.toHaveBeenCalled();
  });
  const now = new Date('2030-01-01T10:00:00.000Z');
  const roundSnapshot = (id: string, position: number) => ({
    id, roomId: 'room', position, currentPrice: new Prisma.Decimal(25), currentBidderId: 'alice',
    startedAt: now, endsAt: now, maximumEndsAt: now, entries: [{ kind: 'ITEM', catalogId: item }],
  });
  const schedulerTx = (overrides: Record<string, unknown> = {}) => ({
    room: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    round: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    outboxEvent: { create: vi.fn() },
    ...overrides,
  });
  const scheduler = (tx: ReturnType<typeof schedulerTx>) =>
    new RoomsService({ $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as never, catalog as never);
  const enqueued = (tx: ReturnType<typeof schedulerTx>) =>
    tx.outboxEvent.create.mock.calls.map(([{ data }]) => data.payload as Record<string, unknown>);

  it('activa las salas vencidas, abre su primera ronda y publica la transicion', async () => {
    const tx = schedulerTx();
    tx.room.findMany.mockResolvedValue([{ id: 'room' }]);
    tx.round.findFirst.mockResolvedValue(roundSnapshot('round-1', 1));
    await expect(scheduler(tx).activateDueRooms(now)).resolves.toEqual({ count: 1 });
    expect(tx.round.updateMany).toHaveBeenCalledWith({
      where: { roomId: 'room', position: 1, status: 'SCHEDULED' },
      data: { status: 'ACTIVE', startedAt: now, endsAt: new Date(now.getTime() + 3 * 60_000), maximumEndsAt: new Date(now.getTime() + 8 * 60_000) },
    });
    expect(enqueued(tx)).toEqual([expect.objectContaining({ eventType: 'auction.round.activated.v1', roomId: 'room', roundId: 'round-1', position: 1 })]);
  });
  it('no abre rondas cuando otra ejecucion ya activo la sala', async () => {
    const tx = schedulerTx();
    tx.room.findMany.mockResolvedValue([{ id: 'room' }]);
    tx.room.updateMany.mockResolvedValue({ count: 0 });
    await expect(scheduler(tx).activateDueRooms(now)).resolves.toEqual({ count: 0 });
    expect(tx.round.updateMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('cierra la ronda vencida y activa la siguiente publicando ambos eventos en orden', async () => {
    const tx = schedulerTx();
    tx.round.findMany.mockResolvedValue([roundSnapshot('round-1', 1)]);
    tx.round.findFirst.mockResolvedValue({ id: 'round-2' });
    tx.round.findUnique.mockResolvedValue(roundSnapshot('round-2', 2));
    await scheduler(tx).activateDueRooms(now);
    expect(enqueued(tx)).toEqual([
      expect.objectContaining({ eventType: 'auction.round.closed.v1', roundId: 'round-1', currentPrice: '25', currentBidderId: 'alice', closedAt: now.toISOString() }),
      expect.objectContaining({ eventType: 'auction.round.activated.v1', roundId: 'round-2', position: 2 }),
    ]);
  });
  it('cierra la sala cuando vence su ultima ronda', async () => {
    const tx = schedulerTx();
    tx.round.findMany.mockResolvedValue([roundSnapshot('round-1', 1)]);
    await scheduler(tx).activateDueRooms(now);
    expect(tx.room.updateMany).toHaveBeenCalledWith({ where: { id: 'room', status: 'ACTIVE' }, data: { status: 'CLOSED' } });
    expect(enqueued(tx).map((payload) => payload.eventType)).toEqual(['auction.round.closed.v1']);
  });

  it('entrega el estado vigente con la hora del servidor para resincronizar al reconectar', async () => {
    const currentRound = { id: 'round-1', position: 1, status: 'ACTIVE', currentPrice: new Prisma.Decimal(25), currentBidderId: 'alice', startedAt: now, endsAt: now, entries: [] };
    const findUnique = vi.fn().mockResolvedValue({ id: 'room', status: 'ACTIVE', participants: [{ id: 'p' }], rounds: [currentRound] });
    const service = new RoomsService({ room: { findUnique } } as never, catalog as never);
    const state = await service.getCurrentState('room', 'student');
    expect(state).toMatchObject({ id: 'room', status: 'ACTIVE', currentRound });
    expect(state.serverTime).toBeInstanceOf(Date);
  });
  it('no entrega el estado a quien no fue admitido en la sala', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'room', status: 'ACTIVE', participants: [], rounds: [] });
    const service = new RoomsService({ room: { findUnique } } as never, catalog as never);
    await expect(service.getCurrentState('room', 'intruso')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
