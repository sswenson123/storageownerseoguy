-- One-hour links that open Stripe's hosted billing portal (update card, invoices, switch or cancel plan).
-- Only the SHA-256 of each link token is stored. Links are emailed only to the address on file.
CREATE TABLE portal_tokens (
  token_hash TEXT PRIMARY KEY,
  ref        TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_portal_tokens_ref ON portal_tokens(ref);
