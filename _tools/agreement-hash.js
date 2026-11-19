#!/usr/bin/env node
// After editing agreement.html: bump agreementVersion in js/signup-config.js, then run
//   npm run agreement-hash
// to record the new text's fingerprint. Signups store this fingerprint, so you can always
// prove which exact wording a customer accepted (git history keeps every version of agreement.html).
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'js', 'signup.js'));
const root = path.join(__dirname, '..');
const src = S.extractAgreementSource(fs.readFileSync(path.join(root, 'agreement.html'), 'utf8'));
if (!src) { console.error('Agreement markers not found in agreement.html'); process.exit(1); }
S.sha256Hex(src).then((h) => {
  const cfgPath = path.join(root, 'js', 'signup-config.js');
  const cfg = fs.readFileSync(cfgPath, 'utf8').replace(/agreementHash: '[0-9a-f]*'/, "agreementHash: '" + h + "'");
  fs.writeFileSync(cfgPath, cfg);
  console.log('agreementHash = ' + h);
});
