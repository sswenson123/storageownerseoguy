// Pure helpers for the signup Worker (no network, no storage) — unit-tested in tests/worker.test.mjs.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const enc = new TextEncoder();

export function pricing(env) {
  const n = (v, d) => { const x = parseInt(v, 10); return Number.isFinite(x) && x >= 0 ? x : d; };
  return {
    buildCents: n(env.BUILD_PRICE_CENTS, 19900),
    plans: {
      none: { id: 'none', name: 'No monthly service', cents: 0 },
      maintain: { id: 'maintain', name: 'Maintain', cents: n(env.MAINTAIN_PRICE_CENTS, 5900) },
      improve: { id: 'improve', name: 'Maintain + Improve', cents: n(env.IMPROVE_PRICE_CENTS, 9900) }
    },
    maxFacilities: n(env.MAX_FACILITIES, 7)
  };
}

export function money(cents) {
  return '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

// Same rules as Step 1 in js/signup.js, enforced again on the server.
export function validateInfo(raw) {
  const i = raw || {};
  const info = {
    owner_name: clean(i.owner_name, 80), legal_name: clean(i.legal_name, 120), facility_name: clean(i.facility_name, 120),
    street: clean(i.street, 120), city: clean(i.city, 60), state: clean(i.state, 20), zip: clean(i.zip, 10),
    phone: clean(i.phone, 30), email: clean(i.email, 120).toLowerCase(), website: clean(i.website, 200),
    rental_software: clean(i.rental_software, 60), marketing_opt_out: i.marketing_opt_out === true
  };
  const errors = [];
  for (const [k, label] of [['owner_name', 'Your name'], ['legal_name', 'Legal business name'], ['facility_name', 'Facility name'], ['street', 'Street address'], ['city', 'City'], ['state', 'State'], ['rental_software', 'Rental software']]) {
    if (info[k].length < 2) errors.push(label + ' is required.');
  }
  if (!/^\d{5}(-\d{4})?$/.test(info.zip)) errors.push('ZIP code is invalid.');
  if (info.phone.replace(/\D/g, '').length < 10) errors.push('Phone number is invalid.');
  if (!EMAIL_RE.test(info.email)) errors.push('Email address is invalid.');
  return { info, errors };
}

export function b64url(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlToBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export function randomToken(bytes = 32) { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
export function randomId(len = 6) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(len));
  return [...b].map((x) => a[x % a.length]).join('');
}
export function makeRef(now) { return 'SOSG-' + new Date(now).toISOString().slice(0, 10).replace(/-/g, '') + '-' + randomId(6); }
export function makeAgreementId(now) { return 'AGR-' + new Date(now).toISOString().slice(0, 10).replace(/-/g, '') + '-' + randomId(8).toUpperCase(); }

// Stripe webhook: header "t=<ts>,v1=<hex>"; v1 = HMAC-SHA256(secret, "<ts>.<raw body>")
export async function verifyStripeSignature(rawBody, header, secret, nowSec, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = {};
  for (const p of header.split(',')) { const [k, v] = p.split('='); (parts[k] = parts[k] || []).push(v); }
  const t = parseInt((parts.t || [])[0], 10);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = await hmacHex(secret, t + '.' + rawBody);
  return (parts.v1 || []).some((v) => safeEqual(v, expected));
}

// ---------- private invitations (same format and key as _tools/make-invite.js) ----------
const MAX_PRICE = 20000;
const okPrice = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_PRICE;
export async function verifyInvite(token, jwk, nowMs, maxFacilities = 7) {
  try {
    if (typeof token !== 'string' || token.length > 3000 || !jwk) return { ok: false, reason: 'invalid' };
    const dot = token.indexOf('.');
    if (dot < 1) return { ok: false, reason: 'invalid' };
    const payload = token.slice(0, dot);
    const key = await crypto.subtle.importKey('jwk', typeof jwk === 'string' ? JSON.parse(jwk) : jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(token.slice(dot + 1)), enc.encode(payload));
    if (!valid) return { ok: false, reason: 'invalid' };
    const inv = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    if (!inv || inv.v !== 1 || typeof inv.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(inv.id) || !okPrice(inv.setup)) return { ok: false, reason: 'invalid' };
    for (const [k, v] of Object.entries(inv.plans || {})) if (!['maintain', 'improve'].includes(k) || !okPrice(v)) return { ok: false, reason: 'invalid' };
    if (inv.facilities !== undefined && !(Number.isInteger(inv.facilities) && inv.facilities >= 1 && inv.facilities <= maxFacilities)) return { ok: false, reason: 'invalid' };
    if (inv.email !== undefined && !EMAIL_RE.test(inv.email)) return { ok: false, reason: 'invalid' };
    if (inv.exp !== undefined) {
      const end = Date.parse(inv.exp + 'T23:59:59Z');
      if (!Number.isFinite(end)) return { ok: false, reason: 'invalid' };
      if (nowMs > end) return { ok: false, reason: 'expired' };
    }
    return { ok: true, invite: inv };
  } catch (e) { return { ok: false, reason: 'invalid' }; }
}

// Prices that apply to this signup: public, or the verified invitation's.
export function offerFor(record, env) {
  const p = pricing(env);
  const inv = record.invite;
  if (!inv) return { buildCents: p.buildCents, plans: p.plans, maxFacilities: p.maxFacilities, fixedFacilities: null, promoAllowed: env.ALLOW_PROMO_CODES !== 'false' };
  const plans = { none: p.plans.none };
  for (const [k, v] of Object.entries(inv.plans || {})) plans[k] = { ...p.plans[k], cents: Math.round(v * 100) };
  return { buildCents: Math.round(inv.setup * 100), plans, maxFacilities: inv.facilities || p.maxFacilities, fixedFacilities: inv.facilities || null, promoAllowed: false, inviteId: inv.id };
}

export function normalizePromo(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9_-]{2,40}$/.test(c) ? c : '';
}

// Server-side quote. coupon = Stripe coupon object (already validated) or null.
export function computeQuote(order, offer, coupon) {
  const o = order || {};
  const buildIncluded = o.buildIncluded !== false;
  let facilities = parseInt(o.facilities, 10);
  if (!Number.isFinite(facilities) || facilities < 1) facilities = 1;
  facilities = Math.min(facilities, offer.maxFacilities);
  if (offer.fixedFacilities) facilities = offer.fixedFacilities;
  const plan = (typeof o.planId === 'string' && Object.prototype.hasOwnProperty.call(offer.plans, o.planId) && offer.plans[o.planId]) || offer.plans.none;
  const setupSubtotal = buildIncluded ? offer.buildCents * facilities : 0;
  let discount = 0;
  if (coupon && setupSubtotal > 0) {
    if (coupon.percent_off) discount = Math.round(setupSubtotal * coupon.percent_off / 100);
    else if (coupon.amount_off) discount = Math.min(coupon.amount_off, setupSubtotal);
  }
  const monthly = plan.cents * facilities;
  return {
    buildIncluded, facilities, planId: plan.id, planName: plan.name,
    buildUnitCents: offer.buildCents, setupSubtotalCents: setupSubtotal, discountCents: discount,
    dueTodayCents: setupSubtotal - discount, monthlyUnitCents: plan.cents, monthlyCents: monthly,
    monthlyStarts: monthly === 0 ? 'none' : (buildIncluded ? 'the day your new website goes live' : 'when service begins'),
    nothingSelected: !buildIncluded && plan.cents === 0
  };
}

// The order-approval sentence the customer must accept on Step 4 (same text shown and stored).
export function approvalText(q) {
  const parts = [];
  parts.push(q.dueTodayCents > 0 ? `I approve a one-time charge of ${money(q.dueTodayCents)} today` : 'I understand nothing is charged today');
  if (q.monthlyCents > 0) parts.push(`and ${money(q.monthlyCents)} per month for ${q.planName} starting ${q.monthlyStarts}, renewing monthly until I cancel`);
  else parts.push('and no monthly charges');
  return parts.join(' ') + '.';
}

// Promo code check against Stripe's promotion code + coupon objects.
export function checkPromotion(pc, nowSec, buildProductId) {
  if (!pc || !pc.active) return { ok: false, message: 'That promo code isn’t valid.' };
  const c = pc.coupon || {};
  if (c.valid === false) return { ok: false, message: 'That promo code has expired.' };
  if (pc.expires_at && nowSec > pc.expires_at) return { ok: false, message: 'That promo code has expired.' };
  if (pc.max_redemptions && pc.times_redeemed >= pc.max_redemptions) return { ok: false, message: 'That promo code has already been used.' };
  if (pc.customer) return { ok: false, message: 'That promo code is reserved for a specific customer — ask Scott.' };
  if (c.applies_to && Array.isArray(c.applies_to.products) && c.applies_to.products.length && buildProductId && !c.applies_to.products.includes(buildProductId)) {
    return { ok: false, message: 'That promo code doesn’t apply to the website build.' };
  }
  if (c.currency && c.amount_off && c.currency !== 'usd') return { ok: false, message: 'That promo code isn’t valid.' };
  return { ok: true };
}

// ---------- first-party signing ----------

// Server-authoritative consent wording. The page shows these exact strings (from /api/sign/start);
// the Worker records the text and version it defined — never text sent by the browser.
export const CONSENTS = {
  esign: {
    id: 'esign-2026-10-24.3', label: 'Electronic records and signatures',
    text: 'I agree to use electronic records and electronic signatures for the Website & SEO Services Agreement and related records. I intend my typed name and my click on \u201cSign Agreement\u201d to be my signature, with the same legal effect as a handwritten signature. I can download and keep the signed PDF, ask for a paper copy at no charge, and withdraw consent for future records by emailing storageownerseoguy@gmail.com.'
  },
  authority: {
    id: 'authority-2026-10-24.3', label: 'Authority to sign',
    text: 'I am authorized to sign this Agreement on behalf of the business named above and to bind it to these terms.'
  }
};

// Names match if they are the same apart from capitalization, spacing and apostrophe style.
export function normalizeName(s) {
  return String(s || '').normalize('NFKC').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}
export const namesMatch = (a, b) => normalizeName(a).length >= 3 && normalizeName(a) === normalizeName(b);

// 6-digit code, uniform (rejection sampling), from the platform CSPRNG.
export function otpCode() {
  const buf = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(buf); if (buf[0] < 4294000000) return String(buf[0] % 1000000).padStart(6, '0'); }
}

// Privacy: the full IP stays in the private database; documents show a masked form.
export function maskIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : 'unknown';
}
export function uaSummary(ua) {
  ua = String(ua || '');
  const b = /Edg\/(\d+)/.exec(ua) ? 'Edge ' + /Edg\/(\d+)/.exec(ua)[1] : /Chrome\/(\d+)/.exec(ua) && !/Chromium/.test(ua) ? 'Chrome ' + /Chrome\/(\d+)/.exec(ua)[1] : /Firefox\/(\d+)/.exec(ua) ? 'Firefox ' + /Firefox\/(\d+)/.exec(ua)[1] : /Version\/(\d+).*Safari/.exec(ua) ? 'Safari ' + /Version\/(\d+).*Safari/.exec(ua)[1] : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return `${b} on ${os}${/Mobile/.test(ua) ? ' (mobile)' : ''}`;
}

// Stable JSON (sorted keys) for hashing audit entries.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
export async function auditHash(prevHash, entry) {
  return sha256Hex(prevHash + '\n' + canonical(entry));
}

// Recompute an audit chain; returns { ok, head, brokenAt }.
export async function verifyAuditChain(rows) {
  let prev = 'GENESIS';
  for (const r of rows) {
    const h = await auditHash(prev, { ref: r.ref, at: r.at, event: r.event, detail: JSON.parse(r.detail) });
    if (r.prev_hash !== prev || r.entry_hash !== h) return { ok: false, brokenAt: r.seq, head: prev };
    prev = h;
  }
  return { ok: true, head: prev };
}
