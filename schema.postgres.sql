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

DO $$ BEGIN
  ALTER TABLE licenses ADD COLUMN sync_enabled  BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE licenses ADD COLUMN supabase_url  TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE licenses ADD COLUMN supabase_key  TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Any existing keys keep sync=false until you explicitly enable it per customer
UPDATE licenses SET sync_enabled = FALSE WHERE sync_enabled IS NULL;

-- license_devices table (if your DB was created before this table existed)
CREATE TABLE IF NOT EXISTS license_devices (
  id           BIGSERIAL    PRIMARY KEY,
  license_key  TEXT         NOT NULL REFERENCES licenses(key) ON DELETE CASCADE,
  machine_id   TEXT         NOT NULL,
  platform     TEXT,
  label        TEXT,
  activated_at TIMESTAMPTZ  DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(license_key, machine_id)
);
CREATE INDEX IF NOT EXISTS idx_license_devices_key ON license_devices(license_key);