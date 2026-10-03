-- AlterEnum
ALTER TYPE "PStatus" ADD VALUE 'DROPPED';

-- CreateEnum
CREATE TYPE "ChargeKind" AS ENUM ('PICKUP', 'DROP');

-- AlterTable
ALTER TABLE "fees" ADD COLUMN "trips_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "trip_charges" (
    "id" TEXT NOT NULL,
    "pickup_id" TEXT NOT NULL,
    "kind" "ChargeKind" NOT NULL,
    "fee_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trip_charges_pickup_id_kind_key" ON "trip_charges"("pickup_id", "kind");

-- AddForeignKey
ALTER TABLE "trip_charges" ADD CONSTRAINT "trip_charges_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "pickup_status"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_charges" ADD CONSTRAINT "trip_charges_fee_id_fkey" FOREIGN KEY ("fee_id") REFERENCES "fees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migration data update
UPDATE fees SET amount = 0, due_date = '2026-11-05' WHERE status = 'DUE' AND month = 10 AND year = 2026 AND trips_count = 0;
