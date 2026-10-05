const { PrismaClient, Prisma } = require('@prisma/client');
const { slToday, slMonthYear, formatSLTime } = require('./slDate');
const { HttpError } = require('./httpError');

const prisma = new PrismaClient();

/**
 * Resyncs a fee row from its associated trip_charges.
 * Fee.amount = MIN(SUM(trip_charges.amount), monthly_fee)
 * Fee.trips_count = COUNT(trip_charges)
 *
 * @param {Object} tx - Prisma transaction client
 * @param {string} feeId - Fee UUID
 * @param {number|Decimal|string} monthlyFee - Student's monthly fee
 * @returns {Promise<Object>}
 */
async function syncFee(tx, feeId, monthlyFee) {
  const agg = await tx.tripCharge.aggregate({
    where: { fee_id: feeId },
    _sum: { amount: true },
    _count: { id: true }
  });

  const totalSum = agg._sum.amount ? new Prisma.Decimal(agg._sum.amount) : new Prisma.Decimal(0);
  const monthlyFeeDec = new Prisma.Decimal(monthlyFee);
  const cappedAmount = totalSum.greaterThan(monthlyFeeDec) ? monthlyFeeDec : totalSum;
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
 * @returns {Promise<{ pickup: Object, fee: Object|null, charge: Object|null }>}
 */
async function applyPickupStatus({ studentId, routeId, status, actorUserId, method }) {
  return await prisma.$transaction(async (tx) => {
    const today = slToday();
    const { month, year } = slMonthYear();

    // 1 & 2. Load student, RouteStudent, route, and existing pickup row in parallel
    const [student, routeStudent, route, existing, existingFee] = await Promise.all([
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
      }),
      tx.pickupStatus.findUnique({
        where: {
          route_id_student_id_date: {
            route_id: routeId,
            student_id: studentId,
            date: today
          }
        }
      }),
      tx.fee.findUnique({
        where: {
          student_id_month_year: {
            student_id: studentId,
            month,
            year
          }
        }
      })
    ]);

    if (!student) {
      throw new HttpError(404, 'Student not found', 'NOT_FOUND');
    }

    if (!routeStudent || !route) {
      throw new HttpError(409, 'Student is not assigned to this route', 'NOT_ON_ROUTE');
    }

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

    // Find or create fee if not found
    if (!fee) {
      const nextDueDate = new Date(Date.UTC(year, month, 5, 0, 0, 0));
      fee = await tx.fee.create({
        data: {
          student_id: studentId,
          amount: 0,
          trips_count: 0,
          status: 'DUE',
          due_date: nextDueDate,
          month,
          year
        }
      });
    }

    let charge = null;

    // If the fee is PAID, it is locked: add or remove no charges
    if (fee.status !== 'PAID') {
      const monthlyFeeNum = Number(routeStudent.monthly_fee);
      const perTripAmount = Number((Math.round((monthlyFeeNum / 40) * 100) / 100).toFixed(2));

      if (status === 'DROPPED') {
        // Becoming DROPPED adds one DROP charge
        const existingDropCharge = await tx.tripCharge.findUnique({
          where: {
            pickup_id_kind: {
              pickup_id: pickup.id,
              kind: 'DROP'
            }
          }
        });

        if (!existingDropCharge) {
          const currentChargesCount = await tx.tripCharge.count({
            where: { fee_id: fee.id }
          });

          if (currentChargesCount < 40) {
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
        }

        fee = await syncFee(tx, fee.id, routeStudent.monthly_fee);
      } else if (previousStatus === 'DROPPED') {
        // DROPPED -> PICKED_UP, PENDING or ABSENT deletes the row's charge and resyncs the fee
        await tx.tripCharge.deleteMany({
          where: { pickup_id: pickup.id }
        });
        fee = await syncFee(tx, fee.id, routeStudent.monthly_fee);
      }
      // Note: PICKED_UP -> anything never touches charges (it has none).
    }

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

    const isHomeToSchool = route.direction === 'HOME_TO_SCHOOL';

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

module.exports = { applyPickupStatus, syncFee };
