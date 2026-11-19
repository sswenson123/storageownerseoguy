// MOCKED outside services for local testing (no accounts, no keys, nothing sent or charged):
//  - Resend  POST /emails                         (email codes + signed-copy attachments land in S.inbox)
//  - Stripe  GET /v1/promotion_codes, POST /v1/checkout/sessions, /pay/:id stand-in checkout page,
//            webhooks signed exactly like Stripe ("t=..,v1=HMAC(secret, t.payload)").
// The Worker, D1 and R2 are NOT mocked: they run in Cloudflare's own local runtime (workerd/Miniflare).
import http from 'node:http';
import crypto from 'node:crypto';

export function startMocks({ port, workerUrl, resendKey, stripeKey, stripeSecret }) {
  const S = { inbox: [], sessions: {}, calls: [], opts: { resendFail: false, sendStripeWebhook: true, stripeAmountOffset: 0 } };
  const base = `http://127.0.0.1:${port}`;
  const PROMOS = {
    WELCOME50: { id: 'promo_w50', code: 'WELCOME50', active: true, coupon: { id: 'co_w50', amount_off: 5000, currency: 'usd', valid: true, applies_to: { products: ['prod_build'] } }, times_redeemed: 0 },
    FRIEND25: { id: 'promo_f25', code: 'FRIEND25', active: true, coupon: { id: 'co_f25', percent_off: 25, valid: true, applies_to: { products: ['prod_build'] } }, times_redeemed: 0 },
    FREEBUILD: { id: 'promo_free', code: 'FREEBUILD', active: true, coupon: { id: 'co_free', percent_off: 100, valid: true, applies_to: { products: ['prod_build'] } }, times_redeemed: 0 },
    OLDCODE50: { id: 'promo_old', code: 'OLDCODE50', active: true, expires_at: Math.floor(Date.now() / 1000) - 3600, coupon: { id: 'co_w50', amount_off: 5000, currency: 'usd', valid: true, applies_to: { products: ['prod_build'] } }, times_redeemed: 0 },
    ONEUSE50: { id: 'promo_one', code: 'ONEUSE50', active: true, max_redemptions: 1, times_redeemed: 1, coupon: { id: 'co_w50', amount_off: 5000, currency: 'usd', valid: true, applies_to: { products: ['prod_build'] } } },
    MONTHLY20: { id: 'promo_m20', code: 'MONTHLY20', active: true, coupon: { id: 'co_m20', percent_off: 20, valid: true, applies_to: { products: ['prod_maintain'] } }, times_redeemed: 0 }
  };
  const hmac = (k, m) => crypto.createHmac('sha256', k).update(m).digest('hex');
  const readBody = (req) => new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(d)); });
  const send = (res, status, body, type) => { res.writeHead(status, { 'Content-Type': type || 'application/json' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

  async function stripeWebhook(type, obj, secret, eventId) {
    const payload = JSON.stringify({ id: eventId || 'evt_' + crypto.randomBytes(6).toString('hex'), type, data: { object: obj } });
    const t = Math.floor(Date.now() / 1000);
    return fetch(workerUrl + '/api/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${hmac(secret || stripeSecret, t + '.' + payload)}` }, body: payload });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const p = url.pathname;
    const raw = await readBody(req);
    try {
      // ---------- Resend ----------
      if (req.method === 'POST' && p === '/emails') {
        if (req.headers.authorization !== 'Bearer ' + resendKey) return send(res, 401, { message: 'invalid key' });
        if (S.opts.resendFail) return send(res, 500, { message: 'mock outage' });
        const m = JSON.parse(raw);
        S.inbox.push({ ...m, at: Date.now() });
        return send(res, 200, { id: 'em_' + crypto.randomBytes(4).toString('hex') });
      }
      // ---------- Stripe API ----------
      if (p.startsWith('/v1/')) {
        let mm;
        if (req.headers.authorization !== 'Bearer ' + stripeKey) return send(res, 401, { error: { message: 'Invalid API Key' } });
        if (req.method === 'GET' && p === '/v1/promotion_codes') {
          const pc = PROMOS[url.searchParams.get('code')];
          return send(res, 200, { object: 'list', data: pc && pc.active ? [pc] : [] });
        }
        if (req.method === 'POST' && p === '/v1/checkout/sessions') {
          const f = new URLSearchParams(raw);
          const g = (k) => f.get(k);
          S.calls.push({ stripe: 'create_session', params: Object.fromEntries(f) });
          const qty = parseInt(g('line_items[0][quantity]'), 10);
          let unit;
          const CATALOG = { price_build: 19900, price_maintain: 5900, price_improve: 9900 };
          if (CATALOG[g('line_items[0][price]')]) unit = CATALOG[g('line_items[0][price]')];
          else if (g('line_items[0][price_data][unit_amount]')) unit = parseInt(g('line_items[0][price_data][unit_amount]'), 10);
          else return send(res, 400, { error: { message: 'No such price', param: 'line_items[0][price]' } });
          const sub = unit * qty;
          let disc = 0;
          const promoId = g('discounts[0][promotion_code]');
          if (promoId) {
            const pc = Object.values(PROMOS).find((x) => x.id === promoId);
            disc = pc.coupon.percent_off ? Math.round(sub * pc.coupon.percent_off / 100) : Math.min(pc.coupon.amount_off, sub);
          }
          const id = 'cs_test_' + crypto.randomBytes(8).toString('hex');
          const md = {}; for (const [k, v] of f) { const mm = /^metadata\[(\w+)\]$/.exec(k); if (mm) md[mm[1]] = v; }
          const sess = { id, object: 'checkout.session', url: `${base}/pay/${id}`, amount_subtotal: sub, amount_total: sub - disc + S.opts.stripeAmountOffset, currency: 'usd',
            client_reference_id: g('client_reference_id'), customer_email: g('customer_email'), customer: g('customer') || null, metadata: md, payment_status: 'unpaid', status: 'open', success_url: g('success_url'), mode: g('mode') };
          S.sessions[id] = sess;
          return send(res, 200, sess);
        }
        if (req.method === 'GET' && (mm = /^\/v1\/checkout\/sessions\/(cs_test_\w+)$/.exec(p))) { const x = S.sessions[mm[1]]; return x ? send(res, 200, x) : send(res, 404, { error: { message: 'No such session' } }); }
        if (req.method === 'POST' && (mm = /^\/v1\/checkout\/sessions\/(cs_test_\w+)\/expire$/.exec(p))) {
          const x = S.sessions[mm[1]]; S.calls.push({ stripe: 'expire_session', id: mm[1] });
          if (!x || x.status !== 'open') return send(res, 400, { error: { message: 'Only Checkout Sessions with a status in [open] can be expired.' } });
          x.status = 'expired'; return send(res, 200, x);
        }
        if (req.method === 'GET' && (mm = /^\/v1\/(prices|products|billing_portal\/configurations)\/([\w-]+)$/.exec(p))) {
          const CAT = { price_build: 19900, price_maintain: 5900, price_improve: 9900 };
          if (mm[1] === 'prices') return CAT[mm[2]] ? send(res, 200, { id: mm[2], object: 'price', livemode: false, active: true, unit_amount: CAT[mm[2]], product: mm[2].replace('price_', 'prod_') }) : send(res, 404, { error: { message: 'No such price' } });
          return send(res, 200, { id: mm[2], livemode: false, active: true });
        }
        if (req.method === 'POST' && p === '/v1/billing_portal/sessions') {
          const f = new URLSearchParams(raw);
          S.calls.push({ stripe: 'portal_session', params: Object.fromEntries(f) });
          if (!/^cus_/.test(f.get('customer') || '')) return send(res, 400, { error: { message: 'No such customer' } });
          const id = 'bps_' + crypto.randomBytes(6).toString('hex');
          return send(res, 200, { id, object: 'billing_portal.session', customer: f.get('customer'), url: `${base}/portal/${id}`, return_url: f.get('return_url') });
        }
        return send(res, 404, { error: { message: 'not found' } });
      }
      // ---------- stand-in Stripe Checkout page ----------
      let m;
      if (req.method === 'GET' && (m = /^\/pay\/(cs_test_\w+)$/.exec(p))) {
        const s = S.sessions[m[1]];
        return send(res, 200, `<!doctype html><title>Stripe Checkout (mock)</title><h1>Pay</h1><p id="amount">$${(s.amount_total / 100).toFixed(2)}</p><p id="email">${s.customer_email}</p><form method="post" action="/pay/${s.id}/complete"><button id="pay">Pay</button></form>`, 'text/html');
      }
      if (req.method === 'POST' && (m = /^\/pay\/(cs_test_\w+)\/complete$/.exec(p))) {
        const s = S.sessions[m[1]];
        if (s.status !== 'open') return send(res, 400, 'This Checkout Session is no longer active.', 'text/plain');
        s.status = 'complete'; s.payment_status = 'paid'; s.customer_details = { email: s.customer_email };
        if (!s.customer) s.customer = 'cus_' + crypto.randomBytes(5).toString('hex');
        if (s.mode === 'subscription') s.subscription = 'sub_' + crypto.randomBytes(6).toString('hex');
        else { s.payment_intent = 'pi_' + crypto.randomBytes(6).toString('hex'); s.invoice = 'in_' + crypto.randomBytes(6).toString('hex'); }
        if (S.opts.sendStripeWebhook) await stripeWebhook('checkout.session.completed', s);
        res.writeHead(303, { Location: s.success_url }); return res.end();
      }
      send(res, 404, 'not found', 'text/plain');
    } catch (e) { send(res, 500, { error: String(e && e.stack || e) }); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ S, base, server, PROMOS, stripeWebhook })));
}
