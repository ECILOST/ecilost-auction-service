CREATE TABLE "outbox_events" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "routingKey" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "aggregateSequence" BIGINT,
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_events_publishedAt_occurredAt_idx"
ON "outbox_events"("publishedAt", "occurredAt");
