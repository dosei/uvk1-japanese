// RxJa Tools: memory channel map of the F4HWN UV-K1 / UV-K5 V3 firmware.
// Added by the RxJa project; not part of UV Studio. No DOM: also used by the
// Node tests in tools/memedit-test.
//
// Layout (EEPROM-compatible addresses, App/driver/eeprom_compat.c):
//     0x0000 + n*16  channel record  (freq, offset, tones, mode, power, step)
//     0x4000 + n*16  channel name    (10 bytes Shift_JIS, rest 0; RxJa v1.1.0 shows Japanese)
//     0x8000 + n*2   attributes      (band:3 compander:2 .. exclude:1 | scanlist)
//     0x880E + n*4   scan list names (24 lists)
// Field meanings follow the armel CHIRP driver (f4hwn.chirp.v6.0.0.py) so a
// CSV written here reads the same in CHIRP; bits this editor does not show
// (TX lock, busy lockout, DTMF, unused) are kept from the existing bytes.

import { encodeName, decodeName as decodeSjisName } from './rxja-sjis.js';

export const CHANNELS = 1024;
export const LIST_COUNT = 24;
export const NAME_LEN = 10;
export const LIST_NAME_LEN = 3;          // the radio shows 3 of the 4 bytes

export const CHAN_BASE = 0x0000;
export const NAME_BASE = 0x4000;
export const ATTR_BASE = 0x8000;
export const LIST_NAME_BASE = 0x880E;
export const IMAGE_SIZE = 0x886E;        // everything up to the end of the list names

// Regions the editor may write, each a multiple of 8 bytes (0x051D writes 8 at a time)
export const REGIONS = [
  { name: 'chan', start: CHAN_BASE, size: CHANNELS * 16 },
  { name: 'name', start: NAME_BASE, size: CHANNELS * 16 },
  { name: 'attr', start: ATTR_BASE, size: CHANNELS * 2 },
  { name: 'list', start: LIST_NAME_BASE, size: LIST_COUNT * 4 },
];

export const MIN_HZ = 18000000;          // BX4819_band1_lower, App/frequencies.c
export const MAX_HZ = 1300000000;        // BX4819_band2_upper

// Lower edges of BAND1..BAND7 with ENABLE_WIDE_RX (frequencyBandTable, 10 Hz units)
const BAND_LOWER = [1800000, 10800000, 13700000, 17400000, 35000000, 40000000, 47000000];
export const BAND_EMPTY = 7;

// Index = value of the step byte (STEP_Setting_t)
export const STEPS = [2.5, 5, 6.25, 10, 12.5, 25, 8.33, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 1.25,
                      9, 15, 20, 30, 50, 100, 125, 200, 250, 500];

export const MODES = ['FM', 'NFM', 'AM', 'NAM', 'USB'];   // modulation*2 + narrow

export const CTCSS_TONES = [
  67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5,
  107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7,
  159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8,
  196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1];

export const DTCS_CODES = [
  23, 25, 26, 31, 32, 36, 43, 47, 51, 53, 54, 65, 71, 72, 73, 74, 114, 115, 116, 122, 125,
  131, 132, 134, 143, 145, 152, 155, 156, 162, 165, 172, 174, 205, 212, 223, 225, 226, 243,
  244, 245, 246, 251, 252, 255, 261, 263, 265, 266, 271, 274, 306, 311, 315, 325, 331, 332,
  343, 346, 351, 356, 364, 365, 371, 411, 412, 413, 423, 431, 432, 445, 446, 452, 454, 455,
  462, 464, 465, 466, 503, 506, 516, 523, 526, 532, 546, 565, 606, 612, 624, 627, 631, 632,
  654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754];

// Index = txpower bits; CHIRP CSV only takes "<watts>W". USER (0) has no fixed
// power: 0.01 W stands for it, as CHIRP's CSV reads "0W" as "not set".
export const POWER_WATTS = [0.01, 0.02, 0.125, 0.25, 0.5, 1, 2, 5];

const OFFSET_NONE = 0, OFFSET_PLUS = 1, OFFSET_MINUS = 2;
const TONE_NONE = 0, TONE_CTCSS = 1, TONE_DCS = 2, TONE_RDCS = 3;

export function bandOf(hz) {
  const f = Math.floor(hz / 10);
  for (let b = BAND_LOWER.length - 1; b >= 0; b--)
    if (f >= BAND_LOWER[b]) return b;
  return 0;
}

export function newImage() {
  return new Uint8Array(IMAGE_SIZE).fill(0xFF);
}

// A tone spec is { mode: '' | 'Tone' | 'DTCS', value, pol: 'N' | 'R' }
const NO_TONE = Object.freeze({ mode: '', value: null, pol: 'N' });

function decodeTone(flag, code) {
  if (flag === TONE_CTCSS && code < CTCSS_TONES.length)
    return { mode: 'Tone', value: CTCSS_TONES[code], pol: 'N' };
  if ((flag === TONE_DCS || flag === TONE_RDCS) && code < DTCS_CODES.length)
    return { mode: 'DTCS', value: DTCS_CODES[code], pol: flag === TONE_RDCS ? 'R' : 'N' };
  return { ...NO_TONE };
}

function encodeTone(tone) {
  if (tone && tone.mode === 'Tone') {
    const i = CTCSS_TONES.indexOf(tone.value);
    if (i >= 0) return [TONE_CTCSS, i];
  } else if (tone && tone.mode === 'DTCS') {
    const i = DTCS_CODES.indexOf(tone.value);
    if (i >= 0) return [tone.pol === 'R' ? TONE_RDCS : TONE_DCS, i];
  }
  return [TONE_NONE, 0];
}

// ---------- channel <-> bytes ----------

// Channel object:
//   { number (1-based), name, comment, freq (Hz), offset (Hz), duplex ('' '+' '-'),
//     rxTone, txTone, mode, step (kHz), power (0-7), scanlist (0 off, 1-24, 25 all),
//     compander, rec (16 raw bytes kept for the hidden bits) }
// comment lives only in the editor and the CSV. name is Shift_JIS on the
// radio: up to 10 bytes (5 full-width or 10 half-width characters).

export function emptyAt(image, index) {
  const a = ATTR_BASE + index * 2;
  if ((image[a] & 0x07) === BAND_EMPTY) return true;
  const o = CHAN_BASE + index * 16;
  const freq = (image[o] | (image[o + 1] << 8) | (image[o + 2] << 16) | (image[o + 3] << 24)) >>> 0;
  return freq === 0 || freq === 0xFFFFFFFF;
}

export function decodeChannel(image, index) {
  if (emptyAt(image, index)) return null;
  const o = CHAN_BASE + index * 16;
  const rec = image.slice(o, o + 16);
  const dv = new DataView(rec.buffer);
  const a = ATTR_BASE + index * 2;

  const modulation = rec[11] >> 4;
  const narrow = (rec[12] >> 1) & 1;
  let modeIdx = modulation * 2 + narrow;
  if (modeIdx === 5) modeIdx = 4;              // USB with the narrow bit
  const mode = MODES[modeIdx] || 'FM';

  const dir = rec[11] & 0x0F;
  return {
    number: index + 1,
    name: decodeSjisName(image.subarray(NAME_BASE + index * 16, NAME_BASE + index * 16 + NAME_LEN)),
    comment: '',
    freq: dv.getUint32(0, true) * 10,
    offset: dv.getUint32(4, true) * 10,
    duplex: dir === OFFSET_PLUS ? '+' : dir === OFFSET_MINUS ? '-' : '',
    rxTone: decodeTone(rec[10] & 0x0F, rec[8]),
    txTone: decodeTone(rec[10] >> 4, rec[9]),
    mode,
    step: STEPS[rec[14]] ?? 2.5,
    power: (rec[12] >> 2) & 0x07,
    scanlist: image[a + 1] <= LIST_COUNT + 1 ? image[a + 1] : 0,
    compander: (image[a] >> 3) & 0x03,
    rec,
  };
}

// ASCII up to the first byte outside 0x20-0x7E (scan list names)
function decodeName(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7E) break;
    s += String.fromCharCode(b);
  }
  return s.trimEnd();
}

export function encodeChannel(image, index, ch) {
  const o = CHAN_BASE + index * 16;
  const n = NAME_BASE + index * 16;
  const a = ATTR_BASE + index * 2;
  if (!ch) {
    // Same as deleting on the radio (SETTINGS_UpdateChannel), plus a blank record
    // so CHIRP, which only looks at the frequency, sees it as empty too.
    image.fill(0xFF, o, o + 16);
    image.fill(0x00, n, n + 16);
    image[a] = BAND_EMPTY;
    image[a + 1] = 0;
    return;
  }
  // Start from the bytes the channel came with (or what is there now), so bits
  // the editor does not handle stay as they were.
  const emptySlot = emptyAt(image, index);
  const fromRadio = ch.rec && ch.rec.length === 16;
  const rec = (fromRadio ? ch.rec : image.subarray(o, o + 16)).slice();
  if (!fromRadio) {
    // New channel (CSV, table): TX lock, busy lockout, reverse and DTMF off, as
    // CHIRP's set_memory does when a memory carries no extra settings.
    rec[12] &= 0x80;
    rec[13] &= 0xF0;
  }
  const dv = new DataView(rec.buffer);
  dv.setUint32(0, Math.round(ch.freq / 10), true);
  dv.setUint32(4, Math.round((ch.offset || 0) / 10), true);
  const [rxFlag, rxCode] = encodeTone(ch.rxTone);
  const [txFlag, txCode] = encodeTone(ch.txTone);
  rec[8] = rxCode;
  rec[9] = txCode;
  rec[10] = (txFlag << 4) | rxFlag;
  let modeIdx = MODES.indexOf(ch.mode);
  if (modeIdx < 0) modeIdx = 0;
  const modulation = modeIdx >> 1;
  const narrow = ch.mode === 'USB' ? 1 : modeIdx & 1;
  const dir = ch.duplex === '+' ? OFFSET_PLUS : ch.duplex === '-' ? OFFSET_MINUS : OFFSET_NONE;
  rec[11] = (modulation << 4) | dir;
  rec[12] = (rec[12] & 0xE1) | ((ch.power & 0x07) << 2) | (narrow << 1);
  const step = STEPS.indexOf(ch.step);
  rec[14] = step >= 0 ? step : STEPS.indexOf(12.5);
  image.set(rec, o);

  // Same name as stored (the radio and CHIRP pad with spaces): keep the bytes
  const name = encodeName(ch.name, NAME_LEN);
  if (emptySlot || decodeSjisName(image.subarray(n, n + NAME_LEN)) !== name.text) {
    image.fill(0x00, n, n + 16);
    image.set(name.bytes, n);
  }

  // Keep bits 5-7 (unused/exclude) as they were unless the slot was free
  const keep = emptySlot ? 0 : image[a] & 0xE0;
  image[a] = keep | ((ch.compander & 0x03) << 3) | bandOf(ch.freq);
  image[a + 1] = ch.scanlist;
}

// The name as the radio will hold it: characters it cannot show dropped, cut to 10 bytes
export function cleanName(s) {
  return encodeName(s, NAME_LEN).text;
}

export function decodeAll(image) {
  const channels = [];
  for (let i = 0; i < CHANNELS; i++) {
    const ch = decodeChannel(image, i);
    if (ch) channels.push(ch);
  }
  return channels;
}

export function decodeListNames(image) {
  const names = [];
  for (let i = 0; i < LIST_COUNT; i++) {
    const o = LIST_NAME_BASE + i * 4;
    names.push(decodeName(image.subarray(o, o + LIST_NAME_LEN)));
  }
  return names;
}

export function encodeListNames(image, names) {
  for (let i = 0; i < LIST_COUNT; i++) {
    const o = LIST_NAME_BASE + i * 4;
    const s = String(names[i] || '').replace(/[^\x20-\x7E]/g, '').slice(0, LIST_NAME_LEN).trimEnd();
    if (decodeName(image.subarray(o, o + LIST_NAME_LEN)) === s) continue;   // keep the bytes
    image.fill(0x00, o, o + 4);
    for (let k = 0; k < s.length; k++) image[o + k] = s.charCodeAt(k);
  }
}

// Build the image to write: the radio's snapshot with every channel slot
// re-encoded from the editor (slots not in channels become empty).
export function buildImage(snapshot, channels, listNames) {
  const image = snapshot.slice();
  const byIndex = new Map(channels.map(ch => [ch.number - 1, ch]));
  for (let i = 0; i < CHANNELS; i++) {
    const ch = byIndex.get(i);
    if (ch) encodeChannel(image, i, ch);
    else if (!emptyAt(snapshot, i)) encodeChannel(image, i, null);
  }
  if (listNames) encodeListNames(image, listNames);
  return image;
}

// Writes needed to turn `from` into `to`: [{ addr, data }], each a run of
// changed 8-byte blocks of at most maxLen bytes that does not cross a 4 KB
// flash sector. Attributes come last so an interrupted write leaves new
// channels still marked free rather than pointing at half-written records.
export function planWrites(from, to, maxLen = 128) {
  const writes = [];
  const order = ['name', 'chan', 'list', 'attr'];
  for (const name of order) {
    const r = REGIONS.find(x => x.name === name);
    let run = null;
    for (let off = r.start; off < r.start + r.size; off += 8) {
      let changed = false;
      for (let k = 0; k < 8; k++) if (from[off + k] !== to[off + k]) { changed = true; break; }
      const sameSector = run && (run.addr >> 12) === (off >> 12);
      if (changed && run && run.addr + run.len === off && run.len + 8 <= maxLen && sameSector) {
        run.len += 8;
      } else {
        if (run) writes.push(run);
        run = changed ? { addr: off, len: 8 } : null;
      }
    }
    if (run) writes.push(run);
  }
  return writes.map(w => ({ addr: w.addr, data: to.slice(w.addr, w.addr + w.len) }));
}

// ---------- CHIRP CSV rows ----------

export const CSV_COLUMNS = ['Location', 'Name', 'Frequency', 'Duplex', 'Offset', 'Tone', 'rToneFreq',
  'cToneFreq', 'DtcsCode', 'DtcsPolarity', 'RxDtcsCode', 'CrossMode', 'Mode', 'TStep', 'Skip',
  'Power', 'Comment', 'URCALL', 'RPT1CALL', 'RPT2CALL', 'DVCODE', 'ScanList'];

// chirp_common.split_tone_decode
function tonesToChirp(tx, rx) {
  const m = { tmode: '', rtone: 88.5, ctone: 88.5, dtcs: 23, rxDtcs: 23, crossMode: 'Tone->Tone',
              pol: (tx.mode === 'DTCS' ? tx.pol : 'N') + (rx.mode === 'DTCS' ? rx.pol : 'N') };
  if (!tx.mode && !rx.mode) return m;
  if (tx.mode === 'Tone' && !rx.mode) { m.tmode = 'Tone'; m.rtone = tx.value; return m; }
  if (tx.mode === 'Tone' && rx.mode === 'Tone' && tx.value === rx.value) { m.tmode = 'TSQL'; m.ctone = tx.value; return m; }
  if (tx.mode === 'DTCS' && rx.mode === 'DTCS' && tx.value === rx.value) { m.tmode = 'DTCS'; m.dtcs = tx.value; return m; }
  m.tmode = 'Cross';
  m.crossMode = `${tx.mode}->${rx.mode}`;
  if (tx.mode === 'Tone') m.rtone = tx.value; else if (tx.mode === 'DTCS') m.dtcs = tx.value;
  if (rx.mode === 'Tone') m.ctone = rx.value; else if (rx.mode === 'DTCS') m.rxDtcs = rx.value;
  return m;
}

// chirp_common.split_tone_encode
function tonesFromChirp(tmode, rtone, ctone, dtcs, rxDtcs, crossMode, pol) {
  let tx = '', rx = '', txv = null, rxv = null;
  if (tmode === 'Tone') { tx = 'Tone'; txv = rtone; }
  else if (tmode === 'TSQL') { tx = rx = 'Tone'; txv = rxv = ctone; }
  else if (tmode === 'DTCS') { tx = rx = 'DTCS'; txv = rxv = dtcs; }
  else if (tmode === 'Cross') {
    [tx, rx] = String(crossMode || '->').split('->');
    if (tx === 'Tone') txv = rtone; else if (tx === 'DTCS') txv = dtcs;
    if (rx === 'Tone') rxv = ctone; else if (rx === 'DTCS') rxv = rxDtcs;
  }
  const p = String(pol || 'NN');
  return [
    tx ? { mode: tx, value: txv, pol: tx === 'DTCS' ? (p[0] === 'R' ? 'R' : 'N') : 'N' } : { ...NO_TONE },
    rx ? { mode: rx, value: rxv, pol: rx === 'DTCS' ? (p[1] === 'R' ? 'R' : 'N') : 'N' } : { ...NO_TONE },
  ];
}

const mhz = hz => `${Math.floor(hz / 1e6)}.${String(hz % 1e6).padStart(6, '0')}`;

export function scanlistLabel(v) {
  return v === 0 ? 'OFF' : v === LIST_COUNT + 1 ? 'ALL' : String(v);
}

export function parseScanlist(s) {
  const t = String(s ?? '').trim().toUpperCase();
  if (!t || t === 'OFF' || t === '0') return 0;
  if (t === 'ALL') return LIST_COUNT + 1;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= LIST_COUNT ? n : null;
}

function powerLabel(p) {
  const w = POWER_WATTS[p] ?? 0;
  return w < 1 ? `${w}W` : `${w.toFixed(1)}W`;
}

export function channelToRow(ch) {
  const t = tonesToChirp(ch.txTone, ch.rxTone);
  return {
    Location: String(ch.number),
    Name: ch.name,
    Frequency: mhz(ch.freq),
    Duplex: ch.duplex,
    Offset: mhz(ch.offset || 0),
    Tone: t.tmode,
    rToneFreq: t.rtone.toFixed(1),
    cToneFreq: t.ctone.toFixed(1),
    DtcsCode: String(t.dtcs).padStart(3, '0'),
    DtcsPolarity: t.pol,
    RxDtcsCode: String(t.rxDtcs).padStart(3, '0'),
    CrossMode: t.crossMode,
    Mode: ch.mode,
    TStep: ch.step.toFixed(2),
    Skip: '',
    Power: powerLabel(ch.power),
    Comment: ch.comment || '',
    URCALL: '', RPT1CALL: '', RPT2CALL: '', DVCODE: '',
    ScanList: scanlistLabel(ch.scanlist),
  };
}

// MHz text to Hz without floating point drift ("145.5" -> 145500000)
export function parseMHz(s) {
  const m = String(s ?? '').trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const frac = (m[2] || '').padEnd(6, '0');
  if (frac.length > 6 && /[1-9]/.test(frac.slice(6))) return null;
  return Number(m[1]) * 1e6 + Number(frac.slice(0, 6));
}

function nearestPower(watts) {
  let best = 0;
  POWER_WATTS.forEach((w, i) => { if (Math.abs(w - watts) < Math.abs(POWER_WATTS[best] - watts)) best = i; });
  return best;
}

// One CSV row (object keyed by header) -> { ch } or { error }. Missing columns
// take CHIRP's defaults; rows CHIRP would drop (no location, 0 Hz) are errors.
export function rowToChannel(row) {
  const get = k => (row[k] ?? '').trim();
  const number = Number(get('Location'));
  if (!Number.isInteger(number) || number < 1 || number > CHANNELS)
    return { error: 'location', value: get('Location') };
  const freq = parseMHz(get('Frequency'));
  if (!freq) return { error: 'frequency', value: get('Frequency') };
  if (freq < MIN_HZ || freq > MAX_HZ) return { error: 'range', value: get('Frequency') };

  const mode = get('Mode') || 'FM';
  if (!MODES.includes(mode)) return { error: 'mode', value: mode };

  const num = (k, d) => { const v = Number(get(k)); return get(k) !== '' && Number.isFinite(v) ? v : d; };
  const [txTone, rxTone] = tonesFromChirp(get('Tone'), num('rToneFreq', 88.5), num('cToneFreq', 88.5),
    num('DtcsCode', 23), num('RxDtcsCode', 23), get('CrossMode') || 'Tone->Tone', get('DtcsPolarity') || 'NN');
  for (const tone of [txTone, rxTone]) {
    if (tone.mode === 'Tone' && !CTCSS_TONES.includes(tone.value)) return { error: 'tone', value: tone.value };
    if (tone.mode === 'DTCS' && !DTCS_CODES.includes(tone.value)) return { error: 'tone', value: tone.value };
  }

  let step = num('TStep', 12.5);
  if (!STEPS.includes(step)) step = STEPS.find(s => Math.abs(s - step) < 0.005) ?? 12.5;

  const duplex = ['+', '-'].includes(get('Duplex')) ? get('Duplex') : '';

  // NameJa: column of RxJa Tools before v1.1.0 (Japanese names kept off the
  // radio). It becomes the name when Name is empty, else goes to the comment.
  let rawName = get('Name'), comment = get('Comment');
  const nameJa = get('NameJa');
  if (nameJa && !rawName) rawName = nameJa;
  const nm = encodeName(rawName, NAME_LEN);
  if (nameJa && nameJa !== nm.text) comment = comment ? `${nameJa} / ${comment}` : nameJa;
  const pw = get('Power').match(/^([\d.]+)\s*W$/i);
  const scanlist = parseScanlist(get('ScanList'));

  return {
    ch: {
      number,
      name: nm.text,
      comment,
      freq,
      offset: duplex ? (parseMHz(get('Offset')) || 0) : 0,
      duplex,
      rxTone, txTone,
      mode,
      step,
      power: pw ? nearestPower(Number(pw[1])) : 2,
      scanlist: scanlist ?? 0,
      compander: 0,
      rec: null,
    },
    nameChanged: nm.bad.length > 0 || nm.cut,
  };
}

export function formatMHz(hz) {
  // 145.500 / 118.025 / 26.968 -> at least 3 decimals, more only when needed
  let s = mhz(hz).replace(/0+$/, '');
  const [i, f = ''] = s.split('.');
  return `${i}.${f.padEnd(3, '0')}`;
}

export function toneLabel(tone) {
  if (!tone || !tone.mode) return '';
  if (tone.mode === 'Tone') return tone.value.toFixed(1);
  return `D${String(tone.value).padStart(3, '0')}${tone.pol === 'R' ? 'I' : 'N'}`;
}

// "88.5" / "D023N" / "D023I" / "" -> tone spec, or null when not valid
export function parseToneLabel(s) {
  const t = String(s ?? '').trim().toUpperCase();
  if (!t || t === 'OFF') return { ...NO_TONE };
  const d = t.match(/^D?(\d{3})([NI])?$/);
  if (d && t.startsWith('D')) {
    const v = Number(d[1]);
    return DTCS_CODES.includes(v) ? { mode: 'DTCS', value: v, pol: d[2] === 'I' ? 'R' : 'N' } : null;
  }
  const v = Number(t);
  return CTCSS_TONES.includes(v) ? { mode: 'Tone', value: v, pol: 'N' } : null;
}
