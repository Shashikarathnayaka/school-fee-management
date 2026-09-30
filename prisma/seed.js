const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash('password123', salt);

  // 0. Create an Admin
  const adminPassword = 'Admin@123';
  const adminSalt = await bcrypt.genSalt(10);
  const adminPasswordHash = await bcrypt.hash(adminPassword, adminSalt);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@test.com' },
    update: {},
    create: {
      name: 'Admin User',
      email: 'admin@test.com',
      password_hash: adminPasswordHash,
      role: 'ADMIN',
    },
  });

  console.log('Created admin:', admin.email, '| password:', adminPassword);

  // 1. Create a Parent
  const parent = await prisma.user.upsert({
    where: { email: 'parent@example.com' },
    update: {},
    create: {
      name: 'John Doe (Parent)',
      email: 'parent@example.com',
      phone: '1234567890',
      password_hash: passwordHash,
      role: 'PARENT',
    },
  });

  console.log('Created parent:', parent.email);

  // 2. Create a Driver
  const driverUser = await prisma.user.upsert({
    where: { email: 'driver@example.com' },
    update: {},
    create: {
      name: 'Bob Smith (Driver)',
      email: 'driver@example.com',
      phone: '0987654321',
      password_hash: passwordHash,
      role: 'DRIVER',
      driver: {
        create: {
          van_number: 'VAN-1234',
          license_no: 'LIC-987654321'
        }
      }
    },
  });

  console.log('Created driver:', driverUser.email);

  // 3. Create Students for Parent
  const student1 = await prisma.student.upsert({
    where: { student_code: 'STU-12345' },
    update: {},
    create: {
      student_code: 'STU-12345',
      name: 'Alice Doe',
      grade: '5',
      section: 'A',
      school_name: 'Springfield Elementary',
      parent_id: parent.id
    }
  });

  const student2 = await prisma.student.upsert({
    where: { student_code: 'STU-67890' },
    update: {},
    create: {
      student_code: 'STU-67890',
      name: 'Tommy Doe',
      grade: '3',
      section: 'B',
      school_name: 'Springfield Elementary',
      parent_id: parent.id
    }
  });

  console.log('Created students:', student1.student_code, student2.student_code);

  // 4. Create a Route for Driver
  const route = await prisma.route.create({
    data: {
      name: 'Morning Pickup (North Side)',
      driver_id: driverUser.id,
      start_time: '06:30',
      end_time: '08:00',
      status: 'SCHEDULED'
    }
  });

  console.log('Created route:', route.name);

  // 5. Add Students to Route
  await prisma.routeStudent.create({
    data: {
      route_id: route.id,
      student_id: student1.id,
      pickup_order: 1,
      scheduled_time: '06:45',
      monthly_fee: 150.00
    }
  });

  await prisma.routeStudent.create({
    data: {
      route_id: route.id,
      student_id: student2.id,
      pickup_order: 2,
      scheduled_time: '07:00',
      monthly_fee: 150.00
    }
  });

  console.log('Added students to route');

  // 6. Add Fees for Parent
  const nextMonthDate = new Date();
  nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
  nextMonthDate.setDate(5);
  const nextMonth = nextMonthDate.getMonth() + 1;
  const nextYear = nextMonthDate.getFullYear();

  await prisma.fee.create({
    data: {
      student_id: student1.id,
      amount: 150.00,
      due_date: nextMonthDate,
      month: nextMonth,
      year: nextYear,
      status: 'DUE'
    }
  });

  await prisma.fee.create({
    data: {
      student_id: student2.id,
      amount: 150.00,
      due_date: nextMonthDate,
      month: nextMonth,
      year: nextYear,
      status: 'DUE'
    }
  });

  console.log('Created fees');

  console.log('Seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
