const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { getDb } = require('../db');

// Add error handling wrapper block
const catchErrors = fn => (req, res, next) => fn(req, res, next).catch(next);

// POST /login
router.post('/login', catchErrors(async (req, res) => {
  const { username, password } = req.body;
  const db = await getDb();

  const user = await db.get('SELECT * FROM users WHERE username = $1', [username]);

  if (!user) {
    req.session.errorMsg = 'Invalid username or password.';
    return res.redirect('/login');
  }

  const match = await bcrypt.compare(password, user.password);
  
  if (!match) {
    req.session.errorMsg = 'Invalid username or password.';
    return res.redirect('/login');
  }

  // Setup session
  req.session.user = { id: user.id, username: user.username, role: user.role };
  
  // Create team if they are a 'team' user and don't have one
  if (user.role === 'team') {
    let team = await db.get('SELECT * FROM teams WHERE user_id = $1', [user.id]);
    
    // Auto-create a team if it doesn't exist
    if (!team) {
      const sys = await db.get('SELECT default_bidding_purse, default_allocation_purse FROM system_control LIMIT 1');
      const bPurse = sys ? sys.default_bidding_purse : 1000000;
      const aPurse = sys ? sys.default_allocation_purse : 2000000;
      
      const teamName = `${user.username}_team`;
      await db.run('INSERT INTO teams (team_name, user_id, purse_remaining, allocation_purse) VALUES ($1, $2, $3, $4)', [teamName, user.id, bPurse, aPurse]);
      team = await db.get('SELECT * FROM teams WHERE user_id = $1', [user.id]);
    }
    
    req.session.team = { id: team.id, team_name: team.team_name, purse: team.purse_remaining };
    req.session.successMsg = `Welcome, ${user.username}!`;
    return res.redirect('/team/dashboard');
  }

  // Admin login success
  req.session.successMsg = 'Admin login successful.';
  return res.redirect('/admin/dashboard');
}));

// POST /logout
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error("Session destruction error:", err);
    res.redirect('/login');
  });
});

module.exports = router;
