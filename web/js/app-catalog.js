// Overlay-app catalog: discovers versioned .app archives from
// archive/apps/v<firmware-version>/ on the main firmware repository.
//
// Modified by the RxJa project: the app picker always ends with "choose a file"
// and the local .app chooser is shown only while that entry is selected, the same
// way as the flash, multiboot slot and Japanese data views. The picker stays
// visible when the listing cannot be fetched, so a local file still works.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UVStudioAppCatalog = api;

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
  const BRANCH = 'main';
  const APPS_PATH = 'archive/apps';
  const API_ROOT = `https://api.github.com/repos/${REPO}/contents`;
  // Value of the app picker's "choose a file" entry (not a URL).
  const FILE_OPTION = '__file__';

  function contentsURL(path) {
    const encodedPath = String(path).split('/').map(encodeURIComponent).join('/');
    return `${API_ROOT}/${encodedPath}?ref=${encodeURIComponent(BRANCH)}`;
  }

  function compareVersionsDesc(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const delta = (pb[i] || 0) - (pa[i] || 0);
      if (delta) return delta;
    }
    return 0;
  }

  function parseVersionDirectory(item) {
    if (!item || item.type !== 'dir' || typeof item.name !== 'string') return null;
    const match = item.name.match(/^v(\d+(?:\.\d+){2})$/i);
    if (!match) return null;
    return {
      version: match[1],
      directory: item.name,
      path: item.path || `${APPS_PATH}/${item.name}`
    };
  }

  function listVersions(items) {
    return (Array.isArray(items) ? items : [])
      .map(parseVersionDirectory)
      .filter(Boolean)
      .sort((a, b) => compareVersionsDesc(a.version, b.version));
  }

  function displayAppName(filename) {
    return String(filename)
      .replace(/\.app$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  function listApps(items) {
    return (Array.isArray(items) ? items : [])
      .filter(item => item && item.type === 'file' && /\.app$/i.test(item.name) && item.download_url)
      .map(item => ({
        name: item.name,
        label: displayAppName(item.name),
        size: item.size,
        url: item.download_url
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  function formatAppLabel(app) {
    if (!Number.isFinite(app.size)) return app.label;
    return `${app.label} · ${(app.size / 1024).toFixed(1)} KB`;
  }

  function boot() {
    const versionSelect = document.getElementById('appCatalogVersionSelect');
    const appSelect = document.getElementById('appCatalogSelect');
    const fileSection = document.getElementById('appFileSection');
    if (!versionSelect || !appSelect) return;

    let versions = [];
    let loaded = false;
    let loading = false;
    let appLoadSeq = 0;

    function t(key) {
      return window.uvStudioI18n ? window.uvStudioI18n.t(key) : key;
    }

    function resetSelect(select, key) {
      select.textContent = '';
      const option = document.createElement('option');
      option.value = '';
      option.disabled = true;
      option.selected = true;
      option.textContent = t(key);
      select.appendChild(option);
    }

    function appendFileOption() {
      const option = document.createElement('option');
      option.value = FILE_OPTION;
      option.textContent = t('flash_catalog_file');
      appSelect.appendChild(option);
    }

    // The app picker: placeholder, the listed apps (if any), then "choose a file".
    // It is never disabled, so a local .app can be used without the listing.
    function resetAppSelect() {
      resetSelect(appSelect, 'app_catalog_app_placeholder');
      appendFileOption();
    }

    // The local .app chooser is only shown while "choose a file" is selected.
    function syncFileSection() {
      if (fileSection) fileSection.hidden = appSelect.value !== FILE_OPTION;
    }

    async function loadApps(versionEntry) {
      const seq = ++appLoadSeq;
      // Keep "choose a file" selected while the list for another version loads.
      const keepFile = appSelect.value === FILE_OPTION;
      resetAppSelect();
      if (keepFile) appSelect.value = FILE_OPTION;
      const response = await fetch(contentsURL(versionEntry.path), { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const apps = listApps(await response.json());
      if (seq !== appLoadSeq) return;
      const fileOption = appSelect.querySelector(`option[value="${FILE_OPTION}"]`);
      apps.forEach(app => {
        const option = document.createElement('option');
        option.value = app.url;
        option.dataset.appName = app.name;
        option.textContent = formatAppLabel(app);
        appSelect.insertBefore(option, fileOption);
      });
    }

    async function load() {
      if (loading || loaded) return;
      loading = true;
      try {
        const response = await fetch(contentsURL(APPS_PATH), { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        versions = listVersions(await response.json());
        if (!versions.length) throw new Error('No app versions');

        resetSelect(versionSelect, 'app_catalog_version_placeholder');
        versions.forEach(entry => {
          const option = document.createElement('option');
          option.value = entry.directory;
          option.textContent = entry.version;
          versionSelect.appendChild(option);
        });
        versionSelect.value = versions[0].directory;
        versionSelect.disabled = false;
        await loadApps(versions[0]);
        loaded = true;
      } catch (error) {
        // No listing: the version picker stays disabled, "choose a file" still works.
      } finally {
        loading = false;
      }
    }

    versionSelect.addEventListener('change', () => {
      const selected = versions.find(entry => entry.directory === versionSelect.value);
      if (!selected) return;
      // A local file does not depend on the firmware version: keep it.
      if (appSelect.value !== FILE_OPTION) {
        const flash = window.UVStudioFlash;
        if (flash && typeof flash.clearAppFromCatalog === 'function') flash.clearAppFromCatalog();
      }
      loadApps(selected).catch(() => {
        const keepFile = appSelect.value === FILE_OPTION;
        resetAppSelect();
        if (keepFile) appSelect.value = FILE_OPTION;
        syncFileSection();
      });
    });

    appSelect.addEventListener('change', () => {
      const option = appSelect.options[appSelect.selectedIndex];
      const url = appSelect.value;
      syncFileSection();
      if (!url || !option) return;
      const flash = window.UVStudioFlash;
      if (url === FILE_OPTION) {
        if (flash && typeof flash.useLocalApp === 'function') flash.useLocalApp();
        return;
      }
      if (flash && typeof flash.loadAppFromURL === 'function') {
        flash.loadAppFromURL(url, option.dataset.appName || 'application.app');
      }
    });

    // A local file always means "choose a file" is the selected entry. Clearing for
    // a version change ('catalog') leaves the picker as it is.
    window.addEventListener('uvstudio:appselect', event => {
      if (event.detail && event.detail.source === 'local') {
        appSelect.value = FILE_OPTION;
        syncFileSection();
      }
    });

    window.addEventListener('uvstudio:languagechange', () => {
      const selectedVersion = versionSelect.value;
      const selectedApp = appSelect.value;
      const versionPlaceholder = versionSelect.options[0];
      const appPlaceholder = appSelect.options[0];
      if (versionPlaceholder) versionPlaceholder.textContent = t('app_catalog_version_placeholder');
      if (appPlaceholder) appPlaceholder.textContent = t('app_catalog_app_placeholder');
      const fileOption = appSelect.querySelector(`option[value="${FILE_OPTION}"]`);
      if (fileOption) fileOption.textContent = t('flash_catalog_file');
      if (selectedVersion) versionSelect.value = selectedVersion;
      if (selectedApp) appSelect.value = selectedApp;
    });

    window.addEventListener('uvstudio:toolviewchange', event => {
      if (event.detail && event.detail.view === 'apps') load();
    });
    window.addEventListener('online', () => { if (!loaded) load(); });

    const paneTools = document.getElementById('pane-tools');
    const appsView = document.getElementById('apps-content');
    if (paneTools && paneTools.classList.contains('active') &&
        appsView && appsView.classList.contains('active')) {
      load();
    }
  }

  return {
    boot,
    compareVersionsDesc,
    contentsURL,
    displayAppName,
    formatAppLabel,
    listApps,
    listVersions,
    parseVersionDirectory
  };
});
