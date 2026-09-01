const express = require('express');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middlewares/auth');

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

  const queryDate = date ? new Date(date) : new Date();
  
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
  const fees = await prisma.fee.findMany({
    where: { 
      student: { parent_id: req.user.id }
    },
    include: {
      student: { select: { name: true, student_code: true } }
    }
  });
  res.json({ fees });
});

// PATCH /parent/fees/:feeId/pay - mark as paid
router.patch('/fees/:feeId/pay', async (req, res) => {
  const { feeId } = req.params;

  const fee = await prisma.fee.findFirst({
    where: { id: feeId, student: { parent_id: req.user.id } }
  });

  if (!fee) {
    return res.status(404).json({ error: { message: 'Fee not found', code: 'NOT_FOUND' } });
  }

  const updatedFee = await prisma.fee.update({
    where: { id: feeId },
    data: { 
      status: 'PAID',
      paid_date: new Date()
    }
  });

  res.json({ fee: updatedFee });
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

// GET /parent/profile
router.get('/profile', async (req, res) => {
  const profile = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, name: true, email: true, phone: true, created_at: true }
  });
  res.json({ profile });
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
