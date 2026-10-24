const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { PrismaClient } = require('@prisma/client');
const app = require('../index');
const { generateToken, hashPassword } = require('../utils/auth');

const prisma = new PrismaClient();

describe('Driver Student Route Management Fixes', () => {
  let server;
  let baseUrl;
  let driverUser;
  let driverToken;
  let parentUser;
  let routeHomeToSchool;
  let routeSchoolToHome; // Twin of routeHomeToSchool
  let routeArchived;
  let student1;
  let student2;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const pwdHash = await hashPassword('password123');
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    driverUser = await prisma.user.create({
      data: {
        name: `Driver Twin ${suffix}`,
        email: `driver_twin_${suffix}@test.com`,
        password_hash: pwdHash,
        role: 'DRIVER',
        driver: {
          create: {
            van_number: `VAN-T-${suffix}`,
            license_no: `LIC-T-${suffix}`,
            is_on_duty: true
          }
        }
      },
      include: { driver: true }
    });
    driverToken = generateToken({ userId: driverUser.id, role: driverUser.role, roles: ['DRIVER'] });

    parentUser = await prisma.user.create({
      data: {
        name: `Parent Twin ${suffix}`,
        email: `parent_twin_${suffix}@test.com`,
        password_hash: pwdHash,
        role: 'PARENT'
      }
    });

    const routeName = `Twin Route ${suffix}`;

    routeHomeToSchool = await prisma.route.create({
      data: {
        driver_id: driverUser.id,
        name: routeName,
        direction: 'HOME_TO_SCHOOL',
        status: 'SCHEDULED'
      }
    });

    routeSchoolToHome = await prisma.route.create({
      data: {
        driver_id: driverUser.id,
        name: routeName,
        direction: 'SCHOOL_TO_HOME',
        status: 'SCHEDULED'
      }
    });

    routeArchived = await prisma.route.create({
      data: {
        driver_id: driverUser.id,
        name: `Archived Route ${suffix}`,
        direction: 'HOME_TO_SCHOOL',
        status: 'ARCHIVED'
      }
    });

    student1 = await prisma.student.create({
      data: {
        parent_id: parentUser.id,
        name: `Twin Student 1 ${suffix}`,
        student_code: `STU-TW1-${suffix}`,
        grade: '4',
        section: 'A',
        pickup_location: '10 Twin St'
      }
    });

    student2 = await prisma.student.create({
      data: {
        parent_id: parentUser.id,
        name: `Twin Student 2 ${suffix}`,
        student_code: `STU-TW2-${suffix}`,
        grade: '5',
        section: 'B',
        pickup_location: '20 Twin Ave'
      }
    });

    // Assign student1 to both routeHomeToSchool and twin routeSchoolToHome
    await prisma.routeStudent.create({
      data: {
        route_id: routeHomeToSchool.id,
        student_id: student1.id,
        monthly_fee: 10000,
        pickup_order: 1
      }
    });

    await prisma.routeStudent.create({
      data: {
        route_id: routeSchoolToHome.id,
        student_id: student1.id,
        monthly_fee: 10000,
        pickup_order: 1
      }
    });

    // Assign student2 to routeArchived
    await prisma.routeStudent.create({
      data: {
        route_id: routeArchived.id,
        student_id: student2.id,
        monthly_fee: 12000,
        pickup_order: 1
      }
    });
  });

  after(async () => {
    if (student1 && student2) {
      await prisma.tripCharge.deleteMany({
        where: { pickup: { student_id: { in: [student1.id, student2.id] } } }
      });
      await prisma.pickupStatus.deleteMany({
        where: { student_id: { in: [student1.id, student2.id] } }
      });
      await prisma.fee.deleteMany({
        where: { student_id: { in: [student1.id, student2.id] } }
      });
      await prisma.routeStudent.deleteMany({
        where: { student_id: { in: [student1.id, student2.id] } }
      });
      await prisma.student.deleteMany({
        where: { id: { in: [student1.id, student2.id] } }
      });
    }

    if (driverUser) {
      await prisma.route.deleteMany({
        where: { driver_id: driverUser.id }
      });
      await prisma.driver.deleteMany({
        where: { user_id: driverUser.id }
      });
    }

    if (parentUser || driverUser) {
      const userIds = [parentUser?.id, driverUser?.id].filter(Boolean);
      await prisma.notification.deleteMany({ where: { user_id: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    await prisma.$disconnect();

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('DELETE /driver/routes/:routeId/students/:studentId', () => {
    it('returns 400 when attempting to delete student on an ARCHIVED route', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${routeArchived.id}/students/${student2.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${driverToken}` }
      });

      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.deepStrictEqual(body, {
        error: {
          message: 'Cannot modify students of a completed or archived route',
          code: 'VALIDATION_ERROR'
        }
      });

      // Verify the student assignment still exists
      const remainingAssignment = await prisma.routeStudent.findFirst({
        where: { route_id: routeArchived.id, student_id: student2.id }
      });
      assert.ok(remainingAssignment);
    });

    it('removes the student from both the route and its twin', async () => {
      // Prior to delete, verify student1 is in both routes
      const beforeHome = await prisma.routeStudent.findFirst({
        where: { route_id: routeHomeToSchool.id, student_id: student1.id }
      });
      const beforeSchool = await prisma.routeStudent.findFirst({
        where: { route_id: routeSchoolToHome.id, student_id: student1.id }
      });
      assert.ok(beforeHome);
      assert.ok(beforeSchool);

      const res = await fetch(`${baseUrl}/driver/routes/${routeHomeToSchool.id}/students/${student1.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${driverToken}` }
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);

      // Verify student1 removed from routeHomeToSchool
      const afterHome = await prisma.routeStudent.findFirst({
        where: { route_id: routeHomeToSchool.id, student_id: student1.id }
      });
      assert.strictEqual(afterHome, null);

      // Verify student1 removed from twin routeSchoolToHome
      const afterSchool = await prisma.routeStudent.findFirst({
        where: { route_id: routeSchoolToHome.id, student_id: student1.id }
      });
      assert.strictEqual(afterSchool, null);
    });
  });

  describe('PATCH /driver/routes/:routeId/students/:studentId', () => {
    before(async () => {
      // Re-assign student1 to routeHomeToSchool and twin routeSchoolToHome for PATCH tests
      await prisma.routeStudent.create({
        data: {
          route_id: routeHomeToSchool.id,
          student_id: student1.id,
          monthly_fee: 10000,
          pickup_order: 1
        }
      });
      await prisma.routeStudent.create({
        data: {
          route_id: routeSchoolToHome.id,
          student_id: student1.id,
          monthly_fee: 10000,
          pickup_order: 1
        }
      });
    });

    it('returns 400 when attempting to patch student on an ARCHIVED route', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${routeArchived.id}/students/${student2.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${driverToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ monthly_fee: 14000 })
      });

      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.deepStrictEqual(body, {
        error: {
          message: 'Cannot modify students of a completed or archived route',
          code: 'VALIDATION_ERROR'
        }
      });
    });

    it('returns 409 when new_route_id points to the twin route and leaves both RouteStudent rows intact', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${routeHomeToSchool.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${driverToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ new_route_id: routeSchoolToHome.id })
      });

      assert.strictEqual(res.status, 409);
      const body = await res.json();
      assert.deepStrictEqual(body, {
        error: {
          message: 'Cannot move a student to the twin of the same route',
          code: 'CONFLICT'
        }
      });

      // Verify both assignments remain intact
      const homeAssoc = await prisma.routeStudent.findFirst({
        where: { route_id: routeHomeToSchool.id, student_id: student1.id }
      });
      const schoolAssoc = await prisma.routeStudent.findFirst({
        where: { route_id: routeSchoolToHome.id, student_id: student1.id }
      });
      assert.ok(homeAssoc);
      assert.ok(schoolAssoc);
    });

    it('updates monthly_fee on the route student and its twin', async () => {
      const newMonthlyFee = 16500;
      const res = await fetch(`${baseUrl}/driver/routes/${routeHomeToSchool.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${driverToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ monthly_fee: newMonthlyFee })
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.monthly_fee, newMonthlyFee);

      // Verify DB updates on both routes
      const homeAssoc = await prisma.routeStudent.findFirst({
        where: { route_id: routeHomeToSchool.id, student_id: student1.id }
      });
      const schoolAssoc = await prisma.routeStudent.findFirst({
        where: { route_id: routeSchoolToHome.id, student_id: student1.id }
      });
      assert.strictEqual(Number(homeAssoc.monthly_fee), newMonthlyFee);
      assert.strictEqual(Number(schoolAssoc.monthly_fee), newMonthlyFee);
    });
  });
});
