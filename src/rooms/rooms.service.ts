import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BidStatus, Prisma, RoomStatus, RoundCloseReason, RoundResult, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CatalogReservationClient } from '../events/catalog-reservation.client.js';
import { closeRoundAndAdvance, enqueueRoundEvent, ROUND_EVENT_SELECT, roundTiming } from '../rounds/round-lifecycle.js';
import type { ListRoomsQueryDto } from './dto/list-rooms-query.dto.js';
import type { ScheduleRoomDto } from './dto/schedule-room.dto.js';

const ROOM_SUMMARY = {
  id: true, name: true, status: true, startsAt: true, maximumCapacity: true, admittedCount: true, createdAt: true,
} as const;

/**
 * Lo que se publica de una sala con sus rondas. Es un `select` explicito y no un `include`
 * a proposito: `rounds.nextBidSequence` es BigInt y JSON no sabe serializarlo, asi que un
 * `include` hacia fallar la respuesta con 500 despues de haber guardado la sala.
 */
const roomDetailSelect = (userId: string) => ({
  ...ROOM_SUMMARY,
  participants: { where: { userId }, select: { id: true }, take: 1 },
  rounds: {
    orderBy: { position: 'asc' as const },
    select: {
      id: true, position: true, status: true, startingPrice: true, currentPrice: true, buyNowPrice: true, currentBidderId: true,
      startedAt: true, endsAt: true, maximumEndsAt: true, result: true, closedAt: true, closeReason: true,
      entries: { select: { kind: true, catalogId: true } },
      // Solo la mejor puja aceptada de quien consulta: la de los demas no se publica.
      bids: {
        where: { bidderId: userId, status: BidStatus.ACCEPTED },
        orderBy: { amount: 'desc' as const },
        take: 1,
        select: { amount: true },
      },
    },
  },
});

const statusFilter = (status?: RoomStatus[]) => (status?.length ? { status: { in: status } } : undefined);

/**
 * El lider de cada ronda se publica como dos banderas y no como su userId: quien consulta
 * necesita saber si ya hay pujas (para calcular la minima) y si el lider es el, no quien es
 * el otro. La sala la ven tambien quienes no participan.
 */
function toRoomDetail<T extends {
  participants: unknown[];
  rounds: Array<{ currentBidderId: string | null; bids?: Array<{ amount: Prisma.Decimal }> }>;
}>(
  { participants, rounds, ...room }: T,
  userId: string,
) {
  return {
    ...room,
    isParticipant: participants.length > 0,
    rounds: rounds.map(({ currentBidderId, bids, ...round }) => ({
      ...round,
      hasBids: currentBidderId !== null,
      isLeading: currentBidderId === userId,
      myHighestBid: bids?.[0]?.amount ?? null,
    })),
  };
}

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(private readonly prisma: PrismaService, private readonly catalog: CatalogReservationClient) {}

  /**
   * Una sola escritura anidada persiste sala, rondas y reservas. La restriccion unica de
   * RoundEntry es el arbitro de concurrencia: dos funcionarios no pueden programar la
   * misma referencia en salas distintas por una carrera de lecturas previas.
   */
  async schedule(input: ScheduleRoomDto, scheduledBy: string) {
    if (input.maximumCapacity <= 0) throw new BadRequestException('El aforo maximo debe ser mayor que cero.');
    if (!input.rounds.length || input.rounds.some((round) => !round.entries.length)) {
      throw new BadRequestException('La sala debe tener rondas y cada ronda debe contener al menos un objeto o lote.');
    }
    if (input.rounds.some((round) => !Number.isInteger(round.startingPrice) || round.startingPrice < 1)) {
      throw new BadRequestException('Cada ronda debe tener un precio minimo entero mayor que cero.');
    }
    // HU-24: comprar de inmediato debe costar mas que la primera puja posible.
    if (input.rounds.some((round) => round.buyNowPrice != null && (!Number.isInteger(round.buyNowPrice) || round.buyNowPrice <= round.startingPrice))) {
      throw new BadRequestException('El precio de compra inmediata debe ser un entero mayor que el precio minimo de la ronda.');
    }
    const roomId = randomUUID();
    const rounds = input.rounds.map((round, index) => ({
      id: randomUUID(), position: index + 1, entries: round.entries, startingPrice: new Prisma.Decimal(round.startingPrice),
      buyNowPrice: round.buyNowPrice != null ? new Prisma.Decimal(round.buyNowPrice) : null,
    }));
    // Si catalog no contesta a tiempo no se sabe si reservo: se compensa por si acaso. Si
    // contesto que no, ya deshizo lo suyo en su propia transaccion y no hay nada que liberar.
    let reserved: boolean;
    try {
      reserved = await this.catalog.reserve(rounds.flatMap((round) => round.entries.map((entry) => ({ ...entry, roundId: round.id }))));
    } catch (error) {
      await this.compensateReservation(roomId, rounds);
      throw error;
    }
    if (!reserved) throw new ConflictException('Uno o mas objetos o lotes ya no estan disponibles.');
    try {
      const room = await this.prisma.room.create({
        data: {
          id: roomId,
          name: input.name,
          maximumCapacity: input.maximumCapacity,
          startsAt: new Date(input.startsAt),
          scheduledBy,
          rounds: {
            create: rounds.map((round) => ({
              // El precio vigente arranca en el minimo: es lo que ve la sala antes de la primera puja.
              id: round.id, position: round.position, startingPrice: round.startingPrice, currentPrice: round.startingPrice,
              buyNowPrice: round.buyNowPrice,
              entries: { create: round.entries.map((entry) => ({ id: randomUUID(), kind: entry.kind, catalogId: entry.catalogId })) },
            })),
          },
        },
        select: roomDetailSelect(scheduledBy),
      });
      return toRoomDetail(room, scheduledBy);
    } catch (error) {
      // Catalog ya reservo y la sala no existira: sin compensar, esos objetos quedarian
      // "En subasta" para siempre, reservados por rondas que nadie va a cerrar.
      await this.compensateReservation(roomId, rounds);
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Un objeto o lote ya pertenece a una sala programada o activa.');
      }
      throw error;
    }
  }

  /**
   * Pide a catalog que suelte lo que reservo para una sala que no llego a existir.
   *
   * No es una transaccion distribuida sino una orden compensatoria: va por el outbox, asi
   * que se reintenta hasta que RabbitMQ la acepte. Catalog la procesa en la misma cola que
   * la reserva y de a un mensaje, de modo que nunca se adelanta a la reserva que anula, y
   * solo libera lo que siga reservado por ESTAS rondas: repetirla, o recibirla cuando catalog
   * habia rechazado la reserva, no cambia nada.
   *
   * Si ni siquiera la base de auction acepta la orden, se intenta publicar directo; si eso
   * tambien falla, queda en el log con lo necesario para liberar a mano.
   */
  private async compensateReservation(roomId: string, rounds: Array<{ id: string; entries: Array<{ kind: string; catalogId: string }> }>) {
    const eventId = randomUUID();
    const eventType = 'catalog.round-reservation.cancelled.v1';
    const payload = {
      eventId,
      eventType,
      occurredAt: new Date().toISOString(),
      roomId,
      rounds: rounds.map((round) => ({ roundId: round.id, entries: round.entries.map(({ kind, catalogId }) => ({ kind, catalogId })) })),
    };
    try {
      await this.prisma.outboxEvent.create({ data: { id: eventId, eventType, routingKey: eventType, aggregateId: roomId, payload } });
    } catch (outboxError) {
      try {
        await this.catalog.cancel(payload);
      } catch (publishError) {
        this.logger.error(
          `No se pudo pedir a catalog que libere la reserva de la sala ${roomId}; hay que liberarla a mano: ${JSON.stringify(payload.rounds)}`,
          `${String(outboxError)} / ${String(publishError)}`,
        );
      }
    }
  }

  /** La base de datos arbitra el aforo con una comparacion entre ambas columnas. */
  async admitParticipant(roomId: string, userId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const room = await tx.room.findUnique({
          where: { id: roomId },
          select: { id: true, status: true, maximumCapacity: true, admittedCount: true },
        });
        if (!room) throw new NotFoundException('La sala no existe.');

        const alreadyAdmitted = await tx.roomParticipant.findUnique({
          where: { roomId_userId: { roomId, userId } },
        });
        if (alreadyAdmitted && (room.status === RoomStatus.SCHEDULED || room.status === RoomStatus.ACTIVE)) {
          return { participant: alreadyAdmitted, alreadyAdmitted: true };
        }

        if (room.status === RoomStatus.ACTIVE) throw new ConflictException('Sala cerrada.');
        if (room.status !== RoomStatus.SCHEDULED) throw new ConflictException('La sala no esta disponible.');

        if (room.admittedCount >= room.maximumCapacity) throw new ConflictException('Sala completa.');
        const consumed = await tx.$executeRaw`
          UPDATE "rooms"
          SET "admittedCount" = "admittedCount" + 1
          WHERE "id" = ${roomId}
            AND "status" = CAST(${RoomStatus.SCHEDULED} AS "RoomStatus")
            AND "admittedCount" < "maximumCapacity"
        `;
        if (consumed !== 1) {
          // Otra solicitud pudo haber admitido a este mismo usuario mientras esta esperaba.
          const admittedConcurrently = await tx.roomParticipant.findUnique({
            where: { roomId_userId: { roomId, userId } },
          });
          if (admittedConcurrently) return { participant: admittedConcurrently, alreadyAdmitted: true };
          const currentRoom = await tx.room.findUnique({
            where: { id: roomId },
            select: { status: true, maximumCapacity: true, admittedCount: true },
          });
          if (!currentRoom) throw new NotFoundException('La sala no existe.');
          if (currentRoom.status === RoomStatus.ACTIVE) throw new ConflictException('Sala cerrada.');
          if (currentRoom.status !== RoomStatus.SCHEDULED) throw new ConflictException('La sala no esta disponible.');
          if (currentRoom.admittedCount >= currentRoom.maximumCapacity) throw new ConflictException('Sala completa.');
          throw new ConflictException('No fue posible reservar un cupo. Intenta de nuevo.');
        }

        const participant = await tx.roomParticipant.create({
          data: { id: randomUUID(), roomId, userId },
        });
        return { participant, alreadyAdmitted: false };
      });
    } catch (error) {
      // Una segunda solicitud simultanea del mismo estudiante revierte su incremento
      // por la restriccion unica; luego se responde como reconexion idempotente.
      if ((error as { code?: string }).code === 'P2002') {
        const participant = await this.prisma.roomParticipant.findUnique({ where: { roomId_userId: { roomId, userId } } });
        if (participant) return { participant, alreadyAdmitted: true };
      }
      throw error;
    }
  }

  /**
   * Salas para descubrir (estudiante) o administrar (funcionario), de la mas proxima a la
   * mas lejana. Sin `include`, solo datos de la sala; con `include=rounds`, cada una con el
   * mismo detalle que `getRoom` (ver `listRoomDetails`). `status` filtra en ambos casos.
   */
  async listRooms(userId: string, query: ListRoomsQueryDto = {}) {
    if (query.include === 'rounds') return this.listRoomDetails(userId, query.status);
    const rooms = await this.prisma.room.findMany({
      where: statusFilter(query.status),
      orderBy: { startsAt: 'asc' },
      select: {
        ...ROOM_SUMMARY,
        participants: { where: { userId }, select: { id: true }, take: 1 },
        _count: { select: { rounds: true } },
      },
    });
    return rooms.map(({ participants, _count, ...room }) => ({
      ...room, roundCount: _count.rounds, isParticipant: participants.length > 0,
    }));
  }

  /**
   * Una sala con sus rondas en orden. Las entradas solo traen `kind` y `catalogId`: el
   * nombre y las fotos son de Catalog, y Auction no guarda copia para no desincronizarse.
   */
  async getRoom(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId }, select: roomDetailSelect(userId) });
    if (!room) throw new NotFoundException('La sala no existe.');
    // `serverTime` deja al cliente corregir su reloj para pintar el contador; nunca decide
    // nada. Sale del reloj de la base, el mismo que acepta pujas y cierra rondas: con el del
    // contenedor, un desfase entre los dos dejaba el contador en cero con la ronda abierta.
    return { ...toRoomDetail(room, userId), serverTime: await this.databaseNow() };
  }

  /**
   * Las salas (todas, o las de `status`) con sus rondas, en una sola consulta: el listado de
   * subastas antes pedia el detalle sala por sala. Usa el mismo `select` y el mismo mapeo que
   * `getRoom`, para que las dos respuestas no puedan divergir.
   */
  private async listRoomDetails(userId: string, status?: RoomStatus[]) {
    const [rooms, serverTime] = await Promise.all([
      this.prisma.room.findMany({
        where: statusFilter(status),
        orderBy: { startsAt: 'asc' },
        select: roomDetailSelect(userId),
      }),
      this.databaseNow(),
    ]);
    return rooms.map((room) => ({ ...toRoomDetail(room, userId), serverTime }));
  }

  async getCurrentState(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        status: true,
        participants: { where: { userId }, select: { id: true }, take: 1 },
        rounds: {
          where: { status: RoundStatus.ACTIVE },
          orderBy: { position: 'asc' },
          take: 1,
          select: {
            id: true,
            position: true,
            status: true,
            currentPrice: true,
            // HU-24: la ronda vigente ofrece compra inmediata si tiene precio y las pujas no lo alcanzaron.
            buyNowPrice: true,
            currentBidderId: true,
            startedAt: true,
            endsAt: true,
            maximumEndsAt: true,
            entries: { select: { kind: true, catalogId: true } },
            // Solo la puja automatica de quien consulta (HU-22).
            autoBids: { where: { bidderId: userId }, select: { enabled: true, maximumAmount: true, stoppedReason: true }, take: 1 },
          },
        },
      },
    });
    if (!room) throw new NotFoundException('La sala no existe.');
    if (room.participants.length === 0) throw new ForbiddenException('Debes estar admitido en la sala para consultar su estado.');

    const { participants: _participants, rounds, ...roomState } = room;
    const current = rounds[0];
    const serverTime = await this.databaseNow();
    if (!current) return { ...roomState, currentRound: null, autoBid: null, serverTime };
    const { autoBids, ...currentRound } = current;
    const autoBid = autoBids?.[0];
    return {
      ...roomState,
      currentRound,
      autoBid: autoBid
        ? { enabled: autoBid.enabled, maximumAmount: autoBid.maximumAmount, stopped: autoBid.stoppedReason !== null, stoppedReason: autoBid.stoppedReason }
        : null,
      serverTime,
    };
  }
  /**
   * Hora del reloj autoritativo: el de PostgreSQL, el mismo con el que la puja decide si
   * llego a tiempo (`"endsAt" > CURRENT_TIMESTAMP`). Con un solo reloj, un desfase entre la
   * maquina del servicio y la base no puede cerrar una ronda que la base aun considera
   * abierta, ni al reves. Se pide como texto UTC para no depender de la zona de la sesion.
   */
  private async databaseNow(): Promise<Date> {
    const [{ now }] = await this.prisma.$queryRaw<Array<{ now: string }>>`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
    `;
    return new Date(now);
  }

  /**
   * Motor del ciclo de vida (HU-18, HU-19). El reloj del servidor es su unico dueno: el
   * cliente no puede abrir ni cerrar nada.
   *
   * - Una sala SCHEDULED cuya hora llego pasa a ACTIVE (y con eso cierra el acceso) y abre
   *   su primera ronda.
   * - Una ronda ACTIVE vencida se cierra con su ganador y, en el mismo instante, se abre la
   *   siguiente; si era la ultima, la sala pasa a CLOSED y ya no acepta pujas.
   *
   * Todas las condiciones van en el WHERE: si dos instancias corren el ciclo a la vez, solo
   * una cambia cada fila y solo esa publica el evento.
   */
  async activateDueRooms(at?: Date) {
    const now = at ?? (await this.databaseNow());
    return this.prisma.$transaction(async (tx) => {
      const dueRooms = await tx.room.findMany({
        where: { status: RoomStatus.SCHEDULED, startsAt: { lte: now } },
        select: { id: true },
      });
      let count = 0;
      for (const room of dueRooms) {
        // La condición preserva el resultado si dos ciclos del scheduler se cruzan.
        const activated = await tx.room.updateMany({
          where: { id: room.id, status: RoomStatus.SCHEDULED, startsAt: { lte: now } },
          data: { status: RoomStatus.ACTIVE },
        });
        if (activated.count !== 1) continue;
        count += 1;
        this.logger.log(`room=${room.id} SCHEDULED -> ACTIVE at=${now.toISOString()}`);
        const firstRound = await tx.round.updateMany({
          where: { roomId: room.id, position: 1, status: RoundStatus.SCHEDULED },
          data: { status: RoundStatus.ACTIVE, ...roundTiming(now) },
        });
        if (firstRound.count === 1) {
          const activatedRound = await tx.round.findFirst({
            where: { roomId: room.id, position: 1, status: RoundStatus.ACTIVE },
            select: ROUND_EVENT_SELECT,
          });
          if (activatedRound) {
            await enqueueRoundEvent(tx, 'auction.round.activated.v1', activatedRound, RoomStatus.ACTIVE);
            this.logger.log(`room=${room.id} round=${activatedRound.id} position=1 SCHEDULED -> ACTIVE endsAt=${activatedRound.endsAt?.toISOString()}`);
          }
        }
      }

      const expiredRounds = await tx.round.findMany({
        where: { status: RoundStatus.ACTIVE, endsAt: { lte: now } },
        orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      for (const { id } of expiredRounds) {
        // Se bloquea la fila antes de leer al lider. Una puja en curso termina primero (o
        // espera a este cierre), y lo leido despues del bloqueo es definitivo: si esa puja
        // extendio el cierre, la ronda ya no vence y no se cierra; si no, su lider es el
        // ganador. Leerlo antes del bloqueo podia adjudicar a quien ya habia sido superado.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "rounds"
          WHERE id = ${id}
            AND status = CAST(${RoundStatus.ACTIVE} AS "RoundStatus")
            AND "endsAt" <= CAST(${now.toISOString()} AS timestamp)
          FOR UPDATE
        `;
        if (locked.length === 0) continue;
        const round = await tx.round.findUnique({ where: { id }, select: ROUND_EVENT_SELECT });
        if (!round) continue;

        await closeRoundAndAdvance(tx, round, now, {
          result: round.currentBidderId ? RoundResult.AWARDED : RoundResult.DESERTED,
          winnerId: round.currentBidderId,
          closeReason: RoundCloseReason.EXPIRED,
        }, this.logger);
      }
      return { count };
    });
  }
}
