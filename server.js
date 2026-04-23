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

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

// ── Auth ──────────────────────────────────────────────────────────────────────
// Only checks: key is known, active, and not expired.
// machine_id is NOT checked here — that's the job of /license/verify.
// Reason: after a reinstall the device activates → sync must work immediately.
// If we checked machine_id here, the first sync after a fresh install on a
// new device would fail until /verify was separately called.
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
  "orders",
  "order_items",
  "dues",
  "staff",
]);

// Parent-before-child order for /changes pull — client applies in this order
// so FK refs are always satisfied.
const TABLE_PULL_ORDER = [
  "categories",
  "customers",
  "staff",
  "products",
  "orders",
  "order_items",
  "dues",
];

// Only real stored columns — strips computed JOIN columns like category_name,
// customer_name, item_count, current_stock that the local IPC adds via SELECT.
const TABLE_COLUMNS = {
  categories: new Set([
    "id",
    "name",
    "description",
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
    "role",
    "phone",
    "email",
    "is_active",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
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

// ── PULL ──────────────────────────────────────────────────────────────────────
app.get("/changes", async (req, res) => {
  try {
    const since = req.query.since ?? "1970-01-01T00:00:00.000Z";
    const limit = Math.min(parseInt(req.query.limit ?? "200"), 1000);
    const offset = parseInt(req.query.offset ?? "0");

    const rows = [];
    // Sequential in FK order — parents always come before children
    for (const table of TABLE_PULL_ORDER) {
      const result = await pool.query(
        `SELECT * FROM "${table}" WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT $2 OFFSET $3`,
        [since, limit, offset],
      );
      for (const row of result.rows) {
        if (table === "staff") delete row.password; // never send passwords
        rows.push({ table, row });
      }
    }

    res.json({ ok: true, rows, hasMore: rows.length >= limit });
  } catch (err) {
    console.error("GET /changes:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── UPSERT ────────────────────────────────────────────────────────────────────
async function upsertRow(table, rawRow, res) {
  try {
    if (!rawRow || rawRow.id === undefined || rawRow.id === null)
      return res.status(400).json({ ok: false, error: "Missing row.id" });

    const row = stripRow(table, rawRow); // remove computed columns
    const cols = Object.keys(row).filter((k) => k !== "synced_at");
    if (cols.length === 0)
      return res.status(400).json({ ok: false, error: "No valid columns" });

    const vals = cols.map((k) => row[k]);
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const setClauses = cols
      .filter((c) => c !== "id")
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(", ");

    // DEFERRED constraints handle any remaining out-of-order FK arrivals
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})
         ON CONFLICT (id) DO UPDATE SET ${setClauses}, synced_at = NOW()`,
        vals,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(`upsertRow [${table}]:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

app.post("/:table", async (req, res) => {
  if (!guardTable(req.params.table, res)) return;
  await upsertRow(req.params.table, req.body, res);
});
app.put("/:table/:id", async (req, res) => {
  if (!guardTable(req.params.table, res)) return;
  await upsertRow(
    req.params.table,
    { ...req.body, id: Number(req.params.id) },
    res,
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
      `UPDATE "${table}" SET _deleted = TRUE, updated_at = NOW(), synced_at = NOW() WHERE id = $1`,
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

// ─────────────────────────────────────────────────────────────────────────────
//  LICENSE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

app.post("/license/activate", async (req, res) => {
  const { key, machine_id, platform } = req.body;
  if (!key || !machine_id || !platform)
    return res
      .status(400)
      .json({ ok: false, error: "Missing key, machine_id or platform" });
  try {
    const { rows } = await pool.query("SELECT * FROM licenses WHERE key = $1", [
      key,
    ]);
    const lic = rows[0];
    if (!lic)
      return res.status(404).json({ ok: false, error: "Invalid license key" });
    if (!lic.is_active)
      return res.status(403).json({ ok: false, error: "License deactivated" });
    if (lic.expires_at && new Date(lic.expires_at) < new Date())
      return res.status(403).json({ ok: false, error: "License expired" });

    const col =
      platform === "mobile" ? "machine_id_mobile" : "machine_id_desktop";
    const col_at =
      platform === "mobile" ? "activated_at_mobile" : "activated_at_desktop";
    const current = lic[col];

    // Allow same device to re-activate (reinstall case)
    if (current && current !== machine_id)
      return res.status(403).json({
        ok: false,
        error: `License already activated on another ${platform} device`,
      });

    await pool.query(
      `UPDATE licenses SET ${col} = $1, ${col_at} = NOW() WHERE key = $2`,
      [machine_id, key],
    );
    res.json({ ok: true, expires_at: lic.expires_at });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/license/verify", async (req, res) => {
  const { key, machine_id, platform } = req.body;
  if (!key || !machine_id || !platform)
    return res.status(400).json({ ok: false, error: "Missing fields" });
  try {
    const { rows } = await pool.query("SELECT * FROM licenses WHERE key = $1", [
      key,
    ]);
    const lic = rows[0];
    if (!lic)
      return res.status(404).json({ ok: false, error: "Invalid license key" });
    if (!lic.is_active)
      return res.status(403).json({ ok: false, error: "License deactivated" });
    if (lic.expires_at && new Date(lic.expires_at) < new Date())
      return res.status(403).json({ ok: false, error: "License expired" });

    const col =
      platform === "mobile" ? "machine_id_mobile" : "machine_id_desktop";
    const current = lic[col];

    // If not yet activated on this platform, auto-activate on first verify
    // This handles the case where the user enters the key offline and verifies
    // online for the first time
    if (!current) {
      await pool.query(
        `UPDATE licenses SET ${col} = $1, ${
          platform === "mobile" ? "activated_at_mobile" : "activated_at_desktop"
        } = NOW() WHERE key = $2`,
        [machine_id, key],
      );
      return res.json({ ok: true, expires_at: lic.expires_at });
    }

    if (current !== machine_id)
      return res
        .status(403)
        .json({ ok: false, error: "License not valid for this device" });

    res.json({ ok: true, expires_at: lic.expires_at });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/license/deactivate", async (req, res) => {
  const { key, machine_id, platform } = req.body;
  if (!key || !platform)
    return res.status(400).json({ ok: false, error: "Missing fields" });
  try {
    const { rows } = await pool.query("SELECT * FROM licenses WHERE key = $1", [
      key,
    ]);
    const lic = rows[0];
    if (!lic) return res.status(404).json({ ok: false, error: "Invalid key" });

    const col =
      platform === "mobile" ? "machine_id_mobile" : "machine_id_desktop";
    const col_at =
      platform === "mobile" ? "activated_at_mobile" : "activated_at_desktop";
    if (lic[col] && lic[col] !== machine_id)
      return res.status(403).json({ ok: false, error: "Not your license" });

    await pool.query(
      `UPDATE licenses SET ${col} = NULL, ${col_at} = NULL WHERE key = $1`,
      [key],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = parseInt(process.env.PORT ?? "3001");
app.listen(PORT, () =>
  console.log(`✅ Store sync backend running on port ${PORT}`),
);
