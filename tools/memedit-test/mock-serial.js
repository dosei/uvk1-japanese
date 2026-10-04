// A fake UV-K1 on navigator.serial for testing the memory editor without a
// radio: answers 0x0514 / 0x051B / 0x051D / 0x05DD like App/app/uart.c over an
// EEPROM-compatible image of 0x10000 bytes. Inject into the page, then
//   window.mockRadio.image     the radio's memory
//   window.mockRadio.log       [{cmd, addr, len}] of commands received
//   window.mockRadio.rebooted  count of 0x05DD
//   window.mockRadio.info      0x0748 answer { flags, version }, or null for
//                              firmware before RxJa v1.1.0 (no answer)
//   window.mockRadio.stale     true: send a stale reply (previous request's
//                              offset) before each real one, like a late reply
//                              to a retried request
(function () {
  const KEY = [0x16, 0x6C, 0x14, 0xE6, 0x2E, 0x91, 0x0D, 0x40, 0x21, 0x35, 0xD5, 0x40, 0x13, 0x03, 0xE9, 0x80];
  const xor = d => d.map((b, i) => b ^ KEY[i % 16]);
  const radio = {
    image: new Uint8Array(0x10000).fill(0xFF),
    version: 'F4HWN v6.0.0',
    log: [],
    rebooted: 0,
    stale: false,
    info: { flags: 3, version: 'v1.1.0' },
    last: null,
    ts: null,
  };
  window.mockRadio = radio;

  function reply(id, data) {
    const body = new Uint8Array(4 + data.length);
    body[0] = id & 0xFF; body[1] = id >> 8; body[2] = data.length & 0xFF; body[3] = data.length >> 8;
    body.set(data, 4);
    const out = new Uint8Array(4 + body.length + 4);
    out.set([0xAB, 0xCD, body.length & 0xFF, body.length >> 8]);
    out.set(xor(body), 4);
    out.set([0xFF, 0xFF, 0xDC, 0xBA], 4 + body.length);   // CRC not checked by the page
    return out;
  }

  function handle(p, push) {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const id = dv.getUint16(0, true);
    if (id === 0x0514) {
      radio.ts = dv.getUint32(4, true);
      const v = new Uint8Array(16);
      v.set(new TextEncoder().encode(radio.version));
      push(reply(0x0515, v));
    } else if (id === 0x051B) {
      const addr = dv.getUint16(4, true), len = p[6], ts = dv.getUint32(8, true);
      radio.log.push({ cmd: 'read', addr, len });
      if (ts !== radio.ts || len > 128) return;
      const d = new Uint8Array(4 + len);
      d[0] = addr & 0xFF; d[1] = addr >> 8; d[2] = len;
      d.set(radio.image.slice(addr, addr + len), 4);
      if (radio.stale && radio.last) push(radio.last);
      push(radio.last = reply(0x051C, d));
    } else if (id === 0x051D) {
      const addr = dv.getUint16(4, true), len = p[6], ts = dv.getUint32(8, true);
      radio.log.push({ cmd: 'write', addr, len });
      if (ts !== radio.ts) return;
      for (let i = 0; i < Math.floor(len / 8); i++)
        radio.image.set(p.slice(12 + i * 8, 12 + i * 8 + 8), addr + i * 8);
      if (radio.stale && radio.last) push(radio.last);
      push(radio.last = reply(0x051E, new Uint8Array([addr & 0xFF, addr >> 8])));
    } else if (id === 0x0748) {
      if (!radio.info) return;
      const d = new Uint8Array(20);
      d[0] = radio.info.flags;
      d.set(new TextEncoder().encode(radio.info.version), 4);
      push(reply(0x0749, d));
    } else if (id === 0x05DD) {
      radio.rebooted++;
    }
  }

  function makePort() {
    let controller;
    let buf = new Uint8Array(0);
    const port = {
      readable: null,
      writable: null,
      getInfo: () => ({ usbVendorId: 0x1A86, usbProductId: 0x7523 }),
      async open() {
        port.readable = new ReadableStream({ start(c) { controller = c; } });
        port.writable = new WritableStream({
          write(chunk) {
            const b = new Uint8Array(buf.length + chunk.length);
            b.set(buf); b.set(chunk, buf.length); buf = b;
            for (;;) {
              const i = buf.findIndex((x, k) => x === 0xAB && buf[k + 1] === 0xCD);
              if (i < 0 || buf.length < i + 4) break;
              const size = buf[i + 2] | (buf[i + 3] << 8);
              if (buf.length < i + 4 + size + 4) break;
              const body = xor(buf.slice(i + 4, i + 4 + size + 2)).slice(0, size);
              buf = buf.slice(i + 4 + size + 4);
              // a short delay like the real link
              setTimeout(() => handle(body, out => controller.enqueue(out)), 2);
            }
          },
        });
      },
      async close() {},
    };
    return port;
  }

  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: {
      async requestPort() { return makePort(); },
      async getPorts() { return []; },
      addEventListener() {},
      removeEventListener() {},
    },
  });
})();
