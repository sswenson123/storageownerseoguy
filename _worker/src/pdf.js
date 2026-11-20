// Minimal, dependency-free PDF writer for the signed agreement (text only, Helvetica, Letter).
// Deterministic: the same agreement + signing record always produce byte-identical PDFs, so a
// stored PDF can be re-created from the database and compared (reproducible signing record).
// Fast enough for the Workers Free plan CPU limit (no PDF library to parse or compress).
import { WIDTHS, UNICODE_TO_WINANSI } from './fonts.generated.js';

const PAGE_W = 612, PAGE_H = 792, MARGIN_X = 64, TOP = 728, BOTTOM = 72;
const MAX_W = PAGE_W - MARGIN_X * 2;

// code table: Unicode → WinAnsi byte (Latin-1 direct, plus the curly quotes/dashes/bullet WinAnsi has)
const CODE = new Uint8Array(65536).fill(63); // '?'
for (let i = 32; i < 127; i++) CODE[i] = i;
for (let i = 0xa1; i <= 0xff; i++) CODE[i] = i;
CODE[0xa0] = 32;
for (const [cp, c] of Object.entries(UNICODE_TO_WINANSI)) if (+cp < 65536) CODE[+cp] = c;
const WR = Float64Array.from(WIDTHS.regular, (x) => x || 556), WB = Float64Array.from(WIDTHS.bold, (x) => x || 556);
const ESC = [];
for (let c = 0; c < 256; c++) ESC[c] = c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c) : (c < 32 || c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c));

function width(text, bold, size) {
  const w = bold ? WB : WR;
  let t = 0;
  for (let i = 0; i < text.length; i++) t += w[CODE[text.charCodeAt(i)]];
  return (t * size) / 1000;
}
function pdfString(text) {
  let s = '(';
  for (let i = 0; i < text.length; i++) s += ESC[CODE[text.charCodeAt(i)]];
  return s + ')';
}

// Word-wrap runs [{b, t}] to lines of runs within maxWidth.
function wrap(runs, size, maxWidth) {
  const tokens = [];
  for (const r of runs) for (const part of r.t.split(/(\s+)/)) if (part) tokens.push({ b: !!r.b, t: /^\s+$/.test(part) ? ' ' : part });
  const lines = [];
  let line = [], w = 0;
  const push = () => {
    while (line.length && line[line.length - 1].t === ' ') line.pop();
    if (line.length) { // merge neighbouring tokens with the same weight into one text run
      const merged = [];
      for (const t of line) { const last = merged[merged.length - 1]; if (last && last.b === t.b) last.t += t.t; else merged.push({ b: t.b, t: t.t }); }
      lines.push(merged);
    }
    line = []; w = 0;
  };
  for (const tok of tokens) {
    if (tok.t === ' ' && line.length === 0) continue;
    let tw = width(tok.t, tok.b, size);
    if (w + tw > maxWidth && line.length) push();
    if (tok.t === ' ' && line.length === 0) continue;
    // a single word longer than the line (e.g. a hash): hard-break it
    while (tw > maxWidth) {
      let cut = tok.t.length;
      while (cut > 1 && width(tok.t.slice(0, cut), tok.b, size) > maxWidth) cut--;
      line.push({ b: tok.b, t: tok.t.slice(0, cut) }); push();
      tok.t = tok.t.slice(cut); tw = width(tok.t, tok.b, size);
    }
    line.push(tok); w += tw;
  }
  push();
  return lines;
}

const STYLE = {
  h1: { size: 16, lead: 20, before: 0, after: 6, gray: 0 },
  h2: { size: 14, lead: 18, before: 0, after: 8, gray: 0 },
  h3: { size: 11, lead: 14.5, before: 9, after: 3, gray: 0 },
  meta: { size: 8.5, lead: 11.5, before: 0, after: 8, gray: 0.35 },
  p: { size: 9.75, lead: 13.2, before: 0, after: 6, gray: 0 },
  li: { size: 9.75, lead: 13.2, before: 0, after: 3.5, gray: 0, indent: 14 },
  kv: { size: 9.5, lead: 12.8, before: 0, after: 2, gray: 0 },
  small: { size: 8, lead: 10.4, before: 0, after: 1.5, gray: 0.25 },
  mono: { size: 7.5, lead: 9.8, before: 0, after: 1, gray: 0.15 }
};

export function layout(blocks, footerText) {
  const pages = [];
  let ops = [], y = TOP;
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = TOP; };
  for (const blk of blocks) {
    if (blk.type === 'pagebreak') { newPage(); continue; }
    const st = STYLE[blk.type] || STYLE.p;
    const indent = st.indent || 0;
    const lines = wrap(blk.runs, st.size, MAX_W - indent);
    if (y - st.before - st.lead * Math.min(lines.length, 2) < BOTTOM) newPage(); // keep headings with text
    else y -= st.before;
    lines.forEach((ln, i) => {
      if (y - st.lead < BOTTOM) newPage();
      y -= st.lead;
      let x = MARGIN_X + indent;
      if (blk.type === 'li' && i === 0) ops.push({ x: MARGIN_X + 3, y, b: false, size: st.size, gray: st.gray, t: '•' });
      for (const r of ln) { ops.push({ x, y, b: r.b, size: st.size, gray: st.gray, t: r.t }); x += width(r.t, r.b, st.size); }
    });
    y -= st.after;
  }
  newPage();
  return pages.map((p, i) => ({ ops: p, footer: `${footerText} · page ${i + 1} of ${pages.length}` }));
}

function opsStream(ops) {
  let s = '';
  for (const o of ops) {
    const font = (o.b ? '/F2 ' : '/F1 ') + o.size + ' Tf';
    const col = o.gray.toFixed(2) + ' g';
    s += 'BT ' + col + ' ' + font + ' ' + o.x.toFixed(2) + ' ' + o.y.toFixed(2) + ' Td ' + pdfString(o.t) + ' Tj ET\n';
  }
  return s;
}
function contentStream(page) {
  let s = page.body !== undefined ? page.body : opsStream(page.ops);
  const fw = width(page.footer, false, 7.5);
  s += 'BT 0.40 g /F1 7.5 Tf ' + ((PAGE_W - fw) / 2).toFixed(2) + ' 40.00 Td ' + pdfString(page.footer) + ' Tj ET\n';
  return s;
}

function pdfDate(iso) {
  const d = iso.replace(/[-:]/g, '').replace('T', '').slice(0, 14);
  return 'D:' + d + 'Z';
}

// pages: from layout(); info: { title, subject, createdIso }
export function writePdf(pages, info) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const infoObj = add(`<< /Title ${pdfString(info.title)} /Subject ${pdfString(info.subject || '')} /Producer (SOSG signup Worker) /CreationDate (${pdfDate(info.createdIso)}) /ModDate (${pdfDate(info.createdIso)}) >>`);
  const kids = [];
  for (const p of pages) {
    const stream = contentStream(p);
    const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // the whole file is 7-bit ASCII (text is octal-escaped), so bytes = chars
}

const kv = (k, v) => ({ type: 'kv', runs: [{ b: true, t: k + ': ' }, { b: false, t: v }] });

// The agreement pages are the same for every signer (the agreement ends on a page break before the
// certificate), so their text layout is done once — at build time (_tools/build-agreement-pages.mjs →
// agreement-pages.generated.js) or on first use — and only the certificate is laid out per signature.
// Output is byte-identical to laying out the whole document in one pass (unit-tested).
export function agreementPageBodies(blocks) { return layout(blocks, '').map((p) => opsStream(p.ops)); }
const bodyCache = new Map();
function bodiesFor(agreement, pre) {
  if (pre && pre.sha256 === agreement.sha256 && pre.version === agreement.version && Array.isArray(pre.bodies)) return pre.bodies;
  let b = bodyCache.get(agreement.sha256);
  if (!b) { b = agreementPageBodies(agreement.blocks); bodyCache.set(agreement.sha256, b); }
  return b;
}

// The full signed document: the agreement exactly as frozen, then the signing certificate.
export function signedAgreementPdf(agreement, c, prebuiltPages) {
  const blocks = [];
  blocks.push({ type: 'h2', runs: [{ b: true, t: 'Signing Certificate' }] });
  blocks.push({ type: 'meta', runs: [{ b: false, t: 'This page is part of the signed Agreement. It was produced by the Provider’s own signup system at the moment of signing from the signing record below.' }] });
  for (const [k, v] of [
    ['Agreement', `Services Agreement, version ${c.agreement_version}`],
    ['Agreement SHA-256', c.agreement_sha256 + ' (fingerprint of the exact agreement text shown to the signer and printed above)'],
    ['Agreement ID', c.agreement_id],
    ['Signup reference', c.ref],
    ['Signed (UTC)', c.signed_at],
    ['Signer', `${c.signer_name}, ${c.signer_title}`],
    ['Electronic signature', `/s/ ${c.signer_name} — typed by the signer, adopted by clicking “Sign Agreement”`],
    ['Legal business name', c.legal_name],
    ['Facility', `${c.facility_name}, ${c.address}`],
    c.email_verified_at
      ? ['Verified email', `${c.email} (control confirmed by one-time code at ${c.email_verified_at}; not an ID check)`]
      : ['Email', `${c.email} (entered by the signer; the signed copy is emailed to this address; not an ID check)`],
    ['Signing device', `IP ${c.ip_masked} · ${c.user_agent_summary}`]
  ]) blocks.push(kv(k, v));
  blocks.push({ type: 'h3', runs: [{ b: true, t: 'Consents given by the signer (each a separate box, unchecked by default)' }] });
  for (const cs of c.consents) blocks.push({ type: 'li', runs: [{ b: true, t: `[X] ${cs.label}: ` }, { b: false, t: `“${cs.text}” — given ${cs.at}` }] });
  blocks.push({ type: 'li', runs: [{ b: true, t: 'Intent to sign: ' }, { b: false, t: `the signer typed “${c.signer_name}” and clicked “Sign Agreement” at ${c.signed_at}.` }] });
  blocks.push({ type: 'h3', runs: [{ b: true, t: 'Signing events (append-only audit trail, each entry chained by SHA-256)' }] });
  for (const e of c.audit) blocks.push({ type: 'mono', runs: [{ b: false, t: `#${e.n}  ${e.at}  ${e.event}${e.note ? ' — ' + e.note : ''}  [${e.hash.slice(0, 16)}]` }] });
  blocks.push(kv('Audit chain head', c.audit_head));
  blocks.push({ type: 'small', runs: [{ b: false, t: 'To check this document: the Agreement SHA-256 above must equal the fingerprint of the agreement text for this version, and the PDF’s own SHA-256 is kept with the signing record. Payment, if any, is recorded separately and is not part of this document.' }] });
  const footer = `Services Agreement v${c.agreement_version} · ${c.agreement_id}`;
  const bodies = bodiesFor(agreement, prebuiltPages);
  const cert = layout(blocks, footer);
  const total = bodies.length + cert.length;
  const pages = [...bodies.map((body) => ({ body })), ...cert.map((p) => ({ ops: p.ops }))].map((p, i) => ({ ...p, footer: `${footer} · page ${i + 1} of ${total}` }));
  return writePdf(pages, { title: `Signed Services Agreement ${c.agreement_id}`, subject: `Signup ${c.ref}`, createdIso: c.signed_at });
}

