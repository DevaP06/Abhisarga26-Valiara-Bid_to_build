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

// Setup multer for PDF uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../public/uploads/'))
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
    req.session.errorMsg = 'Error adding company. Name might already exist.';
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
  await db.run('UPDATE system_control SET current_phase = $1', [phase]);
  req.session.successMsg = `Phase changed to ${phase}.`;
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

// POST /admin/add-results
router.post('/add-results', catchAsync(async (req, res) => {
  const { company_id, stock_price, revenue, yoy_growth, ebitda, market_cap, market_share } = req.body;
  const db = await getDb();
  
  try {
    await db.run(`INSERT INTO company_results 
      (company_id, stock_price, revenue, yoy_growth, ebitda, market_cap, market_share) 
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(company_id) DO UPDATE SET 
      stock_price=excluded.stock_price, revenue=excluded.revenue, yoy_growth=excluded.yoy_growth, 
      ebitda=excluded.ebitda, market_cap=excluded.market_cap, market_share=excluded.market_share`,
      [company_id, stock_price, revenue, yoy_growth, ebitda, market_cap, market_share]
    );
    req.session.successMsg = 'Company results updated successfully.';
  } catch(err) {
    req.session.errorMsg = 'Error updating company results.';
  }
  res.redirect('/admin/dashboard');
}));

// POST /admin/calculate-scores
router.post('/calculate-scores', catchAsync(async (req, res) => {
  const db = await getDb();
  
  // Clear old scores
  await db.run('DELETE FROM scores');
  
  const teams = await db.all('SELECT * FROM teams');
  for (let team of teams) {
    const allocations = await db.all('SELECT * FROM allocations WHERE team_id = $1', [team.id]);
    let totalScore = 0;
    
    for (let alloc of allocations) {
      const result = await db.get('SELECT * FROM company_results WHERE company_id = $1', [alloc.company_id]);
      if (result) {
        const companyScore = alloc.allocated_amount * (
          result.stock_price + result.revenue + result.yoy_growth + result.ebitda + result.market_cap + result.market_share
        );
        totalScore += companyScore;
      }
    }
    
    await db.run('INSERT INTO scores (team_id, total_score) VALUES ($1, $2)', [team.id, totalScore]);
  }
  
  req.session.successMsg = 'Scores calculated successfully. Viewing final Leaderboard!';
  res.redirect('/leaderboard');
}));

module.exports = router;

