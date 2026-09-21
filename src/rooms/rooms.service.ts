import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoomStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CatalogReservationClient } from '../events/catalog-reservation.client.js';
import type { ScheduleRoomDto } from './dto/schedule-room.dto.js';

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

  /**
   * La comparacion y el incremento ocurren en la misma transaccion. El filtro por el
   * contador leido convierte la actualizacion en optimista: frente a solicitudes
   * simultaneas, solo una puede consumir el siguiente cupo.
   */
  async admitParticipant(roomId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
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
      const consumed = await tx.room.updateMany({
        where: { id: roomId, status: RoomStatus.SCHEDULED, admittedCount: room.admittedCount },
        data: { admittedCount: { increment: 1 } },
      });
      if (consumed.count !== 1) {
        // Otra solicitud pudo haber admitido a este mismo usuario mientras esta esperaba.
        const admittedConcurrently = await tx.roomParticipant.findUnique({
          where: { roomId_userId: { roomId, userId } },
        });
        if (admittedConcurrently) return { participant: admittedConcurrently, alreadyAdmitted: true };
        throw new ConflictException('Sala completa.');
      }

      const participant = await tx.roomParticipant.create({
        data: { id: randomUUID(), roomId, userId },
      });
      return { participant, alreadyAdmitted: false };
    });
  }

  /** Cambia una sala a ACTIVE una sola vez cuando llega su hora de inicio. */
  async activateDueRooms(now = new Date()) {
    return this.prisma.room.updateMany({
      where: { status: RoomStatus.SCHEDULED, startsAt: { lte: now } },
      data: { status: RoomStatus.ACTIVE },
    });
  }
}
