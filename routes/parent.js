const express = require('express');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middlewares/auth');
const { generateToken } = require('../utils/auth');
const { ensureMonthlyFees } = require('../utils/feeGenerator');
const { slToday, slMonthYear } = require('../utils/slDate');
const { getOrCreateOpenFee } = require('../utils/pickupEngine');

const router = express.Router();
const prisma = new PrismaClient();

// All parent routes require authentication and PARENT role
router.use(requireAuth, requireRole('PARENT'));

const generateStudentCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'STU-';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// GET /parent/students - list of logged-in parent's children
router.get('/students', async (req, res) => {
  const students = await prisma.student.findMany({
    where: { parent_id: req.user.id }
  });
  res.json({ students });
});

// POST /parent/students - add a child
const createStudentSchema = z.object({
  name: z.string().min(2),
  grade: z.string().optional(),
  section: z.string().optional(),
  school_name: z.string().optional(),
  pickup_location: z.string().optional()
});

router.post('/students', async (req, res) => {
  const data = createStudentSchema.parse(req.body);

  let student_code;
  let isUnique = false;
  // Ensure uniqueness of student code
  while (!isUnique) {
    student_code = generateStudentCode();
    const existing = await prisma.student.findUnique({ where: { student_code } });
    if (!existing) isUnique = true;
  }

  const student = await prisma.student.create({
    data: {
      ...data,
      student_code,
      parent_id: req.user.id
    }
  });

  res.status(201).json({ student });
});

// GET /parent/students/:id - details of one of their own children
router.get('/students/:id', async (req, res) => {
  const { id } = req.params;
  const student = await prisma.student.findFirst({
    where: { id, parent_id: req.user.id }
  });

  if (!student) {
    return res.status(404).json({ error: { message: 'Student not found', code: 'NOT_FOUND' } });
  }

  res.json({ student });
});

// GET /parent/students/:id/pickup-status?date=
router.get('/students/:id/pickup-status', async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;

  // Verify ownership
  const student = await prisma.student.findFirst({
    where: { id, parent_id: req.user.id }
  });

  if (!student) {
    return res.status(404).json({ error: { message: 'Student not found', code: 'NOT_FOUND' } });
  }

  let queryDate;
  if (date) {
    queryDate = new Date(date);
  } else {
    queryDate = slToday();
  }

  const status = await prisma.pickupStatus.findMany({
    where: {
      student_id: id,
      date: queryDate
    },
    include: {
      route: {
        include: {
          driver: {
            include: { user: { select: { name: true, phone: true } } }
          }
        }
      }
    }
  });

  res.json({ status });
});

// GET /parent/fees - all fees across their children
router.get('/fees', async (req, res) => {
  const parentStudents = await prisma.student.findMany({
    where: { parent_id: req.user.id },
    select: { id: true }
  });
  const studentIds = parentStudents.map(s => s.id);
  if (studentIds.length > 0) {
    await ensureMonthlyFees({ studentIds });
  }

  const fees = await prisma.fee.findMany({
    where: {
      student: { parent_id: req.user.id }
    },
    include: {
      student: { select: { name: true, student_code: true } }
    },
    orderBy: [{ due_date: 'desc' }, { cycle: 'desc' }]
  });

  const distinctStudentIds = [...new Set(fees.map(f => f.student_id))];
  const routeStudents = await prisma.routeStudent.findMany({
    where: {
      student_id: { in: distinctStudentIds },
      route: { status: { notIn: ['COMPLETED', 'ARCHIVED'] } }
    },
    select: { student_id: true, monthly_fee: true }
  });

  const routeStudentMap = new Map();
  for (const rs of routeStudents) {
    if (!routeStudentMap.has(rs.student_id)) {
      routeStudentMap.set(rs.student_id, rs.monthly_fee);
    }
  }

  const missingStudentIds = distinctStudentIds.filter(id => !routeStudentMap.has(id));
  if (missingStudentIds.length > 0) {
    const fallbackRS = await prisma.routeStudent.findMany({
      where: { student_id: { in: missingStudentIds } },
      select: { student_id: true, monthly_fee: true }
    });
    for (const rs of fallbackRS) {
      if (!routeStudentMap.has(rs.student_id)) {
        routeStudentMap.set(rs.student_id, rs.monthly_fee);
      }
    }
  }

  const formattedFees = fees.map(f => {
    const monthlyFee = routeStudentMap.get(f.student_id);
    const per_trip_amount = monthlyFee !== undefined && monthlyFee !== null
      ? Number((Math.round((Number(monthlyFee) / 40) * 100) / 100).toFixed(2))
      : null;

    return {
      ...f,
      trips_count: f.trips_count ?? 0,
      trips_total: 40,
      per_trip_amount,
      month: f.month,
      year: f.year
    };
  });

  res.json({ fees: formattedFees });
});

// PATCH /parent/fees/:feeId/pay - mark as paid
router.patch('/fees/:feeId/pay', async (req, res) => {
  const { feeId } = req.params;

  const fee = await prisma.fee.findFirst({
    where: { id: feeId, student: { parent_id: req.user.id } },
    include: {
      student: {
        include: {
          parent: { select: { name: true } }
        }
      }
    }
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

  const now = new Date();
  const month = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(fee.due_date);
  const year = fee.due_date.getFullYear();
  const paidDateFormatted = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(now);
  const body = `Your payment of Rs. ${fee.amount} for ${fee.student.name} (${month} ${year} fee) was successful on ${paidDateFormatted}.`;

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
        user_id: req.user.id,
        title: "Payment Successful",
        body
      }
    });

    // Notify the driver who owns the student's active route
    const activeRouteStudent = await tx.routeStudent.findFirst({
      where: {
        student_id: fee.student_id,
        route: { status: { notIn: ['COMPLETED', 'ARCHIVED'] } }
      },
      include: {
        route: true
      }
    });

    if (activeRouteStudent?.route?.driver_id) {
      const parentName = fee.student.parent?.name || 'Parent';
      await tx.notification.create({
        data: {
          user_id: activeRouteStudent.route.driver_id,
          title: "Fee Paid by Parent",
          body: `${parentName} paid ${fee.month}/${fee.year} fee for ${fee.student.name}.`
        }
      });
    }

    // Paid in the middle of the current month: start a fresh Rs. 0 cycle
    const sl = slMonthYear();
    if (fee.month === sl.month && fee.year === sl.year) {
      await getOrCreateOpenFee(tx, fee.student_id, fee.month, fee.year);
    }

    return updatedFee;
  });

  res.json({ fee: result });
});

// GET /parent/notifications
router.get('/notifications', async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { user_id: req.user.id },
    orderBy: { created_at: 'desc' }
  });
  res.json({ notifications });
});

// PATCH /parent/notifications/:id/read
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

// DELETE /parent/notifications/:id
router.delete('/notifications/:id', async (req, res) => {
  const { id } = req.params;
  const result = await prisma.notification.deleteMany({
    where: { id, user_id: req.user.id }
  });

  if (result.count === 0) {
    return res.status(404).json({ error: { message: 'Notification not found', code: 'NOT_FOUND' } });
  }

  res.json({ success: true });
});

// DELETE /parent/notifications  (clear all)
router.delete('/notifications', async (req, res) => {
  const result = await prisma.notification.deleteMany({
    where: { user_id: req.user.id }
  });

  res.json({ success: true, deleted: result.count });
});

// GET /parent/profile
router.get('/profile', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, name: true, email: true, phone: true, created_at: true, driver: true }
  });
  if (!user) {
    return res.status(404).json({ error: { message: 'User not found', code: 'NOT_FOUND' } });
  }
  const profile = {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    created_at: user.created_at,
    has_driver_profile: !!user.driver
  };
  res.json({ profile });
});

// PATCH /parent/become-driver
const becomeDriverSchema = z.object({
  van_number: z.string().min(1),
  license_no: z.string().min(1)
});

router.patch('/become-driver', async (req, res) => {
  const { van_number, license_no } = becomeDriverSchema.parse(req.body);

  const existingDriver = await prisma.driver.findUnique({
    where: { user_id: req.user.id }
  });

  if (existingDriver) {
    return res.status(409).json({
      error: { message: 'Driver profile already exists', code: 'DRIVER_PROFILE_EXISTS' }
    });
  }

  await prisma.driver.create({
    data: {
      user_id: req.user.id,
      van_number,
      license_no,
      is_on_duty: false
    }
  });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { driver: true }
  });

  const roles = Array.from(new Set([user.role, 'DRIVER', ...(user.driver ? ['DRIVER'] : [])]));
  const token = generateToken({ userId: user.id, roles, role: user.role });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      roles
    }
  });
});

// PATCH /parent/profile
const updateProfileSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional()
});

router.patch('/profile', async (req, res) => {
  const data = updateProfileSchema.parse(req.body);
  const profile = await prisma.user.update({
    where: { id: req.user.id },
    data,
    select: { id: true, name: true, email: true, phone: true, created_at: true }
  });
  res.json({ profile });
});

module.exports = router;
