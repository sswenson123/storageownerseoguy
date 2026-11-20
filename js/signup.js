/*
 * Four-step signup: 1 Info → 2 Electronic agreement + signature → 3 Package → 4 Approve amounts + pay.
 * Two paths share it: public signup (/signup/) and private invitations (/signup/?invite=…).
 *
 * Security model: this page decides nothing. The signup Worker (config.signupApi, code in _worker/)
 *  - freezes the exact agreement shown in Step 3 (no email code: name + two consents + click signs),
 *    records the typed-name signature (two separate consents + the "Sign Agreement" click) with its own
 *    timestamp, and keeps the signed PDF + append-only audit trail privately under the signup reference,
 *  - prices the order itself (public prices, verified invitation prices, Stripe-validated promo codes),
 *  - and only after a verified signature AND the customer's approval of the exact amounts creates a
 *    one-time Stripe Checkout Session for that amount. There is no public payment link to skip to.
 * Prices shown before Step 4 are read-only previews.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Signup = api;
})(this, function () {
  'use strict';

  var STORAGE_KEY = 'sosg_signup_v3'; // v3: package → info → agreement → pay
  var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  var MAX_PRICE = 20000;
  // ---------- pure logic (unit-tested in tests/signup.test.js) ----------

  function money(n) {
    var fixed = (Math.round(n * 100) / 100).toFixed(2);
    return '$' + fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function cents(c) { return money(c / 100); }

  function wholeDollars(n) {
    return n % 1 === 0 ? '$' + n : money(n);
  }

  function clampFacilities(n, max) {
    var v = parseInt(n, 10);
    if (!isFinite(v) || v < 1) return 1;
    return Math.min(v, max);
  }

  function findPlan(config, id) {
    for (var i = 0; i < config.plans.length; i++) {
      if (config.plans[i].id === id) return config.plans[i];
    }
    return null;
  }

  // Stripe promotion codes: letters, digits, dashes, underscores.
  function normalizePromoCode(raw) {
    if (typeof raw !== 'string') return '';
    var c = raw.trim().toUpperCase();
    return /^[A-Z0-9_-]{2,40}$/.test(c) ? c : '';
  }

  // Read-only preview for Step 1 (package). The binding amounts come from the server quote on Step 4.
  function computeSummary(order, config) {
    var buildIncluded = order.buildIncluded !== false;
    var facilities = clampFacilities(order.facilities, config.build.maxFacilities);
    var plan = findPlan(config, order.planId) || findPlan(config, 'none');
    var setupSubtotal = buildIncluded ? config.build.price * facilities : 0;
    var monthlyTotal = plan.price * facilities;
    var monthlyStarts;
    if (plan.price === 0) monthlyStarts = 'No monthly charges';
    else if (buildIncluded) monthlyStarts = 'Starts the day your new website goes live — not today';
    else monthlyStarts = 'Starts when service begins on your existing website';
    return {
      buildIncluded: buildIncluded,
      facilities: facilities,
      setupUnit: config.build.price,
      setupSubtotal: setupSubtotal,
      plan: plan,
      monthlyUnit: plan.price,
      monthlyTotal: monthlyTotal,
      monthlyStarts: monthlyStarts,
      dueToday: setupSubtotal,
      promoCode: config.allowPromoCodes === false ? '' : normalizePromoCode(order.promoCode || ''),
      nothingSelected: !buildIncluded && plan.price === 0
    };
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var SIGN_FIELDS = ['owner_name', 'legal_name', 'facility_name', 'street', 'city', 'state', 'zip', 'phone', 'email', 'rental_software', 'rental_software_other', 'website'];

  // What the agreement was signed with. If any of it changes after signing, the customer signs again.
  function infoFingerprint(data) {
    return SIGN_FIELDS.map(function (f) { return String(data[f] || '').trim().toLowerCase(); }).join('|');
  }

  function validateStep(step, data, config, sign) {
    var errors = [];
    function need(field, label) {
      if (!data[field] || String(data[field]).trim().length < 2) errors.push({ field: field, message: label + ' is required.' });
    }
    if (step === 2) {
      need('owner_name', 'Your full legal name');
      need('legal_name', 'Legal business name');
      need('facility_name', 'Facility name');
      need('street', 'Street address');
      need('city', 'City');
      need('state', 'State');
      if (!/^\d{5}(-\d{4})?$/.test(String(data.zip || '').trim())) errors.push({ field: 'zip', message: 'Enter a 5-digit ZIP code.' });
      if (String(data.phone || '').replace(/\D/g, '').length < 10) errors.push({ field: 'phone', message: 'Enter a 10-digit phone number.' });
      var email = String(data.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'Enter a valid email address.' });
      else if (email !== String(data.email_confirm || '').trim().toLowerCase()) errors.push({ field: 'email_confirm', message: 'The two email addresses don’t match.' });
      else if (config && config.invite && config.invite.email && email !== config.invite.email.toLowerCase()) errors.push({ field: 'email', message: 'This private offer was issued for a different email address. Use the email Scott sent it to, or sign up at the regular prices without the invitation link.' });
      if (!data.rental_software) errors.push({ field: 'rental_software', message: 'Choose your rental software (or "None / paper").' });
      else if (data.rental_software === 'Other' && String(data.rental_software_other || '').trim().length < 2) errors.push({ field: 'rental_software_other', message: 'Tell us which rental software you use.' });
    } else if (step === 3) {
      if (!sign || sign.signed !== true) errors.push({ field: 'typed_name', message: 'Please sign the agreement before continuing: verify your email, type your full legal name and title, check both boxes, and click “Sign Agreement”.' });
      else if (sign.infoFingerprint && sign.infoFingerprint !== infoFingerprint(data)) errors.push({ field: 'owner_name', message: 'You changed your information after signing, so the agreement needs to be signed again with the new details.' });
    } else if (step === 1) {
      var s = computeSummary(data, config);
      if (s.nothingSelected) errors.push({ field: 'planId', message: 'Choose the website build, a monthly plan, or both.' });
    } else if (step === 4) {
      if (data.order_approved !== true) errors.push({ field: 'order_approved', message: 'Please review and approve the order amounts before continuing.' });
    }
    return errors;
  }

  // Step 4 disclosure, built from the SERVER quote (amounts in cents).
  function disclosureLines(q, config) {
    var lines = [];
    if (q.dueTodayCents > 0) {
      lines.push('Today: ' + cents(q.dueTodayCents) + ' one-time build fee' + (q.facilities > 1 ? ' (' + q.facilities + ' facilities)' : '') +
        (q.discountCents ? ', after your ' + cents(q.discountCents) + ' promo discount' : '') + '. Nothing else is charged today.');
    } else {
      lines.push('Today: nothing is charged.');
    }
    if (q.monthlyCents > 0) {
      lines.push('Monthly: ' + cents(q.monthlyCents) + '/month for ' + q.planName + (q.facilities > 1 ? ' (' + q.facilities + ' facilities)' : '') +
        ', starting ' + q.monthlyStarts + ' — not today. You’ll authorize it then, and it renews on that same day each month.');
      lines.push('Cancel the monthly plan anytime by text or email; it stops at the end of the current billing month. No contract, no cancellation fee.');
    } else {
      lines.push('Monthly: none — you chose no monthly service.');
    }
    if (q.buildIncluded) lines.push('Satisfaction guarantee: not happy within ' + config.guaranteeDays + ' days after launch, and the build fee is refunded.');
    return lines;
  }

  function quoteRows(q, buildName) {
    var rows = [];
    if (q.buildIncluded) rows.push([escapeHtml(buildName) + (q.facilities > 1 ? ' × ' + q.facilities + ' facilities @ ' + cents(q.buildUnitCents) : ''), cents(q.setupSubtotalCents)]);
    if (q.discountCents) rows.push(['Promo code ' + escapeHtml(q.promo ? q.promo.code : ''), '−' + cents(q.discountCents)]);
    rows.push(['<strong>Charged today</strong>', '<strong>' + cents(q.dueTodayCents) + '</strong>']);
    rows.push([escapeHtml(q.planName) + (q.monthlyCents && q.facilities > 1 ? ' × ' + q.facilities : ''), q.monthlyCents ? cents(q.monthlyCents) + '/month' : '$0']);
    rows.push(['Monthly billing starts', q.monthlyCents ? escapeHtml(q.monthlyStarts) : 'No monthly charges']);
    return '<table class="order-summary"><tbody>' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</tbody></table>';
  }

  // ---------- private invitations ----------
  // "<base64url JSON>.<base64url ECDSA P-256 signature>", made with _tools/make-invite.js.
  // The Worker verifies the same signature again and charges the invitation price itself.

  function b64urlToBytes(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
    var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function b64urlDecode(s) { return new TextDecoder().decode(b64urlToBytes(s)); }

  function getSubtle() {
    return (typeof crypto !== 'undefined' && crypto && crypto.subtle) ? crypto.subtle : null;
  }

  function sha256Hex(text) {
    var subtle = getSubtle();
    if (!subtle) return Promise.resolve('');
    return subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  // The exact agreement text a customer saw: everything between these two markers in agreement.html.
  function extractAgreementSource(html) {
    var start = html.indexOf('<div id="agreement-text">');
    var end = html.indexOf('<!-- /agreement-text -->');
    if (start < 0 || end < start) return '';
    return html.slice(start, end);
  }

  function okPrice(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && n <= MAX_PRICE; }

  function parseInvite(token, config, nowMs) {
    if (typeof token !== 'string' || !token || token.length > 2000) return { ok: false, reason: 'invalid' };
    var inv;
    try { inv = JSON.parse(b64urlDecode(token)); } catch (e) { return { ok: false, reason: 'invalid' }; }
    if (!inv || typeof inv !== 'object' || inv.v !== 1) return { ok: false, reason: 'invalid' };
    if (typeof inv.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(inv.id)) return { ok: false, reason: 'invalid' };
    if (typeof inv['for'] !== 'string' || !inv['for'].trim() || inv['for'].length > 80) return { ok: false, reason: 'invalid' };
    if (!okPrice(inv.setup)) return { ok: false, reason: 'invalid' };
    var plans = inv.plans || {};
    if (typeof plans !== 'object') return { ok: false, reason: 'invalid' };
    for (var k in plans) {
      if (!Object.prototype.hasOwnProperty.call(plans, k)) continue;
      if (k === 'none' || !findPlan(config, k) || !okPrice(plans[k])) return { ok: false, reason: 'invalid' };
    }
    if (inv.facilities !== undefined) {
      var f = inv.facilities;
      if (typeof f !== 'number' || f % 1 !== 0 || f < 1 || f > config.build.maxFacilities) return { ok: false, reason: 'invalid' };
    }
    if (inv.note !== undefined && (typeof inv.note !== 'string' || inv.note.length > 140)) return { ok: false, reason: 'invalid' };
    if (inv.email !== undefined && (typeof inv.email !== 'string' || inv.email.length > 120 || !EMAIL_RE.test(inv.email))) return { ok: false, reason: 'invalid' };
    if (inv.exp !== undefined) {
      if (typeof inv.exp !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(inv.exp)) return { ok: false, reason: 'invalid' };
      var endOfDay = Date.parse(inv.exp + 'T23:59:59Z');
      if (!isFinite(endOfDay)) return { ok: false, reason: 'invalid' };
      if (nowMs > endOfDay) return { ok: false, reason: 'expired' };
    }
    return { ok: true, invite: inv };
  }

  function verifyInvite(token, config, nowMs) {
    return Promise.resolve().then(function () {
      if (typeof token !== 'string' || token.length > 3000) return { ok: false, reason: 'invalid' };
      var dot = token.indexOf('.');
      var subtle = getSubtle();
      if (dot < 1 || !config.invitePublicKey || !subtle) return { ok: false, reason: 'invalid' };
      var payload = token.slice(0, dot);
      var sig = b64urlToBytes(token.slice(dot + 1));
      return subtle.importKey('jwk', config.invitePublicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        .then(function (key) { return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(payload)); })
        .then(function (valid) { return valid ? parseInvite(payload, config, nowMs) : { ok: false, reason: 'invalid' }; });
    }).catch(function () { return { ok: false, reason: 'invalid' }; });
  }

  // Returns a copy of the public config with the invitation's offer applied (display only).
  function applyInvite(config, inv) {
    var plans = inv.plans || {};
    var outPlans = [];
    config.plans.forEach(function (p) {
      if (p.id === 'none') outPlans.push(p);
      else if (Object.prototype.hasOwnProperty.call(plans, p.id)) outPlans.push({ id: p.id, name: p.name, price: plans[p.id] });
    });
    var firstPaid = outPlans.filter(function (p) { return p.id !== 'none'; })[0];
    var out = {};
    for (var key in config) if (Object.prototype.hasOwnProperty.call(config, key)) out[key] = config[key];
    out.build = { name: config.build.name, price: inv.setup, maxFacilities: inv.facilities || config.build.maxFacilities };
    out.plans = outPlans;
    out.defaultPlan = firstPaid ? firstPaid.id : 'none';
    out.allowPromoCodes = false; // private offers don't stack with promo codes
    out.invite = { id: inv.id, forName: inv['for'], note: inv.note || '', fixedFacilities: inv.facilities || null, email: inv.email || '' };
    return out;
  }

  // Formspree notification email (the system of record is the Worker; this is Scott's heads-up).
  function buildSubmission(data, quote, sign, config, nowIso) {
    var path = config.invite ? 'PRIVATE INVITATION ' + config.invite.id + ' (' + config.invite.forName + ')' : 'public signup';
    return {
      _subject: 'NEW SIGNUP — ' + (data.facility_name || '') + ' (' + sign.ref + ')' + (config.invite ? ' [invite]' : ''),
      _replyto: data.email,
      signup_ref: sign.ref,
      agreement_id: sign.agreementId,
      agreement_signed_at: sign.signedAt || '',
      signer: (sign.signerName || '') + (sign.signerTitle ? ', ' + sign.signerTitle : ''),
      agreement_sha256: sign.agreementSha256 || '',
      signed_pdf_sha256: sign.pdfSha256 || '',
      agreement_version: config.agreementVersion,
      signup_path: path,
      submitted_at: nowIso,
      owner_name: data.owner_name,
      legal_name: data.legal_name,
      facility_name: data.facility_name,
      address: [data.street, data.city, data.state, data.zip].join(', '),
      phone: data.phone,
      email: data.email,
      website: data.website || '',
      rental_software: data.rental_software === 'Other' ? 'Other: ' + (data.rental_software_other || '') : data.rental_software,
      marketing_opt_out: data.marketing_opt_out === true ? 'YES — do not use name/results' : 'no',
      facilities: quote.facilities,
      charged_today: cents(quote.dueTodayCents),
      promo_code: quote.promo ? quote.promo.code + ' (−' + cents(quote.discountCents) + ')' : '(none)',
      monthly_plan: quote.planName,
      monthly_amount: quote.monthlyCents ? cents(quote.monthlyCents) + '/mo starting ' + quote.monthlyStarts : 'none',
      order_approval: quote.approval_text,
      note: 'The signed PDF and its audit trail are stored privately by the signup Worker under the signup reference. Paid status comes only from Stripe.',
      _gotcha: data._gotcha || ''
    };
  }

  function storageKey(inviteId) { return STORAGE_KEY + (inviteId ? '_inv_' + inviteId : ''); }

  function saveProgress(storage, state, now, inviteId) {
    try {
      storage.setItem(storageKey(inviteId), JSON.stringify({ savedAt: now, state: state }));
      return true;
    } catch (e) { return false; }
  }

  function loadProgress(storage, now, inviteId) {
    try {
      var raw = storage.getItem(storageKey(inviteId));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.savedAt !== 'number' || now - parsed.savedAt > MAX_AGE_MS) return null;
      return parsed.state || null;
    } catch (e) { return null; }
  }

  function clearProgress(storage, inviteId) {
    try { storage.removeItem(storageKey(inviteId)); } catch (e) { /* ignore */ }
  }

  function fillConfigSpans(root, config) {
    var values = {
      buildPrice: wholeDollars(config.build.price),
      maintainPrice: wholeDollars((findPlan(config, 'maintain') || {}).price || 0),
      improvePrice: wholeDollars((findPlan(config, 'improve') || {}).price || 0),
      guaranteeDays: String(config.guaranteeDays),
      governingLawState: config.governingLawState,
      agreementVersion: config.agreementVersion
    };
    var nodes = root.querySelectorAll('[data-cfg]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-cfg');
      if (values[key] !== undefined) nodes[i].textContent = values[key];
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function agreementPdfUrl(config) { return '/downloads/agreements/SOSG-Services-Agreement-' + config.agreementVersion + '.pdf'; }

  // ---------- page wiring ----------

  var TEXT_FIELDS = ['owner_name', 'legal_name', 'facility_name', 'street', 'city', 'state', 'zip', 'phone', 'email', 'email_confirm', 'rental_software', 'rental_software_other', 'website'];

  function initPage(doc, win, publicConfig) {
    var form = doc.getElementById('signup-form');
    if (!form) return Promise.resolve();
    var token = new win.URLSearchParams(win.location.search).get('invite');
    var check = token ? verifyInvite(token, publicConfig, Date.now()) : Promise.resolve(null);
    return check.then(function (parsed) { setupPage(doc, win, publicConfig, form, parsed, token); });
  }

  function setupPage(doc, win, publicConfig, form, parsed, inviteToken) {
    var storage = null;
    try { storage = win.localStorage; } catch (e) { storage = null; }
    var API = String(publicConfig.signupApi || '').replace(/\/$/, '');

    // --- invitation? ---
    var config = publicConfig;
    var inviteId = null;
    var banner = doc.getElementById('invite-banner');
    if (parsed) {
      if (parsed.ok) {
        config = applyInvite(publicConfig, parsed.invite);
        inviteId = parsed.invite.id;
        banner.innerHTML = '<strong>Private offer for ' + escapeHtml(config.invite.forName) + '.</strong> ' +
          (config.invite.note ? escapeHtml(config.invite.note) + ' ' : '') + 'Your custom pricing is shown below and on the order review before payment.';
        banner.hidden = false;
      } else {
        inviteToken = null;
        banner.innerHTML = parsed.reason === 'expired'
          ? '<strong>This invitation has expired.</strong> You can still sign up at the regular prices below, or contact Scott for a new link.'
          : '<strong>This invitation link isn’t valid.</strong> You can sign up at the regular prices below, or ask Scott to resend your link.';
        banner.className = 'invite-banner warn';
        banner.hidden = false;
      }
    }

    var state = { step: 1, data: { buildIncluded: true, facilities: config.invite && config.invite.fixedFacilities || 1, planId: config.defaultPlan, promoCode: '' }, sign: null };
    var submitting = false;
    var quote = null;

    var restored = storage ? loadProgress(storage, Date.now(), inviteId) : null;
    if (restored && restored.data) {
      state = restored;
    }

    fillConfigSpans(doc, config);
    var pdfLinks = doc.querySelectorAll('[data-agreement-pdf]');
    for (var pl = 0; pl < pdfLinks.length; pl++) pdfLinks[pl].setAttribute('href', agreementPdfUrl(config));

    var planWrap = doc.getElementById('plan-options');
    planWrap.innerHTML = '';
    var PLAN_INFO = {
      none: { blurb: 'Just the build. Add a plan later anytime.', features: [] },
      maintain: { blurb: 'Keep everything accurate.', features: ['Unlimited small changes (prices, hours, specials) in 2 business days', 'Hosting watched for you', 'Every listing re-checked monthly', 'One-page monthly report'] },
      improve: { tag: 'Most complete', blurb: 'Everything in Maintain, plus growth.', features: ['A real improvement every month (town pages, size guide, seasonal)', 'Google Business Profile posts', 'Review engine managed', 'Rank tracking on searches that fill units'] }
    };
    var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>';
    config.plans.forEach(function (p) {
      var id = 'plan-' + p.id;
      var info = PLAN_INFO[p.id] || { blurb: '', features: [] };
      var label = doc.createElement('label');
      label.className = 'option-card plan-card';
      label.setAttribute('for', id);
      label.innerHTML = (info.tag ? '<span class="plan-tag">' + escapeHtml(info.tag) + '</span>' : '') +
        '<span class="plan-head"><input type="radio" name="planId" id="' + id + '" value="' + p.id + '"><span class="plan-name">' + escapeHtml(p.name) + '</span></span>' +
        '<span class="plan-price">' + (p.price ? wholeDollars(p.price) + '<small>/mo per facility</small>' : '$0<small>/mo</small>') + '</span>' +
        '<span class="plan-blurb">' + escapeHtml(info.blurb) + '</span>' +
        (info.features.length ? '<span class="feature-list">' + info.features.map(function (f) { return '<span>' + CHECK_SVG + escapeHtml(f) + '</span>'; }).join('') + '</span>' : '');
      planWrap.appendChild(label);
    });

    var facSel = doc.getElementById('facilities');
    for (var n = 1; n <= config.build.maxFacilities; n++) {
      var o = doc.createElement('option');
      o.value = String(n);
      o.textContent = n + (n === 1 ? ' facility' : ' facilities');
      facSel.appendChild(o);
    }
    if (config.invite && config.invite.fixedFacilities) { facSel.disabled = true; }

    if (!config.allowPromoCodes) doc.getElementById('promo-block').hidden = true;

    function api(method, path, body) {
      var headers = { 'Accept': 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      if (state.sign && state.sign.token) headers.Authorization = 'Bearer ' + state.sign.token;
      return win.fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Unexpected response.' }; }).then(function (j) { j._status = r.status; return j; }); });
    }

    function readForm() {
      var d = state.data;
      TEXT_FIELDS.forEach(function (f) { var el = form.elements[f]; if (el) d[f] = el.value; });
      d.marketing_opt_out = form.elements.marketing_opt_out.checked;
      d.buildIncluded = form.elements.buildIncluded.checked;
      d.facilities = config.invite && config.invite.fixedFacilities ? config.invite.fixedFacilities : clampFacilities(facSel.value, config.build.maxFacilities);
      var checked = form.querySelector('input[name="planId"]:checked');
      d.planId = checked ? checked.value : 'none';
      d._gotcha = form.elements._gotcha.value;
      d.order_approved = form.elements.order_approved.checked;
      doc.getElementById('rental-other-row').hidden = d.rental_software !== 'Other';
    }

    function writeForm() {
      var d = state.data;
      TEXT_FIELDS.forEach(function (f) { var el = form.elements[f]; if (el && d[f] !== undefined) el.value = d[f]; });
      form.elements.marketing_opt_out.checked = d.marketing_opt_out === true;
      form.elements.buildIncluded.checked = d.buildIncluded !== false;
      form.elements.order_approved.checked = false; // re-approve every time
      facSel.value = String(clampFacilities(d.facilities, config.build.maxFacilities));
      var radio = doc.getElementById('plan-' + (d.planId || config.defaultPlan)) || doc.getElementById('plan-' + config.defaultPlan);
      if (radio) radio.checked = true;
      doc.getElementById('rental-other-row').hidden = d.rental_software !== 'Other';
      renderPromo();
    }

    function persist() {
      if (!storage) return;
      var copy = JSON.parse(JSON.stringify(state));
      delete copy.data._gotcha;
      saveProgress(storage, copy, Date.now(), inviteId);
    }

    function showErrors(step, errors) {
      var box = doc.querySelector('[data-step="' + step + '"] .step-errors');
      form.querySelectorAll('[aria-invalid="true"]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
      form.querySelectorAll('.field-error').forEach(function (el) { el.remove(); });
      if (!errors.length) { box.hidden = true; box.innerHTML = ''; return; }
      box.innerHTML = '<strong>Please fix ' + (errors.length === 1 ? 'this' : 'these ' + errors.length) + ':</strong><ul>' + errors.map(function (e) { return '<li>' + escapeHtml(e.message) + '</li>'; }).join('') + '</ul>';
      box.hidden = false;
      var first = null;
      errors.forEach(function (e) {
        var el = form.elements[e.field];
        if (!el || !el.setAttribute) return;
        el.setAttribute('aria-invalid', 'true');
        var row = el.closest && el.closest('.form-row');
        if (row && !row.querySelector('.field-error')) { var m = doc.createElement('p'); m.className = 'field-error'; m.textContent = e.message; row.appendChild(m); }
        if (!first && el.offsetParent !== null) first = el;
      });
      // the message must be seen: bring the first problem (or the summary) into view
      var target = first || box;
      if (target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (x) { first.focus(); } }
    }

    function previewRows(s) {
      var rows = [];
      if (s.buildIncluded) rows.push([escapeHtml(config.build.name) + (s.facilities > 1 ? ' × ' + s.facilities + ' facilities' : ''), money(s.setupSubtotal)]);
      if (s.promoCode) rows.push(['Promo code: ' + escapeHtml(s.promoCode), '<span class="muted">discount shown on the next step</span>']);
      rows.push(['<strong>Due today</strong>' + (s.promoCode && s.dueToday ? ' <span class="muted">(before promo)</span>' : ''), '<strong>' + money(s.dueToday) + '</strong>']);
      rows.push([escapeHtml(s.plan.name) + (s.plan.price && s.facilities > 1 ? ' × ' + s.facilities : ''), s.plan.price ? money(s.monthlyTotal) + '/month' : '$0']);
      rows.push(['Monthly billing', escapeHtml(s.monthlyStarts)]);
      return '<table class="order-summary"><tbody>' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</tbody></table>';
    }

    function renderSummary() {
      var s = computeSummary(state.data, config);
      var slot = doc.getElementById('preview-slot');
      if (slot) slot.innerHTML = previewRows(s);
      renderAside();
      return s;
    }

    // Live order summary beside every step (the server quote takes over on the payment step)
    function renderAside() {
      var lines = doc.getElementById('aside-lines');
      if (!lines) return;
      var s = computeSummary(state.data, config);
      var q = state.step === 4 && quote ? quote : null;
      var rows = [];
      var fac = q ? q.facilities : s.facilities;
      var buildIncl = q ? q.buildIncluded : s.buildIncluded;
      if (buildIncl) rows.push(['<span>' + escapeHtml(config.build.name) + (fac > 1 ? ' × ' + fac : '') + '</span>', '<span>' + (q ? cents(q.setupSubtotalCents) : money(s.setupSubtotal)) + '</span>']);
      if (q && q.discountCents) rows.push(['<span>Promo ' + escapeHtml(q.promo ? q.promo.code : '') + '</span>', '<span>−' + cents(q.discountCents) + '</span>', 'discount']);
      var plan = s.plan;
      if (plan && plan.price) rows.push(['<span>' + escapeHtml(plan.name) + (fac > 1 ? ' × ' + fac : '') + '</span>', '<span>' + (q ? cents(q.monthlyCents) : money(s.monthlyTotal)) + '/mo</span>']);
      if (!rows.length) rows.push(['<span>Nothing selected yet</span>', '<span></span>']);
      lines.innerHTML = rows.map(function (r) { return '<div class="aside-line' + (r[2] ? ' ' + r[2] : '') + '">' + r[0] + r[1] + '</div>'; }).join('');
      doc.getElementById('aside-due').textContent = q ? cents(q.dueTodayCents) : money(s.dueToday);
      doc.getElementById('aside-monthly').textContent = plan && plan.price ? 'Monthly plan starts the day your new website goes live — not today.' : 'No monthly plan. You can add one later.';
    }

    function renderPromo() {
      var code = config.allowPromoCodes ? state.data.promoCode : '';
      doc.getElementById('promo-entry').hidden = !!code;
      doc.getElementById('promo-chip').hidden = !code;
      doc.getElementById('promo-chip-code').textContent = code || '';
    }

    function renderRecap() {
      var d = state.data;
      var sw = d.rental_software === 'Other' ? d.rental_software_other : d.rental_software;
      var sg = state.sign || {};
      doc.getElementById('recap').innerHTML =
        '<p><strong>' + escapeHtml(d.facility_name || '') + '</strong> (' + escapeHtml(d.legal_name || '') + ')<br>' +
        escapeHtml([d.street, d.city, d.state, d.zip].join(', ')) +
        '<br>' + escapeHtml(d.owner_name || '') + ' · ' + escapeHtml(d.phone || '') + ' · ' + escapeHtml(d.email || '') +
        '<br><span class="muted">Rental software: ' + escapeHtml(sw || '') + '</span></p>' +
        '<p class="muted">Services Agreement v' + escapeHtml(config.agreementVersion) + ' signed electronically · Agreement ID ' + escapeHtml(sg.agreementId || '') + ' · Signup reference ' + escapeHtml(sg.ref || '') + '</p>';
    }

    // ----- Step 3: agreement + first-party electronic signature -----
    // The Worker freezes the exact agreement (version + SHA-256 + text) when Step 3 opens; that frozen
    // text is what is shown here and what goes into the signed PDF.
    var signStatus = doc.getElementById('sign-status');
    var emailStatus = doc.getElementById('email-status');
    var signBtn = doc.getElementById('sign-btn');
    var frozen = null;   // { agreement: {version, sha256, html}, consents }
    var signing = false;

    function setText(el, t, cls) { el.textContent = t || ''; el.className = (el.className.split(' ')[0] || '') + (cls ? ' ' + cls : ''); }

    function signReady() {
      var sg = state.sign;
      return !!(frozen && sg && !sg.signed && frozen.emailConfigured && form.elements.typed_name.value.trim().length >= 3 &&
        form.elements.signer_title.value.trim().length >= 2 && form.elements.consent_esign.checked && form.elements.consent_authority.checked);
    }

    function renderSign() {
      var sg = state.sign;
      var signed = !!(sg && sg.signed && sg.infoFingerprint === infoFingerprint(state.data));
      doc.getElementById('signed-box').hidden = !signed;
      doc.getElementById('sign-form').hidden = signed || !API;
      doc.getElementById('sign-unavailable').hidden = !!API;
      doc.getElementById('sign-business').textContent = (state.data.legal_name || '') + ' — ' + (state.data.facility_name || '');
      doc.getElementById('typed-name-hint').textContent = 'Type your name as you entered it: ' + (state.data.owner_name || '');
      if (!form.elements.signer_title.value) form.elements.signer_title.value = 'Owner';
      doc.getElementById('email-target').textContent = state.data.email || '';
      if (signed) {
        doc.getElementById('signed-detail').textContent = 'Signed by ' + sg.signerName + (sg.signerTitle ? ', ' + sg.signerTitle : '') + ' on ' + new Date(sg.signedAt).toUTCString() +
          ' · Agreement ID ' + sg.agreementId + ' · Reference ' + sg.ref;
        doc.getElementById('signed-hash').textContent = 'Agreement fingerprint (SHA-256): ' + sg.agreementSha256 + ' · Signed PDF fingerprint: ' + sg.pdfSha256;
      }
      signBtn.disabled = !signReady() || signing;
      renderSignaturePreview();
    }

    function renderSignaturePreview() {
      var pv = doc.getElementById('sig-preview');
      if (!pv) return;
      var nm = form.elements.typed_name.value.trim();
      pv.textContent = nm;
      var title = form.elements.signer_title.value.trim();
      doc.getElementById('sig-meta').textContent = nm ? nm + (title ? ', ' + title : '') + ' · ' + (state.data.legal_name || '') + ' · ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    }

    function ensureStarted() {
      if (!API) { loadStaticAgreement(); renderSign(); return Promise.resolve(); }
      var d = state.data;
      var panel = doc.getElementById('agreement-panel');
      if (!frozen) panel.innerHTML = '<p class="muted">Loading the agreement…</p>';
      return api('POST', '/api/sign/start', {
        info: { owner_name: d.owner_name, legal_name: d.legal_name, facility_name: d.facility_name, street: d.street, city: d.city, state: d.state, zip: d.zip, phone: d.phone, email: d.email, website: d.website,
          rental_software: d.rental_software === 'Other' ? 'Other: ' + (d.rental_software_other || '') : d.rental_software, marketing_opt_out: d.marketing_opt_out === true },
        invite: inviteToken || undefined,
        resume: state.sign && state.sign.ref && state.sign.token ? { ref: state.sign.ref, token: state.sign.token } : undefined,
        _gotcha: d._gotcha || undefined
      }).then(function (r) {
        if (r.honeypot) return;
        if (!r.ok && r.code === 'token_expired' && r.signed) {
          // a signed agreement whose 30-day link has expired: never start a second one silently
          panel.innerHTML = '<p class="step-errors">Your signup link has expired, but your signed agreement is safely on file. <a href="/signup/copy/?ref=' + encodeURIComponent(state.sign.ref) + '">Get a copy of your signed agreement</a>, or email storageownerseoguy@gmail.com.</p>';
          setText(signStatus, ''); renderSign(); return;
        }
        if (!r.ok) { panel.innerHTML = '<p class="step-errors">' + escapeHtml(r.error || 'We couldn’t load the agreement.') + '</p>'; setText(signStatus, r.error || ''); renderSign(); return; }
        var sameSignup = state.sign && state.sign.ref === r.ref;
        state.sign = { ref: r.ref, token: r.token, agreementId: r.agreementId, status: r.status, emailVerified: r.emailVerified, signed: r.signed, signedAt: r.signedAt,
          signerName: r.signerName, signerTitle: r.signerTitle, agreementVersion: r.agreementVersion, agreementSha256: r.agreementSha256, pdfSha256: r.pdfSha256,
          infoFingerprint: infoFingerprint(state.data) };
        frozen = { agreement: r.agreement, consents: r.consents, emailConfigured: r.emailConfigured };
        panel.innerHTML = r.agreement.html.replace('<div id="agreement-text">', '<div>');
        fillConfigSpans(panel, publicConfig);
        doc.getElementById('agreement-version').textContent = r.agreement.version;
        doc.getElementById('consent-esign-text').textContent = r.consents.esign.text;
        doc.getElementById('consent-authority-text').textContent = r.consents.authority.text;
        if (!sameSignup) { form.elements.consent_esign.checked = false; form.elements.consent_authority.checked = false; form.elements.typed_name.value = ''; }
        if (!r.emailConfigured && !r.signed) setText(emailStatus, 'Email delivery isn’t switched on yet, so online signing is unavailable. Please contact Scott at storageownerseoguy@gmail.com.', 'error');
        persist(); renderSign();
      }).catch(function () { panel.innerHTML = '<p class="step-errors">We couldn’t reach the signup service. Check your connection and try again.</p>'; renderSign(); });
    }

    function loadStaticAgreement() {
      var panel = doc.getElementById('agreement-panel');
      win.fetch('/agreement.html').then(function (r) { return r.text(); }).then(function (html) {
        var body = new win.DOMParser().parseFromString(html, 'text/html').getElementById('agreement-text');
        if (!body) throw new Error('missing agreement');
        panel.innerHTML = body.innerHTML; fillConfigSpans(panel, publicConfig);
      }).catch(function () { panel.innerHTML = '<p>Please <a href="' + agreementPdfUrl(config) + '" target="_blank" rel="noopener">open the Services Agreement (PDF)</a>.</p>'; });
    }

    function signAgreement() {
      readForm();
      if (signing) return;
      var errs = [];
      if (!state.sign || !frozen) errs.push({ field: 'typed_name', message: 'The agreement is still loading — wait a moment and try again.' });
      if (form.elements.typed_name.value.trim().length < 3) errs.push({ field: 'typed_name', message: 'Type your full legal name.' });
      if (form.elements.signer_title.value.trim().length < 2) errs.push({ field: 'signer_title', message: 'Enter your title or role.' });
      if (!form.elements.consent_esign.checked) errs.push({ field: 'consent_esign', message: 'Check the box to agree to electronic records and signatures.' });
      if (!form.elements.consent_authority.checked) errs.push({ field: 'consent_authority', message: 'Check the box to confirm you are authorized to sign.' });
      showErrors(3, errs);
      if (errs.length) return;
      signing = true; renderSign();
      setText(signStatus, 'Signing and saving your agreement…');
      api('POST', '/api/sign/complete', {
        ref: state.sign.ref, agreementVersion: frozen.agreement.version, agreementSha256: frozen.agreement.sha256,
        typedName: form.elements.typed_name.value, title: form.elements.signer_title.value,
        consentEsign: form.elements.consent_esign.checked, consentAuthority: form.elements.consent_authority.checked,
        consentIds: { esign: frozen.consents.esign.id, authority: frozen.consents.authority.id }, signClicked: true
      }).then(function (r) {
        signing = false;
        if (!r.ok) {
          setText(signStatus, r.error || 'Your signature wasn’t saved. Nothing was signed — try again.', 'error');
          if (r.code === 'agreement_changed' || r.code === 'consent_changed') { frozen = null; ensureStarted(); }
          renderSign(); return;
        }
        state.sign.signed = true; state.sign.status = r.status; state.sign.signedAt = r.signedAt; state.sign.signerName = r.signerName; state.sign.signerTitle = r.signerTitle;
        state.sign.pdfSha256 = r.pdfSha256; state.sign.agreementSha256 = r.agreementSha256;
        persist(); setText(signStatus, ''); renderSign();
        doc.getElementById('download-signed').focus();
      }).catch(function () { signing = false; setText(signStatus, 'We couldn’t reach the signup service. Nothing was signed — try again.', 'error'); renderSign(); });
    }

    function downloadSigned() {
      var st = doc.getElementById('download-status');
      st.textContent = 'Preparing your signed PDF…';
      var expected = state.sign.pdfSha256;
      win.fetch(API + '/api/sign/pdf?ref=' + encodeURIComponent(state.sign.ref), { headers: { Authorization: 'Bearer ' + state.sign.token } })
        .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.arrayBuffer(); })
        .then(function (buf) {
          return (getSubtle() ? getSubtle().digest('SHA-256', buf) : Promise.resolve(null)).then(function (h) {
            var got = h ? Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('') : expected;
            if (got !== expected) throw new Error('fingerprint mismatch');
            var a = doc.createElement('a');
            a.href = win.URL.createObjectURL(new win.Blob([buf], { type: 'application/pdf' }));
            a.download = 'Signed-Services-Agreement-' + state.sign.agreementId + '.pdf';
            doc.body.appendChild(a); a.click(); a.remove();
            st.textContent = 'Downloaded and checked (fingerprint matches). Keep it with your records.';
          });
        }).catch(function (e) {
          if (/status 401/.test(String(e && e.message))) { st.innerHTML = 'Your signup link has expired. <a href="/signup/copy/?ref=' + encodeURIComponent(state.sign.ref) + '">Get your signed copy by email</a>.'; return; }
          st.textContent = 'The download didn’t work. Try again, or ask Scott to email it.';
        });
    }

    // ----- Step 4: server quote + approval -----
    function loadQuote() {
      quote = null;
      var slot = doc.getElementById('quote-slot');
      var btn = doc.getElementById('submit-btn');
      btn.disabled = true;
      form.elements.order_approved.checked = false;
      slot.innerHTML = '<p class="muted">Calculating your order…</p>';
      var d = state.data;
      return api('POST', '/api/order/quote', { ref: state.sign.ref, facilities: d.facilities, planId: d.planId, buildIncluded: d.buildIncluded, promoCode: config.allowPromoCodes ? d.promoCode : '' }).then(function (r) {
        if (!r.ok) {
          slot.innerHTML = '<p class="step-errors">' + escapeHtml(r.error || 'We couldn’t calculate your order.') + '</p>';
          if (r.code === 'promo_rejected') { // drop the code and show the order without it
            var pm = doc.getElementById('promo-msg'); pm.textContent = r.error || 'That promo code can’t be used.'; pm.className = 'promo-msg error';
            state.data.promoCode = ''; persist(); renderPromo(); return loadQuote();
          }
          return;
        }
        quote = r.quote;
        slot.innerHTML = quoteRows(quote, config.build.name);
        doc.getElementById('disclosure').innerHTML = '<ul>' + disclosureLines(quote, config).map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>';
        doc.getElementById('approval-text').textContent = quote.approval_text;
        btn.disabled = false;
        btn.textContent = quote.dueTodayCents > 0 ? 'Pay ' + cents(quote.dueTodayCents) + ' securely →' : 'Approve & Submit My Signup';
        renderAside();
        doc.getElementById('payment-note').textContent = quote.dueTodayCents > 0
          ? 'Next you’ll go to Stripe’s secure page to pay exactly ' + cents(quote.dueTodayCents) + ' by card, Apple Pay, or Link. We never see your card number.'
          : 'Nothing is charged today. Scott will confirm your start date and send your monthly billing link when service begins.';
      }).catch(function () { slot.innerHTML = '<p class="step-errors">We couldn’t reach the order service. Please try again.</p>'; });
    }

    function goTo(step) {
      state.step = step;
      doc.querySelectorAll('.signup-step').forEach(function (el) { el.hidden = Number(el.getAttribute('data-step')) !== step; });
      doc.querySelectorAll('.steps-progress li').forEach(function (li) {
        var n2 = Number(li.getAttribute('data-for'));
        li.classList.toggle('current', n2 === step);
        li.classList.toggle('done', n2 < step);
        if (n2 === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
      renderAside();
      if (step === 1) renderSummary();
      if (step === 3) { renderSign(); ensureStarted(); }
      if (step === 4) { renderRecap(); renderPromo(); loadQuote(); }
      var heading = doc.querySelector('[data-step="' + step + '"] h2');
      if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
      win.scrollTo(0, 0);
      persist();
    }

    function next() {
      readForm();
      var errs = validateStep(state.step, state.data, config, state.sign);
      showErrors(state.step, errs);
      if (!errs.length) goTo(state.step + 1);
    }

    form.addEventListener('click', function (e) {
      var t = e.target;
      if (t.matches('[data-next]')) { e.preventDefault(); next(); }
      else if (t.matches('[data-back]')) { e.preventDefault(); readForm(); goTo(state.step - 1); }
      else if (t.matches('[data-goto]')) { e.preventDefault(); readForm(); goTo(Number(t.getAttribute('data-goto'))); }
      else if (t.id === 'sign-btn') { e.preventDefault(); signAgreement(); }
      else if (t.id === 'download-signed') { e.preventDefault(); downloadSigned(); }
      else if (t.id === 'print-agreement') { e.preventDefault(); win.open(agreementPdfUrl(config), '_blank', 'noopener'); }
      else if (t.id === 'promo-apply') {
        e.preventDefault();
        var input = doc.getElementById('promo');
        var msg = doc.getElementById('promo-msg');
        var code = normalizePromoCode(input.value);
        if (!input.value.trim()) { msg.textContent = 'Type your code first.'; msg.className = 'promo-msg error'; return; }
        if (!code) { msg.textContent = 'That doesn’t look like a promo code — codes use only letters, numbers, and dashes.'; msg.className = 'promo-msg error'; return; }
        if (!state.sign || !state.sign.signed) { msg.textContent = 'Sign the agreement first — then apply your code here.'; msg.className = 'promo-msg error'; return; }
        msg.textContent = 'Checking ' + code + '…'; msg.className = 'promo-msg';
        readForm();
        api('POST', '/api/order/quote', { ref: state.sign.ref, facilities: state.data.facilities, planId: state.data.planId, buildIncluded: state.data.buildIncluded, promoCode: code }).then(function (r) {
          if (!r.ok) { msg.textContent = r.error || 'That promo code isn’t valid.'; msg.className = 'promo-msg error'; return; }
          state.data.promoCode = code;
          input.value = '';
          msg.textContent = 'Code ' + code + ' applied: −' + cents(r.quote.discountCents) + ' on the website build.';
          msg.className = 'promo-msg ok';
          renderPromo(); persist(); loadQuote();
        }).catch(function () { msg.textContent = 'We couldn’t check that code right now. Try again.'; msg.className = 'promo-msg error'; });
      } else if (t.id === 'promo-remove') {
        e.preventDefault();
        state.data.promoCode = '';
        var m2 = doc.getElementById('promo-msg');
        m2.textContent = 'Promo code removed.';
        m2.className = 'promo-msg';
        renderPromo(); persist(); loadQuote();
      } else if (t.id === 'clear-progress') {
        e.preventDefault();
        if (storage) clearProgress(storage, inviteId);
        win.location.href = win.location.pathname + (inviteToken ? '?invite=' + encodeURIComponent(inviteToken) : '');
      }
    });

    doc.getElementById('promo').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doc.getElementById('promo-apply').click(); }
    });
    form.addEventListener('change', function (e) {
      readForm();
      if (state.step === 3) renderSign();
      if (state.step === 1) renderSummary(); else renderAside();
      if (state.step === 4 && e.target && e.target.id === 'order_approved') {
        doc.getElementById('submit-btn').disabled = !quote;
      }
      persist();
    });
    form.addEventListener('input', function (e) {
      if (state.step === 3) renderSign();
      // fixing a field clears its message right away
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('aria-invalid') === 'true') {
        t.removeAttribute('aria-invalid');
        var row = t.closest && t.closest('.form-row'); var fe = row && row.querySelector('.field-error'); if (fe) fe.remove();
      }
    });
    // six digits typed or pasted → verify right away (one less click)
    form.addEventListener('submit', function (e) { e.preventDefault(); if (state.step < 4) next(); else submit(); });

    function showDone(ref) {
      form.hidden = true;
      doc.querySelector('.steps-progress').hidden = true;
      var done = doc.getElementById('signup-done');
      doc.getElementById('done-ref').textContent = ref;
      done.hidden = false;
      done.querySelector('h2').focus();
    }

    function submit() {
      if (submitting) return; // blocks double-clicks / duplicate submissions
      readForm();
      for (var s1 = 1; s1 <= 4; s1++) {
        var errs = validateStep(s1, state.data, config, state.sign);
        if (errs.length) { goTo(s1); showErrors(s1, errs); return; }
      }
      if (!quote) { showErrors(4, [{ field: 'order_approved', message: 'Your order is still loading — please wait a moment.' }]); return; }
      submitting = true;
      var btn = doc.getElementById('submit-btn');
      var status = doc.getElementById('submit-status');
      btn.disabled = true;
      if (state.data._gotcha) { showDone(state.sign.ref); return; } // bot filled the hidden field: fake success, send nothing
      status.textContent = 'Submitting…';
      // Scott's notice is emailed by the Worker once Stripe confirms (no customer data goes to third parties from the browser).
      api('POST', '/api/order/checkout', { ref: state.sign.ref, quoteId: quote.id, approve: true, approvedDueTodayCents: quote.dueTodayCents, approvedMonthlyCents: quote.monthlyCents }).then(function (r) {
        if (!r.ok) {
          submitting = false; btn.disabled = false;
          status.textContent = (r.error || 'Something went wrong.') + ' Nothing was charged.';
          if (r.code === 'quote_changed' || r.code === 'quote_expired') loadQuote();
          return;
        }
        if (r.url) { status.textContent = 'Taking you to secure payment…'; persist(); win.location.assign(r.url); return; }
        if (storage) clearProgress(storage, inviteId);
        showDone(state.sign.ref);
      }).catch(function () {
        submitting = false;
        btn.disabled = false;
        status.textContent = 'Something went wrong sending your signup. Please try again — nothing was charged.';
      });
    }

    writeForm();
    goTo(state.step);
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.SIGNUP_CONFIG) {
    var start = function () {
      initPage(document, window, window.SIGNUP_CONFIG);
      if (!document.getElementById('signup-form')) fillConfigSpans(document, window.SIGNUP_CONFIG);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return {
    money: money, cents: cents, clampFacilities: clampFacilities, normalizePromoCode: normalizePromoCode,
    computeSummary: computeSummary, validateStep: validateStep, infoFingerprint: infoFingerprint,
    parseInvite: parseInvite, applyInvite: applyInvite, verifyInvite: verifyInvite,
    disclosureLines: disclosureLines, quoteRows: quoteRows, extractAgreementSource: extractAgreementSource, sha256Hex: sha256Hex,
    buildSubmission: buildSubmission, saveProgress: saveProgress, loadProgress: loadProgress,
    clearProgress: clearProgress, fillConfigSpans: fillConfigSpans, escapeHtml: escapeHtml, agreementPdfUrl: agreementPdfUrl,
    STORAGE_KEY: STORAGE_KEY, MAX_AGE_MS: MAX_AGE_MS
  };
});
