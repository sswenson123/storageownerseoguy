/*
 * Customer record pages (no build step, no libraries):
 *   /signup/copy/     — email me a copy of my signed agreement (works after the 30-day signup link expires)
 *   /signup/monthly/  — launch day: approve and start the monthly plan (link emailed by the signup Worker)
 * The page decides nothing; the signup Worker (SIGNUP_CONFIG.signupApi) checks everything.
 */
(function (win, doc) {
  'use strict';
  var cfg = win.SIGNUP_CONFIG || {};
  var API = String(cfg.signupApi || '').replace(/\/$/, '');
  var page = doc.body.getAttribute('data-page');
  var money = function (c) { return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var $ = function (id) { return doc.getElementById(id); };
  var say = function (el, text, kind) { el.textContent = text || ''; el.style.color = kind === 'error' ? '#b42318' : kind === 'ok' ? '#1d7a3a' : ''; };
  function call(method, path, body, token) {
    var h = { Accept: 'application/json' };
    if (body) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    return win.fetch(API + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (j) { j._status = r.status; return j; }); });
  }
  var OFF = 'This isn’t switched on yet. Please email storageownerseoguy@gmail.com and Scott will send it to you.';

  if (page === 'copy') {
    var form = $('copy-form'), status = $('copy-status'), btn = $('copy-btn');
    var q = new win.URLSearchParams(win.location.search);
    if (q.get('ref')) $('copy_ref').value = q.get('ref');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!API) { say(status, OFF, 'error'); return; }
      var email = $('copy_email').value.trim(), ref = $('copy_ref').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say(status, 'Enter the email address you signed with.', 'error'); return; }
      btn.disabled = true; say(status, 'Sending…');
      call('POST', '/api/records/copy', { email: email, ref: ref || undefined }).then(function (r) {
        btn.disabled = false;
        say(status, r.ok ? r.message : (r.error || 'Something went wrong. Please try again.'), r.ok ? 'ok' : 'error');
      }).catch(function () { btn.disabled = false; say(status, 'We couldn’t reach the service. Check your connection and try again.', 'error'); });
    });
  }

  // open Stripe's hosted billing portal with a private token (launch link or emailed billing link)
  function openPortal(ref, tok, statusEl) {
    say(statusEl, 'Opening Stripe’s secure billing page…');
    return call('POST', '/api/billing/portal', { ref: ref }, tok).then(function (r) {
      if (r.ok && r.url) { win.location.href = r.url; return true; }
      say(statusEl, r.error || 'We couldn’t open the billing page. Request a new link below.', 'error'); return false;
    }).catch(function () { say(statusEl, 'We couldn’t reach the service. Try again.', 'error'); return false; });
  }

  if (page === 'billing') {
    var bq = new win.URLSearchParams(win.location.search), bStatus = $('billing-status');
    var bref = bq.get('ref') || '';
    var btok = (/[#&]t=([A-Za-z0-9_-]{40,})/.exec(win.location.hash) || [])[1];
    if (win.location.hash && win.history.replaceState) win.history.replaceState(null, '', win.location.pathname + win.location.search);
    if (bq.get('done') === '1') $('billing-done').hidden = false;
    if (API && bref && btok) { $('billing-open').hidden = false; openPortal(bref, btok, bStatus).then(function (ok) { if (!ok) $('billing-open').hidden = true; }); }
    $('billing-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!API) { say(bStatus, OFF, 'error'); return; }
      var email = $('billing_email').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say(bStatus, 'Enter the email address you signed up with.', 'error'); return; }
      var b = $('billing-btn'); b.disabled = true; say(bStatus, 'Sending…');
      call('POST', '/api/billing/link', { email: email }).then(function (r) {
        b.disabled = false; say(bStatus, r.ok ? r.message : (r.error || 'Something went wrong. Please try again.'), r.ok ? 'ok' : 'error');
      }).catch(function () { b.disabled = false; say(bStatus, 'We couldn’t reach the service. Check your connection and try again.', 'error'); });
    });
  }

  if (page === 'monthly') {
    var p = new win.URLSearchParams(win.location.search);
    var ref = p.get('ref') || '';
    var mStatus = $('monthly-status');
    var show = function (id) { ['monthly-loading', 'monthly-ready', 'monthly-done'].forEach(function (x) { $(x).hidden = x !== id; }); };
    // the private token arrives in the #fragment (never sent to any server in a URL); keep it for this tab only
    var tok = (/[#&]t=([A-Za-z0-9_-]{40,})/.exec(win.location.hash) || [])[1];
    try { if (tok) win.sessionStorage.setItem('sosg_monthly_' + ref, tok); else tok = win.sessionStorage.getItem('sosg_monthly_' + ref); } catch (e) { /* private mode */ }
    if (win.location.hash && win.history.replaceState) win.history.replaceState(null, '', win.location.pathname + win.location.search);
    // works in every state, including right after returning from Stripe (?done=1)
    var mb = $('manage-billing');
    if (mb) mb.addEventListener('click', function () { if (tok) openPortal(ref, tok, mStatus); else win.location.href = '/signup/billing/'; });
    if (p.get('done') === '1') {
      // back from Stripe: show "set up" only once the Worker has Stripe's confirmation
      if (!API || !tok) { show(null); say(mStatus, 'Payment submitted. Stripe emails your receipt; your plan shows as active once Stripe confirms it.', 'ok'); return; }
      show(null); say(mStatus, 'Confirming with Stripe…');
      var tries = 0;
      (function poll() {
        call('GET', '/api/monthly/status?ref=' + encodeURIComponent(ref), null, tok).then(function (r) {
          if (r.ok && r.active) { say(mStatus, ''); show('monthly-done'); return; }
          if (r.ok && r.processing) { say(mStatus, 'Your bank payment is processing (this can take a few days). Nothing else to do — Stripe emails you when it clears.', 'ok'); return; }
          if (++tries < 12) { win.setTimeout(poll, 2500); return; }
          say(mStatus, 'Payment submitted. It can take a minute to confirm — reload this page shortly, or check the receipt email from Stripe.', 'ok');
        }).catch(function () { if (++tries < 12) win.setTimeout(poll, 2500); });
      })();
      return;
    }
    if (!API) { show(null); say(mStatus, OFF, 'error'); return; }
    if (!tok || !ref) { show(null); say(mStatus, 'Open this page from the link in your launch email.', 'error'); return; }
    var state = null;
    call('GET', '/api/monthly/status?ref=' + encodeURIComponent(ref), null, tok).then(function (r) {
      if (!r.ok) { show(null); say(mStatus, r.error || 'This link isn’t valid.', 'error'); return; }
      state = r;
      if (r.active || r.hasSubscription) {
        show('monthly-done');
        var note = { cancel_scheduled: 'Cancellation is scheduled: your plan ends at the end of this billing month.', past_due: 'Your last monthly payment didn’t go through. Update your card below — Stripe retries automatically.', canceled: 'This monthly plan was cancelled. To restart it, email storageownerseoguy@gmail.com.' }[r.status];
        if (note) { $('monthly-done-line').textContent = note; $('monthly-done-line').style.color = r.status === 'cancel_scheduled' ? '' : '#b42318'; }
        return;
      }
      if (r.processing) { show(null); say(mStatus, 'Your bank payment is processing. Nothing else to do — Stripe emails you when it clears.', 'ok'); return; }
      $('m-facility').textContent = r.facilityName;
      $('m-site').textContent = r.siteUrl ? ' at ' + r.siteUrl : '';
      $('m-plan').textContent = r.planName + (r.facilities > 1 ? ' × ' + r.facilities + ' facilities' : '');
      $('m-unit').textContent = money(r.monthlyUnitCents) + '/month' + (r.facilities > 1 ? ' each' : '');
      $('m-total').textContent = money(r.monthlyCents) + '/month';
      $('m-approval').textContent = r.approvalText;
      $('m-agreement').textContent = r.agreementId;
      show('monthly-ready');
    }).catch(function () { show(null); say(mStatus, 'We couldn’t reach the service. Try again.', 'error'); });
    var cb = $('monthly_approved'), go = $('monthly-btn');
    cb.addEventListener('change', function () { go.disabled = !cb.checked; });
    go.addEventListener('click', function () {
      if (!state || !cb.checked) return;
      go.disabled = true; say(mStatus, 'Opening secure payment…');
      call('POST', '/api/monthly/checkout', { ref: ref, approve: true, approvedMonthlyCents: state.monthlyCents }, tok).then(function (r) {
        if (r.ok && r.url) { win.location.href = r.url; return; }
        go.disabled = false; say(mStatus, r.error || 'We couldn’t open secure payment. Try again.', 'error');
      }).catch(function () { go.disabled = false; say(mStatus, 'We couldn’t reach the service. Try again.', 'error'); });
    });
  }
})(window, document);
