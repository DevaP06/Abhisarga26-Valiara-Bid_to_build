CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'team' CHECK(role IN ('admin', 'team')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  team_name TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purse_remaining REAL DEFAULT 0,
  allocation_purse REAL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  pdf_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bids (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  bid_amount REAL NOT NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id) -- A company can only be bought by one team
);

CREATE TABLE IF NOT EXISTS allocations (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  allocated_amount REAL NOT NULL,
  UNIQUE(team_id, company_id) -- A team can only allocate once per company
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  initiator_team_id INTEGER NOT NULL REFERENCES teams(id),
  target_team_id INTEGER NOT NULL REFERENCES teams(id),
  offered_company_id INTEGER REFERENCES companies(id),
  offered_cash REAL DEFAULT 0.0,
  target_company_id INTEGER NOT NULL REFERENCES companies(id),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS system_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_phase TEXT DEFAULT 'closed' CHECK(current_phase IN ('auction', 'allocation', 'closed')),
  live_company_id INTEGER REFERENCES companies(id),
  default_bidding_purse REAL DEFAULT 1000000.0,
  default_allocation_purse REAL DEFAULT 2000000.0
);
