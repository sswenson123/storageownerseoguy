// End-to-end tests for first-party signing.
//   REAL:   the Worker code in Cloudflare's runtime (workerd via Miniflare), local D1 (SQLite) and local R2,
//           the real signup page in Chromium (desktop + iPhone 13 emulation).
//   MOCKED: Resend (email) and Stripe (API, checkout page, webhooks) — see mocks.mjs.
// usage (from _worker):  node test/e2e.mjs .. test/output
import { Miniflare } from 'miniflare';
import { chromium, devices } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startMocks } from './mocks.mjs';

const REPO = path.resolve(process.argv[2] || '..');
const OUT = path.resolve(process.argv[3] || 'test/output');
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const W = path.join(REPO, '_worker');
const { AGREEMENT } = await import(path.join(W, 'src', 'agreement.generated.js'));
const { signedAgreementPdf } = await import(path.join(W, 'src', 'pdf.js'));
const L = await import(path.join(W, 'src', 'lib.js'));
const CFG = require(path.join(REPO, 'js', 'signup-config.js'));
const SITE = 'http://127.0.0.1:8765', MOCK_PORT = 18860, WORKER_PORT = 18861, WORKER = `http://127.0.0.1:${WORKER_PORT}`;
const KEYS = { resendKey: 're_mock', stripeKey: 'sk_test_mock', stripeSecret: 'whsec_mock_secret' };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + String(detail).slice(0, 200) : '')); };

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const J = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
const PUBJWK = { kty: J.kty, crv: J.crv, x: J.x, y: J.y };
const { makeInvite } = require(path.join(REPO, '_tools', 'make-invite.js'));
const invite = (a) => makeInvite({ site: SITE, ...a }, Date.now(), { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), config: { ...CFG, invitePublicKey: PUBJWK } });

const modules = ['index.js', 'lib.js', 'pdf.js', 'fonts.generated.js', 'agreement.generated.js', 'agreement-pages.generated.js'].map((f) => ({ type: 'ESModule', path: path.join(W, 'src', f) }));
function bindings(extra) {
  return {
    ALLOWED_ORIGINS: SITE, SITE_URL: SITE, AGREEMENT_VERSION: AGREEMENT.version,
    OTP_SECRET: crypto.randomBytes(32).toString('hex'), RESEND_API_KEY: KEYS.resendKey, RESEND_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, EMAIL_FROM: 'The Storage Owner’s SEO Guy <signup@example.test>',
    STRIPE_API_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`, STRIPE_SECRET_KEY: KEYS.stripeKey, STRIPE_WEBHOOK_SECRET: KEYS.stripeSecret,
    STRIPE_PRODUCT_BUILD: 'prod_build', STRIPE_PRICE_BUILD: 'price_build', STRIPE_PRODUCT_MAINTAIN: 'prod_maintain', STRIPE_PRODUCT_IMPROVE: 'prod_improve', ALLOW_PROMO_CODES: 'true',
    STRIPE_PRICE_MAINTAIN: 'price_maintain', STRIPE_PRICE_IMPROVE: 'price_improve', STRIPE_PORTAL_CONFIG: 'bpc_test', OWNER_NOTIFY_EMAIL: 'owner@example.test', MAX_NOTICE_EMAILS_PER_DAY: '900', MAX_BILLING_LINKS_PER_DAY: '900',
    BUILD_PRICE_CENTS: '19900', MAINTAIN_PRICE_CENTS: '5900', IMPROVE_PRICE_CENTS: '9900', MAX_FACILITIES: '7',
    MAX_STARTS_PER_IP_PER_DAY: '500', MAX_CODES_PER_15_MIN: '3', MAX_CODES_PER_SIGNUP_PER_DAY: '6', MAX_CODES_PER_EMAIL_PER_DAY: '8', MAX_CODES_PER_IP_PER_DAY: '500', MAX_EMAILS_PER_DAY: '900', MAX_CODE_ATTEMPTS: '5',
    TOKEN_TTL_DAYS: '30', UNSIGNED_RETENTION_DAYS: '30', SIGNUP_OPEN: 'true', MAX_COPY_REQUESTS_PER_IP_PER_DAY: '50', INVITE_PUBLIC_JWK: JSON.stringify(PUBJWK), ...(extra || {})
  };
}
function splitSql(sql) {
  const out = []; let cur = []; let trig = false;
  for (const line of sql.split('\n')) {
    if (!cur.length && (/^\s*--/.test(line) || !line.trim())) continue;
    cur.push(line);
    if (/^CREATE TRIGGER/i.test(line)) trig = true;
    if (trig ? /^END;\s*$/.test(line) : /;\s*(--.*)?$/.test(line)) { out.push(cur.join('\n')); cur = []; trig = false; }
  }
  return out;
}
async function newWorker(port, extra) {
  const mf = new Miniflare({ modules, modulesRoot: path.join(W, 'src'), compatibilityDate: '2024-09-23', d1Databases: ['DB'], r2Buckets: ['AGREEMENTS'], bindings: bindings(extra), port });
  const u = await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const f of fs.readdirSync(path.join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) for (const st of splitSql(fs.readFileSync(path.join(W, 'migrations', f), 'utf8'))) await db.prepare(st).run();
  return { mf, url: u.href.replace(/\/$/, ''), db, r2: await mf.getR2Bucket('AGREEMENTS') };
}

const site = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore' });
const M = await startMocks({ port: MOCK_PORT, workerUrl: WORKER, ...KEYS });
const { mf, db, r2 } = await newWorker(WORKER_PORT);
const rec = (ref) => db.prepare('SELECT * FROM signups WHERE ref = ?').bind(ref).first();
const auditOf = async (ref) => (await db.prepare('SELECT * FROM audit WHERE ref = ? ORDER BY seq').bind(ref).all()).results;
const latestCode = (email) => { const m = [...M.S.inbox].reverse().find((x) => x.to[0] === email && /is (\d{6})/.test(x.text)); return m && /is (\d{6})/.exec(m.text)[1]; };
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const formspree = [];

async function newPage(opts = {}) {
  const ctx = await browser.newContext(opts.device ? { ...devices[opts.device] } : { viewport: { width: 1280, height: 950 }, ...(opts.storageState ? { storageState: opts.storageState } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://formspree.io/**', async (r) => { formspree.push(JSON.parse(r.request().postData() || '{}')); await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await page.route('**/js/signup-config.js', async (r) => {
    let resp, body;
    try { resp = await r.fetch(); body = await resp.text(); } catch (e) { return r.abort().catch(() => {}); }
    body = body.replace(/    signupApi: '[^']*',/, `    signupApi: '${opts.api === undefined ? WORKER : opts.api}',`).replace('    invitePublicKey: null,', '    invitePublicKey: ' + JSON.stringify(PUBJWK) + ',');
    await r.fulfill({ response: resp, body }).catch(() => {});
  });
  return { ctx, page, errors };
}
async function shot(page, name) { await page.addStyleTag({ content: '.site-header{position:static!important}' }).catch(() => {}); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }); }
const uniq = () => crypto.randomBytes(3).toString('hex');
async function step1(page, o = {}) {
  const v = { owner_name: 'Pat Rivera', legal_name: 'Lakeside Storage Properties LLC', facility_name: 'Lakeside Storage', street: '100 Example Rd', city: 'Anytown', state: 'MN', zip: '56401', phone: '(573) 555-0101', email: `pat-${uniq()}@example.com`, ...o };
  // Step 1: package (facilities + plan), Step 2: information, then Step 3: the agreement opens
  await page.waitForSelector('[data-step="1"]:not([hidden])');
  if (o.facilities) await page.selectOption('#facilities', String(o.facilities));
  if (o.plan) await page.check('#plan-' + o.plan);
  await page.click('[data-step="1"] [data-next]');
  await page.waitForSelector('[data-step="2"]:not([hidden])');
  for (const [k, val] of Object.entries(v)) if (!['facilities', 'plan'].includes(k)) await page.fill('#' + k, val);
  await page.fill('#email_confirm', v.email);
  await page.selectOption('#rental_software', 'CC Storage');
  await page.click('[data-step="2"] [data-next]');
  await page.waitForSelector('[data-step="3"]:not([hidden])');
  await page.waitForFunction(() => document.getElementById('agreement-version').textContent && /Services Agreement/.test(document.getElementById('agreement-panel').textContent));
  return v;
}
async function verifyEmail(page, email) {
  // the code is emailed automatically when the agreement opens; ask again only if that didn't happen
  await page.waitForFunction(() => /emailed a 6-digit code|couldn’t|Too many|isn’t/.test(document.getElementById('email-status').textContent), null, { timeout: 10000 }).catch(() => {});
  if (!/emailed a 6-digit code/.test(await page.textContent('#email-status'))) await page.click('#send-code');
  await page.waitForFunction(() => /emailed a 6-digit code/.test(document.getElementById('email-status').textContent));
  await page.fill('#email_code', latestCode(email)); // six digits → verified automatically, no extra click
  await page.waitForSelector('#email-verified:not([hidden])');
}
async function sign(page, name, title = 'Owner') {
  await page.fill('#typed_name', name);
  await page.fill('#signer_title', title);
  await page.check('#consent_esign');
  await page.check('#consent_authority');
  await page.click('#sign-btn');
}
const lsSign = (page) => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('sosg_signup_v3')) return JSON.parse(localStorage.getItem(k)).state.sign; return null; });
async function api(method, p, body, token, origin = SITE) {
  const h = { Origin: origin, 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(WORKER + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const INFO = (email) => ({ owner_name: 'Pat Lee', legal_name: 'Lee Storage LLC', facility_name: 'Lee Storage', street: '1 Main St', city: 'Brainerd', state: 'MN', zip: '56401', phone: '2185550100', email, rental_software: 'CC Storage' });
// API-level helper: start → code → verify → (optionally) sign
async function apiSignup({ email = `api-${uniq()}@example.com`, signIt = true, name = 'Pat Lee', inviteToken } = {}) {
  const st = await api('POST', '/api/sign/start', { info: INFO(email), invite: inviteToken });
  if (st.status !== 200) return { st };
  const { ref, token } = st.body;
  await api('POST', '/api/sign/email/send', { ref }, token);
  const v = await api('POST', '/api/sign/email/verify', { ref, code: latestCode(email) }, token);
  let c = null;
  const body = { ref, agreementVersion: st.body.agreement.version, agreementSha256: st.body.agreement.sha256, typedName: name, title: 'Member', consentEsign: true, consentAuthority: true, signClicked: true, consentIds: { esign: st.body.consents.esign.id, authority: st.body.consents.authority.id } };
  if (signIt) c = await api('POST', '/api/sign/complete', body, token);
  return { st, ref, token, v, c, body, email };
}

try {
  // ===== 1. Desktop: verified email + typed legal name + explicit click → exact signed PDF =====
  {
    const { ctx, page, errors } = await newPage();
    await page.goto(SITE + '/signup/');
    const v = await step1(page, { facilities: 1, plan: 'maintain' });
    const sg0 = await lsSign(page);
    const r0 = await rec(sg0.ref);
    const segment = (() => { const h = fs.readFileSync(path.join(REPO, 'agreement.html'), 'utf8'); return h.slice(h.indexOf('<div id="agreement-text">'), h.indexOf('<!-- /agreement-text -->')); })();
    check('1 Agreement frozen at Step 2: version + SHA-256 = agreement.html = js/signup-config.js fingerprint', r0.agreement_version === CFG.agreementVersion && r0.agreement_sha256 === sha(segment) && r0.agreement_sha256 === CFG.agreementHash && r0.status === 'awaiting_email_verification', r0.agreement_sha256);
    const shown = await page.$eval('#agreement-panel', (e) => e.innerText);
    check('1 Step 2 shows the complete agreement (all 15 sections + Schedule A + Signature Page)', ['1. Services and Fees', '8. Limitation of Liability', '15. Electronic Signatures and Electronic Records', 'Schedule A', 'Signature Page', 'storageownerseoguy@gmail.com'].every((s) => shown.includes(s)));
    const pdfHref = await page.getAttribute('[data-agreement-pdf]', 'href');
    const dl0 = await fetch(SITE + pdfHref);
    check('1 Download PDF serves this version’s agreement', dl0.status === 200 && pdfHref.includes(AGREEMENT.version));
    check('1 Sign Agreement disabled before email verification, typed name, title and both boxes', await page.isDisabled('#sign-btn'));
    check('1 Both consent boxes start unchecked', !(await page.isChecked('#consent_esign')) && !(await page.isChecked('#consent_authority')));
    await page.click('[data-step="3"] [data-next]');
    check('1 Cannot reach payment unsigned', !(await page.isVisible('[data-step="4"]')));
    await shot(page, '1-step2-unsigned');
    await verifyEmail(page, v.email);
    check('1 Email verified with a one-time code sent to the Step 1 address', (await rec(sg0.ref)).status === 'email_verified');
    await sign(page, 'Pat Rivera', 'Owner');
    await page.waitForSelector('#signed-box:not([hidden])');
    await shot(page, '1-step2-signed');
    const r1 = await rec(sg0.ref);
    check('1 Signed record: name, title, Worker timestamp, PDF fingerprint, consents', r1.status === 'signed' && r1.signer_name === 'Pat Rivera' && r1.signer_title === 'Owner' && /Z$/.test(r1.signed_at) && /^[0-9a-f]{64}$/.test(r1.pdf_sha256) && JSON.parse(r1.consent_json).esign.given && JSON.parse(r1.consent_json).authority.given);
    const stored = Buffer.from(await (await r2.get(r1.pdf_key)).arrayBuffer());
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-signed')]);
    const dlPath = path.join(OUT, '1-signed.pdf'); await dl.saveAs(dlPath);
    const dlBuf = fs.readFileSync(dlPath);
    check('1 Downloaded PDF SHA-256 = D1 record = private R2 object', sha(dlBuf) === r1.pdf_sha256 && sha(stored) === r1.pdf_sha256, r1.pdf_sha256);
    const text = execSync(`pdftotext "${dlPath}" -`).toString();
    const norm = (s) => s.replace(/\s+/g, '');
    const fullText = norm(AGREEMENT.blocks.map((b) => b.runs.map((r) => r.t).join('')).join(''));
    check('1 Signed PDF reproduces the ENTIRE agreement text, then the signing certificate', norm(text.replace(/Services Agreement v[^\n]*page \d+ of \d+/g, '').replace(/•/g, '')).includes(fullText) && text.includes('Signing Certificate'));
    check('1 Certificate: name, title, business, facility, UTC time, agreement + signup IDs, agreement hash, consents, events', [r1.signer_name, 'Owner', v.legal_name, v.facility_name, r1.signed_at, r1.agreement_id, r1.ref, r1.agreement_sha256, 'Electronic records and signatures', 'Authority to sign', 'email_verified', 'agreement_signed'].every((s) => norm(text).includes(norm(s))));
    const rows = await auditOf(r1.ref);
    const chain = await L.verifyAuditChain(rows);
    check('1 Append-only audit chain verifies end to end and its head is printed in the PDF', chain.ok && text.includes(rows.find((x) => x.event === 'agreement_signed').entry_hash) , rows.map((x) => x.event).join(' > '));
    // reproducibility: rebuild the PDF purely from the stored record and audit → identical bytes
    const i = JSON.parse(r1.info_json), consent = JSON.parse(r1.consent_json);
    const signedRow = rows.find((x) => x.event === 'agreement_signed'), sd = JSON.parse(signedRow.detail);
    const prior = rows.filter((x) => x.seq < signedRow.seq);
    const rebuilt = signedAgreementPdf(AGREEMENT, { ref: r1.ref, agreement_id: r1.agreement_id, agreement_version: r1.agreement_version, agreement_sha256: r1.agreement_sha256, signed_at: r1.signed_at, signer_name: r1.signer_name, signer_title: r1.signer_title,
      legal_name: i.legal_name, facility_name: i.facility_name, address: [i.street, i.city, i.state, i.zip].join(', '), email: i.email, email_verified_at: r1.email_verified_at, ip_masked: L.maskIp(sd.ip), user_agent_summary: L.uaSummary(sd.ua),
      consents: [{ label: 'Electronic records and signatures', text: consent.esign.text, at: consent.esign.at }, { label: 'Authority to sign', text: consent.authority.text, at: consent.authority.at }],
      audit: [...prior.map((a, n) => ({ n: n + 1, at: a.at, event: a.event, hash: a.entry_hash })), { n: prior.length + 1, at: signedRow.at, event: 'agreement_signed', hash: signedRow.entry_hash }], audit_head: signedRow.entry_hash });
    check('1 Reproducible: PDF rebuilt from the database record is byte-identical to the stored one', sha(Buffer.from(rebuilt)) === r1.pdf_sha256);
    const copy = [...M.S.inbox].reverse().find((m) => m.to[0] === v.email && m.attachments);
    check('1 Signed copy emailed to the verified address as a PDF attachment (same bytes)', copy && sha(Buffer.from(copy.attachments[0].content, 'base64')) === r1.pdf_sha256, copy && copy.subject);
    // Step 3 + 4
    await page.click('[data-step="3"] [data-next]');
    await page.waitForSelector('#quote-slot table');
    await page.fill('#promo', 'WELCOME50'); await page.click('#promo-apply');
    await page.waitForFunction(() => /applied/.test(document.getElementById('promo-msg').textContent));
    await page.waitForFunction(() => /\$149\.00/.test(document.getElementById('quote-slot').textContent));
    check('1 Step 4 exact amounts: $199.00 − $50.00 = $149.00 today; $59.00/month from launch', (await page.textContent('#quote-slot')).includes('$149.00') && (await page.textContent('#approval-text')).includes('$149.00 today and $59.00 per month for Maintain starting the day your new website goes live'));
    await page.click('#submit-btn');
    check('1 Payment blocked until the separate exact-amount approval is checked', page.url().startsWith(SITE) && await page.isVisible('[data-step="4"] .step-errors'));
    await page.check('#order_approved');
    M.S.opts.sendStripeWebhook = false;
    await Promise.all([page.waitForURL(/\/pay\/cs_test_/), page.click('#submit-btn')]);
    const sc = M.S.calls.filter((c) => c.stripe === 'create_session').pop().params;
    check('1 Stripe Checkout opened for exactly $149.00, one-time (mode=payment, no subscription)', (await page.textContent('#amount')) === '$149.00' && sc.mode === 'payment' && !Object.keys(sc).some((k) => /recurring|subscription/.test(k)) && sc['line_items[0][quantity]'] === '1');
    check('1 Stripe session carries signup ref, agreement ID, agreement hash, signed-PDF hash, quote', sc.client_reference_id === r1.ref && sc['metadata[agreement_id]'] === r1.agreement_id && sc['metadata[agreement_sha256]'] === r1.agreement_sha256 && sc['metadata[signed_pdf_sha256]'] === r1.pdf_sha256);
    await Promise.all([page.waitForURL(/signup\/welcome/), page.click('#pay')]);
    check('1 Reaching the welcome page without a verified Stripe webhook does NOT mark paid', (await rec(r1.ref)).status === 'signed');
    const sess = M.S.sessions[sc.success_url ? Object.keys(M.S.sessions).pop() : ''];
    const wh = await M.stripeWebhook('checkout.session.completed', sess);
    const r1p = await rec(r1.ref);
    const pay = JSON.parse(r1p.payment_json || '{}');
    check('1 Verified Stripe webhook → paid, amount = approved, tied to the agreement', wh.status === 200 && r1p.status === 'paid' && pay.amount_total === 14900 && pay.amount_matches_approval && pay.agreement_id === r1.agreement_id);
    M.S.opts.sendStripeWebhook = true;
    check('1 No customer data is posted from the browser to Formspree (the Worker emails Scott after Stripe confirms)', !formspree.some((f) => f.signup_ref === r1.ref));
    check('1 No JavaScript errors; no SignWell code loaded', errors.length === 0 && !(await page.evaluate(() => !!window.SignWellEmbed)), errors.join('; '));
    fs.writeFileSync(`${OUT}/1-record.json`, JSON.stringify({ signup: { ...r1p, token_hash: '(hash)' }, audit: rows }, null, 2));
    await ctx.close();
  }

  // ===== 2. Mobile (iPhone 13): full signing, 3 facilities + FRIEND25 =====
  {
    const { ctx, page, errors } = await newPage({ device: 'iPhone 13' });
    await page.goto(SITE + '/signup/');
    const v = await step1(page, { facilities: 3, plan: 'improve' });
    await verifyEmail(page, v.email);
    await sign(page, 'pat  RIVERA', 'Managing Member');
    await page.waitForSelector('#signed-box:not([hidden])');
    await shot(page, '2-mobile-signed');
    const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    check('2 Mobile: signed (name matched ignoring case/spacing), no horizontal overflow', !over && (await rec((await lsSign(page)).ref)).status === 'signed');
    await page.click('[data-step="3"] [data-next]');
    await page.waitForSelector('#quote-slot table');
    await page.fill('#promo', 'FRIEND25'); await page.click('#promo-apply');
    await page.waitForFunction(() => /applied/.test(document.getElementById('promo-msg').textContent));
    await page.waitForFunction(() => /\$447\.75/.test(document.getElementById('quote-slot').textContent));
    const qt = await page.textContent('#quote-slot');
    check('2 Mobile: 3 × $199 − 25% = $447.75 today; $297.00/month at launch', qt.includes('$597.00') && qt.includes('−$149.25') && qt.includes('$447.75') && qt.includes('$297.00/month'));
    await page.check('#order_approved');
    await Promise.all([page.waitForURL(/\/pay\//), page.click('#submit-btn')]);
    check('2 Mobile: Stripe amount $447.75, quantity 3', (await page.textContent('#amount')) === '$447.75' && M.S.calls.filter((c) => c.stripe === 'create_session').pop().params['line_items[0][quantity]'] === '3');
    check('2 Mobile: no JS errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ===== 3. Required "blocked" cases =====
  {
    // email delivery not configured → fail closed
    const w2 = await newWorker(WORKER_PORT + 2, { RESEND_API_KEY: '' });
    const st = await (await fetch(w2.url + '/api/sign/start', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: JSON.stringify({ info: INFO('noemail@example.com') }) })).json();
    const send = await fetch(w2.url + '/api/sign/email/send', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token }, body: JSON.stringify({ ref: st.ref }) });
    const comp = await fetch(w2.url + '/api/sign/complete', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token }, body: JSON.stringify({ ref: st.ref, agreementVersion: st.agreement.version, agreementSha256: st.agreement.sha256, typedName: 'Pat Lee', title: 'Owner', consentEsign: true, consentAuthority: true, signClicked: true, consentIds: { esign: st.consents.esign.id, authority: st.consents.authority.id } }) });
    check('3 No email service configured → codes refused (503) and signing impossible', send.status === 503 && (await send.json()).code === 'email_not_configured' && comp.status === 403 && st.emailConfigured === false);
    await w2.mf.dispose();
    // no storage configured → everything refused (safe default)
    const w3 = new Miniflare({ modules, modulesRoot: path.join(W, 'src'), compatibilityDate: '2024-09-23', bindings: bindings(), port: WORKER_PORT + 3 });
    const u3 = await w3.ready;
    const s3 = await fetch(u3.href + 'api/sign/start', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: JSON.stringify({ info: INFO('x@example.com') }) });
    check('3 No database/bucket bound → Worker refuses to start signups (503)', s3.status === 503);
    await w3.dispose();

    // unsigned → no quote / checkout
    const a = await apiSignup({ signIt: false });
    check('3 Unsigned (email verified but not signed): quote 403, checkout 403', (await api('POST', '/api/order/quote', { ref: a.ref, facilities: 1, planId: 'maintain' }, a.token)).status === 403 && (await api('POST', '/api/order/checkout', { ref: a.ref, quoteId: 'Q', approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 5900 }, a.token)).status === 403);
    // complete before email verification
    const b = await api('POST', '/api/sign/start', { info: INFO(`nv-${uniq()}@example.com`) });
    const nb = await api('POST', '/api/sign/complete', { ref: b.body.ref, agreementVersion: b.body.agreement.version, agreementSha256: b.body.agreement.sha256, typedName: 'Pat Lee', title: 'Owner', consentEsign: true, consentAuthority: true, signClicked: true, consentIds: { esign: b.body.consents.esign.id, authority: b.body.consents.authority.id } }, b.body.token);
    check('3 Unverified email → signing refused (403 email_not_verified)', nb.status === 403 && nb.body.code === 'email_not_verified');
    // expired OTP
    const e1 = `exp-${uniq()}@example.com`;
    const e = await api('POST', '/api/sign/start', { info: INFO(e1) });
    await api('POST', '/api/sign/email/send', { ref: e.body.ref }, e.body.token);
    await db.prepare('UPDATE email_codes SET expires_at = ? WHERE ref = ?').bind(new Date(Date.now() - 1000).toISOString(), e.body.ref).run();
    const ev = await api('POST', '/api/sign/email/verify', { ref: e.body.ref, code: latestCode(e1) }, e.body.token);
    check('3 Expired code (older than 10 minutes) refused', ev.status === 400 && ev.body.code === 'code_expired');
    // stored only as a keyed hash; code sent expires in 10 minutes
    const row = await db.prepare('SELECT * FROM email_codes WHERE ref = ?').bind(e.body.ref).first();
    check('3 Code stored only as an HMAC (never the digits)', !String(row.code_hash).includes(latestCode(e1)) && row.code_hash.length === 64);
    // wrong codes → lockout after 5; then a new code works once, and only once
    await api('POST', '/api/sign/email/send', { ref: e.body.ref }, e.body.token);
    const sent = await db.prepare('SELECT sent_at, expires_at FROM email_codes WHERE ref = ?').bind(e.body.ref).first();
    check('3 Code lifetime is 10 minutes', Math.abs(Date.parse(sent.expires_at) - Date.parse(sent.sent_at) - 600000) < 3000);
    const good = latestCode(e1);
    const bad = good === '000000' ? '111111' : '000000';
    const tries = [];
    for (let k = 0; k < 6; k++) tries.push((await api('POST', '/api/sign/email/verify', { ref: e.body.ref, code: bad }, e.body.token)).body.code);
    const afterLock = await api('POST', '/api/sign/email/verify', { ref: e.body.ref, code: good }, e.body.token);
    check('3 Five wrong tries lock the code (even the right one is then refused)', tries.slice(0, 5).every((x) => x === 'code_wrong') && tries[5] === 'too_many_attempts' && afterLock.body.code === 'too_many_attempts', tries.join(','));
    // invitation revoked
    const invEmail = `inv-${uniq()}@example.com`;
    const { url: invUrl, invite: inv } = await invite({ for: 'Lee Storage', setup: 149, maintain: 49, email: invEmail, exp: '2026-12-31' });
    const invTok = invUrl.split('invite=')[1];
    const ia = await apiSignup({ email: invEmail, inviteToken: invTok });
    check('3 Valid invitation signs at the invitation price', ia.c && ia.c.status === 200 && (await api('POST', '/api/order/quote', { ref: ia.ref, facilities: 1, planId: 'maintain' }, ia.token)).body.quote.dueTodayCents === 14900);
    await db.prepare('INSERT INTO revoked_invites (invite_id, revoked_at, reason) VALUES (?, ?, ?)').bind(inv.id, new Date().toISOString(), 'test').run();
    const rq = await api('POST', '/api/order/quote', { ref: ia.ref, facilities: 1, planId: 'maintain' }, ia.token);
    const rs = await api('POST', '/api/sign/start', { info: INFO(invEmail), invite: invTok });
    check('3 Revoked invitation: no new signup and no quote/checkout on an existing one', rq.status === 403 && rq.body.code === 'invite_revoked' && rs.status === 400 && rs.body.code === 'invite_revoked');
    // forged / missing token
    const f1 = await api('GET', `/api/sign/status?ref=${a.ref}`, null, 'A'.repeat(43));
    const f2 = await api('POST', '/api/sign/complete', { ...a.body }, crypto.randomBytes(32).toString('base64url'));
    const f3 = await api('GET', `/api/sign/status?ref=${a.ref}`);
    check('3 Forged or missing signup token → 404 (no record revealed)', f1.status === 404 && f2.status === 404 && f3.status === 404);
    // mismatched typed name
    const nm = await api('POST', '/api/sign/complete', { ...a.body, typedName: 'Someone Else' }, a.token);
    const nm2 = await api('POST', '/api/sign/complete', { ...a.body, typedName: 'Pat' }, a.token);
    check('3 Typed name must match the Step 1 signer', nm.status === 400 && nm.body.code === 'name_mismatch' && nm2.status === 400);
    // missing consents / no click / no title
    const c1 = await api('POST', '/api/sign/complete', { ...a.body, consentAuthority: false }, a.token);
    const c2 = await api('POST', '/api/sign/complete', { ...a.body, consentEsign: 'yes' }, a.token);
    const c3 = await api('POST', '/api/sign/complete', { ...a.body, signClicked: false }, a.token);
    const c4 = await api('POST', '/api/sign/complete', { ...a.body, title: '' }, a.token);
    check('3 Both consents (true booleans), the Sign click and a title are each required', [c1, c2, c3, c4].every((x) => x.status === 400), [c1, c2, c3, c4].map((x) => x.body.code).join(','));
    // changed agreement: client sends another hash; or the frozen version is no longer what the Worker serves
    const ch1 = await api('POST', '/api/sign/complete', { ...a.body, agreementSha256: 'f'.repeat(64) }, a.token);
    await db.prepare('UPDATE signups SET agreement_sha256 = ? WHERE ref = ?').bind('0'.repeat(64), a.ref).run();
    const ch2 = await api('POST', '/api/sign/complete', { ...a.body, agreementSha256: '0'.repeat(64) }, a.token);
    check('3 Changed agreement → signing refused (409 agreement_changed), customer must reload', ch1.status === 409 && ch1.body.code === 'agreement_changed' && ch2.status === 409 && ch2.body.code === 'agreement_changed');
    await db.prepare('UPDATE signups SET agreement_sha256 = ? WHERE ref = ?').bind(AGREEMENT.sha256, a.ref).run();
    // duplicate / concurrent signing
    const races = await Promise.all([0, 1, 2, 3].map(() => api('POST', '/api/sign/complete', { ...a.body }, a.token)));
    const signedEvents = (await auditOf(a.ref)).filter((x) => x.event === 'agreement_signed').length;
    const objs = (await r2.list({ prefix: `signed/${a.ref}/` })).objects.length;
    check('3 Four simultaneous Sign clicks → exactly one signature, one PDF; others idempotent or "in progress"', signedEvents === 1 && objs === 1 && races.filter((x) => x.status === 200).length >= 1 && races.every((x) => x.status === 200 || x.body.code === 'signing_in_progress'), races.map((x) => x.status).join(','));
    const again = await api('POST', '/api/sign/complete', { ...a.body }, a.token);
    check('3 Signing again later returns the same signed record (no second document)', again.status === 200 && again.body.already === true && (await auditOf(a.ref)).filter((x) => x.event === 'agreement_signed').length === 1);
    const imm = await db.prepare('UPDATE signups SET signer_name = ? WHERE ref = ?').bind('Forged', a.ref).run().then(() => 'changed', (er) => er.message);
    const delAudit = await db.prepare('DELETE FROM audit WHERE ref = ?').bind(a.ref).run().then(() => 'deleted', (er) => er.message);
    check('3 Database refuses to alter a signed record or delete/alter its audit trail', /immutable/.test(imm) && /cannot be deleted/.test(delAudit));
    // altered price / approval
    const qq = await api('POST', '/api/order/quote', { ref: a.ref, facilities: 2, planId: 'maintain', promoCode: 'WELCOME50' }, a.token);
    const alt = await api('POST', '/api/order/checkout', { ref: a.ref, quoteId: qq.body.quote.id, approve: true, approvedDueTodayCents: 100, approvedMonthlyCents: qq.body.quote.monthlyCents }, a.token);
    check('3 Approving an altered price → refused', alt.status === 400 && alt.body.code === 'approval_mismatch');
    M.S.opts.stripeAmountOffset = 700;
    const mism = await api('POST', '/api/order/checkout', { ref: a.ref, quoteId: qq.body.quote.id, approve: true, approvedDueTodayCents: qq.body.quote.dueTodayCents, approvedMonthlyCents: qq.body.quote.monthlyCents }, a.token);
    M.S.opts.stripeAmountOffset = 0;
    check('3 If Stripe’s total ever differs from the approved amount, no payment page is issued', mism.status === 409 && mism.body.code === 'amount_mismatch');
    // expired signup token
    await db.prepare('UPDATE signups SET token_expires_at = ? WHERE ref = ?').bind(new Date(Date.now() - 1000).toISOString(), b.body.ref).run();
    const exp = await api('GET', `/api/sign/status?ref=${b.body.ref}`, null, b.body.token);
    check('3 Expired signup token → refused (401)', exp.status === 401 && exp.body.code === 'token_expired');
  }

  // ===== 4. Privacy: other customers' agreements, direct checkout, forged webhooks, old Payment Links =====
  {
    const A = await apiSignup({});
    const B = await apiSignup({});
    const crossPdf = await api('GET', `/api/sign/pdf?ref=${A.ref}`, null, B.token);
    const crossStatus = await api('GET', `/api/sign/status?ref=${A.ref}`, null, B.token);
    const own = await api('GET', `/api/sign/pdf?ref=${A.ref}`, null, A.token);
    check('4 Customer B cannot read customer A’s agreement or status with B’s token', crossPdf.status === 404 && crossStatus.status === 404 && own.status === 200 && sha(own.body) === (await rec(A.ref)).pdf_sha256);
    check('4 PDF download is private (no-store) and carries its SHA-256', /no-store/.test(own.headers.get('cache-control')) && own.headers.get('x-content-sha256') === (await rec(A.ref)).pdf_sha256);
    const pub = await fetch(WORKER + '/' + (await rec(A.ref)).pdf_key);
    check('4 No public path to stored PDFs (bucket is not exposed by the Worker)', pub.status === 403 || pub.status === 404);
    const C = await apiSignup({ signIt: false });
    const direct = await api('POST', '/api/order/checkout', { ref: C.ref, quoteId: 'Qx', approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 0 }, C.token);
    check('4 Direct checkout without a signature refused', direct.status === 403);
    const forged = await M.stripeWebhook('checkout.session.completed', { id: 'cs_test_forged', client_reference_id: A.ref, payment_status: 'paid', amount_total: 14900 }, 'whsec_wrong');
    check('4 Forged Stripe webhook (wrong signing secret) refused; nothing marked paid', forged.status === 400 && (await rec(A.ref)).status === 'signed');
    const stray = await M.stripeWebhook('checkout.session.completed', { id: 'cs_test_paymentlink_old', payment_link: 'plink_old', amount_total: 19900, payment_status: 'paid', customer_details: { email: 'stray@example.com' } });
    const um = await db.prepare('SELECT * FROM unmatched_payments WHERE session_id = ?').bind('cs_test_paymentlink_old').first();
    check('4 A payment from an old public Payment Link is never matched to a signup — it is flagged for review', stray.status === 200 && um && JSON.parse(um.detail).payment_link === 'plink_old');
    check('4 The site no longer configures any public Payment Links', CFG.setupPaymentLinks === undefined && !fs.readFileSync(path.join(REPO, 'js', 'signup.js'), 'utf8').includes('buy.stripe.com'));
    const corsBad = await api('POST', '/api/sign/start', { info: INFO('x@example.com') }, null, 'https://evil.example');
    check('4 Other websites cannot call the signup API (origin check)', corsBad.status === 403);
  }

  // ===== 5. Pricing, facility quantities, promo codes, monthly-at-launch =====
  {
    const P = await apiSignup({});
    const qf = async (b) => (await api('POST', '/api/order/quote', { ref: P.ref, ...b }, P.token)).body;
    const r = await Promise.all([qf({ facilities: 1, planId: 'maintain' }), qf({ facilities: 1, planId: 'improve' }), qf({ facilities: 2, planId: 'maintain', promoCode: 'WELCOME50' }), qf({ facilities: 3, planId: 'improve', promoCode: 'FRIEND25' }), qf({ facilities: 7, planId: 'none' }), qf({ facilities: 99, planId: 'maintain' })]);
    check('5 $199 build, $59 Maintain, $99 Maintain + Improve (1 facility)', r[0].quote.dueTodayCents === 19900 && r[0].quote.monthlyCents === 5900 && r[1].quote.monthlyCents === 9900);
    check('5 $50 code takes $50 off the ORDER once (2 facilities: $398 → $348)', r[2].quote.dueTodayCents === 34800 && r[2].quote.discountCents === 5000);
    check('5 25% code on 3 facilities: $447.75; facilities capped at 7', r[3].quote.dueTodayCents === 44775 && r[4].quote.dueTodayCents === 139300 && r[5].quote.facilities === 7);
    check('5 Monthly billing starts at website launch, never charged at signup', r[0].quote.monthlyStarts === 'the day your new website goes live' && r[0].quote.approval_text.includes('starting the day your new website goes live'));
    for (const [code, msg] of [['OLDCODE50', 'expired'], ['ONEUSE50', 'already been used'], ['MONTHLY20', 'doesn’t apply'], ['NOTREAL', 'isn’t valid']]) {
      const x = await api('POST', '/api/order/quote', { ref: P.ref, facilities: 1, planId: 'maintain', promoCode: code }, P.token);
      check(`5 Promo ${code} rejected`, x.status === 400 && x.body.error.includes(msg), x.body.error);
    }
    const mo = await qf({ buildIncluded: false, facilities: 1, planId: 'maintain' });
    const moc = await api('POST', '/api/order/checkout', { ref: P.ref, quoteId: mo.quote.id, approve: true, approvedDueTodayCents: 0, approvedMonthlyCents: 5900 }, P.token);
    check('5 Monthly-only order: nothing charged today, no payment page; monthly is activated separately at launch', moc.body.done === true && (await rec(P.ref)).status === 'submitted_no_payment');
  }

  // ===== 6. ACH processing, retries / error recovery, resume, amended Step 1 =====
  {
    const A = await apiSignup({});
    const q = await api('POST', '/api/order/quote', { ref: A.ref, facilities: 1, planId: 'none' }, A.token);
    const co = await api('POST', '/api/order/checkout', { ref: A.ref, quoteId: q.body.quote.id, approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 0 }, A.token);
    const sid = co.body.url.split('/pay/')[1];
    await M.stripeWebhook('checkout.session.completed', { ...M.S.sessions[sid], payment_status: 'unpaid' });
    check('6 ACH bank debit: "payment_processing" — not paid until Stripe confirms', (await rec(A.ref)).status === 'payment_processing');
    await M.stripeWebhook('checkout.session.async_payment_succeeded', { ...M.S.sessions[sid], payment_status: 'paid' });
    check('6 ACH clears → paid', (await rec(A.ref)).status === 'paid');
    const dupEvt = await db.prepare('SELECT COUNT(*) AS n FROM stripe_events').first();
    check('6 Stripe events are de-duplicated by id', dupEvt.n >= 2);

    // email outage → clear error → retry works
    const { ctx, page } = await newPage();
    await page.goto(SITE + '/signup/');
    const v = await step1(page);
    await page.waitForFunction(() => /emailed a 6-digit code/.test(document.getElementById('email-status').textContent));
    check('6 Opening the agreement emails the code automatically (signing made easy)', !!latestCode(v.email));
    M.S.opts.resendFail = true;
    await page.click('#send-code');
    await page.waitForFunction(() => /couldn’t send/.test(document.getElementById('email-status').textContent));
    check('6 Email outage → clear message; nothing verified', (await rec((await lsSign(page)).ref)).status === 'awaiting_email_verification');
    M.S.opts.resendFail = false;
    await verifyEmail(page, v.email);
    // network failure on Sign → clear message, nothing signed; retry signs once
    let blocked = 0;
    await page.route(WORKER + '/api/sign/complete', (r) => { if (blocked++ === 0) return r.abort(); return r.continue(); });
    await sign(page, 'Pat Rivera');
    await page.waitForFunction(() => /Nothing was signed/.test(document.getElementById('sign-status').textContent));
    check('6 Connection drop on Sign → "Nothing was signed — try again"', (await rec((await lsSign(page)).ref)).status === 'email_verified');
    await page.click('#sign-btn');
    await page.waitForSelector('#signed-box:not([hidden])');
    check('6 Retry signs exactly once', (await auditOf((await lsSign(page)).ref)).filter((x) => x.event === 'agreement_signed').length === 1);
    // reload → resume shows signed state from the server
    const storageState = await ctx.storageState();
    const ref1 = (await lsSign(page)).ref;
    await ctx.close();
    const p2 = await newPage({ storageState });
    await p2.page.goto(SITE + '/signup/');
    await p2.page.waitForSelector('[data-step="3"]:not([hidden])');
    await p2.page.waitForSelector('#signed-box:not([hidden])');
    check('6 Coming back later resumes the same signed agreement (no re-signing)', (await lsSign(p2.page)).ref === ref1);
    // amend Step 1 → new agreement must be signed
    await p2.page.click('[data-step="3"] [data-back]');
    await p2.page.fill('#legal_name', 'Lakeside Holdings LLC');
    await p2.page.click('[data-step="2"] [data-next]');
    await p2.page.waitForFunction((r) => { for (const k of Object.keys(localStorage)) if (k.startsWith('sosg_signup_v3')) return JSON.parse(localStorage.getItem(k)).state.sign.ref !== r; return false; }, ref1);
    const ref2 = (await lsSign(p2.page)).ref;
    check('6 Amended Step 1 after signing → a fresh agreement (new ref) must be signed; the old signed record is untouched', ref2 !== ref1 && (await rec(ref1)).status === 'signed' && (await rec(ref2)).status === 'awaiting_email_verification' && await p2.page.isVisible('#sign-form'));
    await p2.ctx.close();
    // unsigned amendment supersedes the old unsigned record
    const U = await apiSignup({ signIt: false });
    const U2 = await api('POST', '/api/sign/start', { info: { ...INFO(U.email), legal_name: 'Lee Holdings LLC' }, resume: { ref: U.ref, token: U.token } });
    check('6 Changing details before signing supersedes the old unsigned signup', U2.body.ref !== U.ref && (await rec(U.ref)).status === 'superseded' && (await rec(U.ref)).superseded_by === U2.body.ref);
  }

  // ===== 7. Abuse limits, retention purge, export =====
  {
    const R = await api('POST', '/api/sign/start', { info: INFO(`rl-${uniq()}@example.com`) });
    const sends = [];
    for (let k = 0; k < 4; k++) sends.push((await api('POST', '/api/sign/email/send', { ref: R.body.ref }, R.body.token)).status);
    check('7 Code requests limited (3 per 15 minutes per signup)', sends.join() === '200,200,200,429', sends.join());
    const w4 = await newWorker(WORKER_PORT + 4, { MAX_STARTS_PER_IP_PER_DAY: '2' });
    const codes = [];
    for (let k = 0; k < 3; k++) codes.push((await fetch(w4.url + '/api/sign/start', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: JSON.stringify({ info: INFO(`r${k}@example.com`) }) })).status);
    check('7 New signups limited per connection per day', codes.join() === '200,200,429', codes.join());
    // retention: unsigned + 40 days old → purged; signed + 40 days old → kept
    const oldU = await api('POST', '/api/sign/start', { info: INFO(`old-${uniq()}@example.com`) });
    const oldS = await apiSignup({});
    const past = new Date(Date.now() - 40 * 86400e3).toISOString();
    await db.prepare('UPDATE signups SET created_at = ? WHERE ref IN (?, ?)').bind(past, oldU.body.ref, oldS.ref).run();
    const wk = await mf.getWorker();
    await wk.scheduled({ cron: '17 * * * *', scheduledTime: new Date(new Date().setUTCHours(12, 17, 0, 0)) });
    await new Promise((r) => setTimeout(r, 500));
    check('7 Daily purge deletes abandoned unsigned signups after 30 days (and their audit/codes)', !(await rec(oldU.body.ref)) && (await auditOf(oldU.body.ref)).length === 0);
    check('7 Signed agreements and their audit trails are retained', (await rec(oldS.ref)).status === 'signed' && (await auditOf(oldS.ref)).length > 0 && !!(await r2.head((await rec(oldS.ref)).pdf_key)));
    // export (same queries as _tools/export-signed-agreements.sh): every signed record + its audit + its PDF
    const ex = (await db.prepare("SELECT ref, agreement_id, signed_at, pdf_key, pdf_sha256 FROM signups WHERE signed_at IS NOT NULL ORDER BY signed_at").all()).results;
    let allMatch = ex.length > 0;
    for (const x of ex) { const o = await r2.get(x.pdf_key); allMatch = allMatch && o && sha(Buffer.from(await o.arrayBuffer())) === x.pdf_sha256 && (await L.verifyAuditChain(await auditOf(x.ref))).ok; }
    check(`7 Export: all ${ex.length} signed records have a PDF whose SHA-256 matches and an intact audit chain`, allMatch);
    await w4.mf.dispose();
  }

  // helpers for 9 + 10
  const waitFor = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 100)); } };
  const mailsTo = (email) => M.S.inbox.filter((m) => m.to[0] === email);
  async function payBuild(P, planId = 'maintain', facilities = 1, buildIncluded = true) {
    const qq = await api('POST', '/api/order/quote', { ref: P.ref, facilities, planId, buildIncluded }, P.token);
    const co = await api('POST', '/api/order/checkout', { ref: P.ref, quoteId: qq.body.quote.id, approve: true, approvedDueTodayCents: qq.body.quote.dueTodayCents, approvedMonthlyCents: qq.body.quote.monthlyCents }, P.token);
    if (co.body.url) { const sid = co.body.url.split('/pay/')[1]; await M.stripeWebhook('checkout.session.completed', { ...M.S.sessions[sid], status: 'complete', payment_status: 'paid', payment_intent: 'pi_x', customer: 'cus_' + uniq(), invoice: 'in_' + uniq() }); }
    return qq.body.quote;
  }
  const LAUNCH_SQL = "INSERT INTO launches (ref, launched_at, site_url, marked_by, subscription_status, created_at, updated_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'owner-cli', 'link_pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  const markLaunched = (ref, url = 'https://leestorage.example') => db.prepare(LAUNCH_SQL).bind(ref, url).run().then(() => 'ok', (e) => e.message);
  const runCron = async (hour = 12) => { await (await mf.getWorker()).scheduled({ cron: '17 * * * *', scheduledTime: new Date(new Date().setUTCHours(hour, 17, 0, 0)) }); await new Promise((r) => setTimeout(r, 400)); };
  const linkFor = (email) => { const m = [...mailsTo(email)].reverse().find((x) => /signup\/monthly\/\?ref=/.test(x.text || '')); return m && /(\/signup\/monthly\/\?ref=(SOSG-\d{8}-[a-z0-9]{6})#t=([A-Za-z0-9_-]+))/.exec(m.text); };

  // ===== 9. Signed agreements stay reachable after the 30-day signup token expires =====
  {
    const A = await apiSignup({});
    const rA = await rec(A.ref);
    await db.prepare('UPDATE signups SET token_expires_at = ? WHERE ref = ?').bind(new Date(Date.now() - 1000).toISOString(), A.ref).run();
    const st = await api('GET', `/api/sign/status?ref=${A.ref}`, null, A.token);
    const pdf = await api('GET', `/api/sign/pdf?ref=${A.ref}`, null, A.token);
    check('9 Expired token on a SIGNED agreement → 401 that says it is safely on file and where to get a copy', st.status === 401 && st.body.signed === true && st.body.copyPath === '/signup/copy/' && pdf.status === 401);
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM signups WHERE email = ?').bind(A.email).first()).n;
    const rs = await api('POST', '/api/sign/start', { info: INFO(A.email), resume: { ref: A.ref, token: A.token } });
    const after = (await db.prepare('SELECT COUNT(*) AS n FROM signups WHERE email = ?').bind(A.email).first()).n;
    check('9 Returning with an expired link never silently starts a second agreement', rs.status === 401 && rs.body.signed === true && before === after);
    const n0 = mailsTo(A.email).length;
    const c1 = await api('POST', '/api/records/copy', { email: A.email.toUpperCase(), ref: A.ref });
    const got = await waitFor(() => mailsTo(A.email).length > n0 && [...mailsTo(A.email)].pop());
    check('9 Copy request → original signed PDF emailed to the signing address (bytes = D1 fingerprint = R2)', c1.status === 202 && got && got.attachments && sha(Buffer.from(got.attachments[0].content, 'base64')) === rA.pdf_sha256 && got.text.includes(rA.pdf_sha256) && sha(Buffer.from(await (await r2.get(rA.pdf_key)).arrayBuffer())) === rA.pdf_sha256);
    check('9 Copy request is recorded in the audit trail (chain still verifies)', (await auditOf(A.ref)).some((x) => x.event === 'signed_copy_resent') && (await L.verifyAuditChain(await auditOf(A.ref))).ok);
    const U = await apiSignup({ signIt: false });
    const n1 = M.S.inbox.length;
    const wrong = await api('POST', '/api/records/copy', { email: 'attacker@example.com', ref: A.ref });
    const nobody = await api('POST', '/api/records/copy', { email: `nobody-${uniq()}@example.com` });
    const unsigned = await api('POST', '/api/records/copy', { email: U.email });
    await new Promise((r) => setTimeout(r, 600));
    check('9 Wrong email / unknown email / unsigned: identical answer, nothing sent to anyone', [wrong, nobody, unsigned].every((x) => x.status === 202 && x.body.message === c1.body.message) && M.S.inbox.length === n1);
    for (let k = 0; k < 3; k++) await api('POST', '/api/records/copy', { email: A.email });
    await new Promise((r) => setTimeout(r, 600));
    check('9 Copies limited to 3 per email address per day (no inbox flooding)', mailsTo(A.email).filter((m) => /^Copy of your signed/.test(m.subject)).length === 3);
    const bad = await api('POST', '/api/records/copy', { email: 'not-an-email' });
    check('9 Malformed request refused', bad.status === 400);
    // owner recovery (same queries as _tools/get-signed-agreement.sh): works regardless of any token
    const own = await db.prepare('SELECT pdf_key, pdf_sha256 FROM signups WHERE ref = ? AND signed_at IS NOT NULL').bind(A.ref).first();
    check('9 Owner recovery by reference: original PDF + matching SHA-256, no customer token needed', own && sha(Buffer.from(await (await r2.get(own.pdf_key)).arrayBuffer())) === own.pdf_sha256);
    // the customer page
    const B = await apiSignup({});
    const { ctx, page, errors } = await newPage();
    await page.route('**/js/records.js', (r) => r.continue());
    await page.goto(SITE + '/signup/copy/?ref=' + B.ref);
    await page.fill('#copy_email', B.email);
    await page.click('#copy-btn');
    await page.waitForFunction(() => /on its way/.test(document.getElementById('copy-status').textContent));
    const gotB = await waitFor(() => mailsTo(B.email).find((m) => /^Copy of your signed/.test(m.subject)));
    await shot(page, '9-copy-page');
    check('9 "Get a copy of your signed agreement" page works (desktop), no JS errors', !!gotB && (await page.inputValue('#copy_ref')) === B.ref && errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ===== 10. Monthly billing can only start after the website launches =====
  {
    const P = await apiSignup({});
    const subsBefore = M.S.calls.filter((c) => c.stripe === 'create_session' && c.params.mode === 'subscription').length;
    check('10 Signup checkout never creates a subscription (all sessions so far are one-time)', subsBefore === 0 && M.S.calls.filter((c) => c.stripe === 'create_session').every((c) => c.params.mode === 'payment'));
    const early = await markLaunched(P.ref);
    check('10 A launch cannot be recorded before the build is paid (database refuses)', /signed, paid/.test(early));
    const qt = await payBuild(P, 'maintain', 2);
    check('10 Paid build: monthly ($118.00 = 2 × $59) promised "starting the day your new website goes live"', (await rec(P.ref)).status === 'paid' && qt.monthlyCents === 11800 && qt.approval_text.includes('starting the day your new website goes live'));
    const pre1 = await api('GET', `/api/monthly/status?ref=${P.ref}`, null, crypto.randomBytes(32).toString('base64url'));
    const pre2 = await api('POST', '/api/monthly/checkout', { ref: P.ref, approve: true, approvedMonthlyCents: 11800 }, P.token);
    await runCron();
    check('10 Before launch: no billing link exists, the signup token can’t start billing, cron sends nothing', pre1.status === 404 && pre2.status === 404 && !linkFor(P.email));
    check('10 Owner records the launch (mark-launched.sh SQL)', (await markLaunched(P.ref)) === 'ok' && (await db.prepare('SELECT subscription_status FROM launches WHERE ref = ?').bind(P.ref).first()).subscription_status === 'link_pending');
    await runCron();
    const L1 = linkFor(P.email);
    const lrow = await db.prepare('SELECT * FROM launches WHERE ref = ?').bind(P.ref).first();
    check('10 Hourly cron emails a private 14-day billing link (token only in the #fragment, stored as a hash)', L1 && L1[2] === P.ref && lrow.link_sent_at && lrow.subscription_status === 'link_sent' && lrow.link_token_hash === sha(L1[3]) && Math.round((Date.parse(lrow.link_expires_at) - Date.now()) / 86400e3) === 14);
    await runCron();
    check('10 Link is sent once (cron re-runs send nothing new)', mailsTo(P.email).filter((m) => /start your/.test(m.subject)).length === 1);
    const tok = L1[3];
    const ms = await api('GET', `/api/monthly/status?ref=${P.ref}`, null, tok);
    check('10 Billing page shows plan, facilities and exact monthly amount', ms.status === 200 && ms.body.planName === 'Maintain' && ms.body.facilities === 2 && ms.body.monthlyCents === 11800 && ms.body.approvalText.includes('$118.00 per month for Maintain'));
    const na = await api('POST', '/api/monthly/checkout', { ref: P.ref, approve: false, approvedMonthlyCents: 11800 }, tok);
    const wa = await api('POST', '/api/monthly/checkout', { ref: P.ref, approve: true, approvedMonthlyCents: 100 }, tok);
    check('10 Monthly billing needs the customer’s approval of the exact amount', na.status === 400 && wa.status === 400 && wa.body.code === 'approval_mismatch');
    const mc = await api('POST', '/api/monthly/checkout', { ref: P.ref, approve: true, approvedMonthlyCents: 11800 }, tok);
    const sp = M.S.calls.filter((c) => c.stripe === 'create_session').pop().params;
    check('10 After approval: Stripe Checkout in subscription mode, 2 × the catalog $59.00/month Maintain price, same Stripe customer as the build, tied to the agreement',
      mc.status === 200 && sp.mode === 'subscription' && sp['line_items[0][quantity]'] === '2' && sp['line_items[0][price]'] === 'price_maintain' && !sp['line_items[0][price_data][unit_amount]'] && /^cus_/.test(sp.customer || '') && !sp.customer_email && sp['metadata[kind]'] === 'monthly' && sp['metadata[agreement_id]'] === (await rec(P.ref)).agreement_id && sp['subscription_data[metadata][signup_ref]'] === P.ref, JSON.stringify(sp).slice(0, 200));
    const mc2 = await api('POST', '/api/monthly/checkout', { ref: P.ref, approve: true, approvedMonthlyCents: 11800 }, tok);
    check('10 A second click reuses the same payment page (no duplicate subscriptions)', mc2.body.url === mc.body.url && mc2.body.reused === true);
    const sid = mc.body.url.split('/pay/')[1];
    M.S.sessions[sid].subscription = 'sub_test_P'; M.S.sessions[sid].payment_status = 'paid';
    await M.stripeWebhook('checkout.session.completed', M.S.sessions[sid]);
    const lp = await db.prepare('SELECT * FROM launches WHERE ref = ?').bind(P.ref).first();
    check('10 Verified webhook → subscription recorded active, amount = approved, audit event', lp.subscription_id === 'sub_test_P' && lp.subscription_status === 'active' && JSON.parse(lp.subscription_json).amount_matches_approval === true && (await auditOf(P.ref)).some((x) => x.event === 'monthly_subscription_started'));
    const again = await api('POST', '/api/monthly/checkout', { ref: P.ref, approve: true, approvedMonthlyCents: 11800 }, tok);
    check('10 Once active, no second subscription can be started', again.status === 409 && again.body.code === 'already_active');
    const moveDate = await db.prepare('UPDATE launches SET launched_at = ? WHERE ref = ?').bind('2020-01-01T00:00:00Z', P.ref).run().then(() => 'changed', (e) => e.message);
    const delL = await db.prepare('DELETE FROM launches WHERE ref = ?').bind(P.ref).run().then(() => 'deleted', (e) => e.message);
    check('10 Launch date is fixed once billing starts; launch records can’t be deleted', /fixed once billing/.test(moveDate) && /cannot be deleted/.test(delL));
    const plSub = await M.stripeWebhook('checkout.session.completed', { id: 'cs_test_plink_sub', mode: 'subscription', subscription: 'sub_plink', payment_link: 'plink_maintain', amount_total: 5900, payment_status: 'paid', customer_details: { email: 'someone@example.com' } });
    const umS = await db.prepare('SELECT * FROM unmatched_payments WHERE session_id = ?').bind('cs_test_plink_sub').first();
    check('10 A subscription from an old Payment Link (no recorded launch) is flagged for review, never matched', plSub.status === 200 && umS && JSON.parse(umS.detail).payment_link === 'plink_maintain');
    // expired link
    const E = await apiSignup({});
    await payBuild(E, 'improve', 1);
    await markLaunched(E.ref); await runCron();
    const LE = linkFor(E.email);
    await db.prepare('UPDATE launches SET link_expires_at = ? WHERE ref = ?').bind(new Date(Date.now() - 1000).toISOString(), E.ref).run();
    const ex = await api('POST', '/api/monthly/checkout', { ref: E.ref, approve: true, approvedMonthlyCents: 9900 }, LE[3]);
    check('10 Expired billing link refused (owner can --resend a fresh one)', ex.status === 401 && ex.body.code === 'link_expired');
    await db.prepare("UPDATE launches SET link_sent_at = NULL, link_token_hash = NULL, link_send_attempts = 0, subscription_status = 'link_pending' WHERE ref = ? AND subscription_id IS NULL").bind(E.ref).run();
    await runCron();
    const LE2 = linkFor(E.email);
    check('10 --resend issues a new link; the old link stays dead', LE2 && LE2[3] !== LE[3] && (await api('GET', `/api/monthly/status?ref=${E.ref}`, null, LE[3])).status === 404 && (await api('GET', `/api/monthly/status?ref=${E.ref}`, null, LE2[3])).status === 200);
    // the customer page, on a phone
    const { ctx, page, errors } = await newPage({ device: 'iPhone 13' });
    await page.goto(SITE + LE2[1]);
    await page.waitForSelector('#monthly-ready:not([hidden])');
    const urlNoToken = !page.url().includes('#t=');
    check('10 Mobile billing page: $99.00/month for Maintain + Improve, button locked until approved; token removed from the address bar', (await page.textContent('#m-total')) === '$99.00/month' && await page.isDisabled('#monthly-btn') && urlNoToken);
    await shot(page, '10-monthly-page');
    await page.check('#monthly_approved');
    await Promise.all([page.waitForURL(/\/pay\/cs_test_/), page.click('#monthly-btn')]);
    check('10 Stripe page for exactly $99.00 (first month)', (await page.textContent('#amount')) === '$99.00');
    await Promise.all([page.waitForURL(/done=1/), page.click('#pay')]);
    await page.waitForSelector('#monthly-done:not([hidden])');
    const le = await db.prepare('SELECT * FROM launches WHERE ref = ?').bind(E.ref).first();
    check('10 After paying: "Your monthly plan is set up", subscription active in the record, no JS errors', le.subscription_status === 'active' && /^sub_/.test(le.subscription_id) && errors.length === 0, errors.join('; '));
    await ctx.close();
    // monthly-only order and no-monthly order
    const MO = await apiSignup({});
    await payBuild(MO, 'maintain', 1, false);
    check('10 Monthly-only order (nothing due at signup) can be launched later; billing still waits for launch', (await rec(MO.ref)).status === 'submitted_no_payment' && (await markLaunched(MO.ref)) === 'ok');
    const NM = await apiSignup({});
    await payBuild(NM, 'none', 1);
    await markLaunched(NM.ref); await runCron();
    check('10 Build-only order: launch recorded, no billing link sent', (await db.prepare('SELECT subscription_status FROM launches WHERE ref = ?').bind(NM.ref).first()).subscription_status === 'not_needed' && !linkFor(NM.email));
  }

  // ===== 12. Review fixes: one subscription only, paid quote frozen, no lost webhooks, ACH, cancellations =====
  {
    const sessCalls = () => M.S.calls.filter((c) => c.stripe === 'create_session' && c.params.mode === 'subscription').length;
    const launchOf = (ref) => db.prepare('SELECT * FROM launches WHERE ref = ?').bind(ref).first();
    // quote changed after the build checkout opened → monthly uses the PAID quote
    const Q = await apiSignup({});
    const qa = await api('POST', '/api/order/quote', { ref: Q.ref, facilities: 7, planId: 'improve' }, Q.token);
    const coA = await api('POST', '/api/order/checkout', { ref: Q.ref, quoteId: qa.body.quote.id, approve: true, approvedDueTodayCents: qa.body.quote.dueTodayCents, approvedMonthlyCents: qa.body.quote.monthlyCents }, Q.token);
    await api('POST', '/api/order/quote', { ref: Q.ref, facilities: 1, planId: 'maintain' }, Q.token); // re-quoted, never checked out
    const sidA = coA.body.url.split('/pay/')[1];
    await fetch(coA.body.url + '/complete', { method: 'POST', redirect: 'manual' });
    await markLaunched(Q.ref); await runCron();
    const LQ = linkFor(Q.email);
    const qs = await api('GET', `/api/monthly/status?ref=${Q.ref}`, null, LQ[3]);
    check('12 Monthly plan comes from the quote that was PAID (7 × Maintain + Improve), not a later re-quote', JSON.parse((await rec(Q.ref)).payment_json).quote_matches_approval === true && qs.body.facilities === 7 && qs.body.monthlyCents === 69300 && M.S.sessions[sidA].status === 'complete');
    // three simultaneous clicks → one payment page
    const n0 = sessCalls();
    const clicks = await Promise.all([0, 1, 2].map(() => api('POST', '/api/monthly/checkout', { ref: Q.ref, approve: true, approvedMonthlyCents: 69300 }, LQ[3])));
    const urls = new Set(clicks.filter((c) => c.body.url).map((c) => c.body.url));
    check('12 Three simultaneous clicks → exactly one Stripe page (others reuse it or wait)', sessCalls() - n0 === 1 && urls.size === 1 && clicks.every((c) => c.status === 200 || c.body.code === 'checkout_in_progress'), clicks.map((c) => c.status).join(','));
    // page about to expire → a new one is opened and the old one is CLOSED at Stripe first
    const s1 = [...urls][0].split('/pay/')[1];
    await db.prepare('UPDATE launch_sessions SET expires_at = ? WHERE session_id = ?').bind(new Date(Date.now() + 30e3).toISOString(), s1).run();
    const c2 = await api('POST', '/api/monthly/checkout', { ref: Q.ref, approve: true, approvedMonthlyCents: 69300 }, LQ[3]);
    const s2 = c2.body.url.split('/pay/')[1];
    const payOld = await fetch(`${M.base}/pay/${s1}/complete`, { method: 'POST', redirect: 'manual' });
    check('12 Opening a new page closes the old one at Stripe first (old page can no longer be paid)', s2 !== s1 && M.S.sessions[s1].status === 'expired' && payOld.status === 400 && M.S.calls.some((c) => c.stripe === 'expire_session' && c.id === s1));
    // an older session that WAS paid is still recognised as ours (no false "unmatched")
    M.S.sessions[s1].status = 'complete'; M.S.sessions[s1].payment_status = 'paid'; M.S.sessions[s1].subscription = 'sub_old_tab';
    await M.stripeWebhook('checkout.session.completed', M.S.sessions[s1]);
    const lq = await launchOf(Q.ref);
    check('12 Paying an older page this Worker opened still activates the plan (matched by recorded session)', lq.subscription_id === 'sub_old_tab' && lq.subscription_status === 'active' && !(await db.prepare('SELECT 1 FROM unmatched_payments WHERE session_id = ?').bind(s1).first()));
    M.S.sessions[s2].status = 'complete'; M.S.sessions[s2].payment_status = 'paid'; M.S.sessions[s2].subscription = 'sub_second';
    const dupW = await M.stripeWebhook('checkout.session.completed', M.S.sessions[s2]);
    check('12 A second subscription for the same launch is flagged for review; the first stays recorded', dupW.status === 200 && (await launchOf(Q.ref)).subscription_id === 'sub_old_tab' && !!(await db.prepare('SELECT 1 FROM unmatched_payments WHERE session_id = ?').bind(s2).first()));
    // cancellations / failed renewals reach the record
    await M.stripeWebhook('invoice.payment_failed', { id: 'in_1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_old_tab' } } }); // 2026 API shape
    const pd = (await launchOf(Q.ref)).subscription_status;
    await M.stripeWebhook('customer.subscription.deleted', { id: 'sub_old_tab', status: 'canceled' });
    const qs2 = await api('GET', `/api/monthly/status?ref=${Q.ref}`, null, LQ[3]);
    check('12 Failed renewal → past_due; cancellation → canceled and the page no longer says active', pd === 'past_due' && (await launchOf(Q.ref)).subscription_status === 'canceled' && qs2.body.active === false);
    // ACH: processing is not active; failure lets the customer try again; success activates
    const A = await apiSignup({});
    await payBuild(A, 'maintain', 1);
    await markLaunched(A.ref); await runCron();
    const LA = linkFor(A.email);
    const ca = await api('POST', '/api/monthly/checkout', { ref: A.ref, approve: true, approvedMonthlyCents: 5900 }, LA[3]);
    const sa = ca.body.url.split('/pay/')[1];
    await M.stripeWebhook('checkout.session.completed', { ...M.S.sessions[sa], status: 'complete', payment_status: 'unpaid', subscription: 'sub_ach' });
    const proc = await api('GET', `/api/monthly/status?ref=${A.ref}`, null, LA[3]);
    const again = await api('POST', '/api/monthly/checkout', { ref: A.ref, approve: true, approvedMonthlyCents: 5900 }, LA[3]);
    await M.stripeWebhook('checkout.session.async_payment_failed', { ...M.S.sessions[sa], status: 'complete', payment_status: 'unpaid', subscription: 'sub_ach' });
    const afterFail = await api('GET', `/api/monthly/status?ref=${A.ref}`, null, LA[3]);
    M.S.sessions[sa].status = 'complete';
    const retry = await api('POST', '/api/monthly/checkout', { ref: A.ref, approve: true, approvedMonthlyCents: 5900 }, LA[3]);
    check('12 Bank debit: "processing" (not active, no second page); failed → can retry with a new page', proc.body.active === false && proc.body.processing === true && again.body.code === 'payment_processing' && afterFail.body.active === false && afterFail.body.status === 'payment_failed' && retry.status === 200 && retry.body.url && !retry.body.reused, [proc.body.status, again.body.code, afterFail.body.status, retry.status].join(','));
    const sr = retry.body.url.split('/pay/')[1];
    await M.stripeWebhook('checkout.session.async_payment_succeeded', { ...M.S.sessions[sr], status: 'complete', payment_status: 'paid', subscription: 'sub_ach2' });
    check('12 Bank debit clears → active', (await launchOf(A.ref)).subscription_status === 'active' && (await launchOf(A.ref)).subscription_id === 'sub_ach2');
    // a webhook that fails mid-way is NOT marked as seen: Stripe's retry gets processed
    const B = await apiSignup({});
    const qb = await api('POST', '/api/order/quote', { ref: B.ref, facilities: 1, planId: 'none' }, B.token);
    const cb = await api('POST', '/api/order/checkout', { ref: B.ref, quoteId: qb.body.quote.id, approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 0 }, B.token);
    const sb = cb.body.url.split('/pay/')[1];
    const goodApproval = (await rec(B.ref)).approval_json;
    await db.prepare('UPDATE signups SET approval_json = ? WHERE ref = ?').bind('{broken', B.ref).run();
    const w1 = await M.stripeWebhook('checkout.session.completed', { ...M.S.sessions[sb], payment_status: 'paid' }, undefined, 'evt_retry_test');
    await db.prepare('UPDATE signups SET approval_json = ? WHERE ref = ?').bind(goodApproval, B.ref).run();
    const w2 = await M.stripeWebhook('checkout.session.completed', { ...M.S.sessions[sb], payment_status: 'paid' }, undefined, 'evt_retry_test');
    check('12 Webhook that fails is retried by Stripe and processed (not dropped as a duplicate)', w1.status === 500 && w2.status === 200 && (await rec(B.ref)).status === 'paid');
    // build: re-opening payment closes the earlier page
    const C = await apiSignup({});
    const qc = await api('POST', '/api/order/quote', { ref: C.ref, facilities: 1, planId: 'none' }, C.token);
    const k1 = await api('POST', '/api/order/checkout', { ref: C.ref, quoteId: qc.body.quote.id, approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 0 }, C.token);
    const k2 = await api('POST', '/api/order/checkout', { ref: C.ref, quoteId: qc.body.quote.id, approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 0 }, C.token);
    const o1 = k1.body.url.split('/pay/')[1];
    check('12 Build: coming back to pay again closes the first page (no double build charge)', k2.status === 200 && k2.body.url !== k1.body.url && M.S.sessions[o1].status === 'expired');
    await fetch(k2.body.url + '/complete', { method: 'POST', redirect: 'manual' });
    const k3 = await api('POST', '/api/order/checkout', { ref: C.ref, quoteId: qc.body.quote.id, approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 0 }, C.token);
    check('12 Build: after paying, a new payment page is refused', k3.status === 403 || k3.body.code === 'already_paid', k3.body.code);
    // live keys with test-phase addresses → everything refused
    const w5 = await newWorker(WORKER_PORT + 5, { STRIPE_SECRET_KEY: 'sk_live_example', SITE_URL: 'http://127.0.0.1:8765' });
    const h5 = await (await fetch(w5.url + '/api/health')).json();
    const s5 = await fetch(w5.url + '/api/sign/start', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: JSON.stringify({ info: INFO('x@example.com') }) });
    check('12 Live Stripe key + test-phase addresses → API refuses (503) and health says liveConfigSafe=false', s5.status === 503 && h5.liveConfigSafe === false && h5.stripeMode === 'live');
    await w5.mf.dispose();
    // real-phone test on home Wi-Fi: LAN origins only when switched on AND Stripe is in test mode
    const lanO = 'http://192.168.1.23:8765';
    const lanOff = await api('POST', '/api/sign/start', { info: INFO(`lan-${uniq()}@example.com`) }, null, lanO);
    const w6 = await newWorker(WORKER_PORT + 6, { ALLOW_LAN_TEST_ORIGINS: 'true' });
    const lanOn = await fetch(w6.url + '/api/sign/start', { method: 'POST', headers: { Origin: lanO, 'Content-Type': 'application/json' }, body: JSON.stringify({ info: INFO(`lan-${uniq()}@example.com`) }) });
    const pub = await fetch(w6.url + '/api/sign/start', { method: 'POST', headers: { Origin: 'http://203.0.113.9:8765', 'Content-Type': 'application/json' }, body: JSON.stringify({ info: INFO(`lan-${uniq()}@example.com`) }) });
    await w6.mf.dispose();
    const w7 = await newWorker(WORKER_PORT + 7, { ALLOW_LAN_TEST_ORIGINS: 'true', STRIPE_SECRET_KEY: 'sk_live_example' });
    const h7 = await (await fetch(w7.url + '/api/health')).json();
    await w7.mf.dispose();
    check('12 Home-Wi-Fi phone testing: private-network origin accepted only when switched on in test mode; public IPs never; live keys refuse it', lanOff.status === 403 && lanOn.status === 200 && pub.status === 403 && h7.liveConfigSafe === false);
  }

  // ===== 13. Billing completion: welcome emails, one Stripe customer, catalog prices, portal, plan switch, cancel =====
  {
    const launchOf = (ref) => db.prepare('SELECT * FROM launches WHERE ref = ?').bind(ref).first();
    const OWNER = 'owner@example.test';
    const welcomes = (email) => mailsTo(email).filter((m) => /^Welcome — /.test(m.subject));
    // build: WELCOME50 → $149.00 paid; Stripe customer + invoice; welcome email once
    const W = await apiSignup({});
    const wq = await api('POST', '/api/order/quote', { ref: W.ref, facilities: 1, planId: 'maintain', promoCode: 'WELCOME50' }, W.token);
    const wc = await api('POST', '/api/order/checkout', { ref: W.ref, quoteId: wq.body.quote.id, approve: true, approvedDueTodayCents: wq.body.quote.dueTodayCents, approvedMonthlyCents: wq.body.quote.monthlyCents }, W.token);
    const wp = M.S.calls.filter((c) => c.stripe === 'create_session').pop().params;
    check('13 Build checkout: $149.00 with WELCOME50, one Stripe customer per signup, Stripe invoice tied to the agreement',
      wq.body.quote.dueTodayCents === 14900 && wp['line_items[0][price]'] === 'price_build' && wp.customer_creation === 'always' && wp['invoice_creation[enabled]'] === 'true' && wp['invoice_creation[invoice_data][metadata][agreement_id]'] === (await rec(W.ref)).agreement_id && wp['discounts[0][promotion_code]'] === 'promo_w50', JSON.stringify(wp).slice(0, 300));
    const wsid = wc.body.url.split('/pay/')[1];
    const before = welcomes(W.email).length;
    await fetch(wc.body.url + '/complete', { method: 'POST', redirect: 'manual' });
    const wr = await rec(W.ref), wpay = JSON.parse(wr.payment_json);
    const wm = welcomes(W.email);
    check('13 After Stripe confirms: paid $149.00, Stripe customer + invoice recorded on the signed agreement', wr.status === 'paid' && wpay.amount_total === 14900 && /^cus_/.test(wpay.customer) && /^in_/.test(wpay.invoice) && M.S.sessions[wsid].amount_total === 14900);
    check('13 Welcome email: amount, $50 WELCOME50 discount, monthly starts at launch, agreement ID, copy + billing links', before === 0 && wm.length === 1 && wm[0].text.includes('Paid today: $149.00') && wm[0].text.includes('$50.00 off with WELCOME50') && wm[0].text.includes('starts on the day your new website goes live') && wm[0].text.includes(wr.agreement_id) && wm[0].text.includes('/signup/billing/') && wm[0].text.includes('Access Day'));
    const on = mailsTo(OWNER).filter((m) => m.subject.includes(W.ref));
    check('13 Owner notice: paid amount + the mark-launched command for launch day', on.length === 1 && on[0].subject.includes('$149.00') && on[0].text.includes('mark-launched.sh ' + W.ref));
    await M.stripeWebhook('checkout.session.completed', M.S.sessions[wsid]); // Stripe re-delivery with a new event id
    check('13 Repeat webhook: no second welcome email, still one payment', welcomes(W.email).length === 1 && (await rec(W.ref)).status === 'paid' && (await auditOf(W.ref)).filter((x) => x.event === 'welcome_email_sent').length === 1);
    // monthly-only order: welcome with "nothing charged today"
    const Z = await apiSignup({});
    await payBuild(Z, 'improve', 1, false);
    check('13 Nothing-due-today order also gets the welcome email ("Nothing was charged today")', welcomes(Z.email).length === 1 && welcomes(Z.email)[0].text.includes('Nothing was charged today'));
    // launch → monthly at the catalog price, on the SAME Stripe customer
    await markLaunched(W.ref); await runCron();
    const LW = linkFor(W.email);
    const mcw = await api('POST', '/api/monthly/checkout', { ref: W.ref, approve: true, approvedMonthlyCents: 5900 }, LW[3]);
    const mp = M.S.calls.filter((c) => c.stripe === 'create_session').pop().params;
    check('13 Monthly checkout after launch: catalog $59 Maintain price, same Stripe customer as the build (no duplicate customer)', mcw.status === 200 && mp.mode === 'subscription' && mp['line_items[0][price]'] === 'price_maintain' && mp.customer === wpay.customer && !mp.customer_email);
    await fetch(mcw.body.url + '/complete', { method: 'POST', redirect: 'manual' });
    const lw = await launchOf(W.ref);
    const act = mailsTo(W.email).filter((m) => /plan is active/.test(m.subject));
    check('13 Monthly active → customer confirmation (switch/cancel terms, billing link) + owner notice, once', lw.subscription_status === 'active' && act.length === 1 && act[0].text.includes('next billing date') && act[0].text.includes('/signup/billing/') && mailsTo(OWNER).some((m) => m.subject.startsWith('Monthly started') && m.subject.includes(W.ref)));
    // billing portal from the launch link
    const nP = M.S.calls.filter((c) => c.stripe === 'portal_session').length;
    const bp = await api('POST', '/api/billing/portal', { ref: W.ref }, LW[3]);
    const pp = M.S.calls.filter((c) => c.stripe === 'portal_session').pop().params;
    check('13 Billing portal (launch link): Stripe-hosted, this customer only, our portal configuration, returns to /signup/billing/', bp.status === 200 && /\/portal\/bps_/.test(bp.body.url) && pp.customer === wpay.customer && pp.configuration === 'bpc_test' && pp.return_url === SITE + '/signup/billing/?done=1' && M.S.calls.filter((c) => c.stripe === 'portal_session').length === nP + 1);
    const bad1 = await api('POST', '/api/billing/portal', { ref: W.ref }, crypto.randomBytes(32).toString('base64url'));
    const bad2 = await api('POST', '/api/billing/portal', { ref: Z.ref }, LW[3]);
    const bad3 = await api('POST', '/api/billing/portal', { ref: W.ref });
    check('13 Portal refused without the right private link (wrong token, another customer’s ref, no token)', bad1.status === 404 && bad2.status === 404 && bad3.status === 404);
    // emailed one-hour billing link
    const bl = await api('POST', '/api/billing/link', { email: W.email });
    const bu = await api('POST', '/api/billing/link', { email: `nobody-${uniq()}@example.com` });
    await new Promise((r) => setTimeout(r, 300));
    const lm = [...mailsTo(W.email)].reverse().find((m) => /secure billing link/.test(m.subject));
    const lk = lm && /\/signup\/billing\/\?ref=(SOSG-\d{8}-[a-z0-9]{6})#t=([A-Za-z0-9_-]+)/.exec(lm.text);
    check('13 Billing link request: same answer for known and unknown emails; link emailed only to the address on file', bl.status === 202 && bu.status === 202 && bl.body.message === bu.body.message && lk && lk[1] === W.ref);
    const ptRow = await db.prepare('SELECT * FROM portal_tokens WHERE ref = ? ORDER BY created_at DESC').bind(W.ref).first();
    const bpe = await api('POST', '/api/billing/portal', { ref: W.ref }, lk[2]);
    check('13 Emailed link opens the portal (token stored only as a hash, expires in 1 hour)', bpe.status === 200 && ptRow.token_hash === sha(lk[2]) && Math.abs(Date.parse(ptRow.expires_at) - Date.now() - 3600e3) < 120e3);
    await db.prepare('UPDATE portal_tokens SET expires_at = ? WHERE token_hash = ?').bind(new Date(Date.now() - 1000).toISOString(), sha(lk[2])).run();
    const bpx = await api('POST', '/api/billing/portal', { ref: W.ref }, lk[2]);
    check('13 Expired emailed link refused', bpx.status === 401 && bpx.body.code === 'link_expired');
    const NC = await apiSignup({});
    await api('POST', '/api/billing/link', { email: NC.email });
    await new Promise((r) => setTimeout(r, 300));
    check('13 Signed but never paid (no Stripe customer): no billing link is sent', !mailsTo(NC.email).some((m) => /secure billing link/.test(m.subject)));
    // plan switch in the portal: recorded, no new checkout, no charge from us
    const subW = lw.subscription_id;
    const nS = M.S.calls.filter((c) => c.stripe === 'create_session').length;
    const item = (price, unit) => ({ items: { data: [{ quantity: 1, current_period_end: 1800000000, price: { id: price, product: price.replace('price_', 'prod_'), unit_amount: unit } }] } });
    await M.stripeWebhook('customer.subscription.updated', { id: subW, status: 'active', cancel_at_period_end: false, ...item('price_improve', 9900) });
    const sw = JSON.parse((await launchOf(W.ref)).subscription_json);
    check('13 Switch to Maintain + Improve ($99) in the portal → recorded on the launch; no new checkout or subscription created', sw.current_plan === 'improve' && sw.current_unit_amount === 9900 && (await launchOf(W.ref)).subscription_status === 'active' && (await launchOf(W.ref)).subscription_id === subW && M.S.calls.filter((c) => c.stripe === 'create_session').length === nS);
    await M.stripeWebhook('customer.subscription.updated', { id: subW, status: 'active', cancel_at_period_end: false, ...item('price_maintain', 5900) });
    check('13 Switch back to Maintain ($59) recorded', JSON.parse((await launchOf(W.ref)).subscription_json).current_plan === 'maintain');
    // cancel at period end → still active until then; page shows it
    await M.stripeWebhook('customer.subscription.updated', { id: subW, status: 'active', cancel_at_period_end: true, ...item('price_maintain', 5900) });
    const cs = await api('GET', `/api/monthly/status?ref=${W.ref}`, null, LW[3]);
    const again = await api('POST', '/api/monthly/checkout', { ref: W.ref, approve: true, approvedMonthlyCents: 5900 }, LW[3]);
    check('13 Cancel in the portal → "cancel_scheduled", still active to the period end; a second subscription still can’t be started', (await launchOf(W.ref)).subscription_status === 'cancel_scheduled' && cs.body.active === true && again.status === 409);
    await M.stripeWebhook('customer.subscription.updated', { id: subW, status: 'active', cancel_at_period_end: false, ...item('price_maintain', 5900) });
    check('13 Un-cancel in the portal → active again', (await launchOf(W.ref)).subscription_status === 'active');
    // failed renewal → past_due + customer email pointing at the billing page
    await M.stripeWebhook('invoice.payment_failed', { id: 'in_fail', amount_due: 5900, parent: { type: 'subscription_details', subscription_details: { subscription: subW } } });
    const fm = mailsTo(W.email).filter((m) => /didn't go through/.test(m.subject));
    check('13 Failed renewal → past_due and the customer is emailed a way to update the card', (await launchOf(W.ref)).subscription_status === 'past_due' && fm.length === 1 && fm[0].text.includes('$59.00') && fm[0].text.includes('/signup/billing/'));
    await M.stripeWebhook('customer.subscription.updated', { id: subW, status: 'active', cancel_at_period_end: false, ...item('price_maintain', 5900) });
    check('13 Card updated and Stripe’s retry succeeds → active', (await launchOf(W.ref)).subscription_status === 'active');
    // someone else's subscription (e.g. a client's direct Payment Link) is never touched
    const nA = (await db.prepare('SELECT COUNT(*) n FROM audit').first()).n;
    const fr = await M.stripeWebhook('customer.subscription.updated', { id: 'sub_bd_storage', status: 'active', cancel_at_period_end: true, ...item('price_live_99', 9900) });
    const fr2 = await M.stripeWebhook('invoice.payment_failed', { id: 'in_bd', parent: { subscription_details: { subscription: 'sub_bd_storage' } } });
    check('13 Subscriptions this Worker didn’t create (e.g. a direct Payment Link) are ignored: no record changes, no emails', fr.status === 200 && fr2.status === 200 && (await db.prepare('SELECT COUNT(*) n FROM audit').first()).n === nA);
    // invitation pricing still works (price_data at the invited amount, not the catalog price)
    const iEmail = `inv13-${uniq()}@example.com`;
    const { url: inv13 } = await invite({ for: 'Lee Storage', setup: 149, maintain: 49, email: iEmail, exp: '2026-12-31' });
    const I = await apiSignup({ email: iEmail, inviteToken: inv13.split('invite=')[1] });
    await payBuild(I, 'maintain', 1);
    await markLaunched(I.ref); await runCron();
    const LI = linkFor(iEmail);
    await api('POST', '/api/monthly/checkout', { ref: I.ref, approve: true, approvedMonthlyCents: 4900 }, LI[3]);
    const ip = M.S.calls.filter((c) => c.stripe === 'create_session').pop().params;
    check('13 Private invitation price ($49 Maintain) uses an exact one-off price, not the $59 catalog price', ip['line_items[0][price_data][unit_amount]'] === '4900' && !ip['line_items[0][price]'] && ip['line_items[0][price_data][product]'] === 'prod_maintain', JSON.stringify(ip).slice(0, 200));
    // the billing page in a browser (desktop + phone)
    for (const dev of [null, 'iPhone 13']) {
      const { ctx, page, errors } = await newPage(dev ? { device: dev } : {});
      await page.goto(SITE + '/signup/billing/');
      await page.fill('#billing_email', W.email);
      await page.click('#billing-btn');
      await page.waitForFunction(() => /secure link is on its way/.test(document.getElementById('billing-status').textContent));
      await shot(page, `13-billing-request-${dev ? 'mobile' : 'desktop'}`);
      await new Promise((r) => setTimeout(r, 300));
      const m2 = [...mailsTo(W.email)].reverse().find((m) => /secure billing link/.test(m.subject));
      const k2 = /(\/signup\/billing\/\?ref=SOSG-\d{8}-[a-z0-9]{6}#t=[A-Za-z0-9_-]+)/.exec(m2.text)[1];
      await Promise.all([page.waitForURL(/\/portal\/bps_/), page.goto(SITE + k2)]);
      check(`13 ${dev ? 'Phone' : 'Desktop'}: billing page emails a link; opening it goes straight to Stripe’s portal; no JS errors`, /\/portal\/bps_/.test(page.url()) && errors.length === 0, errors.join('; '));
      await page.goto(SITE + '/signup/billing/?done=1');
      check(`13 ${dev ? 'Phone' : 'Desktop'}: back from Stripe → confirmation shown`, await page.isVisible('#billing-done'));
      await ctx.close();
    }
    // monthly page shows "Manage plan, card & invoices" once active, and it opens the portal
    {
      const { ctx, page, errors } = await newPage({});
      await page.goto(SITE + LW[1]);
      await page.waitForSelector('#monthly-done:not([hidden])');
      await Promise.all([page.waitForURL(/\/portal\/bps_/), page.click('#manage-billing')]);
      check('13 Launch billing page (active plan) → "Manage plan, card & invoices" opens Stripe’s portal (direct visit)', /\/portal\/bps_/.test(page.url()));
      await page.goto(SITE + `/signup/monthly/?ref=${W.ref}&done=1`); // straight back from Stripe: token comes from this tab's sessionStorage
      await page.waitForSelector('#monthly-done:not([hidden])');
      await Promise.all([page.waitForURL(/\/portal\/bps_/), page.click('#manage-billing')]);
      check('13 Launch billing page (active plan) → "Manage plan, card & invoices" opens Stripe’s portal', /\/portal\/bps_/.test(page.url()) && errors.length === 0, errors.join('; '));
      await ctx.close();
    }
  }

  // ===== 14. Production-readiness fixes =====
  {
    // controlled launch: closed → only allowlisted addresses can start
    const wg = await newWorker(WORKER_PORT + 8, { SIGNUP_OPEN: 'false', SIGNUP_ALLOWLIST: 'Owner@Example.com, other@example.com' });
    const st = (email) => fetch(wg.url + '/api/sign/start', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: JSON.stringify({ info: INFO(email) }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const gs = await st('stranger@example.com'), go = await st('owner@example.com');
    const hg = await (await fetch(wg.url + '/api/health')).json();
    await wg.mf.dispose();
    check('14 Controlled launch: signups closed to the public (friendly 403), allowlisted address can sign up; health shows signupOpen=false', gs.status === 403 && gs.body.code === 'signup_not_open' && /opens soon/.test(gs.body.error) && go.status === 200 && hg.signupOpen === false);
    // $0 order after a payment page was opened → that page is closed and can't be paid
    const Z = await apiSignup({});
    const zq = await api('POST', '/api/order/quote', { ref: Z.ref, facilities: 1, planId: 'maintain' }, Z.token);
    const zc = await api('POST', '/api/order/checkout', { ref: Z.ref, quoteId: zq.body.quote.id, approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 5900 }, Z.token);
    const zsid = zc.body.url.split('/pay/')[1];
    const zq2 = await api('POST', '/api/order/quote', { ref: Z.ref, facilities: 1, planId: 'maintain', buildIncluded: false }, Z.token);
    const zc2 = await api('POST', '/api/order/checkout', { ref: Z.ref, quoteId: zq2.body.quote.id, approve: true, approvedDueTodayCents: 0, approvedMonthlyCents: 5900 }, Z.token);
    const payOld = await fetch(`${M.base}/pay/${zsid}/complete`, { method: 'POST', redirect: 'manual' });
    check('14 Switching to "nothing due today" closes the earlier $199 payment page first (it can no longer be paid)', zc2.body.done === true && M.S.sessions[zsid].status === 'expired' && payOld.status === 400 && (await rec(Z.ref)).status === 'submitted_no_payment' && !(await rec(Z.ref)).checkout_session_id);
    // a 100%-off code never skips Stripe
    const F = await apiSignup({});
    const fq = await api('POST', '/api/order/quote', { ref: F.ref, facilities: 1, planId: 'maintain', promoCode: 'FREEBUILD' }, F.token);
    check('14 A code that makes the build free is refused online (redemption limits can’t be bypassed)', fq.status === 400 && fq.body.code === 'promo_rejected');
    // prototype plan id
    const pq = await api('POST', '/api/order/quote', { ref: F.ref, facilities: 1, planId: '__proto__', buildIncluded: false }, F.token);
    check('14 Plan id "__proto__" is treated as no plan (empty order refused)', pq.status === 400 && pq.body.code === 'empty_order');
    // late "processing" webhook can't undo "paid"
    const P2 = await apiSignup({});
    const p2q = await api('POST', '/api/order/quote', { ref: P2.ref, facilities: 1, planId: 'none' }, P2.token);
    const p2c = await api('POST', '/api/order/checkout', { ref: P2.ref, quoteId: p2q.body.quote.id, approve: true, approvedDueTodayCents: 19900, approvedMonthlyCents: 0 }, P2.token);
    const p2s = M.S.sessions[p2c.body.url.split('/pay/')[1]];
    await M.stripeWebhook('checkout.session.async_payment_succeeded', { ...p2s, status: 'complete', payment_status: 'paid' });
    await M.stripeWebhook('checkout.session.completed', { ...p2s, status: 'complete', payment_status: 'unpaid' });
    check('14 A late "processing" webhook can’t move a paid signup backwards', (await rec(P2.ref)).status === 'paid');
    // unmatched paid money → owner is emailed; expiry of replaced pages is not noise
    const nOwner = mailsTo('owner@example.test').length;
    await M.stripeWebhook('checkout.session.completed', { id: 'cs_test_stray_paid', mode: 'payment', amount_total: 19900, payment_status: 'paid', customer_details: { email: 'x@example.com' } });
    await M.stripeWebhook('checkout.session.expired', { id: 'cs_test_replaced_page', mode: 'payment', amount_total: 19900, payment_status: 'unpaid' });
    check('14 Paid money with no agreement → owner emailed; expiry of an already-replaced page is ignored (not flagged)', mailsTo('owner@example.test').length === nOwner + 1 && /needs review/.test(mailsTo('owner@example.test').pop().subject) && !(await db.prepare('SELECT 1 FROM unmatched_payments WHERE session_id = ?').bind('cs_test_replaced_page').first()));
    // a canceled plan stays canceled even if an older "updated" event arrives late
    const launched = await db.prepare("SELECT ref, subscription_id FROM launches WHERE subscription_status = 'canceled' AND subscription_id IS NOT NULL LIMIT 1").first();
    await M.stripeWebhook('customer.subscription.updated', { id: launched.subscription_id, status: 'active', cancel_at_period_end: false, items: { data: [{ quantity: 1, price: { id: 'price_maintain', product: 'prod_maintain', unit_amount: 5900 } }] } });
    check('14 Out-of-order "updated" after "deleted" doesn’t revive a canceled plan', (await db.prepare('SELECT subscription_status FROM launches WHERE ref = ?').bind(launched.ref).first()).subscription_status === 'canceled');
    // Stripe catalog check (mock ids are test-mode objects)
    const cc = await (await fetch(WORKER + '/api/health?stripe=1')).json();
    check('14 /api/health?stripe=1 checks every configured Stripe id against the key’s account', cc && cc.mode === 'test' && Object.keys(cc.checks || {}).length === 7, JSON.stringify(cc).slice(0, 200));
  }

  // ===== 11. Daily backup snapshot of the records (second copy beyond D1's 7-day Time Travel) =====
  {
    await runCron(7);
    const day = new Date().toISOString().slice(0, 10);
    const obj = await r2.get(`backups/d1/${day}.json`);
    const buf = obj ? Buffer.from(await obj.arrayBuffer()) : Buffer.alloc(0);
    const snap = obj ? JSON.parse(buf.toString()) : {};
    const signedNow = (await db.prepare('SELECT ref, pdf_sha256 FROM signups WHERE signed_at IS NOT NULL').all()).results;
    let chains = true;
    for (const r of signedNow) chains = chains && (await L.verifyAuditChain(snap.audit.filter((a) => a.ref === r.ref))).ok;
    check('11 07:17 UTC run writes backups/d1/<date>.json: every signed record + intact audit chains + launches; SHA-256 recorded', obj && sha(buf) === obj.customMetadata.sha256 && snap.signups.length === signedNow.length && signedNow.every((r) => snap.signups.some((x) => x.ref === r.ref && x.pdf_sha256 === r.pdf_sha256)) && chains && snap.launches.length >= 3, `${snap.signups && snap.signups.length} records`);
    check('11 Snapshot never contains signup tokens or email codes', !buf.toString().includes('token_hash') && !buf.toString().includes('code_hash'));
    await runCron(7);
    const again = await r2.get(`backups/d1/${day}.json`);
    check('11 A day’s snapshot is written once and never overwritten', again && again.etag === obj.etag);
  }

  // ===== 8. Safe default: no Worker configured → nobody can sign or pay =====
  {
    const { ctx, page } = await newPage({ api: '' });
    await page.goto(SITE + '/signup/');
    await step1(page).catch(() => {});
    check('8 No Worker configured: signing form hidden, contact message shown, Step 3 unreachable', (await page.isVisible('#sign-unavailable')) && !(await page.isVisible('#sign-form')));
    await page.click('[data-step="3"] [data-next]');
    check('8 …and Next stays blocked', !(await page.isVisible('[data-step="4"]')));
    await ctx.close();
  }
} catch (e) {
  check('UNEXPECTED ERROR', false, e.stack);
} finally {
  await browser.close();
  await mf.dispose();
  M.server.close();
  site.kill();
  const fails = results.filter((r) => !r.ok);
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
}
