const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

const catchAsync = fn => (req, res, next) => fn(req, res, next).catch(next);

const requireTeam = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'team') {
    req.session.errorMsg = 'Access Denied. Team only.';
    return res.redirect('/login');
  }
  next();
};

router.use(requireTeam);

// GET /team/dashboard
router.get('/dashboard', catchAsync(async (req, res) => {
  const db = await getDb();
  const teamId = req.session.team.id;
  
  // Refresh team data
  const team = await db.get('SELECT * FROM teams WHERE id = $1', [teamId]);
  req.session.team.purse = team.purse_remaining; // Update session just in case
  
  const systemControl = await db.get('SELECT * FROM system_control LIMIT 1');
  let liveCompany = null;
  if (systemControl && systemControl.live_company_id) {
    liveCompany = await db.get('SELECT * FROM companies WHERE id = $1', [systemControl.live_company_id]);
  }
  
  // Get owned companies
  const ownedCompanies = await db.all(`
    SELECT companies.*, bids.bid_amount, bids.assigned_at 
    FROM bids 
    JOIN companies ON bids.company_id = companies.id 
    WHERE bids.team_id = $1
    ORDER BY bids.assigned_at DESC
  `, [teamId]);

  res.render('team_dashboard', {
    team,
    ownedCompanies,
    liveCompany,
    currentPhase: systemControl ? systemControl.current_phase : 'closed',
    live_company_id: systemControl ? systemControl.live_company_id : null
  });
}));

// GET /team/companies
router.get('/companies', catchAsync(async (req, res) => {
  const db = await getDb();
  const companies = await db.all('SELECT * FROM companies ORDER BY name ASC');
  // Check which are already bought
  const bids = await db.all('SELECT company_id, team_id FROM bids');
  
  // Map companies to add 'status'
  const enhancedCompanies = companies.map(c => {
    const bid = bids.find(b => b.company_id === c.id);
    if (!bid) c.status = 'Available';
    else if (bid.team_id === req.session.team.id) c.status = 'Owned by You';
    else c.status = 'Sold';
    return c;
  });

  res.render('companies', {
    companies: enhancedCompanies
  });
}));

// GET /team/allocate
router.get('/allocate', catchAsync(async (req, res) => {
  const db = await getDb();
  const teamId = req.session.team.id;
  
  const systemControl = await db.get('SELECT * FROM system_control LIMIT 1');
  if (!systemControl || systemControl.current_phase !== 'allocation') {
    req.session.errorMsg = 'Allocation phase is not active right now.';
    return res.redirect('/team/dashboard');
  }
  
  const ownedCompanies = await db.all(`
    SELECT companies.id, companies.name 
    FROM bids 
    JOIN companies ON bids.company_id = companies.id 
    WHERE bids.team_id = $1
  `, [teamId]);

  // See if already allocated
  const existingAllocations = await db.all('SELECT * FROM allocations WHERE team_id = $1', [teamId]);
  
  res.render('allocation', {
    ownedCompanies,
    hasAllocated: existingAllocations.length > 0
  });
}));

// POST /team/allocate
router.post('/allocate', catchAsync(async (req, res) => {
  const db = await getDb();
  const teamId = req.session.team.id;

  const systemControl = await db.get('SELECT * FROM system_control LIMIT 1');
  if (!systemControl || systemControl.current_phase !== 'allocation') {
    req.session.errorMsg = 'Allocation phase is not active.';
    return res.redirect('/team/dashboard');
  }

  // Example body: { 'company_1': '50000', 'company_3': '50000' }
  const totalPurse = await db.get('SELECT purse_remaining FROM teams WHERE id = $1', [teamId]);
  let sum = 0;
  const allocationData = [];

  for (const key in req.body) {
    if (key.startsWith('company_')) {
      const companyId = parseInt(key.replace('company_', ''));
      const amount = parseFloat(req.body[key]);
      
      if (isNaN(amount) || !isFinite(amount) || amount < 0) {
        req.session.errorMsg = 'Invalid allocation amount detected.';
        return res.redirect('/team/allocate');
      }
      
      sum += amount;
      allocationData.push({ companyId, amount });
    }
  }

  // Float precision issue mitigation
  if (Math.abs(sum - totalPurse.purse_remaining) > 0.1) {
    req.session.errorMsg = `You must allocate exactly your remaining purse: $${totalPurse.purse_remaining.toLocaleString()}`;
    return res.redirect('/team/allocate');
  }

  // Use a transaction and row locking to prevent race conditions (double spend)
  await db.exec('BEGIN');
  try {
    // Lock the team row so concurrent requests from the same team queue up here
    await db.get('SELECT id FROM teams WHERE id = $1 FOR UPDATE', [teamId]);

    // Check if they already allocated (inside the lock)
    const existing = await db.get('SELECT * FROM allocations WHERE team_id = $1', [teamId]);
    if (existing) {
      throw new Error('You have already submitted your allocations.');
    }

    for (let alloc of allocationData) {
      // Validate they actually own this company
      const checkOwns = await db.get('SELECT * FROM bids WHERE team_id = $1 AND company_id = $2', [teamId, alloc.companyId]);
      if (!checkOwns) throw new Error('You do not own this company.');

      await db.run('INSERT INTO allocations (team_id, company_id, allocated_amount) VALUES ($1, $2, $3)', 
        [teamId, alloc.companyId, alloc.amount]);
    }
    await db.exec('COMMIT');
    req.session.successMsg = 'Allocations submitted successfully!';
  } catch (err) {
    await db.exec('ROLLBACK');
    req.session.errorMsg = err.message || 'Error saving allocations.';
  }

  res.redirect('/team/dashboard');
}));

module.exports = router;
