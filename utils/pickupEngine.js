const { PrismaClient, Prisma } = require('@prisma/client');
const { slToday, slMonthYear, isRouteLiveNow, formatSLTime } = require('./slDate');
const { HttpError } = require('./httpError');

const prisma = new PrismaClient();

// ─── Constants ────────────────────────────────────────────────────────────────
const OPPOSITE = {
  HOME_TO_SCHOOL: 'SCHOOL_TO_HOME',
  SCHOOL_TO_HOME: 'HOME_TO_SCHOOL'
};
const LIVE = { notIn: ['COMPLETED', 'ARCHIVED'] };

/**
 * Resyncs a fee row from its associated trip_charges.
 * Fee.amount = MIN(SUM(trip_charges.amount), monthly_fee - sum_of_other_cycles)
 * Fee.trips_count = COUNT(trip_charges)
 *
 * @param {Object} tx - Prisma transaction client
 * @param {string} feeId - Fee UUID
 * @param {number|Decimal|string} monthlyFee - Student's monthly fee
 * @returns {Promise<Object>}
 */
async function syncFee(tx, feeId, monthlyFee) {
  const current = await tx.fee.findUnique({
    where: { id: feeId },
    select: { student_id: true, month: true, year: true }
  });

  const agg = await tx.tripCharge.aggregate({
    where: { fee_id: feeId },
    _sum: { amount: true },
    _count: { id: true }
  });

  // Other cycles (e.g. an already-paid one) of the same month use up part of the monthly fee
  const others = await tx.fee.aggregate({
    where: {
      student_id: current.student_id,
      month: current.month,
      year: current.year,
      id: { not: feeId }
    },
    _sum: { amount: true }
  });

  const totalSum = agg._sum.amount ? new Prisma.Decimal(agg._sum.amount) : new Prisma.Decimal(0);
  const othersSum = others._sum.amount ? new Prisma.Decimal(others._sum.amount) : new Prisma.Decimal(0);
  let remaining = new Prisma.Decimal(monthlyFee).minus(othersSum);
  if (remaining.lessThan(0)) remaining = new Prisma.Decimal(0);
  const cappedAmount = totalSum.greaterThan(remaining) ? remaining : totalSum;
  const tripsCount = agg._count.id;

  return await tx.fee.update({
    where: { id: feeId },
    data: {
      amount: cappedAmount,
      trips_count: tripsCount
    }
  });
}

/**
 * Returns the latest open (non-PAID) fee for the given student/month/year,
 * or creates a new cycle if the latest is already PAID (or none exists).
 *
 * @param {Object} tx - Prisma transaction client
 * @param {string} studentId
 * @param {number} month
 * @param {number} year
 * @returns {Promise<Object>}
 */
async function getOrCreateOpenFee(tx, studentId, month, year) {
  const latest = await tx.fee.findFirst({
    where: { student_id: studentId, month, year },
    orderBy: { cycle: 'desc' }
  });

  if (latest && latest.status !== 'PAID') {
    return latest;
  }

  return await tx.fee.create({
    data: {
      student_id: studentId,
      amount: 0,
      trips_count: 0,
      status: 'DUE',
      due_date: new Date(Date.UTC(year, month, 5, 0, 0, 0)),
      month,
      year,
      cycle: latest ? latest.cycle + 1 : 1
    }
  });
}

/**
 * Returns a Prisma where-clause matching the twin route of the given route.
 * Use this in route-level queries only (e.g., prisma.route.findFirst/updateMany).
 *
 * @param {string} driverId
 * @param {{ name: string, direction: string }} route
 * @returns {Object}
 */
function twinWhere(driverId, route) {
  return {
    driver_id: driverId,
    name: route.name,
    direction: OPPOSITE[route.direction],
    status: LIVE
  };
}

// Per-driver in-memory lock so concurrent requests don't create duplicate twins
const twinLocks = new Map();

/**
 * For every live route this driver owns, ensures an opposite-direction twin with
 * the same name exists and copies any RouteStudent rows the twin is missing.
 * Skips students who already have a live same-direction route with this driver.
 * Does NOT copy start_time or end_time.
 *
 * @param {string} driverId
 * @returns {Promise<void>}
 */
async function ensureTwinRoutes(driverId) {
  if (twinLocks.has(driverId)) {
    return twinLocks.get(driverId);
  }
  const promise = syncTwins(driverId).finally(() => twinLocks.delete(driverId));
  twinLocks.set(driverId, promise);
  return promise;
}

async function syncTwins(driverId) {
  const routes = await prisma.route.findMany({
    where: { driver_id: driverId, status: LIVE },
    include: { students: true }
  });

  for (const route of routes) {
    // Find or create the twin route (opposite direction, same name)
    let twin = await prisma.route.findFirst({
      where: twinWhere(driverId, route),
      include: { students: true }
    });

    if (!twin) {
      twin = await prisma.route.create({
        data: {
          driver_id: driverId,
          name: route.name,
          direction: OPPOSITE[route.direction],
          status: route.status
          // start_time and end_time intentionally omitted (null)
        },
        include: { students: true }
      });
    }

    // Determine students already in the twin
    const twinStudentIds = new Set(twin.students.map(rs => rs.student_id));

    // Compute next pickup_order for new rows in the twin
    let nextOrder = twin.students.length > 0
      ? Math.max(...twin.students.map(s => s.pickup_order || 0)) + 1
      : 1;

    for (const rs of route.students) {
      // Already in twin — skip
      if (twinStudentIds.has(rs.student_id)) continue;

      // Skip if student already has a live route of the twin direction with THIS driver
      const alreadyOnTwinDir = await prisma.routeStudent.findFirst({
        where: {
          student_id: rs.student_id,
          route: {
            driver_id: driverId,
            direction: OPPOSITE[route.direction],
            status: LIVE
          }
        }
      });
      if (alreadyOnTwinDir) continue;

      await prisma.routeStudent.create({
        data: {
          route_id: twin.id,
          student_id: rs.student_id,
          pickup_order: nextOrder++,
          monthly_fee: rs.monthly_fee
        }
      });
    }
  }
}

/**
 * Applies a pickup status change for a student on a route.
 * Handles validation, pickup record update, fee creation/resync,
 * trip charges (on DROPPED only), and parent notifications within a single transaction.
 *
 * @param {Object} params
 * @param {string} params.studentId
 * @param {string} params.routeId
 * @param {string} params.status - 'PENDING' | 'PICKED_UP' | 'DROPPED' | 'ABSENT'
 * @param {string} [params.actorUserId]
 * @param {string} [params.method] - 'MANUAL' | 'TICKET'
 * @param {boolean} [params.enforcePeriod=true] - If true, throws when route is not live now
 * @returns {Promise<{ pickup: Object, fee: Object|null, charge: Object|null }>}
 */
async function applyPickupStatus({ studentId, routeId, status, actorUserId, method, enforcePeriod = true }) {
  return await prisma.$transaction(async (tx) => {
    const today = slToday();
    const { month, year } = slMonthYear();

    // ── Step 1: Load route-independent data ──────────────────────────────────
    const [student, routeStudent, route] = await Promise.all([
      tx.student.findUnique({
        where: { id: studentId },
        select: {
          id: true,
          name: true,
          parent_id: true,
          pickup_location: true,
          school_name: true,
          student_code: true
        }
      }),
      tx.routeStudent.findFirst({
        where: {
          route_id: routeId,
          student_id: studentId
        }
      }),
      tx.route.findUnique({
        where: { id: routeId },
        select: {
          id: true,
          name: true,
          direction: true
        }
      })
    ]);

    if (!student) {
      throw new HttpError(404, 'Student not found', 'NOT_FOUND');
    }

    if (!routeStudent || !route) {
      throw new HttpError(409, 'Student is not assigned to this route', 'NOT_ON_ROUTE');
    }

    // ── Period guard (admins bypass with enforcePeriod: false) ───────────────
    if (enforcePeriod && !isRouteLiveNow(route.direction)) {
      const label = route.direction === 'HOME_TO_SCHOOL'
        ? 'morning (Home to School)'
        : 'evening (School to Home)';
      throw new HttpError(
        409,
        `This route is not active right now. Only the ${label} route can be used at this time.`,
        'WRONG_PERIOD'
      );
    }

    // Derive period from route direction so the stored row always matches its route,
    // regardless of what the clock says (important for admin overrides).
    const period = route.direction === 'HOME_TO_SCHOOL' ? 'MORNING' : 'EVENING';

    // ── Step 2: Load period-dependent data ───────────────────────────────────
    const [existing, existingFee] = await Promise.all([
      tx.pickupStatus.findUnique({
        where: {
          route_id_student_id_date_period: {
            route_id: routeId,
            student_id: studentId,
            date: today,
            period
          }
        }
      }),
      tx.fee.findFirst({
        where: { student_id: studentId, month, year },
        orderBy: { cycle: 'desc' }
      })
    ]);

    const previousStatus = existing ? existing.status : null;
    const hasStatusChanged = previousStatus !== status;

    // 4. Validate transition: DROPPED is only allowed when current status is PICKED_UP (or already DROPPED)
    if (status === 'DROPPED') {
      if (!existing || (existing.status !== 'PICKED_UP' && existing.status !== 'DROPPED')) {
        throw new HttpError(409, 'Cannot drop off without pickup first', 'PICKUP_REQUIRED');
      }
    }

    // 5. Create or update pickup row
    const pickupData = {
      status,
      ...(method ? { pickup_method: method } : {}),
      ...(actorUserId ? { marked_by: actorUserId } : {})
    };

    let pickup;
    if (existing) {
      pickup = await tx.pickupStatus.update({
        where: { id: existing.id },
        data: pickupData,
        include: {
          student: { select: { id: true, name: true, student_code: true } },
          route: { select: { id: true, name: true, direction: true } }
        }
      });
    } else {
      pickup = await tx.pickupStatus.create({
        data: {
          route_id: routeId,
          student_id: studentId,
          date: today,
          period,
          ...pickupData
        },
        include: {
          student: { select: { id: true, name: true, student_code: true } },
          route: { select: { id: true, name: true, direction: true } }
        }
      });
    }

    let fee = existingFee;

    // Helper to format fee response
    const formatFee = (f) => f ? {
      id: f.id,
      amount: Number(f.amount),
      trips_count: f.trips_count,
      trips_total: 40,
      status: f.status
    } : null;

    // If status did not change, repeating the same status is a no-op
    if (!hasStatusChanged) {
      return {
        pickup,
        fee: formatFee(fee),
        charge: null
      };
    }

    // Make sure the month has at least one fee row (cycle 1)
    if (!fee) {
      fee = await getOrCreateOpenFee(tx, studentId, month, year);
    }

    let charge = null;
    const monthlyFeeNum = Number(routeStudent.monthly_fee);
    const perTripAmount = Number((Math.round((monthlyFeeNum / 40) * 100) / 100).toFixed(2));

    if (status === 'DROPPED') {
      // Becoming DROPPED adds one DROP charge (only if this pickup has none yet)
      const existingDropCharge = await tx.tripCharge.findUnique({
        where: { pickup_id_kind: { pickup_id: pickup.id, kind: 'DROP' } }
      });

      if (!existingDropCharge) {
        // Use the open fee. If the last one was PAID, a new cycle starts from Rs. 0 here.
        fee = await getOrCreateOpenFee(tx, studentId, month, year);

        // The 40-trip limit applies to the whole month, across all cycles
        const monthChargesCount = await tx.tripCharge.count({
          where: { fee: { student_id: studentId, month, year } }
        });

        if (monthChargesCount < 40) {
          await tx.tripCharge.create({
            data: {
              pickup_id: pickup.id,
              fee_id: fee.id,
              kind: 'DROP',
              amount: perTripAmount
            }
          });
          charge = { kind: 'DROP', amount: perTripAmount };
        }

        fee = await syncFee(tx, fee.id, routeStudent.monthly_fee);
      }
    } else if (previousStatus === 'DROPPED') {
      // DROPPED -> PICKED_UP / PENDING / ABSENT removes the charge, unless its fee is already PAID
      const dropCharge = await tx.tripCharge.findUnique({
        where: { pickup_id_kind: { pickup_id: pickup.id, kind: 'DROP' } },
        include: { fee: { select: { id: true, status: true } } }
      });

      if (dropCharge && dropCharge.fee.status !== 'PAID') {
        await tx.tripCharge.delete({ where: { id: dropCharge.id } });
        fee = await syncFee(tx, dropCharge.fee.id, routeStudent.monthly_fee);
      }
    }
    // Note: PICKED_UP -> anything never touches charges (it has none).

    // 7. Notification for parent when status actually changed to PICKED_UP, DROPPED, or ABSENT
    const now = new Date();
    const timeFormatted = formatSLTime(now);
    const pickupLoc = (student.pickup_location && student.pickup_location.trim().length > 0)
      ? student.pickup_location.trim()
      : 'home';
    const schoolName = (student.school_name && student.school_name.trim().length > 0)
      ? student.school_name.trim()
      : 'school';

    let notifTitle = null;
    let notifBody = null;

    // Notifications follow the period: morning = home→school, evening = school→home
    const isHomeToSchool = period === 'MORNING';

    if (status === 'PICKED_UP') {
      notifTitle = 'Child Picked Up';
      notifBody = isHomeToSchool
        ? `${student.name} was picked up from ${pickupLoc} at ${timeFormatted}.`
        : `${student.name} was picked up from ${schoolName} at ${timeFormatted}.`;
    } else if (status === 'DROPPED') {
      notifTitle = 'Child Dropped Off';
      notifBody = isHomeToSchool
        ? `${student.name} was dropped off at ${schoolName} at ${timeFormatted}.`
        : `${student.name} was dropped off at ${pickupLoc} at ${timeFormatted}.`;
    } else if (status === 'ABSENT') {
      notifTitle = 'Marked Absent';
      const dateFormatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Colombo',
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      }).format(now);
      notifBody = `${student.name} was marked absent today (${dateFormatted}).`;
    }

    if (notifTitle && notifBody) {
      await tx.notification.create({
        data: {
          user_id: student.parent_id,
          title: notifTitle,
          body: notifBody
        }
      });
    }

    return {
      pickup,
      fee: formatFee(fee),
      charge
    };
  }, {
    maxWait: 10000,
    timeout: 30000
  });
}

module.exports = { applyPickupStatus, syncFee, getOrCreateOpenFee, ensureTwinRoutes, twinWhere };
