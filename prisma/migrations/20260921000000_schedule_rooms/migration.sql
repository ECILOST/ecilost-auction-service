CREATE TYPE "RoomStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'CLOSED', 'CANCELLED');
CREATE TYPE "AuctionableKind" AS ENUM ('ITEM', 'LOT');

CREATE TABLE "rooms" (
  "id" TEXT NOT NULL,
  "status" "RoomStatus" NOT NULL DEFAULT 'SCHEDULED',
  "maximumCapacity" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "scheduledBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "rooms_status_startsAt_idx" ON "rooms"("status", "startsAt");

CREATE TABLE "rounds" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "rounds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rounds_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "rounds_roomId_position_key" ON "rounds"("roomId", "position");

CREATE TABLE "round_entries" (
  "id" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "kind" "AuctionableKind" NOT NULL,
  "catalogId" TEXT NOT NULL,
  CONSTRAINT "round_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "round_entries_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "round_entries_kind_catalogId_key" ON "round_entries"("kind", "catalogId");
CREATE INDEX "round_entries_roundId_idx" ON "round_entries"("roundId");
