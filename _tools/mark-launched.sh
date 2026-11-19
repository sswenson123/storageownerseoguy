#!/usr/bin/env bash
# LAUNCH DAY — the only way a monthly plan can start. Run on YOUR computer (logged in with `npx wrangler login`).
#   bash _tools/mark-launched.sh SOSG-20261024-ab12cd https://their-new-site.com   record the launch
#   bash _tools/mark-launched.sh --status SOSG-20261024-ab12cd                      where billing stands
#   bash _tools/mark-launched.sh --resend SOSG-20261024-ab12cd                      new link (old one expired/lost)
# Within the hour the Worker emails the customer a private link (valid 14 days) to approve the monthly amount
# and pay with Stripe. Nothing is charged until they approve it on that page. Launches can't be deleted.
set -euo pipefail
cd "$(dirname "$0")/../_worker"
DB=sosg-signups
MODE=launch
case "${1:-}" in --status|--resend) MODE="${1#--}"; shift;; esac
REF="${1:-}"; URL="${2:-}"
[[ "$REF" =~ ^SOSG-[0-9]{8}-[a-z0-9]{6}$ ]] || { sed -n '2,7p' "$0"; exit 1; }
if [ -n "$URL" ] && ! [[ "$URL" =~ ^https?://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]]; then echo "That website address doesn't look right: $URL"; exit 1; fi
NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')"
run() { npx wrangler d1 execute "$DB" --remote --command "$1"; }
show() { run "SELECT s.ref, s.status, s.signed_at, s.email, json_extract(s.quote_json,'$.planName') AS plan, json_extract(s.quote_json,'$.monthlyCents')/100.0 AS monthly_usd, l.launched_at, l.subscription_status, l.link_sent_at, l.link_expires_at, l.subscription_id FROM signups s LEFT JOIN launches l ON l.ref = s.ref WHERE s.ref = '$REF'"; }
case "$MODE" in
  status) show ;;
  resend)
    run "UPDATE launches SET link_sent_at = NULL, link_token_hash = NULL, link_send_attempts = 0, subscription_status = 'link_pending', updated_at = $NOW WHERE ref = '$REF' AND subscription_id IS NULL AND subscription_status NOT IN ('payment_processing', 'checkout_creating')"
    echo "A new link will be emailed within the hour (only if billing hasn't already started)."; show ;;
  launch)
    show
    read -r -p "Is this client's website LIVE today, and start their monthly plan now? Type YES: " a
    [ "$a" = "YES" ] || { echo "Cancelled. Nothing recorded."; exit 1; }
    SITE_SQL=NULL; [ -n "$URL" ] && SITE_SQL="'$URL'"
    run "INSERT INTO launches (ref, launched_at, site_url, marked_by, subscription_status, created_at, updated_at) VALUES ('$REF', $NOW, $SITE_SQL, 'owner-cli', 'link_pending', $NOW, $NOW)"
    echo "Launch recorded. The billing link email goes out within the hour."; show ;;
esac
