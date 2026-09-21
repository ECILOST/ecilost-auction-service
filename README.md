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
