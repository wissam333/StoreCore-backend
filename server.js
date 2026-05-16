// sync-backend/server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import pg from "pg";
import cors from "cors";

const { Pool } = pg;
const app = express();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? "5432"),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl: { rejectUnauthorized: false },
});

app.use(
  cors({
    origin: "*",
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-secret"],
  }),
);
app.use(express.json({ limit: "10mb" }));

// ── Auth middleware ───────────────────────────────────────────────────────────
// /health, /license/*, /admin/* all skip Bearer auth
app.use(async (req, res, next) => {
  if (
    req.path === "/health" ||
    req.path.startsWith("/license") ||
    req.path.startsWith("/admin")
  )
    return next();

  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const { rows } = await pool.query(
      `SELECT key, is_active, expires_at FROM licenses WHERE key = $1`,
      [token],
    );
    const lic = rows[0];
    if (!lic || !lic.is_active)
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    if (lic.expires_at && new Date(lic.expires_at) < new Date())
      return res.status(401).json({ ok: false, error: "License expired" });
    req.licenseKey = token;
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(500).json({ ok: false, error: "Auth check failed" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

// ── LICENSE ENDPOINTS ─────────────────────────────────────────────────────────

app.post("/license/activate", async (req, res) => {
  const { key, machine_id, platform, label } = req.body;
  if (!key || !machine_id || !platform)
    return res
      .status(400)
      .json({ ok: false, error: "Missing key, machine_id or platform" });

  try {
    const { rows: licRows } = await pool.query(
      `SELECT * FROM licenses WHERE key = $1`,
      [key],
    );
    const lic = licRows[0];
    if (!lic)
      return res.status(404).json({ ok: false, error: "Invalid license key" });
    if (!lic.is_active)
      return res.status(403).json({ ok: false, error: "License deactivated" });
    if (lic.expires_at && new Date(lic.expires_at) < new Date())
      return res.status(403).json({ ok: false, error: "License expired" });

    const { rows: existing } = await pool.query(
      `SELECT * FROM license_devices WHERE license_key = $1 AND machine_id = $2`,
      [key, machine_id],
    );

    if (existing.length > 0) {
      await pool.query(
        `UPDATE license_devices SET last_seen_at = NOW(), platform = $1
         WHERE license_key = $2 AND machine_id = $3`,
        [platform, key, machine_id],
      );
      return res.json({
        ok: true,
        expires_at: lic.expires_at,
        sync_enabled: lic.sync_enabled ?? false,
        ...(lic.sync_enabled && lic.supabase_url
          ? { supabase_url: lic.supabase_url, supabase_key: lic.supabase_key }
          : {}),
        already_registered: true,
      });
    }

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) as n FROM license_devices WHERE license_key = $1`,
      [key],
    );
    const usedSlots = parseInt(countRows[0].n);
    const maxDevices = lic.max_devices ?? 2;

    if (usedSlots >= maxDevices) {
      return res.status(403).json({
        ok: false,
        error: `All ${maxDevices} device slots are used. Contact support to add more slots or deactivate an existing device.`,
        reason: "slots_full",
        used: usedSlots,
        max: maxDevices,
      });
    }

    await pool.query(
      `INSERT INTO license_devices (license_key, machine_id, platform, label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (license_key, machine_id) DO UPDATE SET last_seen_at = NOW()`,
      [key, machine_id, platform, label ?? null],
    );

    return res.json({
      ok: true,
      expires_at: lic.expires_at,
      sync_enabled: lic.sync_enabled ?? false,
      ...(lic.sync_enabled && lic.supabase_url
        ? { supabase_url: lic.supabase_url, supabase_key: lic.supabase_key }
        : {}),
      used: usedSlots + 1,
      max: maxDevices,
    });
  } catch (err) {
    console.error("/license/activate:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/license/verify", async (req, res) => {
  const { key, machine_id, platform } = req.body;
  if (!key || !machine_id || !platform)
    return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const { rows: licRows } = await pool.query(
      `SELECT * FROM licenses WHERE key = $1`,
      [key],
    );
    const lic = licRows[0];
    if (!lic)
      return res.status(404).json({ ok: false, error: "Invalid license key" });
    if (!lic.is_active)
      return res.status(403).json({ ok: false, error: "License deactivated" });
    if (lic.expires_at && new Date(lic.expires_at) < new Date())
      return res.status(403).json({ ok: false, error: "License expired" });

    const { rows: deviceRows } = await pool.query(
      `SELECT * FROM license_devices WHERE license_key = $1 AND machine_id = $2`,
      [key, machine_id],
    );

    if (deviceRows.length === 0) {
      return res.status(403).json({
        ok: false,
        error: "This device is not activated. Please enter your license key.",
        reason: "not_activated",
      });
    }

    await pool.query(
      `UPDATE license_devices SET last_seen_at = NOW()
       WHERE license_key = $1 AND machine_id = $2`,
      [key, machine_id],
    );
    await pool.query(
      `UPDATE licenses SET last_verified_at = NOW() WHERE key = $1`,
      [key],
    );

    return res.json({
      ok: true,
      expires_at: lic.expires_at,
      sync_enabled: lic.sync_enabled ?? false,
      ...(lic.sync_enabled && lic.supabase_url
        ? { supabase_url: lic.supabase_url, supabase_key: lic.supabase_key }
        : {}),
    });
  } catch (err) {
    console.error("/license/verify:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/license/deactivate", async (req, res) => {
  const { key, machine_id } = req.body;
  if (!key || !machine_id)
    return res
      .status(400)
      .json({ ok: false, error: "Missing key or machine_id" });

  try {
    const { rows: licRows } = await pool.query(
      `SELECT key FROM licenses WHERE key = $1`,
      [key],
    );
    if (!licRows[0])
      return res.status(404).json({ ok: false, error: "Invalid key" });

    await pool.query(
      `DELETE FROM license_devices WHERE license_key = $1 AND machine_id = $2`,
      [key, machine_id],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("/license/deactivate:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "change-me-in-env";

const adminAuth = (req, res, next) => {
  const secret = req.headers["x-admin-secret"] ?? "";
  if (secret !== ADMIN_SECRET)
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
};

// List all licenses with device counts
app.get("/admin/licenses", adminAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.*, COUNT(d.id) as used_slots
      FROM licenses l
      LEFT JOIN license_devices d ON d.license_key = l.key
      GROUP BY l.key
      ORDER BY l.created_at DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get one license with its devices
app.get("/admin/licenses/:key", adminAuth, async (req, res) => {
  try {
    const { rows: licRows } = await pool.query(
      `SELECT * FROM licenses WHERE key = $1`,
      [req.params.key],
    );
    if (!licRows[0])
      return res.status(404).json({ ok: false, error: "Not found" });

    const { rows: devices } = await pool.query(
      `SELECT * FROM license_devices WHERE license_key = $1 ORDER BY activated_at`,
      [req.params.key],
    );
    res.json({ ok: true, data: { ...licRows[0], devices } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create a new license key
app.post("/admin/licenses", adminAuth, async (req, res) => {
  try {
    const {
      key,
      max_devices = 2,
      expires_at = null,
      sync_enabled = false,
      supabase_url = null,
      supabase_key = null,
    } = req.body;

    if (!key?.trim())
      return res.status(400).json({ ok: false, error: "key is required" });
    if (sync_enabled && (!supabase_url || !supabase_key))
      return res.status(400).json({
        ok: false,
        error: "supabase_url and supabase_key required when sync_enabled=true",
      });

    await pool.query(
      `INSERT INTO licenses (key, max_devices, expires_at, is_active, sync_enabled, supabase_url, supabase_key)
       VALUES ($1, $2, $3, TRUE, $4, $5, $6)`,
      [
        key.trim(),
        max_devices,
        expires_at,
        sync_enabled,
        supabase_url,
        supabase_key,
      ],
    );
    res.json({ ok: true, key: key.trim(), max_devices });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ ok: false, error: "Key already exists" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Update a license
app.patch("/admin/licenses/:key", adminAuth, async (req, res) => {
  try {
    // FIX: all 6 fields now properly destructured
    const {
      max_devices,
      is_active,
      expires_at,
      sync_enabled,
      supabase_url,
      supabase_key,
    } = req.body;
    const updates = [];
    const vals = [];
    let i = 1;

    if (max_devices !== undefined) {
      updates.push(`max_devices  = $${i++}`);
      vals.push(max_devices);
    }
    if (is_active !== undefined) {
      updates.push(`is_active    = $${i++}`);
      vals.push(is_active);
    }
    if (expires_at !== undefined) {
      updates.push(`expires_at   = $${i++}`);
      vals.push(expires_at);
    }
    if (sync_enabled !== undefined) {
      updates.push(`sync_enabled = $${i++}`);
      vals.push(sync_enabled);
    }
    if (supabase_url !== undefined) {
      updates.push(`supabase_url = $${i++}`);
      vals.push(supabase_url);
    }
    if (supabase_key !== undefined) {
      updates.push(`supabase_key = $${i++}`);
      vals.push(supabase_key);
    }

    if (updates.length === 0)
      return res.status(400).json({ ok: false, error: "Nothing to update" });

    vals.push(req.params.key);
    await pool.query(
      `UPDATE licenses SET ${updates.join(", ")} WHERE key = $${i}`,
      vals,
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Revoke a specific device slot
app.delete(
  "/admin/licenses/:key/devices/:machine_id",
  adminAuth,
  async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM license_devices WHERE license_key = $1 AND machine_id = $2`,
        [req.params.key, req.params.machine_id],
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

// Revoke ALL devices for a license
app.delete("/admin/licenses/:key/devices", adminAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM license_devices WHERE license_key = $1`, [
      req.params.key,
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Seed a customer's Supabase project ────────────────────────────────────────
// Call once per new sync customer after creating their Supabase project.
// ── Init + Seed a customer's Supabase project ─────────────────────────────────
// Call once per new sync customer after creating their Supabase project.
// Creates all tables, indexes, and seeds default roles + admin staff.
// Safe to call again — uses IF NOT EXISTS + ON CONFLICT DO NOTHING.
app.post("/admin/seed-supabase/:key", adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT supabase_url, supabase_key, sync_enabled FROM licenses WHERE key = $1`,
      [req.params.key],
    );
    const lic = rows[0];
    if (!lic)
      return res.status(404).json({ ok: false, error: "License not found" });
    if (!lic.sync_enabled || !lic.supabase_url || !lic.supabase_key)
      return res
        .status(400)
        .json({ ok: false, error: "License has no Supabase config" });

    const supabaseUrl = lic.supabase_url;
    const supabaseKey = lic.supabase_key;

    // ── Step 1: Create schema via Supabase SQL endpoint ───────────────────────
    // Supabase exposes a /rest/v1/rpc endpoint for custom functions,
    // but for raw DDL we use the management API or the pg connection.
    // Simplest: connect directly to the customer's Supabase Postgres.
    // We do this via a temp Pool using the Supabase connection string.
    // Supabase DB host format: db.<project-ref>.supabase.co
    const projectRef = supabaseUrl.replace("https://", "").split(".")[0];
    const customerPool = new Pool({
      host: `db.${projectRef}.supabase.co`,
      port: 5432,
      database: "postgres",
      user: "postgres",
      password: supabaseKey, // service_role key IS the postgres password on Supabase
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });

    try {
      await customerPool.query(`
        -- Categories
        CREATE TABLE IF NOT EXISTS categories (
          id          TEXT          PRIMARY KEY,
          name        TEXT          NOT NULL,
          description TEXT,
          version     INTEGER       NOT NULL DEFAULT 1,
          created_at  TIMESTAMPTZ   DEFAULT NOW(),
          updated_at  TIMESTAMPTZ   DEFAULT NOW(),
          synced_at   TIMESTAMPTZ
        );

        -- Products
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

        -- Customers
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

        -- Roles
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

        -- Staff
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

        -- Orders
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

        -- Order Items
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

        -- Order Payments
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

        -- Dues
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

        -- Sync log — tracks which device changed which fields
        -- Used for field-level merge conflict resolution across devices
        CREATE TABLE IF NOT EXISTS sync_log (
          id            BIGSERIAL     PRIMARY KEY,
          table_name    TEXT          NOT NULL,
          row_id        TEXT          NOT NULL,
          device_id     TEXT          NOT NULL,
          changed_fields TEXT[]       NOT NULL DEFAULT '{}',
          updated_at    TIMESTAMPTZ   DEFAULT NOW()
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

        -- Disable RLS on all tables (service_role key bypasses anyway,
        -- but this avoids issues if Supabase defaults change)
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
      `);
    } finally {
      await customerPool.end();
    }

    // ── Step 2: Seed via PostgREST ─────────────────────────────────────────────
    const base = `${supabaseUrl}/rest/v1`;
    const headers = {
      "Content-Type": "application/json",
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    };

    const ADMIN_ROLE_ID = "role-0001-0000-0000-000000000001";
    const CASHIER_ROLE_ID = "role-0002-0000-0000-000000000002";
    const ADMIN_STAFF_ID = "staff-0001-0000-0000-000000000001";

    const ADMIN_PERMISSIONS = {
      "products.view": true,
      "products.add": true,
      "products.edit": true,
      "products.delete": true,
      "orders.view": true,
      "orders.add": true,
      "orders.edit": true,
      "orders.delete": true,
      "customers.view": true,
      "customers.add": true,
      "customers.edit": true,
      "customers.delete": true,
      "dues.view": true,
      "dues.add": true,
      "dues.edit": true,
      "dues.delete": true,
      "reports.view": true,
      "settings.view": true,
      "settings.edit": true,
      "staff.view": true,
      "staff.add": true,
      "staff.edit": true,
      "staff.delete": true,
    };

    const CASHIER_PERMISSIONS = {
      "products.view": true,
      "products.add": false,
      "products.edit": false,
      "products.delete": false,
      "orders.view": true,
      "orders.add": true,
      "orders.edit": false,
      "orders.delete": false,
      "customers.view": true,
      "customers.add": true,
      "customers.edit": false,
      "customers.delete": false,
      "dues.view": true,
      "dues.add": false,
      "dues.edit": false,
      "dues.delete": false,
      "reports.view": false,
      "settings.view": false,
      "settings.edit": false,
      "staff.view": false,
      "staff.add": false,
      "staff.edit": false,
      "staff.delete": false,
    };

    const rolesRes = await fetch(`${base}/roles`, {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          id: ADMIN_ROLE_ID,
          name: "Administrator",
          is_system: true,
          version: 1,
          permissions: ADMIN_PERMISSIONS,
          _deleted: false,
        },
        {
          id: CASHIER_ROLE_ID,
          name: "Cashier",
          is_system: false,
          version: 1,
          permissions: CASHIER_PERMISSIONS,
          _deleted: false,
        },
      ]),
    });
    if (!rolesRes.ok) {
      const err = await rolesRes.json().catch(() => ({}));
      throw new Error(`Roles seed failed: ${JSON.stringify(err)}`);
    }

    const staffRes = await fetch(`${base}/staff`, {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          id: ADMIN_STAFF_ID,
          full_name: "Admin",
          username: "admin",
          password: "admin",
          role_id: ADMIN_ROLE_ID,
          role: "Administrator",
          is_active: true,
          version: 1,
        },
      ]),
    });
    if (!staffRes.ok) {
      const err = await staffRes.json().catch(() => ({}));
      throw new Error(`Staff seed failed: ${JSON.stringify(err)}`);
    }

    res.json({
      ok: true,
      message: "Schema created and Supabase seeded successfully",
    });
  } catch (err) {
    console.error("/admin/seed-supabase:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = parseInt(process.env.PORT ?? "3001");
app.listen(PORT, () =>
  console.log(`✅ License server running on port ${PORT}`),
);
