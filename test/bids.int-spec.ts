import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BidStatus, RoundStatus } from '../src/generated/prisma/client.js';
import { BidsService } from '../src/bids/bids.service.js';
import { activeRound, createPrisma, FakeWallet, resetDatabase, seedRoom } from './helpers.js';

/**
 * HU-21 y HU-23 contra PostgreSQL real: la serializacion vive en SQL (`FOR UPDATE` sobre la
 * fila de la ronda), asi que solo una base de verdad puede demostrarla.
 */
describe('Pujas concurrentes y anti-sniping (PostgreSQL)', () => {
  const prisma = createPrisma();
  const bidders = Array.from({ length: 12 }, (_, index) => `student-${index}`);

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  async function placeAll(service: BidsService, roundId: string, offers: Array<[string, number]>) {
    return Promise.allSettled(offers.map(([bidder, amount]) => service.place(roundId, bidder, amount)));
  }

  it('N pujas simultaneas dejan un orden total, precio maximo, un solo lider y fondos coherentes', async () => {
    const wallet = new FakeWallet(Object.fromEntries(bidders.map((bidder) => [bidder, 1_000_000])));
    const service = new BidsService(prisma, wallet as never);
    const { roundIds: [roundId] } = await seedRoom(prisma, { participants: bidders, rounds: [activeRound(5 * 60_000)] });

    // Montos repetidos a proposito: dos pujas iguales no pueden quedar ambas vigentes.
    const offers = bidders.map((bidder, index) => [bidder, 1000 + (index % 6) * 100] as [string, number]);
    await placeAll(service, roundId, offers);

    const round = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    const bids = await prisma.bid.findMany({ where: { roundId }, orderBy: { sequence: 'asc' } });
    const accepted = bids.filter((bid) => bid.status === BidStatus.ACCEPTED);

    // Cada intento quedo registrado con una secuencia unica y sin huecos.
    expect(bids.map((bid) => Number(bid.sequence))).toEqual(bids.map((_, index) => index + 1));
    // El historial aceptado es estrictamente creciente y termina en el precio vigente.
    for (let index = 1; index < accepted.length; index += 1) expect(accepted[index].amount.gt(accepted[index - 1].amount)).toBe(true);
    expect(round.currentPrice.eq(accepted.at(-1)!.amount)).toBe(true);
    expect(round.currentBidderId).toBe(accepted.at(-1)!.bidderId);

    // Solo el lider conserva fondos comprometidos, exactamente por el precio vigente.
    expect(wallet.negativeSeen).toBe(false);
    for (const bidder of bidders) {
      expect(wallet.heldBy(bidder)).toBe(bidder === round.currentBidderId ? Number(round.currentPrice) : 0);
    }
  });

  it('una puja con mas de un minuto restante no mueve el cierre', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const service = new BidsService(prisma, wallet as never);
    const round = activeRound(3 * 60_000);
    const { roundIds: [roundId] } = await seedRoom(prisma, { participants: ['alice'], rounds: [round] });
    const result = await service.place(roundId, 'alice', 1000);
    expect(result.extended).toBe(false);
    const stored = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    expect(stored.endsAt!.getTime()).toBe(round.endsAt.getTime());
  });

  it('una puja en el ultimo minuto lleva el cierre a ahora + 60 s', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const service = new BidsService(prisma, wallet as never);
    const { roundIds: [roundId] } = await seedRoom(prisma, { participants: ['alice'], rounds: [activeRound(20_000)] });
    const before = Date.now();
    const result = await service.place(roundId, 'alice', 1000);
    const after = Date.now();
    expect(result.extended).toBe(true);
    const endsAt = (await prisma.round.findUniqueOrThrow({ where: { id: roundId } })).endsAt!.getTime();
    // Margen de un segundo por la diferencia entre el reloj de la base y el de la prueba.
    expect(endsAt).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(endsAt).toBeLessThanOrEqual(after + 60_000 + 1000);
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'auction.bid.accepted.v1' } });
    expect(event.payload).toMatchObject({ extended: true, automatic: false, endsAt: new Date(endsAt).toISOString() });
  });

  it('pujas simultaneas en el ultimo minuto dejan un unico cierre, sin acumular extensiones', async () => {
    const wallet = new FakeWallet(Object.fromEntries(bidders.map((bidder) => [bidder, 1_000_000])));
    const service = new BidsService(prisma, wallet as never);
    const { roundIds: [roundId] } = await seedRoom(prisma, { participants: bidders, rounds: [activeRound(15_000)] });
    const before = Date.now();
    await placeAll(service, roundId, bidders.map((bidder, index) => [bidder, 1000 + index * 100]));
    const after = Date.now();
    const endsAt = (await prisma.round.findUniqueOrThrow({ where: { id: roundId } })).endsAt!.getTime();
    // Doce extensiones acumuladas serian doce minutos; con la regla es un solo minuto.
    expect(endsAt).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(endsAt).toBeLessThanOrEqual(after + 60_000 + 1000);
  });

  it('la extension nunca pasa del cierre maximo de la ronda', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const service = new BidsService(prisma, wallet as never);
    const maximumEndsAt = new Date(Date.now() + 25_000);
    const { roundIds: [roundId] } = await seedRoom(prisma, { participants: ['alice'], rounds: [activeRound(10_000, { maximumEndsAt })] });
    await service.place(roundId, 'alice', 1000);
    const stored = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    expect(stored.endsAt!.getTime()).toBe(maximumEndsAt.getTime());
  });

  it('una ronda cerrada o vencida no acepta pujas ni compromete fondos', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const service = new BidsService(prisma, wallet as never);
    const { roundIds: [closed] } = await seedRoom(prisma, { participants: ['alice'], rounds: [activeRound(60_000, { status: RoundStatus.CLOSED })] });
    await expect(service.place(closed, 'alice', 1000)).rejects.toThrow('La ronda no esta activa.');
    const { roundIds: [expired] } = await seedRoom(prisma, { participants: ['alice'], rounds: [activeRound(-1000)] });
    await expect(service.place(expired, 'alice', 1000)).rejects.toThrow('La ronda no esta activa.');
    expect(wallet.heldBy('alice')).toBe(0);
    expect(await prisma.bid.count()).toBe(0);
  });
});
