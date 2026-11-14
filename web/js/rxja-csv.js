// RxJa Tools: CSV reading/writing for the memory channel and FM station editors.
// Added by the RxJa project; not part of UV Studio. No DOM: also used by the Node tests.
//
// Everything that can be wrong with a file is reported as a "problem":
//   { code, args, line }   code -> locale key rxja_csv_<code>, args = its {0}.. values,
//                          line = 1-based line of the file (0 = the file as a whole)
// so that the pages can list every cause instead of failing without a word.

export const prob = (code, args = [], line = 0) => ({ code, args, line });
export const rowProb = (code, line, ...args) => prob(code, [line, ...args], line);

// 1-based line number of text[index] (a line break is CRLF, CR or LF)
function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    const c = text[i];
    if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
  }
  return line;
}

// Bytes -> text. UTF-8 (with or without BOM) first; a file that is not valid
// UTF-8 is taken as Shift_JIS, which is what Excel on Japanese Windows saves
// as "CSV (comma delimited)".
//   -> { text, encoding, problem }   problem is null, or why the bytes are not usable text:
//      empty / utf16 (Excel "Unicode text") / binary (.xlsx etc.) / encoding (neither UTF-8 nor Shift_JIS)
export function decodeText(bytes) {
  if (!bytes.length) return { text: '', encoding: 'utf-8', problem: prob('empty') };
  const utf16 = (bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF);
  if (utf16) return { text: '', encoding: 'utf-16', problem: prob('utf16') };
  if (bytes.includes(0)) return { text: '', encoding: 'binary', problem: prob('binary') };
  try {
    return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8', problem: null };
  } catch (error) {
    const text = stripBom(new TextDecoder('shift_jis').decode(bytes));
    const bad = text.indexOf('�');
    const problem = bad < 0 ? null
      : prob('encoding', [lineOfIndex(text, bad), (text.match(/�/g) || []).length], lineOfIndex(text, bad));
    return { text, encoding: 'shift_jis', problem };
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks.
//   -> { rows, lines, unclosedQuote }
//      lines[i] = line of the file where rows[i] starts (blank lines are skipped, so it is not i + 1)
//      unclosedQuote = line where a quote was opened and never closed, else 0
function scan(text) {
  const rows = [], lines = [];
  let row = [], field = '', quoted = false, i = 0, line = 1, rowLine = 1, quoteLine = 0;
  const lineEnd = k => text[k] === '\n' || (text[k] === '\r' && text[k + 1] !== '\n');
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (lineEnd(i)) line++;
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; quoteLine = line; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); lines.push(rowLine); row = []; field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++; rowLine = line;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); lines.push(rowLine); }
  const keep = rows.map(r => r.length > 1 || r[0] !== '');
  return {
    rows: rows.filter((r, k) => keep[k]),
    lines: lines.filter((l, k) => keep[k]),
    unclosedQuote: quoted ? quoteLine : 0,
  };
}

export function parseCsv(text) {
  return scan(text).rows;
}

// Rows as objects keyed by the header line (o.__line = line of the file).
// Rows whose length differs from the header are left out and reported
// (CHIRP skips them as well); rows with nothing in them (Excel writes ",,,,"
// for empty rows) are ignored. columns: the names the editor knows; a header
// that differs from one only in letter case ("frequency") is read as that name.
//   -> { header, records, badLines: [line], badRows: [{ line, got }], unclosedQuote }
export function readTable(text, columns = []) {
  const { rows, lines, unclosedQuote } = scan(text);
  if (!rows.length) return { header: [], records: [], badLines: [], badRows: [], unclosedQuote };
  const known = new Map(columns.map(c => [c.toLowerCase(), c]));
  const header = rows[0].map(h => { const n = h.trim(); return known.get(n.toLowerCase()) ?? n; });
  const records = [], badLines = [], badRows = [];
  for (let k = 1; k < rows.length; k++) {
    const r = rows[k], line = lines[k];
    if (r.every(c => c.trim() === '')) continue;
    if (r.length !== header.length) { badLines.push(line); badRows.push({ line, got: r.length }); continue; }
    const o = {};
    header.forEach((h, n) => { o[h] = r[n]; });
    o.__line = line;
    records.push(o);
  }
  return { header, records, badLines, badRows, unclosedQuote };
}

// A whole file -> table, with everything wrong with it listed.
//   required: columns the file must have (else it is not this kind of CSV)
//   columns: every column name the editor knows (see readTable)
//   wrongKind: header -> problem code when the header is that of the other editor's CSV, else null
//   -> { ok, encoding, header, records, problems }
//      ok = false: nothing can be read from the file (problems says why);
//      ok = true : records are the usable rows, problems the lines that were left out
export function loadTable(bytes, required, columns = required, wrongKind = () => null) {
  const dec = decodeText(bytes);
  const fail = (...problems) => ({ ok: false, encoding: dec.encoding, header: [], records: [], problems });
  if (dec.problem) return fail(dec.problem);

  const table = readTable(dec.text, columns);
  if (!table.header.length) return fail(prob('empty'));
  const missing = required.filter(c => !table.header.includes(c));
  if (missing.length) {
    const kind = wrongKind(table.header);
    if (kind) return fail(prob(kind));
    if (table.header.length <= 1) {
      const first = dec.text.split(/\r\n|\r|\n/).find(l => l.trim() !== '') || '';
      if (first.includes('\t')) return fail(prob('delimiter_tab'));
      if (first.includes(';')) return fail(prob('delimiter_semicolon'));
    }
    const found = table.header.slice(0, 8).join(', ') + (table.header.length > 8 ? ', …' : '');
    return fail(prob('missing', [missing.join(', '), found]));
  }

  const problems = [];
  if (table.unclosedQuote) problems.push(prob('quote', [table.unclosedQuote], table.unclosedQuote));
  // the row that swallowed the rest of the file after an unclosed quote is that same problem, not a second one
  for (const b of table.badRows) {
    if (b.line === table.unclosedQuote) continue;
    problems.push(rowProb('columns', b.line, b.got, table.header.length));
  }
  if (!table.records.length && !problems.length) return fail(prob('no_rows'));
  return { ok: true, encoding: dec.encoding, header: table.header, records: table.records, problems };
}

// ---------- report ----------

export function problemText(p, t) {
  return t('rxja_csv_' + p.code, ...p.args.map(a => (a === '' ? t('rxja_csv_blank') : a)));
}

// Plain text for a <pre>: the problems that left rows out (errors), then the
// ones that only changed a row (warnings). `t` is the page's translator.
//   heading: false drops the "N rows" headings (for a file that could not be read at all)
export function formatReport({ errors = [], warnings = [] }, t, { heading = true, limit = 100 } = {}) {
  const block = (list, key) => {
    if (!list.length) return null;
    const pad = heading ? '  ' : '';
    const out = heading ? [t(key, list.length)] : [];
    for (const p of list.slice(0, limit)) out.push(pad + problemText(p, t));
    if (list.length > limit) out.push(pad + t('rxja_csv_more', list.length - limit));
    return out.join('\n');
  };
  const blocks = [block(errors, 'rxja_csv_head_errors'), block(warnings, 'rxja_csv_head_warnings')].filter(Boolean);
  if (errors.some(p => p.code === 'columns')) blocks.push(t('rxja_csv_hint_columns'));
  return blocks.join('\n\n');
}

// ---------- writing ----------

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
