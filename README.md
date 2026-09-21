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
