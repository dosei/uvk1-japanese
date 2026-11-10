// RxJa Tools: layout and coding of the radio's broadcast-FM stations (RxJa v2.0.0+).
// Added by the RxJa project; not part of UV Studio.
//
// No DOM here, so Node can test it (tools/fmedit-test/). The firmware keeps the stations in
// two flash sectors that the 16-bit EEPROM window of 0x051B / 0x051D exposes
// (App/driver/eeprom_compat.c, App/app/fm.c):
//
//   0xD000  header  u32 magic 'RFM1' (0x314D4652, little endian), u16 count (100),
//                   u16 flags (0xFFFE: bit 0 clear = the name sector is initialized)
//   0xD008  100 x u16 frequency in 0.1 MHz, 0xFFFF = empty slot
//   0xE000  100 x 20 bytes station name, Shift_JIS, NUL (or 0xFF) padded
//
// Order of writes matters (see planWrites): names first, the frequencies next and the header
// last, because a radio that finds no valid header at start-up replaces the sector by the old
// 48-entry table of v1.3.0 and earlier.

import { encodeName, decodeName } from './rxja-sjis.js';

export const COUNT = 100;
export const NAME_LEN = 20;                 // bytes: ten full-width characters = one line of the screen
export const EMPTY = 0xFFFF;
export const MAGIC = 0x314D4652;            // "RFM1"
export const FLAGS = 0xFFFE;                // what the firmware writes (App/app/fm.c FM_FLAGS_NAMES_OK)

export const HDR_BASE = 0xD000;
export const HDR_SIZE = 8;
export const FREQ_BASE = HDR_BASE + HDR_SIZE;
export const NAME_BASE = 0xE000;

// Frequencies the radio accepts anywhere (BK1080 bands: 64.0 - 108.0 MHz, App/driver/bk1080.c)
export const MIN_X10 = 640;
export const MAX_X10 = 1080;

// Ranges to read and to write, as [{ name, addr, size }]. Both are multiples of 8, each inside one
// 4 KB sector of its own. `image` is one 0x2000-byte buffer indexed by (addr - HDR_BASE).
export const REGIONS = [
  { name: 'head', addr: HDR_BASE, size: HDR_SIZE },
  { name: 'freq', addr: FREQ_BASE, size: COUNT * 2 },
  { name: 'name', addr: NAME_BASE, size: COUNT * NAME_LEN },
];
export const IMAGE_SIZE = 0x2000;
const off = addr => addr - HDR_BASE;

export function newImage() {
  return new Uint8Array(IMAGE_SIZE).fill(0xFF);
}

function u16(image, a) { return image[off(a)] | (image[off(a) + 1] << 8); }
function putU16(image, a, v) { image[off(a)] = v & 0xFF; image[off(a) + 1] = v >> 8; }
function u32(image, a) {
  return (image[off(a)] | (image[off(a) + 1] << 8) | (image[off(a) + 2] << 16) | (image[off(a) + 3] << 24)) >>> 0;
}

// The sector holds a table this firmware wrote (otherwise the radio is about to rebuild it)
export function hasMagic(image) {
  return u32(image, HDR_BASE) === MAGIC && u16(image, HDR_BASE + 4) === COUNT;
}

// ---------- frequencies ----------

// "80.1" / "80.10" / "８０．１" -> 801, or null when it is not a frequency in 0.1 MHz steps
export function parseMHz10(text) {
  const s = String(text ?? '').trim().replace(/[０-９．]/g, c => (c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)))
    .replace(/\s*MHz$/i, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const v = Math.round(parseFloat(s) * 100) / 100;
  const x10 = Math.round(v * 10);
  if (Math.abs(v * 10 - x10) > 1e-6) return null;      // 80.15 is not on the 0.1 MHz grid
  return x10;
}

export function formatMHz10(x10) {
  return x10 === EMPTY ? '' : (x10 / 10).toFixed(1);
}

export function validFreq(x10) {
  return Number.isInteger(x10) && x10 >= MIN_X10 && x10 <= MAX_X10;
}

// ---------- decode / build ----------

// Stations as [{ number, freq, name }] for every slot that holds a usable frequency.
// number is the radio's FM number (0..99), freq is in 0.1 MHz.
export function decodeAll(image) {
  const out = [];
  for (let i = 0; i < COUNT; i++) {
    const f = u16(image, FREQ_BASE + i * 2);
    if (!validFreq(f)) continue;
    const n = NAME_BASE + i * NAME_LEN;
    out.push({ number: i, freq: f, name: decodeName(image.subarray(off(n), off(n) + NAME_LEN)) });
  }
  return out;
}

// Image with the stations coded in. `base` is the image read from the radio: bytes that do not
// change keep their value, so an unchanged table writes nothing. stations: [{ number, freq, name }]
export function buildImage(base, stations) {
  const image = base ? Uint8Array.from(base) : newImage();
  const byNumber = new Map(stations.map(s => [s.number, s]));

  putU32Header(image);
  for (let i = 0; i < COUNT; i++) {
    const st = byNumber.get(i);
    const n = off(NAME_BASE + i * NAME_LEN);
    if (!st || !validFreq(st.freq)) {
      putU16(image, FREQ_BASE + i * 2, EMPTY);
      image.fill(0x00, n, n + NAME_LEN);               // no frequency, no name (the radio does the same)
      continue;
    }
    putU16(image, FREQ_BASE + i * 2, st.freq);
    const name = encodeName(st.name, NAME_LEN);
    // Same name as stored (padding differs between tools): keep the bytes
    if (decodeName(image.subarray(n, n + NAME_LEN)) !== name.text) {
      image.fill(0x00, n, n + NAME_LEN);
      image.set(name.bytes, n);
    }
  }
  return image;
}

function putU32Header(image) {
  const o = off(HDR_BASE);
  image[o] = MAGIC & 0xFF; image[o + 1] = (MAGIC >> 8) & 0xFF;
  image[o + 2] = (MAGIC >> 16) & 0xFF; image[o + 3] = (MAGIC >>> 24) & 0xFF;
  putU16(image, HDR_BASE + 4, COUNT);
  putU16(image, HDR_BASE + 6, FLAGS);
}

// ---------- write plan ----------

// Writes needed to turn `from` into `to`: [{ addr, data }], each a run of changed 8-byte blocks of
// at most maxLen bytes that does not cross a 4 KB flash sector. Names first, then frequencies, the
// header last: an interrupted write then leaves the old header, with frequencies and names of
// whichever slots were reached, instead of a header over a half-written table.
export function planWrites(from, to, maxLen = 128) {
  const writes = [];
  for (const name of ['name', 'freq', 'head']) {
    const r = REGIONS.find(x => x.name === name);
    let run = null;
    // Runs are cut at 8-byte blocks that are in the region only; the frequency table (200 bytes)
    // is padded to the next block, which belongs to the (unused) tail of the same sector.
    const end = r.addr + Math.ceil(r.size / 8) * 8;
    for (let a = r.addr; a < end; a += 8) {
      let changed = false;
      for (let k = 0; k < 8; k++) if (from[off(a) + k] !== to[off(a) + k]) { changed = true; break; }
      const sameSector = run && (run.addr >> 12) === (a >> 12);
      if (changed && run && run.addr + run.len === a && run.len + 8 <= maxLen && sameSector) {
        run.len += 8;
      } else {
        if (run) writes.push(run);
        run = changed ? { addr: a, len: 8 } : null;
      }
    }
    if (run) writes.push(run);
  }
  return writes.map(w => ({ addr: w.addr, data: to.slice(off(w.addr), off(w.addr) + w.len) }));
}

// ---------- CSV ----------

// number, frequency, name. Frequency in MHz; the file is one station per row.
export const CSV_COLUMNS = ['No', 'Frequency', 'Name'];

export function stationToRow(st) {
  return { No: String(st.number).padStart(2, '0'), Frequency: formatMHz10(st.freq), Name: st.name };
}

// -> { station, problem } ; station is null when the row has no frequency
export function rowToStation(row, fallbackNumber) {
  const freq = parseMHz10(row.Frequency ?? row.frequency ?? '');
  if (freq === null) return { station: null, problem: 'freq' };
  if (!validFreq(freq)) return { station: null, problem: 'range' };
  const raw = String(row.No ?? row.no ?? row.Location ?? '').trim();
  const number = /^\d{1,2}$/.test(raw) ? parseInt(raw, 10) : fallbackNumber;
  if (!Number.isInteger(number) || number < 0 || number >= COUNT) return { station: null, problem: 'number' };
  return { station: { number, freq, name: String(row.Name ?? row.name ?? '').trim() }, problem: null };
}

// ---------- presets (web/presets/fm-jp.json) ----------

// Stations of one prefecture from the preset file -> [{ freq, name }] (no numbers yet).
// Same frequency twice (a main and a relay station of the same programme are different
// frequencies, so this only drops exact repeats).
export function presetStations(doc, prefCode) {
  const pref = doc && doc.prefectures && doc.prefectures[prefCode];
  if (!pref) return [];
  const seen = new Set();
  const out = [];
  for (const s of pref.stations) {
    const freq = Math.round(s.mhz * 10);
    if (!validFreq(freq) || seen.has(freq)) continue;
    seen.add(freq);
    out.push({ freq, name: encodeName(s.name, NAME_LEN).text });
  }
  return out;
}

// Put preset stations into the free slots of `stations`, skipping frequencies already stored.
// -> { stations, added, skipped, full }
export function mergePreset(stations, preset) {
  const used = new Set(stations.map(s => s.number));
  const have = new Set(stations.map(s => s.freq));
  const next = [...stations];
  let added = 0, skipped = 0, full = 0, n = 0;
  for (const p of preset) {
    if (have.has(p.freq)) { skipped++; continue; }
    while (n < COUNT && used.has(n)) n++;
    if (n >= COUNT) { full++; continue; }
    next.push({ number: n, freq: p.freq, name: p.name });
    used.add(n); have.add(p.freq); added++;
  }
  next.sort((a, b) => a.number - b.number);
  return { stations: next, added, skipped, full };
}
