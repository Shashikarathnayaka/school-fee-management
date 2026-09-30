const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Ensures monthly fees are generated for active route students.
 * Idempotent, safe to call repeatedly (uses skipDuplicates).
 *
 * @param {Object} [options]
 * @param {string|string[]} [options.studentIds] - Optional student ID or array of student IDs to generate fees for.
 * @param {number} [options.month] - Target month (1-12). Defaults to current month.
 * @param {number} [options.year] - Target year (e.g. 2026). Defaults to current year.
 * @returns {Promise<{ created: number, count: number }>}
 */
async function ensureMonthlyFees({ studentIds, month, year } = {}) {
  const now = new Date();
  const targetMonth = month !== undefined ? Number(month) : (now.getMonth() + 1);
  const targetYear = year !== undefined ? Number(year) : now.getFullYear();

  // Due date is the 5th of that month (UTC midnight)
  const dueDate = new Date(Date.UTC(targetYear, targetMonth - 1, 5, 0, 0, 0));

  const where = {
    route: {
      status: {
        not: 'COMPLETED'
      }
    }
  };

  if (studentIds) {
    if (Array.isArray(studentIds)) {
      if (studentIds.length === 0) {
        return { created: 0, count: 0 };
      }
      where.student_id = { in: studentIds };
    } else {
      where.student_id = studentIds;
    }
  }

  // Fetch RouteStudents whose route is not COMPLETED
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

  const feeData = Array.from(studentFeeMap.entries()).map(([student_id, monthly_fee]) => ({
    student_id,
    amount: monthly_fee,
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
