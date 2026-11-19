#!/usr/bin/env node
// Builds the unsigned, downloadable/printable agreement PDF from the SAME frozen agreement module and
// PDF writer the signup Worker uses, so the download and the signed copy carry identical text.
//   node _tools/build-agreement-module.js && node _tools/build-agreement-pdf.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGREEMENT } from '../_worker/src/agreement.generated.js';
import { layout, writePdf } from '../_worker/src/pdf.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const blocks = [...AGREEMENT.blocks, { type: 'small', runs: [{ b: false, t: `Unsigned copy for reading and printing. Agreement version ${AGREEMENT.version}, SHA-256 ${AGREEMENT.sha256}. To sign, use the signup page at storageownerseoguy.com/signup.` }] }];
const pdf = writePdf(layout(blocks, `Services Agreement v${AGREEMENT.version} · unsigned copy`), { title: `Services Agreement v${AGREEMENT.version}`, subject: 'Unsigned copy', createdIso: '2026-10-24T00:00:00.000Z' });
const out = path.join(ROOT, 'downloads', 'agreements', `SOSG-Services-Agreement-${AGREEMENT.version}.pdf`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, pdf);
console.log(out, pdf.length + ' bytes');
