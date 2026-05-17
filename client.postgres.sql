-- client.postgres.sql
-- PostgreSQL schema for a new client database.
-- Copy + paste into the remote Supabase/Postgres SQL editor to initialise a new client.
-- Mirrors the schema in my-app/db/schema.js exactly.
-- Columns prefixed with _deleted support soft-delete; synced_at for sync tracking.
--
-- Fixed seed IDs (must match the app's schema.js):
--   Administrator role : role-0001-0000-0000-000000000001
--   Cashier role       : role-0002-0000-0000-000000000002
--   Admin staff        : staff-0001-0000-0000-000000000001

-- ═══════════════════════════════════════════════════════════════════════════════
--  CORE TABLES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  _deleted    INTEGER DEFAULT 0,
  synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT,
  category_id  TEXT    REFERENCES categories(id),
  barcode      TEXT,
  buy_price    NUMERIC NOT NULL DEFAULT 0,
  sell_price   NUMERIC NOT NULL DEFAULT 0,
  currency     TEXT    NOT NULL DEFAULT 'SP' CHECK(currency IN ('SP','USD')),
  stock        INTEGER NOT NULL DEFAULT 0,
  min_stock    INTEGER DEFAULT 0,
  unit         TEXT    DEFAULT 'piece',
  image_url    TEXT,
  is_active    INTEGER DEFAULT 1,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  _deleted     INTEGER DEFAULT 0,
  synced_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customers (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  phone        TEXT,
  address      TEXT,
  notes        TEXT,
  total_orders INTEGER DEFAULT 0,
  total_spent  NUMERIC DEFAULT 0,
  last_order   TIMESTAMPTZ,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  _deleted     INTEGER DEFAULT 0,
  synced_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT    PRIMARY KEY,
  customer_id      TEXT    REFERENCES customers(id),
  order_date       TIMESTAMPTZ DEFAULT NOW(),
  status           TEXT    NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending','partly_paid','paid')),
  total_sp         NUMERIC DEFAULT 0,
  total_usd        NUMERIC DEFAULT 0,
  paid_amount      NUMERIC DEFAULT 0,
  display_currency TEXT    DEFAULT 'SP' CHECK(display_currency IN ('SP','USD')),
  notes            TEXT,
  created_by       TEXT    REFERENCES staff(id),
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  _deleted         INTEGER DEFAULT 0,
  synced_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_items (
  id                  TEXT    PRIMARY KEY,
  order_id            TEXT    NOT NULL REFERENCES orders(id),
  product_id          TEXT    REFERENCES products(id),
  product_name        TEXT    NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1,
  sell_price_at_sale  NUMERIC NOT NULL,
  buy_price_at_sale   NUMERIC,
  currency_at_sale    TEXT    NOT NULL DEFAULT 'SP',
  line_total_sp       NUMERIC NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  _deleted            INTEGER DEFAULT 0,
  synced_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_payments (
  id          TEXT    PRIMARY KEY,
  order_id    TEXT    NOT NULL REFERENCES orders(id),
  amount      NUMERIC NOT NULL,
  currency    TEXT    NOT NULL DEFAULT 'SP',
  amount_sp   NUMERIC NOT NULL DEFAULT 0,
  note        TEXT,
  paid_at     TIMESTAMPTZ DEFAULT NOW(),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  _deleted    INTEGER DEFAULT 0,
  synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dues (
  id          TEXT    PRIMARY KEY,
  customer_id TEXT    REFERENCES customers(id),
  order_id    TEXT    REFERENCES orders(id),
  amount      NUMERIC NOT NULL,
  currency    TEXT    NOT NULL DEFAULT 'SP' CHECK(currency IN ('SP','USD')),
  amount_sp   NUMERIC NOT NULL DEFAULT 0,
  description TEXT,
  due_date    TIMESTAMPTZ,
  paid        INTEGER DEFAULT 0,
  paid_at     TIMESTAMPTZ,
  direction   TEXT    NOT NULL DEFAULT 'receivable' CHECK(direction IN ('receivable','payable')),
  contact_name TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  _deleted    INTEGER DEFAULT 0,
  synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  permissions TEXT    NOT NULL DEFAULT '{}',
  is_system   INTEGER DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  _deleted    INTEGER DEFAULT 0,
  synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS staff (
  id          TEXT    PRIMARY KEY,
  full_name   TEXT    NOT NULL,
  username    TEXT,
  password    TEXT,
  pin         TEXT,
  role_id     TEXT    REFERENCES roles(id),
  role        TEXT,
  phone       TEXT,
  email       TEXT,
  is_active   INTEGER DEFAULT 1,
  last_login  TIMESTAMPTZ,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  _deleted    INTEGER DEFAULT 0,
  synced_at   TIMESTAMPTZ
);

-- ═══════════════════════════════════════════════════════════════════════════════
--  STOCK RECEIVING TABLES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stock_receivings (
  id             TEXT    PRIMARY KEY,
  supplier_name  TEXT,
  supplier_phone TEXT,
  invoice_ref    TEXT,
  notes          TEXT,
  received_at    TIMESTAMPTZ DEFAULT NOW(),
  status         TEXT    NOT NULL DEFAULT 'draft'
                         CHECK(status IN ('draft','posted','voided')),
  posted_at      TIMESTAMPTZ,
  voided_at      TIMESTAMPTZ,
  void_reason    TEXT,
  created_by     TEXT    REFERENCES staff(id),
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  _deleted       INTEGER DEFAULT 0,
  synced_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stock_receiving_items (
  id                TEXT    PRIMARY KEY,
  receiving_id      TEXT    NOT NULL REFERENCES stock_receivings(id),
  product_id        TEXT    REFERENCES products(id),
  product_name      TEXT    NOT NULL,
  quantity_received INTEGER NOT NULL DEFAULT 1,
  buy_price         NUMERIC NOT NULL DEFAULT 0,
  sell_price        NUMERIC,
  currency          TEXT    NOT NULL DEFAULT 'SP' CHECK(currency IN ('SP','USD')),
  is_new_product    INTEGER DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  _deleted          INTEGER DEFAULT 0,
  synced_at         TIMESTAMPTZ
);

-- ═══════════════════════════════════════════════════════════════════════════════
--  SYSTEM TABLES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_queue (
  id             BIGSERIAL PRIMARY KEY,
  table_name     TEXT    NOT NULL,
  operation      TEXT    NOT NULL CHECK(operation IN ('insert','update','delete')),
  row_id         TEXT    NOT NULL,
  payload        JSONB,
  queued_at      TIMESTAMPTZ DEFAULT NOW(),
  synced_at      TIMESTAMPTZ,
  retry_count    INTEGER DEFAULT 0,
  changed_fields TEXT
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ═══════════════════════════════════════════════════════════════════════════════
--  SETTINGS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS settings (
  id         TEXT,
  key        TEXT PRIMARY KEY,
  value      TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  _deleted   INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  synced_at  TIMESTAMPTZ
);

INSERT OR IGNORE INTO settings (id, key, value, version) VALUES
  ('settings-store_name',      'store_name',      'My Store', 1),
  ('settings-store_address',   'store_address',   '',          1),
  ('settings-store_phone',     'store_phone',     '',          1),
  ('settings-dollar_rate',     'dollar_rate',     '15000',     1),
  ('settings-report_currency', 'report_currency', 'SP',        1),
  ('settings-sync_base',       'sync_base',       '',          1),
  ('settings-sync_token',      'sync_token',      '',          1);

-- ═══════════════════════════════════════════════════════════════════════════════
--  INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Partial unique indexes — only active, non-deleted rows must be unique.
-- Deleted rows keep their old username/name so we can soft-delete without collisions.
CREATE UNIQUE INDEX IF NOT EXISTS staff_username_active_unique
  ON staff (username) WHERE _deleted = 0;

CREATE UNIQUE INDEX IF NOT EXISTS roles_name_active_unique
  ON roles (name) WHERE _deleted = 0;


-- Example for seed endpoint :
--   Invoke-WebRequest -Uri "https://storecore-backend.onrender.com/admin/seed-supabase/TEST-0002-SYNC-KEY" `
--   -Method POST `
--   -Headers @{ "x-admin-secret" = "wnajjom321"; "Content-Type" = "application/json" }