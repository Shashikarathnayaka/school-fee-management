const { PrismaClient } = require('@prisma/client');
const { slMonthYear } = require('./slDate');
const prisma = new PrismaClient();

/**
 * Ensures monthly fees are generated for active route students.
 * Idempotent, safe to call repeatedly (uses skipDuplicates).
 * A student on two active routes produces exactly one fee per month (deduped).
 *
 * @param {Object} [options]
 * @param {string|string[]} [options.studentIds] - Optional student ID or array of student IDs to generate fees for.
 * @param {number} [options.month] - Target month (1-12). Defaults to current month.
 * @param {number} [options.year] - Target year (e.g. 2026). Defaults to current year.
 * @returns {Promise<{ created: number, count: number }>}
 */
async function ensureMonthlyFees({ studentIds, month, year } = {}) {
  const currentSl = slMonthYear();
  const targetMonth = month !== undefined ? Number(month) : currentSl.month;
  const targetYear = year !== undefined ? Number(year) : currentSl.year;

  // Due date is the 5th of the NEXT month (UTC midnight)
  const dueDate = new Date(Date.UTC(targetYear, targetMonth, 5, 0, 0, 0));

  const where = {
    route: {
      status: {
        notIn: ['COMPLETED', 'ARCHIVED']
      }
    }
  };

  if (studentIds) {
    if (Array.isArray(studentIds)) {
      const uniqueIds = Array.from(new Set(studentIds));
      if (uniqueIds.length === 0) {
        return { created: 0, count: 0 };
      }
      where.student_id = { in: uniqueIds };
    } else {
      where.student_id = studentIds;
    }
  }

  // Fetch RouteStudents whose route is not COMPLETED and not ARCHIVED
  const routeStudents = await prisma.routeStudent.findMany({
    where,
    select: {
      student_id: true,
      monthly_fee: true
    }
  });

  if (routeStudents.length === 0) {
    return { created: 0, count: 0 };
  }

  // Deduplicate by student_id to prevent duplicates in the same createMany batch
  const studentFeeMap = new Map();
  for (const rs of routeStudents) {
    if (!studentFeeMap.has(rs.student_id)) {
      studentFeeMap.set(rs.student_id, rs.monthly_fee);
    }
  }

  const feeData = Array.from(studentFeeMap.keys()).map((student_id) => ({
    student_id,
    amount: 0,
    trips_count: 0,
    due_date: dueDate,
    month: targetMonth,
    year: targetYear,
    status: 'DUE'
  }));

  const result = await prisma.fee.createMany({
    data: feeData,
    skipDuplicates: true
  });

  return { created: result.count, count: result.count };
}

module.exports = { ensureMonthlyFees };
