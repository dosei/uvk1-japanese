// Japanese resource upload over Web Serial -- a port of tools/ja/upload.py.
//
// Uses the firmware's UART commands (ENABLE_JAPANESE, App/app/uart.c):
//     0x0514 hello     -> 0x0515  latches the session timestamp
//     0x0744 res write -> 0x0745  offset u32, len u16, timestamp u32, bytes
//     0x0746 res read  -> 0x0747  offset u32, len u16 (<= 128)
// Offsets are relative to JA_FLASH_BASE. Keep the constants in step with
// upload.py, App/ui/ja.h and App/ui/ja.c.

export const FLASH_BASE = 0x122000;   // JA_FLASH_BASE in App/ui/ja.h
export const REGION_SIZE = 0x2A000;   // JA_FLASH_SIZE
export const MAGIC = 'JF03';          // JA_MAGIC in App/ui/ja.c
export const VERSION = 3;             // JA_VERSION in App/ui/ja.c
export const BAUD = 38400;

const OBFUSCATION = [0x16, 0x6C, 0x14, 0xE6, 0x2E, 0x91, 0x0D, 0x40,
                     0x21, 0x35, 0xD5, 0x40, 0x13, 0x03, 0xE9, 0x80];
const CHUNK = 128;
const MAGIC_LEN = 4;
const RETRIES = 3;
const REPLY_TIMEOUT_MS = 2000;

const STATUS = {0: 'ok', 1: '接続手順の不一致（最初からやり直してください）', 2: '範囲外'};

export class RadioError extends Error {}

export function crc16xmodem(data) {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
  }
  return crc;
}

export function xor(data) {
  return data.map((b, i) => b ^ OBFUSCATION[i % 16]);
}

export function frame(payload) {
  const crc = crc16xmodem(payload);
  const body = new Uint8Array(payload.length + 2);
  body.set(payload);
  body[payload.length] = crc & 0xFF;
  body[payload.length + 1] = crc >> 8;
  const out = new Uint8Array(4 + body.length + 2);
  out.set([0xAB, 0xCD, payload.length & 0xFF, payload.length >> 8]);
  out.set(xor(body), 4);
  out.set([0xDC, 0xBA], 4 + body.length);
  return out;
}

// Little-endian packer: pack(['H', 0x0514], ['I', ts], ...) and raw Uint8Array parts
function pack(...parts) {
  const size = parts.reduce((n, p) => n + (p instanceof Uint8Array ? p.length : {B: 1, H: 2, I: 4}[p[0]]), 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const p of parts) {
    if (p instanceof Uint8Array) { out.set(p, o); o += p.length; continue; }
    const [t, v] = p;
    if (t === 'B') dv.setUint8(o, v);
    else if (t === 'H') dv.setUint16(o, v, true);
    else dv.setUint32(o, v >>> 0, true);
    o += {B: 1, H: 2, I: 4}[t];
  }
  return out;
}

const hex4 = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
const hex5 = n => '0x' + n.toString(16).toUpperCase().padStart(5, '0');

// Returns an error message, or null when the image is usable.
export function checkImage(image) {
  if (image.length < 8 || String.fromCharCode(...image.slice(0, MAGIC_LEN)) !== MAGIC)
    return '日本語データ（ja_res.bin）ではありません';
  if (image.length > REGION_SIZE)
    return `大きすぎます（${image.length} バイト、上限 ${REGION_SIZE}）`;
  const ver = image[6] | (image[7] << 8);
  if (ver !== VERSION)
    return `形式の版が違います（${ver}、このページとファームは ${VERSION}）。対応する版の ja_res.bin を使ってください`;
  return null;
}

export async function sha256hex(data) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

export class Radio {
  // port: a SerialPort from navigator.serial.requestPort()
  constructor(port) {
    this.port = port;
    this.buf = new Uint8Array(0);
    this.wake = null;
    this.ts = Math.floor(Date.now() / 1000) >>> 0;
  }

  async open() {
    await this.port.open({baudRate: BAUD});
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.reading = this._readLoop();
  }

  async close() {
    try { await this.reader?.cancel(); } catch {}
    await this.reading;
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port.close(); } catch {}
  }

  async _readLoop() {
    try {
      for (;;) {
        const {value, done} = await this.reader.read();
        if (done) break;
        const b = new Uint8Array(this.buf.length + value.length);
        b.set(this.buf);
        b.set(value, this.buf.length);
        this.buf = b;
        this.wake?.();
      }
    } catch (e) {
      this.readError = e;
      this.wake?.();
    }
  }

  // Wait until data arrives or ms elapses
  _waitData(ms) {
    return new Promise(resolve => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.wake = done;
    }).finally(() => { this.wake = null; });
  }

  // Return the payload of the next reply with ID wantId, or null.
  async _reply(wantId, timeoutMs = REPLY_TIMEOUT_MS) {
    const end = performance.now() + timeoutMs;
    for (;;) {
      while (true) {
        const b = this.buf;
        let i = -1;
        for (let k = 0; k + 1 < b.length; k++)
          if (b[k] === 0xAB && b[k + 1] === 0xCD) { i = k; break; }
        if (i < 0) { this.buf = b.slice(b.length ? b.length - 1 : 0); break; }
        this.buf = b.slice(i);
        if (this.buf.length < 4) break;
        const size = this.buf[2] | (this.buf[3] << 8);
        if (size > 250) { this.buf = this.buf.slice(2); continue; }    // not a reply header, resync
        if (this.buf.length < 4 + size + 4) break;
        const ok = this.buf[4 + size + 2] === 0xDC && this.buf[4 + size + 3] === 0xBA;
        const body = xor(this.buf.slice(4, 4 + size));
        this.buf = this.buf.slice(ok ? 4 + size + 4 : 2);
        if (ok && size >= 4 && (body[0] | (body[1] << 8)) === wantId)
          return body.slice(4);
      }
      if (this.readError) throw new RadioError('シリアルポートの読み込みに失敗しました: ' + this.readError.message);
      const left = end - performance.now();
      if (left <= 0) return null;
      await this._waitData(left);
    }
  }

  async call(payload, wantId) {
    for (let n = 0; n < RETRIES; n++) {
      await this.writer.write(frame(payload));
      const r = await this._reply(wantId);
      if (r !== null) return r;
    }
    const cmd = payload[0] | (payload[1] << 8);
    const hint = cmd === 0x0744 || cmd === 0x0746
      ? '（本体のファームが RxJa ではない可能性があります）'
      : '（ケーブル・ポート・本体の電源を確認してください）';
    throw new RadioError(`${hex4(cmd)} に応答がありません${hint}`);
  }

  async hello() {
    const r = await this.call(pack(['H', 0x0514], ['H', 4], ['I', this.ts]), 0x0515);
    const end = r.indexOf(0);
    return new TextDecoder('ascii').decode(end < 0 ? r : r.slice(0, end));
  }

  async write(offset, data) {
    const r = await this.call(pack(['H', 0x0744], ['H', 10 + data.length], ['I', offset],
                                   ['H', data.length], ['I', this.ts], data), 0x0745);
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const rOff = dv.getUint32(0, true), status = r[4];
    if (rOff !== offset || status)
      throw new RadioError(`書き込み ${hex5(offset)}: ${STATUS[status] ?? status}`);
  }

  async read(offset, length) {
    const r = await this.call(pack(['H', 0x0746], ['H', 6], ['I', offset], ['H', length]), 0x0747);
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const rOff = dv.getUint32(0, true), rLen = dv.getUint16(4, true), status = r[6];
    if (rOff !== offset || status || rLen !== length)
      throw new RadioError(`読み出し ${hex5(offset)}: ${STATUS[status] ?? status}`);
    return r.slice(8, 8 + rLen);
  }

  // Everything except the magic, then the magic, so an interrupted upload
  // leaves an image the firmware ignores rather than a half-written one.
  // onProgress(phase, done, total); signal: AbortSignal to stop between chunks.
  async upload(image, {verify = true, onProgress = () => {}, signal} = {}) {
    const body = image.slice();
    body.fill(0xFF, 0, MAGIC_LEN);
    for (let off = 0; off < body.length; off += CHUNK) {
      signal?.throwIfAborted();
      await this.write(off, body.slice(off, off + CHUNK));
      onProgress('write', Math.min(off + CHUNK, body.length), body.length);
    }
    await this.write(0, image.slice(0, MAGIC_LEN));

    if (!verify) return;
    onProgress('verify', 0, image.length);
    for (let off = 0; off < image.length; off += CHUNK) {
      signal?.throwIfAborted();
      const want = image.slice(off, off + CHUNK);
      const got = await this.read(off, want.length);
      if (got.length !== want.length || got.some((b, i) => b !== want[i]))
        throw new RadioError(`照合に失敗しました（オフセット ${hex5(off)}）`);
      onProgress('verify', off + want.length, image.length);
    }
  }
}
