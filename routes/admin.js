const express = require('express');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();
const prisma = new PrismaClient();

// All admin routes require authentication and ADMIN role
router.use(requireAuth, requireRole('ADMIN'));

// ---------------------------------------------------------------------------
// GET /admin/pickups?date=YYYY-MM-DD&route_id=&student_id=&status=
// List PickupStatus rows joined with student name/photo, route name, driver name
// ---------------------------------------------------------------------------
const pickupsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  route_id: z.string().uuid().optional(),
  student_id: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'PICKED_UP', 'ABSENT']).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

router.get('/pickups', async (req, res) => {
  const { date, route_id, student_id, status, page, limit } = pickupsQuerySchema.parse(req.query);

  const where = {};

  if (date) {
    where.date = new Date(date);
  }
  if (route_id) {
    where.route_id = route_id;
  }
  if (student_id) {
    where.student_id = student_id;
  }
  if (status) {
    where.status = status;
  }

  const [pickups, total] = await Promise.all([
    prisma.pickupStatus.findMany({
      where,
      include: {
        student: {
          select: { id: true, name: true, student_code: true, grade: true, section: true, school_name: true }
        },
        route: {
          select: {
            id: true,
            name: true,
            driver: {
              select: {
                user: { select: { id: true, name: true } }
              }
            }
          }
        }
      },
      orderBy: [{ date: 'desc' }, { updated_at: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.pickupStatus.count({ where }),
  ]);

  res.json({ pickups, pagination: { page, limit, total } });
});

// ---------------------------------------------------------------------------
// PATCH /admin/pickups/:id/mark
// Admin manual override — sets pickup_method = MANUAL, marked_by = admin id
// Does NOT allow moving backward (PICKED_UP/ABSENT → PENDING) unless force=true
// ---------------------------------------------------------------------------
const markPickupSchema = z.object({
  status: z.enum(['PICKED_UP', 'ABSENT', 'PENDING']),
  force: z.boolean().optional().default(false),
});

router.patch('/pickups/:id/mark', async (req, res) => {
  const { id } = req.params;
  const { status, force } = markPickupSchema.parse(req.body);

  const existing = await prisma.pickupStatus.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { message: 'Pickup record not found', code: 'NOT_FOUND' } });
  }

  // Guard against backward moves: PICKED_UP/ABSENT → PENDING
  const isBackward = (existing.status === 'PICKED_UP' || existing.status === 'ABSENT') && status === 'PENDING';
  if (isBackward && !force) {
    return res.status(400).json({
      error: {
        message: `Cannot move status from ${existing.status} to PENDING without force=true`,
        code: 'BACKWARD_STATUS_CHANGE'
      }
    });
  }

  const pickup = await prisma.pickupStatus.update({
    where: { id },
    data: {
      status,
      pickup_method: 'MANUAL',
      marked_by: req.user.id,
    },
    include: {
      student: { select: { id: true, name: true, student_code: true } },
      route: { select: { id: true, name: true } }
    }
  });

  res.json({ pickup });
});

// ---------------------------------------------------------------------------
// POST /admin/pickups/ticket
// Ticket-based pickup: look up student by student_code, find/create today's
// PickupStatus row, set status=PICKED_UP, pickup_method=TICKET
// ---------------------------------------------------------------------------
const ticketPickupSchema = z.object({
  student_code: z.string(),
  route_id: z.string().uuid(),
});

router.post('/pickups/ticket', async (req, res) => {
  const { student_code, route_id } = ticketPickupSchema.parse(req.body);

  // Look up student by code
  const student = await prisma.student.findUnique({ where: { student_code } });
  if (!student) {
    return res.status(404).json({ error: { message: 'Invalid student code', code: 'STUDENT_NOT_FOUND' } });
  }

  // Verify the route exists
  const route = await prisma.route.findUnique({ where: { id: route_id } });
  if (!route) {
    return res.status(404).json({ error: { message: 'Route not found', code: 'ROUTE_NOT_FOUND' } });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check for an existing record
  const existing = await prisma.pickupStatus.findFirst({
    where: { student_id: student.id, route_id, date: today }
  });

  if (existing) {
    // If already marked PICKED_UP or ABSENT, return 409
    if (existing.status === 'PICKED_UP' || existing.status === 'ABSENT') {
      return res.status(409).json({
        error: {
          message: `Student already marked as ${existing.status}`,
          code: 'ALREADY_MARKED'
        }
      });
    }

    // Existing PENDING → update to PICKED_UP
    const pickup = await prisma.pickupStatus.update({
      where: { id: existing.id },
      data: {
        status: 'PICKED_UP',
        pickup_method: 'TICKET',
        marked_by: req.user.id,
      },
      include: {
        student: { select: { id: true, name: true, student_code: true } },
        route: { select: { id: true, name: true } }
      }
    });

    return res.json({ pickup });
  }

  // No existing record — create one
  const pickup = await prisma.pickupStatus.create({
    data: {
      student_id: student.id,
      route_id,
      date: today,
      status: 'PICKED_UP',
      pickup_method: 'TICKET',
      marked_by: req.user.id,
    },
    include: {
      student: { select: { id: true, name: true, student_code: true } },
      route: { select: { id: true, name: true } }
    }
  });

  res.status(201).json({ pickup });
});

// ---------------------------------------------------------------------------
// GET /admin/students/:id/pickup-history
// Full pickup history for one student across all dates/routes
// ---------------------------------------------------------------------------
const historyQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

router.get('/students/:id/pickup-history', async (req, res) => {
  const { id } = req.params;
  const { page, limit } = historyQuerySchema.parse(req.query);

  // Verify student exists
  const student = await prisma.student.findUnique({
    where: { id },
    select: { id: true, name: true, student_code: true, grade: true, section: true, school_name: true }
  });

  if (!student) {
    return res.status(404).json({ error: { message: 'Student not found', code: 'NOT_FOUND' } });
  }

  const where = { student_id: id };

  const [history, total] = await Promise.all([
    prisma.pickupStatus.findMany({
      where,
      include: {
        route: {
          select: {
            id: true,
            name: true,
            driver: {
              select: {
                user: { select: { id: true, name: true } }
              }
            }
          }
        }
      },
      orderBy: [{ date: 'desc' }, { updated_at: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.pickupStatus.count({ where }),
  ]);

  res.json({ student, history, pagination: { page, limit, total } });
});


// ---------------------------------------------------------------------------
// GET /admin/routes
// List routes with driver info for filtering and ticket modals
// ---------------------------------------------------------------------------
router.get('/routes', async (req, res) => {
  const routes = await prisma.route.findMany({
    select: {
      id: true,
      name: true,
      status: true,
      driver: {
        select: {
          user: { select: { id: true, name: true } },
          van_number: true
        }
      }
    },
    orderBy: { name: 'asc' }
  });
  res.json({ routes });
});

module.exports = router;

