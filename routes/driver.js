const express = require('express');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middlewares/auth');
const { ensureMonthlyFees } = require('../utils/feeGenerator');
const { slToday, slDateString, slMonthYear, currentPeriod, activeDirection, isRouteLiveNow, formatSLTime } = require('../utils/slDate');
const { applyPickupStatus, getOrCreateOpenFee, ensureTwinRoutes, twinWhere } = require('../utils/pickupEngine');

const router = express.Router();
const prisma = new PrismaClient();

// All driver routes require authentication and DRIVER role
router.use(requireAuth, requireRole('DRIVER'));

// POST /driver/routes (create a route)
const createRouteSchema = z.object({
  name: z.string().min(2),
  direction: z.enum(['HOME_TO_SCHOOL', 'SCHOOL_TO_HOME']).default('HOME_TO_SCHOOL'),
  start_time: z.string().optional(),
  end_time: z.string().optional()
});

router.post('/routes', async (req, res) => {
  const data = createRouteSchema.parse(req.body);
  const route = await prisma.route.create({
    data: {
      ...data,
      driver_id: req.user.id
    }
  });
  res.status(201).json({ route });
});

// GET /driver/routes/today
router.get('/routes/today', async (req, res) => {
  const today = slToday();

  // Ensure every live route has an opposite-direction twin (best-effort, never fails the request)
  try {
    await ensureTwinRoutes(req.user.id);
  } catch (err) {
    console.error('[ensureTwinRoutes] failed for driver', req.user.id, err);
  }

  const routes = await prisma.route.findMany({
    where: {
      driver_id: req.user.id,
      status: { not: 'ARCHIVED' }
    },
    include: {
      students: {
        include: {
          student: true
        },
        orderBy: { pickup_order: 'asc' }
      }
    }
  });

  const routeIds = routes.map(r => r.id);

  let pickups = [];
  if (routeIds.length > 0) {
    pickups = await prisma.pickupStatus.findMany({
      where: {
        route_id: { in: routeIds },
        date: today,
        period: currentPeriod()
      }
    });
  }

  const pickupMap = new Map();
  for (const p of pickups) {
    pickupMap.set(`${p.route_id}_${p.student_id}`, p);
  }

  const formattedRoutes = routes.map(route => {
    const formattedStudents = route.students.map(rs => {
      const mFee = Number(rs.monthly_fee);
      const perTrip = Number((Math.round((mFee / 40) * 100) / 100).toFixed(2));
      const pickupRow = pickupMap.get(`${rs.route_id}_${rs.student_id}`);
      return {
        ...rs,
        monthly_fee: mFee,
        per_trip_amount: perTrip,
        student: {
          ...rs.student,
          pickup_status: pickupRow ? [pickupRow] : []
        }
      };
    });

    return {
      ...route,
      is_active_now: isRouteLiveNow(route.direction),
      students: formattedStudents
    };
  });

  // Order HOME_TO_SCHOOL first
  formattedRoutes.sort((a, b) => {
    if (a.direction === 'HOME_TO_SCHOOL' && b.direction !== 'HOME_TO_SCHOOL') return -1;
    if (a.direction !== 'HOME_TO_SCHOOL' && b.direction === 'HOME_TO_SCHOOL') return 1;
    return 0;
  });

  res.json({
    routes: formattedRoutes,
    period: currentPeriod(),
    active_direction: activeDirection()
  });
});

// PATCH /driver/status - toggle on-duty/off-duty
const updateStatusSchema = z.object({
  is_on_duty: z.boolean()
});

router.patch('/status', async (req, res) => {
  const { is_on_duty } = updateStatusSchema.parse(req.body);

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.driver.findUnique({ where: { user_id: req.user.id } });
    const driver = await tx.driver.update({
      where: { user_id: req.user.id },
      data: { is_on_duty }
    });

    // When going off-duty: set ACTIVE routes back to SCHEDULED and cascade today's PENDING pickups to ABSENT
    if (current.is_on_duty === true && is_on_duty === false) {
      await tx.route.updateMany({
        where: {
          driver_id: req.user.id,
          status: 'ACTIVE'
        },
        data: { status: 'SCHEDULED' }
      });

      const today = slToday();
      const routes = await tx.route.findMany({
        where: {
          driver_id: req.user.id,
          status: { notIn: ['COMPLETED', 'ARCHIVED'] }
        },
        select: { id: true }
      });
      const routeIds = routes.map(r => r.id);
      if (routeIds.length > 0) {
        await tx.pickupStatus.updateMany({
          where: { route_id: { in: routeIds }, date: today, status: 'PENDING' },
          data: { status: 'ABSENT' }
        });
      }
    }

    return driver;
  });

  res.json({ driver: result });
});

// GET /driver/students/by-code/:code (DRIVER)
router.get('/students/by-code/:code', async (req, res) => {
  const { code } = req.params;

  const student = await prisma.student.findUnique({
    where: { student_code: code },
    select: {
      id: true,
      name: true,
      grade: true,
      section: true,
      school_name: true,
      pickup_location: true
    }
  });

  if (!student) {
    return res.status(404).json({
      error: { message: 'Student not found', code: 'STUDENT_NOT_FOUND' }
    });
  }

  const activeRouteStudent = await prisma.routeStudent.findFirst({
    where: {
      student_id: student.id,
      route: {
        driver_id: req.user.id,
        status: { notIn: ['COMPLETED', 'ARCHIVED'] }
      }
    },
    include: {
      route: {
        select: {
          id: true,
          name: true,
          direction: true
        }
      }
    }
  });

  res.json({
    student,
    existing_monthly_fee: activeRouteStudent ? Number(activeRouteStudent.monthly_fee) : null,
    existing_route: activeRouteStudent ? {
      id: activeRouteStudent.route.id,
      name: activeRouteStudent.route.name,
      direction: activeRouteStudent.route.direction
    } : null
  });
});

// POST /driver/routes/:routeId/students { student_code, monthly_fee? }
const addStudentToRouteSchema = z.object({
  student_code: z.string(),
  monthly_fee: z.number().positive().optional()
});

router.post('/routes/:routeId/students', async (req, res) => {
  const { routeId } = req.params;
  const { student_code, monthly_fee } = addStudentToRouteSchema.parse(req.body);

  // Verify driver owns the route
  const route = await prisma.route.findFirst({
    where: { id: routeId, driver_id: req.user.id }
  });
  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  // Find student by code
  const student = await prisma.student.findUnique({ where: { student_code } });
  if (!student) {
    return res.status(404).json({ error: { message: 'Student code not found', code: 'NOT_FOUND' } });
  }

  // 1. If student has an active RouteStudent on a different driver's route -> 409 CONFLICT
  const otherDriverActiveRoute = await prisma.routeStudent.findFirst({
    where: {
      student_id: student.id,
      route: {
        driver_id: { not: req.user.id },
        status: { notIn: ['COMPLETED', 'ARCHIVED'] }
      }
    }
  });

  if (otherDriverActiveRoute) {
    return res.status(409).json({
      error: { message: 'Student is already assigned to an active route', code: 'CONFLICT' }
    });
  }

  // 2. One route covers both trips, so a student can be on only one active route
  const alreadyOnActiveRoute = await prisma.routeStudent.findFirst({
    where: {
      student_id: student.id,
      route: { status: { notIn: ['COMPLETED', 'ARCHIVED'] } }
    }
  });

  if (alreadyOnActiveRoute) {
    return res.status(409).json({
      error: { message: 'Student is already assigned to an active route', code: 'CONFLICT' }
    });
  }

  // 3. Check for active RouteStudent with this driver on the other direction
  const otherDirection = route.direction === 'HOME_TO_SCHOOL' ? 'SCHOOL_TO_HOME' : 'HOME_TO_SCHOOL';
  const existingActiveRoute = await prisma.routeStudent.findFirst({
    where: {
      student_id: student.id,
      route: {
        driver_id: req.user.id,
        direction: otherDirection,
        status: { notIn: ['COMPLETED', 'ARCHIVED'] }
      }
    }
  });

  let finalMonthlyFee;
  if (existingActiveRoute) {
    const existingFeeNum = Number(existingActiveRoute.monthly_fee);
    if (monthly_fee === undefined || monthly_fee === null) {
      finalMonthlyFee = existingFeeNum;
    } else {
      if (monthly_fee !== existingFeeNum) {
        return res.status(409).json({
          error: {
            message: `This student's monthly fee is already Rs. ${existingFeeNum}`,
            code: 'FEE_MISMATCH'
          }
        });
      }
      finalMonthlyFee = monthly_fee;
    }
  } else {
    if (monthly_fee === undefined || monthly_fee === null) {
      return res.status(400).json({
        error: {
          message: 'Monthly fee is required',
          code: 'VALIDATION_ERROR'
        }
      });
    }
    finalMonthlyFee = monthly_fee;
  }

  // Get max pickup order
  const lastStudent = await prisma.routeStudent.findFirst({
    where: { route_id: routeId },
    orderBy: { pickup_order: 'desc' }
  });
  const pickup_order = lastStudent ? (lastStudent.pickup_order || 0) + 1 : 1;

  const routeStudent = await prisma.routeStudent.create({
    data: {
      route_id: routeId,
      student_id: student.id,
      pickup_order,
      monthly_fee: finalMonthlyFee
    },
    include: { student: true }
  });

  await ensureMonthlyFees({ studentIds: [student.id] });
  await ensureTwinRoutes(req.user.id);

  res.status(201).json({ routeStudent });
});

// DELETE /driver/routes/:routeId/students/:studentId
router.delete('/routes/:routeId/students/:studentId', async (req, res) => {
  const { routeId, studentId } = req.params;

  // Verify driver owns route
  const route = await prisma.route.findFirst({ where: { id: routeId, driver_id: req.user.id } });
  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  const deleted = await prisma.routeStudent.deleteMany({
    where: { route_id: routeId, student_id: studentId }
  });

  if (deleted.count === 0) {
    return res.status(404).json({ error: { message: 'Student not found in route', code: 'NOT_FOUND' } });
  }

  // Also remove the student from the twin route (if any)
  await prisma.routeStudent.deleteMany({
    where: { student_id: studentId, route: twinWhere(req.user.id, route) }
  });

  res.json({ success: true });
});

// PATCH /driver/routes/:routeId { name?, start_time?, end_time?, direction? }
const updateRouteSchema = z.object({
  name: z.string().min(2).optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  direction: z.enum(['HOME_TO_SCHOOL', 'SCHOOL_TO_HOME']).optional()
});

router.patch('/routes/:routeId', async (req, res) => {
  const { routeId } = req.params;
  const data = updateRouteSchema.parse(req.body);

  const route = await prisma.route.findFirst({
    where: { id: routeId, driver_id: req.user.id }
  });

  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  if (data.direction && data.direction !== route.direction) {
    // Check if the route has any pickup_status rows
    const historyCount = await prisma.pickupStatus.count({
      where: { route_id: routeId }
    });
    if (historyCount > 0) {
      return res.status(409).json({
        error: {
          message: 'Route has pickup history. Direction cannot be changed.',
          code: 'ROUTE_HAS_HISTORY'
        }
      });
    }

    // Check if a student would end up on two routes of the same direction
    const routeStudents = await prisma.routeStudent.findMany({
      where: { route_id: routeId },
      select: { student_id: true }
    });
    const studentIds = routeStudents.map(rs => rs.student_id);

    if (studentIds.length > 0) {
      const conflict = await prisma.routeStudent.findFirst({
        where: {
          student_id: { in: studentIds },
          route_id: { not: routeId },
          route: {
            direction: data.direction,
            status: { notIn: ['COMPLETED', 'ARCHIVED'] }
          }
        },
        include: { student: true }
      });

      if (conflict) {
        const dirLabel = data.direction === 'HOME_TO_SCHOOL' ? 'Home to School' : 'School to Home';
        return res.status(409).json({
          error: {
            message: `Student is already assigned to an active ${dirLabel} route`,
            code: 'CONFLICT'
          }
        });
      }
    }
  }

  // If the name is changing, rename the twin route first
  if (data.name && data.name !== route.name) {
    await prisma.route.updateMany({
      where: twinWhere(req.user.id, route),
      data: { name: data.name }
    });
  }

  const updated = await prisma.route.update({
    where: { id: routeId },
    data
  });

  res.json({ route: updated });
});

// DELETE /driver/routes/:routeId
router.delete('/routes/:routeId', async (req, res) => {
  const { routeId } = req.params;

  const route = await prisma.route.findFirst({
    where: { id: routeId, driver_id: req.user.id }
  });

  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  const historyCount = await prisma.pickupStatus.count({
    where: { route_id: routeId }
  });

  if (historyCount > 0) {
    return res.status(409).json({
      error: {
        message: 'Route has pickup history. Archive it instead.',
        code: 'ROUTE_HAS_HISTORY'
      }
    });
  }

  await prisma.route.delete({
    where: { id: routeId }
  });

  // Archive the twin so ensureTwinRoutes does not recreate it
  await prisma.route.updateMany({
    where: twinWhere(req.user.id, route),
    data: { status: 'ARCHIVED' }
  });

  res.json({ success: true });
});

// PATCH /driver/routes/:routeId/archive
router.patch('/routes/:routeId/archive', async (req, res) => {
  const { routeId } = req.params;

  const route = await prisma.route.findFirst({
    where: { id: routeId, driver_id: req.user.id }
  });

  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  const updated = await prisma.route.update({
    where: { id: routeId },
    data: { status: 'ARCHIVED' }
  });

  // Archive the twin so ensureTwinRoutes does not recreate it
  await prisma.route.updateMany({
    where: twinWhere(req.user.id, route),
    data: { status: 'ARCHIVED' }
  });

  res.json({ route: updated });
});

// PATCH /driver/pickup/:studentId
const pickupSchema = z.object({
  status: z.enum(['PICKED_UP', 'DROPPED', 'ABSENT', 'PENDING']),
  routeId: z.string() // Need to know which route to record it against
});

router.patch('/pickup/:studentId', async (req, res) => {
  const { studentId } = req.params;
  const { status, routeId } = pickupSchema.parse(req.body);

  // Verify driver owns route
  const route = await prisma.route.findFirst({ where: { id: routeId, driver_id: req.user.id } });
  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  const { pickup, fee, charge } = await applyPickupStatus({
    studentId,
    routeId,
    status,
    actorUserId: req.user.id,
    method: 'MANUAL'
  });

  res.json({ pickup, fee, charge });
});

// POST /driver/routes/:routeId/start - start route and notify parents
router.post('/routes/:routeId/start', async (req, res) => {
  const { routeId } = req.params;

  const route = await prisma.route.findFirst({
    where: { id: routeId, driver_id: req.user.id }
  });

  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  if (route.status === 'ARCHIVED' || route.status === 'COMPLETED') {
    return res.status(409).json({
      error: {
        message: `Cannot start a route that is ${route.status.toLowerCase()}`,
        code: 'INVALID_STATE'
      }
    });
  }

  const driver = await prisma.driver.findUnique({
    where: { user_id: req.user.id }
  });

  if (!driver || !driver.is_on_duty) {
    return res.status(409).json({
      error: {
        message: 'Driver must be on duty to start a route',
        code: 'NOT_ON_DUTY'
      }
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    // a. Set driver's other ACTIVE routes back to SCHEDULED
    await tx.route.updateMany({
      where: {
        driver_id: req.user.id,
        id: { not: routeId },
        status: 'ACTIVE'
      },
      data: { status: 'SCHEDULED' }
    });

    // b. Set this route status = ACTIVE
    const updatedRoute = await tx.route.update({
      where: { id: routeId },
      data: { status: 'ACTIVE' }
    });

    // c. Load RouteStudent for the route with student (id, name, parent_id)
    const routeStudents = await tx.routeStudent.findMany({
      where: { route_id: routeId },
      include: {
        student: {
          select: {
            id: true,
            name: true,
            parent_id: true
          }
        }
      },
      orderBy: { pickup_order: 'asc' }
    });

    // d. Group by parent_id (one parent with several kids gets ONE notification listing the names)
    const parentStudentsMap = new Map();
    for (const rs of routeStudents) {
      if (rs.student && rs.student.parent_id) {
        const parentId = rs.student.parent_id;
        if (!parentStudentsMap.has(parentId)) {
          parentStudentsMap.set(parentId, []);
        }
        parentStudentsMap.get(parentId).push(rs.student);
      }
    }

    // e. Create Notification rows / f. Idempotent
    const todaySLStr = slDateString();
    const slStartOfDay = new Date(`${todaySLStr}T00:00:00+05:30`);
    const isHomeToSchool = route.direction === 'HOME_TO_SCHOOL';
    const periodLabel = isHomeToSchool ? 'Morning' : 'Evening';
    const actionLabel = isHomeToSchool ? 'pickup' : 'drop-off';
    const timeFormatted = formatSLTime();
    const title = 'Driver on the way';

    let notified = 0;
    let skipped = 0;

    for (const [parentId, students] of parentStudentsMap.entries()) {
      const existingNotifs = await tx.notification.findMany({
        where: {
          user_id: parentId,
          title,
          created_at: { gte: slStartOfDay }
        }
      });

      const alreadyNotified = existingNotifs.some(n =>
        n.body.includes(route.name) &&
        n.body.includes(actionLabel)
      );

      if (alreadyNotified) {
        skipped++;
      } else {
        const names = students.map(s => s.name);
        const namesStr = names.length > 1
          ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
          : names[0];

        const body = `${namesStr}'s van (${driver.van_number}) has started the ${periodLabel} ${actionLabel} route '${route.name}' at ${timeFormatted} and is on the way.`;

        await tx.notification.create({
          data: {
            user_id: parentId,
            title,
            body
          }
        });
        notified++;
      }
    }

    return {
      route: updatedRoute,
      notified,
      skipped
    };
  });

  res.json(result);
});

// PATCH /driver/routes/:routeId/complete - mark route as completed, cascade PENDING→ABSENT
router.patch('/routes/:routeId/complete', async (req, res) => {
  const { routeId } = req.params;
  const today = slToday();

  const result = await prisma.$transaction(async (tx) => {
    // Verify driver owns route
    const route = await tx.route.findFirst({ where: { id: routeId, driver_id: req.user.id } });
    if (!route) {
      return null;
    }

    const updated = await tx.route.update({
      where: { id: routeId },
      data: { status: 'COMPLETED' }
    });

    // Cascade: mark remaining PENDING pickups as ABSENT
    await tx.pickupStatus.updateMany({
      where: { route_id: routeId, date: today, status: 'PENDING' },
      data: { status: 'ABSENT' }
    });

    return updated;
  });

  if (!result) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  res.json({ route: result });
});

// GET /driver/history?date=YYYY-MM-DD&route_id=&page=&limit=
const historyQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  route_id: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

router.get('/history', async (req, res) => {
  const { date, route_id, page, limit } = historyQuerySchema.parse(req.query);

  const where = {
    route: {
      driver_id: req.user.id
    }
  };

  if (date) {
    where.date = new Date(date);
  }

  if (route_id) {
    where.route_id = route_id;
  }

  const [history, total] = await Promise.all([
    prisma.pickupStatus.findMany({
      where,
      select: {
        id: true,
        date: true,
        status: true,
        pickup_method: true,
        updated_at: true,
        period: true,
        student: {
          select: {
            id: true,
            name: true,
            grade: true,
            section: true,
            pickup_location: true
          }
        },
        route: {
          select: {
            id: true,
            name: true,
            direction: true
          }
        }
      },
      orderBy: [{ date: 'desc' }, { updated_at: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.pickupStatus.count({ where }),
  ]);

  const historyWithDirection = history.map(h => ({
    ...h,
    direction: h.period === 'EVENING' ? 'SCHOOL_TO_HOME' : 'HOME_TO_SCHOOL'
  }));

  res.json({ history: historyWithDirection, pagination: { page, limit, total } });
});

// GET /driver/notifications
router.get('/notifications', async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { user_id: req.user.id },
    orderBy: { created_at: 'desc' }
  });
  res.json({ notifications });
});

// PATCH /driver/notifications/:id/read
router.patch('/notifications/:id/read', async (req, res) => {
  const { id } = req.params;
  const notification = await prisma.notification.updateMany({
    where: { id, user_id: req.user.id },
    data: { is_read: true }
  });

  if (notification.count === 0) {
    return res.status(404).json({ error: { message: 'Notification not found', code: 'NOT_FOUND' } });
  }

  res.json({ success: true });
});

// GET /driver/profile
router.get('/profile', async (req, res) => {
  const profile = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, name: true, email: true, phone: true, created_at: true,
      driver: true
    }
  });
  res.json({ profile });
});

// PATCH /driver/profile
const updateProfileSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
  van_number: z.string().optional(),
  license_no: z.string().optional()
});

router.patch('/profile', async (req, res) => {
  const { name, phone, van_number, license_no } = updateProfileSchema.parse(req.body);

  const profile = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      name,
      phone,
      driver: {
        update: {
          van_number,
          license_no
        }
      }
    },
    select: {
      id: true, name: true, email: true, phone: true, created_at: true,
      driver: true
    }
  });
  res.json({ profile });
});

// GET /driver/students/:studentId/fees
const studentFeesParamsSchema = z.object({
  studentId: z.string().uuid()
});

router.get('/students/:studentId/fees', async (req, res) => {
  const { studentId } = studentFeesParamsSchema.parse(req.params);

  // Verify the student is on a route owned by this driver (active first, or any)
  let assignment = await prisma.routeStudent.findFirst({
    where: {
      student_id: studentId,
      route: {
        driver_id: req.user.id,
        status: { notIn: ['COMPLETED', 'ARCHIVED'] }
      }
    }
  });

  if (!assignment) {
    assignment = await prisma.routeStudent.findFirst({
      where: {
        student_id: studentId,
        route: { driver_id: req.user.id }
      }
    });
  }

  if (!assignment) {
    return res.status(404).json({ error: { message: 'Student not found on any of your routes', code: 'NOT_FOUND' } });
  }

  await ensureMonthlyFees({ studentIds: [studentId] });

  const fees = await prisma.fee.findMany({
    where: { student_id: studentId },
    select: {
      id: true,
      amount: true,
      due_date: true,
      month: true,
      year: true,
      status: true,
      paid_date: true,
      trips_count: true,
      cycle: true
    },
    orderBy: [{ due_date: 'desc' }, { cycle: 'desc' }]
  });

  const per_trip_amount = assignment && assignment.monthly_fee
    ? Number((Math.round((Number(assignment.monthly_fee) / 40) * 100) / 100).toFixed(2))
    : null;

  const formattedFees = fees.map(f => ({
    ...f,
    trips_count: f.trips_count ?? 0,
    trips_total: 40,
    per_trip_amount,
    month: f.month,
    year: f.year
  }));

  res.json({ fees: formattedFees });
});

// PATCH /driver/students/:studentId/fees/:feeId/pay
const payStudentFeeParamsSchema = z.object({
  studentId: z.string().uuid(),
  feeId: z.string().uuid()
});

router.patch('/students/:studentId/fees/:feeId/pay', async (req, res) => {
  const { studentId, feeId } = payStudentFeeParamsSchema.parse(req.params);

  // Verify the student is on a route owned by this driver
  const assignment = await prisma.routeStudent.findFirst({
    where: {
      student_id: studentId,
      route: { driver_id: req.user.id }
    }
  });

  if (!assignment) {
    return res.status(404).json({ error: { message: 'Student not found on any of your routes', code: 'NOT_FOUND' } });
  }

  const fee = await prisma.fee.findFirst({
    where: { id: feeId, student_id: studentId },
    include: { student: true }
  });

  if (!fee) {
    return res.status(404).json({ error: { message: 'Fee not found', code: 'NOT_FOUND' } });
  }

  if (fee.status === 'PAID') {
    return res.status(409).json({ error: { message: 'Fee is already paid', code: 'CONFLICT' } });
  }

  if (Number(fee.amount) === 0) {
    return res.status(409).json({ error: { message: 'This month has no charges yet', code: 'NOTHING_TO_PAY' } });
  }

  const driverUser = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true }
  });

  const now = new Date();
  const month = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(fee.due_date);
  const year = fee.due_date.getFullYear();
  const paidDateFormatted = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(now);

  const body = `Rs. ${fee.amount} payment for ${fee.student.name} (${month} ${year} fee) was collected and marked as paid by ${driverUser.name} on ${paidDateFormatted}.`;

  const result = await prisma.$transaction(async (tx) => {
    const updatedFee = await tx.fee.update({
      where: { id: feeId },
      data: {
        status: 'PAID',
        paid_date: now
      }
    });

    await tx.notification.create({
      data: {
        user_id: fee.student.parent_id,
        title: "Payment Successful",
        body
      }
    });

    // Paid in the middle of the current month: start a fresh Rs. 0 cycle
    const sl = slMonthYear();
    if (fee.month === sl.month && fee.year === sl.year) {
      await getOrCreateOpenFee(tx, fee.student_id, fee.month, fee.year);
    }

    return updatedFee;
  });

  res.json({ fee: result });
});

// POST /driver/fees/remind - send fee reminders to parents of students on active routes
const remindFeesSchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
}).optional();

router.post('/fees/remind', async (req, res) => {
  const data = req.body && Object.keys(req.body).length > 0
    ? remindFeesSchema.parse(req.body)
    : {};

  const currentSl = slMonthYear();
  const targetMonth = data?.month !== undefined ? Number(data.month) : currentSl.month;
  const targetYear = data?.year !== undefined ? Number(data.year) : currentSl.year;

  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long' })
    .format(new Date(Date.UTC(targetYear, targetMonth - 1, 1)));

  const todaySLStr = slDateString();
  const slStartOfDay = new Date(`${todaySLStr}T00:00:00+05:30`);

  const routeStudents = await prisma.routeStudent.findMany({
    where: {
      route: {
        driver_id: req.user.id,
        status: { notIn: ['COMPLETED', 'ARCHIVED'] }
      }
    },
    include: {
      student: {
        select: {
          id: true,
          name: true,
          parent_id: true
        }
      }
    }
  });

  const studentMap = new Map();
  for (const rs of routeStudents) {
    if (rs.student && !studentMap.has(rs.student.id)) {
      studentMap.set(rs.student.id, rs.student);
    }
  }

  const studentIds = Array.from(studentMap.keys());
  if (studentIds.length === 0) {
    return res.json({ sent: 0, skipped: 0 });
  }

  const fees = await prisma.fee.findMany({
    where: {
      student_id: { in: studentIds },
      month: targetMonth,
      year: targetYear,
      status: 'DUE',
      amount: { gt: 0 }
    }
  });

  let sent = 0;
  let skipped = 0;

  for (const fee of fees) {
    const student = studentMap.get(fee.student_id);
    if (!student || !student.parent_id) continue;

    const formattedAmount = Number(fee.amount).toLocaleString('en-US');
    const tripsCount = fee.trips_count ?? 0;
    const title = 'Transport Fee Reminder';
    const body = `${student.name}'s transport fee for ${monthName} ${targetYear} is Rs. ${formattedAmount} (${tripsCount} ${tripsCount === 1 ? 'trip' : 'trips'}). Please pay your driver.`;

    const existingNotif = await prisma.notification.findFirst({
      where: {
        user_id: student.parent_id,
        title,
        body,
        created_at: { gte: slStartOfDay }
      }
    });

    if (existingNotif) {
      skipped++;
    } else {
      await prisma.notification.create({
        data: {
          user_id: student.parent_id,
          title,
          body
        }
      });
      sent++;
    }
  }

  res.json({ sent, skipped });
});

module.exports = router;
