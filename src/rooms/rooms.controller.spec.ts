import { describe, expect, it, vi } from 'vitest';
import { Principal, Role } from '../common/principal.js';
import type { DynamicModesService } from './dynamic-modes.service.js';
import { RoomsController } from './rooms.controller.js';
import type { RoomsService } from './rooms.service.js';

const student = new Principal('student', Role.STUDENT);
const operator = new Principal('operator', Role.STAFF);
const roomId = 'room-1';

function setup() {
  const rooms = { getRoom: vi.fn(), getCurrentState: vi.fn(), admitParticipant: vi.fn() };
  const modes = { setEnabled: vi.fn(), spin: vi.fn() };
  const controller = new RoomsController(
    rooms as unknown as RoomsService, modes as unknown as DynamicModesService,
  );
  return { controller, rooms, modes };
}

describe('RoomsController', () => {
  it('reads a room and its live state for the requesting student', async () => {
    const { controller, rooms } = setup();
    const detail = { id: roomId };
    const state = { roundId: 'round-1' };
    rooms.getRoom.mockResolvedValue(detail);
    rooms.getCurrentState.mockResolvedValue(state);

    await expect(controller.detail(student, roomId)).resolves.toEqual(detail);
    await expect(controller.currentState(student, roomId)).resolves.toEqual(state);
    expect(rooms.getRoom).toHaveBeenCalledWith(roomId, student.userId);
    expect(rooms.getCurrentState).toHaveBeenCalledWith(roomId, student.userId);
  });

  it('uses the requesting student as the participant', async () => {
    const { controller, rooms } = setup();
    const admission = { roomId, userId: student.userId };
    rooms.admitParticipant.mockResolvedValue(admission);

    await expect(controller.admitParticipant(student, roomId)).resolves.toEqual(admission);
    expect(rooms.admitParticipant).toHaveBeenCalledWith(roomId, student.userId);
  });

  it('forwards mode changes and spins with the operator and target round', async () => {
    const { controller, modes } = setup();
    modes.setEnabled.mockResolvedValue({ enabled: false });
    modes.spin.mockResolvedValue({ mode: 'MYSTERY' });

    await expect(controller.setDynamicModes(operator, roomId, { enabled: false })).resolves.toEqual({ enabled: false });
    await expect(controller.spin(operator, roomId, 'round-2')).resolves.toEqual({ mode: 'MYSTERY' });
    expect(modes.setEnabled).toHaveBeenCalledWith(roomId, operator.userId, false);
    expect(modes.spin).toHaveBeenCalledWith(roomId, 'round-2', operator.userId);
  });
});
