// Unit tests for web/js/rxja-memmap.js and rxja-csv.js (RxJa memory channel editor).
// Run: node tools/memedit-test/unit.mjs [path/to/channels.csv]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../../web/js/rxja-memmap.js';
import * as C from '../../web/js/rxja-csv.js';
import * as J from '../../web/js/rxja-sjis.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

test('parseMHz', () => {
  assert.equal(M.parseMHz('145.5'), 145500000);
  assert.equal(M.parseMHz('26.968000'), 26968000);
  assert.equal(M.parseMHz('118.0250'), 118025000);
  assert.equal(M.parseMHz('1295'), 1295000000);
  assert.equal(M.parseMHz('abc'), null);
  assert.equal(M.parseMHz('145.0000001'), null);
});

test('bandOf matches frequencyBandTable', () => {
  assert.equal(M.bandOf(18000000), 0);
  assert.equal(M.bandOf(107999990), 0);
  assert.equal(M.bandOf(108000000), 1);
  assert.equal(M.bandOf(137000000), 2);
  assert.equal(M.bandOf(174000000), 3);
  assert.equal(M.bandOf(350000000), 4);
  assert.equal(M.bandOf(400000000), 5);
  assert.equal(M.bandOf(470000000), 6);
  assert.equal(M.bandOf(1300000000), 6);
});

test('encode -> decode keeps every field', () => {
  const image = M.newImage();
  const ch = {
    number: 7, name: 'ITM TWR', comment: '', freq: 118100000, offset: 600000, duplex: '-',
    rxTone: { mode: 'DTCS', value: 754, pol: 'R' }, txTone: { mode: 'Tone', value: 88.5, pol: 'N' },
    mode: 'NAM', step: 8.33, power: 6, scanlist: 25, compander: 2, rec: null,
  };
  M.encodeChannel(image, 6, ch);
  const back = M.decodeChannel(image, 6);
  for (const k of ['number', 'name', 'freq', 'offset', 'duplex', 'mode', 'step', 'power', 'scanlist', 'compander'])
    assert.deepEqual(back[k], ch[k], k);
  assert.deepEqual(back.rxTone, ch.rxTone);
  assert.deepEqual(back.txTone, ch.txTone);
  // new channel: TX lock / busy lockout / reverse / DTMF cleared, unused bits kept
  assert.equal(back.rec[12] & 0x61, 0);
  assert.equal(back.rec[13], 0xF0);
  assert.equal(image[M.ATTR_BASE + 12] & 7, 1);  // band 108-137
});

test('USB is stored with the narrow bit and reads back as USB', () => {
  const image = M.newImage();
  M.encodeChannel(image, 0, { number: 1, name: '', freq: 21150000, mode: 'USB', step: 1, power: 0, scanlist: 0, compander: 0, rxTone: {}, txTone: {} });
  assert.equal((image[12] >> 1) & 1, 1);
  assert.equal(M.decodeChannel(image, 0).mode, 'USB');
});

test('hidden bits survive a decode/encode round trip', () => {
  const image = M.newImage();
  M.encodeChannel(image, 3, { number: 4, name: 'A', freq: 145000000, mode: 'NFM', step: 12.5, power: 7, scanlist: 1, compander: 0, rxTone: {}, txTone: {} });
  image[3 * 16 + 12] |= 0x60;   // TX lock + busy lockout set on the radio
  image[3 * 16 + 13] = 0x0B;    // DTMF decode + PTT-ID
  image[3 * 16 + 15] = 0x00;
  const before = image.slice();
  const ch = M.decodeChannel(image, 3);
  M.encodeChannel(image, 3, ch);
  assert.deepEqual(image, before);
});

test('unchanged channels and list names write nothing (space-padded names kept)', () => {
  const image = M.newImage();
  M.encodeChannel(image, 0, { number: 1, name: 'AB', freq: 145000000, mode: 'NFM', step: 12.5, power: 0, scanlist: 0, compander: 0, rxTone: {}, txTone: {} });
  image.fill(0x20, M.NAME_BASE + 2, M.NAME_BASE + 10);   // padded like the radio's menu / CHIRP
  const snap = image.slice();
  const out = M.buildImage(snap, M.decodeAll(snap), M.decodeListNames(snap));
  assert.equal(M.planWrites(snap, out).length, 0);
  // a renamed channel rewrites its name block
  const chans = M.decodeAll(snap); chans[0].name = 'XY';
  assert.ok(M.planWrites(snap, M.buildImage(snap, chans, null)).some(w => w.addr === M.NAME_BASE));
});

test('delete marks the slot free like the firmware', () => {
  const image = M.newImage();
  M.encodeChannel(image, 0, { number: 1, name: 'X', freq: 145000000, mode: 'NFM', step: 12.5, power: 0, scanlist: 3, compander: 0, rxTone: {}, txTone: {} });
  M.encodeChannel(image, 0, null);
  assert.equal(M.decodeChannel(image, 0), null);
  assert.deepEqual([...image.subarray(M.ATTR_BASE, M.ATTR_BASE + 2)], [7, 0]);
  assert.ok(image.subarray(M.NAME_BASE, M.NAME_BASE + 16).every(b => b === 0));
});

test('names: Shift_JIS like the firmware reads them', () => {
  const image = M.newImage();
  image[M.ATTR_BASE] = 0; image.set([0x10, 0x27, 0, 0], 0);
  image.set([0x41, 0x42, 0x20, 0x20, 0x1F, 0x41], M.NAME_BASE);     // stops below 0x20, trims spaces
  assert.equal(M.decodeChannel(image, 0).name, 'AB');
  image.fill(0, M.NAME_BASE, M.NAME_BASE + 16);
  image.set([0x88, 0xC9, 0x92, 0x4F, 0xC0, 0xDC, 0xB0, 0xFF], M.NAME_BASE);   // 伊丹ﾀﾜｰ, 0xFF ends
  assert.equal(M.decodeChannel(image, 0).name, '伊丹ﾀﾜｰ');
  image.set([0x88, 0xC9, 0x88], M.NAME_BASE); image[M.NAME_BASE + 3] = 0;    // cut-off lead byte
  assert.equal(M.decodeChannel(image, 0).name, '伊' + J.GETA);
});

test('Shift_JIS encoding: bytes, limits, variants, unsupported characters', () => {
  const b = s => [...J.encodeName(s).bytes];
  assert.deepEqual(b('伊丹タワー'), [0x88, 0xC9, 0x92, 0x4F, 0x83, 0x5E, 0x83, 0x8F, 0x81, 0x5B]);
  assert.deepEqual(b('ｲﾀﾐ'), [0xB2, 0xC0, 0xD0]);
  assert.deepEqual(b('KIX ﾀﾜｰ'), [0x4B, 0x49, 0x58, 0x20, 0xC0, 0xDC, 0xB0]);
  let r = J.encodeName('関西アプローチ');               // 14 bytes: cut between characters
  assert.equal(r.text, '関西アプロ'); assert.equal(r.cut, true); assert.equal(r.bytes.length, 10);
  r = J.encodeName('関西APP1');                         // 4 + 4 = 8
  assert.equal(r.text, '関西APP1'); assert.equal(r.cut, false);
  r = J.encodeName('ABCDEFGHI伊');                      // 9 + 2 > 10: the kanji does not fit
  assert.equal(r.text, 'ABCDEFGHI'); assert.equal(r.cut, true);
  r = J.encodeName('①髙😀A');
  assert.deepEqual(r.bad, ['①', '髙', '😀']); assert.equal(r.text, 'A');
  assert.equal(J.encodeName('〜～').text, '〜〜');         // cp932 FF5E -> JIS 301C
  assert.deepEqual(b('～'), [0x81, 0x60]);
  assert.deepEqual(b('＼'), [0x81, 0x5F]);
  assert.equal(J.encodeName('AB  ').text, 'AB');
  assert.equal(M.cleanName('伊丹TWR long name'), '伊丹TWR lo');
  for (const s of ['伊丹タワー', 'ｶﾝｻｲｱﾌﾟﾛｰﾁ', 'MAR CH16', '¢£¬‖−', '漢字かなカナ'])
    assert.equal(J.decodeName(J.encodeName(s).bytes), J.encodeName(s).text);
});

test('every table character round-trips and matches what browsers decode', () => {
  let n = 0;
  const dec = new TextDecoder('shift_jis');
  for (let lead of [0x81, 0x82, 0x83, 0x84, ...Array.from({ length: 24 }, (_, i) => 0x88 + i), ...Array.from({ length: 11 }, (_, i) => 0xE0 + i)])
    for (let t = 0x40; t <= 0xFC; t++) {
      if (t === 0x7F) continue;
      const s = J.decodeName(Uint8Array.of(lead, t));
      if (s === J.GETA && !(lead === 0x81 && t === 0xAC)) continue;   // 0x81AC is 〓 itself
      n++;
      assert.deepEqual([...J.encodeName(s).bytes], [lead, t], `${lead.toString(16)}${t.toString(16)}`);
      const web = dec.decode(Uint8Array.of(lead, t));
      assert.equal(J.encodeName(web).text, s, `browser ${web} vs ${s}`);
    }
  assert.equal(n, 6879);
});

test('planWrites: only changed 8-byte blocks, <=128 B, no 4 KB crossing, attrs last', () => {
  const a = M.newImage(), b = a.slice();
  b[0x0FFF] = 0; b[0x1000] = 0;            // either side of a sector edge
  b.fill(0, 0x2000, 0x2000 + 300);         // long run
  b[M.NAME_BASE + 5] = 0x41;
  b[M.ATTR_BASE + 1] = 0;
  b[M.LIST_NAME_BASE] = 0x41;
  const w = M.planWrites(a, b);
  for (const x of w) {
    assert.equal(x.data.length % 8, 0);
    assert.ok(x.data.length <= 128);
    assert.equal(x.addr >> 12, (x.addr + x.data.length - 1) >> 12);
  }
  const out = a.slice();
  for (const x of w) out.set(x.data, x.addr);
  assert.deepEqual(out, b);
  assert.equal(w[0].addr, M.NAME_BASE);
  assert.equal(w[w.length - 1].addr, M.ATTR_BASE);
  assert.equal(M.planWrites(a, a.slice()).length, 0);
});

test('CSV parse: quotes, commas, newlines, CRLF', () => {
  const rows = C.parseCsv('a,b,c\r\n1,"x,y","he said ""hi"""\r\n2,"multi\nline",\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x,y', 'he said "hi"'], ['2', 'multi\nline', '']]);
  const back = C.parseCsv(C.writeCsv(['a', 'b', 'c'], [{ a: '1', b: 'x,y', c: 'he said "hi"' }]).slice(1));
  assert.deepEqual(back[1], ['1', 'x,y', 'he said "hi"']);
});

test('CSV decode: UTF-8 BOM and Shift_JIS', () => {
  const utf = new TextEncoder().encode('﻿Location,Name\r\n1,伊丹タワー\r\n');
  assert.equal(C.decodeText(utf).text.startsWith('Location'), true);
  // "伊丹" in Shift_JIS
  const sjis = new Uint8Array([0x31, 0x2C, 0x88, 0xC9, 0x92, 0x4F]);
  const d = C.decodeText(sjis);
  assert.equal(d.encoding, 'shift_jis');
  assert.equal(d.text, '1,伊丹');
});

test('CHIRP rows: tones round trip through Tone/TSQL/DTCS/Cross', () => {
  const cases = [
    [{ mode: '' }, { mode: '' }, ''],
    [{ mode: 'Tone', value: 88.5, pol: 'N' }, { mode: '' }, 'Tone'],
    [{ mode: 'Tone', value: 100, pol: 'N' }, { mode: 'Tone', value: 100, pol: 'N' }, 'TSQL'],
    [{ mode: 'DTCS', value: 23, pol: 'N' }, { mode: 'DTCS', value: 23, pol: 'R' }, 'DTCS'],
    [{ mode: '' }, { mode: 'Tone', value: 67, pol: 'N' }, 'Cross'],
    [{ mode: 'Tone', value: 67, pol: 'N' }, { mode: 'DTCS', value: 754, pol: 'R' }, 'Cross'],
  ];
  for (const [tx, rx, tmode] of cases) {
    const ch = { number: 1, name: 'T', freq: 433000000, offset: 0, duplex: '', mode: 'NFM', step: 12.5, power: 2, scanlist: 0,
      txTone: { value: null, pol: 'N', ...tx }, rxTone: { value: null, pol: 'N', ...rx } };
    const row = M.channelToRow(ch);
    assert.equal(row.Tone, tmode);
    const { ch: back } = M.rowToChannel(row);
    assert.equal(back.txTone.mode, ch.txTone.mode);
    assert.equal(back.rxTone.mode, ch.rxTone.mode);
    if (tx.mode) assert.equal(back.txTone.value, tx.value);
    if (rx.mode) assert.equal(back.rxTone.value, rx.value);
  }
});

test('NameJa column of older RxJa Tools CSVs', () => {
  let r = M.rowToChannel({ Location: '1', Frequency: '118.1', Name: '', NameJa: '伊丹タワー' });
  assert.equal(r.ch.name, '伊丹タワー'); assert.equal(r.ch.comment, '');
  r = M.rowToChannel({ Location: '1', Frequency: '118.1', Name: 'ITM TWR', NameJa: '伊丹タワー', Comment: '航空' });
  assert.equal(r.ch.name, 'ITM TWR'); assert.equal(r.ch.comment, '伊丹タワー / 航空');
  r = M.rowToChannel({ Location: '1', Frequency: '118.1', Name: '', NameJa: '関西アプローチ(伊丹)' });
  assert.equal(r.ch.name, '関西アプロ'); assert.equal(r.ch.comment, '関西アプローチ(伊丹)');
});

test('rowToChannel rejects what CHIRP would drop', () => {
  assert.equal(M.rowToChannel({ Location: '0', Frequency: '145.0' }).error, 'location');
  assert.equal(M.rowToChannel({ Location: '1', Frequency: '0' }).error, 'frequency');
  assert.equal(M.rowToChannel({ Location: '1', Frequency: '10.0' }).error, 'range');
  assert.equal(M.rowToChannel({ Location: '1', Frequency: '145.0', Mode: 'DMR' }).error, 'mode');
  let r = M.rowToChannel({ Location: '5', Frequency: '145.0', Name: '①伊丹ABC' });
  assert.equal(r.ch.name, '伊丹ABC');
  assert.equal(r.nameChanged, true);
  r = M.rowToChannel({ Location: '5', Frequency: '145.0', Name: '伊丹ABC' });
  assert.equal(r.nameChanged, false);
});

// Optional: a whole CSV through CSV -> image -> CSV
const file = process.argv[2];
if (file) test(`round trip ${file}`, () => {
  const { text } = C.decodeText(readFileSync(file));
  const { records, badLines } = C.readTable(text);
  assert.deepEqual(badLines, []);
  const chans = records.map(r => {
    const x = M.rowToChannel(r);
    assert.ok(x.ch, `line ${r.__line}: ${x.error} ${x.value}`);
    return x.ch;
  });
  const image = M.buildImage(M.newImage(), chans, []);
  const back = M.decodeAll(image);
  assert.equal(back.length, chans.length);
  back.forEach((b, i) => {
    const a = chans[i];
    b.comment = a.comment;
    const ra = M.channelToRow(a), rb = M.channelToRow(b);
    assert.deepEqual(rb, ra, `ch ${a.number}`);
  });
});

console.log(`${n} tests passed`);
