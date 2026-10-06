-- AlterTable
ALTER TABLE "fees" ADD COLUMN "cycle" INTEGER NOT NULL DEFAULT 1;

-- DropIndex
DROP INDEX "fees_student_id_month_year_key";

-- CreateIndex
CREATE UNIQUE INDEX "fees_student_id_month_year_cycle_key" ON "fees"("student_id", "month", "year", "cycle");
