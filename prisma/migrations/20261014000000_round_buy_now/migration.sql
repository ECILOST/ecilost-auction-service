-- Compra inmediata (HU-24). Solo agrega columnas opcionales: la version anterior del servicio
-- las ignora y ninguna fila existente cambia de significado.
CREATE TYPE "RoundCloseReason" AS ENUM ('EXPIRED', 'BUY_NOW');

ALTER TABLE "rounds"
  ADD COLUMN "buyNowPrice" DECIMAL(18,2),
  ADD COLUMN "closeReason" "RoundCloseReason";

-- Hasta hoy toda ronda cerrada vencio por su reloj.
UPDATE "rounds"
SET "closeReason" = 'EXPIRED'::"RoundCloseReason"
WHERE "status" = 'CLOSED';
