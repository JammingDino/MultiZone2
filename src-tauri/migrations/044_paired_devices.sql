-- Paired devices and the pairing attempt log (0.17.0).
--
-- Until now the API had exactly one credential: a bearer token generated in
-- Settings and copy-pasted into a shell. That survives one person and one
-- terminal. It does not survive a phone — it is long, it is typed by hand, it
-- is the same secret on every device that holds it, and revoking it signs out
-- everything at once.
--
-- A device is therefore a row rather than a share of one secret. Pairing mints
-- a token for *that* device; the desktop keeps only its hash, so a copy of this
-- database is not a set of working credentials. Revoking is a timestamp on one
-- row, which is what makes "a lost phone is one tap" and "it just works next
-- time" the same feature rather than opposing ones.
--
-- The static token in `app_settings.apiToken` is untouched and still works: it
-- is what a script on the same machine uses, and breaking it to add phones
-- would be trading one working thing for another.

CREATE TABLE IF NOT EXISTS paired_devices (
  id           TEXT PRIMARY KEY,
  -- What the user sees in the device list. Sent by the device at pairing time
  -- and editable after, because "Pixel 8" is a better answer than a UUID and a
  -- worse one than "my phone".
  name         TEXT NOT NULL,
  -- android / ios / web / desktop / other. Free text on purpose: this is a
  -- label in a list, not a capability check, and an unknown platform should
  -- show up as itself rather than be rejected at the door.
  platform     TEXT NOT NULL DEFAULT 'other',
  -- SHA-256 of the bearer token, hex. Never the token: the desktop has no
  -- reason to be able to reproduce a credential it already handed out, and a
  -- stolen database should not be a stolen phone.
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  -- Updated at most once a minute by the auth path — the point is "was this
  -- device around today", not a write on every request.
  last_seen_at INTEGER,
  -- The address it was last seen from, so a device list on a shared network is
  -- checkable against what the user expects.
  last_seen_ip TEXT,
  -- Set rather than deleted: a revoked device should stay visible long enough
  -- for the user to see that the revoke worked.
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_paired_devices_token ON paired_devices(token_hash);

-- Every pairing attempt, accepted or not.
--
-- Pairing is the only unauthenticated write on the surface, which is exactly
-- the reason to write down who tried. A user who opens the pairing dialog and
-- sees three failed attempts from an address they do not recognise has learned
-- something no counter would have told them.
CREATE TABLE IF NOT EXISTS pairing_attempts (
  id          TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  device_name TEXT,
  ok          INTEGER NOT NULL,
  -- Why it was refused, in words: "no pairing window open", "code expired",
  -- "wrong code", "too many attempts".
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairing_attempts_at ON pairing_attempts(created_at DESC);
