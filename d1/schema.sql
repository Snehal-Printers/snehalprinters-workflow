-- Snehal Printers Lead Gen Pipeline — D1 schema
-- Single-tenant DB. Run once: wrangler d1 execute snehal-leadgen --file=./d1/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,      
  password_salt TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'admin',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT,
  description TEXT,
  keywords TEXT,              
  source TEXT DEFAULT 'scraped', 
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  area TEXT DEFAULT 'Pune MIDC',
  trigger TEXT DEFAULT 'manual',   
  status TEXT DEFAULT 'running',   
  progress_step TEXT DEFAULT 'queued',   
  progress_pct INTEGER DEFAULT 0,        
  queries_used INTEGER DEFAULT 0,
  hits_scanned INTEGER DEFAULT 0,
  leads_found INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id)
);


CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  product_id INTEGER,
  company_name TEXT,
  website TEXT,
  domain TEXT,
  email TEXT,
  email_source TEXT,           
  phone TEXT,
  address TEXT,
  area_match TEXT,             
  relevance_score INTEGER,     
  relevance_reason TEXT,
  status TEXT DEFAULT 'new',   
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(domain, email),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS outreach_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'pending',  
  approved_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id),
  FOREIGN KEY (approved_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_leads_run ON leads(run_id);
CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(domain);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach_queue(status);
