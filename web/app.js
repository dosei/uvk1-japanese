import {Radio, RadioError, checkImage, sha256hex, FLASH_BASE} from './rxja.js';

const $ = id => document.getElementById(id);
const startBtn = $('start'), stopBtn = $('stop'), fileInput = $('file'), verifyBox = $('verify');

let bundled = null;     // {image, info} from ja_res.json + ja_res.bin
let picked = null;      // {image, name}
let busy = false;

function log(msg) {
  const t = new Date().toLocaleTimeString('ja-JP', {hour12: false});
  $('log').textContent += `[${t}] ${msg}\n`;
  $('log').scrollTop = $('log').scrollHeight;
}

function setStatus(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = cls;
}

function source() {
  return document.querySelector('input[name=src]:checked').value;
}

function currentImage() {
  return source() === 'bundled' ? bundled?.image : picked?.image;
}

async function describe(image) {
  const err = checkImage(image);
  const sum = await sha256hex(image);
  $('image-info').textContent = `${image.length.toLocaleString()} バイト / SHA-256 ${sum}`
    + (err ? ` — ${err}` : '');
  return err;
}

async function refresh() {
  if (!busy) { setStatus('待機中'); $('bar').style.width = '0'; }
  const image = currentImage();
  let err = null;
  if (!image) {
    $('image-info').textContent = source() === 'file' ? 'ファイルを選んでください' : '';
    err = 'no image';
  } else {
    err = await describe(image);
  }
  startBtn.disabled = busy || !('serial' in navigator) || !!err;
}

async function loadBundled() {
  try {
    const info = await (await fetch('ja_res.json', {cache: 'no-store'})).json();
    const res = await fetch('ja_res.bin', {cache: 'no-store'});
    if (!res.ok) throw new Error(res.status);
    const image = new Uint8Array(await res.arrayBuffer());
    if (await sha256hex(image) !== info.sha256) throw new Error('SHA-256 が ja_res.json と一致しません');
    bundled = {image, info};
    const tag = info.release_url
      ? `<a href="${info.release_url}">${info.tag}</a>` : info.tag;
    $('bundled-info').innerHTML = `（${tag} の Release と同じ ja_res.bin）`;
  } catch (e) {
    $('bundled-info').textContent = `（読み込めませんでした: ${e.message}）`;
    document.querySelector('input[name=src][value=file]').checked = true;
  }
  refresh();
}

fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  picked = f ? {image: new Uint8Array(await f.arrayBuffer()), name: f.name} : null;
  document.querySelector('input[name=src][value=file]').checked = true;
  refresh();
});
for (const r of document.querySelectorAll('input[name=src]')) r.addEventListener('change', refresh);

let abort = null;
let phase = null;   // 'write' | 'verify' while uploading

startBtn.addEventListener('click', async () => {
  const image = currentImage();
  if (!image || checkImage(image)) return;

  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch {
    return;     // the chooser was cancelled
  }

  busy = true;
  startBtn.disabled = true;
  stopBtn.hidden = false;
  fileInput.disabled = true;
  abort = new AbortController();
  $('bar').style.width = '0';
  const radio = new Radio(port);
  const t0 = performance.now();
  phase = null;
  try {
    setStatus('ポートを開いています…');
    try {
      await radio.open();
    } catch (e) {
      throw new RadioError(`ポートを開けません（ほかのソフトが使っていないか確認してください）: ${e.message}`);
    }
    log('ポートを開きました（38400 bps）');
    setStatus('本体に接続しています…');
    const id = await radio.hello();
    log(`本体: ${id}`);

    const verify = verifyBox.checked;
    const phaseT = {};
    phase = 'write';
    await radio.upload(image, {
      verify,
      signal: abort.signal,
      onProgress(p, done, total) {
        phase = p;
        phaseT[phase] ??= performance.now();
        const rate = done / Math.max((performance.now() - phaseT[phase]) / 1000, 1e-3) / 1024;
        const share = verify ? 0.5 : 1;
        const pct = (phase === 'write' ? 0 : 0.5) + share * done / total;
        $('bar').style.width = `${(pct * 100).toFixed(1)}%`;
        setStatus(`${phase === 'write' ? '書き込み中' : '照合中'} ${done.toLocaleString()} / ${total.toLocaleString()} バイト（${rate.toFixed(1)} KB/s）`);
      },
    });
    $('bar').style.width = '100%';
    const sec = ((performance.now() - t0) / 1000).toFixed(0);
    log(`完了: ${image.length} バイトを SPI 0x${FLASH_BASE.toString(16).toUpperCase()} に書きました（${verify ? '照合済み' : '照合なし'}、${sec} 秒）`);
    setStatus(`完了しました${verify ? '（照合 OK）' : ''}。反映されないときは本体の電源を入れ直してください。`, 'ok');
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? (phase === 'verify'
          ? '照合の途中で中止しました。書き込み自体は終わっています。'
          : '中止しました。本体は英語表示で起動します。もう一度書き込めば直ります。')
      : e instanceof RadioError ? e.message : `エラー: ${e.message}`;
    log(msg);
    setStatus(msg, 'err');
  } finally {
    await radio.close();
    log('ポートを閉じました');
    busy = false;
    stopBtn.hidden = true;
    fileInput.disabled = false;
    const [msg, cls, bar] = [$('status').textContent, $('status').className, $('bar').style.width];
    await refresh();
    setStatus(msg, cls);    // keep the result until the data is changed
    $('bar').style.width = bar;
  }
});

stopBtn.addEventListener('click', () => abort?.abort());

if (!('serial' in navigator)) $('unsupported').hidden = false;
loadBundled();
