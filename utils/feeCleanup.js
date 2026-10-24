const { PrismaClient } = require('@prisma/client');
const { slMonthYear } = require('./slDate');

const prisma = new PrismaClient();

/** Total months of history to keep (current month + 11 previous). */
const HISTORY_MONTHS = 12;

/**
 * Returns the oldest { month, year } that is still within the rolling window.
 * Fees for this month/year and later are kept; anything before is eligible for deletion.
 *
 * @param {Date} [now=new Date()]
 * @returns {{ month: number, year: number }}
 */
function getFeeCutoff(now = new Date()) {
  const { month, year } = slMonthYear(now);
  const index = year * 12 + (month - 1) - (HISTORY_MONTHS - 1);
  return {
    year: Math.floor(index / 12),
    month: (index % 12) + 1
  };
}

/**
 * Returns a Prisma `where` fragment that keeps only fees within the 12-month window.
 * Spread this into any fee query's `where` clause to enforce the display filter.
 *
 * @param {Date} [now=new Date()]
 * @returns {object} Prisma where fragment
 */
function feeWindowWhere(now = new Date()) {
  const cutoff = getFeeCutoff(now);
  return {
    OR: [
      { year: { gt: cutoff.year } },
      { year: cutoff.year, month: { gte: cutoff.month } }
    ]
  };
}

/**
 * Hard-deletes all Fee rows older than the 12-month rolling window.
 * Because TripCharge has `onDelete: Cascade` on its Fee relation, trip charges
 * for the deleted fees are automatically removed.
 *
 * @param {Date} [now=new Date()]
 * @returns {Promise<{ deleted: number }>}
 */
async function deleteOldFees(now = new Date()) {
  const cutoff = getFeeCutoff(now);
  const result = await prisma.fee.deleteMany({
    where: {
      OR: [
        { year: { lt: cutoff.year } },
        { year: cutoff.year, month: { lt: cutoff.month } }
      ]
    }
  });
  return { deleted: result.count };
}

module.exports = { HISTORY_MONTHS, getFeeCutoff, feeWindowWhere, deleteOldFees };
