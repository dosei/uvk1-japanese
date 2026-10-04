#!/usr/bin/env python3
"""Check the RxJa memory editor's codec against CHIRP and the armel F4HWN driver.

    python chirp_golden.py <chirp source dir> <f4hwn.chirp.vX.py> <channels.csv>

A: CSV -> image through CHIRP (generic_csv + driver set_memory) and through
   cli.mjs csv2img must give the same channel bytes.
B: an image -> CSV through cli.mjs img2csv, read back by CHIRP's generic_csv,
   must match the memories the driver's get_memory reads from that image.
Known, intended differences are normalised:
  - names: CHIRP pads with spaces, the editor (like the firmware) with zeros
  - attribute bits 5-7 of a fresh slot: CHIRP leaves them 1, the editor 0
    (bit 7 is the exclude flag, which the firmware clears at boot anyway)
  - scan list byte: CHIRP has no CSV column for it (the editor's ScanList
    column is unknown to CHIRP and ignored), so CHIRP writes 0
  - TX power bits: the driver compares a CSV power ("1.0W") with its own
    level names, never matches and always stores USER; the editor keeps the
    nearest level (irrelevant for receiving, but it survives a round trip)
"""
import importlib.util
import subprocess
import sys
import tempfile
import types
from pathlib import Path

chirp_dir, driver_path, csv_path = map(Path, sys.argv[1:4])
here = Path(__file__).resolve().parent
sys.path.insert(0, str(chirp_dir))
sys.modules['wx'] = types.ModuleType('wx')      # the driver only uses wx for settings dialogs

from chirp import chirp_common, errors, memmap  # noqa: E402
from chirp.drivers import generic_csv           # noqa: E402

spec = importlib.util.spec_from_file_location('chirp.drivers.f4hwn_golden', driver_path)
drv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drv)
Radio = next(c for c in vars(drv).values()
             if isinstance(c, type) and issubclass(c, chirp_common.CloneModeRadio)
             and getattr(c, 'MODEL', '') and c.__module__ == drv.__name__)

IMAGE = 0x886E
CHANNELS = 1024


def node(*args):
    subprocess.run(['node', '--no-warnings', str(here / 'cli.mjs'), *map(str, args)], check=True)


def chirp_from_csv(path):
    csvr = generic_csv.CSVRadio(str(path))
    radio = Radio(memmap.MemoryMapBytes(b'\xFF' * drv.MEM_SIZE))
    lo, hi = csvr.get_features().memory_bounds
    for n in range(lo, hi + 1):
        mem = csvr.get_memory(n)
        if not mem.empty:
            radio.set_memory(mem)
    return radio


def normalise(img):
    img = bytearray(img[:IMAGE])
    for i in range(CHANNELS):
        n = 0x4000 + i * 16
        name = bytes(img[n:n + 16]).split(b'\0')[0].rstrip(b' ')
        img[n:n + 16] = name.ljust(16, b'\0')
        img[0x8000 + i * 2] &= 0x1F
        img[0x8000 + i * 2 + 1] = 0
        img[i * 16 + 12] &= 0xE3
    return bytes(img)


failures = 0
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)

    # A: CSV -> image
    radio = chirp_from_csv(csv_path)
    want = normalise(radio.get_mmap().get_packed())
    node('csv2img', csv_path, tmp / 'js.bin')
    got = normalise((tmp / 'js.bin').read_bytes())
    for i in range(CHANNELS):
        for base, size, what in ((0, 16, 'record'), (0x4000, 16, 'name'), (0x8000, 2, 'attr')):
            o = base + i * size
            if want[o:o + size] != got[o:o + size]:
                failures += 1
                print(f'A ch{i + 1} {what}: chirp {want[o:o + size].hex()} js {got[o:o + size].hex()}')
    print(f'A: CSV -> image compared {CHANNELS} slots, {failures} differences')

    # B: image (the one CHIRP built) -> CSV by the editor, read back by CHIRP
    (tmp / 'chirp.bin').write_bytes(radio.get_mmap().get_packed())
    node('img2csv', tmp / 'chirp.bin', tmp / 'js.csv')
    back = generic_csv.CSVRadio(str(tmp / 'js.csv'))
    b_fail = 0
    for n in range(1, CHANNELS + 1):
        m1 = radio.get_memory(n)
        try:
            m2 = back.get_memory(n)
        except errors.InvalidMemoryLocation:
            m2 = chirp_common.Memory(n, empty=True)
        if m1.empty != m2.empty:
            b_fail += 1
            print(f'B ch{n}: empty {m1.empty} vs {m2.empty}')
            continue
        if m1.empty:
            continue
        for attr in ('freq', 'name', 'duplex', 'offset', 'mode', 'tmode', 'rtone', 'ctone', 'dtcs',
                     'rx_dtcs', 'dtcs_polarity', 'cross_mode', 'tuning_step'):
            a, b = getattr(m1, attr), getattr(m2, attr)
            if attr == 'cross_mode' and m1.tmode != 'Cross':
                continue
            if a != b:
                b_fail += 1
                print(f'B ch{n} {attr}: chirp {a!r} js {b!r}')
        if abs(chirp_common.dBm_to_watts(float(m1.power)) - chirp_common.dBm_to_watts(float(m2.power))) > 0.011:  # USER: CHIRP 0 W, editor 0.01 W
            b_fail += 1
            print(f'B ch{n} power: chirp {m1.power} js {m2.power}')
    print(f'B: image -> CSV compared, {b_fail} differences')
    failures += b_fail

sys.exit(1 if failures else 0)
