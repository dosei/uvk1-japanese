// RxJa Tools: Japanese data (ja_res.bin) upload. Added by the RxJa project; not
// part of UV Studio.
//
// Two entry points share one upload routine:
//   - afterFlash(): called by flash.js once an RxJa firmware picked from the
//     catalog has been flashed. The radio leaves the bootloader and comes back
//     as the RxJa firmware, usually on a new USB serial port, so we keep probing
//     the ports this page may already use (getPorts) until one answers hello,
//     then write the data. If none does, the user can pick the port again
//     (requestPort needs a click) or skip.
//   - the "Japanese data" view: pick a bundled release or a local file, choose
//     the port, write.
// Serial access goes through UVStudioSerial as the 'rxja' client so the viewer
// and tools never hold the port at the same time.

import { Radio, RadioError, checkImage, sha256hex } from './rxja.js';

const PROBE_TIMEOUT_MS = 90000;   // give up waiting for the reboot after this
const SLOW_HINT_MS = 10000;       // then suggest a manual power cycle
const PROBE_INTERVAL_MS = 700;
const PING_TIMEOUT_MS = 800;

const t = (key, ...values) => window.uvStudioI18n ? window.uvStudioI18n.t(key, ...values) : key;
const $ = id => document.getElementById(id);

const serial = window.UVStudioSerial.register('rxja', { disconnect: () => closeRadio() });

let pending = null;   // catalog entry of the RxJa firmware waiting to be flashed
let radio = null;     // open Radio, if any
let job = null;       // { abort: AbortController, token, picked, wake }

// ---------- shared helpers ----------

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function isAbort(error) {
  return error && error.name === 'AbortError';
}

async function closeRadio() {
  const r = radio;
  radio = null;
  if (r) await r.close();
}

function sleepOrWake(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); if (job) job.wake = null; resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
    if (job) job.wake = done;
  });
}

async function fetchImage(ja) {
  const response = await fetch(ja.url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const image = new Uint8Array(await response.arrayBuffer());
  if (ja.sha256 && (await sha256hex(image)) !== ja.sha256) throw new Error(t('rxja_ja_hashbad'));
  const bad = checkImage(image);
  if (bad) throw new Error(bad);
  return image;
}

// Open the port and send one hello. Returns an open Radio, or null.
async function probe(port) {
  const candidate = new Radio(port);
  try {
    await candidate.open();
  } catch (error) {
    return null;   // gone, still re-enumerating, or held elsewhere
  }
  try {
    if (await candidate.ping(PING_TIMEOUT_MS) !== null) return candidate;
  } catch (error) {
    // read error: the port vanished under us
  }
  await candidate.close();
  return null;
}

function sameUsb(a, b) {
  const ia = a.getInfo ? a.getInfo() : {};
  const ib = b.getInfo ? b.getInfo() : {};
  return ia.usbVendorId !== undefined && ia.usbVendorId === ib.usbVendorId;
}

// Write image through an already opened radio. ui: { progress(phase, pct) }.
async function writeImage(image, { verify, signal, ui }) {
  let phase = 'write';
  try {
    await radio.upload(image, {
      verify,
      signal,
      onProgress(p, done, total) {
        phase = p;
        ui.progress(p, total ? Math.floor(done * 100 / total) : 0);
      }
    });
  } catch (error) {
    if (isAbort(error)) error.phase = phase;
    throw error;
  }
}

function abortMessage(error) {
  return error.phase === 'verify' ? t('rxja_ja_aborted_verify') : t('rxja_ja_aborted_write');
}

function warnOnUnload(event) {
  event.preventDefault();
  event.returnValue = '';
}

// Acquire the serial controller and start the critical ja-upload operation.
async function beginJob() {
  if (job) return null;
  if (window.UVStudioSerial.isNavigationBlocked()) return null;
  await serial.acquire({ reason: 'ja-upload' });
  if (!serial.isOwner()) return null;
  const token = serial.beginOperation('ja-upload', { critical: true });
  if (!token) {
    await serial.release('operation-blocked');
    return null;
  }
  job = { abort: new AbortController(), token, picked: null, wake: null };
  window.addEventListener('beforeunload', warnOnUnload);
  return job;
}

async function endJob() {
  if (!job) return;
  const { token } = job;
  job = null;
  window.removeEventListener('beforeunload', warnOnUnload);
  try { await closeRadio(); } catch (error) {}
  serial.endOperation(token);
  await serial.release('operation-complete');
}

function markConnected() {
  serial.setState('connected', { reason: 'ja-upload' });
}

// ---------- UI helpers ----------

function panelUi(prefix) {
  const panel = $(`${prefix}Panel`) || $(prefix);
  const status = $(`${prefix}Status`);
  const fill = $(`${prefix}Fill`);
  const label = $(`${prefix}Label`);
  const bar = fill ? fill.parentElement : null;
  return {
    state(state, text) {
      if (panel) panel.dataset.state = state;
      if (status) {
        status.dataset.state = state;
        status.removeAttribute('data-i18n');
        if (text !== undefined) status.textContent = text;
      }
    },
    progress(phase, pct) {
      this.state(phase === 'verify' ? 'verifying' : 'writing',
        t(phase === 'verify' ? 'rxja_ja_verifying' : 'rxja_ja_writing', pct));
      this.bar(pct);
    },
    bar(pct) {
      if (fill) fill.style.width = `${pct}%`;
      if (label) label.textContent = pct ? `${pct}%` : '';
      if (bar) bar.setAttribute('aria-valuenow', String(pct));
    }
  };
}

// ---------- post-flash chain ----------

const chain = {
  panel: $('rxjaChain'),
  title: $('rxjaChainTitle'),
  note: $('rxjaChainNote'),
  repick: $('rxjaChainRepick'),
  skip: $('rxjaChainSkip'),
  ui: panelUi('rxjaChain'),
  entry: null
};

function chainNote(text) {
  chain.note.hidden = !text;
  chain.note.textContent = text || '';
}

function chainFinish(state, text) {
  chain.ui.state(state, text);
  chain.repick.hidden = true;
  chain.skip.hidden = true;
  chainNote('');
}

async function afterFlash({ port, fileName } = {}) {
  const entry = pending;
  if (!entry || !entry.ja || entry.name !== fileName || !chain.panel) return;
  if (!(await beginJob())) return;
  const { signal } = job.abort;

  chain.entry = entry;
  chain.panel.hidden = false;
  chain.title.textContent = t('rxja_chain_title', `v${entry.version}`);
  chain.repick.hidden = true;
  chain.skip.hidden = false;
  chainNote('');
  chain.ui.bar(0);
  chain.ui.state('waiting', t('rxja_chain_waiting'));
  chain.panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  try {
    const image = await fetchImage(entry.ja);
    const started = performance.now();
    let slow = false;
    while (!radio) {
      if (signal.aborted) throw abortError();
      const elapsed = performance.now() - started;
      if (!slow && elapsed > SLOW_HINT_MS) {
        slow = true;
        chain.ui.state('waiting', t('rxja_chain_waiting_long'));
        chainNote(t('rxja_chain_pick'));
        chain.repick.hidden = false;
      }
      if (elapsed > PROBE_TIMEOUT_MS && !job.picked) {
        chainFinish('timeout', t('rxja_chain_timeout'));
        return;
      }

      // The port the user picked first, then ports that look like the radio,
      // then the flashed port itself (some adapters keep the same port object).
      const granted = await navigator.serial.getPorts();
      const candidates = [];
      const add = p => { if (p && !candidates.includes(p)) candidates.push(p); };
      add(job.picked);
      granted.filter(p => sameUsb(p, port)).forEach(add);
      add(port);
      granted.forEach(add);
      for (const candidate of candidates) {
        if (signal.aborted) throw abortError();
        const found = await probe(candidate);
        if (found) { radio = found; break; }
      }
      if (!radio) await sleepOrWake(PROBE_INTERVAL_MS, signal);
    }

    markConnected();
    chain.repick.hidden = true;
    chainNote('');
    const verify = true;
    await writeImage(image, { verify, signal, ui: chain.ui });
    chain.ui.bar(100);
    chainFinish('done', t('rxja_chain_done'));
  } catch (error) {
    if (isAbort(error)) {
      chainFinish('skipped', radio ? abortMessage(error) : t('rxja_chain_skipped'));
    } else {
      chainFinish('error', t('rxja_ja_error', error.message || String(error)));
    }
  } finally {
    await endJob();
  }
}

chain.skip?.addEventListener('click', () => job?.abort.abort());

chain.repick?.addEventListener('click', async () => {
  if (!job) return;
  try {
    const picked = await navigator.serial.requestPort();
    if (job) {
      job.picked = picked;
      job.wake?.();
    }
  } catch (error) {
    // dialog cancelled: keep waiting
  }
});

// A new firmware choice hides the result of the previous chain.
window.addEventListener('uvstudio:firmwareselect', event => {
  if (event.detail?.source === 'local') pending = null;
  if (!job && chain.panel) chain.panel.hidden = true;
});

// ---------- flash view hint ----------

function renderFlashHint() {
  const hint = $('rxjaFlashHint');
  if (hint) hint.innerHTML = t('rxja_flash_hint');
}

// ---------- "Japanese data" view ----------

const view = {
  source: $('rxjaJaSource'),
  fileSection: $('rxjaJaFileSection'),
  file: $('rxjaJaFile'),
  fileName: $('rxjaJaFileName'),
  fileLabel: $('rxjaJaFileLabel'),
  image: $('rxjaJaImage'),
  verify: $('rxjaJaVerify'),
  start: $('rxjaJaStart'),
  stop: $('rxjaJaStop'),
  ui: panelUi('rxjaJa'),
  releases: [],
  loaded: null,      // { image, label } ready to write
  loadSeq: 0
};

function renderSourceOptions() {
  if (!view.source) return;
  const previous = view.source.value;
  view.source.textContent = '';
  view.releases.forEach(entry => {
    const option = document.createElement('option');
    option.value = entry.tag;
    option.textContent = `v${entry.version}${entry.prerelease ? t('rxja_prerelease') : ''} · ${t('rxja_ja_release')}`;
    view.source.appendChild(option);
  });
  const fileOption = document.createElement('option');
  fileOption.value = 'file';
  fileOption.textContent = t('rxja_ja_file');
  view.source.appendChild(fileOption);
  if (previous && view.source.querySelector(`option[value="${CSS.escape(previous)}"]`)) {
    view.source.value = previous;
  }
}

function showImage(text, bad) {
  view.image.textContent = text || '';
  view.image.dataset.bad = String(Boolean(bad));
}

async function describe(image, label) {
  const hash = await sha256hex(image);
  return t('rxja_ja_ready', label, image.length, hash.slice(0, 12));
}

function refreshStart() {
  view.start.disabled = !view.loaded || Boolean(job);
}

async function selectSource() {
  const seq = ++view.loadSeq;
  view.loaded = null;
  refreshStart();
  const value = view.source.value;
  view.fileSection.hidden = value !== 'file';
  if (value === 'file') {
    const file = view.file.files && view.file.files[0];
    if (!file) { showImage(t('rxja_ja_pickfile')); return; }
    const image = new Uint8Array(await file.arrayBuffer());
    if (seq !== view.loadSeq) return;
    const bad = checkImage(image);
    if (bad) { showImage(bad, true); return; }
    view.loaded = { image, label: file.name };
  } else {
    const entry = view.releases.find(r => r.tag === value);
    if (!entry || !entry.ja) { showImage(t('rxja_ja_pickfile')); return; }
    showImage(t('rxja_ja_loading'));
    try {
      const image = await fetchImage(entry.ja);
      if (seq !== view.loadSeq) return;
      view.loaded = { image, label: `ja_res.bin（RxJa v${entry.version}）` };
    } catch (error) {
      if (seq !== view.loadSeq) return;
      showImage(t('rxja_ja_nobundle', error.message || String(error)), true);
      return;
    }
  }
  showImage(await describe(view.loaded.image, view.loaded.label));
  refreshStart();
}

let viewReady = false;
async function initView() {
  if (viewReady || !view.source) return;
  viewReady = true;
  try {
    view.releases = (await window.RxJaCatalog?.releases()) || [];
  } catch (error) {
    view.releases = [];
  }
  renderSourceOptions();
  view.fileName.textContent = t('fileNoFile');
  await selectSource();
}

async function startUpload() {
  if (!view.loaded || job) return;
  const { image } = view.loaded;
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (error) {
    return;   // dialog cancelled
  }
  if (!(await beginJob())) return;
  const { signal } = job.abort;
  view.start.disabled = true;
  view.stop.hidden = false;
  view.source.disabled = true;
  view.ui.bar(0);
  view.ui.state('connecting', t('rxja_ja_connecting'));
  try {
    const opened = new Radio(port);
    await opened.open();
    radio = opened;
    const version = await radio.hello();
    markConnected();
    view.ui.state('writing', t('rxja_ja_connected', version));
    await writeImage(image, { verify: view.verify.checked, signal, ui: view.ui });
    view.ui.bar(100);
    view.ui.state('done', t(view.verify.checked ? 'rxja_ja_done_verified' : 'rxja_ja_done'));
  } catch (error) {
    if (isAbort(error)) view.ui.state('skipped', abortMessage(error));
    else view.ui.state('error', t('rxja_ja_error', error.message || String(error)));
  } finally {
    await endJob();
    view.stop.hidden = true;
    view.source.disabled = false;
    refreshStart();
  }
}

if (view.source) {
  view.source.addEventListener('change', () => { void selectSource(); });
  view.file.addEventListener('change', () => {
    const file = view.file.files && view.file.files[0];
    view.fileName.textContent = file ? file.name : t('fileNoFile');
    view.fileName.classList.toggle('has-file', Boolean(file));
    view.fileLabel.classList.toggle('has-file', Boolean(file));
    void selectSource();
  });
  view.start.addEventListener('click', () => { void startUpload(); });
  view.stop.addEventListener('click', () => job?.abort.abort());
}

window.addEventListener('uvstudio:toolviewchange', event => {
  if (event.detail?.view === 'ja-data') void initView();
});

window.addEventListener('uvstudio:languagechange', () => {
  renderFlashHint();
  if (viewReady) {
    renderSourceOptions();
    if (!(view.file.files && view.file.files[0])) view.fileName.textContent = t('fileNoFile');
    if (view.loaded) void describe(view.loaded.image, view.loaded.label).then(text => showImage(text));
  }
  if (chain.entry && chain.title) chain.title.textContent = t('rxja_chain_title', `v${chain.entry.version}`);
});

renderFlashHint();
// The module may load after studio.js already opened the Japanese data view.
if (document.getElementById('ja-data-content')?.classList.contains('active')) void initView();

window.RxJaData = Object.freeze({
  setPending(entry) { pending = entry && entry.ja ? entry : null; },
  afterFlash,
  RadioError
});
