const express = require('express');
const { ensureMonthlyFees } = require('../utils/feeGenerator');
const { deleteOldFees } = require('../utils/feeCleanup');

const router = express.Router();

// GET /cron/generate-fees
// Protected by Authorization: Bearer ${process.env.CRON_SECRET}
router.get('/generate-fees', async (req, res) => {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || !authHeader || authHeader.trim() !== `Bearer ${cronSecret}`) {
    return res.status(401).json({
      error: {
        message: 'Unauthorized',
        code: 'UNAUTHORIZED'
      }
    });
  }

  const result = await ensureMonthlyFees();
  const cleanup = await deleteOldFees();
  res.json({ success: true, created: result.created, deleted: cleanup.deleted });
});

module.exports = router;
