-- sync-backend/schema.postgres.sql
-- Store App sync backend schema.
-- Run once on your PostgreSQL database.

-- ─────────────────────────────────────────────────────────────────────────────
--  CATEGORIES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT          PRIMARY KEY,
  name        TEXT          NOT NULL,
  description TEXT,
  version     INTEGER       NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  _deleted    BOOLEAN       DEFAULT FALSE,
  synced_at   TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  PRODUCTS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id           TEXT          PRIMARY KEY,
  name         TEXT          NOT NULL,
  description  TEXT,
  category_id  TEXT          REFERENCES categories(id) ON DELETE SET NULL,
  barcode      TEXT,
  buy_price    NUMERIC(14,4) NOT NULL DEFAULT 0,
  sell_price   NUMERIC(14,4) NOT NULL DEFAULT 0,
  currency     TEXT          NOT NULL DEFAULT 'SP' CHECK(currency IN ('SP','USD')),
  stock        INTEGER       NOT NULL DEFAULT 0,
  min_stock    INTEGER       DEFAULT 0,
  unit         TEXT          DEFAULT 'piece',
  image_url    TEXT,
  is_active    BOOLEAN       DEFAULT TRUE,
  version      INTEGER       NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ   DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   DEFAULT NOW(),
  _deleted     BOOLEAN       DEFAULT FALSE,
  synced_at    TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  CUSTOMERS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id           TEXT          PRIMARY KEY,
  name         TEXT          NOT NULL,
  phone        TEXT,
  address      TEXT,
  notes        TEXT,
  total_orders INTEGER       DEFAULT 0,
  total_spent  NUMERIC(14,4) DEFAULT 0,
  last_order   TIMESTAMPTZ,
  version      INTEGER       NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ   DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   DEFAULT NOW(),
  _deleted     BOOLEAN       DEFAULT FALSE,
  synced_at    TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  ORDERS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id               TEXT          PRIMARY KEY,
  customer_id      TEXT          REFERENCES customers(id) ON DELETE SET NULL,
  order_date       TIMESTAMPTZ   DEFAULT NOW(),
  status           TEXT          NOT NULL DEFAULT 'pending'
                                 CHECK(status IN ('pending','partly_paid','paid')),
  total_sp         NUMERIC(14,4) DEFAULT 0,
  total_usd        NUMERIC(14,4) DEFAULT 0,
  paid_amount      NUMERIC(14,4) DEFAULT 0,
  display_currency TEXT          DEFAULT 'SP' CHECK(display_currency IN ('SP','USD')),
  notes            TEXT,
  created_by       TEXT          REFERENCES staff(id) ON DELETE SET NULL,
  version          INTEGER       NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   DEFAULT NOW(),
  _deleted         BOOLEAN       DEFAULT FALSE,
  synced_at        TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  ORDER ITEMS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id                  TEXT          PRIMARY KEY,
  order_id            TEXT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id          TEXT          REFERENCES products(id) ON DELETE SET NULL,
  product_name        TEXT          NOT NULL,
  quantity            INTEGER       NOT NULL DEFAULT 1,
  sell_price_at_sale  NUMERIC(14,4) NOT NULL,
  currency_at_sale    TEXT          NOT NULL DEFAULT 'SP',
  line_total_sp       NUMERIC(14,4) NOT NULL DEFAULT 0,
  version             INTEGER       NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ   DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   DEFAULT NOW(),
  _deleted            BOOLEAN       DEFAULT FALSE,
  synced_at           TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  ORDER PAYMENTS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_payments (
  id          TEXT          PRIMARY KEY,
  order_id    TEXT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount      NUMERIC(14,4) NOT NULL,
  currency    TEXT          NOT NULL DEFAULT 'SP',
  amount_sp   NUMERIC(14,4) NOT NULL DEFAULT 0,
  note        TEXT,
  paid_at     TIMESTAMPTZ   DEFAULT NOW(),
  version     INTEGER       NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  _deleted    BOOLEAN       DEFAULT FALSE,
  synced_at   TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  DUES (ديون)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dues (
  id           TEXT          PRIMARY KEY,
  customer_id  TEXT          REFERENCES customers(id) ON DELETE SET NULL,
  order_id     TEXT          REFERENCES orders(id)    ON DELETE SET NULL,
  amount       NUMERIC(14,4) NOT NULL,
  currency     TEXT          NOT NULL DEFAULT 'SP' CHECK(currency IN ('SP','USD')),
  amount_sp    NUMERIC(14,4) NOT NULL DEFAULT 0,
  description  TEXT,
  due_date     TEXT,
  paid         BOOLEAN       DEFAULT FALSE,
  paid_at      TIMESTAMPTZ,
  version      INTEGER       NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ   DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   DEFAULT NOW(),
  _deleted     BOOLEAN       DEFAULT FALSE,
  synced_at    TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  ROLES
--  permissions: JSONB blob — flat key/value e.g. {"products.view":true, ...}
--  is_system:   TRUE = built-in role (Administrator) that cannot be deleted
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT          PRIMARY KEY,
  name        TEXT          NOT NULL UNIQUE,
  permissions JSONB         NOT NULL DEFAULT '{}',
  is_system   BOOLEAN       DEFAULT FALSE,
  version     INTEGER       NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  _deleted    BOOLEAN       DEFAULT FALSE,
  synced_at   TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  STAFF
--  role_id:    FK → roles.id  (replaces the old hardcoded role CHECK constraint)
--  role:       kept as a plain-text label for display / backward compat
--  pin:        optional — salt:sha256hash for quick re-auth / fingerprint login
--  password:   salt:sha256hash (plain 'admin' only on seed, hashed on first login)
--  last_login: timestamp of most recent successful login
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff (
  id          TEXT          PRIMARY KEY,
  full_name   TEXT          NOT NULL,
  username    TEXT          UNIQUE,
  password    TEXT,
  pin         TEXT,
  role_id     TEXT          REFERENCES roles(id) ON DELETE SET NULL,
  role        TEXT,
  phone       TEXT,
  email       TEXT,
  is_active   BOOLEAN       DEFAULT TRUE,
  last_login  TIMESTAMPTZ,
  version     INTEGER       NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  _deleted    BOOLEAN       DEFAULT FALSE,
  synced_at   TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
--  LICENSES  (matches server.js column names)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS licenses (
  key                   TEXT         PRIMARY KEY,
  machine_id_desktop    TEXT,
  machine_id_mobile     TEXT,
  is_active             BOOLEAN      DEFAULT TRUE,
  expires_at            TIMESTAMPTZ,
  activated_at_desktop  TIMESTAMPTZ,
  activated_at_mobile   TIMESTAMPTZ,
  last_verified_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
--  Indexes — updated_at is the hot path for pull queries
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_categories_updated_at     ON categories(updated_at);
CREATE INDEX IF NOT EXISTS idx_products_updated_at       ON products(updated_at);
CREATE INDEX IF NOT EXISTS idx_customers_updated_at      ON customers(updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_updated_at         ON orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_items_updated_at    ON order_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_payments_order_id   ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_updated_at ON order_payments(updated_at);
CREATE INDEX IF NOT EXISTS idx_dues_updated_at           ON dues(updated_at);
CREATE INDEX IF NOT EXISTS idx_roles_updated_at          ON roles(updated_at);
CREATE INDEX IF NOT EXISTS idx_staff_updated_at          ON staff(updated_at);
CREATE INDEX IF NOT EXISTS idx_staff_role_id             ON staff(role_id);

-- ─────────────────────────────────────────────────────────────────────────────
--  Migration script — run this if the database already exists
--  (safe to run multiple times — each statement is wrapped in DO $$ blocks)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create roles table if it doesn't exist yet (idempotent — covered above)

-- 2. Add new columns to staff (ignore errors if they already exist)
DO $$ BEGIN
  ALTER TABLE staff ADD COLUMN pin        TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE staff ADD COLUMN role_id    TEXT REFERENCES roles(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE staff ADD COLUMN last_login TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 3. Drop the old hardcoded CHECK constraint on role (if it exists)
--    Constraint name may vary — check yours with \d staff in psql.
--    The name below matches what PostgreSQL auto-generates from the original schema.
DO $$ BEGIN
  ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN created_by TEXT REFERENCES staff(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Backfill existing orders
UPDATE orders SET created_by = 'staff-0001-0000-0000-000000000001' WHERE created_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_created_by ON orders(created_by);