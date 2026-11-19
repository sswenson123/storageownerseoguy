#!/usr/bin/env node
/*
 * Private invitation links for custom quotes. Runs on YOUR computer only — the _tools folder
 * is not published (GitHub Pages/Jekyll skips folders starting with "_").
 *
 * Invitations are digitally signed. The signing key lives on your computer
 * (~/.sosg/invite-signing-key.pem) and never goes in the repo or on the website. The website
 * only has the matching public key, which can check a signature but cannot make one. Anyone who
 * edits an invitation link — price, plan, email, expiry — breaks the signature and gets refused.
 *
 * ONE-TIME SETUP (creates your key and puts the public half in js/signup-config.js):
 *   node _tools/make-invite.js --init-keys
 *   → back up ~/.sosg/invite-signing-key.pem somewhere safe (password manager). Lose it and you
 *     just run --init-keys --force again; old invitations stop working.
 *
 * Also copy the public key into the Worker (INVITE_PUBLIC_JWK in _worker/wrangler.toml) — the Worker
 * re-checks every invitation and charges the invitation price itself. No Stripe link is needed.
 *
 * MAKE AN INVITATION:
 *   node _tools/make-invite.js --for "Lakeside Storage" --setup 149 --maintain 49 \
 *        --email pat@example.com --exp 2026-11-30 --note "Founding-client rate"
 *   Send the printed link to that client only. Every invitation is logged to ~/.sosg/invites-log.csv
 *   — that log is your record of what you actually offered. The client must sign the agreement and
 *   approve the exact amounts before the Worker opens a payment page; with --email, only that email
 *   address can use the offer.
 *
 * Options: --for (required) --setup (required) --maintain --improve --facilities --email
 *          --exp YYYY-MM-DD --note --id --site --key <path to signing key>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Signup = require(path.join(__dirname, '..', 'js', 'signup.js'));
const CONFIG_PATH = path.join(__dirname, '..', 'js', 'signup-config.js');
const DEFAULT_DIR = path.join(os.homedir(), '.sosg');
const DEFAULT_KEY = path.join(DEFAULT_DIR, 'invite-signing-key.pem');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true; else { out[k] = v; i++; }
  }
  return out;
}

function publicJwkFromPrivatePem(pem) {
  const jwk = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ format: 'jwk' });
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

function initKeys({ keyPath = DEFAULT_KEY, force = false, configPath = CONFIG_PATH } = {}) {
  if (fs.existsSync(keyPath) && !force) throw new Error('A signing key already exists at ' + keyPath + ' (use --force to replace it; old invitations will stop working).');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const jwk = publicJwkFromPrivatePem(fs.readFileSync(keyPath, 'utf8'));
  let cfg = fs.readFileSync(configPath, 'utf8');
  const line = '    invitePublicKey: ' + JSON.stringify(jwk) + ',';
  if (!/^ {4}invitePublicKey: .*,$/m.test(cfg)) throw new Error('Could not find invitePublicKey in ' + configPath);
  cfg = cfg.replace(/^ {4}invitePublicKey: .*,$/m, line);
  fs.writeFileSync(configPath, cfg);
  const toml = path.join(path.dirname(configPath), '..', '_worker', 'wrangler.toml');
  if (fs.existsSync(toml)) {
    const t = fs.readFileSync(toml, 'utf8').replace(/^INVITE_PUBLIC_JWK = .*$/m, 'INVITE_PUBLIC_JWK = ' + JSON.stringify(JSON.stringify(jwk)));
    fs.writeFileSync(toml, t);
  }
  return { keyPath, jwk };
}

function sign(payload, keyPem) {
  return crypto.sign('sha256', Buffer.from(payload, 'utf8'), { key: keyPem, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

async function makeInvite(a, now = Date.now(), opts = {}) {
  if (!a.for || a.for === true) throw new Error('--for is required');
  if (a.setup === undefined || a.setup === true) throw new Error('--setup is required');
  const keyPem = opts.keyPem || fs.readFileSync(a.key || DEFAULT_KEY, 'utf8');
  const config = opts.config || require(CONFIG_PATH);
  const inv = {
    v: 1,
    id: a.id || (String(a.for).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) + '-' + new Date(now).toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex')),
    for: String(a.for),
    setup: Number(a.setup),
    plans: {}
  };
  if (a.maintain !== undefined) inv.plans.maintain = Number(a.maintain);
  if (a.improve !== undefined) inv.plans.improve = Number(a.improve);
  if (a.facilities !== undefined) inv.facilities = Number(a.facilities);
  if (a.email) inv.email = String(a.email).trim().toLowerCase();
  if (a.exp) inv.exp = a.exp;
  if (a.note) inv.note = a.note;

  const myPublic = publicJwkFromPrivatePem(keyPem);
  if (!config.invitePublicKey || config.invitePublicKey.x !== myPublic.x || config.invitePublicKey.y !== myPublic.y) {
    throw new Error('js/signup-config.js does not have the public key for this signing key. Run --init-keys (or check --key).');
  }
  const payload = Buffer.from(JSON.stringify(inv), 'utf8').toString('base64url');
  const token = payload + '.' + sign(payload, keyPem);
  const check = await Signup.verifyInvite(token, config, now);
  if (!check.ok) throw new Error('Invitation failed validation (' + check.reason + ') — check prices, dates, and email.');
  return { invite: inv, url: (a.site || 'https://storageownerseoguy.com') + '/signup/?invite=' + token };
}

function logInvite(inv, url, logPath = path.join(DEFAULT_DIR, 'invites-log.csv')) {
  const q = (v) => '"' + String(v === undefined ? '' : v).replace(/"/g, '""') + '"';
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, 'created,id,for,setup,maintain,improve,facilities,email,exp,url\n', { mode: 0o600 });
  fs.appendFileSync(logPath, [new Date().toISOString(), inv.id, inv.for, inv.setup, inv.plans.maintain, inv.plans.improve, inv.facilities, inv.email, inv.exp, url].map(q).join(',') + '\n');
  return logPath;
}

module.exports = { makeInvite, initKeys, sign, publicJwkFromPrivatePem, args };

if (require.main === module) {
  (async () => {
    const a = args(process.argv.slice(2));
    try {
      if (a['init-keys']) {
        const { keyPath } = initKeys({ keyPath: a.key || DEFAULT_KEY, force: !!a.force });
        console.log('\nSigning key created: ' + keyPath + '  (back it up; never put it in the repo)');
        console.log('Public key written to js/signup-config.js — commit that file.\n');
        return;
      }
      const { invite, url } = await makeInvite(a);
      const log = logInvite(invite, url);
      console.log('\nInvitation for ' + invite.for + ' (id ' + invite.id + '):\n\n' + url + '\n');
      console.log('Logged to ' + log + '. Send this link only to that client. Use --email so a forwarded link can’t be used by anyone else.');
    } catch (e) {
      console.error('Error: ' + e.message);
      process.exit(1);
    }
  })();
}
