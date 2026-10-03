const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);
  
  if (err instanceof require('zod').ZodError) {
    return res.status(400).json({
      error: {
        message: 'Validation Error',
        code: 'VALIDATION_ERROR',
        details: err.errors
      }
    });
  }

  // Handle unique constraint violations from Prisma
  if (err.code === 'P2002') {
    return res.status(409).json({
      error: {
        message: 'Unique constraint failed',
        code: 'UNIQUE_CONSTRAINT_FAILED',
        target: err.meta?.target
      }
    });
  }

  // Handle record not found from Prisma
  if (err.code === 'P2025') {
    return res.status(404).json({
      error: {
        message: 'Record not found',
        code: 'NOT_FOUND'
      }
    });
  }

  // Handle custom HTTP errors (e.g. HttpError)
  if (err.statusCode || err.status) {
    return res.status(err.statusCode || err.status).json({
      error: {
        message: err.message,
        code: err.code || 'ERROR'
      }
    });
  }

  res.status(500).json({
    error: {
      message: err.message || 'Internal Server Error',
      code: 'INTERNAL_SERVER_ERROR'
    }
  });
};

module.exports = errorHandler;
