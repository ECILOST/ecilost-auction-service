import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RoomsService } from './rooms.service.js';
import { AuctionableKindDto } from './dto/schedule-room.dto.js';

const item = '11111111-1111-4111-8111-111111111111';
const valid = { maximumCapacity: 30, startsAt: '2030-01-01T10:00:00.000Z', rounds: [{ entries: [{ kind: AuctionableKindDto.ITEM, catalogId: item }] }] };
const catalog = { reserve: vi.fn().mockResolvedValue(true) };

describe('RoomsService', () => {
  it('crea una sala SCHEDULED con rondas encadenadas', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'room', status: 'SCHEDULED', rounds: [] });
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
    await expect(service.schedule({ ...valid, rounds: [{ entries: [] }] }, 'staff')).rejects.toBeInstanceOf(BadRequestException);
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
  it('activa solo las salas SCHEDULED cuya hora de inicio ya llego', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const service = new RoomsService({ room: { updateMany } } as never, catalog as never);
    const now = new Date('2030-01-01T10:00:00.000Z');
    await expect(service.activateDueRooms(now)).resolves.toEqual({ count: 2 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: 'SCHEDULED', startsAt: { lte: now } },
      data: { status: 'ACTIVE' },
    });
  });
});
