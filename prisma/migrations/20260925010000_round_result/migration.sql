-- Resultado de la ronda al cerrar (HU-28). Las rondas ya cerradas se completan con su lider.
CREATE TYPE "RoundResult" AS ENUM ('AWARDED', 'DESERTED');

ALTER TABLE "rounds"
  ADD COLUMN "result" "RoundResult",
  ADD COLUMN "winnerId" TEXT,
  ADD COLUMN "closedAt" TIMESTAMP(3);

UPDATE "rounds"
SET "result" = CASE WHEN "currentBidderId" IS NULL THEN 'DESERTED'::"RoundResult" ELSE 'AWARDED'::"RoundResult" END,
    "winnerId" = "currentBidderId",
    "closedAt" = "endsAt"
WHERE "status" = 'CLOSED';
