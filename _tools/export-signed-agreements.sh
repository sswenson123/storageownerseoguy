#!/usr/bin/env bash
# Backup/export of every signed agreement: records + audit trails (JSON) + the original signed PDFs.
# Run on YOUR computer from the repo, logged in with `npx wrangler login`. Output contains customer data:
# keep it on an encrypted disk (e.g. FileVault) — never commit it or put it in a shared folder.
#   bash _tools/export-signed-agreements.sh            → ~/SOSG-signed-export-YYYYMMDD/
# Policy: run at least monthly and keep the last 12 exports (see _docs/RECORDS-RETENTION-AND-BACKUP.md).
set -euo pipefail
cd "$(dirname "$0")/../_worker"
OUT="${1:-$HOME/SOSG-signed-export-$(date +%Y%m%d)}"
mkdir -p "$OUT/pdf" && chmod 700 "$OUT"
DB=sosg-signups BUCKET=sosg-signed-agreements
npx wrangler d1 execute "$DB" --remote --json --command \
  "SELECT ref, agreement_id, agreement_version, agreement_sha256, status, signed_at, signer_name, signer_title, email, info_json, consent_json, pdf_key, pdf_sha256, audit_head, quote_json, approval_json, checkout_session_id, payment_json FROM signups WHERE signed_at IS NOT NULL ORDER BY signed_at" > "$OUT/signed-records.json"
npx wrangler d1 execute "$DB" --remote --json --command \
  "SELECT a.* FROM audit a JOIN signups s ON s.ref = a.ref WHERE s.signed_at IS NOT NULL ORDER BY a.ref, a.seq" > "$OUT/audit-trails.json"
npx wrangler d1 execute "$DB" --remote --json --command "SELECT * FROM unmatched_payments" > "$OUT/unmatched-payments.json"
# full database dump (every table, incl. unsigned signups still inside their 30 days) — restorable with wrangler d1 execute --file
npx wrangler d1 export "$DB" --remote --output "$OUT/sosg-signups-full.sql"
npx wrangler d1 execute "$DB" --remote --json --command "SELECT ref, launched_at, site_url, subscription_status, subscription_id, billing_approval_json, subscription_json FROM launches" > "$OUT/launches.json"
# download each signed PDF and check its SHA-256 against the record
node -e '
const fs=require("fs"),cp=require("child_process"),crypto=require("crypto");
const out=process.argv[1], rows=JSON.parse(fs.readFileSync(out+"/signed-records.json","utf8"))[0].results;
let bad=0;
for (const r of rows) {
  const f=`${out}/pdf/${r.agreement_id}.pdf`;
  cp.execFileSync("npx",["wrangler","r2","object","get",`sosg-signed-agreements/${r.pdf_key}`,"--remote","--file",f],{stdio:"ignore"});
  const ok=crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")===r.pdf_sha256;
  if(!ok) bad++; console.log((ok?"OK   ":"BAD  ")+r.agreement_id+"  "+r.ref);
}
console.log(`${rows.length} signed agreements exported to ${out}${bad?` — ${bad} FAILED their fingerprint check`:""}`);
process.exit(bad?1:0);
' "$OUT"
