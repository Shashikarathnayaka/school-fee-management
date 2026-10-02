const express = require('express');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middlewares/auth');
const { ensureMonthlyFees } = require('../utils/feeGenerator');

const router = express.Router();
const prisma = new PrismaClient();

// All driver routes require authentication and DRIVER role
router.use(requireAuth, requireRole('DRIVER'));

// POST /driver/routes (create a route)
const createRouteSchema = z.object({
  name: z.string().min(2),
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const routes = await prisma.route.findMany({
    where: { driver_id: req.user.id },
    include: {
      students: {
        include: {
          student: {
            include: {
              pickup_status: {
                where: { date: today }
              }
            }
          }
        },
        orderBy: { pickup_order: 'asc' }
      }
    }
  });
  res.json({ routes });
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

    // Auto-absent cascade: when going off-duty, mark all today's PENDING pickups as ABSENT
    if (current.is_on_duty === true && is_on_duty === false) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const routes = await tx.route.findMany({
        where: { driver_id: req.user.id },
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

// POST /driver/routes/:routeId/students
const addStudentToRouteSchema = z.object({
  student_code: z.string(),
  monthly_fee: z.number().positive()
});

router.post('/routes/:routeId/students', async (req, res) => {
  const { routeId } = req.params;
  const { student_code, monthly_fee } = addStudentToRouteSchema.parse(req.body);

  // Verify driver owns the route
  const route = await prisma.route.findFirst({ where: { id: routeId, driver_id: req.user.id } });
  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
  }

  // Find student by code
  const student = await prisma.student.findUnique({ where: { student_code } });
  if (!student) {
    return res.status(404).json({ error: { message: 'Student code not found', code: 'NOT_FOUND' } });
  }

  // Check if student is already in an active route
  const activeRoute = await prisma.routeStudent.findFirst({
    where: {
      student_id: student.id,
      route: { status: { not: 'COMPLETED' } }
    }
  });

  if (activeRoute) {
    return res.status(409).json({ error: { message: 'Student is already assigned to an active route', code: 'CONFLICT' } });
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
      monthly_fee
    },
    include: { student: true }
  });

  await ensureMonthlyFees({ studentIds: [student.id] });

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

  res.json({ success: true });
});

// PATCH /driver/pickup/:studentId
const pickupSchema = z.object({
  status: z.enum(['PICKED_UP', 'ABSENT', 'PENDING']),
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

  // Verify student exists and get parent details
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) {
    return res.status(404).json({ error: { message: 'Student not found', code: 'NOT_FOUND' } });
  }

  // Get driver name for notification body
  const driverUser = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true }
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await prisma.$transaction(async (tx) => {
    // Read the existing pickupStatus row for today BEFORE upserting
    const existingPickup = await tx.pickupStatus.findFirst({
      where: {
        student_id: studentId,
        route_id: routeId,
        date: today
      }
    });

    const previousStatus = existingPickup ? existingPickup.status : null;
    const hasStatusChanged = previousStatus !== status;

    let pickup;
    if (existingPickup) {
      pickup = await tx.pickupStatus.update({
        where: { id: existingPickup.id },
        data: { status }
      });
    } else {
      pickup = await tx.pickupStatus.create({
        data: {
          student_id: studentId,
          route_id: routeId,
          date: today,
          status
        }
      });
    }

    // Create a Notification for the student's parent ONLY when the status actually changes to PICKED_UP or ABSENT
    if (hasStatusChanged && (status === 'PICKED_UP' || status === 'ABSENT')) {
      const now = new Date();
      let title;
      let body;

      if (status === 'PICKED_UP') {
        const timeFormatted = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
        title = 'Child Picked Up';
        body = `${student.name} was picked up at ${timeFormatted} by ${driverUser.name}.`;
      } else if (status === 'ABSENT') {
        const dateFormatted = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: 'short', year: 'numeric' }).format(now);
        title = 'Marked Absent';
        body = `${student.name} was marked absent today (${dateFormatted}).`;
      }

      await tx.notification.create({
        data: {
          user_id: student.parent_id,
          title,
          body
        }
      });
    }

    return pickup;
  });

  res.json({ pickup: result });
});

// PATCH /driver/routes/:routeId/complete - mark route as completed, cascade PENDING→ABSENT
router.patch('/routes/:routeId/complete', async (req, res) => {
  const { routeId } = req.params;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

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
            name: true
          }
        }
      },
      orderBy: [{ date: 'desc' }, { updated_at: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.pickupStatus.count({ where }),
  ]);

  res.json({ history, pagination: { page, limit, total } });
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
      paid_date: true
    },
    orderBy: { due_date: 'desc' }
  });

  res.json({ fees });
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

    return updatedFee;
  });

  res.json({ fee: result });
});

module.exports = router;

