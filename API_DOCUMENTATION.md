# N&D Smart SchoolPay API Documentation

This document provides a comprehensive overview of the N&D Smart SchoolPay backend API. It includes environment configuration, base URLs, authentication methods, and detailed endpoint descriptions with payloads.

---

## 1. Environment Configuration

To run the API locally, you must create a `.env` file in the root directory.

### Environment Variables (`.env`)

```ini
# The connection string for your PostgreSQL database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/schoolpay?schema=public"

# The secret key used to sign JSON Web Tokens (JWT)
JWT_SECRET="development_secret_key_123"

# The port the API server runs on
PORT=3000
```

---

## 2. Base URLs

- **Local Development**: `http://localhost:3000`
- **Production** (Example): `https://api.schoolpay.example.com`

---

## 3. Data Format & Authentication

- **Content-Type**: All requests and responses use `application/json`.
- **Authentication**: The API uses JWT (JSON Web Tokens). Protected routes require the token to be passed in the HTTP `Authorization` header as a Bearer token.
  - **Header Format**: `Authorization: Bearer <your_jwt_token>`

---

## 4. Error Handling Format

If an API request fails, the server responds with an appropriate HTTP status code (e.g., `400`, `401`, `404`, `500`) and a standardized JSON error object:

```json
{
  "error": {
    "message": "Human readable error message",
    "code": "ERROR_CODE_STRING",
    "details": [] // Optional array containing validation specifics
  }
}
```

---
---

## 5. API Endpoints

### A. Authentication APIs

*These endpoints do not require an Authorization header.*

#### 1. Register a Parent

- **Method**: `POST`
- **Endpoint**: `/auth/register/parent`
- **Body**:

  ```json
  {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "password": "password123", // Minimum 6 characters
    "phone": "1234567890"      // Optional
  }
  ```

- **Success Response (201 Created)**: Returns the user object and a JWT token.

#### 2. Register a Driver

- **Method**: `POST`
- **Endpoint**: `/auth/register/driver`
- **Body**:

  ```json
  {
    "name": "Alex Driver",
    "email": "alex@example.com",
    "password": "password123", // Minimum 6 characters
    "phone": "0987654321",     // Optional
    "van_number": "VAN-999",
    "license_no": "LIC-111"
  }
  ```

- **Success Response (201 Created)**: Returns the user object and a JWT token.

#### 3. Login User

- **Method**: `POST`
- **Endpoint**: `/auth/login`
- **Body**:

  ```json
  {
    "email": "jane@example.com",
    "password": "password123"
  }
  ```

- **Success Response (200 OK)**: Returns the user object (with roles) and a JWT token.

---

### B. Parent APIs

*These endpoints require an Authorization header containing a Parent's JWT token.*

#### 1. Get Parent Profile

- **Method**: `GET`
- **Endpoint**: `/parent/profile`
- **Success Response (200 OK)**: Returns the parent's profile details including `has_driver_profile: boolean`.

#### 2. Become Driver (Upgrade Account)

- **Method**: `PATCH`
- **Endpoint**: `/parent/become-driver`
- **Body**:

  ```json
  {
    "van_number": "VAN-123",
    "license_no": "LIC-456"
  }
  ```

- **Success Response (200 OK)**: Returns new JWT token with updated `roles: ["PARENT", "DRIVER"]` and user info.
- **Error Response (409 Conflict)**: If driver profile already exists for user (`code: "DRIVER_PROFILE_EXISTS"`).

#### 3. Update Parent Profile

- **Method**: `PATCH`
- **Endpoint**: `/parent/profile`
- **Body** (All fields optional):

  ```json
  {
    "name": "Jane Doe Updated",
    "phone": "1234567899"
  }
  ```

#### 3. List Children (Students)

- **Method**: `GET`
- **Endpoint**: `/parent/students`
- **Success Response (200 OK)**: Returns an array of students linked to this parent.

#### 4. Add a Child

- **Method**: `POST`
- **Endpoint**: `/parent/students`
- **Description**: Adds a new child and automatically generates a unique 5-character `student_code` (e.g., `STU-X8K9Z`) which is returned in the response.
- **Body**:

  ```json
  {
    "name": "Little Jane",
    "grade": "5",                         // Optional
    "section": "A",                       // Optional
    "school_name": "Springfield School",  // Optional
    "pickup_location": "123 Main St"      // Optional
  }
  ```

#### 5. Get Specific Child Details

- **Method**: `GET`
- **Endpoint**: `/parent/students/:id`
- **Parameters**: `:id` (The UUID of the student in the URL path).

#### 6. Get Child's Pickup Status

- **Method**: `GET`
- **Endpoint**: `/parent/students/:id/pickup-status?date=YYYY-MM-DD`
- **Parameters**:
  - `:id` (Path): The UUID of the student.
  - `date` (Query, Optional): Format `YYYY-MM-DD`. If omitted, defaults to today.

#### 7. Get All Fees

- **Method**: `GET`
- **Endpoint**: `/parent/fees`
- **Description**: Returns all pending and paid fees for all children belonging to the parent. Automatically ensures that current month fees are generated for children on active routes.
- **Success Response (200 OK)**: Returns the list of fees including:
  - `id`: Fee UUID
  - `amount`: Current calculated fee amount (capped at `monthly_fee`)
  - `due_date`: Due date (5th of next month)
  - `month`: Fee month (1-12)
  - `year`: Fee year
  - `status`: `DUE` or `PAID`
  - `paid_date`: Date payment was made
  - `trips_count`: Number of trips recorded this month
  - `trips_total`: 40 (maximum monthly billable trips)
  - `per_trip_amount`: Calculated fee per trip (`monthly_fee / 40` rounded to 2 decimals)
  - `student`: `{ name, student_code }`

#### 8. Pay a Fee

- **Method**: `PATCH`
- **Endpoint**: `/parent/fees/:feeId/pay`
- **Parameters**: `:feeId` (Path) - The UUID of the fee.
- **Description**: Pays the fee and automatically creates:
  1. A payment success notification for the parent (`"Payment Successful"`).
  2. A notification for the driver who owns the student's active route (`"Fee Paid by Parent"`, body: `"{parent name} paid {month}/{year} fee for {student name}."`). If the student has no active route/driver, this notification is skipped silently without failing the payment.
- **Success Response (200 OK)**: Marks the fee status as `PAID`.

#### 9. Get Parent Notifications

- **Method**: `GET`
- **Endpoint**: `/parent/notifications`

#### 10. Read Notification

- **Method**: `PATCH`
- **Endpoint**: `/parent/notifications/:id/read`
- **Parameters**: `:id` (Path) - The UUID of the notification.

---

### C. Driver APIs

*These endpoints require an Authorization header containing a Driver's JWT token.*

#### 1. Get Driver Profile

- **Method**: `GET`
- **Endpoint**: `/driver/profile`
- **Success Response (200 OK)**: Returns the driver's profile details.

#### 2. Update Driver Profile

- **Method**: `PATCH`
- **Endpoint**: `/driver/profile`
- **Body** (All fields optional):

  ```json
  {
    "name": "Alex Driver",
    "phone": "0987654321",
    "van_number": "VAN-999",
    "license_no": "LIC-111"
  }
  ```

#### 3. Toggle Duty Status

- **Method**: `PATCH`
- **Endpoint**: `/driver/status`
- **Body**:

  ```json
  {
    "is_on_duty": true
  }
  ```

#### 4. Create Route

- **Method**: `POST`
- **Endpoint**: `/driver/routes`
- **Body**:

  ```json
  {
    "name": "Evening Dropoff",
    "start_time": "14:30", // Optional
    "end_time": "16:00"    // Optional
  }
  ```

#### 5. Get Today's Routes

- **Method**: `GET`
- **Endpoint**: `/driver/routes/today`
- **Success Response (200 OK)**: Retrieves all routes assigned to the driver, including the list of students in each route and their pickup status for today.

#### 6. Add Student to Route (Via Student Code)

- **Method**: `POST`
- **Endpoint**: `/driver/routes/:routeId/students`
- **Parameters**: `:routeId` (Path) - The UUID of the route.
- **Description**: Allows a driver to add a student to their route by providing the unique code given to them by the parent.
- **Body**:

  ```json
  {
    "student_code": "STU-12345",
    "monthly_fee": 150.00
  }
  ```

#### 7. Update Pickup Status

- **Method**: `PATCH`
- **Endpoint**: `/driver/pickup/:studentId`
- **Parameters**: `:studentId` (Path) - The UUID of the student.
- **Description**: Records or updates the student's pickup status for today on a specific route within a single transaction using the per-trip fee engine.
  - Allowed statuses: `PENDING`, `PICKED_UP`, `DROPPED`, `ABSENT`.
  - Transition rule: `DROPPED` is only allowed when current status is `PICKED_UP` (or already `DROPPED`). Attempting `DROPPED` from `PENDING` or `ABSENT` returns `409 Conflict` with code `PICKUP_REQUIRED`.
  - Charges:
    - Moving to `PICKED_UP` adds 1 `PICKUP` charge (`round(monthly_fee / 40, 2)`).
    - Moving to `DROPPED` adds 1 `DROP` charge (`round(monthly_fee / 40, 2)`).
    - Moving from `DROPPED` back to `PICKED_UP` deletes the `DROP` charge.
    - Moving to `PENDING` or `ABSENT` deletes both charges for that day.
    - Fee amount = `MIN(SUM(trip_charges), monthly_fee)`, `trips_count = COUNT(trip_charges)`.
    - Maximum 40 charges per monthly fee (subsequent charges silently skipped).
    - A `PAID` fee is locked (status and notifications still apply, but no charges are added/removed).
  - Notifications: Automatically created for parent only when status changes:
    - `PICKED_UP`: `"Child Picked Up"`, body `"{student} was picked up from {location} at {h:mm A}."`
    - `DROPPED`: `"Child Dropped Off"`, body `"{student} was dropped off at {location} at {h:mm A}."`
    - `ABSENT`: `"Marked Absent"`, body `"{student} was marked absent today ({DD MMM YYYY})."`
  - Repeating the same status is a no-op (no extra charge, no duplicate notification).
- **Body**:

  ```json
  {
    "status": "PICKED_UP", // Must be one of: "PICKED_UP", "DROPPED", "ABSENT", "PENDING"
    "routeId": "uuid-of-the-route"
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "pickup": { "id": "...", "status": "PICKED_UP", "pickup_method": "MANUAL", ... },
    "fee": { "id": "...", "amount": 375, "trips_count": 1, "trips_total": 40, "status": "DUE" },
    "charge": { "kind": "PICKUP", "amount": 375 }
  }
  ```

#### 8. Remove Student from Route

- **Method**: `DELETE`
- **Endpoint**: `/driver/routes/:routeId/students/:studentId`
- **Parameters**:
  - `:routeId` (Path) - The UUID of the route.
  - `:studentId` (Path) - The UUID of the student.

#### 9. Get Driver Notifications

- **Method**: `GET`
- **Endpoint**: `/driver/notifications`

#### 10. Read Driver Notification

- **Method**: `PATCH`
- **Endpoint**: `/driver/notifications/:id/read`
- **Parameters**: `:id` (Path) - The UUID of the notification.

#### 11. Get Pickup History

- **Method**: `GET`
- **Endpoint**: `/driver/history?date=YYYY-MM-DD&route_id=&page=&limit=`
- **Description**: Returns paginated pickup history for all routes belonging to the authenticated driver. Supports optional date and route filtering.
- **Query Parameters**:
  - `date` (Query, Optional): Format `YYYY-MM-DD`. Filters records by pickup date.
  - `route_id` (Query, Optional): UUID of the route.
  - `page` (Query, Optional): Page number (defaults to `1`).
  - `limit` (Query, Optional): Number of items per page (defaults to `50`, max `200`).
- **Success Response (200 OK)**:

  ```json
  {
    "history": [
      {
        "id": "c1f7b845-82f2-47f4-aa91-9ca04e5030c8",
        "date": "2026-09-25T00:00:00.000Z",
        "status": "PICKED_UP",
        "pickup_method": "MANUAL",
        "updated_at": "2026-09-25T08:30:00.000Z",
        "student": {
          "id": "e5b8c3d2-a1f4-4b8c-9d3e-1f2a3b4c5d6e",
          "name": "Little Jane",
          "grade": "1",
          "section": "A",
          "pickup_location": "123 Main St"
        },
        "route": {
          "id": "d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a",
          "name": "Evening Dropoff"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 1
    }
  }
  ```

#### 12. Get Student Fee Payment Status

- **Method**: `GET`
- **Endpoint**: `/driver/students/:studentId/fees`
- **Parameters**: `:studentId` (Path) - The UUID of the student.
- **Description**: Returns all fee records for a specific student. The driver
  must own a route the student is assigned to; otherwise `404` is returned.
  This prevents drivers from viewing fee data for students outside their routes.
- **Error Responses**:
  - `400 Bad Request`: If `:studentId` is not a valid UUID (zod validation).
  - `404 Not Found`: If the student is not assigned to any of the driver's routes
    (`code: "NOT_FOUND"`).
- **Success Response (200 OK)**:

  ```json
  {
    "fees": [
      {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "amount": "150.00",
        "due_date": "2026-09-05T00:00:00.000Z",
        "month": 9,
        "year": 2026,
        "status": "PAID",
        "paid_date": "2026-08-28T10:00:00.000Z",
        "trips_count": 40,
        "trips_total": 40,
        "per_trip_amount": 3.75
      }
    ]
  }
  ```

#### 13. Pay Student Fee (Collect Payment)

- **Method**: `PATCH`
- **Endpoint**: `/driver/students/:studentId/fees/:feeId/pay`
- **Parameters**:
  - `:studentId` (Path) - The UUID of the student.
  - `:feeId` (Path) - The UUID of the fee.
- **Description**: Marks the fee as paid when collected by the driver and automatically creates a payment success notification for the student's parent. The driver must own a route the student is assigned to.
- **Error Responses**:
  - `400 Bad Request`: If `:studentId` or `:feeId` is not a valid UUID.
  - `404 Not Found`: If student is not on driver's route, or fee does not exist.
  - `409 Conflict`: If the fee is already paid.
- **Success Response (200 OK)**: Returns the updated fee marked as `PAID`.

#### 14. Remind Parents of Due Transport Fees

- **Method**: `POST`
- **Endpoint**: `/driver/fees/remind`
- **Description**: For each student assigned to this driver's non-COMPLETED routes that has a `DUE` fee for the specified month/year with `amount > 0`, creates a notification for the student's parent:
  - Title: `"Transport Fee Reminder"`
  - Body: `"{student}'s transport fee for {MonthName} {year} is Rs. {amount} ({trips_count} trips). Please pay your driver."`
  - Deduplication: Skips if the same user, title, and body was already created today in Sri Lanka time.
- **Request Body (JSON, Optional)**:
  ```json
  {
    "month": 10,  // Optional: integer 1-12. Defaults to current SL month.
    "year": 2026   // Optional: integer. Defaults to current SL year.
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "sent": 3,
    "skipped": 1
  }
  ```

---

## 8. Admin Endpoints

All admin endpoints require an authenticated user with the `ADMIN` role (`Authorization: Bearer <admin_token>`).

#### 1. Generate Monthly Fees

- **Method**: `POST`
- **Endpoint**: `/admin/fees/generate`
- **Description**: Generates monthly fee records for all students assigned to active (non-completed) routes. Safe to invoke repeatedly (idempotent, skips existing fees for the specified student, month, and year).
- **Request Body (JSON, Optional)**:
  ```json
  {
    "month": 10,  // Optional: integer 1-12. Defaults to current month.
    "year": 2026   // Optional: integer (e.g., 2026). Defaults to current year.
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: If month or year is out of valid range.
  - `401 Unauthorized`: If unauthenticated.
  - `403 Forbidden`: If user role is not `ADMIN`.
- **Success Response (200 OK)**:
  ```json
  {
    "created": 5
  }
  ```

#### 2. Get Pickups List

- **Method**: `GET`
- **Endpoint**: `/admin/pickups?date=YYYY-MM-DD&route_id=&student_id=&status=&page=&limit=`
- **Description**: List pickup records with optional filters.
- **Query Parameters**:
  - `status`: Optional enum (`PENDING`, `PICKED_UP`, `DROPPED`, `ABSENT`).

#### 3. Mark Pickup Status (Admin Override)

- **Method**: `PATCH`
- **Endpoint**: `/admin/pickups/:id/mark`
- **Description**: Admin manual override for pickup status.
- **Body**:
  ```json
  {
    "status": "DROPPED", // "PICKED_UP" | "DROPPED" | "ABSENT" | "PENDING"
    "force": false
  }
  ```

#### 4. Ticket-Based Pickup

- **Method**: `POST`
- **Endpoint**: `/admin/pickups/ticket`
- **Description**: Mark a student as `PICKED_UP` using student code and route ID.
- **Body**:
  ```json
  {
    "student_code": "STU-12345",
    "route_id": "uuid"
  }
  ```
- **Success Response**: `200 OK` if already pending and updated, `201 Created` if new row created.

---

## 9. Cron Endpoints

#### 1. Scheduled Monthly Fee Generation

- **Method**: `GET`
- **Endpoint**: `/cron/generate-fees`
- **Description**: Intended for automated execution (e.g. Vercel Cron on the 1st of every month at midnight `0 0 1 * *`). Generates monthly fee records for all active students for the current month and year.
- **Authentication**: Protected by a static bearer token matching the server's `CRON_SECRET` environment variable:
  - Header: `Authorization: Bearer <CRON_SECRET>`
- **Error Responses**:
  - `401 Unauthorized`: If `CRON_SECRET` is missing, or header does not match `Bearer <CRON_SECRET>`.
- **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "created": 5
  }
  ```

