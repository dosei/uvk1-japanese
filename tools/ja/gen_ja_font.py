#!/usr/bin/env python3
"""
Build the Japanese resource image for external SPI flash (ENABLE_JAPANESE).

Font: Shinonome 12 via efont-unicode-bdf 0.4.2 (shinonome12_uni.hex, Public
Domain). JIS X 0208 = kana, kanji and full-width symbols, 12x12. Every non-ASCII
code point is kept; ASCII is drawn with the built-in gFontSmall.
Half-width katakana U+FF61..U+FF9F: Shinonome 6x12 JIS X 0201 (shnm6x12r.bdf,
Public Domain), stored in the same 18-byte slots with columns 6..11 empty; the
firmware advances 6 px for that range (App/ui/ja.c).
UI strings: strings_ja.tsv (English key -> Japanese, see the file header).
Range-scan presets: presets_ja.tsv (ENABLE_RXJA_PRESET, see the file header).

Image layout (little-endian), written to SPI at JA_FLASH_BASE (App/ui/ja.h):
    +0   char[4]  magic "JF03" (withdrawn test builds: "JF12", so their upload.py refuses this)
    +4   u16      glyph count N
    +6   u16      format version
    +8   u32      text table offset T (0 = none)
    +12  u16[N]   code points, ascending
    +..  N x 18   glyphs: 12 columns x 12 bits, bit 0 = top row; column c is
                  bits 12c..12c+11 of the 144-bit little-endian glyph
    +T   u16      string count M
    +T+2 u16      preset table offset from T in 4-byte units, 0 = none
                  (was padding: older firmware ignores it, so no format bump)
    +..  u32[M]   FNV-1a hash of the English key, ascending
    +..  u16[M]   offset of each string from the end of this array
    +..           UTF-8 strings, NUL terminated
    +P   u16      preset count K, u16 record size (40)
    +..  K x      u32 lower, u32 upper (10 Hz units, inclusive), u8 step
                  (STEP_Setting_t), u8 modulation, u8 bandwidth, u8 flags (0),
                  char[28] UTF-8 name, NUL padded (JA_Preset_t in App/ui/ja.h)
    +S   char[4]  "SJ01", 4-byte aligned right after the preset table (RxJa
                  v1.1.0; older firmware stops reading at the preset table,
                  so no format bump)
    +S+4 u16      entry count (39 x 188), u16 reserved (0)
    +S+8 u16[..]  glyph index for each Shift_JIS double-byte code, 0xFFFF = none:
                  lead bytes 0x81..0x84, 0x88..0x9F, 0xE0..0xEA (JIS X 0208
                  rows 1..8, 16..84) x trail bytes 0x40..0x7E, 0x80..0xFC.
                  Channel names are stored in Shift_JIS (App/ui/ja.c).
Also writes web/js/rxja-sjis-data.js, the same table as characters for the
memory channel editor of RxJa Tools.
Usage: gen_ja_font.py [out.bin]   (default: tools/ja/ja_res.bin)
"""
import decimal
import pathlib
import re
import struct
import sys

HERE = pathlib.Path(__file__).resolve().parent
MENU_C = HERE.parent.parent / 'App' / 'ui' / 'menu.c'
MAIN_C = HERE.parent.parent / 'App' / 'ui' / 'main.c'
# other files with translated strings, searched for the keys
SOURCES = [MAIN_C] + [HERE.parent.parent / 'App' / f for f in (
    'ui/welcome.c', 'ui/helper.c', 'ui/scanner.c', 'ui/fmradio.c', 'app/rxtx_log.c',
    'app/preset.c')]
MAGIC = b'JF03'             # JA_MAGIC in App/ui/ja.c
VERSION = 3
TEXT_MAX = 48               # JA_TEXT_MAX in App/ui/ja.h, incl. NUL
FLASH_BASE = 0x122000      # JA_FLASH_BASE: right after the overlay Apps (0x102000..0x122000)
FLASH_LIMIT = 0x14C000     # voice prompts; 0x0C0000..0x100000 are multiboot config banks
HALF_FIRST, HALF_LAST = 0xFF61, 0xFF9F  # half-width katakana, 6 px (HALF_WIDTH in ja.c)
SJIS_LEADS = [*range(0x81, 0x85), *range(0x88, 0xA0), *range(0xE0, 0xEB)]   # SJIS_LEADS in ja.c
SJIS_TRAILS = [*range(0x40, 0x7F), *range(0x80, 0xFD)]                      # SJIS_TRAILS
SJIS_JS = HERE.parent.parent / 'web' / 'js' / 'rxja-sjis-data.js'

# presets: STEP_Setting_t order and gStepFrequencyTable (10 Hz units), App/frequencies.c
STEPS = [250, 500, 625, 1000, 1250, 2500, 833, 1, 5, 10, 25, 50, 100, 125,
         900, 1500, 2000, 3000, 5000, 10000, 12500, 20000, 25000, 50000]
MODULATIONS = {'FM': 0, 'AM': 1, 'USB': 2}      # ModulationMode_t
BANDWIDTHS = {'W': 0, 'N': 1}                   # BANDWIDTH_WIDE / BANDWIDTH_NARROW
PRESET_NAME = 28            # JA_PRESET_NAME in App/ui/ja.h, incl. NUL
PRESET_NAME_WIDTH = 128 - 18  # LCD_WIDTH - NAME_X in App/app/preset.c
RX_LOWER, RX_UPPER = 1800000, 130000000         # BX4819_band1.lower, BX4819_band2.upper
GAP_LOWER, GAP_UPPER = 63000000, 84000000       # BK4819 cannot receive [63, 84) MHz


def load_hex(path):
    glyphs = {}
    lines = path.read_text(encoding='ascii').splitlines()
    assert lines[0].split() == ['12', '12']
    for line in lines[1:]:
        cp, h = line.split(':')
        glyphs[int(cp, 16)] = [int(h[i:i + 4], 16) for i in range(0, 48, 4)]
    return glyphs


def load_halfwidth_kana(path):
    """JIS X 0201 0xA1..0xDF -> U+FF61..U+FF9F, rows as u16 like load_hex."""
    glyphs, enc, rows = {}, None, None
    for line in path.read_text(encoding='ascii').splitlines():
        if line.startswith('ENCODING'):
            enc = int(line.split()[1])
        elif line.startswith('BBX'):
            assert line.split()[1:] == ['6', '12', '0', '-2'], line
        elif line == 'BITMAP':
            rows = []
        elif line == 'ENDCHAR':
            if 0xA1 <= enc <= 0xDF:
                assert len(rows) == 12
                glyphs[enc - 0xA1 + HALF_FIRST] = rows
            rows = None
        elif rows is not None:
            rows.append(int(line, 16) << 8)
    assert len(glyphs) == HALF_LAST - HALF_FIRST + 1
    return glyphs


def rows_to_columns(rows):
    cols = []
    for c in range(12):
        v = 0
        for r, row in enumerate(rows):
            if row & (0x8000 >> c):
                v |= 1 << r
        cols.append(v)
    return cols


def pack_glyph(cols):
    v = 0
    for c, bits in enumerate(cols):
        assert bits < 1 << 12
        v |= bits << (12 * c)
    return v.to_bytes(18, 'little')


def fnv1a(data):
    h = 2166136261
    for b in data:
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h


def text_width(s):
    return sum(7 if ord(ch) < 0x80 else 6 if HALF_FIRST <= ord(ch) <= HALF_LAST else 12
               for ch in s)


def load_strings(path, glyphs):
    """(key, ja) pairs from the TSV, checked against the font and width limits."""
    pairs, errors, width = [], [], None
    for n, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip() or line.startswith('#'):
            continue
        key, _, ja = line.partition('\t')
        if key.startswith('@width'):
            width = int(key.split()[1])
            continue
        key, ja = key.replace('\\n', '\n'), ja.replace('\\n', '\n')
        where = '%s:%d %r' % (path.name, n, key)
        if not ja:
            errors.append('%s: no tab-separated translation' % where)
            continue
        missing = [ch for ch in ja if ord(ch) >= 0x80 and ord(ch) not in glyphs]
        if missing:
            errors.append('%s: not in the font: %s' % (where, ''.join(missing)))
        for part in ja.split('\n'):
            if width and text_width(part) > width:
                errors.append('%s: %r is %d px, limit %d' % (where, part, text_width(part), width))
        if len(ja.encode()) >= TEXT_MAX:
            errors.append('%s: longer than %d bytes' % (where, TEXT_MAX - 1))
        if '|' in key and len(key.encode()) >= TEXT_MAX:
            errors.append('%s: "menu|value" key longer than %d bytes' % (where, TEXT_MAX - 1))
        pairs.append((key, ja))
    if errors:
        raise SystemExit('\n'.join(errors))
    return pairs


def check_against_menu(pairs):
    """Warn about keys that do not appear in the sources and menu names left in English."""
    if not MENU_C.exists():
        return
    src = MENU_C.read_text(encoding='utf-8', errors='replace')
    other = ''.join(p.read_text(encoding='utf-8', errors='replace') for p in SOURCES if p.exists())
    menu = src[src.index('MenuList[] ='):]
    menu = menu[:menu.index('};')]
    names = re.findall(r'\{"([^"]+)",', menu)
    keys = {k for k, _ in pairs}
    for k in sorted(keys):
        menu, _, value = k.rpartition('|')
        if menu and menu not in names:
            print('warning: menu %r of key %r not in MenuList' % (menu, k))
        # a string literal starting with the value ("CARRIER" matches "CARRIER\n%02ds...")
        lit = '"' + value.replace('\n', '\\n')
        if lit not in src and lit not in other:
            print('warning: key %r not found in the sources' % k)
    left = [n for n in names if n not in keys]
    if left:
        print('untranslated menu names (shown in English, may be disabled in this build):',
              ' '.join(left))


def load_presets(path, glyphs):
    """Records of presets_ja.tsv (name, lower, upper, step, mode, bandwidth), checked."""
    presets, errors = [], []
    if not path.exists():
        return presets
    for n, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip() or line.startswith('#'):
            continue
        cols = line.split('\t')
        where = '%s:%d' % (path.name, n)
        if len(cols) != 6:
            errors.append('%s: need 6 tab-separated columns, got %d' % (where, len(cols)))
            continue
        name, lower, upper, step, mode, bw = (c.strip() for c in cols)
        where += ' %r' % name
        try:
            lo = decimal.Decimal(lower) * 100000
            hi = decimal.Decimal(upper) * 100000
            st = decimal.Decimal(step) * 100
        except decimal.InvalidOperation:
            errors.append('%s: bad number' % where)
            continue
        if lo != int(lo) or hi != int(hi):
            errors.append('%s: frequency finer than 10 Hz' % where)
        lo, hi = int(lo), int(hi)
        if st != int(st) or int(st) not in STEPS:
            errors.append('%s: step %s kHz is not one of the radio\'s steps' % (where, step))
        elif (hi - lo) % int(st):
            print('warning: %s: range is not a whole number of steps, %s is not scanned' % (where, upper))
        if not lo < hi:
            errors.append('%s: lower must be below upper' % where)
        if lo < RX_LOWER or hi > RX_UPPER:
            errors.append('%s: outside 18..1300 MHz' % where)
        if lo < GAP_UPPER and hi >= GAP_LOWER:
            errors.append('%s: overlaps 63..84 MHz, which the BK4819 cannot receive' % where)
        if lo < 40000000 and hi >= 35000000:
            print('warning: %s: 350..400 MHz needs the 350En setting' % where)
        if mode not in MODULATIONS:
            errors.append('%s: mode must be one of %s' % (where, '/'.join(MODULATIONS)))
        if bw not in BANDWIDTHS:
            errors.append('%s: bandwidth must be W or N' % where)
        missing = [ch for ch in name if ord(ch) >= 0x80 and ord(ch) not in glyphs]
        if missing:
            errors.append('%s: not in the font: %s' % (where, ''.join(missing)))
        if len(name.encode()) >= PRESET_NAME:
            errors.append('%s: name longer than %d bytes' % (where, PRESET_NAME - 1))
        if text_width(name) > PRESET_NAME_WIDTH:
            errors.append('%s: name is %d px, limit %d' % (where, text_width(name), PRESET_NAME_WIDTH))
        if not errors:
            presets.append((name, lo, hi, STEPS.index(int(st)), MODULATIONS[mode], BANDWIDTHS[bw]))
    if errors:
        raise SystemExit('\n'.join(errors))
    return presets


def build_preset_table(presets):
    out = struct.pack('<HH', len(presets), struct.calcsize('<IIBBBB%ds' % PRESET_NAME))
    for name, lo, hi, step, mode, bw in presets:
        out += struct.pack('<IIBBBB%ds' % PRESET_NAME, lo, hi, step, mode, bw, 0, name.encode())
    return out


def build_text_table(pairs):
    entries = sorted((fnv1a(k.encode()), ja.encode() + b'\0', k) for k, ja in pairs)
    for a, b in zip(entries, entries[1:]):
        if a[0] == b[0]:
            raise SystemExit('hash collision: %r / %r' % (a[2], b[2]))
    blob, offs = bytearray(), []
    for _, s, _ in entries:
        offs.append(len(blob))
        blob += s
    assert len(blob) < 0x10000
    out = struct.pack('<HH', len(entries), 0)
    out += struct.pack('<%dI' % len(entries), *(e[0] for e in entries))
    out += struct.pack('<%dH' % len(entries), *offs)
    return out + blob


def sjis_chars():
    """Character of each Shift_JIS table entry, '' where JIS X 0208 has none.
    Python's shift_jis codec follows JIS (0x8160 = U+301C, 0x815F = U+FF3C),
    which matches the font, unlike cp932."""
    out = []
    for lead in SJIS_LEADS:
        for trail in SJIS_TRAILS:
            try:
                ch = bytes((lead, trail)).decode('shift_jis')
            except UnicodeDecodeError:
                ch = ''
            out.append(ch if len(ch) == 1 else '')
    return out


def build_sjis_table(chars, codes):
    index = {c: i for i, c in enumerate(codes)}
    missing = [ch for ch in chars if ch and ord(ch) not in index]
    if missing:
        raise SystemExit('Shift_JIS characters not in the font: ' + ''.join(missing))
    out = b'SJ01' + struct.pack('<HH', len(chars), 0)
    return out + struct.pack('<%dH' % len(chars), *(index[ord(ch)] if ch else 0xFFFF for ch in chars))


def write_sjis_js(chars):
    import json
    SJIS_JS.write_text(
        '// Generated by tools/ja/gen_ja_font.py -- do not edit. RxJa project; not part\n'
        '// of UV Studio. Shift_JIS double-byte codes the radio can show, as characters:\n'
        '// lead bytes LEADS x trail bytes 0x40..0x7E, 0x80..0xFC, "\\0" = none.\n'
        'export const LEADS = %s;\n'
        'export const CHARS = %s;\n'
        % (json.dumps(SJIS_LEADS), json.dumps(''.join(ch or '\0' for ch in chars), ensure_ascii=False)),
        encoding='utf-8')


def main():
    out_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'ja_res.bin'
    glyphs = load_hex(HERE / 'shinonome12_uni.hex')
    half = load_halfwidth_kana(HERE / 'shnm6x12r.bdf')
    assert not set(half) & set(glyphs)
    glyphs.update(half)
    # Shift_JIS 0x815F is U+FF3C (fullwidth reverse solidus); the hex font
    # only has it as U+005C, which the 0x80.. filter below drops
    glyphs.setdefault(0xFF3C, glyphs[0x5C])
    codes = sorted(c for c in glyphs if 0x80 <= c <= 0xFFFF)

    pairs = load_strings(HERE / 'strings_ja.tsv', glyphs)
    check_against_menu(pairs)
    presets = load_presets(HERE / 'presets_ja.tsv', glyphs)

    out = bytearray(MAGIC)
    out += struct.pack('<HHI', len(codes), VERSION, 0)
    out += struct.pack('<%dH' % len(codes), *codes)
    for c in codes:
        out += pack_glyph(rows_to_columns(glyphs[c]))
    out += b'\0' * (-len(out) % 4)
    text = len(out)
    struct.pack_into('<I', out, 8, text)
    out += build_text_table(pairs)
    if presets:
        out += b'\0' * (-len(out) % 4)
        assert pairs and (len(out) - text) // 4 < 0xFFFF
        struct.pack_into('<H', out, text + 2, (len(out) - text) // 4)
        out += build_preset_table(presets)
        out += b'\0' * (-len(out) % 4)
        chars = sjis_chars()
        out += build_sjis_table(chars, codes)
    else:
        raise SystemExit('presets_ja.tsv is needed: the Shift_JIS table follows the preset table')

    end = FLASH_BASE + len(out)
    assert end <= FLASH_LIMIT, 'image overflows SPI region: ends at 0x%06X' % end
    out_path.write_bytes(out)
    write_sjis_js(chars)
    print('glyphs: %d (U+%04X..U+%04X), strings: %d, presets: %d'
          % (len(codes), codes[0], codes[-1], len(pairs), len(presets)))
    print('%s: %d bytes, SPI 0x%06X..0x%06X' % (out_path.name, len(out), FLASH_BASE, end))


if __name__ == '__main__':
    main()
