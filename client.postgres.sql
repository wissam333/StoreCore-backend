-- Store schema for customer Supabase projects
-- Run once in Supabase SQL Editor after creating the project

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT          PRIMARY KEY,
  name        TEXT          NOT NULL,
  description TEXT,
  version     INTEGER       NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  synced_at   TIMESTAMPTZ
);

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
  synced_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT          PRIMARY KEY,
  name        TEXT          NOT NULL,
  permissions JSONB         NOT NULL DEFAULT '{}',
  is_system   BOOLEAN       DEFAULT FALSE,
  version     INTEGER       NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS staff (
  id          TEXT          PRIMARY KEY,
  full_name   TEXT          NOT NULL,
  username    TEXT,
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
  synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT          PRIMARY KEY,
  name         TEXT          NOT NULL,
  description  TEXT,
  category_id  TEXT          REFERENCES categories(id) ON DELETE SET NULL,
  barcode      TEXT,
  buy_price    NUMERIC(14,4) NOT NULL DEFAULT 0,
  sell_price   NUMERIC(14,4) NOT NULL DEFAULT 0,
  currency     TEXT          NOT NULL DEFAULT 'SP',
  stock        INTEGER       NOT NULL DEFAULT 0,
  min_stock    INTEGER       DEFAULT 0,
  unit         TEXT          DEFAULT 'piece',
  image_url    TEXT,
  is_active    BOOLEAN       DEFAULT TRUE,
  version      INTEGER       NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ   DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   DEFAULT NOW(),
  synced_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT          PRIMARY KEY,
  customer_id      TEXT          REFERENCES customers(id) ON DELETE SET NULL,
  order_date       TIMESTAMPTZ   DEFAULT NOW(),
  status           TEXT          NOT NULL DEFAULT 'pending',
  total_sp         NUMERIC(14,4) DEFAULT 0,
  total_usd        NUMERIC(14,4) DEFAULT 0,
  paid_amount      NUMERIC(14,4) DEFAULT 0,
  display_currency TEXT          DEFAULT 'SP',
  notes            TEXT,
  created_by       TEXT          REFERENCES staff(id) ON DELETE SET NULL,
  version          INTEGER       NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   DEFAULT NOW(),
  synced_at        TIMESTAMPTZ
);

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
  synced_at           TIMESTAMPTZ
);

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
  synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dues (
  id           TEXT          PRIMARY KEY,
  customer_id  TEXT          REFERENCES customers(id) ON DELETE SET NULL,
  order_id     TEXT          REFERENCES orders(id)    ON DELETE SET NULL,
  amount       NUMERIC(14,4) NOT NULL,
  currency     TEXT          NOT NULL DEFAULT 'SP',
  amount_sp    NUMERIC(14,4) NOT NULL DEFAULT 0,
  description  TEXT,
  due_date     TEXT,
  paid         BOOLEAN       DEFAULT FALSE,
  paid_at      TIMESTAMPTZ,
  version      INTEGER       NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ   DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   DEFAULT NOW(),
  synced_at    TIMESTAMPTZ
);

-- Sync log: tracks which device changed which fields
-- Used for field-level merge conflict resolution
CREATE TABLE IF NOT EXISTS sync_log (
  id             BIGSERIAL    PRIMARY KEY,
  table_name     TEXT         NOT NULL,
  row_id         TEXT         NOT NULL,
  device_id      TEXT         NOT NULL,
  changed_fields TEXT[]       NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_categories_updated_at     ON categories(updated_at);
CREATE INDEX IF NOT EXISTS idx_products_updated_at       ON products(updated_at);
CREATE INDEX IF NOT EXISTS idx_customers_updated_at      ON customers(updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_updated_at         ON orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_items_updated_at    ON order_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_payments_updated_at ON order_payments(updated_at);
CREATE INDEX IF NOT EXISTS idx_dues_updated_at           ON dues(updated_at);
CREATE INDEX IF NOT EXISTS idx_roles_updated_at          ON roles(updated_at);
CREATE INDEX IF NOT EXISTS idx_staff_updated_at          ON staff(updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_log_updated_at       ON sync_log(updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_log_table_row        ON sync_log(table_name, row_id);

-- Disable RLS on all tables
ALTER TABLE categories     DISABLE ROW LEVEL SECURITY;
ALTER TABLE products       DISABLE ROW LEVEL SECURITY;
ALTER TABLE customers      DISABLE ROW LEVEL SECURITY;
ALTER TABLE roles          DISABLE ROW LEVEL SECURITY;
ALTER TABLE staff          DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders         DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_items    DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE dues           DISABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log       DISABLE ROW LEVEL SECURITY;