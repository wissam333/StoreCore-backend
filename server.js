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

// ── Client IP + geo helper ─────────────────────────────────────────────────
// Simple in-memory IP geo cache (1 hour TTL)
const geoCache = new Map();
const GEO_TTL = 3600000;

const getClientInfo = async (req) => {
  const ip =
    (req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    null;
  let city = null, country = null, lat = null, lon = null;
  if (ip) {
    const cleanIp = ip.replace(/^::ffff:/, "");
    const cached = geoCache.get(cleanIp);
    if (cached && Date.now() - cached.ts < GEO_TTL) {
      return { ip: cleanIp, ...cached.data };
    }
    try {
      const res = await fetch(
        `http://ip-api.com/json/${cleanIp}?fields=status,lat,lon,city,country`,
        { signal: AbortSignal.timeout(3000) },
      );
      const data = await res.json();
      if (data.status === "success") {
        city = data.city ?? null;
        country = data.country ?? null;
        lat = data.lat ?? null;
        lon = data.lon ?? null;
        geoCache.set(cleanIp, { ts: Date.now(), data: { city, country, lat, lon } });
      }
    } catch {
      // IP geo failed silently — coords stay null
    }
  }
  return { ip, city, country, lat, lon };
};

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

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
app.post("/license/activate", async (req, res) => {
  const { key, machine_id, platform, label, device_model, os_version, app_version, lat, lon } = req.body;
  if (!key || !machine_id || !platform)
    return res.status(400).json({ ok: false, error: "Missing key, machine_id or platform" });

  let ci = await getClientInfo(req);
  if (lat != null && lon != null) { ci.lat = lat; ci.lon = lon; }

  try {
    const { rows: licRows } = await pool.query(
      `SELECT * FROM licenses WHERE key = $1`, [key],
    );
    const lic = licRows[0];
    if (!lic) return res.status(404).json({ ok: false, error: "Invalid license key" });
    if (!lic.is_active) return res.status(403).json({ ok: false, error: "License deactivated" });
    if (lic.expires_at && new Date(lic.expires_at) < new Date())
      return res.status(403).json({ ok: false, error: "License expired" });

    const { rows: existing } = await pool.query(
      `SELECT * FROM license_devices WHERE license_key = $1 AND machine_id = $2`,
      [key, machine_id],
    );

    if (existing.length > 0) {
      await pool.query(
        `UPDATE license_devices SET last_seen_at = NOW(), platform = $1,
            device_model = COALESCE($2, device_model),
            os_version   = COALESCE($3, os_version),
            app_version  = COALESCE($4, app_version),
            last_ip      = $5,
            last_city    = COALESCE($6, last_city),
            last_country = COALESCE($7, last_country),
            last_lat     = COALESCE($8, last_lat),
            last_lon     = COALESCE($9, last_lon)
         WHERE license_key = $10 AND machine_id = $11`,
        [platform, device_model ?? null, os_version ?? null, app_version ?? null,
         ci.ip, ci.city, ci.country, ci.lat, ci.lon, key, machine_id],
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
      `SELECT COUNT(*) as n FROM license_devices WHERE license_key = $1`, [key],
    );
    const usedSlots = parseInt(countRows[0].n);
    const maxDevices = lic.max_devices ?? 2;
    if (usedSlots >= maxDevices)
      return res.status(403).json({
        ok: false,
        error: `All ${maxDevices} device slots are used. Contact support to add more slots or deactivate an existing device.`,
        reason: "slots_full", used: usedSlots, max: maxDevices,
      });

    await pool.query(
      `INSERT INTO license_devices
         (license_key, machine_id, platform, label, device_model, os_version, app_version, last_ip, last_city, last_country, last_lat, last_lon)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (license_key, machine_id) DO UPDATE SET
         last_seen_at = NOW(),
         platform     = COALESCE($3,  license_devices.platform),
         device_model = COALESCE($5,  license_devices.device_model),
         os_version   = COALESCE($6,  license_devices.os_version),
         app_version  = COALESCE($7,  license_devices.app_version),
         last_ip      = $8,
         last_city    = COALESCE($9,  license_devices.last_city),
         last_country = COALESCE($10, license_devices.last_country),
         last_lat     = COALESCE($11, license_devices.last_lat),
         last_lon     = COALESCE($12, license_devices.last_lon)`,
      [key, machine_id, platform, label ?? null,
       device_model ?? null, os_version ?? null, app_version ?? null,
       ci.ip, ci.city, ci.country, ci.lat, ci.lon],
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
    console.error("/license/activate:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── VERIFY ───────────────────────────────────────────────────────────────────
app.post("/license/verify", async (req, res) => {
  const { key, machine_id, platform, device_model, os_version, app_version, lat, lon } = req.body;
  if (!key || !machine_id || !platform)
    return res.status(400).json({ ok: false, error: "Missing fields" });

  let ci = await getClientInfo(req);
  if (lat != null && lon != null) { ci.lat = lat; ci.lon = lon; }

  try {
    const { rows: licRows } = await pool.query(
      `SELECT * FROM licenses WHERE key = $1`, [key],
    );
    const lic = licRows[0];
    if (!lic) return res.status(404).json({ ok: false, error: "Invalid license key" });
    if (!lic.is_active) return res.status(403).json({ ok: false, error: "License deactivated" });
    if (lic.expires_at && new Date(lic.expires_at) < new Date())
      return res.status(403).json({ ok: false, error: "License expired" });

    const { rows: deviceRows } = await pool.query(
      `SELECT * FROM license_devices WHERE license_key = $1 AND machine_id = $2`,
      [key, machine_id],
    );
    if (deviceRows.length === 0)
      return res.status(403).json({ ok: false, error: "This device is not activated. Please enter your license key.", reason: "not_activated" });

    await pool.query(
      `UPDATE license_devices SET last_seen_at = NOW(),
          platform     = COALESCE($3,  license_devices.platform),
          device_model = COALESCE($4,  license_devices.device_model),
          os_version   = COALESCE($5,  license_devices.os_version),
          app_version  = COALESCE($6,  license_devices.app_version),
          last_ip      = $7,
          last_city    = COALESCE($8,  license_devices.last_city),
          last_country = COALESCE($9,  license_devices.last_country),
          last_lat     = COALESCE($10, license_devices.last_lat),
          last_lon     = COALESCE($11, license_devices.last_lon)
       WHERE license_key = $1 AND machine_id = $2`,
      [key, machine_id, platform ?? null,
       device_model ?? null, os_version ?? null, app_version ?? null,
       ci.ip, ci.city, ci.country, ci.lat, ci.lon],
    );
    await pool.query(`UPDATE licenses SET last_verified_at = NOW() WHERE key = $1`, [key]);

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

// List all licenses with device counts and location data
app.get("/admin/licenses", adminAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.*, COUNT(d.id) as used_slots,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'machine_id', d.machine_id,
              'platform', d.platform,
              'label', d.label,
              'device_model', d.device_model,
              'os_version', d.os_version,
              'app_version', d.app_version,
              'last_lat', d.last_lat,
              'last_lon', d.last_lon,
              'last_city', d.last_city,
              'last_country', d.last_country,
              'activated_at', d.activated_at,
              'last_seen_at', d.last_seen_at
            )
          ) FILTER (WHERE d.id IS NOT NULL),
          '[]'::jsonb
        ) as devices
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

    const base = `${lic.supabase_url}/rest/v1`;
    const headers = {
      "Content-Type": "application/json",
      apikey: lic.supabase_key,
      Authorization: `Bearer ${lic.supabase_key}`,
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
        },
        {
          id: CASHIER_ROLE_ID,
          name: "Cashier",
          is_system: false,
          version: 1,
          permissions: CASHIER_PERMISSIONS,
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

    res.json({ ok: true, message: "Seeded successfully" });
  } catch (err) {
    console.error("/admin/seed-supabase:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = parseInt(process.env.PORT ?? "3001");
app.listen(PORT, () =>
  console.log(`✅ License server running on port ${PORT}`),
);
