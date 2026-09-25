-- Las salas existentes reciben un nombre provisional; las nuevas lo exigen.
ALTER TABLE "rooms" ADD COLUMN "name" TEXT NOT NULL DEFAULT 'Sala sin nombre';
ALTER TABLE "rooms" ALTER COLUMN "name" DROP DEFAULT;

-- Precio minimo por ronda. Las rondas existentes conservan 0: su precio vigente ya manda.
ALTER TABLE "rounds" ADD COLUMN "startingPrice" DECIMAL(18,2) NOT NULL DEFAULT 0;
