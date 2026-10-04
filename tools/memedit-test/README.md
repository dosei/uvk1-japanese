# Memory channel editor tests

Tests for the RxJa Tools memory channel editor (`web/js/rxja-memmap.js`,
`web/js/rxja-csv.js`, `web/js/rxja-mem.js`). Kept outside `web/` so they are
not published on GitHub Pages.

| File | What it does |
|---|---|
| `unit.mjs` | Codec and CSV unit tests. `node unit.mjs [channels.csv]` also round-trips a whole CSV (CSV → image → CSV). |
| `chirp_golden.py` | Compares the codec with CHIRP and the armel F4HWN driver, byte for byte (CSV → image) and memory by memory (image → CSV → CHIRP). |
| `gen_varied.mjs` | Writes a CSV that mixes every mode, step, power, duplex and tone, for the two tests above. |
| `cli.mjs` | `csv2img` / `img2csv` front end used by `chirp_golden.py`. |
| `mock-serial.js` | A fake radio on `navigator.serial` (0x0514 / 0x051B / 0x051D / 0x05DD) for driving the page without hardware, e.g. with Playwright `page.addScriptTag({ path })`. |

```sh
node tools/memedit-test/gen_varied.mjs /path/varied.csv
node tools/memedit-test/unit.mjs /path/varied.csv
# CHIRP: git clone https://github.com/kk7ds/chirp; pip install pyserial lark
python tools/memedit-test/chirp_golden.py /path/chirp f4hwn.chirp.v6.0.0.py /path/varied.csv
```

Intended differences from CHIRP, normalised by `chirp_golden.py`:

- **Name padding.** CHIRP pads names with spaces. The editor, like the firmware, pads with zeros. An unchanged name keeps its stored bytes.
- **Scan list.** CHIRP has no CSV column for the scan list and writes 0. The editor reads its extra `ScanList` column.
- **Transmit power.** The driver never matches a CSV power such as `1.0W` and stores USER. The editor keeps the nearest power level.
- **Attribute bits 5-7 of a newly used slot.** CHIRP leaves them at 1 and the editor sets them to 0. Bit 7 is the exclude flag, which the firmware clears at boot.
