"""QR codes for the SysInf CODE/WIKI pages, as the arrays in App/ui/welcome.c.
Version 4 (33x33), no quiet zone. Rows 0..31: 4 fb-lines x 33 columns, bit 0 = top;
row 32: 5 bytes, bit (qx & 7) of byte qx >> 3.  137 bytes total.
Prints the C arrays; each code is checked by unpacking it and decoding with zxing.
Needs: pip install segno zxing-cpp pillow"""
import segno, zxingcpp
from PIL import Image

URLS = {'GitHub': 'https://github.com/dosei/uvk1-japanese',
        'GitHub_Wiki': 'https://github.com/dosei/uvk1-japanese/wiki'}


def matrix(url, error):
    q = segno.make(url, version=4, error=error, boost_error=False, micro=False)
    assert q.version == 4 and q.error == error.upper(), (q.version, q.error)
    m = [[bool(v) for v in row] for row in q.matrix_iter(border=0)]
    assert len(m) == 33 and all(len(r) == 33 for r in m)
    return m


def pack(m):
    out = []
    for line in range(4):
        for x in range(33):
            b = 0
            for bit in range(8):
                if m[line * 8 + bit][x]:
                    b |= 1 << bit
            out.append(b)
    for i in range(5):
        b = 0
        for bit in range(8):
            x = i * 8 + bit
            if x < 33 and m[32][x]:
                b |= 1 << bit
        out.append(b)
    assert len(out) == 137
    return out


def unpack(data):  # same test as QR_Draw
    return [[bool((data[(y >> 3) * 33 + x] >> (y & 7)) & 1) if y < 32 else
             bool((data[132 + (x >> 3)] >> (x & 7)) & 1) for x in range(33)] for y in range(33)]


def decode(m):
    s = 8
    im = Image.new('L', ((33 + 8) * s,) * 2, 255)
    px = im.load()
    for y in range(33):
        for x in range(33):
            if m[y][x]:
                for dy in range(s):
                    for dx in range(s):
                        px[(x + 4) * s + dx, (y + 4) * s + dy] = 0
    r = zxingcpp.read_barcodes(im)
    return r[0].text if r else None


def main():
    lines = []
    for name, url in URLS.items():
        m = matrix(url, 'q')
        data = pack(m)
        assert unpack(data) == m
        got = decode(unpack(data))
        assert got == url, got
        lines.append('// %s (version 4, EC level Q)' % url)
        lines.append('static const uint8_t BITMAP_QR_%s_Compressed[137] = {' % name)
        for i in range(0, 137, 16):
            lines.append('    ' + ', '.join('0x%02X' % b for b in data[i:i + 16]) + ',')
        lines.append('};')
        lines.append('')
    print('\n'.join(lines[:-1]))


main()
