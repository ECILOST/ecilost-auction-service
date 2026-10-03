import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BidStatus, Prisma, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WalletHoldClient } from '../events/wallet-hold.client.js';

export type PlacedBid = {
  id: string;
  roundId: string;
  bidderId: string;
  amount: Prisma.Decimal;
  sequence: bigint;
  previousBidderId: string | null;
  previousPrice: Prisma.Decimal | null;
  status: BidStatus;
  endsAt: Date;
  extended: boolean;
};

/** Para el motor de pujas automaticas: solo pujar si la ronda sigue como la leyo. */
export type ExpectedRoundState = { price: Prisma.Decimal; leaderId: string | null };

/** Lo minimo que una puja debe superar al precio vigente cuando la ronda ya tiene lider. */
export const BID_INCREMENT = 100;

/**
 * Anti-sniping (HU-23, F4.3): una puja aceptada cuando faltan menos de estos segundos lleva
 * el cierre a "ahora + estos segundos", sin pasar de `maximumEndsAt`. Con mas margen, el
 * cierre no cambia.
 */
export const ANTI_SNIPING_WINDOW_SECONDS = 60;

/** Una sola reserva por estudiante y ronda en wallet: cada puja nueva la reemplaza. */
export const holdReference = (roundId: string, bidderId: string) => `bid:${roundId}:${bidderId}`;

/**
 * Cuantas secciones con candado por estudiante puede abrir a la vez esta instancia. Cada una
 * retiene una conexion (la de su transaccion) y pide otra para sus sentencias; con el limite
 * por debajo de la mitad del pool, nunca se quedan todas esperando una conexion libre.
 */
const MAX_LOCKED_SECTIONS = 4;

/**
 * La primera puja de la ronda debe alcanzar el precio minimo; las siguientes deben superar
 * el vigente en al menos BID_INCREMENT. Por encima de eso el estudiante elige el monto.
 */
export function minimumBid(round: { startingPrice: Prisma.Decimal; currentPrice: Prisma.Decimal; currentBidderId: string | null }) {
  return round.currentBidderId ? round.currentPrice.plus(BID_INCREMENT) : round.startingPrice;
}

@Injectable()
export class BidsService {
  private readonly logger = new Logger(BidsService.name);

  private lockedSections = 0;
  private readonly waitingSections: Array<() => void> = [];

  constructor(private readonly prisma: PrismaService, private readonly wallet: WalletHoldClient) {}

  /**
   * Serializa todo lo que toca la reserva de un estudiante en una ronda.
   *
   * Wallet guarda una sola reserva por (ronda, estudiante) y cada puja fija su monto. Dos
   * operaciones del mismo estudiante a la vez (doble clic, su puja manual y su puja
   * automatica, o la liberacion por haber sido superado) podian pisarse: el lider quedaba con
   * menos reservado que su puja (y se le cobraba de menos) o un perdedor con fondos atrapados.
   *
   * El candado es de PostgreSQL (`pg_advisory_xact_lock`), asi que vale entre instancias, y se
   * suelta solo al terminar la transaccion. Nunca se anidan: quien libera al superado lo hace
   * despues de soltar el suyo, de modo que dos estudiantes no pueden esperarse en circulo.
   */
  async withBidderLock<T>(roundId: string, bidderId: string, work: () => Promise<T>): Promise<T> {
    if (this.lockedSections >= MAX_LOCKED_SECTIONS) await new Promise<void>((resolve) => this.waitingSections.push(resolve));
    this.lockedSections += 1;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(CAST(${roundId} AS text)), hashtext(CAST(${bidderId} AS text)))::text AS locked`;
          return work();
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } finally {
      this.lockedSections -= 1;
      this.waitingSections.shift()?.();
    }
  }

  async place(roundId: string, bidderId: string, amount: number) {
    // ECICoin vale lo mismo que el peso colombiano: no hay fracciones.
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('La puja debe ser un numero entero positivo.');
    const bidAmount = new Prisma.Decimal(amount);
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: {
        status: true, startingPrice: true, currentPrice: true, currentBidderId: true,
        room: { select: { participants: { where: { userId: bidderId }, select: { id: true }, take: 1 } } },
      },
    });
    if (!round) throw new NotFoundException('La ronda no existe.');
    // HU-17: solo puja quien se registro antes del inicio. Se comprueba antes de reservar.
    if (round.room.participants.length === 0) throw new ForbiddenException('Debes estar admitido en la sala para pujar.');
    if (round.status !== RoundStatus.ACTIVE) throw new ConflictException('La ronda no esta activa.');
    if (bidAmount.lt(minimumBid(round))) throw new ConflictException(`La puja debe ser de al menos ${minimumBid(round).toString()} ECICoin.`);
    const placed = await this.withBidderLock(roundId, bidderId, async () => {
      const accepted = await this.wallet.hold(bidderId, holdReference(roundId, bidderId), amount);
      if (!accepted) throw new ConflictException('No tienes ECICoin disponibles suficientes para esta puja.');

      const result = await this.compareAndPlace(roundId, bidderId, bidAmount);
      if (!result) {
        await this.restoreHold(roundId, bidderId, amount);
        throw new ConflictException('La ronda no esta activa.');
      }
      if (result.status === BidStatus.REJECTED) {
        // El intento se conserva en el historial, pero la reserva previa se revierte.
        await this.restoreHold(roundId, bidderId, amount);
        throw new ConflictException('Otra puja llego primero: la tuya ya no alcanza el minimo. Se libero tu reserva.');
      }
      return result;
    });
    this.logAccepted(placed, false);
    await this.releaseOutbid(placed);
    // La secuencia es BigInt y JSON no sabe serializarla: viaja como texto, como en el evento del outbox.
    return {
      id: placed.id, roundId: placed.roundId, bidderId: placed.bidderId, amount: placed.amount, sequence: placed.sequence.toString(),
      endsAt: placed.endsAt, extended: placed.extended,
    };
  }

  /**
   * Puja en nombre del motor automatico (HU-22). Igual que la manual, pero solo entra si la
   * ronda sigue con el precio y el lider con que el motor hizo su calculo; si otra puja se
   * adelanto no se escribe nada y el motor recalcula sobre el estado nuevo. Se llama dentro
   * de `withBidderLock` del estudiante por quien puja.
   */
  placeAutomatic(roundId: string, bidderId: string, amount: Prisma.Decimal, expected: ExpectedRoundState) {
    return this.compareAndPlace(roundId, bidderId, amount, expected);
  }

  /** Libera la reserva de quien acaba de dejar de liderar. Va versionada por su monto. */
  async releaseOutbid(placed: PlacedBid) {
    const { previousBidderId, previousPrice, roundId } = placed;
    if (!previousBidderId || previousBidderId === placed.bidderId || !previousPrice) return;
    const released = await this.withBidderLock(roundId, previousBidderId, () =>
      this.wallet.release(previousBidderId, holdReference(roundId, previousBidderId), Number(previousPrice)),
    );
    if (!released) throw new ConflictException('No fue posible liberar la puja anterior.');
  }

  /**
   * Deshace la reserva hecha para una puja que no entro. No basta con liberarla: si quien
   * pujaba sigue liderando (mejoraba su propia puja), su reserva debe volver al monto con el
   * que lidera; liberarla lo dejaria ganando sin fondos comprometidos. Si ya no lidera, se
   * libera el intento, y wallet ignora la orden si la reserva ya cambio de monto. Se llama
   * dentro de `withBidderLock` del mismo estudiante.
   */
  async restoreHold(roundId: string, bidderId: string, attemptedAmount: number) {
    const reference = holdReference(roundId, bidderId);
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, select: { currentBidderId: true, currentPrice: true } });
    if (round?.currentBidderId === bidderId) {
      if (!round.currentPrice.eq(attemptedAmount)) await this.wallet.hold(bidderId, reference, Number(round.currentPrice));
      return;
    }
    await this.wallet.release(bidderId, reference, attemptedAmount);
  }

  logAccepted(placed: PlacedBid, automatic: boolean) {
    this.logger.log(
      `round=${placed.roundId} bid=${placed.id} seq=${placed.sequence} bidder=${placed.bidderId} amount=${placed.amount.toString()} ` +
        `automatic=${automatic} endsAt=${placed.endsAt.toISOString()}${placed.extended ? ' extended=anti-sniping' : ''}`,
    );
  }

  /**
   * Bloquea únicamente la fila de la ronda, asigna una secuencia total e inserta
   * el intento (aceptado o rechazado) en una sola sentencia local. La fila de la
   * ronda, no el proceso Nest ni el WebSocket, serializa el precio y el cierre: funciona
   * igual con varias instancias del servicio.
   */
  private async compareAndPlace(
    roundId: string, bidderId: string, amount: Prisma.Decimal, expected?: ExpectedRoundState,
  ): Promise<PlacedBid | null> {
    const automatic = expected !== undefined;
    // La hora de llegada la pone PostgreSQL (UTC, igual que las columnas), nunca el cliente.
    const now = Prisma.sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;
    const window = Prisma.sql`(CAST(${ANTI_SNIPING_WINDOW_SECONDS} AS integer) * INTERVAL '1 second')`;
    const guard = expected
      ? Prisma.sql`AND "currentPrice" = ${expected.price} AND "currentBidderId" IS NOT DISTINCT FROM CAST(${expected.leaderId} AS text)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<Omit<PlacedBid, 'endsAt'> & { endsAt: string }>>(Prisma.sql`
      WITH candidate AS (
        -- Misma regla que minimumBid(), evaluada sobre la fila bloqueada: el precio y el
        -- lider que decide son los vigentes al serializar, no los leidos antes.
        SELECT id, "roomId", position, "currentBidderId", "currentPrice", "endsAt",
          CASE WHEN "currentBidderId" IS NULL THEN ${amount} >= "startingPrice"
               ELSE ${amount} >= "currentPrice" + ${BID_INCREMENT} END AS accepts
        FROM "rounds"
        WHERE id = ${roundId}
          AND status = CAST(${RoundStatus.ACTIVE} AS "RoundStatus")
          AND "endsAt" > ${now}
          ${guard}
        FOR UPDATE
      ), sequenced AS (
        UPDATE "rounds" AS round
        SET
          "nextBidSequence" = round."nextBidSequence" + 1,
          "currentPrice" = CASE WHEN candidate.accepts THEN ${amount} ELSE round."currentPrice" END,
          "currentBidderId" = CASE WHEN candidate.accepts THEN ${bidderId} ELSE round."currentBidderId" END,
          -- Anti-sniping: un unico cierre calculado sobre la fila bloqueada. Dos pujas en el
          -- ultimo minuto no suman extensiones: cada una lleva el cierre a "ahora + ventana",
          -- nunca lo acorta y nunca pasa de maximumEndsAt.
          "endsAt" = CASE
            WHEN candidate.accepts AND round."endsAt" < ${now} + ${window}
              THEN GREATEST(round."endsAt", LEAST(${now} + ${window}, round."maximumEndsAt"))
            ELSE round."endsAt" END
        FROM candidate
        WHERE round.id = candidate.id
        RETURNING candidate.accepts AS accepts, candidate."endsAt" AS "previousEndsAt", candidate."currentBidderId" AS "previousBidderId", candidate."currentPrice" AS "previousPrice", candidate."roomId" AS "roomId", candidate.position AS position, round."currentPrice" AS "currentPrice", round."currentBidderId" AS "currentBidderId", round."endsAt" AS "endsAt", round."nextBidSequence" AS sequence
      ), placed_bid AS (
        INSERT INTO "bids" (id, "roundId", "bidderId", amount, sequence, status, automatic, "createdAt", "updatedAt")
        SELECT ${randomUUID()}, ${roundId}, ${bidderId}, ${amount}, sequenced.sequence,
          CASE WHEN sequenced.accepts THEN CAST('ACCEPTED' AS "BidStatus") ELSE CAST('REJECTED' AS "BidStatus") END,
          CAST(${automatic} AS boolean), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM sequenced
        RETURNING id, "roundId", "bidderId", amount, sequence, status
      ),
      outbox_event AS (
        INSERT INTO "outbox_events" ("id", "eventType", "routingKey", "aggregateId", "aggregateSequence", "payload")
        SELECT
          placed_bid.id,
          'auction.bid.accepted.v1',
          'auction.bid.accepted.v1',
          placed_bid."roundId",
          placed_bid.sequence,
          jsonb_build_object(
            'eventId', placed_bid.id,
            'eventType', 'auction.bid.accepted.v1',
            'occurredAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'roomId', sequenced."roomId",
            'roundId', placed_bid."roundId",
            'position', sequenced.position,
            'bidId', placed_bid.id,
            'bidderId', placed_bid."bidderId",
            'amount', placed_bid.amount::text,
            'previousBidderId', sequenced."previousBidderId",
            'previousPrice', sequenced."previousPrice"::text,
            'currentBidderId', sequenced."currentBidderId",
            'currentPrice', sequenced."currentPrice"::text,
            'endsAt', to_char(sequenced."endsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'previousEndsAt', to_char(sequenced."previousEndsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'extended', sequenced."endsAt" > sequenced."previousEndsAt",
            'automatic', CAST(${automatic} AS boolean),
            'sequence', placed_bid.sequence::text
          )
        FROM placed_bid CROSS JOIN sequenced
        WHERE placed_bid.status = CAST('ACCEPTED' AS "BidStatus")
        RETURNING id
      )
      SELECT placed_bid.*, sequenced."previousBidderId", sequenced."previousPrice",
        -- Las columnas son UTC sin zona: se devuelven como texto ISO para no depender del driver.
        to_char(sequenced."endsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endsAt",
        sequenced."endsAt" > sequenced."previousEndsAt" AS extended
      FROM placed_bid CROSS JOIN sequenced
    `);
    const row = rows[0];
    return row ? { ...row, endsAt: new Date(row.endsAt) } : null;
  }
}
