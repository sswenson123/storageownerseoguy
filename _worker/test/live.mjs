// REAL INTEGRATION TEST against your deployed signup Worker — real Resend email, real Stripe TEST mode,
// real Cloudflare D1 + R2. Run on your computer from _worker (after `npx wrangler login` and deploy):
//   node test/live.mjs https://sosg-signup.<you>.workers.dev you@your-inbox.com            (signup + build payment)
//   node test/live.mjs https://sosg-signup.<you>.workers.dev you@your-inbox.com --monthly  (also launch-day billing)
// It stops at once if the Worker is not in Stripe TEST mode. You type the email code and pay on Stripe's
// test page with card 4242 4242 4242 4242 (any future date, any CVC, any ZIP). Nothing real is charged.
// Writes test/output/live-results.json. The test signup is real data in D1/R2 (kept, like any signed record).
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAuditChain } from '../src/lib.js';
import { AGREEMENT } from '../src/agreement.generated.js';

const [WORKER, EMAIL] = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((s) => s && s.replace(/\/$/, ''));
const MONTHLY = process.argv.includes('--monthly');
if (!WORKER || !EMAIL) { console.log('usage: node test/live.mjs <worker url> <your email> [--monthly]'); process.exit(1); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'output'); fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = process.env.SOSG_ORIGIN || 'https://storageownerseoguy.com'; // must be in ALLOWED_ORIGINS
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  — ' + String(detail).slice(0, 160) : '')); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, p, body, token) {
  const h = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(WORKER + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'sosg-signups', '--remote', '--json', '--command', sql], { cwd: path.join(HERE, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0].results;
const done = (code) => { fs.writeFileSync(path.join(OUT, 'live-results.json'), JSON.stringify({ at: new Date().toISOString(), worker: WORKER, results }, null, 2)); console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed — test/output/live-results.json`); rl.close(); process.exit(code); };

console.log('\n1. Health');
const h = (await api('GET', '/api/health')).body;
check('Worker reachable; D1 + R2 bound; email configured; agreement version matches', h.ok && h.storageConfigured && h.emailConfigured && h.configVersionMatches && h.agreementSha256 === AGREEMENT.sha256, JSON.stringify(h));
if (!check('Stripe is in TEST mode (stops here otherwise)', h.stripeMode === 'test', 'stripeMode=' + h.stripeMode)) done(1);

console.log('\n2. Start + email code (real Resend)');
const uniq = crypto.randomBytes(2).toString('hex');
const INFO = { owner_name: 'Scott Swenson', legal_name: `Live Test ${uniq} LLC`, facility_name: `Live Test Storage ${uniq}`, street: '1 Test Rd', city: 'Park Rapids', state: 'MN', zip: '56470', phone: '2185550100', email: EMAIL.toLowerCase(), rental_software: 'CC Storage' };
const st = await api('POST', '/api/sign/start', { info: INFO });
check('Signup started; agreement frozen (version + SHA-256)', st.status === 200 && st.body.agreement.sha256 === AGREEMENT.sha256, st.body.ref || st.body.error);
const { ref, token } = st.body;
const t0 = Date.now();
const sent = await api('POST', '/api/sign/email/send', { ref }, token);
check('Code email accepted by Resend', sent.status === 200, sent.body.sentTo || sent.body.error);
const code = (await rl.question(`   Enter the 6-digit code emailed to ${EMAIL}: `)).trim();
check('Code arrived (you typed it) — seconds after sending', /^\d{6}$/.test(code), ((Date.now() - t0) / 1000).toFixed(0) + ' s incl. typing');
const v = await api('POST', '/api/sign/email/verify', { ref, code }, token);
check('Email verified', v.status === 200 && v.body.emailVerified, v.body.error);

console.log('\n3. Sign (typed name + title + both consents + click)');
const body = { ref, agreementVersion: st.body.agreement.version, agreementSha256: st.body.agreement.sha256, typedName: 'Scott Swenson', title: 'Owner', consentEsign: true, consentAuthority: true, signClicked: true, consentIds: { esign: st.body.consents.esign.id, authority: st.body.consents.authority.id } };
const ts = Date.now();
const c = await api('POST', '/api/sign/complete', body, token);
check('Signed', c.status === 200 && c.body.signed, c.body.error || `${Date.now() - ts} ms wall (CPU time: see Cloudflare dashboard → Metrics)`);
const pdf = await api('GET', `/api/sign/pdf?ref=${ref}`, null, token);
fs.writeFileSync(path.join(OUT, `live-${c.body.agreementId}.pdf`), pdf.body);
check('Downloaded PDF SHA-256 = signed record', pdf.status === 200 && sha(pdf.body) === c.body.pdfSha256, c.body.pdfSha256);
const yes = async (q) => /^y/i.test((await rl.question('   ' + q + ' [y/n] ')).trim());
check('Signed-copy email arrived with the PDF attached (you checked)', await yes(`Did "Your signed Services Agreement (${c.body.agreementId})" arrive at ${EMAIL} with a PDF attached?`));

console.log('\n4. Quote + Stripe Checkout (TEST mode)');
const promo = (await rl.question('   Promo code to test (Enter for none): ')).trim();
const qq = await api('POST', '/api/order/quote', { ref, facilities: 1, planId: 'maintain', promoCode: promo || undefined }, token);
check('Server quote', qq.status === 200, qq.body.quote ? `due today ${qq.body.quote.dueTodayCents / 100}, monthly ${qq.body.quote.monthlyCents / 100} from launch` : qq.body.error);
if (qq.status !== 200) done(1);
const qt = qq.body.quote;
const co = await api('POST', '/api/order/checkout', { ref, quoteId: qt.id, approve: true, approvedDueTodayCents: qt.dueTodayCents, approvedMonthlyCents: qt.monthlyCents }, token);
check('Stripe Checkout Session created in TEST mode (cs_test_…)', co.status === 200 && /cs_test_/.test(co.body.url || ''), co.body.error || '');
if (co.status !== 200) done(1);
console.log(`\n   Open and pay with card 4242 4242 4242 4242:\n   ${co.body.url}\n`);
let s = null;
for (let i = 0; i < 120; i++) { s = (await api('GET', `/api/sign/status?ref=${ref}`, null, token)).body; if (s.paid) break; await sleep(5000); }
check('Signed webhook from Stripe → status "paid"', s && s.paid, s && s.status);

console.log('\n5. Records match (D1, R2, audit, Stripe metadata)');
const row = d1(`SELECT * FROM signups WHERE ref = '${ref}'`)[0];
const audit = d1(`SELECT * FROM audit WHERE ref = '${ref}' ORDER BY seq`);
const pay = JSON.parse(row.payment_json || '{}');
check('D1: agreement hash = agreement.html; PDF hash = download; signer; consents', row.agreement_sha256 === AGREEMENT.sha256 && row.pdf_sha256 === sha(pdf.body) && row.signer_name === 'Scott Swenson' && JSON.parse(row.consent_json).esign.given);
check('D1: payment amount = approved amount, tied to the agreement ID', pay.amount_total === qt.dueTodayCents && pay.amount_matches_approval && pay.agreement_id === row.agreement_id, JSON.stringify(pay));
const tmp = path.join(OUT, `live-r2-${row.agreement_id}.pdf`);
execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `sosg-signed-agreements/${row.pdf_key}`, '--remote', '--file', tmp], { cwd: path.join(HERE, '..'), stdio: 'ignore' });
check('R2 private copy is byte-identical to the download', sha(fs.readFileSync(tmp)) === row.pdf_sha256);
check('Audit chain verifies; signing, copy email and Stripe events recorded', (await verifyAuditChain(audit)).ok && ['email_verified', 'agreement_signed', 'signed_pdf_stored', 'signed_copy_emailed', 'checkout_session_created', 'stripe_checkout.session.completed'].every((e) => audit.some((a) => a.event === e)), audit.map((a) => a.event).join(' > '));
const pub = await fetch(WORKER + '/' + row.pdf_key);
check('No public URL serves the stored PDF', pub.status === 403 || pub.status === 404, pub.status);
check(`Stripe dashboard (test): payment ${qt.dueTodayCents / 100} USD with metadata signup_ref=${ref}, agreement_id=${row.agreement_id} (you checked)`, await yes('Does the Stripe TEST payment show that amount and metadata?'));

console.log('\n6. Copy after the signup link expires');
const cp = await api('POST', '/api/records/copy', { email: EMAIL, ref });
check('Copy request accepted', cp.status === 202, cp.body.message);
check('"Copy of your signed Services Agreement" arrived with the same PDF (you checked)', await yes('Did the copy email arrive with the PDF attached?'));

if (MONTHLY) {
  console.log('\n7. Launch-day monthly billing');
  const early = await api('POST', '/api/monthly/checkout', { ref, approve: true, approvedMonthlyCents: qt.monthlyCents }, token);
  check('Before launch: monthly billing impossible', early.status === 404);
  d1(`INSERT INTO launches (ref, launched_at, site_url, marked_by, subscription_status, created_at, updated_at) VALUES ('${ref}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'https://example.com', 'live-test', 'link_pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  console.log('   Launch recorded. The hourly cron (minute :17) emails the billing link — waiting up to 65 minutes…');
  let l = null;
  for (let i = 0; i < 130; i++) { l = d1(`SELECT * FROM launches WHERE ref = '${ref}'`)[0]; if (l.link_sent_at) break; await sleep(30000); }
  check('Billing link emailed by the cron', l && l.link_sent_at, l && l.subscription_status);
  console.log('   Open the link from the email, approve, and pay with 4242 4242 4242 4242.');
  for (let i = 0; i < 120; i++) { l = d1(`SELECT * FROM launches WHERE ref = '${ref}'`)[0]; if (l.subscription_id) break; await sleep(5000); }
  const sj = JSON.parse((l && l.subscription_json) || '{}');
  check('Subscription active after launch, amount = approved monthly', l && /^sub_/.test(l.subscription_id || '') && sj.amount_matches_approval, l && l.subscription_id);
  check('Stripe dashboard (test): subscription with metadata kind=monthly, signup_ref (you checked) — cancel it there afterwards', await yes('Does the TEST subscription show in Stripe with that metadata?'));
}
done(results.every((r) => r.ok) ? 0 : 1);
