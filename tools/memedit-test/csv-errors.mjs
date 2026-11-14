// Tests for what the CSV importers report (web/js/rxja-csv.js, importRecords of
// rxja-memmap.js / rxja-fmmap.js). Run: node tools/memedit-test/csv-errors.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as C from '../../web/js/rxja-csv.js';
import * as M from '../../web/js/rxja-memmap.js';
import * as F from '../../web/js/rxja-fmmap.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const enc = s => new TextEncoder().encode(s);
const codes = list => list.map(p => `${p.line}:${p.code}`);

// the page's translator with the real locale files
const win = {};
for (const l of ['en', 'ja']) vm.runInNewContext(readFileSync(new URL(`../../web/locales/${l}.js`, import.meta.url), 'utf8'), { window: win });
const tr = lang => (key, ...values) => {
  let s = win.UVSTUDIO_LOCALES[lang][key] ?? key;
  values.forEach((v, i) => { s = s.split(`{${i}}`).join(String(v)); });
  return s;
};
const memLoad = bytes => C.loadTable(bytes, ['Location', 'Frequency'], [...M.CSV_COLUMNS, 'NameJa']);
const HDR = 'Location,Name,Frequency,Mode\r\n';

test('decodeText: empty / UTF-16 / binary / bad bytes', () => {
  assert.equal(C.decodeText(new Uint8Array()).problem.code, 'empty');
  assert.equal(C.decodeText(new Uint8Array([0xFF, 0xFE, 0x41, 0])).problem.code, 'utf16');
  assert.equal(C.decodeText(new Uint8Array([0xFE, 0xFF, 0, 0x41])).problem.code, 'utf16');
  assert.equal(C.decodeText(new Uint8Array([0x50, 0x4B, 3, 4, 0, 0])).problem.code, 'binary');
  assert.equal(C.decodeText(enc('Location\n1\n')).problem, null);
  // Shift_JIS "伊丹": fine; a stray 0xFF byte after a lead byte: not Shift_JIS either
  assert.equal(C.decodeText(new Uint8Array([0x88, 0xC9, 0x92, 0x4F])).problem, null);
  const bad = C.decodeText(new Uint8Array([...enc('a\nb\n'), 0x83, 0xFF, 0x0A]));
  assert.equal(bad.problem.code, 'encoding');
  assert.equal(bad.problem.line, 3);
});

test('loadTable: wrong kind of file', () => {
  assert.equal(memLoad(new Uint8Array()).problems[0].code, 'empty');
  assert.equal(memLoad(enc('Location\tFrequency\n1\t145\n')).problems[0].code, 'delimiter_tab');
  assert.equal(memLoad(enc('Location;Frequency\n1;145\n')).problems[0].code, 'delimiter_semicolon');
  assert.equal(memLoad(enc('a,b\n1,2\n')).problems[0].code, 'missing');
  assert.equal(memLoad(enc('Location,Frequency\n')).problems[0].code, 'no_rows');
  const miss = memLoad(enc('Location,Name\n1,A\n')).problems[0];
  assert.equal(miss.args[0], 'Frequency');
  assert.ok(!memLoad(enc('a,b\n')).ok);
});

test('loadTable: header names ignore letter case', () => {
  const r = memLoad(enc('location,NAME,frequency\n1,A,145.5\n'));
  assert.ok(r.ok);
  assert.deepEqual(r.header, ['Location', 'Name', 'Frequency']);
  assert.equal(M.importRecords(r.records).channels[0].freq, 145500000);
});

test('loadTable: wrong column count is reported with the line of the file', () => {
  const r = memLoad(enc(HDR + '1,A,145.5,FM\r\n\r\n2,B,145.6\r\n3,C,145.7,FM,extra\r\n4,D,145.8,FM\r\n'));
  assert.ok(r.ok);
  assert.deepEqual(codes(r.problems), ['4:columns', '5:columns']);
  assert.deepEqual(r.problems[0].args, [4, 3, 4]);       // line, columns in the row, columns in the header
  assert.deepEqual(r.records.map(x => x.__line), [2, 6]);
});

test('loadTable: a field with line breaks keeps the line numbers right', () => {
  const r = memLoad(enc(HDR + '1,"two\r\nlines",145.5,FM\r\n2,B\r\n'));
  assert.deepEqual(r.records.map(x => x.__line), [2]);
  assert.deepEqual(codes(r.problems), ['4:columns']);
});

test('loadTable: an unclosed quote is one problem, not a column count', () => {
  const r = memLoad(enc(HDR + '1,"open,145.5,FM\r\n2,B,145.6,FM\r\n'));
  assert.deepEqual(codes(r.problems), ['2:quote']);
});

test('loadTable: rows made only of commas (Excel) are ignored', () => {
  const r = memLoad(enc(HDR + '1,A,145.5,FM\r\n,,,\r\n,,,\r\n'));
  assert.ok(r.ok);
  assert.deepEqual(r.problems, []);
  assert.equal(r.records.length, 1);
});

test('memory rows: every bad value is reported with its line', () => {
  const r = memLoad(enc(HDR
    + '1,OK,145.5,FM\r\n'          // 2
    + '1,SAME,145.6,FM\r\n'        // 3 duplicate of line 2
    + '0,ZERO,145.7,FM\r\n'        // 4
    + '5000,BIG,145.7,FM\r\n'      // 5
    + '6,X,abc,FM\r\n'             // 6
    + '7,X,10.0,FM\r\n'            // 7 below 18 MHz
    + '8,X,145.0,DMR\r\n'));       // 8
  const m = M.importRecords(r.records);
  assert.equal(m.channels.length, 1);
  assert.deepEqual(codes(m.errors), ['3:dup', '4:location', '5:location', '6:frequency', '7:range', '8:mode']);
  assert.deepEqual(m.errors[0].args, [3, 1, 2]);          // line, number, line of the first row with it
  assert.deepEqual(m.errors[1].args, [4, '0']);
});

test('memory rows: changed values are warnings and the row is kept', () => {
  const rows = [
    { Location: '1', Frequency: '145.5', Name: '①ABC' },
    { Location: '2', Frequency: '145.5', Name: 'あいうえおかきくけこ' },
    { Location: '3', Frequency: '145.5', TStep: '7.77' },
    { Location: '4', Frequency: '145.5', TStep: 'abc' },
    { Location: '5', Frequency: '145.5', Power: 'High' },
    { Location: '6', Frequency: '145.5', ScanList: '99' },
    { Location: '7', Frequency: '145.5', Tone: 'XYZ' },
    { Location: '8', Frequency: '145.5', Name: 'OK', TStep: '12.50', Power: '5.0W', ScanList: 'ALL', Tone: 'TSQL' },
  ].map((r, i) => ({ ...r, __line: i + 2 }));
  const m = M.importRecords(rows);
  assert.equal(m.channels.length, 8);
  assert.deepEqual(codes(m.warnings), ['2:name_chars', '3:name_cut', '4:step', '5:step', '6:power', '7:scanlist', '8:tonemode']);
  assert.deepEqual(m.errors, []);
});

test('memory rows: tone outside the list is an error', () => {
  const m = M.importRecords([{ Location: '1', Frequency: '145.5', Tone: 'Tone', rToneFreq: '89.0', __line: 2 }]);
  assert.deepEqual(codes(m.errors), ['2:tone']);
});

test('FM rows: errors with lines', () => {
  const r = C.loadTable(enc('No,Frequency,Name\r\n'
    + '00,80.2,A\r\n'        // 2
    + '01,81.0,B\r\n'        // 3
    + '02,x,C\r\n'           // 4
    + '02,82.0,D\r\n'        // 5 (02 itself is fine: line 4 never became a station)
    + '03,81.0,E\r\n'        // 6 same frequency as line 3
    + '104,90.0,F\r\n'       // 7
    + ',95.1,G\r\n'          // 8 no number: first free one
    + '05,200.0,H\r\n'       // 9
    + '00,99.9,I\r\n'        // 10 number 00 again
    + 'FM06,91.5,①丸\r\n'    // 11
  ), ['Frequency'], [...F.CSV_COLUMNS, 'Location']);
  const f = F.importRecords(r.records);
  assert.deepEqual(codes(f.errors), ['4:fm_freq', '6:fm_dup_freq', '7:fm_number', '9:fm_range', '10:fm_dup_no']);
  // the row without a number takes the first number no row names: 03 is named by line 6 (left out
  // for its frequency, but still named), so it gets 04
  assert.deepEqual(f.stations.map(s => s.number), [0, 1, 2, 4, 6]);
  assert.equal(f.stations.find(s => s.number === 4).freq, 951);
  assert.equal(f.stations.find(s => s.number === 6).name, '丸');
  assert.deepEqual(codes(f.warnings), ['11:name_chars']);
});

test('FM rows: no free number left', () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ No: '', Frequency: (76 + i * 0.1).toFixed(1), Name: '', __line: i + 2 }));
  const f = F.importRecords(rows);
  assert.equal(f.stations.length, 100);
  assert.deepEqual(codes(f.errors), ['102:fm_full']);
});

test('FM: parseNo and rowToStation keep their old answers', () => {
  assert.equal(F.parseNo('05'), 5);
  assert.equal(F.parseNo(' FM07 '), 7);
  assert.equal(F.parseNo(''), '');
  assert.equal(F.parseNo('100'), null);
  assert.equal(F.parseNo('x'), null);
  assert.equal(F.rowToStation({ No: '100', Frequency: '80.0' }).problem, 'number');
  assert.equal(F.rowToStation({ No: '', Frequency: '80.0' }, 7).station.number, 7);
  assert.equal(F.rowToStation({ No: '', Frequency: '80.0' }).problem, 'full');
});

test('every problem code the code can raise has a message in both languages', () => {
  const used = ['empty', 'utf16', 'binary', 'encoding', 'delimiter_tab', 'delimiter_semicolon', 'missing', 'no_rows', 'quote',
    'columns', 'location', 'frequency', 'range', 'mode', 'tone', 'dup', 'fm_freq', 'fm_range', 'fm_number', 'fm_full',
    'fm_dup_no', 'fm_dup_freq', 'tonemode', 'step', 'name_chars', 'name_cut', 'power', 'scanlist', 'wrong_fm', 'wrong_mem'];
  for (const lang of ['ja', 'en']) {
    for (const code of used) assert.ok(win.UVSTUDIO_LOCALES[lang][`rxja_csv_${code}`], `${lang}: rxja_csv_${code}`);
    for (const k of ['blank', 'failed', 'skipped_note', 'head_errors', 'head_warnings', 'more', 'hint_columns'])
      assert.ok(win.UVSTUDIO_LOCALES[lang][`rxja_csv_${k}`], `${lang}: rxja_csv_${k}`);
  }
  // and the code that raises them is in the sources above (a typo would show up as an unknown key)
  const src = ['rxja-csv.js', 'rxja-memmap.js', 'rxja-fmmap.js', 'rxja-mem.js', 'rxja-fm.js']
    .map(f => readFileSync(new URL(`../../web/js/${f}`, import.meta.url), 'utf8')).join('\n');
  const raised = new Set([...src.matchAll(/(?:rowProb|prob)\(\s*'(\w+)'/g)].map(m => m[1]));
  for (const m of src.matchAll(/code: '(\w+)'/g)) raised.add(m[1]);
  for (const m of src.matchAll(/error: '(\w+)'/g)) raised.add(m[1]);
  for (const c of raised) assert.ok(used.includes(c), `raised but not checked above: ${c}`);
});

test('formatReport: errors, warnings, the column hint and the limit', () => {
  const t = tr('ja');
  const text = C.formatReport({
    errors: [C.rowProb('columns', 4, 3, 22), C.rowProb('dup', 9, 1, 2)],
    warnings: [C.rowProb('step', 5, '7.77')],
  }, t);
  assert.match(text, /^読み込めなかった行（2 件）:\n  4 行目: 列の数が合いません（この行は 3 列、見出しは 22 列）。/);
  assert.match(text, /読み込みましたが、内容を変えた行（1 件）:\n  5 行目: ステップ（TStep: 7.77）/);
  assert.match(text, /列の数が合わない行は/);
  const many = Array.from({ length: 130 }, (_, i) => C.rowProb('dup', i + 2, 1, 1));
  const out = C.formatReport({ errors: many }, t, { limit: 100 });
  assert.equal(out.split('\n').length, 1 + 100 + 1);
  assert.match(out, /…ほか 30 件$/);
  // a file that cannot be read at all: the reason only, no heading
  assert.equal(C.formatReport({ errors: [C.prob('empty')] }, t, { heading: false }), 'ファイルが空です（0 バイト）。');
  assert.equal(C.formatReport({ errors: [C.prob('empty')] }, tr('en'), { heading: false }), 'The file is empty (0 bytes).');
  // an empty cell is shown as (empty), not as nothing between the brackets
  assert.match(C.problemText(C.rowProb('frequency', 3, ''), t), /（（空））/);
});

test('the bundled preset reads without a single problem', () => {
  const r = memLoad(readFileSync(new URL('../../web/presets/jp-common.csv', import.meta.url)));
  assert.ok(r.ok);
  const m = M.importRecords(r.records);
  assert.deepEqual([...r.problems, ...m.errors, ...m.warnings], []);
  assert.equal(m.channels.length, 299);
});

console.log(`${n} tests passed`);
