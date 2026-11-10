// RxJa Tools: FM station editor (RxJa v2.0.0+, 0x0748 flag bit 2). Added by the RxJa project; not part of UV Studio.
//
// The table holds the radio's 100 broadcast-FM stations FM00-FM99 (frequency and name). Reading
// takes the two FM sectors (rxja-fmmap.js) as the snapshot; writing reads them again, builds the
// image the table describes on top of them, downloads a backup, writes only the 8-byte blocks
// that differ (names, then frequencies, the header last), reads them back and reboots the radio:
// the radio keeps the stations in RAM and would write its own copy back over ours otherwise.
// Names are Shift_JIS, 20 bytes (ten full-width characters); the radio shows them with the
// Japanese data that has the Shift_JIS table (0x0748 flag bit 1).

import { Radio, RadioError } from './rxja.js?v=3';
import * as F from './rxja-fmmap.js?v=2';
import { decodeText, readTable, writeCsv } from './rxja-csv.js';
import { encodeName, byteLength } from './rxja-sjis.js';

const CHUNK = 128;
const PRESETS_URL = 'presets/fm-jp.json';
// 0x0748 flag: the FM sectors are in the EEPROM window (App/app/uart.c). A version number would
// not do: a build can carry the FM table without the mapping, and old firmware drops the writes.
const FLAG_FM = 0x04;

const t = (key, ...values) => window.uvStudioI18n ? window.uvStudioI18n.t(key, ...values) : key;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmNo = n => `FM${String(n).padStart(2, '0')}`;

const serial = window.UVStudioSerial.register('rxja-fm', { disconnect: () => closeRadio() });

const state = {
  snapshot: null,          // image last read from / written to the radio (rxja-fmmap layout)
  base: new Map(),         // number -> station decoded from snapshot
  stations: new Map(),     // number -> { number, freq, name } being edited
  selected: new Set(),
  source: null,            // { key, arg } of where the table came from
  radioInfo: undefined,
  presets: null,           // web/presets/fm-jp.json, loaded on first use
  dirty: false,
};

let radio = null;
let job = null;            // { abort, token }

// ---------- elements ----------

const el = {
  read: $('rxjaFmRead'),
  write: $('rxjaFmWrite'),
  importBtn: $('rxjaFmImport'),
  file: $('rxjaFmFile'),
  pref: $('rxjaFmPref'),
  preset: $('rxjaFmPreset'),
  exportBtn: $('rxjaFmExport'),
  stop: $('rxjaFmStop'),
  panel: $('rxjaFmPanel'),
  status: $('rxjaFmStatus'),
  fill: $('rxjaFmFill'),
  label: $('rxjaFmLabel'),
  summary: $('rxjaFmSummary'),
  showEmpty: $('rxjaFmShowEmpty'),
  del: $('rxjaFmDelete'),
  revert: $('rxjaFmRevert'),
  clear: $('rxjaFmClear'),
  table: $('rxjaFmTable'),
  body: $('rxjaFmBody'),
  all: $('rxjaFmAll'),
  writeDialog: $('rxjaFmWriteDialog'),
  writeText: $('rxjaFmWriteText'),
  writeDelete: $('rxjaFmWriteDelete'),
  writeJa: $('rxjaFmWriteJa'),
};

if (!el.table) throw new Error('FM editor markup missing');

// ---------- status panel ----------

function setStatus(stateName, text) {
  el.panel.dataset.state = stateName;
  el.status.dataset.state = stateName;
  el.status.removeAttribute('data-i18n');
  el.status.textContent = text;
}

function setBar(pct) {
  el.fill.style.width = `${pct}%`;
  el.label.textContent = pct ? `${pct}%` : '';
  el.fill.parentElement.setAttribute('aria-valuenow', String(pct));
}

// ---------- serial job (same pattern as rxja-mem.js) ----------

async function closeRadio() {
  const r = radio;
  radio = null;
  if (r) await r.close();
}

function warnOnUnload(event) {
  event.preventDefault();
  event.returnValue = '';
}

async function beginJob(operation) {
  if (job) return null;
  if (window.UVStudioSerial.isNavigationBlocked()) return null;
  await serial.acquire({ reason: operation });
  if (!serial.isOwner()) return null;
  const token = serial.beginOperation(operation, { critical: operation === 'fm-write' });
  if (!token) {
    await serial.release('operation-blocked');
    return null;
  }
  job = { abort: new AbortController(), token };
  window.addEventListener('beforeunload', warnOnUnload);
  refreshButtons();
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
  refreshButtons();
}

// Firmware without the flag answers 0xFF for these addresses and drops the writes, so it is
// refused before anything is read.
async function connect(port) {
  const opened = new Radio(port);
  await opened.open();
  radio = opened;
  setStatus('connecting', t('rxja_fm_connecting'));
  const version = await radio.hello();       // latches the session timestamp 0x051B/0x051D need
  serial.setState('connected', { reason: 'fm' });
  state.radioInfo = await radio.rxjaInfo();
  const rx = state.radioInfo && state.radioInfo.version;
  if (!rx || !(state.radioInfo.flags & FLAG_FM)) throw new RadioError(t('rxja_fm_badfw', rx || version || '?'));
  return `RxJa ${rx}`;
}

async function readFm(signal, phaseKey) {
  const image = F.newImage();
  const total = F.REGIONS.reduce((s, r) => s + r.size, 0);
  let done = 0;
  for (const r of F.REGIONS) {
    for (let a = r.addr; a < r.addr + r.size; a += CHUNK) {
      signal.throwIfAborted();
      const len = Math.min(CHUNK, r.addr + r.size - a);
      image.set(await radio.readEeprom(a, len), a - F.HDR_BASE);
      done += len;
      const pct = Math.floor(done * 100 / total);
      setBar(pct);
      setStatus('reading', t(phaseKey, pct));
    }
  }
  return image;
}

const isAbort = e => e && e.name === 'AbortError';

// ---------- model ----------

function setSnapshot(image, source) {
  state.snapshot = image;
  state.base = new Map(F.decodeAll(image).map(s => [s.number, s]));
  state.stations = new Map([...state.base].map(([n, s]) => [n, { ...s }]));
  state.selected.clear();
  state.source = source;
}

function baseImage() {
  return state.snapshot || F.newImage();
}

function targetImage() {
  return F.buildImage(baseImage(), [...state.stations.values()]);
}

function diffCounts() {
  let added = 0, changed = 0, deleted = 0;
  for (let n = 0; n < F.COUNT; n++) {
    const a = state.base.get(n), b = state.stations.get(n);
    if (!a && b) added++;
    else if (a && !b) deleted++;
    else if (a && b && (a.freq !== b.freq || a.name !== encodeName(b.name, F.NAME_LEN).text)) changed++;
  }
  return { added, changed, deleted };
}

function rowState(n) {
  const a = state.base.get(n), b = state.stations.get(n);
  if (!state.snapshot) return b ? 'added' : '';
  if (!a && b) return 'added';
  if (a && b && (a.freq !== b.freq || a.name !== b.name)) return 'changed';
  return '';
}

// Japanese names show only with the Japanese data that has the Shift_JIS table
function jaNameProblem() {
  if (![...state.stations.values()].some(s => /[^\x20-\x7E]/.test(s.name))) return '';
  const info = state.radioInfo;
  if (info && !(info.flags & 2)) return t('rxja_fm_ja_nodata');
  return '';
}

// ---------- table ----------

function render() {
  const showEmpty = el.showEmpty.checked;
  const rows = [];
  for (let n = 0; n < F.COUNT; n++) {
    const st = state.stations.get(n);
    if (!st) {
      if (!showEmpty && !state.base.has(n)) continue;
      const gone = state.base.has(n) ? ' rxja-mem-changed' : '';
      rows.push(`<tr class="rxja-mem-empty${gone}" data-n="${n}"><td class="rxja-mem-check"><input type="checkbox" disabled></td>`
        + `<td class="rxja-mem-num">${fmNo(n)}</td><td colspan="2"><button type="button" class="btn rxja-mem-addhere" data-n="${n}">`
        + `${esc(state.base.has(n) ? t('rxja_fm_deleted_row') : t('rxja_mem_addhere'))}</button></td></tr>`);
      continue;
    }
    const base = state.base.get(n);
    const d = rowState(n);
    const sel = state.selected.has(n);
    const ch = f => d === 'changed' && base && (f === 'freq' ? base.freq !== st.freq : base.name !== st.name) ? ' rxja-mem-changed' : '';
    rows.push(`<tr data-n="${n}" class="${d === 'added' ? 'rxja-mem-added' : ''}${sel ? ' rxja-mem-selected' : ''}">`
      + `<td class="rxja-mem-check"><input type="checkbox" data-n="${n}"${sel ? ' checked' : ''} aria-label="${esc(t('rxja_mem_select', fmNo(n)))}"></td>`
      + `<td class="rxja-mem-num">${fmNo(n)}</td>`
      + `<td class="rxja-mem-cell${ch('freq')}" data-f="freq" tabindex="0">${esc(F.formatMHz10(st.freq))}</td>`
      + `<td class="rxja-mem-cell${ch('name')}" data-f="name" tabindex="0">${esc(st.name)}</td></tr>`);
  }
  if (!rows.length) rows.push(`<tr><td colspan="4" class="rxja-mem-none">${esc(t('rxja_fm_none'))}</td></tr>`);
  el.body.innerHTML = rows.join('');
  renderSummary();
  refreshButtons();
}

function renderSummary() {
  const c = diffCounts();
  const parts = [t('rxja_fm_count', state.stations.size)];
  if (state.source) parts.push(t(state.source.key, state.source.arg));
  const changes = [];
  if (c.added) changes.push(t('rxja_mem_added', c.added));
  if (c.changed) changes.push(t('rxja_mem_changed', c.changed));
  if (c.deleted) changes.push(t('rxja_mem_deleted', c.deleted));
  parts.push(changes.length ? t('rxja_mem_vs_radio', changes.join('・')) : (state.snapshot ? t('rxja_mem_same') : ''));
  el.summary.textContent = parts.filter(Boolean).join(' / ');
  state.dirty = Boolean(c.added || c.changed || c.deleted);
}

function refreshButtons() {
  const busy = Boolean(job);
  el.read.disabled = busy;
  el.write.disabled = busy || (!state.snapshot && !state.stations.size);
  el.importBtn.disabled = busy;
  el.preset.disabled = busy || !el.pref.value;
  el.pref.disabled = busy;
  el.exportBtn.disabled = busy || !state.stations.size;
  el.stop.hidden = !busy;
  const anySel = [...state.selected].some(n => state.stations.has(n));
  el.del.disabled = busy || !anySel;
  el.revert.disabled = busy || !state.dirty;
  el.clear.disabled = busy || !state.stations.size;
  el.table.classList.toggle('rxja-mem-busy', busy);
}

// ---------- cell editing ----------

let editing = null;   // { td, n, f, input }

function startEdit(td) {
  if (job || !td || editing?.td === td) return;
  const n = Number(td.parentElement.dataset.n);
  const f = td.dataset.f;
  if (editing) {
    if (!commitEdit()) return;
    td = el.body.querySelector(`tr[data-n="${n}"] td[data-f="${f}"]`);
    if (!td) return;
  }
  const st = state.stations.get(n);
  if (!st) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.className = 'rxja-mem-input';
  if (f === 'freq') { input.inputMode = 'decimal'; input.value = F.formatMHz10(st.freq); }
  else input.value = st.name;
  td.textContent = '';
  td.appendChild(input);
  td.classList.add('rxja-mem-editing');
  if (f === 'name') {
    const meter = document.createElement('span');
    meter.className = 'rxja-mem-bytes';
    const update = () => {
      const used = byteLength(input.value);
      meter.textContent = `${used}/${F.NAME_LEN}`;
      meter.dataset.over = String(used > F.NAME_LEN || encodeName(input.value, 99).bad.length > 0);
    };
    input.addEventListener('input', update);
    update();
    td.appendChild(meter);
  }
  editing = { td, n, f, input };
  input.focus();
  input.select();
  input.addEventListener('keydown', onEditKey);
  input.addEventListener('blur', () => setTimeout(() => { if (editing?.input === input) commitEdit(); }, 0));
}

function commitEdit() {
  if (!editing) return true;
  const { td, n, f, input } = editing;
  const st = state.stations.get(n);
  let error = '';
  if (st && f === 'freq') {
    const x10 = F.parseMHz10(input.value);
    if (x10 === null || !F.validFreq(x10)) error = t('rxja_fm_bad_freq');
    else if ([...state.stations.values()].some(o => o.number !== n && o.freq === x10)) error = t('rxja_fm_dup_freq', F.formatMHz10(x10));
    else st.freq = x10;
  } else if (st && f === 'name') {
    const nm = encodeName(input.value, F.NAME_LEN);
    if (nm.bad.length) setStatus('idle', t('rxja_mem_name_bad', nm.bad.join(' ')));
    else if (nm.cut) setStatus('idle', t('rxja_mem_name_cut', nm.text));
    st.name = nm.text;
  }
  if (error) {
    td.classList.add('rxja-mem-invalid');
    input.title = error;
    setStatus('error', error);
    input.focus();
    return false;
  }
  editing = null;
  render();
  return true;
}

function cancelEdit() {
  if (!editing) return;
  const { n, f } = editing;
  editing = null;
  render();
  el.body.querySelector(`tr[data-n="${n}"] td[data-f="${f}"]`)?.focus();
}

function onEditKey(event) {
  if (!editing) return;
  if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); return; }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    const { n, f } = editing;
    if (!commitEdit()) return;
    if (event.key === 'Tab') {
      const next = f === 'freq' ? 'name' : 'freq';
      const td = el.body.querySelector(`tr[data-n="${n}"] td[data-f="${next}"]`);
      if (td) startEdit(td);
    }
  }
}

el.body.addEventListener('click', event => {
  const add = event.target.closest('.rxja-mem-addhere');
  if (add) { addStation(Number(add.dataset.n)); return; }
  const box = event.target.closest('input[type="checkbox"][data-n]');
  if (box) {
    const n = Number(box.dataset.n);
    if (box.checked) state.selected.add(n); else state.selected.delete(n);
    box.closest('tr').classList.toggle('rxja-mem-selected', box.checked);
    refreshButtons();
    return;
  }
  const td = event.target.closest('td.rxja-mem-cell');
  if (td && !td.classList.contains('rxja-mem-editing')) startEdit(td);
});

el.body.addEventListener('keydown', event => {
  const td = event.target.closest('td.rxja-mem-cell');
  if (td && editing?.td !== td && (event.key === 'Enter' || event.key === 'F2')) { event.preventDefault(); startEdit(td); }
});

el.all.addEventListener('change', () => {
  for (const n of state.stations.keys()) {
    if (el.all.checked) state.selected.add(n); else state.selected.delete(n);
  }
  render();
});

el.showEmpty.addEventListener('change', () => { commitEdit(); render(); });

// ---------- row operations ----------

// A new station needs a frequency: start from one not in use, so the table stays valid
function freeFrequency() {
  const used = new Set([...state.stations.values()].map(s => s.freq));
  for (let f = 760; f <= F.MAX_X10; f++) if (!used.has(f)) return f;
  return null;
}

function addStation(n) {
  if (job || state.stations.has(n)) return;
  commitEdit();
  const prev = state.base.get(n);
  const freq = prev && ![...state.stations.values()].some(s => s.freq === prev.freq) ? prev.freq : freeFrequency();
  if (freq === null) return;
  state.stations.set(n, { number: n, freq, name: prev && prev.freq === freq ? prev.name : '' });
  render();
  el.body.querySelector(`tr[data-n="${n}"] td[data-f="freq"]`)?.click();
}

el.del.addEventListener('click', () => {
  if (job) return;
  commitEdit();
  for (const n of state.selected) state.stations.delete(n);
  state.selected.clear();
  render();
});

el.revert.addEventListener('click', () => {
  if (job || !state.dirty || !confirm(t('rxja_mem_revert_confirm'))) return;
  editing = null;
  state.stations = new Map([...state.base].map(([n, s]) => [n, { ...s }]));
  state.selected.clear();
  render();
});

el.clear.addEventListener('click', () => {
  if (job || !state.stations.size || !confirm(t('rxja_fm_clear_confirm'))) return;
  editing = null;
  state.stations.clear();
  state.selected.clear();
  render();
});

// ---------- presets ----------

async function loadPresets() {
  if (state.presets) return state.presets;
  const r = await fetch(PRESETS_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${PRESETS_URL}: HTTP ${r.status}`);
  const doc = await r.json();
  if (doc.format !== 'rxja-fm-presets') throw new Error(t('rxja_fm_preset_bad'));
  state.presets = doc;
  return doc;
}

async function fillPrefectures() {
  try {
    const doc = await loadPresets();
    const keep = el.pref.value;
    el.pref.innerHTML = `<option value="">${esc(t('rxja_fm_pref_choose'))}</option>`
      + Object.entries(doc.prefectures).map(([code, p]) => `<option value="${esc(code)}">${esc(p.name)}（${p.stations.length}）</option>`).join('');
    el.pref.value = keep;
  } catch (error) {
    el.pref.innerHTML = `<option value="">${esc(t('rxja_fm_preset_fail'))}</option>`;
  }
  refreshButtons();
}

el.pref.addEventListener('change', refreshButtons);

el.preset.addEventListener('click', async () => {
  if (job || !el.pref.value) return;
  commitEdit();
  try {
    const doc = await loadPresets();
    const list = F.presetStations(doc, el.pref.value);
    const r = F.mergePreset([...state.stations.values()], list);
    state.stations = new Map(r.stations.map(s => [s.number, s]));
    state.selected.clear();
    render();
    const name = doc.prefectures[el.pref.value].name;
    let msg = t('rxja_fm_preset_done', name, r.added, r.skipped);
    if (r.full) msg += ' ' + t('rxja_fm_preset_full', r.full);
    if (!state.snapshot) msg += ' ' + t('rxja_fm_preset_read_first');
    setStatus('done', msg);
  } catch (error) {
    setStatus('error', t('rxja_mem_error', error.message || String(error)));
  }
});

// ---------- CSV / backup files ----------

function stamp() {
  const d = new Date();
  const p = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

el.exportBtn.addEventListener('click', () => {
  if (!commitEdit()) return;
  const rows = [...state.stations.values()].sort((a, b) => a.number - b.number).map(F.stationToRow);
  download('﻿' + writeCsv(F.CSV_COLUMNS, rows), `uvk1-fm-${stamp()}.csv`, 'text/csv;charset=utf-8');
});

el.importBtn.addEventListener('click', () => { if (!job) el.file.click(); });

el.file.addEventListener('change', async () => {
  const file = el.file.files[0];
  el.file.value = '';
  if (!file) return;
  commitEdit();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let stations;
    const problems = [];
    if (/\.bin$/i.test(file.name)) {
      // a backup this page downloaded (image of the two FM sectors)
      if (bytes.length !== F.IMAGE_SIZE) throw new Error(t('rxja_fm_bin_bad'));
      stations = F.decodeAll(bytes);
    } else {
      const rows = readTable(decodeText(bytes));
      stations = [];
      const used = new Set(), seen = new Set();
      rows.forEach((row, i) => {
        const { station, problem } = F.rowToStation(row, [...Array(F.COUNT).keys()].find(k => !used.has(k)));
        if (!station) { problems.push(t('rxja_fm_row_bad', i + 2, t(`rxja_fm_problem_${problem}`))); return; }
        if (used.has(station.number)) { problems.push(t('rxja_fm_row_dup_no', i + 2, fmNo(station.number))); return; }
        if (seen.has(station.freq)) { problems.push(t('rxja_fm_row_dup_freq', i + 2, F.formatMHz10(station.freq))); return; }
        station.name = encodeName(station.name, F.NAME_LEN).text;
        used.add(station.number); seen.add(station.freq);
        stations.push(station);
      });
    }
    if (state.stations.size && !confirm(t('rxja_fm_import_replace', stations.length))) return;
    state.stations = new Map(stations.map(s => [s.number, s]));
    state.selected.clear();
    render();
    setStatus(problems.length ? 'error' : 'done',
      t('rxja_fm_import_done', file.name, stations.length) + (problems.length ? '\n' + problems.slice(0, 8).join('\n') : ''));
  } catch (error) {
    setStatus('error', t('rxja_mem_error', error.message || String(error)));
  }
});

// ---------- radio ----------

async function pickPort() {
  try {
    return await navigator.serial.requestPort();
  } catch (error) {
    return null;
  }
}

el.read.addEventListener('click', async () => {
  if (job) return;
  commitEdit();
  if (state.dirty && !confirm(t('rxja_mem_read_discard'))) return;
  const port = await pickPort();
  if (!port || !(await beginJob('fm-read'))) return;
  const { signal } = job.abort;
  setBar(0);
  try {
    const version = await connect(port);
    const image = await readFm(signal, 'rxja_fm_reading');
    setSnapshot(image, { key: 'rxja_mem_from_radio', arg: version });
    render();
    setBar(100);
    setStatus('done', t(F.hasMagic(image) ? 'rxja_fm_read_done' : 'rxja_fm_read_nohdr', state.stations.size));
  } catch (error) {
    if (isAbort(error)) setStatus('skipped', t('rxja_mem_aborted_read'));
    else setStatus('error', t('rxja_mem_error', error.message || String(error)));
  } finally {
    await endJob();
  }
});

function askWrite(counts, writes) {
  return new Promise(resolve => {
    const parts = [];
    if (counts.added) parts.push(t('rxja_mem_added', counts.added));
    if (counts.changed) parts.push(t('rxja_mem_changed', counts.changed));
    if (counts.deleted) parts.push(t('rxja_mem_deleted', counts.deleted));
    const bytes = writes.reduce((s, w) => s + w.data.length, 0);
    el.writeText.textContent = t('rxja_fm_write_text', parts.join('・') || t('rxja_fm_header_only'), writes.length, bytes);
    el.writeDelete.hidden = !counts.deleted;
    el.writeDelete.textContent = counts.deleted ? t('rxja_fm_write_delete', counts.deleted) : '';
    const problem = jaNameProblem();
    el.writeJa.hidden = !problem;
    el.writeJa.textContent = problem;
    el.writeDialog.returnValue = '';
    el.writeDialog.onclose = () => resolve(el.writeDialog.returnValue === 'write');
    el.writeDialog.showModal();
  });
}

el.write.addEventListener('click', async () => {
  if (job) return;
  if (!commitEdit()) return;
  const port = await pickPort();
  if (!port || !(await beginJob('fm-write'))) return;
  const { signal } = job.abort;
  setBar(0);
  let phase = 'read';
  try {
    const version = await connect(port);
    // Read again: the radio may have changed (save on the radio, auto-scan) since the table was read.
    // Stations are numbered slots, so build on the fresh image as it is.
    const fresh = await readFm(signal, 'rxja_fm_reading_before');
    if (state.snapshot && !sameStations(state.snapshot, fresh)) {
      setSnapshotKeepEdits(fresh);
      if (!confirm(t('rxja_fm_radio_changed'))) {
        render();
        setStatus('skipped', t('rxja_mem_write_cancelled'));
        return;
      }
    }
    const before = state.snapshot || fresh;
    const target = F.buildImage(fresh, [...state.stations.values()]);
    const writes = F.planWrites(fresh, target, CHUNK);
    if (!writes.length) {
      setSnapshot(fresh, { key: 'rxja_mem_from_radio', arg: version });
      render();
      setStatus('done', t('rxja_mem_nothing'));
      return;
    }
    if (!state.snapshot) state.base = new Map(F.decodeAll(fresh).map(s => [s.number, s]));
    const counts = diffCounts();
    setStatus('waiting', t('rxja_mem_confirm_wait'));
    if (!(await askWrite(counts, writes))) {
      setStatus('skipped', t('rxja_mem_write_cancelled'));
      return;
    }
    void before;
    download(fresh, `uvk1-fm-backup-${stamp()}.bin`, 'application/octet-stream');

    phase = 'write';
    const total = writes.reduce((s, w) => s + w.data.length, 0);
    let done = 0;
    for (const w of writes) {
      signal.throwIfAborted();
      await radio.writeEeprom(w.addr, w.data);
      done += w.data.length;
      const pct = Math.floor(done * 100 / total);
      setBar(pct);
      setStatus('writing', t('rxja_mem_writing', pct));
    }
    phase = 'verify';
    done = 0;
    for (const w of writes) {
      const got = await radio.readEeprom(w.addr, w.data.length);
      if (got.some((b, i) => b !== w.data[i]))
        throw new RadioError(t('rxja_mem_verify_bad', '0x' + w.addr.toString(16).toUpperCase().padStart(4, '0')));
      done += w.data.length;
      const pct = Math.floor(done * 100 / total);
      setBar(pct);
      setStatus('verifying', t('rxja_mem_verifying', pct));
    }
    await radio.reboot();
    setSnapshot(target, { key: 'rxja_mem_from_radio', arg: version });
    render();
    setBar(100);
    setStatus('done', t('rxja_fm_write_done', writes.length));
  } catch (error) {
    if (isAbort(error)) setStatus('skipped', t(phase === 'write' ? 'rxja_mem_aborted_write' : 'rxja_mem_aborted_read'));
    else setStatus('error', t(phase === 'write' || phase === 'verify' ? 'rxja_mem_error_write' : 'rxja_mem_error',
      error.message || String(error)));
  } finally {
    await endJob();
  }
});

function sameStations(a, b) {
  return JSON.stringify(F.decodeAll(a)) === JSON.stringify(F.decodeAll(b));
}

// The radio changed under us: take its stations as the new base, keep the user's edits on top
function setSnapshotKeepEdits(fresh) {
  const edits = new Map(state.stations);
  const oldBase = state.base;
  state.snapshot = fresh;
  state.base = new Map(F.decodeAll(fresh).map(s => [s.number, s]));
  const next = new Map([...state.base].map(([n, s]) => [n, { ...s }]));
  for (let n = 0; n < F.COUNT; n++) {
    const was = oldBase.get(n), now = edits.get(n);
    const touched = JSON.stringify(was) !== JSON.stringify(now);
    if (!touched) continue;
    if (now) next.set(n, { ...now }); else next.delete(n);
  }
  state.stations = next;
}

el.stop.addEventListener('click', () => job?.abort.abort());

window.addEventListener('beforeunload', event => {
  if (state.dirty && !job) { event.preventDefault(); event.returnValue = ''; }
});

// ---------- view lifecycle ----------

let ready = false;

function init() {
  if (ready) return;
  ready = true;
  render();
  fillPrefectures();
}

window.addEventListener('uvstudio:toolviewchange', event => {
  if (event.detail?.view === 'fm') init();
});

window.addEventListener('uvstudio:languagechange', () => {
  if (!ready) return;
  render();
  fillPrefectures();
  if (el.panel.dataset.state === 'idle') setStatus('idle', t('rxja_fm_idle'));
});

if ($('fm-content')?.classList.contains('active')) init();
