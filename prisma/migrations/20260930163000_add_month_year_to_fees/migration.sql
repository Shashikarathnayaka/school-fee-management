-- AlterTable: add month and year columns
ALTER TABLE "fees" ADD COLUMN "month" INTEGER;
ALTER TABLE "fees" ADD COLUMN "year" INTEGER;

-- Backfill month and year from existing due_date
UPDATE "fees"
SET "month" = EXTRACT(MONTH FROM "due_date")::INTEGER,
    "year" = EXTRACT(YEAR FROM "due_date")::INTEGER
WHERE "month" IS NULL OR "year" IS NULL;

-- Delete/merge duplicate rows BEFORE adding the unique constraint (keep the PAID one if duplicates exist)
WITH ranked_fees AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY student_id, month, year
           ORDER BY 
             CASE WHEN status = 'PAID' THEN 0 ELSE 1 END,
             paid_date DESC NULLS LAST,
             id ASC
         ) as rn
  FROM "fees"
)
DELETE FROM "fees"
WHERE id IN (
  SELECT id FROM ranked_fees WHERE rn > 1
);

-- AlterTable: make month and year NOT NULL
ALTER TABLE "fees" ALTER COLUMN "month" SET NOT NULL;
ALTER TABLE "fees" ALTER COLUMN "year" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "fees_student_id_month_year_key" ON "fees"("student_id", "month", "year");
