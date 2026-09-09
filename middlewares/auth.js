const { verifyToken } = require('../utils/auth');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: { message: 'Authentication required', code: 'AUTH_REQUIRED' } });
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { driver: true }
    });
    if (!user) {
      return res.status(401).json({ error: { message: 'User not found', code: 'USER_NOT_FOUND' } });
    }

    let roles = payload.roles;
    if (!Array.isArray(roles)) {
      roles = Array.from(new Set([user.role, ...(user.driver ? ['DRIVER'] : [])]));
    }

    req.user = { id: user.id, role: user.role, roles };
    next();
  } catch (error) {
    return res.status(401).json({ error: { message: 'Invalid token', code: 'INVALID_TOKEN' } });
  }
};

const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user || !Array.isArray(req.user.roles) || !req.user.roles.includes(role)) {
      return res.status(403).json({ error: { message: 'Forbidden: Insufficient role', code: 'FORBIDDEN' } });
    }
    next();
  };
};

module.exports = { requireAuth, requireRole };
