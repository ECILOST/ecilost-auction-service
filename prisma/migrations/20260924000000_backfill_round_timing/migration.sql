-- Rondas que ya estaban activas antes de existir los campos de tiempo.
UPDATE "rounds"
SET
  "startedAt" = CURRENT_TIMESTAMP,
  "endsAt" = CURRENT_TIMESTAMP + INTERVAL '3 minutes',
  "maximumEndsAt" = CURRENT_TIMESTAMP + INTERVAL '8 minutes'
WHERE "status" = 'ACTIVE' AND "endsAt" IS NULL;
