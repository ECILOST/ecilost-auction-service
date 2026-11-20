import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoBidsService } from '../bids/auto-bids.service.js';
import { RoomActivationScheduler } from './room-activation.scheduler.js';
import type { RoomsService } from './rooms.service.js';

function setup() {
  const activateDueRooms = vi.fn().mockResolvedValue(undefined);
  const resolvePending = vi.fn().mockResolvedValue(undefined);
  const scheduler = new RoomActivationScheduler(
    { activateDueRooms } as unknown as RoomsService,
    { resolvePending } as unknown as AutoBidsService,
  );
  vi.useFakeTimers();
  scheduler.onModuleInit();
  return { scheduler, activateDueRooms, resolvePending };
}

describe('RoomActivationScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('runs on startup and stops scheduling work when destroyed', async () => {
    const { scheduler, activateDueRooms, resolvePending } = setup();
    try {
      expect(activateDueRooms).toHaveBeenCalledTimes(1);
      expect(resolvePending).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(activateDueRooms).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.onModuleDestroy();
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(activateDueRooms).toHaveBeenCalledTimes(2);
  });

  it('keeps a single activation cycle in flight and recovers on the next interval', async () => {
    const { scheduler, activateDueRooms, resolvePending } = setup();
    let rejectActivation!: (reason: Error) => void;
    activateDueRooms.mockReturnValueOnce(new Promise<void>((_, reject) => { rejectActivation = reject; }));
    resolvePending.mockRejectedValueOnce(new Error('wallet unavailable'));
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(activateDueRooms).toHaveBeenCalledTimes(2);
      expect(resolvePending).toHaveBeenCalledTimes(3);
      rejectActivation(new Error('database unavailable'));
      await vi.advanceTimersByTimeAsync(500);
      expect(activateDueRooms).toHaveBeenCalledTimes(3);
    } finally {
      scheduler.onModuleDestroy();
    }
  });
});
