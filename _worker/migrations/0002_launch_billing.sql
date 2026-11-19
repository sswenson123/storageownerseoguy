-- Launch-day monthly billing. A monthly subscription can only be created for a signup that has a row
-- here, and rows are added ONLY by you (Scott) from your computer on launch day:
--   bash _tools/mark-launched.sh SOSG-YYYYMMDD-xxxxxx https://their-new-site.com
-- The Worker then emails the customer a private link to approve and start the monthly plan.

CREATE TABLE launches (
  ref                   TEXT PRIMARY KEY,         -- the signed signup this launch belongs to
  launched_at           TEXT NOT NULL,            -- when the website went live (set by you)
  site_url              TEXT,
  marked_by             TEXT,
  link_token_hash       TEXT,                     -- SHA-256 of the private monthly-billing link token
  link_expires_at       TEXT,
  link_sent_at          TEXT,
  link_send_attempts    INTEGER NOT NULL DEFAULT 0,
  billing_approval_json TEXT,                     -- what the customer approved on the monthly page
  subscribe_session_id  TEXT,                     -- Stripe Checkout Session (mode=subscription)
  subscription_id       TEXT,
  subscription_status   TEXT,                     -- link_pending | link_sent | checkout_open | active | not_needed
  subscription_json     TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_launches_session ON launches(subscribe_session_id);
CREATE INDEX idx_launches_pending ON launches(link_sent_at, subscription_id);

-- Only a SIGNED signup that has been paid (or that had nothing due today) can be launched.
CREATE TRIGGER launches_require_signed BEFORE INSERT ON launches
WHEN NOT EXISTS (SELECT 1 FROM signups WHERE ref = NEW.ref AND signed_at IS NOT NULL AND status IN ('paid', 'submitted_no_payment'))
BEGIN
  SELECT RAISE(ABORT, 'launch needs a signed, paid signup');
END;

-- The launch date can't be moved earlier or erased once billing has started; launch records are kept.
CREATE TRIGGER launches_fixed_once_billing BEFORE UPDATE ON launches
WHEN OLD.subscription_id IS NOT NULL AND (NEW.launched_at IS NOT OLD.launched_at OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.ref IS NOT OLD.ref)
BEGIN
  SELECT RAISE(ABORT, 'launch record is fixed once billing has started');
END;

CREATE TRIGGER launches_no_delete BEFORE DELETE ON launches
BEGIN
  SELECT RAISE(ABORT, 'launch records cannot be deleted');
END;
