// RxJa Tools: CSV reading/writing for the memory channel editor. Added by the
// RxJa project; not part of UV Studio. No DOM: also used by the Node tests.

// Bytes -> text. UTF-8 (with or without BOM) first; a file that is not valid
// UTF-8 is taken as Shift_JIS, which is what Excel on Japanese Windows saves
// as "CSV (comma delimited)".
export function decodeText(bytes) {
  try {
    return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8' };
  } catch (error) {
    return { text: stripBom(new TextDecoder('shift_jis').decode(bytes)), encoding: 'shift_jis' };
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

// Rows as objects keyed by the header line. Rows whose length differs from
// the header are reported (CHIRP skips them as well).
export function readTable(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], records: [], badLines: [] };
  const header = rows[0].map(h => h.trim());
  const records = [], badLines = [];
  rows.slice(1).forEach((r, i) => {
    if (r.length !== header.length) { badLines.push(i + 2); return; }
    const o = {};
    header.forEach((h, k) => { o[h] = r[k]; });
    o.__line = i + 2;
    records.push(o);
  });
  return { header, records, badLines };
}

function quote(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// UTF-8 with BOM and CRLF: Excel opens it without mojibake and CHIRP reads it
// (utf-8-sig).
export function writeCsv(columns, records) {
  const lines = [columns.map(quote).join(',')];
  for (const r of records) lines.push(columns.map(c => quote(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
