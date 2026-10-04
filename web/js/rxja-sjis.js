// RxJa Tools: Shift_JIS channel names. Added by the RxJa project; not part of
// UV Studio. No DOM: also used by the Node tests.
//
// The radio (RxJa v1.1.0+) stores channel names in Shift_JIS: ASCII,
// half-width katakana (0xA1-0xDF) and the JIS X 0208 characters of its font,
// which rxja-sjis-data.js lists in the order of the firmware's table (both are
// written by tools/ja/gen_ja_font.py). Browsers cannot encode Shift_JIS, so
// the map is built from that list.

import { LEADS, CHARS } from './rxja-sjis-data.js';

const TRAILS = [];
for (let t = 0x40; t <= 0xFC; t++) if (t !== 0x7F) TRAILS.push(t);

const toBytes = new Map();      // character -> [lead, trail]
const toChar = new Map();       // lead << 8 | trail -> character
[...CHARS].forEach((ch, i) => {
  if (ch === '\0') return;
  const lead = LEADS[Math.floor(i / TRAILS.length)], trail = TRAILS[i % TRAILS.length];
  toBytes.set(ch, [lead, trail]);
  toChar.set((lead << 8) | trail, ch);
});

// What Windows (cp932) types for six JIS characters the font has in their JIS form
const VARIANTS = { '～': '〜', '－': '−', '∥': '‖',
                   '￠': '¢', '￡': '£', '￢': '¬' };

export const GETA = '〓';   // what the radio shows for a broken character

// Bytes of one character, or null when the radio cannot show it
export function charBytes(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x20 && c <= 0x7E) return [c];
  if (c >= 0xFF61 && c <= 0xFF9F) return [0xA1 + c - 0xFF61];
  return toBytes.get(VARIANTS[ch] || ch) || null;
}

// Fit a name into maxBytes: characters the radio cannot show are dropped
// (listed in bad), and the name is cut between characters.
//   -> { text, bytes, bad: [characters], cut: bool }
export function encodeName(s, maxBytes = 10) {
  const bytes = [], bad = [];
  let text = '', cut = false;
  for (const ch of String(s ?? '')) {
    const b = charBytes(ch);
    if (!b) { if (!bad.includes(ch)) bad.push(ch); continue; }
    if (bytes.length + b.length > maxBytes) { cut = true; break; }
    bytes.push(...b);
    text += VARIANTS[ch] || ch;
  }
  // the radio trims trailing spaces
  while (bytes.length && bytes[bytes.length - 1] === 0x20) { bytes.pop(); text = text.slice(0, -1); }
  return { text, bytes: Uint8Array.from(bytes), bad, cut };
}

export function byteLength(s) {
  let n = 0;
  for (const ch of String(s ?? '')) n += (charBytes(ch) || []).length;
  return n;
}

// Name bytes as the firmware reads them (SETTINGS_FetchChannelName): up to the
// first byte below 0x20, 0x7F or 0xFF; trailing spaces trimmed.
export function decodeName(bytes) {
  let end = 0;
  while (end < bytes.length && bytes[end] >= 0x20 && bytes[end] !== 0x7F && bytes[end] !== 0xFF) end++;
  let s = '';
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); continue; }
    if (b >= 0xA1 && b <= 0xDF) { s += String.fromCharCode(0xFF61 + b - 0xA1); continue; }
    const t = i + 1 < end ? bytes[i + 1] : 0;
    const lead = (b >= 0x81 && b <= 0x9F) || (b >= 0xE0 && b <= 0xFC);
    if (lead && t >= 0x40 && t <= 0xFC && t !== 0x7F) {
      s += toChar.get((b << 8) | t) || GETA;
      i++;
    } else {
      s += GETA;
    }
  }
  return s.replace(/ +$/, '');
}

export function isAscii(s) {
  return /^[\x20-\x7E]*$/.test(String(s ?? ''));
}
