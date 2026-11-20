/*
 * Storage Owner's SEO Guy — signup Worker (Cloudflare Workers).
 *
 * First-party electronic signing (no outside signing service):
 *   1. /api/sign/start          freezes the exact agreement (version + SHA-256 + text) and the signer's
 *                               business details; returns a private bearer token for this signup.
 *   2. /api/sign/email/send     optional (legacy): emails a one-time 6-digit code; signing no longer requires it.
 *      /api/sign/email/verify   proves control of the Step 1 mailbox (10-minute, single-use, 5 tries).
 *   3. /api/sign/complete       typed full legal name + title + two separate consents + the click on
 *                               "Sign Agreement" → Worker timestamp → immutable PDF (full agreement +
 *                               signing certificate) → private R2 → verified → D1 record + audit chain.
 *   4. /api/order/quote|checkout  server pricing; Stripe Checkout only for a signed record and only for
 *                               the exact amounts the customer approved (one-time build only). Stripe
 *                               webhooks mark payment.
 *   5. /api/records/copy        lost link / after the 30-day token expires: emails the signed PDF(s) — only
 *                               ever to the email address on the signed record. Same answer either way.
 *   6. /api/monthly/status|checkout  launch-day monthly billing. Works only after YOU record the launch
 *                               (_tools/mark-launched.sh); the hourly cron then emails the customer a
 *                               private link to approve and start the plan (Stripe Checkout, subscription).
 *                               No subscription can be created before a launch is recorded.
 *
 * Storage: D1 (DB) for records + append-only hash-chained audit; R2 (AGREEMENTS, private) for PDFs.
 * Nothing works until it is configured: missing database/bucket/secret → requests fail closed.
 */
import {
  validateInfo, verifyInvite, offerFor, computeQuote, approvalText, checkPromotion, normalizePromo,
  verifyStripeSignature, sha256Hex, hmacHex, safeEqual, randomToken, makeRef, makeAgreementId, money,
  CONSENTS, namesMatch, otpCode, maskIp, uaSummary, canonical, auditHash
} from './lib.js';
import { AGREEMENT } from './agreement.generated.js';
import { AGREEMENT_PAGES } from './agreement-pages.generated.js';
import { signedAgreementPdf } from './pdf.js';

const JSON_HDR = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const DAY = 86400, MIN = 60;
const SIGNED_STATES = ['signed', 'submitted_no_payment', 'payment_processing', 'paid'];

const json = (body, status, extra) => new Response(JSON.stringify(body), { status: status || 200, headers: { ...JSON_HDR, ...(extra || {}) } });
const fail = (msg, status, code, extra) => json({ ok: false, error: msg, code: code || undefined, ...(extra || {}) }, status || 400);
const nowIso = () => new Date().toISOString();
const plus = (sec) => new Date(Date.now() + sec * 1000).toISOString();
const ipOf = (req) => req.headers.get('CF-Connecting-IP') || 'unknown';
// rate-limit key: IPv4 as is, IPv6 by its /64 (one household or phone network gets one bucket, not 2^64)
const ipKey = (req) => { const ip = ipOf(req); return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip; };
const uaOf = (req) => (req.headers.get('User-Agent') || '').slice(0, 300);
const int = (v, d) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; };
const maskEmail = (e) => { const [u, d] = String(e).split('@'); return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d; };
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };

// TEST PHASE ONLY: the signup pages served from your own computer on your home Wi-Fi (npm run preview --
// --lan) so a real phone can be tested. Never with live Stripe keys (see liveConfigSafe).
const LAN_TEST_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):8765$/;
const lanTestOrigin = (env, origin) => env.ALLOW_LAN_TEST_ORIGINS === 'true' && stripeMode(env) === 'test' && LAN_TEST_ORIGIN.test(origin);
function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) || lanTestOrigin(env, origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600', 'Access-Control-Expose-Headers': 'Content-Disposition, X-Content-SHA256' } : null;
}

const emailConfigured = (env) => !!(env.RESEND_API_KEY && env.EMAIL_FROM && env.OTP_SECRET);
const storageConfigured = (env) => !!(env.DB && env.AGREEMENTS);

// ---------- database helpers ----------
const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
async function getRec(env, ref) {
  if (typeof ref !== 'string' || !/^SOSG-\d{8}-[a-z0-9]{6}$/.test(ref)) return null;
  return q(env, 'SELECT * FROM signups WHERE ref = ?', ref).first();
}
const bearer = (req) => { const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.get('Authorization') || ''); return m ? m[1] : null; };
async function authed(env, req, ref) {
  const rec = await getRec(env, ref);
  const tok = bearer(req);
  if (!rec || !tok) return null;
  if (!safeEqual(await sha256Hex(tok), rec.token_hash)) return null;
  if (Date.parse(rec.token_expires_at) < Date.now()) return { expired: true, signed: !!rec.signed_at };
  return rec;
}
const expiredFail = (a) => a.signed
  ? fail('This signup link has expired (links last 30 days). Your signed agreement is safely on file — get a copy at storageownerseoguy.com/signup/copy/.', 401, 'token_expired', { signed: true, copyPath: '/signup/copy/' })
  : fail('This signup link has expired. Please start again.', 401, 'token_expired');
const today = () => new Date().toISOString().slice(0, 10);
const site = (env) => (env.SITE_URL || 'https://storageownerseoguy.com').replace(/\/$/, '');
const siteFor = (env, req) => { const o = req.headers.get('Origin') || ''; return lanTestOrigin(env, o) ? o : site(env); }; // Stripe return links
const info = (rec) => JSON.parse(rec.info_json);

async function auditHead(env, ref) {
  const r = await q(env, 'SELECT entry_hash FROM audit WHERE ref = ? ORDER BY seq DESC LIMIT 1', ref).first();
  return r ? r.entry_hash : 'GENESIS';
}
async function auditStmt(env, ref, event, detail, prev, at) {
  at = at || nowIso();
  const entry = { ref, at, event, detail: detail || {} };
  const hash = await auditHash(prev, entry);
  return { stmt: q(env, 'INSERT INTO audit (ref, at, event, detail, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?)', ref, at, event, JSON.stringify(entry.detail), prev, hash), hash, at };
}
// Append one entry (retries if a concurrent request appended first — UNIQUE(ref, prev_hash)).
async function audit(env, ref, event, detail) {
  for (let i = 0; i < 5; i++) {
    const a = await auditStmt(env, ref, event, detail, await auditHead(env, ref));
    try { await a.stmt.run(); return a.hash; } catch (e) { if (!/UNIQUE/i.test(String(e && e.message))) throw e; }
  }
  throw new Error('audit append contention');
}

// Fixed-window counter; returns true while under the limit.
async function allow(env, key, limit, windowSec) {
  const now = nowIso();
  const r = await q(env, `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limits.expires_at < ? THEN 1 ELSE rate_limits.count + 1 END,
      expires_at = CASE WHEN rate_limits.expires_at < ? THEN excluded.expires_at ELSE rate_limits.expires_at END
    RETURNING count`, key, plus(windowSec), now, now).first();
  return r.count <= limit;
}

async function inviteRevoked(env, inviteId) {
  if (!inviteId) return false;
  return !!(await q(env, 'SELECT 1 AS x FROM revoked_invites WHERE invite_id = ?', inviteId).first());
}

// ---------- email (Resend) ----------
async function sendEmail(env, msg) {
  const r = await fetch((env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/$/, '') + '/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, reply_to: env.EMAIL_REPLY_TO || undefined, ...msg })
  });
  return r.ok;
}

// ---------- signing ----------
function agreementPayload() { return { version: AGREEMENT.version, sha256: AGREEMENT.sha256, html: AGREEMENT.html }; }
function publicState(rec) {
  const i = info(rec);
  return {
    ok: true, ref: rec.ref, agreementId: rec.agreement_id, status: rec.status,
    emailVerified: !!rec.email_verified_at, email: i.email,
    signed: SIGNED_STATES.includes(rec.status), signedAt: rec.signed_at, signerName: rec.signer_name, signerTitle: rec.signer_title,
    agreementVersion: rec.agreement_version, agreementSha256: rec.agreement_sha256, pdfSha256: rec.pdf_sha256,
    paid: rec.status === 'paid', tokenExpiresAt: rec.token_expires_at
  };
}

async function startSigning(env, req, body) {
  if (body._gotcha) return json({ ok: true, honeypot: true });
  if (env.AGREEMENT_VERSION !== AGREEMENT.version) return fail('Signing is temporarily unavailable. Please contact Scott.', 503, 'agreement_config_mismatch');
  const ip = ipOf(req);
  const { info: inf, errors } = validateInfo(body.info);
  if (errors.length) return fail(errors.join(' '), 400, 'invalid_info');
  if (!signupOpen(env) && !allowlisted(env, inf.email)) return fail('Online signup opens soon. To get started now, email Scott at storageownerseoguy@gmail.com or call — he’ll set you up personally.', 403, 'signup_not_open');

  let invite = null;
  if (body.invite) {
    const v = await verifyInvite(body.invite, env.INVITE_PUBLIC_JWK, Date.now(), int(env.MAX_FACILITIES, 7));
    if (!v.ok) return fail(v.reason === 'expired' ? 'This invitation has expired.' : 'This invitation link isn’t valid.', 400, 'invite_' + v.reason);
    if (await inviteRevoked(env, v.invite.id)) return fail('This invitation has been withdrawn. Please contact Scott.', 400, 'invite_revoked');
    if (v.invite.email && v.invite.email.toLowerCase() !== inf.email) return fail('This private offer was issued for a different email address.', 400, 'invite_email');
    invite = v.invite;
  }

  // Resume the same signup (reload, come back later) if nothing that was frozen has changed.
  let previous = null;
  if (body.resume && body.resume.ref && body.resume.token) {
    const prev = await authed(env, new Request('https://x', { headers: { Authorization: 'Bearer ' + body.resume.token } }), body.resume.ref);
    if (prev && prev.expired && prev.signed) return expiredFail(prev); // never silently start a second agreement
    if (prev && !prev.expired) {
      const same = canonical(info(prev)) === canonical(inf) && (prev.invite_id || null) === (invite ? invite.id : null);
      if (same && (SIGNED_STATES.includes(prev.status) || prev.agreement_sha256 === AGREEMENT.sha256) && prev.status !== 'superseded') {
        await audit(env, prev.ref, 'signup_resumed', { ip, ua: uaOf(req) });
        return json({ ...publicState(prev), token: body.resume.token, agreement: agreementPayload(), consents: CONSENTS, emailConfigured: emailConfigured(env), resumed: true });
      }
      if (!SIGNED_STATES.includes(prev.status)) previous = prev; // details changed (or agreement updated) → new signup, old one superseded
    }
  }

  if (!(await allow(env, `start:${ipKey(req)}:${new Date().toISOString().slice(0, 10)}`, int(env.MAX_STARTS_PER_IP_PER_DAY, 10), DAY))) {
    return fail('Too many signups from this connection today. Please call or email Scott.', 429, 'rate_limited');
  }
  const now = Date.now();
  const token = randomToken(32);
  const ref = makeRef(now), agreementId = makeAgreementId(now), at = nowIso();
  await q(env, `INSERT INTO signups (ref, token_hash, token_expires_at, status, agreement_id, agreement_version, agreement_sha256, info_json, email, invite_id, invite_json, created_ip, created_at, updated_at)
    VALUES (?, ?, ?, 'awaiting_email_verification', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ref, await sha256Hex(token), plus(int(env.TOKEN_TTL_DAYS, 30) * DAY), agreementId, AGREEMENT.version, AGREEMENT.sha256,
    JSON.stringify(inf), inf.email, invite ? invite.id : null, invite ? JSON.stringify(invite) : null, ip, at, at).run();
  await audit(env, ref, 'signup_started', { ip, ua: uaOf(req), signup_path: invite ? 'invitation ' + invite.id : 'public', agreement_version: AGREEMENT.version, agreement_sha256: AGREEMENT.sha256, agreement_id: agreementId });
  if (previous) {
    await q(env, "UPDATE signups SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE ref = ? AND signed_at IS NULL", ref, at, previous.ref).run();
    await audit(env, previous.ref, 'superseded_by_new_signup', { new_ref: ref });
    await audit(env, ref, 'replaces_unsigned_signup', { old_ref: previous.ref });
  }
  const rec = await getRec(env, ref);
  return json({ ...publicState(rec), token, agreement: agreementPayload(), consents: CONSENTS, emailConfigured: emailConfigured(env) });
}

async function emailSend(env, req, body) {
  const rec = await authed(env, req, body.ref);
  if (!rec) return fail('Not found.', 404);
  if (rec.expired) return expiredFail(rec);
  if (rec.status === 'email_verified' || SIGNED_STATES.includes(rec.status)) return json({ ok: true, alreadyVerified: true });
  if (rec.status !== 'awaiting_email_verification') return fail('This signup can’t continue. Please start again.', 409, 'bad_state');
  if (!emailConfigured(env)) return fail('Email verification isn’t switched on yet, so signing is unavailable. Please contact Scott.', 503, 'email_not_configured');
  const ip = ipOf(req), d = new Date().toISOString().slice(0, 10);
  const ok = await allow(env, `send15:${rec.ref}:${Math.floor(Date.now() / 900e3)}`, int(env.MAX_CODES_PER_15_MIN, 3), 15 * MIN)
    && await allow(env, `sendday:${rec.ref}:${d}`, int(env.MAX_CODES_PER_SIGNUP_PER_DAY, 6), DAY)
    && await allow(env, `sendemail:${rec.email}:${d}`, int(env.MAX_CODES_PER_EMAIL_PER_DAY, 8), DAY)
    && await allow(env, `sendip:${ipKey(req)}:${d}`, int(env.MAX_CODES_PER_IP_PER_DAY, 20), DAY)
    && await allow(env, `sendall:${d}`, int(env.MAX_EMAILS_PER_DAY, 90), DAY);
  if (!ok) { await audit(env, rec.ref, 'email_code_rate_limited', { ip }); return fail('Too many codes requested. Wait a few minutes and try again.', 429, 'rate_limited'); }
  const code = otpCode();
  const at = nowIso();
  await q(env, `INSERT INTO email_codes (ref, code_hash, expires_at, attempts, used_at, sent_at) VALUES (?, ?, ?, 0, NULL, ?)
    ON CONFLICT(ref) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, used_at = NULL, sent_at = excluded.sent_at`,
    rec.ref, await hmacHex(env.OTP_SECRET, rec.ref + ':' + code), plus(10 * MIN), at).run();
  const sent = await sendEmail(env, {
    to: [rec.email],
    subject: `${code} is your signup code — The Storage Owner's SEO Guy`,
    text: `Your code to sign your Website & SEO Services Agreement is ${code}.\n\nIt expires in 10 minutes and can be used once. If you didn't start a signup, ignore this email.\n\nSignup reference: ${rec.ref}\n— The Storage Owner's SEO Guy`
  }).catch(() => false);
  if (!sent) {
    await q(env, 'UPDATE email_codes SET expires_at = ? WHERE ref = ?', at, rec.ref).run();
    await audit(env, rec.ref, 'email_code_send_failed', {});
    return fail('We couldn’t send the code. Check the email address in Step 1 or try again.', 502, 'email_send_failed');
  }
  await audit(env, rec.ref, 'email_code_sent', { to: maskEmail(rec.email), ip, expires_at: plus(10 * MIN) });
  return json({ ok: true, sentTo: maskEmail(rec.email), expiresInSeconds: 600 });
}

async function emailVerify(env, req, body) {
  const rec = await authed(env, req, body.ref);
  if (!rec) return fail('Not found.', 404);
  if (rec.expired) return expiredFail(rec);
  if (rec.status === 'email_verified' || SIGNED_STATES.includes(rec.status)) return json({ ok: true, alreadyVerified: true });
  if (rec.status !== 'awaiting_email_verification') return fail('This signup can’t continue. Please start again.', 409, 'bad_state');
  if (!emailConfigured(env)) return fail('Email verification isn’t switched on yet.', 503, 'email_not_configured');
  const code = String(body.code || '').replace(/\D/g, '');
  if (code.length !== 6) return fail('Enter the 6-digit code from the email.', 400, 'code_format');
  const row = await q(env, 'SELECT * FROM email_codes WHERE ref = ?', rec.ref).first();
  if (!row) return fail('Send yourself a code first.', 400, 'no_code');
  if (row.used_at) return fail('That code was already used. Send a new one.', 400, 'code_used');
  if (Date.parse(row.expires_at) < Date.now()) return fail('That code has expired. Send a new one.', 400, 'code_expired');
  const bump = await q(env, 'UPDATE email_codes SET attempts = attempts + 1 WHERE ref = ? AND attempts < ? AND used_at IS NULL RETURNING attempts', rec.ref, int(env.MAX_CODE_ATTEMPTS, 5)).first();
  if (!bump) { await audit(env, rec.ref, 'email_code_locked', {}); return fail('Too many wrong tries. Send a new code.', 429, 'too_many_attempts'); }
  const good = safeEqual(await hmacHex(env.OTP_SECRET, rec.ref + ':' + code), row.code_hash);
  if (!good) {
    await audit(env, rec.ref, 'email_code_wrong', { attempt: bump.attempts, ip: ipOf(req) });
    return fail('That code isn’t right.', 400, 'code_wrong', { attemptsLeft: Math.max(0, int(env.MAX_CODE_ATTEMPTS, 5) - bump.attempts) });
  }
  const at = nowIso();
  const used = await q(env, 'UPDATE email_codes SET used_at = ? WHERE ref = ? AND used_at IS NULL AND code_hash = ?', at, rec.ref, row.code_hash).run();
  if (used.meta.changes !== 1) return fail('That code was already used. Send a new one.', 400, 'code_used');
  await q(env, "UPDATE signups SET status = 'email_verified', email_verified_at = ?, updated_at = ? WHERE ref = ? AND status = 'awaiting_email_verification'", at, at, rec.ref).run();
  await audit(env, rec.ref, 'email_verified', { method: 'one-time code', email: rec.email, ip: ipOf(req) });
  return json({ ok: true, emailVerified: true });
}

const SIGNABLE_STATES = ['awaiting_email_verification', 'email_verified'];
function signedResult(rec) { return json({ ...publicState(rec), already: true }); }

async function completeSigning(env, req, body) {
  if (!storageConfigured(env)) return fail('Signing storage isn’t set up yet.', 503, 'storage_not_configured');
  const rec = await authed(env, req, body.ref);
  if (!rec) return fail('Not found.', 404);
  if (rec.expired) return expiredFail(rec);
  const i = info(rec);
  // the signed copy is emailed to the address entered, so signing needs email delivery switched on
  if (!SIGNED_STATES.includes(rec.status) && !emailConfigured(env)) return fail('Email isn’t switched on yet, so online signing is unavailable. Please contact Scott at storageownerseoguy@gmail.com.', 503, 'email_not_configured');
  if (SIGNED_STATES.includes(rec.status)) return namesMatch(body.typedName, rec.signer_name) ? signedResult(rec) : fail('This agreement is already signed.', 409, 'already_signed');
  // No email code is needed to sign (agreement 2026-11-20.1+): the signer is identified by the details entered,
  // the typed name, the record of signing (IP, browser, time) and delivery of the signed copy to the email entered.
  if (!SIGNABLE_STATES.includes(rec.status) && rec.status !== 'signing') return fail('This signup can’t be signed. Please start again.', 409, 'bad_state');
  // the exact agreement frozen at start, which must still be the text this Worker serves
  if (body.agreementVersion !== rec.agreement_version || body.agreementSha256 !== rec.agreement_sha256 || rec.agreement_sha256 !== AGREEMENT.sha256 || rec.agreement_version !== AGREEMENT.version) {
    await audit(env, rec.ref, 'sign_refused_agreement_changed', { sent_version: String(body.agreementVersion || '').slice(0, 40), sent_sha256: String(body.agreementSha256 || '').slice(0, 64) });
    return fail('The agreement changed since you opened it. Please reload and review the current version before signing.', 409, 'agreement_changed');
  }
  if (rec.invite_id && await inviteRevoked(env, rec.invite_id)) return fail('This invitation has been withdrawn. Please contact Scott.', 403, 'invite_revoked');
  const typed = String(body.typedName || '').trim().replace(/\s+/g, ' ');
  if (!namesMatch(typed, i.owner_name)) return fail('Type your full legal name exactly as in Step 1 (' + i.owner_name + '). To use a different name, change it in Step 1 and sign again.', 400, 'name_mismatch');
  const title = String(body.title || '').trim().replace(/\s+/g, ' ');
  if (title.length < 2 || title.length > 60) return fail('Enter your title or role (for example Owner, Member, President).', 400, 'title_required');
  if (body.consentEsign !== true || body.consentAuthority !== true) return fail('Both boxes must be checked to sign.', 400, 'consent_required');
  if (!body.consentIds || body.consentIds.esign !== CONSENTS.esign.id || body.consentIds.authority !== CONSENTS.authority.id) return fail('Please reload — the consent wording changed.', 409, 'consent_changed');
  if (body.signClicked !== true) return fail('Click “Sign Agreement” to sign.', 400, 'sign_click_required');

  // claim the right to sign (one winner; a stuck attempt can be retried after 2 minutes)
  const lease = randomToken(12);
  const startedAt = nowIso();
  const claim = await q(env, `UPDATE signups SET status = 'signing', signing_lease = ?, signing_started_at = ?, updated_at = ?
    WHERE ref = ? AND (status IN ('awaiting_email_verification', 'email_verified') OR (status = 'signing' AND signing_started_at < ?))`, lease, startedAt, startedAt, rec.ref, plus(-120)).run();
  if (claim.meta.changes !== 1) {
    const now = await getRec(env, rec.ref);
    if (SIGNED_STATES.includes(now.status)) return signedResult(now);
    return fail('Your signature is already being saved. Wait a moment.', 409, 'signing_in_progress');
  }
  const release = async (why) => {
    await q(env, "UPDATE signups SET status = CASE WHEN email_verified_at IS NULL THEN 'awaiting_email_verification' ELSE 'email_verified' END, signing_lease = NULL, updated_at = ? WHERE ref = ? AND signing_lease = ?", nowIso(), rec.ref, lease).run();
    await audit(env, rec.ref, 'signing_failed', { reason: why });
  };
  let key = null;
  try {
    const signedAt = nowIso();
    const ip = ipOf(req), ua = uaOf(req);
    const consent = {
      esign: { id: CONSENTS.esign.id, text: CONSENTS.esign.text, given: true, at: signedAt },
      authority: { id: CONSENTS.authority.id, text: CONSENTS.authority.text, given: true, at: signedAt },
      sign_clicked_at: signedAt, typed_name: typed, title
    };
    const prior = (await q(env, 'SELECT seq, at, event, entry_hash FROM audit WHERE ref = ? ORDER BY seq', rec.ref).all()).results;
    const head = prior.length ? prior[prior.length - 1].entry_hash : 'GENESIS';
    const signedEntry = await auditStmt(env, rec.ref, 'agreement_signed', {
      typed_name: typed, title, consents: [CONSENTS.esign.id, CONSENTS.authority.id], sign_clicked: true,
      agreement_version: rec.agreement_version, agreement_sha256: rec.agreement_sha256, agreement_id: rec.agreement_id, ip, ua
    }, head, signedAt);
    const cert = {
      ref: rec.ref, agreement_id: rec.agreement_id, agreement_version: rec.agreement_version, agreement_sha256: rec.agreement_sha256,
      signed_at: signedAt, signer_name: typed, signer_title: title, legal_name: i.legal_name, facility_name: i.facility_name,
      address: [i.street, i.city, i.state, i.zip].join(', '), email: i.email, email_verified_at: rec.email_verified_at,
      ip_masked: maskIp(ip), user_agent_summary: uaSummary(ua),
      consents: [{ label: CONSENTS.esign.label, text: CONSENTS.esign.text, at: signedAt }, { label: CONSENTS.authority.label, text: CONSENTS.authority.text, at: signedAt }],
      audit: [...prior.map((a, n) => ({ n: n + 1, at: a.at, event: a.event, hash: a.entry_hash })), { n: prior.length + 1, at: signedAt, event: 'agreement_signed', hash: signedEntry.hash }],
      audit_head: signedEntry.hash
    };
    const pdf = signedAgreementPdf(AGREEMENT, cert, AGREEMENT_PAGES);
    const pdfSha = await sha256Hex(pdf);
    key = `signed/${rec.ref}/${rec.agreement_id}-${lease}.pdf`;
    const put = await env.AGREEMENTS.put(key, pdf, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { ref: rec.ref, agreement_id: rec.agreement_id, sha256: pdfSha, signed_at: signedAt },
      sha256: pdfSha, onlyIf: { etagDoesNotMatch: '*' }
    });
    if (!put) { await release('pdf key already existed'); return fail('Something went wrong saving your signature. Please try again.', 500, 'storage_conflict'); }
    // read it back: the agreement is not "signed" until the stored bytes are proven identical
    const back = await env.AGREEMENTS.get(key);
    const backSha = back ? await sha256Hex(new Uint8Array(await back.arrayBuffer())) : '';
    if (backSha !== pdfSha) { await release('stored pdf did not verify'); return fail('Something went wrong saving your signature. Please try again.', 500, 'storage_verify_failed'); }
    const storedEntry = await auditStmt(env, rec.ref, 'signed_pdf_stored', { pdf_sha256: pdfSha, pdf_bytes: pdf.length, storage_key: key }, signedEntry.hash, signedAt);
    const done = await env.DB.batch([
      q(env, `UPDATE signups SET status = 'signed', signed_at = ?, signer_name = ?, signer_title = ?, consent_json = ?, pdf_key = ?, pdf_sha256 = ?, pdf_bytes = ?, audit_head = ?, signing_lease = NULL, updated_at = ?
        WHERE ref = ? AND status = 'signing' AND signing_lease = ?`, signedAt, typed, title, JSON.stringify(consent), key, pdfSha, pdf.length, storedEntry.hash, signedAt, rec.ref, lease),
      signedEntry.stmt, storedEntry.stmt
    ]);
    if (done[0].meta.changes !== 1) { await env.AGREEMENTS.delete(key).catch(() => {}); throw new Error('lease lost'); } // (a bucket lock may keep the unrecorded file; harmless)
    // copy to the customer (best effort; the signed record does not depend on email)
    const copied = await sendEmail(env, {
      to: [i.email],
      subject: `Your signed Services Agreement (${rec.agreement_id})`,
      text: `Thank you, ${typed}. Your signed Website & SEO Services Agreement is attached.\n\nAgreement ID: ${rec.agreement_id}\nSignup reference: ${rec.ref}\nSigned (UTC): ${signedAt}\nPDF SHA-256: ${pdfSha}\n\nKeep this email for your records. For a paper copy, reply or email storageownerseoguy@gmail.com.\n— The Storage Owner's SEO Guy`,
      attachments: [{ filename: `Signed-Services-Agreement-${rec.agreement_id}.pdf`, content: b64(pdf) }]
    }).catch(() => false);
    await audit(env, rec.ref, copied ? 'signed_copy_emailed' : 'signed_copy_email_failed', { to: maskEmail(i.email) });
    return json({ ...publicState(await getRec(env, rec.ref)) });
  } catch (e) {
    const now = await getRec(env, rec.ref);
    if (now && now.status === 'signing' && now.signing_lease === lease) {
      if (key) await env.AGREEMENTS.delete(key).catch(() => {}); // never leave an unrecorded document behind
      await release(String(e && e.message || e).slice(0, 200));
    }
    if (now && SIGNED_STATES.includes(now.status)) return signedResult(now);
    return fail('Something went wrong saving your signature. Nothing was signed — please try again.', 500, 'sign_failed');
  }
}

async function status(env, req, url) {
  const rec = await authed(env, req, url.searchParams.get('ref'));
  if (!rec) return fail('Not found.', 404);
  if (rec.expired) return expiredFail(rec);
  return json(publicState(rec));
}

async function signedPdf(env, req, url) {
  const rec = await authed(env, req, url.searchParams.get('ref'));
  if (rec && rec.expired) return expiredFail(rec);
  if (!rec || !rec.pdf_key) return fail('Not found.', 404);
  const obj = await env.AGREEMENTS.get(rec.pdf_key);
  if (!obj) return fail('Not found.', 404);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if ((await sha256Hex(bytes)) !== rec.pdf_sha256) { await audit(env, rec.ref, 'pdf_integrity_failure', {}); return fail('The stored document failed its integrity check. Please contact Scott.', 500, 'integrity'); }
  await audit(env, rec.ref, 'signed_pdf_downloaded', { ip: ipOf(req) });
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Signed-Services-Agreement-${rec.agreement_id}.pdf"`, 'Cache-Control': 'no-store, private', 'X-Content-SHA256': rec.pdf_sha256 } });
}

// ---------- Stripe ----------
function stripe(env) {
  const base = (env.STRIPE_API_BASE || 'https://api.stripe.com/v1').replace(/\/$/, '');
  const form = (obj, prefix, out) => {
    out = out || new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
    }
    return out;
  };
  const call = async (method, path, params, idem) => {
    const headers = { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': '2024-06-20' };
    let u = base + path, body;
    if (method === 'GET' && params) u += '?' + form(params).toString();
    else if (params) { body = form(params).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (idem) headers['Idempotency-Key'] = idem;
    const r = await fetch(u, { method, headers, body });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  };
  return {
    findPromotion: (code) => call('GET', '/promotion_codes', { code, active: 'true', limit: 1, expand: { 0: 'data.coupon.applies_to' } }),
    createCheckout: (params, idem) => call('POST', '/checkout/sessions', params, idem),
    getCheckout: (id) => call('GET', '/checkout/sessions/' + encodeURIComponent(id)),
    expireCheckout: (id) => call('POST', '/checkout/sessions/' + encodeURIComponent(id) + '/expire'),
    portalSession: (params) => call('POST', '/billing_portal/sessions', params)
  };
}
// Before opening a new payment page, close the previous one so only one can ever be paid.
// Returns 'paid' if the previous page was already completed (its webhook just hasn't arrived yet).
async function closePrevious(env, sessionId) {
  if (!sessionId) return 'none';
  const g = await stripe(env).getCheckout(sessionId);
  if (!g.ok) return 'unknown';
  if (g.data.status === 'complete') return 'paid';
  if (g.data.status === 'open') { const x = await stripe(env).expireCheckout(sessionId); if (!x.ok) { const again = await stripe(env).getCheckout(sessionId); if (again.ok && again.data.status === 'complete') return 'paid'; } }
  return 'closed';
}
async function lookupPromo(env, code) {
  const r = await stripe(env).findPromotion(code);
  if (!r.ok) return { ok: false, message: 'We couldn’t check that code right now. Try again in a minute.' };
  const pc = (r.data.data || [])[0];
  if (!pc) return { ok: false, message: 'That promo code isn’t valid.' };
  const c = checkPromotion(pc, Math.floor(Date.now() / 1000), env.STRIPE_PRODUCT_BUILD);
  return c.ok ? { ok: true, promotion: pc } : c;
}
const recForOffer = (rec) => ({ invite: rec.invite_json ? JSON.parse(rec.invite_json) : null });

async function quote(env, req, body) {
  const rec = await authed(env, req, body.ref);
  if (!rec) return fail('Not found.', 404);
  if (rec.expired) return expiredFail(rec);
  if (rec.status !== 'signed') return fail(rec.status === 'paid' ? 'This signup is already paid.' : 'Please sign the agreement first.', 403, 'not_signed');
  if (rec.invite_id && await inviteRevoked(env, rec.invite_id)) return fail('This invitation has been withdrawn. Please contact Scott.', 403, 'invite_revoked');
  const offer = offerFor(recForOffer(rec), env);
  let promo = null, coupon = null;
  const code = normalizePromo(body.promoCode);
  if (body.promoCode && !offer.promoAllowed) return fail('Promo codes can’t be combined with a private offer.', 400, 'promo_not_allowed');
  if (body.promoCode && !code) return fail('That doesn’t look like a promo code.', 400, 'promo_invalid');
  if (code) {
    const p = await lookupPromo(env, code);
    if (!p.ok) return fail(p.message, 400, 'promo_rejected');
    promo = { code, id: p.promotion.id, coupon_id: p.promotion.coupon.id };
    coupon = p.promotion.coupon;
  }
  const qt = computeQuote(body, offer, coupon);
  if (qt.nothingSelected) return fail('Choose the website build, a monthly plan, or both.', 400, 'empty_order');
  // a code that makes the build free (or under Stripe's $0.50 minimum) would skip Stripe, so its redemption
  // limits would never count — those offers go through Scott (private invitation) instead
  if (promo && qt.buildIncluded && qt.dueTodayCents < 50) return fail('That code can’t be used for an online order. Please contact Scott at storageownerseoguy@gmail.com.', 400, 'promo_rejected');
  qt.promo = promo;
  qt.id = 'Q' + Date.now().toString(36) + randomToken(4);
  qt.created_at = nowIso();
  qt.approval_text = approvalText(qt);
  await q(env, 'UPDATE signups SET quote_json = ?, updated_at = ? WHERE ref = ?', JSON.stringify(qt), nowIso(), rec.ref).run();
  await audit(env, rec.ref, 'quote_created', { quote_id: qt.id, due_today: qt.dueTodayCents, monthly: qt.monthlyCents, promo: promo ? promo.code : null });
  return json({ ok: true, quote: qt });
}

async function checkout(env, req, body) {
  const rec = await authed(env, req, body.ref);
  if (!rec) return fail('Not found.', 404);
  if (rec.expired) return expiredFail(rec);
  if (rec.status !== 'signed' || !rec.pdf_sha256 || !rec.signed_at) return fail(rec.status === 'paid' ? 'This signup is already paid.' : 'Please sign the agreement first.', 403, 'not_signed');
  if (rec.invite_id && await inviteRevoked(env, rec.invite_id)) return fail('This invitation has been withdrawn. Please contact Scott.', 403, 'invite_revoked');
  const qt = rec.quote_json ? JSON.parse(rec.quote_json) : null;
  if (!qt || body.quoteId !== qt.id) return fail('Your order changed. Please review the amounts again.', 409, 'quote_changed');
  if (Date.now() - Date.parse(qt.created_at) > 3600e3) return fail('This order review expired. Please review the amounts again.', 409, 'quote_expired');
  if (body.approve !== true || body.approvedDueTodayCents !== qt.dueTodayCents || body.approvedMonthlyCents !== qt.monthlyCents) return fail('Please approve the order amounts shown.', 400, 'approval_mismatch');
  // the approved quote is frozen here; monthly billing at launch uses exactly this one
  const approval = { at: nowIso(), ip: ipOf(req), ua: uaOf(req), quote_id: qt.id, text: qt.approval_text, due_today_cents: qt.dueTodayCents, monthly_cents: qt.monthlyCents, quote: qt };
  // any earlier payment page is closed first — including when the new order has nothing due today
  if (rec.checkout_session_id) {
    const prev = await closePrevious(env, rec.checkout_session_id);
    if (prev === 'paid') return fail('Your payment already went through — refresh this page in a minute.', 409, 'already_paid');
    if (prev === 'unknown') return fail('We couldn’t reach Stripe to close your earlier payment page. Nothing was charged — please try again in a minute.', 503, 'stripe_unavailable');
  }
  await audit(env, rec.ref, 'order_amounts_approved', { quote_id: qt.id, due_today: qt.dueTodayCents, monthly: qt.monthlyCents, text: qt.approval_text });
  if (qt.dueTodayCents === 0) {
    await q(env, "UPDATE signups SET approval_json = ?, status = 'submitted_no_payment', checkout_session_id = NULL, updated_at = ? WHERE ref = ? AND status = 'signed'", JSON.stringify(approval), nowIso(), rec.ref).run();
    await audit(env, rec.ref, 'submitted_nothing_due_today', {});
    await sendWelcome(env, await getRec(env, rec.ref), null);
    return json({ ok: true, done: true, ref: rec.ref });
  }
  const base = siteFor(env, req);
  const md = { signup_ref: rec.ref, agreement_id: rec.agreement_id, agreement_sha256: rec.agreement_sha256, signed_pdf_sha256: rec.pdf_sha256, quote_id: qt.id };
  const params = {
    mode: 'payment',
    customer_email: rec.email,
    client_reference_id: rec.ref,
    success_url: `${base}/signup/welcome/?ref=${rec.ref}`,
    cancel_url: `${base}/signup/?resume=1`,
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    metadata: md,
    payment_intent_data: { metadata: md, description: `Website + SEO Build — ${JSON.parse(rec.info_json).facility_name} — ${rec.ref}` },
    customer_creation: 'always', // one Stripe customer per signup: the monthly plan and the billing portal reuse it
    invoice_creation: { enabled: true, invoice_data: { description: `Website + SEO Build — ${JSON.parse(rec.info_json).facility_name}`, metadata: md, footer: `Agreement ${rec.agreement_id} · signup ${rec.ref}` } },
    line_items: { 0: rec.invite_id
      ? { quantity: qt.facilities, price_data: { currency: 'usd', unit_amount: qt.buildUnitCents, product: env.STRIPE_PRODUCT_BUILD } }
      : { quantity: qt.facilities, price: env.STRIPE_PRICE_BUILD } }
  };
  if (qt.promo) params.discounts = { 0: { promotion_code: qt.promo.id } };
  const r = await stripe(env).createCheckout(params, 'checkout-' + rec.ref + '-' + qt.id + '-' + Date.now());
  if (!r.ok) {
    await audit(env, rec.ref, 'checkout_create_failed', { status: r.status, message: (r.data.error && r.data.error.message) || '' });
    const msg = r.data.error && r.data.error.param && /discount|promotion/.test(r.data.error.param) ? 'Stripe didn’t accept that promo code for this order. Remove it and try again.' : 'We couldn’t open secure payment. Please try again.';
    return fail(msg, 502, 'stripe_' + r.status);
  }
  if (r.data.amount_total != null && r.data.amount_total !== qt.dueTodayCents) {
    await stripe(env).expireCheckout(r.data.id).catch(() => {});
    await audit(env, rec.ref, 'checkout_amount_mismatch', { stripe_amount_total: r.data.amount_total, approved: qt.dueTodayCents });
    await notifyOwner(env, `Checkout stopped: amount mismatch (${rec.ref})`, `Stripe computed ${money(r.data.amount_total)} but the customer approved ${money(qt.dueTodayCents)}. The page was closed; nothing was charged. Check promo/price settings.`);
    return fail('The payment amount didn’t match what you approved, so we stopped. Please contact Scott.', 409, 'amount_mismatch');
  }
  await q(env, 'UPDATE signups SET approval_json = ?, checkout_session_id = ?, updated_at = ? WHERE ref = ?', JSON.stringify(approval), r.data.id, nowIso(), rec.ref).run();
  await audit(env, rec.ref, 'checkout_session_created', { session_id: r.data.id, amount_total: r.data.amount_total });
  return json({ ok: true, url: r.data.url });
}

// ---------- confirmation + welcome emails (sent only after Stripe confirms) ----------
const ownerEmail = (env) => env.OWNER_NOTIFY_EMAIL || env.EMAIL_REPLY_TO || '';
async function notify(env, msg) {
  if (!emailConfigured(env)) return false;
  if (!(await allow(env, `notifyall:${today()}`, int(env.MAX_NOTICE_EMAILS_PER_DAY, 40), DAY))) return false;
  return sendEmail(env, msg).catch(() => false);
}
async function sendWelcome(env, rec, payment) {
  const i = info(rec), qt = paidQuote(rec) || {};
  const first = String(i.owner_name || '').split(' ')[0] || 'there';
  const lines = [];
  if (payment) lines.push(`Paid today: ${money(payment.amount_total)}${qt.discountCents ? ` (${qt.facilities} × ${money(qt.buildUnitCents)} build, ${money(qt.discountCents)} off with ${qt.promo ? qt.promo.code : 'your discount'})` : qt.facilities > 1 ? ` (${qt.facilities} facilities × ${money(qt.buildUnitCents)})` : ''}. Stripe emails your receipt separately.`);
  else lines.push('Nothing was charged today.');
  lines.push(qt.monthlyCents > 0 ? `Monthly plan: ${qt.planName}, ${money(qt.monthlyCents)}/month — it starts on the day your new website goes live. You'll get a private link that day to approve it; nothing monthly is charged before then.` : 'Monthly plan: none.');
  const text = `Hi ${first},

Welcome aboard — your signup for ${i.facility_name} is complete.

${lines.join('\n')}

What happens next
• Scott will contact you within 1 business day to book your 30-minute Access Day call.
• Before the call, gather: unit sizes and current prices; door and inside measurements for common sizes; what's on site (gate, cameras, lighting, paving, 24/7 access); gate and office hours; 10–20 photos; two or three sentences on who owns the place and why; and the login emails for your Google Business Profile and domain account.
• On the call you add Scott as a Manager on your Google Business Profile (you stay the owner) and give delegate access to your domain — you click every button yourself, and passwords are never sent by email or text.

Your records
Agreement ID: ${rec.agreement_id}
Signup reference: ${rec.ref}
A copy of your signed agreement: ${site(env)}/signup/copy/
Invoices, payment method and plan: ${site(env)}/signup/billing/

Questions? Just reply to this email.
— Scott Swenson, The Storage Owner's SEO Guy`;
  const ok = await notify(env, { to: [rec.email], subject: `Welcome — your ${i.facility_name} signup is confirmed (${rec.agreement_id})`, text });
  await audit(env, rec.ref, ok ? 'welcome_email_sent' : 'welcome_email_failed', { to: maskEmail(rec.email), paid: payment ? payment.amount_total : 0 });
  if (ownerEmail(env)) await notify(env, { to: [ownerEmail(env)], subject: `New signup${payment ? ' paid ' + money(payment.amount_total) : ''}: ${i.facility_name} (${rec.ref})`,
    text: `${i.owner_name} (${i.legal_name}) — ${i.facility_name}, ${i.city}, ${i.state}
Email: ${rec.email} · Phone: ${i.phone}
Facilities: ${qt.facilities || 1} · Build paid: ${payment ? money(payment.amount_total) : '$0.00'} · Monthly at launch: ${qt.monthlyCents ? qt.planName + ' ' + money(qt.monthlyCents) + '/mo' : 'none'}
Agreement: ${rec.agreement_id} (PDF SHA-256 ${rec.pdf_sha256})
On launch day: bash _tools/mark-launched.sh ${rec.ref} https://<their site>` });
}

const WEBHOOK_TYPES = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'];
async function stripeWebhook(env, req) {
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000)))) return fail('bad signature', 400);
  const event = JSON.parse(raw);
  if (!WEBHOOK_TYPES.includes(event.type)) return json({ ok: true, ignored: true });
  const fresh = await q(env, 'INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?, ?)', event.id, nowIso()).run();
  if (fresh.meta.changes !== 1) return json({ ok: true, duplicate: true });
  try {
    return await handleStripeEvent(env, event);
  } catch (e) {
    // not processed → forget the id so Stripe's automatic retry is handled, not skipped as a duplicate
    await q(env, 'DELETE FROM stripe_events WHERE id = ?', event.id).run().catch(() => {});
    return fail('temporary error, please retry', 500, 'retry');
  }
}
async function flagUnmatched(env, event, s, why) {
  await q(env, 'INSERT OR IGNORE INTO unmatched_payments (session_id, received_at, detail) VALUES (?, ?, ?)', s.id || event.id, nowIso(),
    JSON.stringify({ type: event.type, why, mode: s.mode || null, subscription: s.subscription || null, amount_total: s.amount_total, email: s.customer_details && s.customer_details.email, client_reference_id: s.client_reference_id || null, payment_link: s.payment_link || null })).run();
  if (s.payment_status === 'paid' || s.subscription) await notifyOwner(env, `Payment needs review: ${money(s.amount_total || 0)} (${s.id || event.id})`,
    `${why}.\nEvent: ${event.type}\nCheckout session: ${s.id || '-'}\nSubscription: ${s.subscription || '-'}\nCustomer email: ${(s.customer_details && s.customer_details.email) || '-'}\nCheck it in Stripe; refund or cancel if it shouldn't exist.`);
  return json({ ok: true, unmatched: true });
}
async function notifyOwner(env, subject, text) { if (ownerEmail(env)) await notify(env, { to: [ownerEmail(env)], subject, text }); }
async function handleStripeEvent(env, event) {
  const s = event.data.object;
  if (event.type.startsWith('customer.subscription.') || event.type === 'invoice.payment_failed') return subscriptionLifecycle(env, event, s);
  if (s.mode === 'subscription' || (s.metadata && s.metadata.kind === 'monthly')) return monthlyWebhook(env, event, s);
  const rec = s.id ? await q(env, 'SELECT * FROM signups WHERE checkout_session_id = ?', s.id).first() : null;
  // A payment with no signed agreement behind it (for example an old Payment Link). Kept for review.
  if (!rec && event.type === 'checkout.session.expired') return json({ ok: true, ignored: true }); // an earlier page we already replaced
  if (!rec || (s.client_reference_id && s.client_reference_id !== rec.ref)) return flagUnmatched(env, event, s, 'no signed agreement behind this payment');
  const ap = rec.approval_json ? JSON.parse(rec.approval_json) : {};
  await audit(env, rec.ref, 'stripe_' + event.type, { stripe_event_id: event.id, session_id: s.id, payment_status: s.payment_status, amount_total: s.amount_total });
  if (event.type === 'checkout.session.expired') return json({ ok: true });
  if (event.type === 'checkout.session.async_payment_failed') {
    await q(env, "UPDATE signups SET status = 'signed', payment_json = ?, updated_at = ? WHERE ref = ? AND checkout_session_id = ?", JSON.stringify({ failed_at: nowIso(), session_id: s.id }), nowIso(), rec.ref, s.id).run();
    return json({ ok: true });
  }
  const mdq = s.metadata && s.metadata.quote_id;
  const payment = { session_id: s.id, payment_intent: s.payment_intent || null, amount_total: s.amount_total, approved_amount: ap.due_today_cents, amount_matches_approval: s.amount_total === ap.due_today_cents,
    quote_id: mdq || null, quote_matches_approval: !!mdq && mdq === ap.quote_id, customer_email: s.customer_details && s.customer_details.email, agreement_id: s.metadata && s.metadata.agreement_id,
    customer: s.customer || null, invoice: s.invoice || null };
  if (s.payment_status === 'paid') {
    payment.paid_at = nowIso();
    const up = await q(env, "UPDATE signups SET status = 'paid', payment_json = ?, updated_at = ? WHERE ref = ? AND status != 'paid'", JSON.stringify(payment), nowIso(), rec.ref).run();
    if (up.meta.changes === 1) await sendWelcome(env, await getRec(env, rec.ref), payment); // once, only after Stripe confirms
  } else {
    payment.processing_since = nowIso(); // e.g. ACH bank debit takes a few days
    await q(env, "UPDATE signups SET status = 'payment_processing', payment_json = ?, updated_at = ? WHERE ref = ? AND status != 'paid'", JSON.stringify(payment), nowIso(), rec.ref).run();
  }
  if (!payment.amount_matches_approval || !payment.quote_matches_approval) {
    await audit(env, rec.ref, 'payment_needs_review', { amount_total: s.amount_total, approved: ap.due_today_cents, quote_id: mdq, approved_quote_id: ap.quote_id });
    await notifyOwner(env, `Payment needs review (${rec.ref})`, `Stripe reported ${money(s.amount_total)}; the customer approved ${money(ap.due_today_cents)} (quote ${ap.quote_id}, paid quote ${mdq || '-'}).`);
  }
  return json({ ok: true });
}

// ---------- copies of signed agreements (lost link, or after the 30-day token has expired) ----------
// Anyone may ask; the PDF only ever goes to the email address on the signed agreement, and the
// answer is the same whether or not anything matched (no way to learn who has signed).
async function requestCopy(env, req, body, ctx) {
  const email = String(body.email || '').trim().toLowerCase();
  const ref = String(body.ref || '').trim();
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter the email address you signed with.', 400, 'email_format');
  if (ref && !/^SOSG-\d{8}-[a-z0-9]{6}$/.test(ref)) return fail('That signup reference doesn’t look right — it looks like SOSG-20261024-ab12cd.', 400, 'ref_format');
  if (!emailConfigured(env)) return fail('Email isn’t switched on yet. Please contact Scott at storageownerseoguy@gmail.com.', 503, 'email_not_configured');
  const ip = ipOf(req);
  if (!(await allow(env, `copyip:${ipKey(req)}:${today()}`, int(env.MAX_COPY_REQUESTS_PER_IP_PER_DAY, 3), DAY))) return fail('Too many requests from this connection today. Please email storageownerseoguy@gmail.com.', 429, 'rate_limited');
  const work = sendCopies(env, email, ref, ip).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work; // answer immediately: timing reveals nothing either
  return json({ ok: true, message: 'If a signed agreement matches, a copy is on its way to the email address it was signed with. It can take a few minutes; check spam too.' }, 202);
}
async function sendCopies(env, email, ref, ip) {
  const rows = (await q(env, `SELECT * FROM signups WHERE email = ? AND signed_at IS NOT NULL${ref ? ' AND ref = ?' : ''} ORDER BY signed_at DESC LIMIT 5`, ...(ref ? [email, ref] : [email])).all()).results;
  if (!rows.length) return { sent: 0 };
  const d = today();
  if (!(await allow(env, `copyemail:${email}:${d}`, int(env.MAX_COPIES_PER_EMAIL_PER_DAY, 3), DAY))) { await audit(env, rows[0].ref, 'signed_copy_request_rate_limited', { ip }); return { sent: 0 }; }
  const attachments = [], lines = [], good = [];
  for (const r of rows) {
    const obj = await env.AGREEMENTS.get(r.pdf_key);
    const bytes = obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    if (!bytes || (await sha256Hex(bytes)) !== r.pdf_sha256) { await audit(env, r.ref, 'pdf_integrity_failure', { during: 'copy request' }); continue; }
    attachments.push({ filename: `Signed-Services-Agreement-${r.agreement_id}.pdf`, content: b64(bytes) });
    lines.push(`• ${r.agreement_id} — ${JSON.parse(r.info_json).facility_name} — signed ${r.signed_at} by ${r.signer_name}\n  Signup reference: ${r.ref}\n  PDF SHA-256: ${r.pdf_sha256}`);
    good.push(r);
  }
  if (!good.length) return { sent: 0 };
  // own daily budget, charged only when a copy is really sent (the HTTP answer was already the same either way)
  if (!(await allow(env, `copyall:${today()}`, int(env.MAX_COPY_EMAILS_PER_DAY, 10), DAY))) { await audit(env, good[0].ref, 'signed_copy_daily_budget_reached', { ip }); return { sent: 0 }; }
  const ok = await sendEmail(env, {
    to: [email],
    subject: good.length === 1 ? `Copy of your signed Services Agreement (${good[0].agreement_id})` : `Copies of your ${good.length} signed Services Agreements`,
    text: `You (or someone using your email address) asked for a copy of your signed Website & SEO Services Agreement. ${good.length === 1 ? 'It is' : 'They are'} attached — the original signed document${good.length === 1 ? '' : 's'}, unchanged.\n\n${lines.join('\n\n')}\n\nYou can check a file is the original: its SHA-256 fingerprint must match the one above.\nDidn't ask for this? No action is needed — copies only ever go to this address.\n— The Storage Owner's SEO Guy`,
    attachments
  }).catch(() => false);
  for (const r of good) await audit(env, r.ref, ok ? 'signed_copy_resent' : 'signed_copy_resend_failed', { to: maskEmail(email), ip, reason: 'customer request' });
  return { sent: ok ? good.length : 0 };
}

// ---------- launch-day monthly billing ----------
// Nothing here can start a subscription until you record the launch (row in `launches`, added only with
// _tools/mark-launched.sh from your own computer). Then the hourly cron emails a private link.
const PLAN_PRODUCT = { maintain: 'STRIPE_PRODUCT_MAINTAIN', improve: 'STRIPE_PRODUCT_IMPROVE' };
const PLAN_PRICE = { maintain: ['STRIPE_PRICE_MAINTAIN', 'MAINTAIN_PRICE_CENTS'], improve: ['STRIPE_PRICE_IMPROVE', 'IMPROVE_PRICE_CENTS'] };
const planPriceId = (env, qt) => { const p = PLAN_PRICE[qt.planId]; return p && env[p[0]] && qt.monthlyUnitCents === int(env[p[1]], -1) ? env[p[0]] : null; };
const planOfPrice = (env, priceId, productId) => (priceId && priceId === env.STRIPE_PRICE_MAINTAIN) || (productId && productId === env.STRIPE_PRODUCT_MAINTAIN) ? 'maintain'
  : (priceId && priceId === env.STRIPE_PRICE_IMPROVE) || (productId && productId === env.STRIPE_PRODUCT_IMPROVE) ? 'improve' : null;
// the Stripe customer created at the build checkout (or by the monthly checkout), so receipts, plan and card live in one place
const stripeCustomerOf = (rec, l) => {
  const sj = l && l.subscription_json ? JSON.parse(l.subscription_json) : {};
  const pj = rec && rec.payment_json ? JSON.parse(rec.payment_json) : {};
  const c = sj.customer || pj.customer || null;
  return typeof c === 'string' && /^cus_[A-Za-z0-9]+$/.test(c) ? c : null;
};
const stripeMode = (env) => { const k = String(env.STRIPE_SECRET_KEY || ''); return /^(sk|rk)_test_/.test(k) ? 'test' : /^(sk|rk)_live_/.test(k) ? 'live' : 'not_configured'; };
// Live payments refuse to run while test-phase addresses are still configured.
// Controlled launch: until SIGNUP_OPEN = "true", only addresses in SIGNUP_ALLOWLIST can start a signup.
const signupOpen = (env) => env.SIGNUP_OPEN === 'true';
const allowlisted = (env, email) => String(env.SIGNUP_ALLOWLIST || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean).includes(String(email).toLowerCase());
const liveConfigSafe = (env) => stripeMode(env) !== 'live' || (/^https:\/\//.test(site(env)) && !/http:\/\//.test(String(env.ALLOWED_ORIGINS || '')) && env.ALLOW_LAN_TEST_ORIGINS !== 'true');
const billingConfigured = (env) => !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRODUCT_MAINTAIN && env.STRIPE_PRODUCT_IMPROVE);
const monthlyApproval = (qt) => `I approve ${money(qt.monthlyCents)} per month for ${qt.planName}${qt.facilities > 1 ? ` (${qt.facilities} facilities × ${money(qt.monthlyUnitCents)})` : ''}, charged today and then on the same day each month until I cancel.`;

// The quote the customer approved at signup (frozen at checkout), not whatever was quoted last.
const paidQuote = (rec) => { const ap = rec.approval_json ? JSON.parse(rec.approval_json) : null; return ap && ap.quote ? ap.quote : (rec.quote_json ? JSON.parse(rec.quote_json) : null); };
async function launchAuthed(env, req, ref) {
  if (typeof ref !== 'string' || !/^SOSG-\d{8}-[a-z0-9]{6}$/.test(ref)) return null;
  const tok = bearer(req);
  const l = await q(env, 'SELECT * FROM launches WHERE ref = ?', ref).first();
  if (!l || !tok || !l.link_token_hash || !safeEqual(await sha256Hex(tok), l.link_token_hash)) return null;
  if (Date.parse(l.link_expires_at) < Date.now()) return { expired: true };
  const rec = await getRec(env, ref);
  return rec ? { l, rec, qt: paidQuote(rec) } : null;
}
const monthlyState = (a) => ({
  ok: true, ref: a.rec.ref, agreementId: a.rec.agreement_id, facilityName: info(a.rec).facility_name, launchedAt: a.l.launched_at, siteUrl: a.l.site_url,
  planName: a.qt.planName, facilities: a.qt.facilities, monthlyUnitCents: a.qt.monthlyUnitCents, monthlyCents: a.qt.monthlyCents,
  approvalText: monthlyApproval(a.qt), active: ['active', 'cancel_scheduled'].includes(a.l.subscription_status), hasSubscription: !!a.l.subscription_id, processing: a.l.subscription_status === 'payment_processing',
  status: a.l.subscription_status, linkExpiresAt: a.l.link_expires_at
});
const linkExpired = () => fail('This billing link has expired. Reply to the launch email or contact Scott for a new one.', 401, 'link_expired');

async function monthlyStatus(env, req, url) {
  const a = await launchAuthed(env, req, url.searchParams.get('ref'));
  if (!a) return fail('Not found.', 404);
  if (a.expired) return linkExpired();
  if (!a.qt || !(a.qt.monthlyCents > 0)) return fail('There is no monthly plan on this order.', 409, 'no_monthly_plan');
  return json(monthlyState(a));
}

async function monthlyCheckout(env, req, body) {
  const a = await launchAuthed(env, req, body.ref);
  if (!a) return fail('Not found.', 404);
  if (a.expired) return linkExpired();
  const { l, rec, qt } = a;
  if (!qt || !(qt.monthlyCents > 0)) return fail('There is no monthly plan on this order.', 409, 'no_monthly_plan');
  if (l.subscription_id) return fail(l.subscription_status === 'active' ? 'Your monthly plan is already active.' : 'A monthly plan was already set up for this order. Please contact Scott.', 409, 'already_active');
  if (l.subscription_status === 'payment_processing') return fail('Your bank payment for the monthly plan is still processing — nothing else to do.', 409, 'payment_processing');
  if (!['paid', 'submitted_no_payment'].includes(rec.status) || !rec.signed_at) return fail('This order isn’t ready for monthly billing. Please contact Scott.', 409, 'not_ready');
  if (rec.invite_id && await inviteRevoked(env, rec.invite_id)) return fail('This invitation has been withdrawn. Please contact Scott.', 403, 'invite_revoked');
  if (body.approve !== true || body.approvedMonthlyCents !== qt.monthlyCents) return fail('Please approve the monthly amount shown.', 400, 'approval_mismatch');
  if (!billingConfigured(env) || !env[PLAN_PRODUCT[qt.planId]]) return fail('Monthly billing isn’t switched on yet. Please contact Scott.', 503, 'billing_not_configured');
  // a payment page that is still open is handed back (a second click, a second tab, a new link)
  const open = l.subscription_status === 'checkout_open' ? await q(env, 'SELECT * FROM launch_sessions WHERE ref = ? AND closed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1', rec.ref, plus(120)).first() : null;
  if (open) return json({ ok: true, url: open.url, reused: true });
  // only one request at a time may open a new page
  const startedAt = nowIso();
  const claim = await q(env, `UPDATE launches SET subscription_status = 'checkout_creating', updated_at = ? WHERE ref = ? AND subscription_id IS NULL
    AND (subscription_status IN ('link_sent', 'checkout_open', 'payment_failed') OR (subscription_status = 'checkout_creating' AND updated_at < ?))`, startedAt, rec.ref, plus(-60)).run();
  if (claim.meta.changes !== 1) return fail('Your payment page is being prepared — wait a moment and try again.', 409, 'checkout_in_progress');
  const release = () => q(env, "UPDATE launches SET subscription_status = 'link_sent', updated_at = ? WHERE ref = ? AND subscription_status = 'checkout_creating' AND subscription_id IS NULL", nowIso(), rec.ref).run();
  try {
    // close any older page that could still be paid, so only one subscription can ever start
    for (const old of (await q(env, 'SELECT session_id FROM launch_sessions WHERE ref = ? AND closed_at IS NULL AND expires_at > ?', rec.ref, nowIso()).all()).results) {
      const prev = await closePrevious(env, old.session_id);
      if (prev === 'paid') { await release(); return fail('Your payment already went through — it will show as active in a minute.', 409, 'already_paid'); }
      if (prev === 'unknown') { await release(); return fail('We couldn’t reach Stripe to close your earlier payment page. Nothing was charged — please try again in a minute.', 503, 'stripe_unavailable'); }
    }
    const md = { kind: 'monthly', signup_ref: rec.ref, agreement_id: rec.agreement_id, agreement_sha256: rec.agreement_sha256, signed_pdf_sha256: rec.pdf_sha256, quote_id: qt.id, plan: qt.planId, launched_at: l.launched_at };
    const expiresAt = Math.floor(Date.now() / 1000) + 1800;
    const customer = stripeCustomerOf(rec, l);
    const stdPrice = planPriceId(env, qt); // standard $59/$99 → the catalog price, so the billing portal can switch plans
    const params = {
      mode: 'subscription',
      ...(customer ? { customer } : { customer_email: rec.email }),
      client_reference_id: rec.ref,
      success_url: `${siteFor(env, req)}/signup/monthly/?ref=${rec.ref}&done=1`,
      cancel_url: `${siteFor(env, req)}/signup/monthly/?ref=${rec.ref}`,
      expires_at: expiresAt,
      metadata: md,
      subscription_data: { metadata: md, description: `${qt.planName} — ${info(rec).facility_name} — ${rec.ref}` },
      line_items: { 0: stdPrice ? { quantity: qt.facilities, price: stdPrice }
        : { quantity: qt.facilities, price_data: { currency: 'usd', unit_amount: qt.monthlyUnitCents, recurring: { interval: 'month' }, product: env[PLAN_PRODUCT[qt.planId]] } } }
    };
    const r = await stripe(env).createCheckout(params, 'monthly-' + rec.ref + '-' + startedAt);
    if (!r.ok) {
      await release();
      await audit(env, rec.ref, 'monthly_checkout_create_failed', { status: r.status, message: (r.data.error && r.data.error.message) || '' });
      return fail('We couldn’t open secure payment. Please try again.', 502, 'stripe_' + r.status);
    }
    if (r.data.amount_total != null && r.data.amount_total !== qt.monthlyCents) {
      await stripe(env).expireCheckout(r.data.id).catch(() => {});
      await release();
      await audit(env, rec.ref, 'monthly_checkout_amount_mismatch', { stripe_amount_total: r.data.amount_total, approved: qt.monthlyCents });
      return fail('The payment amount didn’t match what you approved, so we stopped. Please contact Scott.', 409, 'amount_mismatch');
    }
    const approval = { at: nowIso(), ip: ipOf(req), ua: uaOf(req), text: monthlyApproval(qt), monthly_cents: qt.monthlyCents, quote_id: qt.id, session_id: r.data.id };
    await env.DB.batch([
      q(env, 'INSERT INTO launch_sessions (session_id, ref, url, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', r.data.id, rec.ref, r.data.url, new Date(expiresAt * 1000).toISOString(), nowIso()),
      q(env, "UPDATE launches SET billing_approval_json = ?, subscribe_session_id = ?, subscription_status = 'checkout_open', updated_at = ? WHERE ref = ? AND subscription_id IS NULL", JSON.stringify(approval), r.data.id, nowIso(), rec.ref)
    ]);
    await audit(env, rec.ref, 'monthly_amount_approved', { text: approval.text, monthly: qt.monthlyCents });
    await audit(env, rec.ref, 'monthly_checkout_created', { session_id: r.data.id, amount_total: r.data.amount_total });
    return json({ ok: true, url: r.data.url });
  } catch (e) { await release().catch(() => {}); throw e; }
}

async function monthlyWebhook(env, event, s) {
  // only Checkout Sessions this Worker opened count (recorded in launch_sessions); anything else is flagged
  const ls = s.id ? await q(env, 'SELECT * FROM launch_sessions WHERE session_id = ?', s.id).first() : null;
  if (!ls || (s.client_reference_id && s.client_reference_id !== ls.ref)) return flagUnmatched(env, event, s, ls ? 'reference mismatch' : 'subscription not opened by the Worker after a recorded launch (e.g. an old Payment Link)');
  const ref = ls.ref;
  const l = await q(env, 'SELECT * FROM launches WHERE ref = ?', ref).first();
  await audit(env, ref, 'stripe_monthly_' + event.type, { stripe_event_id: event.id, session_id: s.id, subscription: s.subscription || null, payment_status: s.payment_status, amount_total: s.amount_total });
  if (['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_failed'].includes(event.type)) await q(env, 'UPDATE launch_sessions SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL', nowIso(), s.id).run();
  const approved = l.billing_approval_json ? JSON.parse(l.billing_approval_json).monthly_cents : null;
  const sub = { subscription: s.subscription || null, session_id: s.id, amount_total: s.amount_total, approved_monthly: approved, amount_matches_approval: s.amount_total === approved, customer: s.customer || null, payment_status: s.payment_status, at: nowIso() };
  if (event.type === 'checkout.session.expired') {
    await q(env, "UPDATE launches SET subscription_status = 'link_sent', updated_at = ? WHERE ref = ? AND subscription_id IS NULL AND subscription_status = 'checkout_open' AND subscribe_session_id = ?", nowIso(), ref, s.id).run();
    return json({ ok: true });
  }
  if (event.type === 'checkout.session.async_payment_failed') {
    await q(env, "UPDATE launches SET subscription_status = 'payment_failed', subscription_json = ?, updated_at = ? WHERE ref = ? AND subscription_id IS NULL", JSON.stringify({ ...sub, failed: true }), nowIso(), ref).run();
    return json({ ok: true });
  }
  if (!s.subscription) return json({ ok: true });
  if (s.payment_status !== 'paid') { // bank debit still processing: not active until Stripe confirms
    await q(env, "UPDATE launches SET subscription_status = 'payment_processing', subscribe_session_id = ?, subscription_json = ?, updated_at = ? WHERE ref = ? AND subscription_id IS NULL", s.id, JSON.stringify(sub), nowIso(), ref).run();
    return json({ ok: true });
  }
  const upd = await q(env, "UPDATE launches SET subscription_id = ?, subscription_status = 'active', subscribe_session_id = ?, subscription_json = ?, updated_at = ? WHERE ref = ? AND (subscription_id IS NULL OR subscription_id = ?)",
    s.subscription, s.id, JSON.stringify(sub), nowIso(), ref, s.subscription).run();
  if (upd.meta.changes !== 1) {
    await audit(env, ref, 'duplicate_subscription_flagged', { subscription: s.subscription, existing: l.subscription_id });
    return flagUnmatched(env, event, s, 'second subscription for an already-active launch — cancel one in Stripe');
  }
  if (!l.subscription_id) {
    await audit(env, ref, 'monthly_subscription_started', { subscription: s.subscription, amount_total: s.amount_total, launched_at: l.launched_at });
    const rec = await getRec(env, ref), qt = paidQuote(rec) || {};
    const ok = await notify(env, { to: [rec.email], subject: `Your ${qt.planName || 'monthly'} plan is active — ${info(rec).facility_name}`,
      text: `Thank you! Your ${qt.planName || 'monthly'} plan is active: ${money(s.amount_total)} paid today, then the same amount on the same day each month.\n\nSwitch between Maintain ($59) and Maintain + Improve ($99) per facility anytime at no charge — the new price starts on your next billing date — or cancel anytime, effective at the end of the billing month. Update your card or download invoices here: ${site(env)}/signup/billing/\n\nAgreement ID: ${rec.agreement_id} · Signup reference: ${rec.ref}\n— Scott Swenson, The Storage Owner's SEO Guy` });
    await audit(env, ref, ok ? 'monthly_confirmation_emailed' : 'monthly_confirmation_email_failed', { to: maskEmail(rec.email) });
    if (ownerEmail(env)) await notify(env, { to: [ownerEmail(env)], subject: `Monthly started: ${info(rec).facility_name} ${money(s.amount_total)}/mo (${ref})`, text: `Subscription ${s.subscription} for ${info(rec).facility_name} (${ref}).` });
  }
  if (!sub.amount_matches_approval) { await audit(env, ref, 'payment_needs_review', { amount_total: s.amount_total, approved }); await notifyOwner(env, `Monthly amount needs review (${ref})`, `Stripe reported ${money(s.amount_total)}; approved ${money(approved || 0)}.`); }
  return json({ ok: true });
}

// Cancellations, failed renewals, past-due: keep the launch record's status current.
async function subscriptionLifecycle(env, event, o) {
  // newer Stripe API versions (the webhook uses 2026-09-30) moved invoice.subscription under parent
  const invSub = o.subscription || (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || null;
  const subId = event.type === 'invoice.payment_failed' ? (typeof invSub === 'object' && invSub ? invSub.id : invSub) : o.id;
  const l = subId ? await q(env, 'SELECT * FROM launches WHERE subscription_id = ?', subId).first() : null;
  if (!l) return json({ ok: true, ignored: true }); // not one of ours (e.g. a client's direct Payment Link subscription)
  const sj = l.subscription_json ? JSON.parse(l.subscription_json) : {};
  if (l.subscription_status === 'canceled' && event.type !== 'customer.subscription.deleted') { await audit(env, l.ref, 'stripe_event_after_cancel_ignored', { stripe_event_id: event.id, type: event.type }); return json({ ok: true, ignored: true }); }
  let st;
  if (event.type === 'invoice.payment_failed') st = 'past_due';
  else if (event.type === 'customer.subscription.deleted') st = 'canceled';
  else st = o.status === 'trialing' ? 'active' : String(o.status || 'unknown');
  if (event.type === 'customer.subscription.updated') {
    const item = o.items && o.items.data && o.items.data[0];
    const price = item && item.price;
    sj.current_plan = planOfPrice(env, price && price.id, price && (typeof price.product === 'string' ? price.product : price.product && price.product.id)) || sj.current_plan || null;
    sj.current_unit_amount = price && price.unit_amount != null ? price.unit_amount : sj.current_unit_amount;
    sj.quantity = item ? item.quantity : sj.quantity;
    sj.cancel_at_period_end = !!o.cancel_at_period_end;
    sj.current_period_end = (item && item.current_period_end) || o.current_period_end || sj.current_period_end || null;
    if (st === 'active' && o.cancel_at_period_end) st = 'cancel_scheduled';
  }
  if (event.type === 'customer.subscription.deleted') sj.canceled_at = nowIso();
  await q(env, 'UPDATE launches SET subscription_status = ?, subscription_json = ?, updated_at = ? WHERE ref = ?', st, JSON.stringify(sj), nowIso(), l.ref).run();
  await audit(env, l.ref, 'stripe_' + event.type, { stripe_event_id: event.id, subscription: subId, status: st, plan: sj.current_plan || null, cancel_at_period_end: !!sj.cancel_at_period_end });
  if (event.type === 'invoice.payment_failed') {
    const rec = await getRec(env, l.ref);
    const ok = await notify(env, { to: [rec.email], subject: `Your monthly payment didn't go through — ${info(rec).facility_name}`,
      text: `Hi — Stripe couldn't charge your card for this month's plan (${money(o.amount_due || 0)}). Nothing about your website changes right now; Stripe will retry automatically.\n\nTo update your card, request a secure link here: ${site(env)}/signup/billing/\n\nQuestions? Reply to this email.\n— Scott Swenson, The Storage Owner's SEO Guy` });
    await audit(env, l.ref, ok ? 'payment_failed_email_sent' : 'payment_failed_email_failed', { to: maskEmail(rec.email) });
  }
  return json({ ok: true });
}

// ---------- Stripe-hosted billing portal (card, invoices, plan switch, cancel) ----------
// Customers reach it two ways: from their launch-day billing page (that link's token), or by asking for a
// one-hour link at /signup/billing/ — emailed only to the address on file, same answer either way.
async function billingLink(env, req, body, ctx) {
  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter the email address you signed up with.', 400, 'email_format');
  if (!emailConfigured(env)) return fail('Email isn’t switched on yet. Please contact Scott at storageownerseoguy@gmail.com.', 503, 'email_not_configured');
  if (!(await allow(env, `billip:${ipKey(req)}:${today()}`, int(env.MAX_COPY_REQUESTS_PER_IP_PER_DAY, 3), DAY))) return fail('Too many requests from this connection today. Please email storageownerseoguy@gmail.com.', 429, 'rate_limited');
  const work = sendBillingLink(env, email).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return json({ ok: true, message: 'If there’s a billing account for that address, a secure link is on its way to it. It works for one hour.' }, 202);
}
async function sendBillingLink(env, email) {
  const rows = (await q(env, "SELECT s.*, l.subscription_json AS l_sub FROM signups s LEFT JOIN launches l ON l.ref = s.ref WHERE s.email = ? AND s.signed_at IS NOT NULL ORDER BY s.signed_at DESC LIMIT 5", email).all()).results;
  const r = rows.find((x) => stripeCustomerOf(x, { subscription_json: x.l_sub }));
  if (!r) return;
  if (!(await allow(env, `billemail:${email}:${today()}`, int(env.MAX_COPIES_PER_EMAIL_PER_DAY, 3), DAY))) return;
  if (!(await allow(env, `billall:${today()}`, int(env.MAX_BILLING_LINKS_PER_DAY, 10), DAY))) { await audit(env, r.ref, 'billing_link_daily_budget_reached', {}); return; }
  const token = randomToken(32);
  await q(env, 'INSERT INTO portal_tokens (token_hash, ref, expires_at, created_at, uses) VALUES (?, ?, ?, ?, 0)', await sha256Hex(token), r.ref, plus(3600), nowIso()).run();
  const ok = await sendEmail(env, { to: [email], subject: 'Your secure billing link — The Storage Owner\'s SEO Guy',
    text: `Use this private link to update your card, download invoices, or switch or cancel your monthly plan (Stripe's secure billing page):\n\n${site(env)}/signup/billing/?ref=${r.ref}#t=${token}\n\nIt works for one hour. Didn't ask for this? Ignore it — the link only ever goes to this address.\n— The Storage Owner's SEO Guy` }).catch(() => false);
  await audit(env, r.ref, ok ? 'billing_link_sent' : 'billing_link_send_failed', { to: maskEmail(email) });
}
async function billingPortal(env, req, body) {
  const ref = body.ref, tok = bearer(req);
  if (typeof ref !== 'string' || !/^SOSG-\d{8}-[a-z0-9]{6}$/.test(ref) || !tok) return fail('Not found.', 404);
  const h = await sha256Hex(tok);
  let via = null;
  const pt = await q(env, 'SELECT * FROM portal_tokens WHERE token_hash = ? AND ref = ?', h, ref).first();
  if (pt) { if (Date.parse(pt.expires_at) < Date.now() || pt.uses >= 10) return fail('This billing link has expired. Request a new one.', 401, 'link_expired'); via = 'emailed link'; }
  else {
    const a = await launchAuthed(env, req, ref);
    if (!a) return fail('Not found.', 404);
    if (a.expired) return fail('This billing link has expired. Request a new one at /signup/billing/.', 401, 'link_expired');
    via = 'launch link';
  }
  const rec = await getRec(env, ref);
  const l = await q(env, 'SELECT * FROM launches WHERE ref = ?', ref).first();
  const customer = stripeCustomerOf(rec, l);
  if (!customer) return fail('There’s no billing account for this signup yet.', 409, 'no_customer');
  const r = await stripe(env).portalSession({ customer, return_url: `${siteFor(env, req)}/signup/billing/?done=1`, ...(env.STRIPE_PORTAL_CONFIG ? { configuration: env.STRIPE_PORTAL_CONFIG } : {}) });
  if (!r.ok) { await audit(env, ref, 'billing_portal_failed', { status: r.status, message: (r.data.error && r.data.error.message) || '' }); return fail('We couldn’t open the billing page. Please try again.', 502, 'stripe_' + r.status); }
  if (pt) await q(env, 'UPDATE portal_tokens SET uses = uses + 1 WHERE token_hash = ?', h).run();
  await audit(env, ref, 'billing_portal_opened', { via });
  return json({ ok: true, url: r.data.url });
}

// Hourly: email the private monthly-billing link for each newly recorded launch.
export async function processLaunches(env) {
  if (!emailConfigured(env)) return { sent: 0 };
  const rows = (await q(env, `SELECT l.ref, l.launched_at, l.site_url, s.email, s.quote_json, s.approval_json, s.info_json, s.agreement_id FROM launches l JOIN signups s ON s.ref = l.ref
    WHERE l.link_sent_at IS NULL AND l.subscription_id IS NULL AND (l.subscription_status IS NULL OR l.subscription_status = 'link_pending') AND l.link_send_attempts < 5
    ORDER BY l.link_send_attempts, l.created_at LIMIT 4`).all()).results; // ≤ ~8 subrequests each; more go next hour
  let sent = 0;
  for (const r of rows) try {
    const qt = paidQuote(r);
    if (!qt || !(qt.monthlyCents > 0)) {
      await q(env, "UPDATE launches SET subscription_status = 'not_needed', link_sent_at = ?, updated_at = ? WHERE ref = ?", nowIso(), nowIso(), r.ref).run();
      await audit(env, r.ref, 'launch_recorded_no_monthly_plan', { launched_at: r.launched_at });
      continue;
    }
    if (!(await allow(env, `sendall:${today()}`, int(env.MAX_EMAILS_PER_DAY, 90), DAY))) break;
    const token = randomToken(32), expires = plus(int(env.BILLING_LINK_TTL_DAYS, 14) * DAY);
    await q(env, 'UPDATE launches SET link_token_hash = ?, link_expires_at = ?, link_send_attempts = link_send_attempts + 1, updated_at = ? WHERE ref = ? AND subscription_id IS NULL', await sha256Hex(token), expires, nowIso(), r.ref).run();
    const i = JSON.parse(r.info_json);
    const link = `${site(env)}/signup/monthly/?ref=${r.ref}#t=${token}`;
    const ok = await sendEmail(env, {
      to: [r.email],
      subject: `${i.facility_name} is live — start your ${qt.planName} plan`,
      text: `Your new website${r.site_url ? ' (' + r.site_url + ')' : ''} is live.\n\nAs agreed, your ${qt.planName} plan starts now: ${money(qt.monthlyCents)} per month${qt.facilities > 1 ? ` (${qt.facilities} facilities)` : ''}. Use this private link to review the amount and set up payment securely with Stripe:\n\n${link}\n\nNothing is charged until you approve it on that page. The link works for ${int(env.BILLING_LINK_TTL_DAYS, 14)} days. Cancel anytime, effective at the end of the billing month.\n\nAgreement ID: ${r.agreement_id}\nSignup reference: ${r.ref}\n— The Storage Owner's SEO Guy`
    }).catch(() => false);
    if (ok) {
      await q(env, "UPDATE launches SET link_sent_at = ?, subscription_status = 'link_sent', updated_at = ? WHERE ref = ?", nowIso(), nowIso(), r.ref).run();
      await audit(env, r.ref, 'monthly_billing_link_sent', { to: maskEmail(r.email), expires_at: expires, launched_at: r.launched_at });
      sent++;
    } else await audit(env, r.ref, 'monthly_billing_link_send_failed', {});
  } catch (e) { // one bad row never blocks the others; it retries next hour (up to 5 tries, then see --status)
    await q(env, 'UPDATE launches SET link_send_attempts = link_send_attempts + 1, updated_at = ? WHERE ref = ?', nowIso(), r.ref).run().catch(() => {});
  }
  return { sent };
}

// ---------- daily backup snapshot (second copy of the records, inside the private bucket) ----------
// D1 keeps 7 days of point-in-time recovery on the Free plan. This adds one dated JSON snapshot per day
// of every signed record + its audit trail + launches + payment flags under backups/ in the private R2
// bucket, so records can be rebuilt even after those 7 days. The PDFs themselves are already in R2.
export async function snapshot(env, day) {
  day = day || today();
  const key = `backups/d1/${day}.json`;
  const all = async (sql) => (await q(env, sql).all()).results;
  const data = {
    format: 'sosg-records-snapshot-1', taken_at: nowIso(), agreement_version_served: AGREEMENT.version,
    signups: await all('SELECT ref, token_expires_at, status, agreement_id, agreement_version, agreement_sha256, info_json, email, invite_id, invite_json, email_verified_at, signed_at, signer_name, signer_title, consent_json, pdf_key, pdf_sha256, pdf_bytes, audit_head, quote_json, approval_json, checkout_session_id, payment_json, created_ip, created_at, updated_at FROM signups WHERE signed_at IS NOT NULL ORDER BY signed_at'),
    audit: await all('SELECT a.* FROM audit a JOIN signups s ON s.ref = a.ref WHERE s.signed_at IS NOT NULL ORDER BY a.seq'),
    launches: await all('SELECT ref, launched_at, site_url, marked_by, link_expires_at, link_sent_at, billing_approval_json, subscribe_session_id, subscription_id, subscription_status, subscription_json, created_at, updated_at FROM launches ORDER BY created_at'),
    unmatched_payments: await all('SELECT * FROM unmatched_payments ORDER BY received_at'),
    revoked_invites: await all('SELECT * FROM revoked_invites')
  };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = await sha256Hex(bytes);
  const put = await env.AGREEMENTS.put(key, bytes, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: digest, signed_records: String(data.signups.length) }, sha256: digest, onlyIf: { etagDoesNotMatch: '*' } });
  return { key, written: !!put, signedRecords: data.signups.length, sha256: digest };
}

// ---------- retention (daily cron) ----------
export async function purge(env) {
  const cutoff = plus(-int(env.UNSIGNED_RETENTION_DAYS, 30) * DAY);
  // one batch (one subrequest) however many rows: stays far inside the Free plan's per-invocation limits
  const OLD = 'SELECT ref FROM signups WHERE signed_at IS NULL AND created_at < ?';
  const now = nowIso();
  const res = await env.DB.batch([
    q(env, `DELETE FROM audit WHERE ref IN (${OLD})`, cutoff),
    q(env, `DELETE FROM email_codes WHERE ref IN (${OLD})`, cutoff),
    q(env, 'DELETE FROM signups WHERE signed_at IS NULL AND created_at < ?', cutoff),
    q(env, 'DELETE FROM rate_limits WHERE expires_at < ?', now),
    q(env, 'DELETE FROM email_codes WHERE expires_at < ?', plus(-DAY)),
    q(env, 'DELETE FROM portal_tokens WHERE expires_at < ?', plus(-DAY))
  ]);
  return { purgedUnsigned: res[2].meta.changes };
}

// Checks every Stripe id in the config against the account the key belongs to (live ids with a live key,
// prices = the amounts on the website). Rate-limited; returns ids and booleans only.
async function stripeCatalogCheck(env) {
  if (stripeMode(env) === 'not_configured') return { ok: false, error: 'no Stripe key' };
  if (!(await allow(env, `catalogcheck:${Math.floor(Date.now() / 3600e3)}`, 12, 3600))) return { ok: false, error: 'try again later' };
  const live = stripeMode(env) === 'live', out = { ok: true, mode: stripeMode(env), checks: {} };
  const get = async (p) => { const r = await fetch((env.STRIPE_API_BASE || 'https://api.stripe.com/v1') + p, { headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': '2024-06-20' } }); return { ok: r.ok, data: await r.json().catch(() => ({})) }; };
  const want = [['STRIPE_PRICE_BUILD', 'prices', 'BUILD_PRICE_CENTS', 'STRIPE_PRODUCT_BUILD'], ['STRIPE_PRICE_MAINTAIN', 'prices', 'MAINTAIN_PRICE_CENTS', 'STRIPE_PRODUCT_MAINTAIN'], ['STRIPE_PRICE_IMPROVE', 'prices', 'IMPROVE_PRICE_CENTS', 'STRIPE_PRODUCT_IMPROVE'],
    ['STRIPE_PRODUCT_BUILD', 'products'], ['STRIPE_PRODUCT_MAINTAIN', 'products'], ['STRIPE_PRODUCT_IMPROVE', 'products'], ['STRIPE_PORTAL_CONFIG', 'billing_portal/configurations']];
  for (const [k, kind, cents, prod] of want) {
    const id = env[k];
    if (!id) { out.checks[k] = 'missing'; out.ok = false; continue; }
    const r = await get(`/${kind}/${encodeURIComponent(id)}`);
    let good = r.ok && r.data.livemode === live && r.data.active !== false;
    if (good && cents) good = r.data.unit_amount === int(env[cents], -1) && (typeof r.data.product === 'string' ? r.data.product : r.data.product && r.data.product.id) === env[prod];
    out.checks[k] = good ? 'ok' : (r.ok ? 'wrong (mode, amount, product or inactive)' : 'not found with this key');
    if (!good) out.ok = false;
  }
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === 'POST' && path === '/api/webhooks/stripe') return stripeWebhook(env, req);
    if (path === '/api/health' && url.searchParams.get('stripe') === '1') return json(await stripeCatalogCheck(env));
    if (path === '/api/health') return json({ signupOpen: signupOpen(env),  ok: true, storageConfigured: storageConfigured(env), emailConfigured: emailConfigured(env), agreementVersion: AGREEMENT.version, agreementSha256: AGREEMENT.sha256, configVersionMatches: env.AGREEMENT_VERSION === AGREEMENT.version, billingConfigured: billingConfigured(env), stripeMode: stripeMode(env), liveConfigSafe: liveConfigSafe(env) });
    const c = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: c ? 204 : 403, headers: c || {} });
    if (!c) return fail('Forbidden origin.', 403);
    const withCors = async (p) => { const r = await p; const h = new Headers(r.headers); for (const [k, v] of Object.entries(c)) h.set(k, v); return new Response(r.body, { status: r.status, headers: h }); };
    try {
      if (!storageConfigured(env)) return withCors(Promise.resolve(fail('Signup isn’t switched on yet. Please contact Scott.', 503, 'storage_not_configured')));
      if (!liveConfigSafe(env)) return withCors(Promise.resolve(fail('Signup is temporarily unavailable. Please contact Scott.', 503, 'live_config_unsafe')));
      if (req.method === 'GET' && path === '/api/sign/status') return withCors(status(env, req, url));
      if (req.method === 'GET' && path === '/api/sign/pdf') return withCors(signedPdf(env, req, url));
      if (req.method === 'GET' && path === '/api/monthly/status') return withCors(monthlyStatus(env, req, url));
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        if (path === '/api/sign/start') return withCors(startSigning(env, req, body));
        if (path === '/api/sign/email/send') return withCors(emailSend(env, req, body));
        if (path === '/api/sign/email/verify') return withCors(emailVerify(env, req, body));
        if (path === '/api/sign/complete') return withCors(completeSigning(env, req, body));
        if (path === '/api/order/quote') return withCors(quote(env, req, body));
        if (path === '/api/order/checkout') return withCors(checkout(env, req, body));
        if (path === '/api/records/copy') return withCors(requestCopy(env, req, body, ctx));
        if (path === '/api/monthly/checkout') return withCors(monthlyCheckout(env, req, body));
        if (path === '/api/billing/link') return withCors(billingLink(env, req, body, ctx));
        if (path === '/api/billing/portal') return withCors(billingPortal(env, req, body));
      }
      return withCors(Promise.resolve(fail('Not found.', 404)));
    } catch (e) {
      return withCors(Promise.resolve(fail('Something went wrong. Please try again.', 500, 'server_error')));
    }
  },
  // hourly: send monthly-billing links for newly recorded launches; purge abandoned unsigned signups
  // (07:17 UTC: daily backup snapshot instead of billing links, to stay well inside per-run limits)
  async scheduled(event, env, ctx) {
    const backupHour = new Date(event.scheduledTime || Date.now()).getUTCHours() === int(env.BACKUP_HOUR_UTC, 7);
    ctx.waitUntil((backupHour ? snapshot(env) : processLaunches(env)).catch((e) => console.error('cron step failed:', e && e.message)).then(() => purge(env)));
  }
};

export { money };
