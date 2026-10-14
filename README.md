# ECILOST Auction Core

Esqueleto del contexto de subastas: concentra salas, rondas, pujas y auto-bid.

```text
src/
  config/ common/ rooms/domain/ rounds/domain/
  application/ infrastructure/ presentation/http/ events/
prisma/ test/
```

Catalog, Wallet y Auth se consumirán mediante contratos; no mediante sus bases de datos.

## Concurrencia (decisión de diseño)

Auction no debe abrir transacciones distribuidas ni sostener transacciones de base de datos mientras espera a otro servicio. Cada comando de puja se procesará con la clave de partición `roomId`: una sala se ordena de forma determinista, mientras salas distintas pueden avanzar en paralelo. Las persistencias de cada agregado usan versión esperada (control optimista), idempotency key por comando y eventos versionados mediante outbox.

La reserva o liberación de fondos y los cambios de Catalog se solicitan/confirmarán mediante eventos RabbitMQ. Un fallo se resuelve con estados explícitos y compensación, nunca con una transacción entre servicios. Esta es una decisión de scaffolding; los nombres y contratos concretos de eventos se definen antes de crear consumidores.

## HU — Programar sala

`POST /rooms` requiere un JWT de `STAFF` y recibe `maximumCapacity`, `startsAt` y una lista ordenada de rondas. Cada ronda debe incluir por lo menos un `ITEM` o `LOT`. La sala nace `SCHEDULED` y la restricción única `(kind, catalogId)` rechaza concurrentemente una referencia ya reservada, con HTTP 409.

La próxima integración obligatoria es el contrato RabbitMQ con Catalog que confirma que dichas referencias existen y siguen disponibles. Auction no accede a la base de datos de Catalog; mientras ese consumidor no esté desplegado, la historia cubre la exclusividad local pero no certifica disponibilidad remota.

## HU-18, HU-19, HU-22 y HU-23 — Ciclo de vida, pujas automáticas y anti-sniping

- El reloj de PostgreSQL es el único dueño del tiempo: `RoomActivationScheduler` abre salas, encadena rondas y cierra la sala tras la última (`SCHEDULED → ACTIVE → CLOSED`). El cliente solo pinta el contador con `serverTime`.
- Una puja aceptada con menos de 60 s restantes lleva el cierre a "ahora + 60 s", sin pasar de `maximumEndsAt`.
- `PUT /rounds/:roundId/auto-bid` (`{ enabled, maximumAmount }`) declara, cambia o desactiva la puja automática; `GET /rounds/:roundId/auto-bid` la consulta y `GET /rooms/:roomId/state` la incluye en `autoBid`.
- Detalle de las decisiones en `docs/adr/0001-reloj-del-servidor-y-serializacion-de-pujas.md` y de los eventos en `src/events/README.md`.

## HU-24 — Compra inmediata con ECICoin

- `POST /rooms` acepta en cada ronda un `buyNowPrice` opcional (entero, mayor que `startingPrice`). Sin él, la ronda no ofrece compra inmediata. `GET /rooms/:roomId` y `GET /rooms/:roomId/state` lo publican.
- `POST /rounds/:roundId/buy-now` (JWT de `STUDENT`, sin cuerpo) compra el objeto de la ronda activa por su `buyNowPrice` mientras las pujas no lo hayan alcanzado. Reserva el precio en Wallet, cierra la ronda a favor del comprador y abre la siguiente. Responde `201 { roundId, roomId, buyerId, price, closedAt, replayed }`. Repetirla tras una compra hecha responde la misma con `replayed: true`, sin volver a reservar.
- Errores: `403` no admitido en la sala; `404` ronda inexistente; `409` ronda no activa, sin compra inmediata, precio ya alcanzado, saldo insuficiente o compra perdida frente a otra operación; `503` Wallet no respondió (la reserva se deshace).
- Decisiones, garantías y recuperación en `docs/adr/0002-compra-inmediata.md`.

## HU-25 — Un único adquirente y cierre anticipado notificado

- Solo una compra puede cerrar la ronda: la fila de la ronda decide. A las demás se les responde `409` y se les devuelve la reserva en el acto.
- El cierre por compra publica `auction.round.closed.v1` con `closeReason: BUY_NOW`. Wallet cobra al comprador y libera las reservas de los demás, y Engagement avisa a la sala. `GET /rooms/:roomId` publica `closeReason` por ronda para que el cliente diga "Vendido por compra inmediata".
- Una puja o una puja automática sobre una ronda ya cerrada responde `409`. El cliente las envía a la ronda que el estudiante estaba viendo, nunca a "la activa".
- Cobertura por criterio en `docs/adr/0002-compra-inmediata.md`, sección "HU-25".

## Pruebas

```bash
npm test                  # unitarias
npm run test:integration  # contra PostgreSQL real, esquema auction_it (docker compose up -d)
```
