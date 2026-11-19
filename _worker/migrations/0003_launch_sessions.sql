-- Every monthly-billing Checkout Session the Worker opens. Only sessions listed here can start a
-- subscription; anything else that arrives from Stripe is flagged in unmatched_payments.
CREATE TABLE launch_sessions (
  session_id TEXT PRIMARY KEY,
  ref        TEXT NOT NULL,
  url        TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at  TEXT,                 -- set when Stripe reports it completed, failed or expired
  created_at TEXT NOT NULL
);
CREATE INDEX idx_launch_sessions_ref ON launch_sessions(ref, expires_at);
