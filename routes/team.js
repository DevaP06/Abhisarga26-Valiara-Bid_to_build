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

  let market = [];
  let inboundTrades = [];
  let outboundTrades = [];

  if (systemControl && systemControl.current_phase === 'allocation') {
    market = await db.all(`
      SELECT bids.company_id as id, companies.name as company_name, teams.id as owner_team_id, teams.team_name as owner_team_name
      FROM bids
      JOIN companies ON bids.company_id = companies.id
      JOIN teams ON bids.team_id = teams.id
      WHERE bids.team_id != $1
      ORDER BY teams.team_name ASC
    `, [teamId]);

    inboundTrades = await db.all(`
      SELECT trades.*, 
        initiator.team_name as initiator_name,
        target_comp.name as target_company_name,
        offered_comp.name as offered_company_name
      FROM trades
      JOIN teams as initiator ON trades.initiator_team_id = initiator.id
      JOIN companies as target_comp ON trades.target_company_id = target_comp.id
      LEFT JOIN companies as offered_comp ON trades.offered_company_id = offered_comp.id
      WHERE trades.target_team_id = $1 AND trades.status = 'pending'
    `, [teamId]);

    outboundTrades = await db.all(`
      SELECT trades.*, 
        target.team_name as target_name,
        target_comp.name as target_company_name,
        offered_comp.name as offered_company_name
      FROM trades
      JOIN teams as target ON trades.target_team_id = target.id
      JOIN companies as target_comp ON trades.target_company_id = target_comp.id
      LEFT JOIN companies as offered_comp ON trades.offered_company_id = offered_comp.id
      WHERE trades.initiator_team_id = $1
    `, [teamId]);
  }

  res.render('team_dashboard', {
    team,
    ownedCompanies,
    liveCompany,
    currentPhase: systemControl ? systemControl.current_phase : 'closed',
    live_company_id: systemControl ? systemControl.live_company_id : null,
    market,
    inboundTrades,
    outboundTrades
  });
}));

// POST /team/propose-trade
router.post('/propose-trade', catchAsync(async (req, res) => {
  const { target_company_id, offered_cash, offered_company_id } = req.body;
  const teamId = req.session.team.id;
  const db = await getDb();

  const sys = await db.get('SELECT current_phase FROM system_control LIMIT 1');
  if (!sys || sys.current_phase !== 'allocation') {
    req.session.errorMsg = 'Trading is only available during the Allocation phase.';
    return res.redirect('/team/dashboard');
  }

  const cash = parseFloat(offered_cash) || 0;
  const team = await db.get('SELECT allocation_purse FROM teams WHERE id = $1', [teamId]);
  if (cash > team.allocation_purse) {
    req.session.errorMsg = 'You do not have enough funds for this offer.';
    return res.redirect('/team/dashboard');
  }

  const targetBid = await db.get('SELECT team_id FROM bids WHERE company_id = $1', [target_company_id]);
  if (!targetBid || targetBid.team_id === teamId) {
    req.session.errorMsg = 'Invalid target company.';
    return res.redirect('/team/dashboard');
  }

  const offCompId = offered_company_id ? parseInt(offered_company_id) : null;
  if (offCompId) {
    const myBid = await db.get('SELECT team_id FROM bids WHERE company_id = $1', [offCompId]);
    if (!myBid || myBid.team_id !== teamId) {
      req.session.errorMsg = 'You do not own the company you are trying to offer.';
      return res.redirect('/team/dashboard');
    }
  }

  await db.run(
    'INSERT INTO trades (initiator_team_id, target_team_id, offered_company_id, offered_cash, target_company_id) VALUES ($1, $2, $3, $4, $5)',
    [teamId, targetBid.team_id, offCompId, cash, parseInt(target_company_id)]
  );

  req.session.successMsg = 'Trade proposal sent!';
  res.redirect('/team/dashboard');
}));

// POST /team/respond-trade
router.post('/respond-trade', catchAsync(async (req, res) => {
  const { trade_id, action } = req.body;
  const teamId = req.session.team.id;
  const db = await getDb();

  const trade = await db.get('SELECT * FROM trades WHERE id = $1 AND target_team_id = $2 AND status = $3', [trade_id, teamId, 'pending']);
  if (!trade) {
    req.session.errorMsg = 'Trade request not found or already processed.';
    return res.redirect('/team/dashboard');
  }

  if (action === 'rejected') {
    await db.run('UPDATE trades SET status = $1 WHERE id = $2', ['rejected', trade_id]);
    req.session.successMsg = 'Trade rejected.';
    return res.redirect('/team/dashboard');
  }

  if (action === 'accepted') {
    // Verification
    const initBid = trade.offered_company_id ? await db.get('SELECT team_id FROM bids WHERE company_id = $1', [trade.offered_company_id]) : {team_id: trade.initiator_team_id};
    const targBid = await db.get('SELECT team_id FROM bids WHERE company_id = $1', [trade.target_company_id]);
    const initTeam = await db.get('SELECT allocation_purse FROM teams WHERE id = $1', [trade.initiator_team_id]);

    if (!targBid || targBid.team_id !== teamId || initBid.team_id !== trade.initiator_team_id || initTeam.allocation_purse < trade.offered_cash) {
      await db.run('UPDATE trades SET status = $1 WHERE id = $2', ['rejected', trade_id]); // Auto-reject due to invalid state
      req.session.errorMsg = 'This trade is no longer valid (assets or funds changed). It has been canceled.';
      return res.redirect('/team/dashboard');
    }

    try {
      await db.run('BEGIN TRANSACTION');
      
      // Swap companies
      await db.run('UPDATE bids SET team_id = $1 WHERE company_id = $2', [trade.initiator_team_id, trade.target_company_id]);
      if (trade.offered_company_id) {
        await db.run('UPDATE bids SET team_id = $1 WHERE company_id = $2', [teamId, trade.offered_company_id]);
      }
      
      // Transfer cash
      await db.run('UPDATE teams SET allocation_purse = allocation_purse - $1 WHERE id = $2', [trade.offered_cash, trade.initiator_team_id]);
      await db.run('UPDATE teams SET allocation_purse = allocation_purse + $1 WHERE id = $2', [trade.offered_cash, teamId]);
      
      await db.run('UPDATE trades SET status = $1 WHERE id = $2', ['accepted', trade_id]);
      await db.run('COMMIT');
      
      // Optional: Cancel other pending trades involving these companies
      await db.run(`UPDATE trades SET status = 'rejected' WHERE status = 'pending' AND (target_company_id IN ($1, $2) OR offered_company_id IN ($1, $2))`, [trade.target_company_id, trade.offered_company_id || -1]);

      req.session.successMsg = 'Trade accepted successfully!';
    } catch (err) {
      await db.run('ROLLBACK');
      req.session.errorMsg = 'Trade processing failed due to a system error.';
    }
  }

  res.redirect('/team/dashboard');
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

  const team = await db.get('SELECT * FROM teams WHERE id = $1', [teamId]);
  
  const ownedCompanies = await db.all(`
    SELECT companies.id, companies.name 
    FROM bids 
    JOIN companies ON bids.company_id = companies.id 
    WHERE bids.team_id = $1
  `, [teamId]);

  // See if already allocated
  const existingAllocations = await db.all('SELECT * FROM allocations WHERE team_id = $1', [teamId]);
  
  res.render('allocation', {
    team,
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

  // Check if they already allocated
  const existing = await db.get('SELECT * FROM allocations WHERE team_id = $1', [teamId]);
  if (existing) {
    req.session.errorMsg = 'You have already submitted your allocations.';
    return res.redirect('/team/allocate');
  }

  const totalPurse = await db.get('SELECT allocation_purse FROM teams WHERE id = $1', [teamId]);
  let sum = 0;
  const allocationData = [];

  for (const key in req.body) {
    if (key.startsWith('company_')) {
      const companyId = parseInt(key.replace('company_', ''));
      const amount = parseFloat(req.body[key]);
      
      if (amount < 0) {
        req.session.errorMsg = 'Negative allocations are not allowed.';
        return res.redirect('/team/allocate');
      }
      
      sum += amount;
      allocationData.push({ companyId, amount });
    }
  }

  // Float precision issue mitigation
  if (Math.abs(sum - totalPurse.allocation_purse) > 0.1) {
    req.session.errorMsg = `You must allocate exactly your remaining purse: $${totalPurse.allocation_purse.toLocaleString()}`;
    return res.redirect('/team/allocate');
  }

  // Insert allocations
  await db.exec('BEGIN');
  try {
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
