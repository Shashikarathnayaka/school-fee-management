-- AlterEnum
ALTER TYPE "RouteStatus" ADD VALUE 'ARCHIVED';

-- CreateEnum
CREATE TYPE "RouteDirection" AS ENUM ('HOME_TO_SCHOOL', 'SCHOOL_TO_HOME');

-- AlterTable
ALTER TABLE "routes" ADD COLUMN "direction" "RouteDirection" NOT NULL DEFAULT 'HOME_TO_SCHOOL';
