const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { PrismaClient } = require('@prisma/client');
const app = require('../index');
const { generateToken, hashPassword } = require('../utils/auth');

const prisma = new PrismaClient();

describe('Driver Student Route Management API', () => {
  let server;
  let baseUrl;
  let driverUser1;
  let driverUser2;
  let parentUser;
  let driverToken1;
  let driverToken2;
  let parentToken;
  let route1;
  let route2;
  let routeArchived;
  let routeDriver2;
  let student1;
  let student2;
  let student3;

  before(async () => {
    // Start test server on random port
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const pwdHash = await hashPassword('password123');
    const suffix = Date.now();

    // Create Driver 1
    driverUser1 = await prisma.user.create({
      data: {
        name: `Driver One ${suffix}`,
        email: `driver1_${suffix}@test.com`,
        password_hash: pwdHash,
        role: 'DRIVER',
        driver: {
          create: {
            van_number: `VAN-${suffix}`,
            license_no: `LIC-${suffix}`,
            is_on_duty: true
          }
        }
      },
      include: { driver: true }
    });
    driverToken1 = generateToken({ userId: driverUser1.id, role: driverUser1.role, roles: ['DRIVER'] });

    // Create Driver 2
    driverUser2 = await prisma.user.create({
      data: {
        name: `Driver Two ${suffix}`,
        email: `driver2_${suffix}@test.com`,
        password_hash: pwdHash,
        role: 'DRIVER',
        driver: {
          create: {
            van_number: `VAN2-${suffix}`,
            license_no: `LIC2-${suffix}`,
            is_on_duty: true
          }
        }
      },
      include: { driver: true }
    });
    driverToken2 = generateToken({ userId: driverUser2.id, role: driverUser2.role, roles: ['DRIVER'] });

    // Create Parent
    parentUser = await prisma.user.create({
      data: {
        name: `Parent User ${suffix}`,
        email: `parent_${suffix}@test.com`,
        password_hash: pwdHash,
        role: 'PARENT'
      }
    });
    parentToken = generateToken({ userId: parentUser.id, role: parentUser.role, roles: ['PARENT'] });

    // Create Routes for Driver 1
    route1 = await prisma.route.create({
      data: {
        driver_id: driverUser1.id,
        name: `Morning Route ${suffix}`,
        direction: 'HOME_TO_SCHOOL',
        status: 'SCHEDULED'
      }
    });

    route2 = await prisma.route.create({
      data: {
        driver_id: driverUser1.id,
        name: `Midday Route ${suffix}`,
        direction: 'HOME_TO_SCHOOL',
        status: 'SCHEDULED'
      }
    });

    routeArchived = await prisma.route.create({
      data: {
        driver_id: driverUser1.id,
        name: `Archived Route ${suffix}`,
        direction: 'HOME_TO_SCHOOL',
        status: 'ARCHIVED'
      }
    });

    // Create Route for Driver 2
    routeDriver2 = await prisma.route.create({
      data: {
        driver_id: driverUser2.id,
        name: `Driver 2 Route ${suffix}`,
        direction: 'HOME_TO_SCHOOL',
        status: 'SCHEDULED'
      }
    });

    // Create Students
    student1 = await prisma.student.create({
      data: {
        parent_id: parentUser.id,
        name: `Alice ${suffix}`,
        student_code: `STU1-${suffix}`,
        grade: '4',
        section: 'A',
        pickup_location: '10 Main St'
      }
    });

    student2 = await prisma.student.create({
      data: {
        parent_id: parentUser.id,
        name: `Bob ${suffix}`,
        student_code: `STU2-${suffix}`,
        grade: '5',
        section: 'B',
        pickup_location: '20 Park Ave'
      }
    });

    student3 = await prisma.student.create({
      data: {
        parent_id: parentUser.id,
        name: `Charlie ${suffix}`,
        student_code: `STU3-${suffix}`,
        grade: '6',
        section: 'C',
        pickup_location: '30 Hill Rd'
      }
    });

    // Assign student1 and student2 to Route 1
    await prisma.routeStudent.create({
      data: {
        route_id: route1.id,
        student_id: student1.id,
        monthly_fee: 15000,
        pickup_order: 1
      }
    });

    await prisma.routeStudent.create({
      data: {
        route_id: route1.id,
        student_id: student2.id,
        monthly_fee: 12000,
        pickup_order: 2
      }
    });
  });

  after(async () => {
    // Cleanup test data
    if (student1 && student2 && student3) {
      await prisma.tripCharge.deleteMany({
        where: { pickup: { student_id: { in: [student1.id, student2.id, student3.id] } } }
      });
      await prisma.pickupStatus.deleteMany({
        where: { student_id: { in: [student1.id, student2.id, student3.id] } }
      });
      await prisma.fee.deleteMany({
        where: { student_id: { in: [student1.id, student2.id, student3.id] } }
      });
      await prisma.routeStudent.deleteMany({
        where: { student_id: { in: [student1.id, student2.id, student3.id] } }
      });
      await prisma.student.deleteMany({
        where: { id: { in: [student1.id, student2.id, student3.id] } }
      });
    }

    if (driverUser1 && driverUser2) {
      await prisma.route.deleteMany({
        where: { driver_id: { in: [driverUser1.id, driverUser2.id] } }
      });
      await prisma.driver.deleteMany({
        where: { user_id: { in: [driverUser1.id, driverUser2.id] } }
      });
    }

    if (parentUser || driverUser1 || driverUser2) {
      const userIds = [parentUser?.id, driverUser1?.id, driverUser2?.id].filter(Boolean);
      await prisma.notification.deleteMany({ where: { user_id: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    await prisma.$disconnect();

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // 1. DELETE /driver/routes/:routeId/students/:studentId
  // =========================================================================
  describe('DELETE /driver/routes/:routeId/students/:studentId', () => {
    it('returns 401 if unauthenticated', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'DELETE'
      });
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'AUTH_REQUIRED');
    });

    it('returns 403 if authenticated as PARENT', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${parentToken}` }
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'FORBIDDEN');
    });

    it('returns 404 if route does not exist', async () => {
      const fakeRouteId = '00000000-0000-0000-0000-000000000000';
      const res = await fetch(`${baseUrl}/driver/routes/${fakeRouteId}/students/${student1.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${driverToken1}` }
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('returns 403 if route belongs to another driver', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${routeDriver2.id}/students/${student1.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${driverToken1}` }
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'FORBIDDEN');
    });

    it('returns 404 if student is not assigned to the route', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student3.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${driverToken1}` }
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('successfully unassigns student with no unpaid fees (no warning)', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${driverToken1}` }
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.warning, undefined);

      // Verify route_student link is removed
      const link = await prisma.routeStudent.findFirst({
        where: { route_id: route1.id, student_id: student1.id }
      });
      assert.strictEqual(link, null);

      // Verify student record still exists
      const studentStillExists = await prisma.student.findUnique({
        where: { id: student1.id }
      });
      assert.notStrictEqual(studentStillExists, null);
    });

    it('unassigns student with unpaid fees and returns warning field', async () => {
      // Create an unpaid fee with positive amount for student2
      await prisma.fee.create({
        data: {
          student_id: student2.id,
          amount: 5000,
          due_date: new Date(),
          month: 11,
          year: 2026,
          status: 'DUE'
        }
      });

      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student2.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${driverToken1}` }
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.ok(typeof body.warning === 'string' && body.warning.length > 0);

      // Verify route_student link was removed
      const link = await prisma.routeStudent.findFirst({
        where: { route_id: route1.id, student_id: student2.id }
      });
      assert.strictEqual(link, null);

      // Verify fee was NOT deleted
      const fee = await prisma.fee.findFirst({
        where: { student_id: student2.id, status: 'DUE', amount: 5000 }
      });
      assert.notStrictEqual(fee, null);
    });
  });

  // =========================================================================
  // 2. PATCH /driver/routes/:routeId/students/:studentId
  // =========================================================================
  describe('PATCH /driver/routes/:routeId/students/:studentId', () => {
    before(async () => {
      // Re-assign student1 and student2 to Route 1 for PATCH testing
      await prisma.routeStudent.create({
        data: {
          route_id: route1.id,
          student_id: student1.id,
          monthly_fee: 15000,
          pickup_order: 1
        }
      });
    });

    it('returns 401 if unauthenticated', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_fee: 16000 })
      });
      assert.strictEqual(res.status, 401);
    });

    it('returns 403 if authenticated as PARENT', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${parentToken}`
        },
        body: JSON.stringify({ monthly_fee: 16000 })
      });
      assert.strictEqual(res.status, 403);
    });

    it('returns 404 if route not found', async () => {
      const fakeRouteId = '00000000-0000-0000-0000-000000000000';
      const res = await fetch(`${baseUrl}/driver/routes/${fakeRouteId}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ monthly_fee: 16000 })
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('returns 403 if route belongs to another driver', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${routeDriver2.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ monthly_fee: 16000 })
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'FORBIDDEN');
    });

    it('returns 404 if student not on route', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student3.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ monthly_fee: 16000 })
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('returns 400 VALIDATION_ERROR if body is empty', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({})
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR if monthly_fee <= 0', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ monthly_fee: 0 })
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR if pickup_location > 255 chars', async () => {
      const longLocation = 'A'.repeat(256);
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ pickup_location: longLocation })
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    });

    it('returns 404 if new_route_id does not exist', async () => {
      const fakeRouteId = '00000000-0000-0000-0000-000000000000';
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ new_route_id: fakeRouteId })
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('returns 403 if new_route_id belongs to another driver', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ new_route_id: routeDriver2.id })
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'FORBIDDEN');
    });

    it('returns 400 VALIDATION_ERROR if new_route_id is ARCHIVED', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ new_route_id: routeArchived.id })
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    });

    it('updates monthly_fee and never modifies PAID fees', async () => {
      // Create a PAID fee for student1
      const paidFee = await prisma.fee.create({
        data: {
          student_id: student1.id,
          amount: 15000,
          due_date: new Date(),
          month: 9,
          year: 2026,
          status: 'PAID',
          paid_date: new Date()
        }
      });

      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ monthly_fee: 18000 })
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.monthly_fee, 18000);
      assert.strictEqual(body.route.id, route1.id);
      assert.strictEqual(body.student.id, student1.id);

      // Verify the PAID fee amount was NOT changed
      const verifiedPaidFee = await prisma.fee.findUnique({
        where: { id: paidFee.id }
      });
      assert.strictEqual(Number(verifiedPaidFee.amount), 15000);
      assert.strictEqual(verifiedPaidFee.status, 'PAID');
    });

    it('updates pickup_location (trimmed) on Student record', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ pickup_location: '  99 Ocean Drive  ' })
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.student.pickup_location, '99 Ocean Drive');

      // Verify in DB
      const dbStudent = await prisma.student.findUnique({ where: { id: student1.id } });
      assert.strictEqual(dbStudent.pickup_location, '99 Ocean Drive');
    });

    it('moves student to new_route_id in transaction', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route1.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({ new_route_id: route2.id })
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.route.id, route2.id);
      assert.strictEqual(body.route.name, route2.name);
      assert.strictEqual(body.student.id, student1.id);

      // Verify link on route1 is gone
      const oldLink = await prisma.routeStudent.findFirst({
        where: { route_id: route1.id, student_id: student1.id }
      });
      assert.strictEqual(oldLink, null);

      // Verify link on route2 exists
      const newLink = await prisma.routeStudent.findFirst({
        where: { route_id: route2.id, student_id: student1.id }
      });
      assert.notStrictEqual(newLink, null);
    });

    it('updates all three fields at once', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/${route2.id}/students/${student1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken1}`
        },
        body: JSON.stringify({
          monthly_fee: 22000,
          pickup_location: '55 Pine Lane',
          new_route_id: route1.id
        })
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.monthly_fee, 22000);
      assert.strictEqual(body.student.pickup_location, '55 Pine Lane');
      assert.strictEqual(body.route.id, route1.id);
    });
  });

  // =========================================================================
  // 3. GET /driver/routes/today
  // =========================================================================
  describe('GET /driver/routes/today', () => {
    it('returns monthly_fee and student details for each student', async () => {
      const res = await fetch(`${baseUrl}/driver/routes/today`, {
        headers: { Authorization: `Bearer ${driverToken1}` }
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.routes));

      // Find route1 in response
      const r1 = body.routes.find((r) => r.id === route1.id);
      assert.ok(r1, 'route1 should be in returned routes');
      assert.ok(Array.isArray(r1.students));
      assert.ok(r1.students.length > 0, 'route1 should have assigned students');

      for (const rs of r1.students) {
        assert.ok(rs.student, 'rs should contain student');
        // Student object must have: id, name, grade, section, pickup_location, pickup_status, monthly_fee
        assert.ok(rs.student.id !== undefined, 'student.id must be present');
        assert.ok(rs.student.name !== undefined, 'student.name must be present');
        assert.ok(rs.student.grade !== undefined, 'student.grade must be present');
        assert.ok(rs.student.section !== undefined, 'student.section must be present');
        assert.ok(rs.student.pickup_location !== undefined, 'student.pickup_location must be present');
        assert.ok(Array.isArray(rs.student.pickup_status), 'student.pickup_status must be an array');
        assert.ok(typeof rs.student.monthly_fee === 'number', 'student.monthly_fee must be a number');
      }
    });
  });
});
