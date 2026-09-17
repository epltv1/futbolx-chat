CREATE TABLE IF NOT EXISTS profiles (
  username TEXT PRIMARY KEY,
  device_ip TEXT,
  is_owner INTEGER DEFAULT 0,
  is_mod INTEGER DEFAULT 0,
  is_muted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_profiles_ip ON profiles(device_ip);
