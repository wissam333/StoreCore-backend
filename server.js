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

// ── LICENSE ENDPOINTS ─────────────────────────────────────────────────────────

app.post("/license/activate", async (req, res) => {
  const { key, machine_id, platform, label } = req.body;
  if (!key || !machine_id || !platform)
    return res
      .status(400)
      .json({ ok: false, error: "Missing key, machine_id or platform" });

  try {
    // Load license
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

    // Check if this device is already registered (re-activation = just update last_seen)
    const { rows: existing } = await pool.query(
      `SELECT * FROM license_devices WHERE license_key = $1 AND machine_id = $2`,
      [key, machine_id],
    );

    if (existing.length > 0) {
      // Already registered — update last_seen and platform in case it changed
      await pool.query(
        `UPDATE license_devices SET last_seen_at = NOW(), platform = $1 WHERE license_key = $2 AND machine_id = $3`,
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

    // New device — check slot count
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

    // Register the new device
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

    // Check this device is registered
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

    // Update last_seen
    await pool.query(
      `UPDATE license_devices SET last_seen_at = NOW() WHERE license_key = $1 AND machine_id = $2`,
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
  const { key, machine_id, platform } = req.body;
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
app.get("/admin/licenses", adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.*,
        COUNT(d.id) as used_slots
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
    if (sync_enabled && (!supabase_url || !supabase_key))
      return res.status(400).json({
        ok: false,
        error: "supabase_url and supabase_key required when sync_enabled=true",
      });

    if (!key?.trim())
      return res.status(400).json({ ok: false, error: "key is required" });

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

// Update max_devices or is_active on a license
app.patch("/admin/licenses/:key", adminAuth, async (req, res) => {
  try {
    const { max_devices, is_active, expires_at } = req.body;
    const updates = [];
    const vals = [];
    let i = 1;

    if (max_devices !== undefined) {
      updates.push(`max_devices = $${i++}`);
      vals.push(max_devices);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${i++}`);
      vals.push(is_active);
    }
    if (expires_at !== undefined) {
      updates.push(`expires_at = $${i++}`);
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

// ── Seed endpoint — idempotent, safe to call multiple times ──────────────────
app.post("/admin/seed", adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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

    // Wipe all staff first
    await client.query(`DELETE FROM staff`);

    // Upsert Administrator role with fixed ID
    await client.query(
      `
      INSERT INTO roles (id, name, permissions, is_system, version, created_at, updated_at, _deleted)
      VALUES ($1, 'Administrator', $2, TRUE, 1, NOW(), NOW(), FALSE)
      ON CONFLICT (id) DO UPDATE SET
        name        = 'Administrator',
        permissions = $2,
        is_system   = TRUE,
        updated_at  = NOW(),
        _deleted    = FALSE,
        synced_at   = NOW()
    `,
      [ADMIN_ROLE_ID, JSON.stringify(ADMIN_PERMISSIONS)],
    );

    // Upsert Cashier role with fixed ID
    await client.query(
      `
      INSERT INTO roles (id, name, permissions, is_system, version, created_at, updated_at, _deleted)
      VALUES ($1, 'Cashier', $2, FALSE, 1, NOW(), NOW(), FALSE)
      ON CONFLICT (id) DO UPDATE SET
        name        = 'Cashier',
        permissions = $2,
        is_system   = FALSE,
        updated_at  = NOW(),
        _deleted    = FALSE,
        synced_at   = NOW()
    `,
      [CASHIER_ROLE_ID, JSON.stringify(CASHIER_PERMISSIONS)],
    );

    // Insert fresh admin staff
    await client.query(
      `
      INSERT INTO staff (id, full_name, username, password, role_id, role, is_active, version, created_at, updated_at, _deleted, synced_at)
      VALUES ($1, 'Admin', 'admin', 'admin', $2, 'Administrator', TRUE, 1, NOW(), NOW(), FALSE, NOW())
    `,
      [ADMIN_STAFF_ID, ADMIN_ROLE_ID],
    );

    await client.query("COMMIT");
    res.json({ ok: true, message: "Seeded successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("/admin/seed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// Revoke a specific device slot (admin forcefully removes it)
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

// Revoke ALL devices for a license (full reset)
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

const PORT = parseInt(process.env.PORT ?? "3001");
app.listen(PORT, () =>
  console.log(`✅ Store sync backend running on port ${PORT}`),
);
