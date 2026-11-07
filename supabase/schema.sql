-- Pagehouse Supabase PostgreSQL Schema & Storage Setup
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql)

CREATE TABLE IF NOT EXISTS catalog_books (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_name TEXT NOT NULL,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  published_year INTEGER,
  format TEXT NOT NULL DEFAULT '',
  subjects TEXT NOT NULL DEFAULT '[]',
  cover_url TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  rights_status TEXT NOT NULL DEFAULT 'approved' CHECK (rights_status IN ('pending','approved','rejected')),
  rights_scope TEXT NOT NULL DEFAULT '',
  rights_evidence TEXT NOT NULL DEFAULT '',
  attribution TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'GHS',
  file_status TEXT NOT NULL DEFAULT 'ready' CHECK (file_status IN ('metadata_only','queued','ready','unavailable')),
  file_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed','hidden')),
  content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, source_ref)
);

CREATE INDEX IF NOT EXISTS catalog_books_status_updated ON catalog_books(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS catalog_books_source ON catalog_books(source_id, source_ref);

CREATE TABLE IF NOT EXISTS catalog_rights_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  license TEXT NOT NULL DEFAULT '',
  rights_scope TEXT NOT NULL DEFAULT '',
  rights_evidence TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  admin_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (admin_confirmed IN (0,1))
);

CREATE TABLE IF NOT EXISTS store_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_source_licences (
  source_id TEXT PRIMARY KEY,
  licensor TEXT NOT NULL,
  licence TEXT NOT NULL,
  agreement_ref TEXT NOT NULL DEFAULT '',
  rights_scope TEXT NOT NULL,
  evidence TEXT NOT NULL,
  permits_sale INTEGER NOT NULL CHECK (permits_sale IN (0,1)),
  permits_redistribution INTEGER NOT NULL CHECK (permits_redistribution IN (0,1)),
  expires_at TEXT NOT NULL DEFAULT '',
  approved_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_download_checks (
  book_id TEXT PRIMARY KEY REFERENCES catalog_books(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  retry_after TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  momo_phone TEXT UNIQUE,
  momo_provider TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_passkeys (
  credential_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS library_passkeys_library ON library_passkeys(library_id);

CREATE TABLE IF NOT EXISTS store_orders (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency='GHS'),
  status TEXT NOT NULL CHECK (status IN ('pending','paid','failed')),
  checkout_url TEXT NOT NULL DEFAULT '',
  provider_access_code TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'checkout',
  momo_phone TEXT NOT NULL DEFAULT '',
  momo_provider TEXT NOT NULL DEFAULT '',
  library_id TEXT NOT NULL DEFAULT '',
  client_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  paid_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS store_orders_email_created ON store_orders(email, created_at DESC);
CREATE INDEX IF NOT EXISTS store_orders_library ON store_orders(library_id, created_at DESC);

CREATE TABLE IF NOT EXISTS store_order_items (
  order_id TEXT NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES catalog_books(id),
  title_snapshot TEXT NOT NULL,
  price_minor INTEGER NOT NULL,
  file_key_snapshot TEXT NOT NULL,
  source_id_snapshot TEXT NOT NULL DEFAULT '',
  source_ref_snapshot TEXT NOT NULL DEFAULT '',
  format_snapshot TEXT NOT NULL DEFAULT '',
  download_count INTEGER NOT NULL DEFAULT 0,
  download_limit INTEGER NOT NULL DEFAULT 5,
  expires_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(order_id, book_id)
);

CREATE INDEX IF NOT EXISTS store_order_items_book ON store_order_items(book_id);

CREATE TABLE IF NOT EXISTS store_download_sessions (
  order_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(order_id, book_id, token_expires_at)
);

CREATE TABLE IF NOT EXISTS store_payment_events (
  event_hash TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_requests (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  isbn TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  title_key TEXT NOT NULL,
  surname_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','fulfilled','closed','expired')),
  matched_book_id TEXT REFERENCES catalog_books(id) ON DELETE SET NULL,
  library_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  matched_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS book_requests_status ON book_requests(status, created_at);
CREATE INDEX IF NOT EXISTS book_requests_email ON book_requests(email, status);
CREATE INDEX IF NOT EXISTS book_requests_library ON book_requests(library_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS email_outbox_sent ON email_outbox(status, sent_at);

-- Private storage bucket for cached/converted PDFs & covers
INSERT INTO storage.buckets (id, name, public)
VALUES ('pagehouse-books', 'pagehouse-books', false)
ON CONFLICT (id) DO NOTHING;
