require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDb } = require('./db');

// Import routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const teamRoutes = require('./routes/team');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use(express.json()); // Parse JSON bodies

// Session Setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretbidtobuildcode123',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Set true if using HTTPS
    maxAge: 1000 * 60 * 60 * 24 // 1 day session
  }
}));

// Global variables for views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.team = req.session.team || null;
  res.locals.errorMsg = req.session.errorMsg || null;
  res.locals.successMsg = req.session.successMsg || null;
  // Clear flash messages after assigning them to locals
  req.session.errorMsg = null;
  req.session.successMsg = null;
  next();
});

// Routes
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') {
      return res.redirect('/admin/dashboard');
    } else {
      return res.redirect('/team/dashboard');
    }
  }
  res.redirect('/login');
});

app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/team', teamRoutes);
app.use('/api', apiRoutes);

app.get('/login', (req, res) => {
    res.render('login');
});

app.get('/leaderboard', async (req, res) => {
  const { getDb } = require('./db');
  const db = await getDb();
  try {
    const teams = await db.all('SELECT * FROM teams ORDER BY team_name ASC');
    const allocations = await db.all(`
      SELECT allocations.team_id, allocations.allocated_amount, companies.name as company_name 
      FROM allocations 
      JOIN companies ON allocations.company_id = companies.id
    `);
    const bids = await db.all(`
      SELECT bids.team_id, bids.bid_amount, companies.name as company_name 
      FROM bids 
      JOIN companies ON bids.company_id = companies.id
    `);

    // Attach holding data to each team
    for (let t of teams) {
      t.allocations = allocations.filter(a => a.team_id === t.id);
      t.bids = bids.filter(b => b.team_id === t.id);
      t.total_allocated = t.allocations.reduce((sum, a) => sum + a.allocated_amount, 0);
      t.total_bidded = t.bids.reduce((sum, b) => sum + b.bid_amount, 0);
    }

    res.render('leaderboard', { teams });
  } catch(err) {
    console.error(err);
    res.send("Error loading portfolios.");
  }
});

// Initialize DB and start server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
