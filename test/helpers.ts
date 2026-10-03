import { randomUUID } from 'node:crypto';
import { Prisma, RoomStatus, RoundStatus } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { integrationDatabaseUrl } from './database.js';

const integrationSchema = new URL(integrationDatabaseUrl).searchParams.get('schema') ?? 'auction_it';

export function createPrisma() {
  return new PrismaService({ databaseUrl: integrationDatabaseUrl, databaseSchema: integrationSchema } as never);
}

/**
 * Vacia el esquema de pruebas. Se niega a correr si el SQL crudo no apunta a un esquema de
 * pruebas: un TRUNCATE en el esquema de desarrollo borraria datos reales.
 */
export async function resetDatabase(prisma: PrismaService) {
  const [{ schema }] = await prisma.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
  if (schema !== integrationSchema || !schema.endsWith('_it')) {
    throw new Error(`Las pruebas de integracion solo vacian un esquema "*_it"; la sesion apunta a "${schema}".`);
  }
  await prisma.$executeRawUnsafe(
    `TRUNCATE "${schema}"."outbox_events", "${schema}"."auto_bids", "${schema}"."bids", "${schema}"."round_entries", ` +
      `"${schema}"."room_participants", "${schema}"."rounds", "${schema}"."rooms" CASCADE`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Billetera en memoria con las mismas reglas que ecilost-wallet-service: `hold` fija el monto
 * reservado de la referencia (por diferencia contra el disponible), `release` solo libera si
 * el monto coincide (versionado), y nunca hay saldo negativo. Responde con un retraso al azar
 * para mezclar el orden de las operaciones concurrentes, como lo haria RabbitMQ.
 */
export class FakeWallet {
  readonly available = new Map<string, number>();
  readonly holds = new Map<string, number>();
  negativeSeen = false;

  constructor(balances: Record<string, number>, private readonly maxDelayMs = 5) {
    for (const [userId, balance] of Object.entries(balances)) this.available.set(userId, balance);
  }

  private async jitter() {
    await sleep(Math.random() * this.maxDelayMs);
  }

  async availableBalance(userId: string) {
    await this.jitter();
    return this.available.get(userId) ?? 0;
  }

  async hold(userId: string, reference: string, amount: number) {
    await this.jitter();
    const current = this.holds.get(reference) ?? 0;
    const delta = amount - current;
    const available = this.available.get(userId) ?? 0;
    if (delta > available) return false;
    this.available.set(userId, available - delta);
    this.holds.set(reference, amount);
    if (available - delta < 0) this.negativeSeen = true;
    return true;
  }

  async release(userId: string, reference: string, amount: number) {
    await this.jitter();
    if (this.holds.get(reference) !== amount) return true;
    this.holds.delete(reference);
    this.available.set(userId, (this.available.get(userId) ?? 0) + amount);
    return true;
  }

  heldBy(userId: string) {
    return [...this.holds.entries()].filter(([reference]) => reference.endsWith(`:${userId}`)).reduce((sum, [, amount]) => sum + amount, 0);
  }
}

type RoomSeed = {
  status?: RoomStatus;
  startsAt?: Date;
  participants?: string[];
  rounds: Array<{
    status?: RoundStatus;
    startingPrice?: number;
    currentPrice?: number;
    currentBidderId?: string | null;
    startedAt?: Date | null;
    endsAt?: Date | null;
    maximumEndsAt?: Date | null;
  }>;
};

export async function seedRoom(prisma: PrismaService, seed: RoomSeed) {
  const roomId = randomUUID();
  const rounds = seed.rounds.map((round, index) => ({ id: randomUUID(), position: index + 1, ...round }));
  await prisma.room.create({
    data: {
      id: roomId,
      name: 'Sala de integracion',
      status: seed.status ?? RoomStatus.ACTIVE,
      maximumCapacity: 50,
      admittedCount: seed.participants?.length ?? 0,
      startsAt: seed.startsAt ?? new Date(Date.now() - 60_000),
      scheduledBy: 'staff',
      participants: { create: (seed.participants ?? []).map((userId) => ({ id: randomUUID(), userId })) },
      rounds: {
        create: rounds.map((round) => ({
          id: round.id,
          position: round.position,
          status: round.status ?? RoundStatus.SCHEDULED,
          startingPrice: new Prisma.Decimal(round.startingPrice ?? 1000),
          currentPrice: new Prisma.Decimal(round.currentPrice ?? round.startingPrice ?? 1000),
          currentBidderId: round.currentBidderId ?? null,
          startedAt: round.startedAt ?? null,
          endsAt: round.endsAt ?? null,
          maximumEndsAt: round.maximumEndsAt ?? null,
          entries: { create: [{ id: randomUUID(), kind: 'ITEM', catalogId: randomUUID() }] },
        })),
      },
    },
  });
  return { roomId, roundIds: rounds.map((round) => round.id) };
}

/** Una ronda activa que vence en `endsInMs`, con tope de 8 minutos desde ahora. */
export function activeRound(endsInMs: number, overrides: RoomSeed['rounds'][number] = {}) {
  const now = Date.now();
  return {
    status: RoundStatus.ACTIVE,
    startedAt: new Date(now - 60_000),
    endsAt: new Date(now + endsInMs),
    maximumEndsAt: new Date(now + 8 * 60_000),
    ...overrides,
  };
}
