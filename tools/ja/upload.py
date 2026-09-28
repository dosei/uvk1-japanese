#!/usr/bin/env python3
"""
Upload the Japanese resource image (gen_ja_font.py) to the radio's SPI flash.

Uses the firmware's UART commands (ENABLE_JAPANESE, App/app/uart.c):
    0x0514 hello     -> 0x0515  latches the session timestamp
    0x0744 res write -> 0x0745  offset u32, len u16, timestamp u32, bytes
    0x0746 res read  -> 0x0747  offset u32, len u16 (<= 128)
Offsets are relative to JA_FLASH_BASE (0x122000). The withdrawn test builds
(before the version numbers were restarted at v0.1.0) put the image at
0x0C0000 over the multiboot config banks with commands 0x0740/0x0742; the IDs
and the magic changed with the address so that neither this tool nor this
image can be used with those builds or their upload.py.

The magic "JF03" is written last, so an interrupted upload leaves an image the
firmware ignores (it then shows no Japanese) rather than a half-written one.
Unchanged bytes are skipped by the firmware, so a re-upload is quick.

Usage: upload.py PORT [image.bin] [--no-verify] [--baud N]
       upload.py --selftest
"""
import argparse
import pathlib
import struct
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent

OBFUSCATION = bytes([0x16, 0x6C, 0x14, 0xE6, 0x2E, 0x91, 0x0D, 0x40,
                     0x21, 0x35, 0xD5, 0x40, 0x13, 0x03, 0xE9, 0x80])
CHUNK = 128
FLASH_BASE = 0x122000      # JA_FLASH_BASE in App/ui/ja.h
REGION_SIZE = 0x2A000      # JA_FLASH_SIZE
MAGIC = b'JF03'            # JA_MAGIC in App/ui/ja.c
VERSION = 3                # JA_VERSION in App/ui/ja.c
MAGIC_LEN = 4
RETRIES = 3

STATUS = {0: 'ok', 1: 'bad timestamp (no hello?)', 2: 'out of range'}


def crc16_xmodem(data):
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def xor(data):
    return bytes(b ^ OBFUSCATION[i % 16] for i, b in enumerate(data))


def frame(payload):
    body = payload + struct.pack('<H', crc16_xmodem(payload))
    return b'\xAB\xCD' + struct.pack('<H', len(payload)) + xor(body) + b'\xDC\xBA'


def selftest():
    # UV Studio's pre-built reboot frame (0x05DD, empty payload)
    want = bytes([0xAB, 0xCD, 0x04, 0x00, 0xCB, 0x69,
                  0x14, 0xE6, 0x5B, 0xEB, 0xDC, 0xBA])
    got = frame(struct.pack('<HH', 0x05DD, 0))
    print('reboot frame', got.hex(' '), 'OK' if got == want else 'MISMATCH')
    return got == want


class Radio:
    def __init__(self, port, baud):
        import serial     # pyserial, only needed when talking to a radio
        self.ser = serial.Serial(port, baud, timeout=0.1)
        self.ser.reset_input_buffer()
        self.buf = bytearray()
        self.ts = int(time.time()) & 0xFFFFFFFF

    def _reply(self, want_id, timeout=2.0):
        """Return the payload of the next reply with ID want_id, or None."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.buf += self.ser.read(self.ser.in_waiting or 1)
            while True:
                i = self.buf.find(b'\xAB\xCD')
                if i < 0:
                    del self.buf[:-1]
                    break
                del self.buf[:i]
                if len(self.buf) < 4:
                    break
                size = self.buf[2] | (self.buf[3] << 8)
                if size > 250:                  # not a reply header, resync
                    del self.buf[:2]
                    continue
                if len(self.buf) < 4 + size + 4:
                    break
                ok = self.buf[4 + size + 2:4 + size + 4] == b'\xDC\xBA'
                body = xor(bytes(self.buf[4:4 + size]))
                del self.buf[:4 + size + 4 if ok else 2]
                if ok and size >= 4 and (body[0] | (body[1] << 8)) == want_id:
                    return body[4:]
        return None

    def call(self, payload, want_id):
        for _ in range(RETRIES):
            self.ser.write(frame(payload))
            r = self._reply(want_id)
            if r is not None:
                return r
        cmd = payload[0] | (payload[1] << 8)
        hint = ' (is the radio running RxJa?)' if cmd in (0x0744, 0x0746) else ''
        raise SystemExit('no reply to 0x%04X%s' % (cmd, hint))

    def hello(self):
        r = self.call(struct.pack('<HHI', 0x0514, 4, self.ts), 0x0515)
        return r.split(b'\0', 1)[0].decode('ascii', 'replace')

    def write(self, offset, data):
        r = self.call(struct.pack('<HHIHI', 0x0744, 10 + len(data), offset, len(data), self.ts)
                      + data, 0x0745)
        r_off, status = struct.unpack_from('<IB', r)
        if r_off != offset or status:
            raise SystemExit('write 0x%05X: %s' % (offset, STATUS.get(status, status)))

    def read(self, offset, length):
        r = self.call(struct.pack('<HHIH', 0x0746, 6, offset, length), 0x0747)
        r_off, r_len, status = struct.unpack_from('<IHB', r)
        if r_off != offset or status or r_len != length:
            raise SystemExit('read 0x%05X: %s' % (offset, STATUS.get(status, status)))
        return r[8:8 + r_len]


def progress(what, done, total, t0):
    rate = done / max(time.monotonic() - t0, 1e-3)
    sys.stderr.write('\r%s %6d / %d bytes  %5.1f KB/s' % (what, done, total, rate / 1024))
    if done == total:
        sys.stderr.write('\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('port', nargs='?')
    ap.add_argument('image', nargs='?', default=str(HERE / 'ja_res.bin'))
    ap.add_argument('--baud', type=int, default=38400)
    ap.add_argument('--no-verify', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()

    if a.selftest:
        sys.exit(0 if selftest() else 1)
    if not a.port:
        ap.error('PORT is required')

    image = pathlib.Path(a.image).read_bytes()
    if image[:MAGIC_LEN] != MAGIC or len(image) > REGION_SIZE:
        raise SystemExit('%s is not a resource image' % a.image)
    if struct.unpack_from('<H', image, 6)[0] != VERSION:
        raise SystemExit('%s: format version %d, this tool and the firmware need %d '
                         '(rebuild it with gen_ja_font.py)' % (a.image, struct.unpack_from('<H', image, 6)[0], VERSION))

    radio = Radio(a.port, a.baud)
    print('radio:', radio.hello())

    # everything except the magic, then the magic
    body = b'\xFF' * MAGIC_LEN + image[MAGIC_LEN:]
    t0 = time.monotonic()
    for off in range(0, len(body), CHUNK):
        radio.write(off, body[off:off + CHUNK])
        progress('write ', min(off + CHUNK, len(body)), len(body), t0)
    radio.write(0, image[:MAGIC_LEN])

    if not a.no_verify:
        t0 = time.monotonic()
        for off in range(0, len(image), CHUNK):
            want = image[off:off + CHUNK]
            if radio.read(off, len(want)) != want:
                raise SystemExit('\nverify failed at offset 0x%05X' % off)
            progress('verify', off + len(want), len(image), t0)
    print('done: %d bytes at SPI 0x%06X' % (len(image), FLASH_BASE))


if __name__ == '__main__':
    main()
