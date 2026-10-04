// RxJa Tools: memory channel editor. Added by the RxJa project; not part of UV Studio.
//
// The table holds the editor's channels (1-1024). Reading takes the radio's
// memory image (0x0000-0x886D over 0x051B) as the snapshot; writing reads the
// radio again, builds the image the table describes on top of it, downloads a
// backup, writes only the 8-byte blocks that differ (0x051D), reads them back
// and reboots the radio, which only picks the changes up at start-up.
// Japanese names and comments are not stored on the radio yet; they travel in
// the CSV and are remembered in this browser (by frequency + name) so a later
// read from the radio gets them back.

import { Radio, RadioError } from './rxja.js?v=2';
import * as M from './rxja-memmap.js';
import { decodeText, readTable, writeCsv } from './rxja-csv.js';

const READ_CHUNK = 128;
const WRITE_CHUNK = 128;
const PRESET = {
  url: 'presets/jp-common.csv',
  listNames: ['AIR', 'SEA', 'RAL', 'SAT', 'PUB', 'BC', 'CB', 'TKK', 'HAM'],
};
const MEMO_KEY = 'rxja.mem.memo.v1';

const t = (key, ...values) => window.uvStudioI18n ? window.uvStudioI18n.t(key, ...values) : key;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const serial = window.UVStudioSerial.register('rxja-mem', { disconnect: () => closeRadio() });

const state = {
  snapshot: null,          // image last read from / written to the radio
  base: new Map(),         // number -> channel decoded from snapshot
  baseLists: [],
  channels: new Map(),     // number -> channel being edited
  listNames: Array(M.LIST_COUNT).fill(''),
  selected: new Set(),
  source: null,            // { key, arg } or { text } of where the table came from
  showEmpty: false,
  filter: '',
};

let radio = null;
let job = null;           // { abort, token }

// ---------- elements ----------

const el = {
  read: $('rxjaMemRead'),
  write: $('rxjaMemWrite'),
  importBtn: $('rxjaMemImport'),
  file: $('rxjaMemFile'),
  preset: $('rxjaMemPreset'),
  exportBtn: $('rxjaMemExport'),
  stop: $('rxjaMemStop'),
  panel: $('rxjaMemPanel'),
  status: $('rxjaMemStatus'),
  fill: $('rxjaMemFill'),
  label: $('rxjaMemLabel'),
  summary: $('rxjaMemSummary'),
  showEmpty: $('rxjaMemShowEmpty'),
  filter: $('rxjaMemFilter'),
  add: $('rxjaMemAdd'),
  del: $('rxjaMemDelete'),
  up: $('rxjaMemUp'),
  down: $('rxjaMemDown'),
  revert: $('rxjaMemRevert'),
  clear: $('rxjaMemClear'),
  table: $('rxjaMemTable'),
  body: $('rxjaMemBody'),
  all: $('rxjaMemAll'),
  lists: $('rxjaMemLists'),
  importDialog: $('rxjaMemImportDialog'),
  importText: $('rxjaMemImportText'),
  importErrors: $('rxjaMemImportErrors'),
  importMergeHint: $('rxjaMemImportMergeHint'),
  writeDialog: $('rxjaMemWriteDialog'),
  writeText: $('rxjaMemWriteText'),
  writeDelete: $('rxjaMemWriteDelete'),
};

if (!el.table) throw new Error('memory editor markup missing');

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

// ---------- serial job (same pattern as rxja-ja.js) ----------

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
  const token = serial.beginOperation(operation, { critical: operation === 'mem-write' });
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

// Ask for the port, open it and check that the firmware uses the 1024-channel
// layout (F4HWN v5 and later for UV-K1 / UV-K5 V3, which RxJa is built on).
async function connect(port) {
  const opened = new Radio(port);
  await opened.open();
  radio = opened;
  setStatus('connecting', t('rxja_mem_connecting'));
  const version = await radio.hello();
  serial.setState('connected', { reason: 'mem' });
  const m = version.match(/F4HWN\s+v(\d+)/i);
  if (!m || Number(m[1]) < 5) throw new RadioError(t('rxja_mem_badfw', version || '?'));
  return version;
}

async function readImage(signal, phaseKey) {
  const image = M.newImage();
  for (let addr = 0; addr < M.IMAGE_SIZE; addr += READ_CHUNK) {
    signal.throwIfAborted();
    const len = Math.min(READ_CHUNK, M.IMAGE_SIZE - addr);
    image.set(await radio.readEeprom(addr, len), addr);
    const pct = Math.floor((addr + len) * 100 / M.IMAGE_SIZE);
    setBar(pct);
    setStatus('reading', t(phaseKey, pct));
  }
  return image;
}

const isAbort = e => e && e.name === 'AbortError';

// ---------- memo of Japanese names / comments ----------

const memoKey = ch => `${ch.freq}|${ch.name}`;

function loadMemo() {
  try { return JSON.parse(localStorage.getItem(MEMO_KEY) || '{}'); } catch (e) { return {}; }
}

function rememberExtras(channels) {
  const memo = loadMemo();
  for (const ch of channels) {
    if (ch.nameJa || ch.comment) memo[memoKey(ch)] = [ch.nameJa || '', ch.comment || ''];
  }
  try { localStorage.setItem(MEMO_KEY, JSON.stringify(memo)); } catch (e) {}
}

function fillExtras(channels) {
  const memo = loadMemo();
  for (const ch of channels) {
    const m = memo[memoKey(ch)];
    if (m) [ch.nameJa, ch.comment] = m;
  }
}

// ---------- model helpers ----------

const clone = ch => ({ ...ch, rxTone: { ...ch.rxTone }, txTone: { ...ch.txTone }, rec: ch.rec ? ch.rec.slice() : null });

function setSnapshot(image, source) {
  state.snapshot = image;
  const decoded = M.decodeAll(image);
  const keep = new Map([...state.channels.values()].map(ch => [memoKey(ch), ch]));
  fillExtras(decoded);
  // Extras still in the table win over the memo (same frequency and name)
  for (const ch of decoded) {
    const k = keep.get(memoKey(ch));
    if (k) { ch.nameJa = k.nameJa; ch.comment = k.comment; }
  }
  state.base = new Map(decoded.map(ch => [ch.number, ch]));
  state.baseLists = M.decodeListNames(image);
  state.channels = new Map(decoded.map(ch => [ch.number, clone(ch)]));
  state.listNames = state.baseLists.slice();
  state.selected.clear();
  state.source = source;
}

function baseImage() {
  return state.snapshot || M.newImage();
}

function targetImage() {
  return M.buildImage(baseImage(), [...state.channels.values()], state.listNames);
}

// Per-channel comparison against the snapshot: 'added' | 'changed' | null
function slotDiff(from, to, i) {
  const same = (base, size) => {
    for (let k = base + i * size; k < base + (i + 1) * size; k++) if (from[k] !== to[k]) return false;
    return true;
  };
  if (same(M.CHAN_BASE, 16) && same(M.NAME_BASE, 16) && same(M.ATTR_BASE, 2)) return null;
  return M.emptyAt(from, i) ? 'added' : M.emptyAt(to, i) ? 'deleted' : 'changed';
}

function diffCounts(from = baseImage(), to = targetImage()) {
  const c = { added: 0, changed: 0, deleted: 0, lists: false };
  for (let i = 0; i < M.CHANNELS; i++) {
    const d = slotDiff(from, to, i);
    if (d) c[d]++;
  }
  // By text: an erased (0xFF) list name and an empty one are the same to the radio
  const a = M.decodeListNames(from), b = M.decodeListNames(to);
  c.lists = a.some((name, i) => name !== b[i]);
  return { ...c, from, to };
}

function nextFree(after = 0) {
  for (let n = after + 1; n <= M.CHANNELS; n++) if (!state.channels.has(n)) return n;
  for (let n = 1; n <= after; n++) if (!state.channels.has(n)) return n;
  return null;
}

function newChannel(number) {
  return {
    number, name: '', nameJa: '', comment: '', freq: 145000000, offset: 0, duplex: '',
    rxTone: { mode: '', value: null, pol: 'N' }, txTone: { mode: '', value: null, pol: 'N' },
    mode: 'NFM', step: 12.5, power: 0, scanlist: 0, compander: 0, rec: null,
  };
}

// Swap (or move into a free slot) channel numbers a and b
function swap(a, b) {
  const ca = state.channels.get(a), cb = state.channels.get(b);
  state.channels.delete(a);
  state.channels.delete(b);
  if (ca) state.channels.set(b, { ...ca, number: b });
  if (cb) state.channels.set(a, { ...cb, number: a });
}

// ---------- table ----------

const STEP_OPTIONS = [...M.STEPS].sort((a, b) => a - b);

function scanlistText(v) {
  if (v === 0) return t('rxja_mem_off');
  if (v === M.LIST_COUNT + 1) return t('rxja_mem_all');
  const name = state.listNames[v - 1];
  return name ? `${v} ${name}` : String(v);
}

function toneText(tone) {
  return M.toneLabel(tone) || '';
}

const FIELDS = ['name', 'nameJa', 'freq', 'mode', 'step', 'scanlist', 'rxTone', 'comment'];

function fieldText(ch, f) {
  switch (f) {
    case 'freq': return M.formatMHz(ch.freq);
    case 'step': return String(ch.step);
    case 'scanlist': return scanlistText(ch.scanlist);
    case 'rxTone': return toneText(ch.rxTone);
    default: return ch[f] ?? '';
  }
}

function fieldEqual(a, b, f) {
  if (f === 'rxTone') return M.toneLabel(a.rxTone) === M.toneLabel(b.rxTone);
  return a[f] === b[f];
}

function visibleNumbers() {
  const q = state.filter.trim().toLowerCase();
  const out = [];
  for (let n = 1; n <= M.CHANNELS; n++) {
    const ch = state.channels.get(n);
    if (!ch) {
      if (state.showEmpty && !q) out.push(n);
      continue;
    }
    if (q) {
      const hay = `${n} ${ch.name} ${ch.nameJa} ${M.formatMHz(ch.freq)} ${ch.comment}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(n);
  }
  return out;
}

function render() {
  const from = baseImage();
  const to = targetImage();
  const rows = [];
  for (const n of visibleNumbers()) {
    const ch = state.channels.get(n);
    const sel = state.selected.has(n);
    if (!ch) {
      rows.push(`<tr class="rxja-mem-empty" data-n="${n}"><td class="rxja-mem-check"><input type="checkbox" disabled></td>`
        + `<td class="rxja-mem-num">${n}</td><td colspan="${FIELDS.length}"><button type="button" class="btn rxja-mem-addhere" data-n="${n}">${esc(t('rxja_mem_addhere'))}</button></td></tr>`);
      continue;
    }
    const d = slotDiff(from, to, n - 1);
    const base = state.base.get(n);
    const cells = FIELDS.map(f => {
      const changed = d === 'changed' && base && !fieldEqual(base, ch, f) ? ' rxja-mem-changed' : '';
      const extraOnly = f === 'nameJa' || f === 'comment' ? ' rxja-mem-local' : '';
      return `<td class="rxja-mem-cell${changed}${extraOnly}" data-f="${f}" tabindex="0">${esc(fieldText(ch, f))}</td>`;
    }).join('');
    rows.push(`<tr data-n="${n}" class="${d === 'added' ? 'rxja-mem-added' : ''}${sel ? ' rxja-mem-selected' : ''}">`
      + `<td class="rxja-mem-check"><input type="checkbox" data-n="${n}"${sel ? ' checked' : ''} aria-label="${esc(t('rxja_mem_select', n))}"></td>`
      + `<td class="rxja-mem-num rxja-mem-cell" data-f="number" tabindex="0">${n}</td>${cells}</tr>`);
  }
  if (!rows.length) rows.push(`<tr><td colspan="${FIELDS.length + 2}" class="rxja-mem-none">${esc(t('rxja_mem_none'))}</td></tr>`);
  el.body.innerHTML = rows.join('');
  renderSummary();
  refreshButtons();
}

function renderSummary() {
  const c = diffCounts();
  const parts = [t('rxja_mem_count', state.channels.size)];
  if (state.source) parts.push(state.source.key ? t(state.source.key, state.source.arg) : state.source.text);
  const changes = [];
  if (c.added) changes.push(t('rxja_mem_added', c.added));
  if (c.changed) changes.push(t('rxja_mem_changed', c.changed));
  if (c.deleted) changes.push(t('rxja_mem_deleted', c.deleted));
  if (c.lists) changes.push(t('rxja_mem_lists_changed'));
  parts.push(changes.length ? t('rxja_mem_vs_radio', changes.join('・')) : (state.snapshot ? t('rxja_mem_same') : ''));
  el.summary.textContent = parts.filter(Boolean).join(' / ');
  state.dirty = Boolean(c.added || c.changed || c.deleted || c.lists);
}

function renderLists() {
  el.lists.innerHTML = state.listNames.map((name, i) =>
    `<label class="rxja-mem-list"><span>${i + 1}</span><input type="text" maxlength="${M.LIST_NAME_LEN}" data-i="${i}" value="${esc(name)}" spellcheck="false"></label>`).join('');
}

function refreshButtons() {
  const busy = Boolean(job);
  el.read.disabled = busy;
  el.write.disabled = busy || !state.channels.size && !state.snapshot;
  el.importBtn.disabled = busy;
  el.preset.disabled = busy;
  el.exportBtn.disabled = busy || !state.channels.size;
  el.stop.hidden = !busy;
  el.add.disabled = busy || nextFree() === null;
  const anySel = [...state.selected].some(n => state.channels.has(n));
  el.del.disabled = busy || !anySel;
  el.up.disabled = busy || !anySel;
  el.down.disabled = busy || !anySel;
  el.revert.disabled = busy || !state.dirty;
  el.clear.disabled = busy || !state.channels.size;
  el.table.classList.toggle('rxja-mem-busy', busy);
}

// ---------- cell editing ----------

let editing = null;   // { td, n, f, input }

function editorFor(ch, f) {
  if (f === 'mode' || f === 'step' || f === 'scanlist' || f === 'rxTone') {
    const s = document.createElement('select');
    const add = (value, label, selected) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = label; o.selected = selected;
      s.appendChild(o);
    };
    if (f === 'mode') M.MODES.forEach(m => add(m, m, ch.mode === m));
    if (f === 'step') STEP_OPTIONS.forEach(v => add(v, `${v} kHz`, ch.step === v));
    if (f === 'scanlist') for (let v = 0; v <= M.LIST_COUNT + 1; v++) add(v, scanlistText(v), ch.scanlist === v);
    if (f === 'rxTone') {
      const cur = M.toneLabel(ch.rxTone);
      add('', t('rxja_mem_tone_none'), cur === '');
      const group = (label, items) => {
        const g = document.createElement('optgroup');
        g.label = label;
        items.forEach(([v, text]) => { const o = document.createElement('option'); o.value = v; o.textContent = text; o.selected = v === cur; g.appendChild(o); });
        s.appendChild(g);
      };
      group('CTCSS', M.CTCSS_TONES.map(v => [v.toFixed(1), `${v.toFixed(1)} Hz`]));
      group('DCS', M.DTCS_CODES.map(v => { const l = `D${String(v).padStart(3, '0')}N`; return [l, l]; }));
      group(t('rxja_mem_dcs_inv'), M.DTCS_CODES.map(v => { const l = `D${String(v).padStart(3, '0')}I`; return [l, l]; }));
    }
    return s;
  }
  const i = document.createElement('input');
  i.type = 'text';
  i.spellcheck = false;
  if (f === 'number') { i.inputMode = 'numeric'; i.value = String(ch ? ch.number : ''); }
  else if (f === 'freq') { i.inputMode = 'decimal'; i.value = M.formatMHz(ch.freq); }
  else { i.value = ch[f] ?? ''; }
  if (f === 'name') i.maxLength = M.NAME_LEN;
  return i;
}

function startEdit(td) {
  if (job || !td || editing?.td === td) return;
  const n = Number(td.parentElement.dataset.n);
  const f = td.dataset.f;
  if (editing) {
    // Committing re-renders the table, so look the cell up again afterwards
    if (!commitEdit()) return;
    td = el.body.querySelector(`tr[data-n="${n}"] td[data-f="${f}"]`);
    if (!td) return;
  }
  const ch = state.channels.get(n);
  if (!ch) return;
  const input = editorFor(ch, f);
  input.className = 'rxja-mem-input';
  td.textContent = '';
  td.appendChild(input);
  td.classList.add('rxja-mem-editing');
  editing = { td, n, f, input };
  input.focus();
  if (input.select && input.tagName === 'INPUT') input.select();
  input.addEventListener('keydown', onEditKey);
  input.addEventListener('blur', () => setTimeout(() => { if (editing?.input === input) commitEdit(); }, 0));
  if (input.tagName === 'SELECT') input.addEventListener('change', () => commitEdit(true));
}

// Returns false (and keeps the editor open) when the value is not valid
function commitEdit(keepFocus = false) {
  if (!editing) return true;
  const { td, n, f, input } = editing;
  const ch = state.channels.get(n);
  const v = input.value;
  let next = n;
  let error = '';
  if (ch) {
    if (f === 'freq') {
      const hz = M.parseMHz(v);
      if (!hz || hz < M.MIN_HZ || hz > M.MAX_HZ) error = t('rxja_mem_bad_freq');
      else ch.freq = hz;
    } else if (f === 'name') {
      const name = M.asciiName(v);
      if (name !== v.trimEnd()) setStatus('idle', t('rxja_mem_name_ascii'));
      ch.name = name;
    } else if (f === 'mode') ch.mode = v;
    else if (f === 'step') ch.step = Number(v);
    else if (f === 'scanlist') ch.scanlist = Number(v);
    else if (f === 'rxTone') ch.rxTone = M.parseToneLabel(v) || ch.rxTone;
    else if (f === 'number') {
      const to = Number(v);
      if (!Number.isInteger(to) || to < 1 || to > M.CHANNELS) error = t('rxja_mem_bad_number');
      else if (to !== n) { swap(n, to); next = to; state.selected.clear(); }
    } else ch[f] = v.trim();
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
  if (keepFocus || next !== n) focusCell(next, f);
  return true;
}

function cancelEdit() {
  if (!editing) return;
  const { n, f } = editing;
  editing = null;
  render();
  focusCell(n, f);
}

function focusCell(n, f) {
  const td = el.body.querySelector(`tr[data-n="${n}"] td[data-f="${f}"]`);
  if (td) td.focus();
  return td;
}

function moveFocus(n, f, dRow, dCol) {
  const cols = ['number', ...FIELDS];
  const rows = [...el.body.querySelectorAll('tr[data-n]')].filter(tr => !tr.classList.contains('rxja-mem-empty')).map(tr => Number(tr.dataset.n));
  let r = rows.indexOf(n), c = cols.indexOf(f);
  c += dCol;
  if (c >= cols.length) { c = 0; r++; }
  if (c < 0) { c = cols.length - 1; r--; }
  r += dRow;
  if (r < 0 || r >= rows.length) return null;
  return focusCell(rows[r], cols[c]);
}

function onEditKey(event) {
  if (!editing) return;
  const { n, f } = editing;
  if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); return; }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    if (!commitEdit()) return;
    const td = event.key === 'Enter'
      ? moveFocus(n, f, event.shiftKey ? -1 : 1, 0)
      : moveFocus(n, f, 0, event.shiftKey ? -1 : 1);
    if (td && event.key === 'Tab') startEdit(td);
  }
}

el.body.addEventListener('click', event => {
  const add = event.target.closest('.rxja-mem-addhere');
  if (add) { addChannel(Number(add.dataset.n)); return; }
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
  if (!td || editing?.td === td) return;
  const n = Number(td.parentElement.dataset.n), f = td.dataset.f;
  if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); startEdit(td); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(n, f, 1, 0); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(n, f, -1, 0); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); moveFocus(n, f, 0, 1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(n, f, 0, -1); }
});

el.all.addEventListener('change', () => {
  for (const n of visibleNumbers()) {
    if (!state.channels.has(n)) continue;
    if (el.all.checked) state.selected.add(n); else state.selected.delete(n);
  }
  render();
});

// ---------- row operations ----------

function addChannel(at) {
  if (job) return;
  commitEdit();
  const sel = [...state.selected].sort((a, b) => a - b);
  const n = at || nextFree(sel.length ? sel[sel.length - 1] : 0);
  if (!n || state.channels.has(n)) return;
  state.channels.set(n, newChannel(n));
  state.selected.clear();
  render();
  const td = focusCell(n, 'freq');
  if (td) { td.scrollIntoView({ block: 'nearest' }); startEdit(td); }
}

function deleteSelected() {
  commitEdit();
  for (const n of state.selected) state.channels.delete(n);
  state.selected.clear();
  render();
}

function moveSelected(dir) {
  commitEdit();
  const sel = [...state.selected].filter(n => state.channels.has(n)).sort((a, b) => dir * (b - a));
  if (!sel.length) return;
  if (sel.some(n => n + dir < 1 || n + dir > M.CHANNELS)) return;
  for (const n of sel) swap(n, n + dir);
  state.selected = new Set(sel.map(n => n + dir));
  render();
  const first = Math.min(...state.selected);
  el.body.querySelector(`tr[data-n="${first}"]`)?.scrollIntoView({ block: 'nearest' });
}

el.add.addEventListener('click', () => addChannel());
el.del.addEventListener('click', deleteSelected);
el.up.addEventListener('click', () => moveSelected(-1));
el.down.addEventListener('click', () => moveSelected(1));
el.revert.addEventListener('click', () => {
  if (!confirm(t('rxja_mem_revert_confirm'))) return;
  state.channels = new Map([...state.base.values()].map(ch => [ch.number, clone(ch)]));
  state.listNames = state.baseLists.length ? state.baseLists.slice() : Array(M.LIST_COUNT).fill('');
  state.selected.clear();
  renderLists();
  render();
});
el.clear.addEventListener('click', () => {
  if (!confirm(t('rxja_mem_clear_confirm'))) return;
  state.channels.clear();
  state.selected.clear();
  render();
});
el.showEmpty.addEventListener('change', () => { state.showEmpty = el.showEmpty.checked; render(); });
el.filter.addEventListener('input', () => { state.filter = el.filter.value; render(); });
el.lists.addEventListener('input', event => {
  const i = Number(event.target.dataset.i);
  if (!Number.isInteger(i)) return;
  state.listNames[i] = event.target.value.replace(/[^\x20-\x7E]/g, '').slice(0, M.LIST_NAME_LEN);
  renderSummary();
  refreshButtons();
});
el.lists.addEventListener('change', () => render());

// ---------- import ----------

// Parse a file: CSV (CHIRP compatible) or a memory image (.bin backup, CHIRP .img)
async function parseFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.(bin|img)$/i.test(file.name)) {
    if (bytes.length < M.IMAGE_SIZE) throw new Error(t('rxja_mem_bad_image', bytes.length));
    const image = bytes.slice(0, M.IMAGE_SIZE);
    const channels = M.decodeAll(image);
    fillExtras(channels);
    return { channels, listNames: M.decodeListNames(image), errors: [], renamed: 0 };
  }
  return parseCsvText(decodeText(bytes).text);
}

function parseCsvText(text) {
  const { header, records, badLines } = readTable(text);
  if (!header.includes('Location') || !header.includes('Frequency')) throw new Error(t('rxja_mem_not_chirp'));
  const errors = badLines.map(line => t('rxja_mem_err_columns', line));
  const channels = [];
  let renamed = 0;
  const seen = new Set();
  for (const r of records) {
    const x = M.rowToChannel(r);
    if (!x.ch) { errors.push(t(`rxja_mem_err_${x.error}`, r.__line, x.value)); continue; }
    if (seen.has(x.ch.number)) { errors.push(t('rxja_mem_err_dup', r.__line, x.ch.number)); continue; }
    seen.add(x.ch.number);
    if (x.nameChanged) renamed++;
    channels.push(x.ch);
  }
  return { channels, listNames: null, errors, renamed };
}

function askImport(parsed, label) {
  return new Promise(resolve => {
    el.importText.textContent = t('rxja_mem_import_text', label.key ? t(label.key) : label, parsed.channels.length)
      + (parsed.renamed ? ' ' + t('rxja_mem_import_renamed', parsed.renamed) : '');
    el.importErrors.hidden = !parsed.errors.length;
    el.importErrors.textContent = parsed.errors.length
      ? t('rxja_mem_import_errors', parsed.errors.length) + '\n' + parsed.errors.slice(0, 8).join('\n')
        + (parsed.errors.length > 8 ? '\n…' : '')
      : '';
    el.importMergeHint.hidden = Boolean(state.snapshot);
    el.importDialog.returnValue = '';
    el.importDialog.onclose = () => resolve(el.importDialog.returnValue);
    el.importDialog.showModal();
  });
}

async function importParsed(parsed, label) {
  if (!parsed.channels.length) {
    setStatus('error', parsed.errors.length ? t('rxja_mem_import_none_err', parsed.errors[0]) : t('rxja_mem_import_none'));
    return;
  }
  const how = await askImport(parsed, label);
  if (how !== 'replace' && how !== 'merge') return;
  if (how === 'replace') state.channels.clear();
  for (const ch of parsed.channels) {
    // A CSV row has no hidden bits; take them from the channel it replaces
    const old = state.channels.get(ch.number) || state.base.get(ch.number);
    if (!ch.rec && old?.rec) ch.rec = old.rec.slice();
    state.channels.set(ch.number, ch);
  }
  if (parsed.listNames) state.listNames = parsed.listNames.slice();
  rememberExtras(parsed.channels);
  state.selected.clear();
  state.source = label.key ? label : { text: label };
  renderLists();
  render();
  setStatus('done', t(how === 'replace' ? 'rxja_mem_imported_replace' : 'rxja_mem_imported_merge', parsed.channels.length));
}

el.importBtn.addEventListener('click', () => { if (!job) el.file.click(); });
el.file.addEventListener('change', async () => {
  const file = el.file.files && el.file.files[0];
  el.file.value = '';
  if (!file) return;
  try {
    await importParsed(await parseFile(file), file.name);
  } catch (error) {
    setStatus('error', t('rxja_mem_import_failed', error.message || String(error)));
  }
});

el.preset.addEventListener('click', async () => {
  if (job) return;
  try {
    const response = await fetch(PRESET.url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseCsvText(decodeText(new Uint8Array(await response.arrayBuffer())).text);
    parsed.listNames = state.listNames.slice();
    PRESET.listNames.forEach((name, i) => { parsed.listNames[i] = name; });
    await importParsed(parsed, { key: 'rxja_mem_preset_label' });
  } catch (error) {
    setStatus('error', t('rxja_mem_import_failed', error.message || String(error)));
  }
});

// ---------- export ----------

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
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
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

el.exportBtn.addEventListener('click', () => {
  commitEdit();
  const rows = [...state.channels.values()].sort((a, b) => a.number - b.number).map(M.channelToRow);
  download(writeCsv(M.CSV_COLUMNS, rows), `uvk1-channels-${stamp()}.csv`, 'text/csv;charset=utf-8');
  rememberExtras(state.channels.values());
  setStatus('done', t('rxja_mem_exported', rows.length));
});

// ---------- read / write ----------

// requestPort needs the click's user activation, so pick the port first
async function pickPort() {
  try {
    return await navigator.serial.requestPort();
  } catch (error) {
    return null;   // dialog cancelled
  }
}

el.read.addEventListener('click', async () => {
  if (job) return;
  commitEdit();
  if (state.dirty && !confirm(t('rxja_mem_read_discard'))) return;
  const port = await pickPort();
  if (!port || !(await beginJob('mem-read'))) return;
  const { signal } = job.abort;
  setBar(0);
  try {
    const version = await connect(port);
    const image = await readImage(signal, 'rxja_mem_reading');
    setSnapshot(image, { key: 'rxja_mem_from_radio', arg: version });
    renderLists();
    render();
    setBar(100);
    setStatus('done', t('rxja_mem_read_done', state.channels.size));
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
    if (counts.lists) parts.push(t('rxja_mem_lists_changed'));
    const bytes = writes.reduce((s, w) => s + w.data.length, 0);
    el.writeText.textContent = t('rxja_mem_write_text', parts.join('・'), writes.length, bytes);
    el.writeDelete.hidden = !counts.deleted;
    el.writeDelete.textContent = counts.deleted ? t('rxja_mem_write_delete', counts.deleted) : '';
    el.writeDialog.returnValue = '';
    el.writeDialog.onclose = () => resolve(el.writeDialog.returnValue === 'write');
    el.writeDialog.showModal();
  });
}

el.write.addEventListener('click', async () => {
  if (job) return;
  if (!commitEdit()) return;
  const port = await pickPort();
  if (!port || !(await beginJob('mem-write'))) return;
  const { signal } = job.abort;
  setBar(0);
  let phase = 'read';
  try {
    const version = await connect(port);
    // Read again: the radio may have changed since the table was loaded
    const fresh = await readImage(signal, 'rxja_mem_reading_before');
    const target = M.buildImage(fresh, [...state.channels.values()], state.listNames);
    const writes = M.planWrites(fresh, target, WRITE_CHUNK);
    if (!writes.length) {
      setSnapshot(fresh, { key: 'rxja_mem_from_radio', arg: version });
      renderLists();
      render();
      setStatus('done', t('rxja_mem_nothing'));
      return;
    }
    const counts = diffCounts(fresh, target);
    setStatus('waiting', t('rxja_mem_confirm_wait'));
    if (!(await askWrite(counts, writes))) {
      setStatus('skipped', t('rxja_mem_write_cancelled'));
      return;
    }
    download(fresh, `uvk1-memory-backup-${stamp()}.bin`, 'application/octet-stream');

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
    rememberExtras(state.channels.values());
    setSnapshot(target, { key: 'rxja_mem_from_radio', arg: version });
    renderLists();
    render();
    setBar(100);
    setStatus('done', t('rxja_mem_write_done', writes.length));
  } catch (error) {
    if (isAbort(error)) setStatus('skipped', t(phase === 'write' ? 'rxja_mem_aborted_write' : 'rxja_mem_aborted_read'));
    else setStatus('error', t(phase === 'write' || phase === 'verify' ? 'rxja_mem_error_write' : 'rxja_mem_error',
      error.message || String(error)));
  } finally {
    await endJob();
  }
});

el.stop.addEventListener('click', () => job?.abort.abort());

// Unsaved edits: warn before leaving the page
window.addEventListener('beforeunload', event => {
  if (state.dirty && !job) { event.preventDefault(); event.returnValue = ''; }
});

// ---------- view lifecycle ----------

let ready = false;
function localize() {
  el.filter.placeholder = t('rxja_mem_filter');
}

function init() {
  if (ready) return;
  ready = true;
  localize();
  renderLists();
  render();
}

window.addEventListener('uvstudio:toolviewchange', event => {
  if (event.detail?.view === 'mem') init();
});

window.addEventListener('uvstudio:languagechange', () => {
  if (!ready) return;
  localize();
  render();
  if (el.panel.dataset.state === 'idle') setStatus('idle', t('rxja_mem_idle'));
});

if ($('mem-content')?.classList.contains('active')) init();
