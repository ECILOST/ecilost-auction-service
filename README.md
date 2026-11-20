# ECILOST Auction Core

Servicio que programa salas, admite participantes y decide el resultado de rondas, pujas y compras inmediatas. PostgreSQL conserva el estado de las subastas. Auction consulta Auth mediante JWKS y se integra con Catalog, Wallet y Engagement a través de RabbitMQ.

```text
src/
  config/ common/ rooms/domain/ rounds/domain/
  application/ infrastructure/ presentation/http/ events/
prisma/ test/
```

## Inicio local

Requiere Node.js 22, PostgreSQL y RabbitMQ. Levanta Auth para obtener el JWT y su JWKS, Catalog para reservar objetos o lotes, y Wallet para reservar y liquidar Ecicoin. Engagement entrega los eventos en vivo al cliente.

```bash
cp .env.example .env
docker compose up -d
npm ci
npx prisma generate
npm run db:deploy
npm run start:dev
```

Completa `DATABASE_URL`, `RABBITMQ_URL`, `AUTH_JWKS_URL`, `JWT_ISSUER` y `JWT_AUDIENCE` antes del arranque. El puerto HTTP local es `3003`.

## OpenAPI

Abre el [contrato OpenAPI](docs/openapi.json) en Swagger Editor para consultar rutas y esquemas. En las solicitudes HTTP, envía un JWT vigente emitido por Auth. Un `401` indica que la credencial faltó o falló la validación. Un `403` indica rol, propiedad o admisión insuficientes para la operación.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" http://localhost:3003/rooms
```

| Flujo | Ruta principal | Rol |
|---|---|---|
| Programar sala | `POST /rooms` | `STAFF` |
| Descubrir salas | `GET /rooms?include=rounds&status=SCHEDULED,ACTIVE` | `STAFF` o `STUDENT` |
| Inscribirse antes del inicio | `POST /rooms/{roomId}/participants` | `STUDENT` |
| Consultar la ronda activa | `GET /rooms/{roomId}/state` | Participante admitido o funcionario dueño |
| Pujar y comprar | `POST /rounds/{roundId}/bids` y `POST /rounds/{roundId}/buy-now` | `STUDENT` |

## Concurrencia (decisión de diseño)

Auction coordina la reserva de inventario y fondos por RabbitMQ. PostgreSQL serializa las operaciones sobre una ronda y conserva un historial ordenado. Los eventos de subasta se publican mediante outbox. Wallet liquida el cierre y Engagement actualiza sus proyecciones.

## HU — Programar sala

`POST /rooms` requiere un JWT de `STAFF` y recibe `maximumCapacity`, `startsAt` y una lista ordenada de rondas. Cada ronda debe incluir por lo menos un `ITEM` o `LOT`. La sala nace `SCHEDULED` y la restricción única `(kind, catalogId)` rechaza concurrentemente una referencia ya reservada, con HTTP 409.

Catalog confirma la disponibilidad mediante el contrato de reserva por RabbitMQ. Un objeto o lote no disponible produce `409`.

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

## Cobertura y SonarQube

Ejecuta `npm ci` y luego `npm run test:cov` para generar `coverage/index.html` y
`coverage/lcov.info`. La cobertura corresponde a la suite que ejecuta `npm test`.
Vitest exige al menos un 80 % de cobertura global de líneas por repositorio.

El proyecto de SonarQube Cloud es `ECILOST_ecilost-auction-service` en la organización `ecilost`.
Para importar LCOV, desactiva **Automatic Analysis** en **Administration > Analysis Method**.
Configura `SONAR_TOKEN` como secreto de GitHub Actions con permiso de análisis.
En cada push a la rama predeterminada, CI invoca `sonarcloud.yml` con el LCOV
generado por `npm run test:cov` y espera el resultado del Quality Gate.
