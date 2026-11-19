// CPU cost of the heaviest request (/api/sign/complete): build the signed PDF, fingerprint it twice
// (before upload + read-back), base64 it for the email attachment. Same code the Worker runs.
//   node test/bench-cpu.mjs        (Cloudflare Free plan allows 10 ms CPU per request)
// Real Cloudflare numbers: Dashboard → Workers → sosg-signup → Metrics (CPU time) or Observability logs.
import { signedAgreementPdf } from '../src/pdf.js';
import { AGREEMENT } from '../src/agreement.generated.js';
import { AGREEMENT_PAGES } from '../src/agreement-pages.generated.js';
import { sha256Hex } from '../src/lib.js';
const cert = (n) => ({ ref: 'SOSG-20261024-abc' + String(n).padStart(3, '0'), agreement_id: 'AGR-20261024-ABCDEFGH', agreement_version: AGREEMENT.version, agreement_sha256: AGREEMENT.sha256,
  signed_at: new Date().toISOString(), signer_name: 'Pat Rivera', signer_title: 'Managing Member', legal_name: 'Lakeside Storage Properties LLC', facility_name: 'Lakeside Storage', address: '100 Example Rd, Anytown, MN, 56401',
  email: 'pat@example.com', email_verified_at: new Date().toISOString(), ip_masked: '203.0.113.x', user_agent_summary: 'Safari on iPhone',
  consents: [{ label: 'Electronic records and signatures', text: 'x'.repeat(380), at: new Date().toISOString() }, { label: 'Authority to sign', text: 'y'.repeat(110), at: new Date().toISOString() }],
  audit: Array.from({ length: 8 }, (_, i) => ({ n: i + 1, at: new Date().toISOString(), event: 'event_' + i, hash: 'f'.repeat(64) })), audit_head: 'e'.repeat(64) });
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
async function once(n) {
  const t = process.cpuUsage();
  const pdf = signedAgreementPdf(AGREEMENT, cert(n), AGREEMENT_PAGES);
  await sha256Hex(pdf); await sha256Hex(pdf); b64(pdf); JSON.stringify(cert(n));
  const d = process.cpuUsage(t); return { ms: (d.user + d.system) / 1000, bytes: pdf.length };
}
await sha256Hex(new Uint8Array(1)); // Node starts its WebCrypto lazily (~10 ms once); in Workers crypto.subtle is native and ready
const cold = await once(0);
const runs = []; for (let i = 1; i <= 300; i++) runs.push((await once(i)).ms);
runs.sort((a, b) => a - b);
const p = (x) => runs[Math.min(runs.length - 1, Math.floor(runs.length * x))].toFixed(2);
console.log(JSON.stringify({ pdfBytes: cold.bytes, coldFirstRunMs: +cold.ms.toFixed(2), warmP50Ms: +p(0.5), warmP95Ms: +p(0.95), warmP99Ms: +p(0.99), warmMaxMs: +runs[runs.length - 1].toFixed(2), freePlanLimitMs: 10 }, null, 1));
