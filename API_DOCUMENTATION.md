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
- **Success Response (200 OK)**: Returns the parent's profile details.

#### 2. Update Parent Profile
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
- **Success Response (200 OK)**: Returns all pending and paid fees for all children belonging to the parent.

#### 8. Pay a Fee
- **Method**: `PATCH`
- **Endpoint**: `/parent/fees/:feeId/pay`
- **Parameters**: `:feeId` (Path) - The UUID of the fee.
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
    "student_code": "STU-12345"
  }
  ```

#### 7. Update Pickup Status
- **Method**: `PATCH`
- **Endpoint**: `/driver/pickup/:studentId`
- **Parameters**: `:studentId` (Path) - The UUID of the student.
- **Description**: Records or updates the student's pickup status for the current day on a specific route.
- **Body**:
  ```json
  {
    "status": "PICKED_UP", // Must be one of: "PICKED_UP", "ABSENT", "PENDING"
    "routeId": "uuid-of-the-route"
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

#### 10. Read Notification
- **Method**: `PATCH`
- **Endpoint**: `/driver/notifications/:id/read`
- **Parameters**: `:id` (Path) - The UUID of the notification.
