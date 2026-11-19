// LOCAL PREVIEW — click through the whole signup on your own computer, nothing leaves it.
//   cd _worker && npm install && npm run preview      → open http://127.0.0.1:8765/signup/
//   npm run preview -- --worker https://sosg-signup.wi64storage.workers.dev   → same pages, REAL Worker
// Real: the Worker in Cloudflare's local runtime, local D1 + R2 (wiped when you stop it).
// Mocked: email (codes are printed in this terminal instead of sent) and Stripe (a fake "Pay" page).
import { Miniflare } from 'miniflare';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startMocks } from './mocks.mjs';

const REPO = path.resolve(process.argv[2] || '..');
// --worker https://sosg-signup.<you>.workers.dev : serve the site against your REAL deployed Worker instead
// (real email + Stripe test mode). Needs http://127.0.0.1:8765 in ALLOWED_ORIGINS (it is, during testing).
const REAL = (process.argv.indexOf('--worker') > 0 && process.argv[process.argv.indexOf('--worker') + 1]) || '';
// --lan : also reachable from a phone on the same Wi-Fi (http://<this Mac's address>:8765/signup/)
const LAN = process.argv.includes('--lan');
const W = path.join(REPO, '_worker');
const SITE_PORT = 8765, MOCK_PORT = 18870, WORKER_PORT = 18871;
const SITE = `http://127.0.0.1:${SITE_PORT}`, WORKER = `http://127.0.0.1:${WORKER_PORT}`;
let WORKER_URL = REAL.replace(/\/$/, '');
if (!REAL) {
const { AGREEMENT } = await import(path.join(W, 'src', 'agreement.generated.js'));
const KEYS = { resendKey: 're_preview', stripeKey: 'sk_test_preview', stripeSecret: 'whsec_preview' };
const M = await startMocks({ port: MOCK_PORT, workerUrl: WORKER, ...KEYS });
const push = M.S.inbox.push.bind(M.S.inbox);
M.S.inbox.push = (m) => { const c = /is (\d{6})/.exec(m.text || ''); console.log(c ? `\n📧  Code for ${m.to[0]}: ${c[1]}` : `\n📧  Sent to ${m.to[0]}: ${m.subject}${m.attachments ? ' (+ signed PDF attached)' : ''}`); return push(m); };

const modules = ['index.js', 'lib.js', 'pdf.js', 'fonts.generated.js', 'agreement.generated.js', 'agreement-pages.generated.js'].map((f) => ({ type: 'ESModule', path: path.join(W, 'src', f) }));
const mf = new Miniflare({ modules, modulesRoot: path.join(W, 'src'), compatibilityDate: '2024-09-23', d1Databases: ['DB'], r2Buckets: ['AGREEMENTS'], port: WORKER_PORT,
  bindings: { ALLOWED_ORIGINS: SITE, SITE_URL: SITE, AGREEMENT_VERSION: AGREEMENT.version, OTP_SECRET: crypto.randomBytes(32).toString('hex'), RESEND_API_KEY: KEYS.resendKey, RESEND_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, EMAIL_FROM: 'preview@example.test',
    STRIPE_API_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`, STRIPE_SECRET_KEY: KEYS.stripeKey, STRIPE_WEBHOOK_SECRET: KEYS.stripeSecret, STRIPE_PRODUCT_BUILD: 'prod_build', STRIPE_PRICE_BUILD: 'price_build', STRIPE_PRODUCT_MAINTAIN: 'prod_maintain', STRIPE_PRODUCT_IMPROVE: 'prod_improve', ALLOW_PROMO_CODES: 'true',
    BUILD_PRICE_CENTS: '19900', MAINTAIN_PRICE_CENTS: '5900', IMPROVE_PRICE_CENTS: '9900', MAX_FACILITIES: '7', INVITE_PUBLIC_JWK: '' } });
await mf.ready;
const db = await mf.getD1Database('DB');
const sql = fs.readdirSync(path.join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort().map((f) => fs.readFileSync(path.join(W, 'migrations', f), 'utf8')).join('\n');
let cur = [], trig = false;
for (const line of sql.split('\n')) {
  if (!cur.length && (/^\s*--/.test(line) || !line.trim())) continue;
  cur.push(line); if (/^CREATE TRIGGER/i.test(line)) trig = true;
  if (trig ? /^END;\s*$/.test(line) : /;\s*(--.*)?$/.test(line)) { await db.prepare(cur.join('\n')).run(); cur = []; trig = false; }
}

WORKER_URL = WORKER;
}
// static site, with signupApi pointed at the local Worker (only in this preview)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, SITE).pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(REPO, p);
  if (!file.startsWith(REPO) || p.split('/').some((s) => s.startsWith('_') || s.startsWith('.')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  let body = fs.readFileSync(file);
  if (p === '/js/signup-config.js') body = Buffer.from(body.toString().replace(/    signupApi: '[^']*',/, `    signupApi: '${WORKER_URL}',`));
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
}).listen(SITE_PORT, LAN ? '0.0.0.0' : '127.0.0.1');
if (LAN) {
  const os = await import('node:os');
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\nOn your phone (same Wi-Fi), open:  ${ips.map((ip) => `http://${ip}:${SITE_PORT}/signup/`).join('   or   ')}`);
}
console.log(REAL ? `\nSite running against your REAL Worker ${WORKER_URL} (real emails, Stripe TEST mode).\n  Open: ${SITE}/signup/  ·  Ctrl+C to stop.` : `\nLocal preview running (test data only — promo codes: WELCOME50, FRIEND25).\n  Open: ${SITE}/signup/\n  Email codes appear here. Press Ctrl+C to stop (all preview data is discarded).`);
