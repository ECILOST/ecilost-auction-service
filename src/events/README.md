# Integration events

Eventos versionados en `ecilost.events`. Los comandos y eventos se particionarán por `roomId`, con idempotency key, versión esperada y outbox. Wallet y Catalog se integran por mensajes, sin transacción distribuida ni acceso a sus bases de datos.
