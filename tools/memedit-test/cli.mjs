// Command line front end of the editor's codec, for chirp_golden.py.
//   node cli.mjs csv2img in.csv out.bin [base.bin]   CSV -> image (0x0000-0x886D)
//   node cli.mjs img2csv in.bin out.csv              image -> CSV
import { readFileSync, writeFileSync } from 'node:fs';
import * as M from '../../web/js/rxja-memmap.js';
import * as C from '../../web/js/rxja-csv.js';

const [cmd, src, dst, base] = process.argv.slice(2);
if (cmd === 'csv2img') {
  const { records, badLines } = C.readTable(C.decodeText(readFileSync(src)).text);
  if (badLines.length) throw new Error(`bad lines ${badLines}`);
  const chans = records.map(r => {
    const x = M.rowToChannel(r);
    if (!x.ch) throw new Error(`line ${r.__line}: ${x.error} ${x.value}`);
    return x.ch;
  });
  const snap = base ? new Uint8Array(readFileSync(base)).slice(0, M.IMAGE_SIZE) : M.newImage();
  writeFileSync(dst, M.buildImage(snap, chans, null));
} else if (cmd === 'img2csv') {
  const image = new Uint8Array(readFileSync(src)).slice(0, M.IMAGE_SIZE);
  writeFileSync(dst, C.writeCsv(M.CSV_COLUMNS, M.decodeAll(image).map(M.channelToRow)));
} else {
  throw new Error('usage: cli.mjs csv2img|img2csv ...');
}
