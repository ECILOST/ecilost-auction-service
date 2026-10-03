import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RoomStatus, RoundStatus } from '../src/generated/prisma/client.js';
import { BidsService } from '../src/bids/bids.service.js';
import { RoomsService } from '../src/rooms/rooms.service.js';
import { activeRound, createPrisma, FakeWallet, resetDatabase, seedRoom } from './helpers.js';

/** HU-18 y HU-19 contra PostgreSQL real, con el reloj de la base como unico dueno. */
describe('Ciclo de vida de la sala (PostgreSQL)', () => {
  const prisma = createPrisma();
  const rooms = new RoomsService(prisma, { reserve: async () => true } as never);

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  const events = async () =>
    (await prisma.outboxEvent.findMany({ orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((event) => event.payload as Record<string, unknown>);

  it('abre la sala a su hora, encadena las rondas y la cierra al vencer la ultima', async () => {
    const { roomId, roundIds } = await seedRoom(prisma, {
      status: RoomStatus.SCHEDULED, startsAt: new Date(Date.now() - 1000), participants: ['alice'], rounds: [{}, {}],
    });

    // Inicio: sin intervencion manual, con la hora de la base.
    await rooms.activateDueRooms();
    expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).status).toBe(RoomStatus.ACTIVE);
    const first = await prisma.round.findUniqueOrThrow({ where: { id: roundIds[0] } });
    expect(first.status).toBe(RoundStatus.ACTIVE);
    expect(first.endsAt!.getTime() - first.startedAt!.getTime()).toBe(3 * 60_000);

    // Fin de la ronda 1: se cierra y la 2 se abre en el mismo instante.
    const closeAt = new Date(first.endsAt!.getTime() + 1);
    await rooms.activateDueRooms(closeAt);
    const [round1, round2] = await Promise.all(roundIds.map((id) => prisma.round.findUniqueOrThrow({ where: { id } })));
    expect(round1.status).toBe(RoundStatus.CLOSED);
    expect(round2.status).toBe(RoundStatus.ACTIVE);
    expect(round2.startedAt!.getTime()).toBe(closeAt.getTime());

    // Quien entra despues de la transicion ve directamente la ronda vigente.
    const state = await rooms.getCurrentState(roomId, 'alice');
    expect(state.currentRound?.id).toBe(roundIds[1]);

    // Ultima ronda: la sala termina.
    await rooms.activateDueRooms(new Date(round2.endsAt!.getTime() + 1));
    expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).status).toBe(RoomStatus.CLOSED);
    expect((await rooms.getCurrentState(roomId, 'alice')).currentRound).toBeNull();

    expect((await events()).map((event) => [event.eventType, event.position, event.roomStatus])).toEqual([
      ['auction.round.activated.v1', 1, 'ACTIVE'],
      ['auction.round.closed.v1', 1, 'ACTIVE'],
      ['auction.round.activated.v1', 2, 'ACTIVE'],
      ['auction.round.closed.v1', 2, 'CLOSED'],
    ]);

    // Una sala terminada no acepta pujas.
    const bids = new BidsService(prisma, new FakeWallet({ alice: 10_000 }) as never);
    await expect(bids.place(roundIds[1], 'alice', 5000)).rejects.toThrow('La ronda no esta activa.');
  });

  it('dos ciclos simultaneos (dos instancias) producen una sola transicion y un solo evento', async () => {
    const { roundIds } = await seedRoom(prisma, { participants: ['alice'], rounds: [activeRound(-1000), {}] });
    await Promise.all([rooms.activateDueRooms(), rooms.activateDueRooms(), rooms.activateDueRooms()]);
    const types = (await events()).map((event) => event.eventType);
    expect(types).toEqual(['auction.round.closed.v1', 'auction.round.activated.v1']);
    expect((await prisma.round.findUniqueOrThrow({ where: { id: roundIds[1] } })).status).toBe(RoundStatus.ACTIVE);
  });

  it('adjudica a quien lidera al cerrar aunque una puja llegue en el instante del cierre', async () => {
    const wallet = new FakeWallet({ alice: 10_000, bob: 10_000 });
    const bids = new BidsService(prisma, wallet as never);
    // La ronda ya esta en su tope: una puja no puede extenderla.
    const endsAt = new Date(Date.now() + 400);
    const { roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['alice', 'bob'], rounds: [activeRound(400, { endsAt, maximumEndsAt: endsAt })],
    });
    await bids.place(roundId, 'alice', 1000);

    // Puja y cierre compiten; el cierre corre con una hora ya vencida.
    await Promise.allSettled([bids.place(roundId, 'bob', 1100), rooms.activateDueRooms(new Date(endsAt.getTime() + 1))]);
    await rooms.activateDueRooms(new Date(endsAt.getTime() + 1));

    const round = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    expect(round.status).toBe(RoundStatus.CLOSED);
    // Exactamente un ganador, y es quien lideraba al cerrar.
    expect(round.winnerId).toBe(round.currentBidderId);
    const closed = (await events()).find((event) => event.eventType === 'auction.round.closed.v1');
    expect(closed).toMatchObject({ winnerId: round.currentBidderId, winningAmount: round.currentPrice.toString() });
  });
});
