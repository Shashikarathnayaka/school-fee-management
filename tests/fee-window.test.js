const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { PrismaClient } = require('@prisma/client');
const { hashPassword } = require('../utils/auth');
const { deleteOldFees, feeWindowWhere, getFeeCutoff, HISTORY_MONTHS } = require('../utils/feeCleanup');
const { slMonthYear } = require('../utils/slDate');

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Helper: offset a { month, year } by N months (negative = backwards)
// ---------------------------------------------------------------------------
function offsetMonthYear({ month, year }, offsetMonths) {
  const index = year * 12 + (month - 1) + offsetMonths;
  return {
    year: Math.floor(index / 12),
    month: (index % 12) + 1
  };
}

describe('Rolling 12-month fee window', () => {
  let parentUser;
  let student;
  const createdFeeIds = [];

  before(async () => {
    const pwdHash = await hashPassword('password123');
    const suffix = Date.now();

    parentUser = await prisma.user.create({
      data: {
        name: `FeeWindow Parent ${suffix}`,
        email: `feewindow_${suffix}@test.com`,
        password_hash: pwdHash,
        role: 'PARENT'
      }
    });

    student = await prisma.student.create({
      data: {
        parent_id: parentUser.id,
        name: `FeeWindow Student ${suffix}`,
        student_code: `FW-${suffix}`
      }
    });

    // Create 14 consecutive monthly fee records ending at the current SL month.
    // Months 1–14 counting from the oldest, where month 14 = current SL month.
    // Months 1 and 2 fall outside the 12-month window and must be deleted.
    const current = slMonthYear();

    for (let i = 0; i < 14; i++) {
      const offset = i - 13; // -13 (oldest) … 0 (current)
      const { month, year } = offsetMonthYear(current, offset);
      // due_date can be anything; use a deterministic UTC date
      const dueDate = new Date(Date.UTC(year, month, 5));
      const fee = await prisma.fee.create({
        data: {
          student_id: student.id,
          amount: 0,
          trips_count: 0,
          due_date: dueDate,
          month,
          year,
          status: 'DUE'
        }
      });
      createdFeeIds.push(fee.id);
    }
  });

  after(async () => {
    // Best-effort cleanup – fees may have been deleted by deleteOldFees
    await prisma.fee.deleteMany({
      where: { student_id: student.id }
    });
    await prisma.student.deleteMany({ where: { id: student.id } });
    await prisma.user.deleteMany({ where: { id: parentUser.id } });
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. deleteOldFees() removes exactly the 2 oldest months
  // =========================================================================
  it('deleteOldFees() returns the count of deleted fees', async () => {
    const result = await deleteOldFees();
    // At minimum our 2 extra fees were deleted; there may be more from other
    // test runs if they left stale data, so we assert >= 2.
    assert.ok(typeof result.deleted === 'number', 'deleted must be a number');
    assert.ok(result.deleted >= 2, `Expected at least 2 deleted, got ${result.deleted}`);
  });

  it('exactly 12 fee records remain for the test student after cleanup', async () => {
    const remaining = await prisma.fee.findMany({
      where: { student_id: student.id },
      orderBy: [{ year: 'asc' }, { month: 'asc' }]
    });
    assert.strictEqual(remaining.length, 12, `Expected 12 remaining fees, got ${remaining.length}`);
  });

  it('the 2 oldest months are gone', async () => {
    const current = slMonthYear();
    const oldest = offsetMonthYear(current, -13); // i=0 → offset -13
    const secondOldest = offsetMonthYear(current, -12); // i=1 → offset -12

    const oldestFee = await prisma.fee.findFirst({
      where: { student_id: student.id, month: oldest.month, year: oldest.year }
    });
    assert.strictEqual(oldestFee, null, 'Oldest fee (13 months ago) should have been deleted');

    const secondOldestFee = await prisma.fee.findFirst({
      where: { student_id: student.id, month: secondOldest.month, year: secondOldest.year }
    });
    assert.strictEqual(secondOldestFee, null, 'Second-oldest fee (12 months ago, outside window) should have been deleted');
  });

  it('the 12 remaining fees all fall within the window boundary', async () => {
    const cutoff = getFeeCutoff();
    const cutoffIndex = cutoff.year * 12 + (cutoff.month - 1);

    const remaining = await prisma.fee.findMany({
      where: { student_id: student.id }
    });

    for (const fee of remaining) {
      const feeIndex = fee.year * 12 + (fee.month - 1);
      assert.ok(
        feeIndex >= cutoffIndex,
        `Fee ${fee.year}/${fee.month} is older than cutoff ${cutoff.year}/${cutoff.month}`
      );
    }
  });

  // =========================================================================
  // 2. feeWindowWhere() filters correctly across a year boundary
  //    (simulated by passing a synthetic "now" where current month = January)
  // =========================================================================
  describe('feeWindowWhere() across a year boundary (January)', () => {
    it('getFeeCutoff returns February of the previous year when now is January', () => {
      // Synthetic "now": January 2026 in Colombo time (use a UTC date that maps there)
      const januaryNow = new Date('2026-01-15T06:00:00Z'); // 06:00 UTC = 11:30 IST = Jan 15 in Colombo
      const cutoff = getFeeCutoff(januaryNow);

      // 12 months back from Jan 2026 = Feb 2025
      assert.strictEqual(cutoff.year, 2025, `Expected cutoff year 2025, got ${cutoff.year}`);
      assert.strictEqual(cutoff.month, 2, `Expected cutoff month 2 (Feb), got ${cutoff.month}`);
    });

    it('feeWindowWhere() includes January 2026 but excludes January 2025', async () => {
      const januaryNow = new Date('2026-01-15T06:00:00Z');
      // cutoff = Feb 2025; Jan 2025 is outside the window
      const windowWhere = feeWindowWhere(januaryNow);

      // Resolve the OR conditions against synthetic month/year values
      // year: 2026 > 2025 → included
      // year: 2025, month: 1 < 2 → excluded
      // year: 2025, month: 2 >= 2 → included (boundary)

      // Use cycle: 99 to avoid unique-constraint collisions with the 14 fixture fees
      // (the fixture already has month=1/year=2026 with the default cycle=1).
      const feeInWindow = await prisma.fee.create({
        data: {
          student_id: student.id,
          amount: 0,
          trips_count: 0,
          due_date: new Date(Date.UTC(2026, 1, 5)),
          month: 1,
          year: 2026,
          cycle: 99,
          status: 'DUE'
        }
      });

      const feeOutWindow = await prisma.fee.create({
        data: {
          student_id: student.id,
          amount: 0,
          trips_count: 0,
          due_date: new Date(Date.UTC(2025, 1, 5)),
          month: 1,
          year: 2025,
          cycle: 99,
          status: 'DUE'
        }
      });

      try {
        const inWindowResult = await prisma.fee.findFirst({
          where: { id: feeInWindow.id, ...windowWhere }
        });
        assert.notStrictEqual(inWindowResult, null, 'Jan 2026 fee should be inside the window');

        const outWindowResult = await prisma.fee.findFirst({
          where: { id: feeOutWindow.id, ...windowWhere }
        });
        assert.strictEqual(outWindowResult, null, 'Jan 2025 fee should be outside the window');
      } finally {
        await prisma.fee.deleteMany({
          where: { id: { in: [feeInWindow.id, feeOutWindow.id] } }
        });
      }
    });


    it('feeWindowWhere() includes the boundary month (Feb 2025) when now is Jan 2026', async () => {
      const januaryNow = new Date('2026-01-15T06:00:00Z');
      const windowWhere = feeWindowWhere(januaryNow);

      const boundaryFee = await prisma.fee.create({
        data: {
          student_id: student.id,
          amount: 0,
          trips_count: 0,
          due_date: new Date(Date.UTC(2025, 2, 5)),
          month: 2,
          year: 2025,
          status: 'DUE'
        }
      });

      try {
        const result = await prisma.fee.findFirst({
          where: { id: boundaryFee.id, ...windowWhere }
        });
        assert.notStrictEqual(result, null, 'Feb 2025 is the boundary month and must be included');
      } finally {
        await prisma.fee.deleteMany({ where: { id: boundaryFee.id } });
      }
    });
  });

  // =========================================================================
  // 3. HISTORY_MONTHS constant
  // =========================================================================
  it('HISTORY_MONTHS equals 12', () => {
    assert.strictEqual(HISTORY_MONTHS, 12);
  });
});
