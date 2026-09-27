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

Image layout (little-endian), written to SPI at JA_FLASH_BASE (App/ui/ja.h):
    +0   char[4]  magic "JF03" (rxja-v0.1.0: "JF12", so its upload.py refuses this)
    +4   u16      glyph count N
    +6   u16      format version
    +8   u32      text table offset T (0 = none)
    +12  u16[N]   code points, ascending
    +..  N x 18   glyphs: 12 columns x 12 bits, bit 0 = top row; column c is
                  bits 12c..12c+11 of the 144-bit little-endian glyph
    +T   u16      string count M, u16 padding
    +..  u32[M]   FNV-1a hash of the English key, ascending
    +..  u16[M]   offset of each string from the end of this array
    +..           UTF-8 strings, NUL terminated
Usage: gen_ja_font.py [out.bin]   (default: tools/ja/ja_res.bin)
"""
import pathlib
import re
import struct
import sys

HERE = pathlib.Path(__file__).resolve().parent
MENU_C = HERE.parent.parent / 'App' / 'ui' / 'menu.c'
MAIN_C = HERE.parent.parent / 'App' / 'ui' / 'main.c'
# other files with translated strings, searched for the keys
SOURCES = [MAIN_C] + [HERE.parent.parent / 'App' / f for f in (
    'ui/welcome.c', 'ui/helper.c', 'ui/scanner.c', 'ui/fmradio.c', 'app/rxtx_log.c')]
MAGIC = b'JF03'             # JA_MAGIC in App/ui/ja.c
VERSION = 3
TEXT_MAX = 48               # JA_TEXT_MAX in App/ui/ja.h, incl. NUL
FLASH_BASE = 0x122000      # JA_FLASH_BASE: right after the overlay Apps (0x102000..0x122000)
FLASH_LIMIT = 0x14C000     # voice prompts; 0x0C0000..0x100000 are multiboot config banks
HALF_FIRST, HALF_LAST = 0xFF61, 0xFF9F  # half-width katakana, 6 px (HALF_WIDTH in ja.c)


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


def main():
    out_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'ja_res.bin'
    glyphs = load_hex(HERE / 'shinonome12_uni.hex')
    half = load_halfwidth_kana(HERE / 'shnm6x12r.bdf')
    assert not set(half) & set(glyphs)
    glyphs.update(half)
    codes = sorted(c for c in glyphs if 0x80 <= c <= 0xFFFF)

    pairs = load_strings(HERE / 'strings_ja.tsv', glyphs)
    check_against_menu(pairs)

    out = bytearray(MAGIC)
    out += struct.pack('<HHI', len(codes), VERSION, 0)
    out += struct.pack('<%dH' % len(codes), *codes)
    for c in codes:
        out += pack_glyph(rows_to_columns(glyphs[c]))
    out += b'\0' * (-len(out) % 4)
    struct.pack_into('<I', out, 8, len(out))
    out += build_text_table(pairs)

    end = FLASH_BASE + len(out)
    assert end <= FLASH_LIMIT, 'image overflows SPI region: ends at 0x%06X' % end
    out_path.write_bytes(out)
    print('glyphs: %d (U+%04X..U+%04X), strings: %d' % (len(codes), codes[0], codes[-1], len(pairs)))
    print('%s: %d bytes, SPI 0x%06X..0x%06X' % (out_path.name, len(out), FLASH_BASE, end))


if __name__ == '__main__':
    main()
