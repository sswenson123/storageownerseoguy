// Run: npm test   (or: node --test tests/signup.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/signup.js');
const baseConfig = require('../js/signup-config.js');

const cfg = (links = {}) => ({ ...baseConfig, setupPaymentLinks: { ...baseConfig.setupPaymentLinks, ...links } });
const LINK = 'https://buy.stripe.com/test_abc123';

test('config: public prices match the published pricing ($199 / $59 / $99 / $0)', () => {
  assert.equal(baseConfig.build.price, 199);
  const p = Object.fromEntries(baseConfig.plans.map((x) => [x.id, x.price]));
  assert.deepEqual(p, { none: 0, maintain: 59, improve: 99 });
});

test('summary: single facility + Maintain', () => {
  const s = S.computeSummary({ facilities: 1, planId: 'maintain' }, baseConfig);
  assert.equal(s.setupSubtotal, 199);
  assert.equal(s.dueToday, 199);
  assert.equal(s.monthlyTotal, 59);
  assert.match(s.monthlyStarts, /goes live — not today/);
});

test('summary: multi-facility order (3 facilities, Maintain + Improve)', () => {
  const s = S.computeSummary({ facilities: 3, planId: 'improve' }, baseConfig);
  assert.equal(s.setupSubtotal, 597);
  assert.equal(s.monthlyTotal, 297);
});

test('summary: monthly only (existing website) — nothing due today', () => {
  const s = S.computeSummary({ buildIncluded: false, facilities: 1, planId: 'maintain' }, baseConfig);
  assert.equal(s.dueToday, 0);
  assert.equal(s.monthlyTotal, 59);
  assert.match(s.monthlyStarts, /existing website/);
});

test('summary: build with no monthly service', () => {
  const s = S.computeSummary({ facilities: 1, planId: 'none' }, baseConfig);
  assert.equal(s.dueToday, 199);
  assert.equal(s.monthlyTotal, 0);
  assert.equal(s.monthlyStarts, 'No monthly charges');
});

test('summary: unknown plan id falls back to no monthly service', () => {
  const s = S.computeSummary({ facilities: 1, planId: 'hacked-plan' }, baseConfig);
  assert.equal(s.plan.id, 'none');
});

test('facilities are clamped to 1..max', () => {
  assert.equal(S.clampFacilities(0, 7), 1);
  assert.equal(S.clampFacilities(-3, 7), 1);
  assert.equal(S.clampFacilities('abc', 7), 1);
  assert.equal(S.clampFacilities(99, 7), 7);
  assert.equal(S.clampFacilities('4', 7), 4);
});

test('promo: normalized to uppercase; junk rejected', () => {
  assert.equal(S.normalizePromoCode('  welcome50 '), 'WELCOME50');
  assert.equal(S.normalizePromoCode('FRIEND-25'), 'FRIEND-25');
  assert.equal(S.normalizePromoCode('bad code!'), '');
  assert.equal(S.normalizePromoCode('<script>'), '');
  assert.equal(S.normalizePromoCode(''), '');
  assert.equal(S.normalizePromoCode('X'), '');
  assert.equal(S.normalizePromoCode('A'.repeat(41)), '');
  assert.equal(S.normalizePromoCode(null), '');
});

test('promo: code survives a package change; totals recompute', () => {
  const a = S.computeSummary({ facilities: 1, planId: 'maintain', promoCode: 'WELCOME50' }, baseConfig);
  const b = S.computeSummary({ facilities: 2, planId: 'improve', promoCode: 'WELCOME50' }, baseConfig);
  assert.equal(a.promoCode, 'WELCOME50');
  assert.equal(b.promoCode, 'WELCOME50');
  assert.equal(b.setupSubtotal, 398);
  assert.equal(b.monthlyTotal, 198);
});

test('validation: step 1 requires contact details and a valid email/zip/phone', () => {
  const errs = S.validateStep(1, { owner_name: 'Pat', email: 'not-an-email', zip: '12', phone: '555' }, baseConfig);
  const fields = errs.map((e) => e.field);
  for (const f of ['facility_name', 'street', 'city', 'state', 'zip', 'phone', 'email']) assert.ok(fields.includes(f), f);
  for (const f of ['legal_name', 'rental_software']) assert.ok(fields.includes(f), f);
  const good = { owner_name: 'Pat Rivera', legal_name: 'Lakeside Storage Properties LLC', facility_name: 'Lakeside Storage', street: '100 Example Rd', city: 'Anytown', state: 'MN', zip: '56401', phone: '(218) 555-0123', email: 'pat@example.com', email_confirm: 'Pat@Example.com', rental_software: 'CC Storage' };
  assert.deepEqual(S.validateStep(1, good, baseConfig), []);
  assert.equal(S.validateStep(1, { ...good, email_confirm: 'pat@exampel.com' }, baseConfig)[0].field, 'email_confirm');
  assert.equal(S.validateStep(1, { ...good, rental_software: 'Other', rental_software_other: '' }, baseConfig)[0].field, 'rental_software_other');
  assert.deepEqual(S.validateStep(1, { ...good, rental_software: 'Other', rental_software_other: 'SpareFoot Storable' }, baseConfig), []);
});

test('validation: step 3 blocks an empty order (no build, no plan)', () => {
  assert.equal(S.validateStep(3, { buildIncluded: false, planId: 'none', facilities: 1 }, baseConfig).length, 1);
  assert.equal(S.validateStep(3, { buildIncluded: true, planId: 'none', facilities: 1 }, baseConfig).length, 0);
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

test('leave and return: progress restores within 7 days, expires after', () => {
  const st = memStorage();
  const state = { step: 3, data: { facility_name: 'Lakeside Storage', promoCode: 'WELCOME50' } };
  S.saveProgress(st, state, 1000);
  assert.deepEqual(S.loadProgress(st, 1000 + 60 * 1000), state);
  assert.equal(S.loadProgress(st, 1000 + S.MAX_AGE_MS + 1), null);
  S.clearProgress(st);
  assert.equal(S.loadProgress(st, 2000), null);
});

test('leave and return: broken or blocked storage never crashes', () => {
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(S.saveProgress(throwing, {}, 1), false);
  assert.equal(S.loadProgress(throwing, 1), null);
  const st = memStorage(); st.setItem(S.STORAGE_KEY, '{not json');
  assert.equal(S.loadProgress(st, 1), null);
});

test('money formatting', () => {
  assert.equal(S.money(299), '$299.00');
  assert.equal(S.money(2093), '$2,093.00');
});

test('escapeHtml neutralizes typed input shown on the review screen', () => {
  assert.equal(S.escapeHtml('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
});


// ---------- public signup additions: submission fields, invitations ----------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makeInvite, initKeys, sign } = require('../_tools/make-invite.js');
const NOW = Date.parse('2026-10-24T12:00:00Z');
const PRIVATE = 'https://buy.stripe.com/test_PRIVATE149';

// throwaway signing key for tests (never the real one)
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
const keyed = { ...baseConfig, invitePublicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } };
const inviteFor = (a, now = NOW) => makeInvite(a, now, { keyPem: KEY_PEM, config: keyed });
const tokenOf = (url) => new URL(url).searchParams.get('invite');

test('invitation: signed link is accepted and shows the custom offer', async () => {
  const { url, invite } = await inviteFor({ for: 'Lakeside Storage', setup: '149', maintain: '49', pay: PRIVATE, exp: '2026-11-30', note: 'Founding-client rate' });
  assert.ok(url.startsWith('https://storageownerseoguy.com/signup/?invite='));
  const r = await S.verifyInvite(tokenOf(url), keyed, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.invite.for, 'Lakeside Storage');
  assert.match(invite.id, /^lakeside-storage-20261024-[0-9a-f]{4}$/);
});

test('invitation: editing ANY part of a signed link is refused (price, plan, payment link)', async () => {
  const { url } = await inviteFor({ for: 'Lakeside Storage', setup: '149', maintain: '49', pay: PRIVATE });
  const [payload, sig] = tokenOf(url).split('.');
  const inv = JSON.parse(Buffer.from(payload, 'base64url').toString());
  for (const change of [{ setup: 1 }, { plans: { maintain: 1 } }, { pay: 'https://buy.stripe.com/test_OTHER' }, { exp: '2099-12-31' }]) {
    const forged = Buffer.from(JSON.stringify({ ...inv, ...change })).toString('base64url') + '.' + sig;
    assert.equal((await S.verifyInvite(forged, keyed, NOW)).ok, false, JSON.stringify(change));
  }
  const flipped = payload + '.' + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.equal((await S.verifyInvite(flipped, keyed, NOW)).ok, false, 'altered signature');
});

test('invitation: a link signed with someone else’s key is refused', async () => {
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const payload = Buffer.from(JSON.stringify({ v: 1, id: 'fake', for: 'Fake', setup: 0, plans: {} })).toString('base64url');
  assert.equal((await S.verifyInvite(payload + '.' + sign(payload, other), keyed, NOW)).ok, false);
});

test('invitation: unsigned or old-format links are refused; no public key = all refused', async () => {
  const payload = Buffer.from(JSON.stringify({ v: 1, id: 'x', for: 'X', setup: 0, plans: {} })).toString('base64url');
  assert.equal((await S.verifyInvite(payload, keyed, NOW)).ok, false, 'no signature');
  const { url } = await inviteFor({ for: 'X Storage', setup: '149', pay: PRIVATE });
  assert.equal((await S.verifyInvite(tokenOf(url), baseConfig, NOW)).ok, false, 'shipped config has no key yet');
  assert.equal((await S.verifyInvite('garbage.!!', keyed, NOW)).ok, false);
  assert.equal((await S.verifyInvite('', keyed, NOW)).ok, false);
});

test('invitation: expiry is enforced (and inside the signature, so it can’t be extended)', async () => {
  const { url } = await inviteFor({ for: 'Old Offer', setup: '100', exp: '2026-10-01' }, Date.parse('2026-09-01'));
  assert.equal((await S.verifyInvite(tokenOf(url), keyed, NOW)).reason, 'expired');
  const today = await inviteFor({ for: 'Today', setup: '100', exp: '2026-10-24' }, NOW);
  assert.equal((await S.verifyInvite(tokenOf(today.url), keyed, NOW)).ok, true, 'valid through the end of its last day');
});

test('invitation: custom prices replace public ones; promo codes disabled', async () => {
  const r = await S.verifyInvite(tokenOf((await inviteFor({ for: 'Lakeside Storage', setup: '149', maintain: '49', pay: PRIVATE })).url), keyed, NOW);
  const c = S.applyInvite(keyed, r.invite);
  const s = S.computeSummary({ facilities: 1, planId: 'maintain', promoCode: 'WELCOME50' }, c);
  assert.equal(s.setupSubtotal, 149);
  assert.equal(s.monthlyTotal, 49);
  assert.equal(s.promoCode, '', 'promo codes do not stack with a private offer');
  assert.deepEqual(c.plans.map((p) => p.id), ['none', 'maintain'], 'only offered plans are shown');
  assert.equal(baseConfig.build.price, 199, 'public config is not modified');
  const q = { facilities: 1, dueTodayCents: 14900, discountCents: 0, promo: null, planName: 'Maintain', monthlyCents: 4900, monthlyStarts: 'x', approval_text: 'ok' };
  assert.match(S.buildSubmission({ facility_name: 'Lakeside Storage' }, q, { ref: 'R', agreementId: 'A' }, c, '2026-10-24T00:00:00.000Z').signup_path, /^PRIVATE INVITATION lakeside-storage/);
});

test('invitation: locked facility count; un-offered plan falls back to none', async () => {
  const r = await S.verifyInvite(tokenOf((await inviteFor({ for: 'Multi', setup: '150', facilities: '3', maintain: '59', pay: PRIVATE })).url), keyed, NOW);
  const c = S.applyInvite(keyed, r.invite);
  assert.equal(c.build.maxFacilities, 3);
  assert.equal(S.computeSummary({ facilities: 3, planId: 'improve' }, c).plan.id, 'none');
});

test('invitation: bound to an email — a forwarded link fails Step 1 with a different email', async () => {
  const r = await S.verifyInvite(tokenOf((await inviteFor({ for: 'Lakeside Storage', setup: '149', pay: PRIVATE, email: 'Pat@Example.com' })).url), keyed, NOW);
  const c = S.applyInvite(keyed, r.invite);
  const good = { owner_name: 'Pat Rivera', legal_name: 'Lakeside LLC', facility_name: 'Lakeside Storage', street: '1 Main', city: 'Town', state: 'MN', zip: '56401', phone: '2185550123', email: 'pat@example.com', email_confirm: 'pat@example.com', rental_software: 'CC Storage' };
  assert.deepEqual(S.validateStep(1, good, c), []);
  const fwd = { ...good, email: 'friend@other.com', email_confirm: 'friend@other.com' };
  assert.equal(S.validateStep(1, fwd, c)[0].field, 'email');
});

test('invitation tool refuses bad input and a mismatched key', async () => {
  await assert.rejects(inviteFor({ setup: '149' }), /--for/);
  await assert.rejects(inviteFor({ for: 'X', setup: '99999' }), /validation/);
  await assert.rejects(inviteFor({ for: 'X', setup: '149', email: 'not-an-email' }), /validation/);
  await assert.rejects(makeInvite({ for: 'X', setup: '1' }, NOW, { keyPem: KEY_PEM, config: baseConfig }), /public key/);
});

test('invitation tool --init-keys writes the key outside the repo and the public key into config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sosg-'));
  const cfgCopy = path.join(dir, 'signup-config.js');
  fs.copyFileSync(path.join(__dirname, '..', 'js', 'signup-config.js'), cfgCopy);
  const { keyPath, jwk } = initKeys({ keyPath: path.join(dir, 'key.pem'), configPath: cfgCopy });
  assert.ok(fs.readFileSync(keyPath, 'utf8').includes('PRIVATE KEY'));
  const written = fs.readFileSync(cfgCopy, 'utf8');
  assert.ok(written.includes(jwk.x) && !written.includes('PRIVATE'), 'only the public key goes in config');
  assert.throws(() => initKeys({ keyPath, configPath: cfgCopy }), /already exists/);
});

test('invite progress is saved separately from public progress', () => {
  const st = memStorage();
  S.saveProgress(st, { step: 2, data: { a: 1 } }, 1000, null);
  S.saveProgress(st, { step: 3, data: { a: 2 } }, 1000, 'abc');
  assert.equal(S.loadProgress(st, 2000, null).step, 2);
  assert.equal(S.loadProgress(st, 2000, 'abc').step, 3);
});

// ---------- audit additions: agreement integrity + payment disclosure ----------
test('agreement fingerprint in config matches agreement.html (bump version + npm run agreement-hash after edits)', async () => {
  const src = S.extractAgreementSource(fs.readFileSync(path.join(__dirname, '..', 'agreement.html'), 'utf8'));
  assert.ok(src.length > 5000, 'agreement markers found');
  assert.equal(await S.sha256Hex(src), baseConfig.agreementHash);
});

test('agreement text contains the key protections and current prices', () => {
  const src = S.extractAgreementSource(fs.readFileSync(path.join(__dirname, '..', 'agreement.html'), 'utf8'));
  for (const must of ['Limitation of Liability', 'Satisfaction Guarantee', 'goes live', 'cancel any monthly plan at any time', 'private invitation', 'Payment details are collected', 'Electronic Signatures and Electronic Records', 'Withdrawing consent', 'paper', 'Signature Page', 'order review the Client approves before payment']) assert.ok(src.includes(must), must);
  assert.ok(!src.includes('typing a name during signup'), 'old typed-name signature clause removed');
});

// ---------- e-signature signup (Step 2 signing, Step 4 approval) ----------
test('config: production signup Worker is HTTPS only (the Worker itself gates who may sign up)', () => {
  assert.match(baseConfig.signupApi, /^https:\/\/[a-z0-9.-]+$/);
  assert.equal(baseConfig.setupPaymentLinks, undefined, 'public Stripe Payment Links are no longer used (they could be paid without signing)');
});

const INFO = { owner_name: 'Pat Rivera', legal_name: 'Lakeside LLC', facility_name: 'Lakeside Storage', street: '1 Main', city: 'Town', state: 'MN', zip: '56401', phone: '2185550123', email: 'pat@example.com', rental_software: 'CC Storage' };

test('step 2: changing Step 1 details after signing requires signing again', () => {
  const sign = { signed: true, infoFingerprint: S.infoFingerprint(INFO) };
  assert.equal(S.validateStep(2, { ...INFO, legal_name: 'Other LLC' }, baseConfig, sign).length, 1);
  assert.deepEqual(S.validateStep(2, { ...INFO, email: 'PAT@example.com ' }, baseConfig, sign), [], 'case/whitespace only is not a change');
});

test('step 4: requires the separate approval of the exact order amounts', () => {
  assert.equal(S.validateStep(4, { order_approved: false }, baseConfig)[0].field, 'order_approved');
  assert.deepEqual(S.validateStep(4, { order_approved: true }, baseConfig), []);
});

test('step 4 disclosure is built from the server quote: today, monthly start, renewal, cancellation, guarantee', () => {
  const q = { buildIncluded: true, facilities: 2, setupSubtotalCents: 39800, discountCents: 5000, dueTodayCents: 34800, planName: 'Maintain + Improve', monthlyCents: 19800, monthlyStarts: 'the day your new website goes live', buildUnitCents: 19900, promo: { code: 'WELCOME50' } };
  const t = S.disclosureLines(q, baseConfig).join(' ');
  assert.match(t, /Today: \$348\.00 one-time build fee \(2 facilities\), after your \$50\.00 promo discount/);
  assert.match(t, /Monthly: \$198\.00\/month for Maintain \+ Improve \(2 facilities\), starting the day your new website goes live — not today/);
  assert.match(t, /renews on that same day each month/);
  assert.match(t, /Cancel the monthly plan anytime/);
  assert.match(t, /60 days after launch/);
  const rows = S.quoteRows(q, 'Website + SEO Build');
  assert.ok(rows.includes('$398.00') && rows.includes('−$50.00') && rows.includes('$348.00') && rows.includes('$198.00/month'));
  assert.match(S.disclosureLines({ ...q, monthlyCents: 0, dueTodayCents: 0 }, baseConfig).join(' '), /Today: nothing is charged\..*Monthly: none/);
});

test('Formspree heads-up: signup ref, agreement ID, signed time, approved amounts — no payment data', () => {
  const q = { facilities: 1, dueTodayCents: 14900, discountCents: 5000, promo: { code: 'WELCOME50' }, planName: 'Maintain', monthlyCents: 5900, monthlyStarts: 'the day your new website goes live', approval_text: 'I approve a one-time charge of $149.00 today…' };
  const sub = S.buildSubmission({ ...INFO, rental_software: 'Other', rental_software_other: 'Easy Storage Solutions', _gotcha: '' }, q, { ref: 'SOSG-20261024-abc123', agreementId: 'AGR-20261024-ABCDEFGH', signedAt: '2026-10-24T18:00:00Z' }, baseConfig, '2026-10-24T18:01:00.000Z');
  assert.equal(sub.signup_ref, 'SOSG-20261024-abc123');
  assert.equal(sub.agreement_id, 'AGR-20261024-ABCDEFGH');
  assert.equal(sub.agreement_signed_at, '2026-10-24T18:00:00Z');
  assert.equal(sub.agreement_version, baseConfig.agreementVersion);
  assert.equal(sub.charged_today, '$149.00');
  assert.equal(sub.promo_code, 'WELCOME50 (−$50.00)');
  assert.equal(sub.rental_software, 'Other: Easy Storage Solutions');
  assert.equal(sub.signup_path, 'public signup');
  assert.ok(!JSON.stringify(sub).match(/card|routing|account number/i));
});

test('step 2: cannot continue without a server-confirmed signature', () => {
  assert.equal(S.validateStep(2, INFO, baseConfig, null)[0].field, 'typed_name');
  assert.equal(S.validateStep(2, INFO, baseConfig, { signed: false })[0].field, 'typed_name');
  assert.deepEqual(S.validateStep(2, INFO, baseConfig, { signed: true, infoFingerprint: S.infoFingerprint(INFO) }), []);
});

test('no outside e-signature provider remains in the signup (code, page, styles, agreement)', () => {
  for (const f of ['js/signup.js', 'signup/index.html', 'css/signup.css', 'agreement.html', 'js/signup-config.js', '_worker/src/index.js', '_worker/src/lib.js', '_worker/wrangler.toml']) {
    const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/signwell|docusign|e-signature service|e-signature provider/i.test(t), f);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, '..', '_tools', 'signwell-setup.js')));
});

test('agreement is frozen into the Worker exactly: same version and SHA-256 as agreement.html and config', async () => {
  const { AGREEMENT } = await import('../_worker/src/agreement.generated.js');
  const src = S.extractAgreementSource(fs.readFileSync(path.join(__dirname, '..', 'agreement.html'), 'utf8'));
  assert.equal(AGREEMENT.version, baseConfig.agreementVersion);
  assert.equal(AGREEMENT.html, src, 'Worker copy is byte-identical to the page (run: npm run agreement-pdf)');
  assert.equal(AGREEMENT.sha256, baseConfig.agreementHash);
  assert.equal(await S.sha256Hex(src), AGREEMENT.sha256);
  const pdf = fs.readFileSync(path.join(__dirname, '..', 'downloads', 'agreements', `SOSG-Services-Agreement-${AGREEMENT.version}.pdf`));
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  assert.equal(S.agreementPdfUrl(baseConfig), `/downloads/agreements/SOSG-Services-Agreement-${AGREEMENT.version}.pdf`);
});

test('Section 15 describes first-party typed signing accurately (consent, copies, withdrawal, intent, record)', () => {
  const src = S.extractAgreementSource(fs.readFileSync(path.join(__dirname, '..', 'agreement.html'), 'utf8'));
  for (const must of ['one-time code', 'types their full legal name and title', 'authorized to sign', 'clicks "Sign Agreement."', 'same legal effect as a handwritten signature', 'SHA-256 fingerprint', 'signing certificate page', 'not a check of government identification', 'download the signed PDF', 'paper', 'Withdrawing consent', 'Retention']) assert.ok(src.includes(must), must);
});

test('worker settings match the site and contain no secrets; storage is private D1 + R2', () => {
  const toml = fs.readFileSync(path.join(__dirname, '..', '_worker', 'wrangler.toml'), 'utf8');
  assert.match(toml, new RegExp('AGREEMENT_VERSION = "' + baseConfig.agreementVersion.replace(/\./g, '\\.') + '"'));
  assert.match(toml, /BUILD_PRICE_CENTS = "19900"/);
  assert.match(toml, /MAINTAIN_PRICE_CENTS = "5900"/);
  assert.match(toml, /IMPROVE_PRICE_CENTS = "9900"/);
  assert.match(toml, /\[\[d1_databases\]\]/);
  assert.match(toml, /\[\[r2_buckets\]\]/);
  assert.ok(!/sk_(live|test)_|whsec_|re_[A-Za-z0-9]{10,}|OTP_SECRET\s*=/.test(toml));
});
