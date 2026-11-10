// Unit tests for web/js/rxja-fmmap.js (RxJa Tools FM station editor).
// Run: node tools/fmedit-test/unit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../../web/js/rxja-fmmap.js';
import * as J from '../../web/js/rxja-sjis.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const off = a => a - F.HDR_BASE;
const u16 = (img, a) => img[off(a)] | (img[off(a) + 1] << 8);

test('parseMHz10 / formatMHz10', () => {
  assert.equal(F.parseMHz10('80.1'), 801);
  assert.equal(F.parseMHz10('80.10'), 801);
  assert.equal(F.parseMHz10(' 76.5 MHz'), 765);
  assert.equal(F.parseMHz10('１０８．０'), 1080);
  assert.equal(F.parseMHz10('93'), 930);
  assert.equal(F.parseMHz10('80.15'), null);     // not on the 0.1 MHz grid
  assert.equal(F.parseMHz10('abc'), null);
  assert.equal(F.formatMHz10(801), '80.1');
  assert.equal(F.formatMHz10(F.EMPTY), '');
});

test('validFreq is the BK1080 range 64.0-108.0', () => {
  assert.ok(F.validFreq(640) && F.validFreq(1080) && F.validFreq(881));
  assert.ok(!F.validFreq(639) && !F.validFreq(1081) && !F.validFreq(F.EMPTY) && !F.validFreq(0));
});

test('regions: multiples of 8, inside their own 4 KB sector', () => {
  for (const r of F.REGIONS) {
    assert.equal(r.addr % 8, 0, r.name);
    assert.equal(r.addr >> 12, (r.addr + r.size - 1) >> 12, r.name);
  }
  assert.notEqual(F.FREQ_BASE >> 12, F.NAME_BASE >> 12);  // names in a sector of their own
});

test('empty image decodes to no stations, and has no header', () => {
  const img = F.newImage();
  assert.deepEqual(F.decodeAll(img), []);
  assert.ok(!F.hasMagic(img));
});

test('build -> decode round trip, header written', () => {
  const st = [
    { number: 0, freq: 765, name: 'FM COCOLO' },
    { number: 1, freq: 801, name: '' },
    { number: 33, freq: 881, name: 'NHK-FM大阪' },
    { number: 99, freq: 933, name: '朝日放送ラジオ' },
  ];
  const img = F.buildImage(F.newImage(), st);
  assert.ok(F.hasMagic(img));
  assert.equal(img[off(F.HDR_BASE)], 0x52);                    // 'R' first, little endian
  assert.equal(u16(img, F.HDR_BASE + 6), 0xFFFE);              // names-initialized flag, as the firmware writes
  assert.deepEqual(F.decodeAll(img), st);
  assert.equal(u16(img, F.FREQ_BASE + 2 * 2), F.EMPTY);        // FM02 untouched slot stays empty
});

test('names: 20 bytes = ten full-width characters, cut between characters', () => {
  const ten = 'アイウエオカキクケコ';          // 10 full-width = 20 bytes
  const img = F.buildImage(F.newImage(), [{ number: 5, freq: 900, name: ten + 'サ' }]);
  assert.equal(F.decodeAll(img)[0].name, ten);
  const twentyAscii = 'ABCDEFGHIJKLMNOPQRSTUV';
  const img2 = F.buildImage(F.newImage(), [{ number: 5, freq: 900, name: twentyAscii }]);
  assert.equal(F.decodeAll(img2)[0].name, twentyAscii.slice(0, 20));
});

test('a removed station clears its name too', () => {
  const a = F.buildImage(F.newImage(), [{ number: 3, freq: 851, name: 'エフエム大阪' }]);
  const b = F.buildImage(a, []);
  assert.equal(u16(b, F.FREQ_BASE + 3 * 2), F.EMPTY);
  const n = off(F.NAME_BASE + 3 * F.NAME_LEN);
  assert.ok(b.subarray(n, n + F.NAME_LEN).every(x => x === 0));
});

test('a name written by the radio-side clear (first byte 0) reads as no name', () => {
  const a = F.buildImage(F.newImage(), [{ number: 7, freq: 802, name: 'FM802' }]);
  a[off(F.NAME_BASE + 7 * F.NAME_LEN)] = 0x00;                // what FM_ClearName programs
  assert.equal(F.decodeAll(a)[0].name, '');
});

test('unchanged stations plan no writes; same name with other padding keeps bytes', () => {
  const st = [{ number: 0, freq: 765, name: 'FM COCOLO' }];
  const a = F.buildImage(F.newImage(), st);
  assert.deepEqual(F.planWrites(a, F.buildImage(a, st)), []);
  // 0xFF padding (never-written sector) instead of 0x00: same name, no rewrite
  const b = Uint8Array.from(a);
  const n = off(F.NAME_BASE);
  b.fill(0xFF, n + 9, n + F.NAME_LEN);
  assert.deepEqual(F.planWrites(b, F.buildImage(b, st)), []);
});

test('planWrites: 8-byte multiples, <= 128 bytes, no sector crossing, names -> freq -> header', () => {
  const from = F.newImage();
  const all = Array.from({ length: 100 }, (_, i) => ({ number: i, freq: 760 + i * 3, name: 'ステーション' + i }));
  const to = F.buildImage(from, all);
  const w = F.planWrites(from, to);
  assert.ok(w.length > 0);
  for (const x of w) {
    assert.equal(x.addr % 8, 0);
    assert.equal(x.data.length % 8, 0);
    assert.ok(x.data.length <= 128);
    assert.equal(x.addr >> 12, (x.addr + x.data.length - 1) >> 12);
  }
  const kind = a => (a >= F.NAME_BASE ? 'name' : a >= F.FREQ_BASE ? 'freq' : 'head');
  const order = w.map(x => kind(x.addr));
  assert.equal(order[order.length - 1], 'head');
  assert.ok(order.indexOf('freq') > order.lastIndexOf('name'));
  // applying the plan to `from` gives `to` on every written byte
  const got = Uint8Array.from(from);
  for (const x of w) got.set(x.data, off(x.addr));
  assert.deepEqual(F.decodeAll(got), F.decodeAll(to));
  assert.ok(F.hasMagic(got));
});

test('changing one frequency writes one 8-byte block', () => {
  const st = [{ number: 10, freq: 900, name: 'A' }];
  const a = F.buildImage(F.newImage(), st);
  const b = F.buildImage(a, [{ number: 10, freq: 901, name: 'A' }]);
  const w = F.planWrites(a, b);
  assert.equal(w.length, 1);
  assert.equal(w[0].addr, F.FREQ_BASE + 16);    // slot 10 = byte 20 of the table -> block at +16
  assert.equal(w[0].data.length, 8);
});

test('CSV rows', () => {
  assert.deepEqual(F.stationToRow({ number: 3, freq: 851, name: 'エフエム大阪' }), { No: '03', Frequency: '85.1', Name: 'エフエム大阪' });
  assert.deepEqual(F.rowToStation({ No: '03', Frequency: '85.1', Name: ' エフエム大阪 ' }).station, { number: 3, freq: 851, name: 'エフエム大阪' });
  assert.equal(F.rowToStation({ No: '1', Frequency: '200.0' }).problem, 'range');
  assert.equal(F.rowToStation({ No: '100', Frequency: '80.0' }).problem, 'number');
  assert.equal(F.rowToStation({ No: '', Frequency: '80.0' }, 7).station.number, 7);
});

const presetDoc = () => JSON.parse(readFileSync(new URL('../../web/presets/fm-jp.json', import.meta.url), 'utf8'));

test('preset: Osaka from web/presets/fm-jp.json', () => {
  const doc = presetDoc();
  assert.equal(doc.format, 'rxja-fm-presets');
  const p = F.presetStations(doc, 'JP27');
  assert.equal(p.length, 18);
  assert.ok(p.every(s => F.validFreq(s.freq)));
  assert.equal(new Set(p.map(s => s.freq)).size, p.length);
  assert.ok(p.some(s => s.freq === 881 && s.name === 'NHK-FM大阪'));
  assert.deepEqual(F.presetStations(doc, 'JP99'), []);
});

test('preset: all 47 prefectures are well formed', () => {
  const doc = presetDoc();
  const codes = Object.keys(doc.prefectures);
  assert.equal(codes.length, 47);
  assert.deepEqual(codes, Array.from({ length: 47 }, (_, i) => 'JP' + String(i + 1).padStart(2, '0')));
  for (const code of codes) {
    const pref = doc.prefectures[code];
    assert.ok(pref.name && pref.stations.length > 0, code);
    const list = F.presetStations(doc, code);
    // loading must not lose stations to the duplicate-frequency rule: the file has none
    assert.equal(list.length, pref.stations.length, `${pref.name}: repeated frequency in the file`);
    assert.ok(list.length <= F.COUNT, `${pref.name}: more than ${F.COUNT} stations`);
    for (const st of pref.stations) {
      const x10 = Math.round(st.mhz * 10);
      assert.ok(F.validFreq(x10) && Math.abs(st.mhz * 10 - x10) < 1e-6, `${pref.name} ${st.mhz}: not on the 0.1 MHz grid`);
      // the name must survive the radio's encoder unchanged (no characters the radio cannot show, <= 20 bytes)
      const e = J.encodeName(st.name, F.NAME_LEN);
      assert.equal(e.text, st.name, `${pref.name} ${st.mhz}: "${st.name}" would be cut or lose characters`);
      assert.ok(!e.bad.length && !e.cut);
    }
  }
});

test('preset: every prefecture has NHK-FM, and the file says what it leaves out', () => {
  const doc = presetDoc();
  for (const [code, pref] of Object.entries(doc.prefectures))
    assert.ok(pref.stations.some(s => s.kind === 'NHK-FM'), `${pref.name}: no NHK-FM`);
  assert.ok(doc.coverage && doc.coverage.excluded && doc.sources.length >= 3);
});

test('preset: loading several prefectures never exceeds 100 or repeats a number or frequency', () => {
  const doc = presetDoc();
  let st = [];
  for (const code of Object.keys(doc.prefectures)) st = F.mergePreset(st, F.presetStations(doc, code)).stations;
  assert.equal(st.length, F.COUNT);
  assert.equal(new Set(st.map(s => s.number)).size, F.COUNT);
  assert.equal(new Set(st.map(s => s.freq)).size, F.COUNT);
  assert.ok(st.every(s => s.number >= 0 && s.number < F.COUNT));
});

test('mergePreset keeps stored stations, fills free numbers, skips known frequencies', () => {
  const stored = [{ number: 1, freq: 801, name: '' }, { number: 33, freq: 881, name: '' }];
  const preset = [{ freq: 765, name: 'FM COCOLO' }, { freq: 881, name: 'NHK-FM大阪' }, { freq: 802, name: 'FM802' }];
  const r = F.mergePreset(stored, preset);
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 1);           // 88.1 already stored, its slot is not renamed
  assert.deepEqual(r.stations.map(s => [s.number, s.freq]), [[0, 765], [1, 801], [2, 802], [33, 881]]);
  // full table
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i, freq: 700 + i, name: '' }));
  assert.equal(F.mergePreset(full, [{ freq: 1000, name: 'x' }]).full, 1);
});

console.log(`${n} tests passed`);
