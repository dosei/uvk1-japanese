// Firmware catalog: lists stable archive/ files from the main branch and the
// optional rolling development build from feature_update_v6 through the GitHub
// Contents API. Selected builds feed into either the main flash pipeline or the
// multiboot-slot pipeline through window.UVStudioFlash. Pure helpers are exported
// for Node tests; the browser runtime is guarded and self-boots.
//
// Modified by the RxJa project: RxJa releases bundled with this site
// (firmware/index.json) are listed first; picking one also tells rxja-ja.js to
// write the matching Japanese data after the flash.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UVStudioFlashCatalog = api;

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => api.boot());
    } else {
      api.boot();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REPO = 'armel/uv-k1-k5v3-firmware-custom';
  const ARCHIVE_PATH = 'archive';
  const STABLE_BRANCH = 'main';
  const API_URL =
    `https://api.github.com/repos/${REPO}/contents/${ARCHIVE_PATH}` +
    `?ref=${encodeURIComponent(STABLE_BRANCH)}`;
  const DEVELOPMENT_BRANCH = 'feature_update_v6';
  const DEVELOPMENT_FILENAME = 'f4hwn.fusion.development.bin';
  const DEVELOPMENT_API_URL =
    `https://api.github.com/repos/${REPO}/contents/${ARCHIVE_PATH}/${DEVELOPMENT_FILENAME}` +
    `?ref=${encodeURIComponent(DEVELOPMENT_BRANCH)}`;
  // Only current firmwares are offered: v5.0 and newer, no beta or SA818 builds.
  const MIN_MAJOR_VERSION = 5;
  // Multiboot first ships with v6; older images cannot return to the slot menu.
  const MIN_SLOT_MAJOR_VERSION = 6;

  // Group labels are technical terms shared across every language.
  const RXJA_MANIFEST_URL = 'firmware/index.json';

  const GROUP_ORDER = [
    'rxja', 'fusion', 'fieldops', 'transfer', 'labs',
    'development', 'fusion_k1', 'fusion_k5v3', 'stock'
  ];
  const GROUP_LABELS = {
    rxja: 'RxJa',
    fusion: 'F4HWN Fusion (stable)',
    fieldops: 'F4HWN FieldOps',
    transfer: 'F4HWN Transfer',
    labs: 'F4HWN Labs',
    development: 'F4HWN Fusion (dev, unstable)',
    fusion_k1: 'F4HWN Fusion · K1',
    fusion_k5v3: 'F4HWN Fusion · K5v3',
    stock: 'Quansheng (stock)'
  };

  // ========== PURE HELPERS (Node-testable) ==========

  // Parse an archive filename into a structured entry, or null when the file is
  // not a flashable firmware image (logos and other assets are ignored).
  function parseFirmwareName(name) {
    if (typeof name !== 'string') return null;
    const lower = name.toLowerCase();
    if (!lower.endsWith('.bin')) return null;

    const isBeta = /\.beta\b/.test(lower);
    const isSa818 = /\.sa818\b/.test(lower);
    const isDevelopment = lower === DEVELOPMENT_FILENAME;
    const versionMatch = lower.match(/[._-]v(\d+(?:\.\d+)*)/);
    const version = versionMatch ? versionMatch[1] : '';

    let brand;
    let group;
    let model = '';

    if (isDevelopment) {
      brand = 'f4hwn';
      group = 'development';
    } else if (lower.startsWith('quansheng')) {
      brand = 'stock';
      group = 'stock';
      if (lower.includes('.k1.')) model = 'K1';
      else if (lower.includes('.k5v3.')) model = 'K5v3';
    } else {
      brand = 'f4hwn';
      const editionMatch = lower.match(
        /^f4hwn[._-](?:(k1|k5v3)[._-])?([a-z][a-z0-9-]*)(?:[._-].*)?\.bin$/
      );
      if (!editionMatch) return null;
      const modelToken = editionMatch[1] || '';
      const editionToken = editionMatch[2];
      if (modelToken === 'k1' && editionToken === 'fusion') { group = 'fusion_k1'; model = 'K1'; }
      else if (modelToken === 'k5v3' && editionToken === 'fusion') { group = 'fusion_k5v3'; model = 'K5v3'; }
      else { group = editionToken; model = modelToken === 'k1' ? 'K1' : (modelToken === 'k5v3' ? 'K5v3' : ''); }
    }

    return { name, brand, group, model, version, isBeta, isSa818, isDevelopment };
  }

  // Descending semantic comparison so v5.10.0 correctly outranks v5.9.0.
  function compareVersionDesc(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const da = pa[i] || 0;
      const db = pb[i] || 0;
      if (da !== db) return db - da;
    }
    return 0;
  }

  function majorVersion(version) {
    const major = parseInt(String(version).split('.')[0], 10);
    return Number.isFinite(major) ? major : -1;
  }

  // Keep only current, stable, non-SA818 firmware images (v5.0 and newer).
  function isOffered(entry) {
    return entry.isDevelopment ||
      (!entry.isBeta && !entry.isSa818 && majorVersion(entry.version) >= MIN_MAJOR_VERSION);
  }

  // Multiboot slots offer stable v6+ F4HWN editions. Older images, the rolling
  // development build and Quansheng stock images do not embed multiboot.
  // RxJa numbers its own releases (0.x) but is built on the v6 Fusion preset,
  // so every RxJa release carries multiboot.
  function isSlotOffered(entry) {
    if (entry && entry.brand === 'rxja') return true;
    return Boolean(entry) && isOffered(entry) && entry.brand === 'f4hwn' &&
      !entry.isDevelopment && majorVersion(entry.version) >= MIN_SLOT_MAJOR_VERSION;
  }

  // Every stable, versioned F4HWN edition shares the CHIRP driver published for
  // that firmware version. Development and stock Quansheng builds do not.
  function hasSharedChirpDriver(entry) {
    return Boolean(entry) && isOffered(entry) && entry.brand === 'f4hwn' &&
      !entry.isDevelopment && Boolean(entry.version);
  }

  function normalizeFile(file) {
    return {
      name: file && file.name,
      size: file && file.size,
      download_url: file && file.download_url
    };
  }

  // Stable listings never supply the rolling entry. Its canonical source is the
  // development branch, even if a stale copy happens to exist on main.
  function mergeCatalogFiles(stableFiles, developmentFile) {
    const files = (Array.isArray(stableFiles) ? stableFiles : [])
      .filter(file => file && file.name !== DEVELOPMENT_FILENAME)
      .map(normalizeFile);
    if (developmentFile && developmentFile.name === DEVELOPMENT_FILENAME) {
      files.push(normalizeFile(developmentFile));
    }
    return files;
  }

  // Group GitHub file entries ({ name, size, download_url }) into an ordered map
  // of firmware families, newest version first within each family.
  function categorize(files) {
    const groups = new Map();
    GROUP_ORDER.forEach(id => groups.set(id, []));

    (Array.isArray(files) ? files : []).forEach(file => {
      const parsed = parseFirmwareName(file && file.name);
      if (!parsed || !groups.has(parsed.group) || !isOffered(parsed)) return;
      groups.get(parsed.group).push(Object.assign(parsed, {
        size: file.size,
        url: file.download_url
      }));
    });

    groups.forEach(list => list.sort((a, b) => compareVersionDesc(a.version, b.version)));
    return groups;
  }

  // RxJa manifest release → catalog entry. Paths are resolved against baseURL
  // (the page) so flash.js always receives an absolute URL.
  function rxjaEntriesFromManifest(manifest, baseURL) {
    const releases = manifest && Array.isArray(manifest.releases) ? manifest.releases : [];
    return releases
      .filter(r => r && r.tag && r.firmware && r.firmware.path)
      .map(r => ({
        name: String(r.firmware.path).split('/').pop(),
        brand: 'rxja',
        group: 'rxja',
        model: '',
        tag: r.tag,
        version: r.version || String(r.tag).replace(/^rxja-v/, ''),
        prerelease: Boolean(r.prerelease),
        isBeta: false,
        isSa818: false,
        isDevelopment: false,
        size: r.firmware.size,
        sha256: r.firmware.sha256 || '',
        url: new URL(r.firmware.path, baseURL).href,
        ja: r.ja && r.ja.path ? {
          url: new URL(r.ja.path, baseURL).href,
          size: r.ja.size,
          sha256: r.ja.sha256 || ''
        } : null
      }));
  }

  // Compact option label, e.g. "v5.7.0 · 58 KB" or "K1 v7.03.01 · 61 KB".
  function formatOptionLabel(entry, translate) {
    if (entry.group === 'rxja') {
      let label = `v${entry.version}`;
      if (entry.prerelease) label += translate ? translate('rxja_prerelease') : ' (pre-release)';
      if (Number.isFinite(entry.size)) label += ` · ${Math.round(entry.size / 1024)} KB`;
      return label;
    }
    const parts = [];
    if (entry.group === 'stock' && entry.model) parts.push(entry.model);
    // Kept in English like the other technical tags (stable / dev / stock).
    if (entry.isDevelopment) parts.push('⚠ Development · unstable');
    else parts.push(entry.version ? `v${entry.version}` : entry.name);
    let label = parts.join(' ');
    if (Number.isFinite(entry.size)) label += ` · ${Math.round(entry.size / 1024)} KB`;
    return label;
  }

  const pureApi = {
    parseFirmwareName,
    compareVersionDesc,
    categorize,
    formatOptionLabel,
    hasSharedChirpDriver,
    isOffered,
    isSlotOffered,
    mergeCatalogFiles,
    rxjaEntriesFromManifest
  };

  // ========== BROWSER RUNTIME ==========

  function boot() {
    const select = document.getElementById('firmwareCatalogSelect');
    const section = document.getElementById('firmwareCatalogSection');
    const divider = document.getElementById('firmwareCatalogOr');
    const slotSelect = document.getElementById('slotFirmwareCatalogSelect');
    const slotSection = document.getElementById('slotFirmwareCatalogSection');
    const slotDivider = document.getElementById('slotFirmwareCatalogOr');
    const selects = [select, slotSelect].filter(Boolean);
    if (!selects.length) return; // Catalog markup absent.

    // Purge the obsolete persistent listing cache written by earlier versions.
    if (window.UVStudioPreferences) {
      try { window.UVStudioPreferences.remove('uvstudio.firmwareCatalog'); } catch (e) {}
    }

    // Kept only in memory for the lifetime of the page. When the listing cannot be
    // fetched (no connection), the whole picker stays hidden and only the local
    // file input remains — exactly the pre-catalog experience.
    let groups = null;
    let loaded = false;
    let loading = false;
    let retryUntil = 0; // epoch ms before which we must not re-hit a rate-limited API
    let rxjaEntries = null; // bundled RxJa releases (same origin, never rate limited)
    let upstreamLoaded = false;

    function t(key) {
      return window.uvStudioI18n ? window.uvStudioI18n.t(key) : key;
    }

    function showCatalog(flashVisible, slotVisible = flashVisible) {
      if (section) section.hidden = !flashVisible;
      if (divider) divider.hidden = !flashVisible;
      if (slotSection) slotSection.hidden = !slotVisible;
      if (slotDivider) slotDivider.hidden = !slotVisible;
    }

    async function fetchDevelopmentFile() {
      try {
        const response = await fetch(DEVELOPMENT_API_URL, { cache: 'no-cache' });
        if (!response.ok) return null;
        const item = await response.json();
        return {
          name: item.name,
          size: item.size,
          download_url: item.download_url
        };
      } catch (error) {
        return null;
      }
    }

    // Build the menu and return how many firmware options it holds.
    function renderSelect(targetSelect, entryFilter = () => true) {
      const previous = targetSelect.value;
      targetSelect.textContent = '';

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = t('flash_catalog_placeholder');
      placeholder.disabled = true;
      placeholder.selected = true;
      targetSelect.appendChild(placeholder);

      let optionCount = 0;
      GROUP_ORDER.forEach(id => {
        const entries = (groups.get(id) || []).filter(entryFilter);
        if (!entries.length) return;

        const optgroup = document.createElement('optgroup');
        optgroup.label = id === 'rxja' ? t('rxja_group_label') : GROUP_LABELS[id];
        entries.forEach(entry => {
          const option = document.createElement('option');
          option.value = entry.url;
          option.textContent = formatOptionLabel(entry, t);
          optgroup.appendChild(option);
          optionCount += 1;
        });
        targetSelect.appendChild(optgroup);
      });

      // Preserve the current choice across a re-render (e.g. language change).
      if (previous && targetSelect.querySelector(`option[value="${CSS.escape(previous)}"]`)) {
        targetSelect.value = previous;
      }
      return optionCount;
    }

    function render() {
      if (!groups) return { flash: 0, slots: 0 };
      return {
        flash: select ? renderSelect(select) : 0,
        slots: slotSelect ? renderSelect(slotSelect, isSlotOffered) : 0
      };
    }

    async function fetchRxjaEntries() {
      try {
        const response = await fetch(RXJA_MANIFEST_URL, { cache: 'no-cache' });
        if (!response.ok) return null;
        return rxjaEntriesFromManifest(await response.json(), window.location.href);
      } catch (error) {
        return null;
      }
    }

    async function fetchUpstreamFiles() {
      if (Date.now() < retryUntil) return null;
      try {
        const response = await fetch(API_URL, { cache: 'no-cache' });
        if (!response.ok) {
          // Rate limited: back off until GitHub's window resets so we stop
          // hammering the API on every Flash-view open.
          const remaining = response.headers.get('x-ratelimit-remaining');
          const reset = Number(response.headers.get('x-ratelimit-reset'));
          if ((response.status === 403 || response.status === 429) && remaining === '0' && reset) {
            retryUntil = reset * 1000;
          }
          return null;
        }
        const stableFiles = await response.json();
        const developmentFile = await fetchDevelopmentFile();
        return mergeCatalogFiles(stableFiles, developmentFile);
      } catch (error) {
        return null;
      }
    }

    // RxJa entries come from this site; the upstream F4HWN / stock listing (kept
    // for reverting) comes from the GitHub API and may be unavailable. Either
    // source alone is enough to show the picker; with neither, only the local
    // file input remains — exactly the pre-catalog experience. A missing source
    // is retried the next time a firmware view is opened.
    async function load() {
      if (loading || loaded) return;
      loading = true;
      try {
        const [rxja, files] = await Promise.all([
          rxjaEntries ? Promise.resolve(rxjaEntries) : fetchRxjaEntries(),
          upstreamLoaded ? Promise.resolve(null) : fetchUpstreamFiles()
        ]);
        if (rxja) rxjaEntries = rxja;
        if (files) {
          groups = categorize(files);
          upstreamLoaded = true;
        } else if (!groups) {
          groups = categorize([]);
        }
        groups.set('rxja', rxjaEntries || []);
        const counts = render();
        showCatalog(counts.flash > 0, counts.slots > 0);
        loaded = Boolean(rxjaEntries) && upstreamLoaded;
      } finally {
        loading = false;
      }
    }

    function findEntry(url) {
      return (rxjaEntries || []).find(entry => entry.url === url) || null;
    }

    if (select) {
      select.addEventListener('change', () => {
        const url = select.value;
        if (!url) return;
        window.RxJaData?.setPending(findEntry(url));
        const flash = window.UVStudioFlash;
        if (flash && typeof flash.loadFirmwareFromURL === 'function') {
          flash.loadFirmwareFromURL(url);
        }
      });
    }

    if (slotSelect) {
      slotSelect.addEventListener('change', () => {
        const url = slotSelect.value;
        if (!url) return;
        const flash = window.UVStudioFlash;
        if (flash && typeof flash.loadSlotFirmwareFromURL === 'function') {
          flash.loadSlotFirmwareFromURL(url);
        }
      });
    }

    // The Japanese data view offers the same bundled releases.
    window.RxJaCatalog = Object.freeze({
      releases: async () => rxjaEntries || (rxjaEntries = await fetchRxjaEntries()) || []
    });

    // Re-localize the placeholder and option groups when the language changes.
    window.addEventListener('uvstudio:languagechange', () => {
      if (groups) render();
    });

    // Mutual exclusivity: when a local file is picked, drop the catalog selection
    // back to its placeholder so only one firmware source ever looks selected.
    window.addEventListener('uvstudio:firmwareselect', event => {
      if (select && event.detail && event.detail.source === 'local' && select.options.length) {
        select.selectedIndex = 0;
        window.RxJaData?.setPending(null);
      }
    });

    window.addEventListener('uvstudio:slotfirmwareselect', event => {
      if (slotSelect && event.detail && event.detail.source === 'local' && slotSelect.options.length) {
        slotSelect.selectedIndex = 0;
      }
    });

    // Lazily fetch the shared catalog the first time either firmware view is
    // opened, so users who never manage firmware do not spend a GitHub API call.
    window.addEventListener('uvstudio:toolviewchange', event => {
      if (event.detail && (event.detail.view === 'flash' || event.detail.view === 'slots')) load();
    });

    // Retry once connectivity comes back after a failed load.
    window.addEventListener('online', () => { if (!loaded) load(); });

    // Load immediately only when one of the firmware views is actually shown on
    // arrival (flash-content is "active" by default, so also require the tools pane
    // to be visible — otherwise Live Viewer users would trigger a needless call).
    const paneTools = document.getElementById('pane-tools');
    const flashView = document.getElementById('flash-content');
    const slotsView = document.getElementById('slots-content');
    if (paneTools && paneTools.classList.contains('active') &&
        ((flashView && flashView.classList.contains('active')) ||
         (slotsView && slotsView.classList.contains('active')))) {
      load();
    }
  }

  return Object.assign({}, pureApi, { boot });
});
