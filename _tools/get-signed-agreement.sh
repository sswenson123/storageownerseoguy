#!/usr/bin/env bash
# OWNER RECOVERY of one signed agreement — any time, no customer token needed. Run on YOUR computer
# (logged in with `npx wrangler login`). Downloads the original PDF from the private bucket and checks
# its SHA-256 against the signed record, then prints the record and the audit trail.
#   bash _tools/get-signed-agreement.sh SOSG-20261024-ab12cd        → ~/SOSG-signed/<agreement id>.pdf
# (A customer can get their own copy at storageownerseoguy.com/signup/copy/ — emailed to the signing address.)
set -euo pipefail
cd "$(dirname "$0")/../_worker"
REF="${1:-}"
[[ "$REF" =~ ^SOSG-[0-9]{8}-[a-z0-9]{6}$ ]] || { sed -n '2,7p' "$0"; exit 1; }
OUT="${2:-$HOME/SOSG-signed}"; mkdir -p "$OUT"; chmod 700 "$OUT"
J=$(npx wrangler d1 execute sosg-signups --remote --json --command "SELECT ref, agreement_id, status, signed_at, signer_name, signer_title, email, pdf_key, pdf_sha256 FROM signups WHERE ref = '$REF' AND signed_at IS NOT NULL")
node -e '
const r=JSON.parse(process.argv[1])[0].results[0]; if(!r){console.error("No signed agreement with that reference.");process.exit(1)}
console.log(JSON.stringify(r,null,2)); require("fs").writeFileSync(process.argv[2]+"/.key",r.pdf_key+"\n"+r.pdf_sha256+"\n"+r.agreement_id)' "$J" "$OUT"
{ read -r KEY; read -r SHA; read -r AID; } < "$OUT/.key"; rm -f "$OUT/.key"
npx wrangler r2 object get "sosg-signed-agreements/$KEY" --remote --file "$OUT/$AID.pdf" >/dev/null
GOT=$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$OUT/$AID.pdf")
if [ "$GOT" = "$SHA" ]; then echo "OK  $OUT/$AID.pdf — SHA-256 matches the signed record ($SHA)"; else echo "MISMATCH — stored file does not match the signed record. Do not use; contact support."; exit 1; fi
npx wrangler d1 execute sosg-signups --remote --command "SELECT seq, at, event FROM audit WHERE ref = '$REF' ORDER BY seq"
