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
  "orders",
  "order_items",
  "dues",
  "staff",
]);

const TABLE_PULL_ORDER = [
  "categories",
  "customers",
  "staff",
  "products",
  "orders",
  "order_items",
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
    "role",
    "phone",
    "email",
    "is_active",
    "version",
    "created_at",
    "updated_at",
    "_deleted",
    "synced_at",
  ]),
};

const BOOL_COLS = new Set(["_deleted", "is_active", "paid"]);

const normalizeRow = (row) => {
  const out = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (BOOL_COLS.has(k) && typeof v === "number") out[k] = Boolean(v);
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

    const rows = [];
    for (const table of TABLE_PULL_ORDER) {
      const result = await pool.query(
        `SELECT * FROM "${table}" WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT $2 OFFSET $3`,
        [since, limit, offset],
      );
      for (const row of result.rows) {
        if (table === "staff") delete row.password;
        rows.push({ table, row });
      }
    }
    res.json({
      ok: true,
      rows,
      hasMore: rows.length >= limit,
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

    const row = normalizeRow(stripRow(table, rawRow));
    const incomingVersion = row.version ?? 0;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");

      // Check what's currently stored
      const existing = await client.query(
        `SELECT * FROM "${table}" WHERE id = $1`,
        [row.id],
      );
      const current = existing.rows[0];

      if (!current) {
        // ── INSERT (row doesn't exist yet) ────────────────────────────────
        const cols = Object.keys(row).filter((k) => k !== "synced_at");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const vals = cols.map((k) => row[k]);
        await client.query(
          `INSERT INTO "${table}" (${colList}, synced_at)
           VALUES (${placeholders}, NOW())`,
          vals,
        );
      } else {
        // ── MERGE (row exists) ────────────────────────────────────────────
        const currentVersion = current.version ?? 0;

        // Build the merged row: start from current, apply incoming fields
        // For PATCH (changedFields set): only apply the listed fields
        // For PUT (changedFields null): apply all fields if incoming version wins
        const merged = { ...current };

        if (changedFields && changedFields.length > 0) {
          // Field-level merge: each field independently decides winner
          for (const field of changedFields) {
            if (field in row && field !== "id" && field !== "synced_at") {
              // Field wins if incoming version >= current version
              // (equal version is ok — different field, no real conflict)
              if (incomingVersion >= currentVersion) {
                merged[field] = row[field];
              }
            }
          }
          // Always advance version to max of the two
          merged.version = Math.max(currentVersion, incomingVersion);
          // updated_at = most recent of the two
          if (row.updated_at && row.updated_at > current.updated_at) {
            merged.updated_at = row.updated_at;
          }
        } else {
          // Legacy PUT: whole-row replace if incoming version wins
          if (incomingVersion > currentVersion) {
            Object.assign(merged, row);
            merged.version = incomingVersion;
          } else if (incomingVersion === currentVersion) {
            // Tiebreak by timestamp
            if (row.updated_at && row.updated_at > current.updated_at) {
              Object.assign(merged, row);
            }
          }
          // else: current wins, keep merged as-is
        }

        // Write the merged result back
        const updateCols = Object.keys(merged).filter(
          (k) => k !== "id" && k !== "synced_at" && k !== "created_at",
        );
        const setClause = updateCols
          .map((c, i) => `"${c}" = $${i + 2}`)
          .join(", ");
        const vals = [row.id, ...updateCols.map((k) => merged[k])];
        await client.query(
          `UPDATE "${table}" SET ${setClause}, synced_at = NOW() WHERE id = $1`,
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
    console.error(`upsertRow [${table}]:`, err.message);
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

// ─────────────────────────────────────────────────────────────────────────────
//  LICENSE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// ── Activate ──────────────────────────────────────────────────────────────────
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

    // Already activated on this exact machine — idempotent
    if (current && current === machine_id)
      return res.json({ ok: true, expires_at: lic.expires_at });

    // Activated on a different machine — reject
    if (current && current !== machine_id)
      return res.status(403).json({
        ok: false,
        error: `License already activated on another ${platform} device. Deactivate it first.`,
      });

    // Not yet activated for this platform — bind now
    await pool.query(
      `UPDATE licenses SET ${col} = $1, ${col_at} = NOW() WHERE key = $2`,
      [machine_id, key],
    );
    res.json({ ok: true, expires_at: lic.expires_at });
  } catch (err) {
    console.error("/license/activate:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Verify ────────────────────────────────────────────────────────────────────
//
// FIX: previously returned ok:true when machine_id was NULL (unbound).
// This meant any device that had a key in storage — even one that was never
// explicitly activated — would pass verification and open the app.
//
// NEW RULE: machine_id MUST be bound AND must match the caller.
// If unbound → 403, tell the client to activate first.
// This forces the license screen to appear for any unactivated device.
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

    // FIX: unbound = not activated yet = must go through /activate first
    if (!current) {
      return res.status(403).json({
        ok: false,
        error:
          "License not activated on this device. Please enter your license key.",
        reason: "not_activated",
      });
    }

    // Bound to a different machine
    if (current !== machine_id) {
      return res.status(403).json({
        ok: false,
        error:
          "License not valid for this device. Please activate on this device first.",
        reason: "wrong_device",
      });
    }

    // Match — refresh timestamp
    await pool.query(
      `UPDATE licenses SET last_verified_at = NOW() WHERE key = $1`,
      [key],
    );
    res.json({ ok: true, expires_at: lic.expires_at, bound: true });
  } catch (err) {
    console.error("/license/verify:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Deactivate ────────────────────────────────────────────────────────────────
// Knowing the key is sufficient proof of ownership.
// We allow deactivation even if machine_id changed (e.g. after reinstall).
app.post("/license/deactivate", async (req, res) => {
  const { key, machine_id, platform } = req.body;
  if (!key || !platform)
    return res
      .status(400)
      .json({ ok: false, error: "Missing key or platform" });

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

    if (lic[col] && machine_id && lic[col] !== machine_id) {
      console.warn(
        `[license] deactivate: key ${key} bound to ${lic[col]}, ` +
          `requested by ${machine_id} — allowing (key ownership proven)`,
      );
    }

    await pool.query(
      `UPDATE licenses SET ${col} = NULL, ${col_at} = NULL WHERE key = $1`,
      [key],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("/license/deactivate:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = parseInt(process.env.PORT ?? "3001");
app.listen(PORT, () =>
  console.log(`✅ Store sync backend running on port ${PORT}`),
);
