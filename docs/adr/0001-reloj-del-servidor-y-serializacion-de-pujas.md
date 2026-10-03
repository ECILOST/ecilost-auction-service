# ADR-0001: Reloj del servidor y serialización de pujas en PostgreSQL

## Estado

Accepted para HU-18, HU-19, HU-22 y HU-23.

## Contexto

La sala pasa sola por sus estados, las rondas se encadenan, una puja en el último minuto
extiende el cierre y el motor de puja automática compite por el estudiante. Todo ocurre con
varias pujas llegando a la vez, y el servicio puede correr con varias réplicas (Azure
Container Apps). Un candado en memoria no coordina réplicas, y el reloj del navegador no es
confiable.

## Decisiones

1. **Un solo reloj autoritativo: el de PostgreSQL.** La puja decide si llegó a tiempo con
   `CURRENT_TIMESTAMP` y el ciclo de vida cierra con `clock_timestamp()`. Las columnas son
   `TIMESTAMP(3)` en UTC y las comparaciones usan `AT TIME ZONE 'UTC'`. El cliente solo
   pinta el contador corrigiendo su reloj con `serverTime`; nunca decide que algo terminó.
2. **Estados existentes, sin estados nuevos.** Sala `SCHEDULED → ACTIVE → CLOSED`
   (`CLOSED` es el `FINISHED` del backlog; `CANCELLED` queda aparte). Ronda
   `SCHEDULED → ACTIVE → CLOSED`. La extensión anti-sniping no es un estado: viaja como dato
   (`endsAt`, `extended`, `previousEndsAt`).
3. **Motor del ciclo de vida.** `RoomActivationScheduler` ejecuta cada 500 ms
   `activateDueRooms`, que abre salas vencidas y su primera ronda, cierra rondas vencidas,
   abre la siguiente en el mismo instante y cierra la sala tras la última. Cada cambio va en
   un `WHERE` condicional, así que varias réplicas producen una sola transición y un solo
   evento.
4. **El ganador se lee después de bloquear la ronda.** El cierre hace `SELECT … FOR UPDATE`
   con `endsAt <= now` y solo entonces lee al líder. Antes se leía primero, y una puja
   confirmada entre la lectura y el cierre podía adjudicar la ronda a quien ya había sido
   superado.
5. **La fila de la ronda serializa precio, líder, secuencia y cierre.** Una sola sentencia
   (`compareAndPlace`) bloquea la ronda, valida el mínimo, asigna `sequence`, calcula el
   nuevo `endsAt`, inserta la puja y su evento de outbox.
6. **Anti-sniping idempotente.** Si quedan menos de 60 s, `endsAt = GREATEST(endsAt,
   LEAST(now + 60 s, maximumEndsAt))`. Pujas simultáneas dejan un único cierre: cada una lo
   lleva a "ahora + 60 s", nunca acumulan ni lo acortan, y nunca pasan del tope de la ronda.
7. **Puja automática como subasta proxy.** Gana el límite más alto; con límites iguales,
   quien lo declaró primero según `priority`, asignada por PostgreSQL bajo el bloqueo de la
   ronda (`nextAutoBidPriority`). Paga `min(límiteGanador, segundoLímite + 100)`. El
   resultado depende solo del estado y de los límites, no del orden de los mensajes. Cada
   puja del motor entra con una comparación contra el precio y el líder que usó para
   calcularla; si otra se adelantó, recalcula.
8. **Fondos: se reserva lo que se puja, no el límite.** Wallet debita al ganador el monto
   reservado, así que reservar el límite le cobraría de más. Al declarar se consulta el
   saldo (`wallet.balance.requested.v1`) solo como orientación; la garantía es la reserva de
   cada disparo. Si no alcanza, la puja automática se detiene con `INSUFFICIENT_FUNDS` y no
   se compromete nada.
9. **Candado por estudiante y ronda (`pg_advisory_xact_lock`).** Wallet guarda una reserva
   por `bid:{roundId}:{userId}` y cada puja fija su monto. Reservar, pujar y compensar de un
   mismo estudiante ocurre bajo su candado; liberar al superado toma el candado de este
   después de soltar el propio, así que no hay esperas circulares. Un semáforo limita las
   secciones abiertas por réplica para no agotar el pool de conexiones.
10. **El SQL crudo usa el esquema configurado.** `PrismaService` fija `search_path` al
    esquema de `DATABASE_URL`; sin eso, `$queryRaw` resolvía las tablas con el esquema del
    usuario de la base.

## Consecuencias

- Las garantías no dependen del número de réplicas ni de la hora de cada máquina.
- Una puja que espera el bloqueo usa su hora de llegada (`CURRENT_TIMESTAMP` del inicio de
  la sentencia), no la de su turno.
- La resolución automática corre tras cada puja manual y en un barrido cada 500 ms, que
  retoma lo que una réplica haya dejado a medias.
- Riesgo residual: si una compensación de wallet no recibe respuesta (timeout de 5 s), la
  reserva puede quedar desajustada hasta la liquidación de la ronda, que libera toda reserva
  que no sea la del ganador.

## Evidencia

- `src/rooms/rooms.service.ts`: `activateDueRooms`, `databaseNow`.
- `src/bids/bids.service.ts`: `compareAndPlace`, `withBidderLock`, `restoreHold`.
- `src/bids/auto-bid.engine.ts` y `src/bids/auto-bids.service.ts`.
- `test/*.int-spec.ts`: concurrencia, anti-sniping, ciclo de vida y motor automático contra
  PostgreSQL real (`npm run test:integration`).
