// sync-backend/server.js
// UPDATED: Added order_payments to ALLOWED_TABLES, TABLE_PULL_ORDER, and TABLE_COLUMNS

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
  if (req.path === "/health" || req.path.startsWith("/license")) return next();

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

// ── Tables & column whitelist ─────────────────────────────────────────────────
const ALLOWED_TABLES = new Set([
  "categories",
  "products",
  "customers",
  "roles",
  "orders",
  "order_items",
  "order_payments",
  "dues",
  "staff",
]);

const TABLE_PULL_ORDER = [
  "categories",
  "customers",
  "roles",
  "staff",
  "products",
  "orders",
  "order_items",
  "order_payments",
  "dues",
];

const TABLE_COLUMNS = {
  categories: new Set([
    "id",
    "name",
    "description",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
  products: new Set([
    "id",
    "name",
    "description",
    "category_id",
    "barcode",
    "buy_price",
    "sell_price",
    "currency",
    "stock",
    "min_stock",
    "unit",
    "image_url",
    "is_active",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
  customers: new Set([
    "id",
    "name",
    "phone",
    "address",
    "notes",
    "total_orders",
    "total_spent",
    "last_order",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
  orders: new Set([
    "id",
    "customer_id",
    "order_date",
    "status",
    "total_sp",
    "total_usd",
    "paid_amount",
    "display_currency",
    "notes",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
  order_items: new Set([
    "id",
    "order_id",
    "product_id",
    "product_name",
    "quantity",
    "sell_price_at_sale",
    "currency_at_sale",
    "line_total_sp",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
  // ── NEW ──
  order_payments: new Set([
    "id",
    "order_id",
    "amount",
    "currency",
    "amount_sp",
    "note",
    "paid_at",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
  dues: new Set([
    "id",
    "customer_id",
    "order_id",
    "amount",
    "currency",
    "amount_sp",
    "description",
    "due_date",
    "paid",
    "paid_at",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
  staff: new Set([
    "id",
    "full_name",
    "username",
    "password",
    "pin",
    "role",
    "role_id", // ← ADD
    "last_login", // ← ADD
    "phone",
    "email",
    "is_active",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
  roles: new Set([
    "id",
    "name",
    "permissions",
    "is_system",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
};

const BOOL_COLS = new Set(["_deleted", "is_active", "paid", "is_system"]);

const TIMESTAMP_COLS = new Set([
  "created_at",
  "updated_at",
  "paid_at",
  "last_login",
  "order_date",
  "last_order",
  "synced_at",
  "queued_at",
]);

// Coerce a single value to the correct JS type for pg to handle
const coerce = (col, val) => {
  // NULL passthrough
  if (val === null || val === undefined) return null;

  // Boolean columns — SQLite sends 0/1 or "0"/"1"
  if (BOOL_COLS.has(col)) {
    if (val === true || val === 1 || val === "1" || val === "true") return true;
    if (val === false || val === 0 || val === "0" || val === "false")
      return false;
    return null;
  }

  // Timestamp columns — SQLite sends "2026-05-09 09:34:46" (no timezone)
  // Convert to JS Date so pg sends it as a proper timestamptz
  if (TIMESTAMP_COLS.has(col) && typeof val === "string" && val.trim() !== "") {
    // Replace space separator with T, append Z if no offset present
    const iso = val.includes("T") ? val : val.replace(" ", "T");
    const withTz =
      iso.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + "Z";
    const d = new Date(withTz);
    return isNaN(d.getTime()) ? null : d;
  }

  return val;
};

// Coerce all fields in a row object
const coerceRow = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = coerce(k, v);
  }
  return out;
};

const coerceBool = (v) => {
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  return null;
};

const normalizeRow = (row) => {
  const out = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (BOOL_COLS.has(k)) {
      if (v === true || v === 1 || v === "1" || v === "true") out[k] = true;
      else if (v === false || v === 0 || v === "0" || v === "false")
        out[k] = false;
      else out[k] = Boolean(v);
    }
  }
  return out;
};

const stripRow = (table, row) => {
  const allowed = TABLE_COLUMNS[table];
  if (!allowed) return row;
  return Object.fromEntries(
    Object.entries(row).filter(([k]) => allowed.has(k)),
  );
};

const guardTable = (name, res) => {
  if (!ALLOWED_TABLES.has(name)) {
    res.status(400).json({ ok: false, error: `Unknown table: ${name}` });
    return false;
  }
  return true;
};

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

// ── Pull ──────────────────────────────────────────────────────────────────────
app.get("/changes", async (req, res) => {
  try {
    const since = req.query.since ?? "1970-01-01T00:00:00.000Z";
    const limit = Math.min(parseInt(req.query.limit ?? "200"), 1000);
    const offset = parseInt(req.query.offset ?? "0");
    const allRows = [];
    for (const table of TABLE_PULL_ORDER) {
      const result = await pool.query(
        `SELECT * FROM "${table}" WHERE synced_at > $1 ORDER BY synced_at ASC`,
        [since],
      );
      for (const row of result.rows) {
        if (table === "staff") delete row.password;
        allRows.push({ table, row });
      }
    }

    const page = allRows.slice(offset, offset + limit);
    res.json({
      ok: true,
      rows: page,
      hasMore: offset + limit < allRows.length,
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("GET /changes:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Upsert ────────────────────────────────────────────────────────────────────
async function upsertRow(table, rawRow, res, changedFields = null) {
  try {
    if (!rawRow || rawRow.id === undefined || rawRow.id === null)
      return res.status(400).json({ ok: false, error: "Missing row.id" });

    // 1. Strip columns not in whitelist, then coerce types
    const stripped = stripRow(table, rawRow);
    const row = coerceRow(stripped);
    const incomingVersion = row.version ?? 0;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");

      // 2. Check if row already exists
      const existing = await client.query(
        `SELECT * FROM "${table}" WHERE id = $1`,
        [row.id],
      );
      const current = existing.rows[0];

      if (!current) {
        // ── INSERT ─────────────────────────────────────────────────────────
        const cols = Object.keys(row).filter((k) => k !== "synced_at");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const vals = cols.map((k) => row[k]);

        await client.query(
          `INSERT INTO "${table}" (${colList}, synced_at)
           VALUES (${placeholders}, NOW())
           ON CONFLICT (id) DO UPDATE
             SET ${cols
               .filter((c) => c !== "id" && c !== "created_at")
               .map((c) => {
                 const idx = cols.indexOf(c) + 1;
                 return `"${c}" = $${idx}`;
               })
               .join(", ")},
             synced_at = NOW()`,
          vals,
        );
      } else {
        // ── UPDATE (merge) ─────────────────────────────────────────────────
        const currentVersion = current.version ?? 0;

        // Start from current DB row, then apply changes
        const merged = { ...current };

        if (changedFields !== null && changedFields.length > 0) {
          // Field-level merge: only overwrite fields the sender changed
          for (const field of changedFields) {
            if (field in row && field !== "id" && field !== "synced_at") {
              merged[field] = row[field];
            }
          }
          merged.version = Math.max(currentVersion, incomingVersion) + 1;
          merged.updated_at = new Date();
        } else {
          // Version-based full merge
          if (incomingVersion > currentVersion) {
            Object.assign(merged, row);
            merged.version = incomingVersion;
          } else if (incomingVersion === currentVersion) {
            // Tie-break on updated_at
            const remoteUpdated = row.updated_at
              ? new Date(row.updated_at)
              : null;
            const localUpdated = current.updated_at
              ? new Date(current.updated_at)
              : null;
            if (remoteUpdated && localUpdated && remoteUpdated > localUpdated) {
              Object.assign(merged, row);
            }
            // else local wins — no change
          }
          // incomingVersion < currentVersion → local wins, no change
        }

        // Coerce merged row (current DB values may need no coercion,
        // but applied remote values do)
        const coercedMerged = coerceRow(merged);

        const updateCols = Object.keys(coercedMerged).filter(
          (k) => k !== "id" && k !== "synced_at" && k !== "created_at",
        );

        const setClause = updateCols
          .map((c, i) => `"${c}" = $${i + 2}`)
          .join(", ");

        const vals = [row.id, ...updateCols.map((k) => coercedMerged[k])];

        await client.query(
          `UPDATE "${table}"
           SET ${setClause}, synced_at = NOW()
           WHERE id = $1`,
          vals,
        );
      }

      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`upsertRow [${table}]:`, err.message, JSON.stringify(rawRow));
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post("/:table", async (req, res) => {
  if (!guardTable(req.params.table, res)) return;
  await upsertRow(req.params.table, req.body, res, null);
});

app.put("/:table/:id", async (req, res) => {
  if (!guardTable(req.params.table, res)) return;
  await upsertRow(
    req.params.table,
    { ...req.body, id: req.params.id },
    res,
    null,
  );
});

app.patch("/:table/:id", async (req, res) => {
  if (!guardTable(req.params.table, res)) return;
  const { _changed_fields, ...body } = req.body;
  await upsertRow(
    req.params.table,
    { ...body, id: req.params.id },
    res,
    _changed_fields ?? null,
  );
});

app.delete("/:table/:id", async (req, res) => {
  const { table, id } = req.params;
  if (!guardTable(table, res)) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `UPDATE "${table}" SET _deleted = TRUE, version = version + 1,
       updated_at = NOW(), synced_at = NOW() WHERE id = $1`,
      [id],
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`DELETE /${table}/${id}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ── LICENSE ENDPOINTS ─────────────────────────────────────────────────────────
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
      used: (
        await pool.query(
          `SELECT COUNT(*) as n FROM license_devices WHERE license_key = $1`,
          [key],
        )
      ).rows[0].n,
      max: lic.max_devices,
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
// Protect with a separate admin secret — never exposed to clients
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
    const { key, max_devices = 2, expires_at = null, notes = null } = req.body;

    if (!key?.trim())
      return res.status(400).json({ ok: false, error: "key is required" });

    await pool.query(
      `INSERT INTO licenses (key, max_devices, expires_at, is_active)
       VALUES ($1, $2, $3, TRUE)`,
      [key.trim(), max_devices, expires_at],
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
      "staff.manage": true,
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
      "staff.manage": false,
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
