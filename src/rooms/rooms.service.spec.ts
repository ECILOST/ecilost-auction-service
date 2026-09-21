import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RoomsService } from './rooms.service.js';

const item = '11111111-1111-4111-8111-111111111111';
const valid = { maximumCapacity: 30, startsAt: '2030-01-01T10:00:00.000Z', rounds: [{ entries: [{ kind: 'ITEM' as const, catalogId: item }] }] };

describe('RoomsService', () => {
  it('crea una sala SCHEDULED con rondas encadenadas', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'room', status: 'SCHEDULED', rounds: [] });
    const service = new RoomsService({ room: { create } } as never);
    await expect(service.schedule(valid, 'staff')).resolves.toMatchObject({ status: 'SCHEDULED' });
    expect(create).toHaveBeenCalledOnce();
  });
  it.each([0, -1])('rechaza aforo %i', async (maximumCapacity) => {
    const service = new RoomsService({ room: { create: vi.fn() } } as never);
    await expect(service.schedule({ ...valid, maximumCapacity }, 'staff')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rechaza una sala sin rondas o una ronda vacia', async () => {
    const service = new RoomsService({ room: { create: vi.fn() } } as never);
    await expect(service.schedule({ ...valid, rounds: [] }, 'staff')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.schedule({ ...valid, rounds: [{ entries: [] }] }, 'staff')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('convierte la restriccion unica concurrente en conflicto', async () => {
    const service = new RoomsService({ room: { create: vi.fn().mockRejectedValue({ code: 'P2002' }) } } as never);
    await expect(service.schedule(valid, 'staff')).rejects.toBeInstanceOf(ConflictException);
  });
});
