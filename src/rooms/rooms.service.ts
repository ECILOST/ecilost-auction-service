import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoomStatus, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CatalogReservationClient } from '../events/catalog-reservation.client.js';
import type { ScheduleRoomDto } from './dto/schedule-room.dto.js';

const ROUND_DURATION_MS = 3 * 60 * 1000;
const MAX_ROUND_DURATION_MS = 8 * 60 * 1000;

function roundTiming(startedAt: Date) {
  return {
    startedAt,
    endsAt: new Date(startedAt.getTime() + ROUND_DURATION_MS),
    maximumEndsAt: new Date(startedAt.getTime() + MAX_ROUND_DURATION_MS),
  };
}

@Injectable()
export class RoomsService {
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
    const roomId = randomUUID();
    const rounds = input.rounds.map((round, index) => ({ id: randomUUID(), position: index + 1, entries: round.entries }));
    const reserved = await this.catalog.reserve(rounds.flatMap((round) => round.entries.map((entry) => ({ ...entry, roundId: round.id }))));
    if (!reserved) throw new ConflictException('Uno o mas objetos o lotes ya no estan disponibles.');
    try {
      return await this.prisma.room.create({
        data: {
          id: roomId,
          maximumCapacity: input.maximumCapacity,
          startsAt: new Date(input.startsAt),
          scheduledBy,
          rounds: {
            create: rounds.map((round) => ({
              id: round.id, position: round.position,
              entries: { create: round.entries.map((entry) => ({ id: randomUUID(), kind: entry.kind, catalogId: entry.catalogId })) },
            })),
          },
        },
        include: { rounds: { orderBy: { position: 'asc' }, include: { entries: true } } },
      });
    } catch (error) {
      if ((error instanceof Prisma.PrismaClientKnownRequestError || (error as { code?: string }).code === 'P2002') && (error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Un objeto o lote ya pertenece a una sala programada o activa.');
      }
      throw error;
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
   * Cambia una sala a ACTIVE una sola vez cuando llega su hora de inicio y abre
   * su primera ronda. Las rondas posteriores conservan su propio ciclo de vida.
   */
  async activateDueRooms(now = new Date()) {
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
        await tx.round.updateMany({
          where: { roomId: room.id, position: 1, status: RoundStatus.SCHEDULED },
          data: { status: RoundStatus.ACTIVE, ...roundTiming(now) },
        });
      }

      // Recupera rondas que ya estaban activas antes de que existieran los campos de tiempo.
      const activeRoundsWithoutTiming = await tx.round.findMany({
        where: { status: RoundStatus.ACTIVE, endsAt: null },
        select: { id: true },
      });
      for (const round of activeRoundsWithoutTiming) {
        await tx.round.updateMany({
          where: { id: round.id, status: RoundStatus.ACTIVE, endsAt: null },
          data: roundTiming(now),
        });
      }

      const expiredRounds = await tx.round.findMany({
        where: { status: RoundStatus.ACTIVE, endsAt: { lte: now } },
        select: { id: true, roomId: true, position: true },
      });
      for (const round of expiredRounds) {
        const closed = await tx.round.updateMany({
          where: { id: round.id, status: RoundStatus.ACTIVE, endsAt: { lte: now } },
          data: { status: RoundStatus.CLOSED },
        });
        if (closed.count !== 1) continue;

        const nextRound = await tx.round.findFirst({
          where: { roomId: round.roomId, position: { gt: round.position }, status: RoundStatus.SCHEDULED },
          orderBy: { position: 'asc' },
          select: { id: true },
        });
        if (nextRound) {
          await tx.round.updateMany({
            where: { id: nextRound.id, status: RoundStatus.SCHEDULED },
            data: { status: RoundStatus.ACTIVE, ...roundTiming(now) },
          });
        } else {
          await tx.room.updateMany({
            where: { id: round.roomId, status: RoomStatus.ACTIVE },
            data: { status: RoomStatus.CLOSED },
          });
        }
      }
      return { count };
    });
  }
}
