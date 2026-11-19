-- Signup Worker database (Cloudflare D1 / SQLite). Apply with:
--   npx wrangler d1 migrations apply sosg-signups --remote
-- Personal data lives only here and in the private R2 bucket — never in the repo.

CREATE TABLE signups (
  ref                 TEXT PRIMARY KEY,            -- SOSG-YYYYMMDD-xxxxxx (unpredictable suffix)
  token_hash          TEXT NOT NULL,               -- SHA-256 of the customer's bearer/resume token
  token_expires_at    TEXT NOT NULL,
  status              TEXT NOT NULL,               -- awaiting_email_verification | email_verified | signing | signed |
                                                   -- submitted_no_payment | payment_processing | paid | superseded
  agreement_id        TEXT NOT NULL UNIQUE,        -- AGR-YYYYMMDD-XXXXXXXX, made by the Worker
  agreement_version   TEXT NOT NULL,               -- frozen at /api/sign/start
  agreement_sha256    TEXT NOT NULL,               -- frozen at /api/sign/start (Worker's own copy of the text)
  info_json           TEXT NOT NULL,               -- Step 1 details, frozen at /api/sign/start
  email               TEXT NOT NULL,
  invite_id           TEXT,
  invite_json         TEXT,
  email_verified_at   TEXT,
  signing_lease       TEXT,
  signing_started_at  TEXT,
  signed_at           TEXT,
  signer_name         TEXT,
  signer_title        TEXT,
  consent_json        TEXT,
  pdf_key             TEXT,
  pdf_sha256          TEXT,
  pdf_bytes           INTEGER,
  audit_head          TEXT,
  quote_json          TEXT,
  approval_json       TEXT,
  checkout_session_id TEXT,
  payment_json        TEXT,
  superseded_by       TEXT,
  created_ip          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_signups_email ON signups(email);
CREATE INDEX idx_signups_session ON signups(checkout_session_id);
CREATE INDEX idx_signups_status_created ON signups(status, created_at);

-- Once signed, the signature, document and frozen details can never change.
CREATE TRIGGER signups_signed_immutable BEFORE UPDATE ON signups
WHEN OLD.signed_at IS NOT NULL AND (
  NEW.signed_at IS NOT OLD.signed_at OR NEW.signer_name IS NOT OLD.signer_name OR NEW.signer_title IS NOT OLD.signer_title OR
  NEW.pdf_key IS NOT OLD.pdf_key OR NEW.pdf_sha256 IS NOT OLD.pdf_sha256 OR NEW.agreement_sha256 IS NOT OLD.agreement_sha256 OR
  NEW.agreement_version IS NOT OLD.agreement_version OR NEW.agreement_id IS NOT OLD.agreement_id OR NEW.info_json IS NOT OLD.info_json OR
  NEW.consent_json IS NOT OLD.consent_json OR NEW.email IS NOT OLD.email)
BEGIN
  SELECT RAISE(ABORT, 'signed record is immutable');
END;

CREATE TRIGGER signups_signed_no_delete BEFORE DELETE ON signups
WHEN OLD.signed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'signed record cannot be deleted');
END;

-- Append-only audit trail, hash-chained per signup (UNIQUE(ref, prev_hash) stops forks from races).
CREATE TABLE audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ref        TEXT NOT NULL,
  at         TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  UNIQUE (ref, prev_hash)
);
CREATE INDEX idx_audit_ref ON audit(ref, seq);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only');
END;

-- Unsigned, abandoned signups may be purged (privacy); a signed signup's trail never can.
CREATE TRIGGER audit_no_delete_signed BEFORE DELETE ON audit
WHEN (SELECT signed_at FROM signups WHERE ref = OLD.ref) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'audit of a signed agreement cannot be deleted');
END;

CREATE TABLE email_codes (
  ref        TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,                        -- HMAC-SHA256(OTP_SECRET, ref:code); the code itself is never stored
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,
  sent_at    TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE revoked_invites (
  invite_id  TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL,
  reason     TEXT
);

CREATE TABLE stripe_events (
  id          TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE unmatched_payments (
  session_id  TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  detail      TEXT NOT NULL
);
