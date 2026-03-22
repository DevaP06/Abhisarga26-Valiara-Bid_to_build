const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

const catchAsync = fn => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/team-status
router.get('/team-status', catchAsync(async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'team') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = await getDb();
  const teamId = req.session.team.id;

  const team = await db.get('SELECT purse_remaining FROM teams WHERE id = $1', [teamId]);
  const systemControl = await db.get('SELECT current_phase, live_company_id FROM system_control LIMIT 1');
  
  const ownedCompanies = await db.all(`
    SELECT companies.id, companies.name, bids.bid_amount 
    FROM bids 
    JOIN companies ON bids.company_id = companies.id 
    WHERE bids.team_id = $1
  `, [teamId]);

  res.json({
    purse: team.purse_remaining,
    phase: systemControl ? systemControl.current_phase : 'closed',
    live_company_id: systemControl ? systemControl.live_company_id : null,
    companies: ownedCompanies
  });
}));

module.exports = router;
