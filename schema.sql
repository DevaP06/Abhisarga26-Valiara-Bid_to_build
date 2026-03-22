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
  purse_remaining REAL DEFAULT 1000000, -- Default purse: $1,000,000
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

CREATE TABLE IF NOT EXISTS company_results (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id),
  stock_price REAL NOT NULL,
  revenue REAL NOT NULL,
  yoy_growth REAL NOT NULL,
  ebitda REAL NOT NULL,
  market_cap REAL NOT NULL,
  market_share REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL UNIQUE REFERENCES teams(id),
  total_score REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS system_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_phase TEXT DEFAULT 'closed' CHECK(current_phase IN ('auction', 'allocation', 'closed')),
  live_company_id INTEGER REFERENCES companies(id)
);

