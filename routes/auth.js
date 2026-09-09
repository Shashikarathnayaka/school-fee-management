const express = require('express');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');
const { hashPassword, comparePassword, generateToken } = require('../utils/auth');

const router = express.Router();
const prisma = new PrismaClient();

const parentRegisterSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(6),
});

const driverRegisterSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(6),
  van_number: z.string().min(2),
  license_no: z.string().min(2),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

router.post('/register/parent', async (req, res) => {
  const { name, email, phone, password } = parentRegisterSchema.parse(req.body);

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return res.status(409).json({ error: { message: 'Email already in use', code: 'EMAIL_IN_USE' } });
  }

  const password_hash = await hashPassword(password);
  
  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      password_hash,
      role: 'PARENT'
    }
  });

  const roles = ['PARENT'];
  const token = generateToken({ userId: user.id, roles, role: user.role });
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, roles } });
});

router.post('/register/driver', async (req, res) => {
  const { name, email, phone, password, van_number, license_no } = driverRegisterSchema.parse(req.body);

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return res.status(409).json({ error: { message: 'Email already in use', code: 'EMAIL_IN_USE' } });
  }

  const password_hash = await hashPassword(password);
  
  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      password_hash,
      role: 'DRIVER',
      driver: {
        create: {
          van_number,
          license_no
        }
      }
    },
    include: {
      driver: true
    }
  });

  const roles = ['DRIVER'];
  const token = generateToken({ userId: user.id, roles, role: user.role });
  res.status(201).json({ 
    token, 
    user: { 
      id: user.id, 
      name: user.name, 
      email: user.email, 
      role: user.role,
      roles,
      driver: user.driver
    } 
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email }, include: { driver: true } });
  if (!user) {
    return res.status(401).json({ error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } });
  }

  const isValidPassword = await comparePassword(password, user.password_hash);
  if (!isValidPassword) {
    return res.status(401).json({ error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } });
  }

  const roles = Array.from(new Set([user.role, ...(user.driver ? ['DRIVER'] : [])]));
  const token = generateToken({ userId: user.id, roles, role: user.role });
  res.status(200).json({ 
    token, 
    user: { 
      id: user.id, 
      name: user.name, 
      email: user.email, 
      role: user.role,
      roles,
      driver: user.driver || undefined
    } 
  });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  console.log(`[STUB] Forgot password requested for ${email}. Pretend we sent an email with a reset token.`);
  res.status(200).json({ message: 'If an account exists, a reset link has been sent.' });
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = z.object({ token: z.string(), newPassword: z.string().min(6) }).parse(req.body);
  console.log(`[STUB] Reset password requested with token ${token}. Pretend we reset the password.`);
  res.status(200).json({ message: 'Password has been reset successfully.' });
});

module.exports = router;
