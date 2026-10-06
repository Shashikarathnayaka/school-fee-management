ALTER TABLE "pickup_status" ADD COLUMN "period" TEXT NOT NULL DEFAULT 'MORNING';

UPDATE "pickup_status" ps
SET "period" = 'EVENING'
FROM "routes" r
WHERE r."id" = ps."route_id" AND r."direction" = 'SCHOOL_TO_HOME';

DROP INDEX "pickup_status_route_id_student_id_date_key";

CREATE UNIQUE INDEX "pickup_status_route_id_student_id_date_period_key" ON "pickup_status"("route_id", "student_id", "date", "period");
