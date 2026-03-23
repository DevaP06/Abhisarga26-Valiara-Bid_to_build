const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { getDb } = require('../db');

// Error wrapper
const catchAsync = fn => (req, res, next) => fn(req, res, next).catch(next);

// Admin check middleware
const requireAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    req.session.errorMsg = 'Access Denied. Admin only.';
    return res.redirect('/login');
  }
  next();
};

router.use(requireAdmin);

const fs = require('fs');
const uploadDir = path.join(__dirname, '../public/uploads/');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Setup multer for PDF uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname))
  }
});
const upload = multer({ storage: storage });

// GET /admin/dashboard
router.get('/dashboard', catchAsync(async (req, res) => {
  const db = await getDb();
  
  const systemControl = await db.get('SELECT * FROM system_control LIMIT 1');
  const companies = await db.all('SELECT * FROM companies ORDER BY name ASC');
  const teams = await db.all('SELECT * FROM teams ORDER BY team_name ASC');
  const bids = await db.all(`
    SELECT bids.*, teams.team_name, companies.name as company_name 
    FROM bids 
    JOIN teams ON bids.team_id = teams.id 
    JOIN companies ON bids.company_id = companies.id
    ORDER BY bids.assigned_at DESC
  `);
  
  res.render('admin_dashboard', {
    systemControl: systemControl || { current_phase: 'closed'},
    companies,
    teams,
    bids
  });
}));

// POST /admin/create-user
router.post('/create-user', catchAsync(async (req, res) => {
  const { username, password } = req.body;
  const db = await getDb();
  const bcrypt = require('bcrypt');
  
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.run('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, hash, 'team']);
    req.session.successMsg = `Team User '${username}' created successfully.`;
  } catch(err) {
    req.session.errorMsg = 'Error creating user. Username might already exist.';
  }
  res.redirect('/admin/dashboard');
}));

// POST /admin/add-company
router.post('/add-company', upload.single('pdf_doc'), catchAsync(async (req, res) => {
  const { name, description } = req.body;
  const pdf_url = req.file ? `/uploads/${req.file.filename}` : null;
  const db = await getDb();

  try {
    await db.run('INSERT INTO companies (name, description, pdf_url) VALUES ($1, $2, $3)', [name, description, pdf_url]);
    req.session.successMsg = 'Company added successfully.';
  } catch (err) {
    console.error("ADD COMPANY ERROR:", err.message);
    req.session.errorMsg = 'Error adding company. Name might already exist or DB string error.';
  }
  res.redirect('/admin/dashboard');
}));

// POST /admin/assign-bid
router.post('/assign-bid', catchAsync(async (req, res) => {
  const { team_id, company_id, bid_amount } = req.body;
  const amount = parseFloat(bid_amount);
  const db = await getDb();

  const team = await db.get('SELECT * FROM teams WHERE id = $1', [team_id]);
  const existingBid = await db.get('SELECT * FROM bids WHERE company_id = $1', [company_id]);

  if (existingBid) {
    req.session.errorMsg = 'Company already assigned to a team.';
    return res.redirect('/admin/dashboard');
  }

  if (team.purse_remaining < amount) {
    req.session.errorMsg = 'Team does not have enough purse remaining.';
    return res.redirect('/admin/dashboard');
  }

  // Deduct purse and insert bid
  await db.exec('BEGIN');
  try {
    await db.run('INSERT INTO bids (team_id, company_id, bid_amount) VALUES ($1, $2, $3)', [team_id, company_id, amount]);
    await db.run('UPDATE teams SET purse_remaining = purse_remaining - $1 WHERE id = $2', [amount, team_id]);
    await db.exec('COMMIT');
    req.session.successMsg = 'Bid assigned successfully.';
  } catch (err) {
    await db.exec('ROLLBACK');
    req.session.errorMsg = 'Error assigning bid.';
  }

  res.redirect('/admin/dashboard');
}));

// POST /admin/set-phase
router.post('/set-phase', catchAsync(async (req, res) => {
  const { phase } = req.body;
  const db = await getDb();
  
  const sys = await db.get('SELECT current_phase FROM system_control LIMIT 1');
  if (sys && sys.current_phase === 'auction' && phase === 'allocation') {
    // Rollover cash upon transition
    await db.run('UPDATE teams SET allocation_purse = allocation_purse + purse_remaining, purse_remaining = 0');
    req.session.successMsg = `Phase changed to ${phase}. Unspent bidding funds rolled over to allocation purses.`;
  } else {
    req.session.successMsg = `Phase changed to ${phase}.`;
  }

  await db.run('UPDATE system_control SET current_phase = $1', [phase]);
  res.redirect('/admin/dashboard');
}));

// POST /admin/update-default-purses
router.post('/update-default-purses', catchAsync(async (req, res) => {
  const { bidding_purse, allocation_purse } = req.body;
  const db = await getDb();
  const bp = parseFloat(bidding_purse);
  const ap = parseFloat(allocation_purse);
  
  await db.run('UPDATE system_control SET default_bidding_purse = $1, default_allocation_purse = $2', [bp, ap]);
  
  // Retroactively apply the new default to all existing teams so the Admin sees immediate reflection
  await db.run('UPDATE teams SET purse_remaining = $1, allocation_purse = $2', [bp, ap]);
  
  req.session.successMsg = 'Global default purses updated successfully and all existing teams were securely reset to these values.';
  res.redirect('/admin/dashboard');
}));

// POST /admin/update-team-purse
router.post('/update-team-purse', catchAsync(async (req, res) => {
  const { team_id, bidding_purse, allocation_purse } = req.body;
  const db = await getDb();
  await db.run('UPDATE teams SET purse_remaining = $1, allocation_purse = $2 WHERE id = $3', [parseFloat(bidding_purse), parseFloat(allocation_purse), parseInt(team_id)]);
  req.session.successMsg = 'Team purses updated successfully.';
  res.redirect('/admin/dashboard');
}));

// POST /admin/set-live-company
router.post('/set-live-company', catchAsync(async (req, res) => {
  const company_id = req.body.company_id;
  const db = await getDb();
  if (company_id === 'none') {
    await db.run('UPDATE system_control SET live_company_id = NULL');
    req.session.successMsg = 'Cleared live company broadcast.';
  } else {
    await db.run('UPDATE system_control SET live_company_id = $1', [company_id]);
    req.session.successMsg = 'Live company broadcast updated!';
  }
  res.redirect('/admin/dashboard');
}));



// POST /admin/delete-team
router.post('/delete-team', catchAsync(async (req, res) => {
  const { team_id } = req.body;
  const db = await getDb();
  await db.exec('BEGIN TRANSACTION');
  try {
    const team = await db.get('SELECT * FROM teams WHERE id = $1', [team_id]);
    if (team) {
      await db.run('DELETE FROM bids WHERE team_id = $1', [team_id]);
      await db.run('DELETE FROM allocations WHERE team_id = $1', [team_id]);
      await db.run('DELETE FROM scores WHERE team_id = $1', [team_id]);
      await db.run('DELETE FROM teams WHERE id = $1', [team_id]);
      await db.run('DELETE FROM users WHERE id = $1', [team.user_id]);
    }
    await db.exec('COMMIT');
    req.session.successMsg = 'Team deleted completely.';
  } catch (err) {
    await db.exec('ROLLBACK');
    req.session.errorMsg = 'Error deleting team.';
  }
  res.redirect('/admin/dashboard');
}));

// POST /admin/delete-company
router.post('/delete-company', catchAsync(async (req, res) => {
  const { company_id } = req.body;
  const db = await getDb();
  await db.exec('BEGIN TRANSACTION');
  try {
    const bids = await db.all('SELECT * FROM bids WHERE company_id = $1', [company_id]);
    for (let bid of bids) {
      await db.run('UPDATE teams SET purse_remaining = purse_remaining + $1 WHERE id = $2', [bid.bid_amount, bid.team_id]);
    }
    await db.run('DELETE FROM bids WHERE company_id = $1', [company_id]);
    await db.run('DELETE FROM allocations WHERE company_id = $1', [company_id]);
    await db.run('UPDATE system_control SET live_company_id = NULL WHERE live_company_id = $1', [company_id]);
    await db.run('DELETE FROM company_results WHERE company_id = $1', [company_id]);
    await db.run('DELETE FROM companies WHERE id = $1', [company_id]);
    await db.exec('COMMIT');
    req.session.successMsg = 'Company deleted successfully.';
  } catch (err) {
    await db.exec('ROLLBACK');
    req.session.errorMsg = 'Error deleting company.';
  }
  res.redirect('/admin/dashboard');
}));

// POST /admin/revoke-bid
router.post('/revoke-bid', catchAsync(async (req, res) => {
  const { bid_id } = req.body;
  const db = await getDb();
  await db.exec('BEGIN TRANSACTION');
  try {
    const bid = await db.get('SELECT * FROM bids WHERE id = $1', [bid_id]);
    if (bid) {
      await db.run('UPDATE teams SET purse_remaining = purse_remaining + $1 WHERE id = $2', [bid.bid_amount, bid.team_id]);
      await db.run('DELETE FROM allocations WHERE team_id = $1 AND company_id = $2', [bid.team_id, bid.company_id]);
      await db.run('DELETE FROM bids WHERE id = $1', [bid_id]);
    }
    await db.exec('COMMIT');
    req.session.successMsg = 'Bid revoked successfully. Funds returned to team.';
  } catch (err) {
    await db.exec('ROLLBACK');
    req.session.errorMsg = 'Error revoking bid.';
  }
  res.redirect('/admin/dashboard');
}));

module.exports = router;

