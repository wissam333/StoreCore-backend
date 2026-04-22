// sync-backend/server.js
// Store App sync backend — Express + PostgreSQL
// Handles: push (POST/PUT/DELETE), pull (GET /changes), license management.
//
// ENV variables required:
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS
//   SYNC_TOKEN   — Bearer token clients must send
//   PORT         — defaults to 3001

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import pg from "pg";
import cors from "cors";

const { Pool } = pg;
const app = express();

// ── DB pool ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? "5432"),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl: { rejectUnauthorized: false },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

// Auth middleware — skip /health and /license/* routes
app.use((req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/license")) return next();
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (process.env.SYNC_TOKEN && token !== process.env.SYNC_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// ── Whitelist of synced tables ────────────────────────────────────────────────
const ALLOWED_TABLES = new Set([
  "categories",
  "products",
  "customers",
  "orders",
  "order_items",
  "dues",
  "staff",
]);

function guardTable(name, res) {
  if (!ALLOWED_TABLES.has(name)) {
    res.status(400).json({ ok: false, error: `Unknown table: ${name}` });
    return false;
  }
  return true;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

// ── PULL: GET /changes?since=ISO&limit=200&offset=0 ───────────────────────────
// Returns rows from all synced tables updated after `since`.
app.get("/changes", async (req, res) => {
  try {
    const since = req.query.since ?? "1970-01-01T00:00:00.000Z";
    const limit = Math.min(parseInt(req.query.limit ?? "200"), 1000);
    const offset = parseInt(req.query.offset ?? "0");

    const rows = [];
    await Promise.all(
      [...ALLOWED_TABLES].map(async (table) => {
        const result = await pool.query(
          `SELECT * FROM "${table}" WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT $2 OFFSET $3`,
          [since, limit, offset],
        );
        for (const row of result.rows) rows.push({ table, row });
      }),
    );

    // Sort all rows by updated_at so client applies them in order
    rows.sort(
      (a, b) => new Date(a.row.updated_at) - new Date(b.row.updated_at),
    );

    res.json({ ok: true, rows, hasMore: rows.length >= limit });
  } catch (err) {
    console.error("GET /changes:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── UPSERT helper ─────────────────────────────────────────────────────────────
async function upsertRow(table, row, res) {
  try {
    if (!row || !row.id) {
      return res.status(400).json({ ok: false, error: "Missing row.id" });
    }

    const cols = Object.keys(row).filter((k) => k !== "synced_at");
    const vals = cols.map((k) => row[k]);

    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const setClauses = cols
      .filter((c) => c !== "id")
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(", ");

    await pool.query(
      `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET ${setClauses}, synced_at = NOW()`,
      vals,
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(`upsertRow [${table}]:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── PUSH: POST /:table ────────────────────────────────────────────────────────
app.post("/:table", async (req, res) => {
  const { table } = req.params;
  if (!guardTable(table, res)) return;
  await upsertRow(table, req.body, res);
});

// ── PUSH: PUT /:table/:id ─────────────────────────────────────────────────────
app.put("/:table/:id", async (req, res) => {
  const { table, id } = req.params;
  if (!guardTable(table, res)) return;
  // Merge id from URL in case body omits it
  await upsertRow(table, { ...req.body, id: Number(id) }, res);
});

// ── PUSH: DELETE /:table/:id (soft-delete) ────────────────────────────────────
app.delete("/:table/:id", async (req, res) => {
  const { table, id } = req.params;
  if (!guardTable(table, res)) return;
  try {
    await pool.query(
      `UPDATE "${table}" SET _deleted = TRUE, updated_at = NOW(), synced_at = NOW() WHERE id = $1`,
      [id],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(`DELETE /${table}/${id}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  LICENSE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /license/activate
app.post("/license/activate", async (req, res) => {
  const { key, machine_id, platform } = req.body;
  // platform = 'desktop' | 'mobile'
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

    // Already bound to a different device
    if (current && current !== machine_id)
      return res
        .status(403)
        .json({
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

// POST /license/verify
app.post("/license/verify", async (req, res) => {
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
    const current = lic[col];

    if (!current)
      return res
        .status(403)
        .json({ ok: false, error: "Not activated on this platform yet" });
    if (current !== machine_id)
      return res
        .status(403)
        .json({ ok: false, error: "License not valid for this device" });

    res.json({ ok: true, expires_at: lic.expires_at });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /license/deactivate — release machine so user can move to new PC
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

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3001");
app.listen(PORT, () => {
  console.log(`✅ Store sync backend running on port ${PORT}`);
});
