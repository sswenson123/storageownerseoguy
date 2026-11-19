// Run: npm test   — unit tests for the signup Worker's pure logic (_worker/src/lib.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as L from '../_worker/src/lib.js';

const require = createRequire(import.meta.url);
const env = { BUILD_PRICE_CENTS: '19900', MAINTAIN_PRICE_CENTS: '5900', IMPROVE_PRICE_CENTS: '9900', MAX_FACILITIES: '7' };
const pub = L.offerFor({ invite: null }, env);

test('Stripe webhook check follows Stripe’s scheme (t=…,v1=HMAC(secret, "t.payload")) with a 5-minute window', async () => {
  const secret = 'whsec_test', body = '{"id":"evt_1"}', t = 1792865876;
  const v1 = crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex');
  assert.equal(await L.verifyStripeSignature(body, `t=${t},v1=${v1}`, secret, t + 10), true);
  assert.equal(await L.verifyStripeSignature(body + ' ', `t=${t},v1=${v1}`, secret, t + 10), false, 'body changed');
  assert.equal(await L.verifyStripeSignature(body, `t=${t},v1=${v1}`, secret, t + 301), false, 'too old (replay)');
  assert.equal(await L.verifyStripeSignature(body, `t=${t},v1=${v1}`, 'whsec_other', t), false);
  assert.equal(await L.verifyStripeSignature(body, `t=${t},v0=x,v1=${v1}`, secret, t), true, 'extra schemes ignored');
});

test('server quote: public prices, multi-facility, promo math matches Stripe ($50 once per order; % rounded to the cent)', () => {
  assert.equal(L.computeQuote({ facilities: 1, planId: 'maintain' }, pub, null).dueTodayCents, 19900);
  assert.equal(L.computeQuote({ facilities: 2, planId: 'maintain' }, pub, { amount_off: 5000 }).dueTodayCents, 34800);
  const q = L.computeQuote({ facilities: 3, planId: 'improve' }, pub, { percent_off: 25 });
  assert.deepEqual([q.setupSubtotalCents, q.discountCents, q.dueTodayCents, q.monthlyCents], [59700, 14925, 44775, 29700]);
  assert.equal(L.computeQuote({ facilities: 1 }, pub, { percent_off: 100 }).dueTodayCents, 0);
  assert.equal(L.computeQuote({ facilities: 1 }, pub, { amount_off: 99999 }).dueTodayCents, 0, 'never negative');
  assert.equal(L.computeQuote({ facilities: 99, planId: 'maintain' }, pub, null).facilities, 7);
  assert.equal(L.computeQuote({ facilities: -4 }, pub, null).facilities, 1);
  assert.equal(L.computeQuote({ facilities: 1, planId: 'hacked' }, pub, null).planId, 'none');
  const m = L.computeQuote({ buildIncluded: false, facilities: 2, planId: 'maintain' }, pub, { amount_off: 5000 });
  assert.deepEqual([m.dueTodayCents, m.discountCents, m.monthlyCents, m.monthlyStarts], [0, 0, 11800, 'when service begins']);
  assert.equal(L.computeQuote({ buildIncluded: false, planId: 'none' }, pub, null).nothingSelected, true);
});

test('approval sentence states the exact amounts', () => {
  assert.equal(L.approvalText(L.computeQuote({ facilities: 1, planId: 'maintain' }, pub, { amount_off: 5000 })),
    'I approve a one-time charge of $149.00 today and $59.00 per month for Maintain starting the day your new website goes live, renewing monthly until I cancel.');
  assert.equal(L.approvalText(L.computeQuote({ facilities: 1, planId: 'none' }, pub, null)), 'I approve a one-time charge of $199.00 today and no monthly charges.');
});

test('promo checks: inactive, expired, used up, customer-only, wrong product', () => {
  const ok = { active: true, coupon: { valid: true, amount_off: 5000, currency: 'usd', applies_to: { products: ['prod_build'] } }, times_redeemed: 0 };
  const now = 2000000000;
  assert.equal(L.checkPromotion(ok, now, 'prod_build').ok, true);
  assert.equal(L.checkPromotion({ ...ok, active: false }, now, 'prod_build').ok, false);
  assert.match(L.checkPromotion({ ...ok, expires_at: now - 1 }, now, 'prod_build').message, /expired/);
  assert.match(L.checkPromotion({ ...ok, coupon: { ...ok.coupon, valid: false } }, now, 'prod_build').message, /expired/);
  assert.match(L.checkPromotion({ ...ok, max_redemptions: 1, times_redeemed: 1 }, now, 'prod_build').message, /already been used/);
  assert.match(L.checkPromotion({ ...ok, customer: 'cus_1' }, now, 'prod_build').message, /specific customer/);
  assert.match(L.checkPromotion({ ...ok, coupon: { ...ok.coupon, applies_to: { products: ['prod_maintain'] } } }, now, 'prod_build').message, /doesn’t apply/);
  assert.equal(L.normalizePromo(' welcome50 '), 'WELCOME50');
  assert.equal(L.normalizePromo('<script>'), '');
});

test('invitations made by _tools/make-invite.js verify in the Worker; edits and wrong keys are refused; invite prices apply', async () => {
  const { makeInvite } = require('../_tools/make-invite.js');
  const base = require('../js/signup-config.js');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const jwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
  const now = Date.parse('2026-10-24T12:00:00Z');
  const { url } = await makeInvite({ for: 'Lakeside Storage', setup: '149', maintain: '49', facilities: '2', email: 'pat@example.com', exp: '2026-11-30' }, now, { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), config: { ...base, invitePublicKey: jwk } });
  const token = new URL(url).searchParams.get('invite');
  const v = await L.verifyInvite(token, JSON.stringify(jwk), now);
  assert.equal(v.ok, true);
  const offer = L.offerFor({ invite: v.invite }, env);
  const q = L.computeQuote({ facilities: 5, planId: 'maintain' }, offer, null);
  assert.deepEqual([q.facilities, q.dueTodayCents, q.monthlyCents, offer.promoAllowed], [2, 29800, 9800, false]);
  const [p, s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...v.invite, setup: 1 })).toString('base64url') + '.' + s;
  assert.equal((await L.verifyInvite(forged, jwk, now)).ok, false);
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  assert.equal((await L.verifyInvite(token, other, now)).ok, false);
  assert.equal((await L.verifyInvite(token, jwk, Date.parse('2026-12-01T00:00:01Z'))).reason, 'expired');
  assert.equal((await L.verifyInvite(p, jwk, now)).ok, false, 'unsigned');
});

test('server-side validation of Step 1 info', () => {
  assert.equal(L.validateInfo({ owner_name: 'Pat Rivera', legal_name: 'Lakeside LLC', facility_name: 'Lakeside', street: '1 Main', city: 'Town', state: 'MN', zip: '56401', phone: '2185550123', email: 'PAT@example.com', rental_software: 'CC Storage' }).errors.length, 0);
  const bad = L.validateInfo({ owner_name: 'x', zip: '123', phone: '1', email: 'nope' });
  assert.ok(bad.errors.length >= 5);
  assert.equal(L.validateInfo({ email: ' A@B.COM ' }).info.email, 'a@b.com');
});

test('references and tokens: formats and uniqueness', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  assert.match(L.makeRef(now), /^SOSG-20261024-[a-z0-9]{6}$/);
  assert.match(L.makeAgreementId(now), /^AGR-20261024-[A-Z0-9]{8}$/);
  const toks = new Set(Array.from({ length: 200 }, () => L.randomToken()));
  assert.equal(toks.size, 200);
  assert.ok([...toks][0].length >= 43);
});

test('typed-name matching: same person ignoring case/spacing/apostrophe style; anything else refused', () => {
  assert.equal(L.namesMatch('pat  RIVERA', 'Pat Rivera'), true);
  assert.equal(L.namesMatch('Pat O’Neil', "Pat O'Neil"), true);
  assert.equal(L.namesMatch('Pat M. Rivera', 'Pat Rivera'), false);
  assert.equal(L.namesMatch('Pat', 'Pat Rivera'), false);
  assert.equal(L.namesMatch('', ''), false);
});

test('one-time codes: 6 digits, uniform-ish, unpredictable', () => {
  const codes = Array.from({ length: 2000 }, () => L.otpCode());
  assert.ok(codes.every((c) => /^\d{6}$/.test(c)));
  assert.ok(new Set(codes).size > 1990);
  const firstDigits = new Set(codes.map((c) => c[0]));
  assert.equal(firstDigits.size, 10);
});

test('privacy helpers: masked IP and short browser summary on documents', () => {
  assert.equal(L.maskIp('203.0.113.77'), '203.0.113.x');
  assert.match(L.maskIp('2001:db8:85a3:0:0:8a2e:370:7334'), /^2001:db8:85a3:…$/);
  assert.equal(L.uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari 17 on iOS (mobile)');
});

test('audit chain: any edit, removal or reorder of an entry is detected', async () => {
  const rows = []; let prev = 'GENESIS';
  for (let i = 0; i < 4; i++) {
    const e = { ref: 'SOSG-20261024-abc123', at: '2026-10-24T00:00:0' + i + 'Z', event: 'e' + i, detail: { i } };
    const h = await L.auditHash(prev, e);
    rows.push({ seq: i + 1, ref: e.ref, at: e.at, event: e.event, detail: JSON.stringify(e.detail), prev_hash: prev, entry_hash: h }); prev = h;
  }
  assert.equal((await L.verifyAuditChain(rows)).ok, true);
  assert.equal((await L.verifyAuditChain(rows.map((r, i) => (i === 1 ? { ...r, detail: '{"i":9}' } : r)))).ok, false, 'edited');
  assert.equal((await L.verifyAuditChain([rows[0], rows[2], rows[3]])).ok, false, 'removed');
  assert.equal((await L.verifyAuditChain([rows[1], rows[0], rows[2], rows[3]])).ok, false, 'reordered');
});

test('signed PDF is deterministic, valid PDF, contains the full agreement and the certificate', async () => {
  const { AGREEMENT } = await import('../_worker/src/agreement.generated.js');
  const { signedAgreementPdf } = await import('../_worker/src/pdf.js');
  const c = { ref: 'SOSG-20261024-abc123', agreement_id: 'AGR-20261024-ABCDEFGH', agreement_version: AGREEMENT.version, agreement_sha256: AGREEMENT.sha256, signed_at: '2026-10-24T19:00:00.000Z', signer_name: 'Pat Rivera', signer_title: 'Owner', legal_name: 'Lakeside LLC', facility_name: 'Lakeside Storage', address: '1 Main, Town, MO 65037', email: 'pat@example.com', email_verified_at: '2026-10-24T18:59:00.000Z', ip_masked: '203.0.113.x', user_agent_summary: 'Chrome 130 on macOS', consents: [{ label: 'Electronic records and signatures', text: L.CONSENTS.esign.text, at: '2026-10-24T19:00:00.000Z' }], audit: [{ n: 1, at: '2026-10-24T18:58:00.000Z', event: 'signup_started', hash: 'a'.repeat(64) }], audit_head: 'a'.repeat(64) };
  const a = signedAgreementPdf(AGREEMENT, c), b = signedAgreementPdf(AGREEMENT, c);
  assert.deepEqual(a, b, 'same record → identical bytes');
  const s = new TextDecoder().decode(a);
  assert.ok(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF'));
  assert.ok(/[\x00-\x7f]*/.test(s) && [...s].every((ch) => ch.charCodeAt(0) < 128), '7-bit ASCII file');
  assert.match(s, /\(Signing Certificate\)/);
  assert.ok(s.includes('(' + AGREEMENT.sha256), 'agreement hash printed');
  const t0 = performance.now(); for (let i = 0; i < 10; i++) signedAgreementPdf(AGREEMENT, c);
  assert.ok((performance.now() - t0) / 10 < 10, 'fits the Workers Free 10 ms CPU budget (warm)');
});

test('monthly billing is launch-gated: only the monthly endpoint creates subscriptions, only from a recorded launch', () => {
  const fs = require('fs');
  const src = fs.readFileSync(new URL('../_worker/src/index.js', import.meta.url), 'utf8');
  const sql = fs.readFileSync(new URL('../_worker/migrations/0002_launch_billing.sql', import.meta.url), 'utf8');
  assert.equal((src.match(/mode: 'subscription'/g) || []).length, 1, 'exactly one place creates a subscription');
  const fn = src.slice(src.indexOf('async function monthlyCheckout'), src.indexOf('async function monthlyWebhook'));
  assert.ok(fn.includes("mode: 'subscription'") && fn.includes('launchAuthed'), 'and it requires the launch link');
  assert.ok(/mode: 'payment'/.test(src.slice(src.indexOf('async function checkout'), src.indexOf('async function stripeWebhook'))), 'signup checkout is one-time');
  assert.ok(!/INSERT INTO launches/.test(src), 'the Worker never records a launch itself (owner CLI only)');
  assert.ok(/launches_require_signed/.test(sql) && /launches_no_delete/.test(sql) && /launches_fixed_once_billing/.test(sql));
  const cli = fs.readFileSync(new URL('../_tools/mark-launched.sh', import.meta.url), 'utf8');
  assert.ok(/\^SOSG-\[0-9\]\{8\}-\[a-z0-9\]\{6\}\$/.test(cli) && /Type YES/.test(cli), 'CLI validates the reference and asks to confirm');
});

test('copy recovery never reveals whether an agreement exists and only emails the signing address', () => {
  const src = require('fs').readFileSync(new URL('../_worker/src/index.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function requestCopy'), src.indexOf('// ---------- launch-day'));
  assert.ok(fn.includes('ctx.waitUntil'), 'answers before doing the lookup');
  assert.ok(/to: \[email\]/.test(fn) && /WHERE email = \? AND signed_at IS NOT NULL/.test(fn), 'sends only to the email the agreement was signed with');
  assert.ok(/MAX_COPIES_PER_EMAIL_PER_DAY/.test(fn) && /MAX_COPY_REQUESTS_PER_IP_PER_DAY/.test(fn), 'rate limited');
});

test('wrangler.toml: hourly cron, monthly product ids are not secrets, no keys committed', () => {
  const t = require('fs').readFileSync(new URL('../_worker/wrangler.toml', import.meta.url), 'utf8');
  assert.ok(/crons = \["17 \* \* \* \*"\]/.test(t));
  assert.ok(/STRIPE_PRODUCT_MAINTAIN/.test(t) && /STRIPE_PRODUCT_IMPROVE/.test(t));
  assert.ok(!/(sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|re_[A-Za-z0-9]{20,}/.test(t), 'no secrets in config');
});

test('pre-built agreement pages match agreement.html and give the same PDF bytes as a full layout', async () => {
  const { AGREEMENT } = await import('../_worker/src/agreement.generated.js');
  const { AGREEMENT_PAGES } = await import('../_worker/src/agreement-pages.generated.js');
  const P = await import('../_worker/src/pdf.js');
  assert.equal(AGREEMENT_PAGES.sha256, AGREEMENT.sha256, 'run: npm run agreement-pdf');
  assert.equal(AGREEMENT_PAGES.version, AGREEMENT.version);
  assert.deepEqual(AGREEMENT_PAGES.bodies, P.agreementPageBodies(AGREEMENT.blocks));
  const c = { ref: 'SOSG-20261024-abc123', agreement_id: 'AGR-1', agreement_version: AGREEMENT.version, agreement_sha256: AGREEMENT.sha256, signed_at: '2026-10-24T12:00:00.000Z', signer_name: 'Pat Lee', signer_title: 'Owner', legal_name: 'L', facility_name: 'F', address: 'A', email: 'e@x.co', email_verified_at: 'now', ip_masked: '1.2.3.x', user_agent_summary: 'u', consents: [{ label: 'a', text: 'b', at: 'c' }], audit: [{ n: 1, at: 'a', event: 'e', hash: 'f'.repeat(64) }], audit_head: 'f'.repeat(64) };
  const a = Buffer.from(P.signedAgreementPdf(AGREEMENT, c, AGREEMENT_PAGES)), b = Buffer.from(P.signedAgreementPdf(AGREEMENT, c, { ...AGREEMENT_PAGES, sha256: 'stale' }));
  assert.ok(a.equals(b), 'stale pre-built pages are ignored, output identical');
});
