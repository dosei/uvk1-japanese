// Writes a CSV that walks through every mode, step, power, duplex and tone
// combination the editor handles, for chirp_golden.py.
//   node gen_varied.mjs out.csv
import { writeFileSync } from 'node:fs';
import * as M from '../../web/js/rxja-memmap.js';
import * as C from '../../web/js/rxja-csv.js';

let seed = 1;   // mulberry32
const rnd = n => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};
const pick = a => a[rnd(a.length)];
const tone = () => {
  const k = rnd(3);
  if (k === 0) return { mode: '', value: null, pol: 'N' };
  if (k === 1) return { mode: 'Tone', value: pick(M.CTCSS_TONES), pol: 'N' };
  return { mode: 'DTCS', value: pick(M.DTCS_CODES), pol: pick(['N', 'R']) };
};

const rows = [];
for (let i = 0; i < 400; i++) {
  const number = 1 + rnd(M.CHANNELS);
  if (rows.some(r => r.Location === String(number))) continue;
  const step = pick(M.STEPS);
  // a frequency on a 10 Hz grid inside the receive range
  const freq = M.MIN_HZ + rnd((M.MAX_HZ - M.MIN_HZ) / 10) * 10;
  const duplex = pick(['', '+', '-']);
  const ch = {
    number, name: pick(['', 'A', 'TEST 1', 'ABCDEFGHIJ', 'x-y_z!']), comment: '',
    freq, offset: duplex ? (1 + rnd(9999)) * 1000 : 0, duplex,
    txTone: tone(), rxTone: tone(), mode: pick(M.MODES), step, power: rnd(8),
    scanlist: rnd(26), compander: 0,
  };
  rows.push(M.channelToRow(ch));
}
rows.sort((a, b) => a.Location - b.Location);
writeFileSync(process.argv[2], C.writeCsv(M.CSV_COLUMNS, rows));
console.log(`${rows.length} rows`);
