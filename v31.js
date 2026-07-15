/**
 * BlueChat v31 — 同期接続の根本修正（30秒待機・起動前の単一リクエスト）
 */
var APP_VERSION = 'v31';

const SYNC_WAKE_TIMEOUT_MS = 35000;
const SYNC_BACKGROUND_RETRY_MS = 8000;

let syncBackgroundRetryTimer = null;
let wakeSyncPromise = null;

function forceEnsureDefaultSyncUrl() {
  if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
  if (!DEFAULT_SYNC_URL || DEFAULT_SYNC_URL === '__DEFAULT_SYNC_URL__') return;
  const normalized = normalizeSyncUrl(DEFAULT_SYNC_URL);
  if (!normalized || isMixedContentBlocked(normalized)) return;

  const stored = parseSyncUrlInput(localStorage.getItem(SYNC_URL_KEY) || '');
  const rest = stored.filter(u => u !== normalized);
  localStorage.setItem(SYNC_URL_KEY, [normalized, ...rest].join(SYNC_URL_DELIMITER));
  localStorage.setItem(SYNC_CONFIGURED_KEY, '1');
}

async function wakeSyncServer(timeoutMs = SYNC_WAKE_TIMEOUT_MS) {
  if (wakeSyncPromise) return wakeSyncPromise;
  wakeSyncPromise = (async () => {
    forceEnsureDefaultSyncUrl();
    const result = await cloudRequest('/api/health', {}, timeoutMs);
    return !!(result && result.ok && result.writable !== false);
  })().finally(() => {
    wakeSyncPromise = null;
  });
  return wakeSyncPromise;
}

async function testSyncConnectionFast() {
  return wakeSyncServer(SYNC_WAKE_TIMEOUT_MS);
}

async function testSyncConnection(retries = 3) {
  for (let i = 0; i < retries; i++) {
    const ok = await wakeSyncServer(SYNC_WAKE_TIMEOUT_MS);
    if (ok) return true;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

function startGlobalSyncCore() {
  stopGlobalSync();
  if (!getUsableSyncUrl()) return;
  syncAllConversations();
  globalSyncTimer = setInterval(syncAllConversations, 3000);
}

function scheduleSyncBackgroundRetry() {
  if (syncBackgroundRetryTimer) return;
  syncBackgroundRetryTimer = setInterval(async () => {
    if (!getCurrentUser() || !getUsableSyncUrl()) return;
    const ok = await wakeSyncServer(SYNC_WAKE_TIMEOUT_MS);
    if (!ok) return;

    clearInterval(syncBackgroundRetryTimer);
    syncBackgroundRetryTimer = null;
    syncStatusChecked = true;
    bootSyncDone = false;

    const status = document.getElementById('sync-status');
    if (status) {
      status.textContent = '✓ 接続済み — 他の端末にもメッセージが届きます';
      status.classList.remove('warn');
    }
    updateSyncServerDisplay();
    startGlobalSyncCore();
    if (!bootSyncRunning) runFastBootSync();
  }, SYNC_BACKGROUND_RETRY_MS);
}

async function runFastBootSync() {
  if (bootSyncRunning) return;
  const user = getCurrentUser();
  if (!user) return;

  bootSyncRunning = true;
  forceEnsureDefaultSyncUrl();
  updateSyncServerDisplay();

  const url = getUsableSyncUrl();
  if (!url) {
    showBootSyncLine('同期サーバーURLが設定されていません', 'error');
    updateSyncStatusUIFast(false);
    hideBootSyncLine(4000);
    bootSyncRunning = false;
    return;
  }

  showBootSyncLine('同期サーバー起動中…（最大30秒）', 'loading');

  const ok = await wakeSyncServer(SYNC_WAKE_TIMEOUT_MS);
  if (!ok) {
    showBootSyncLine('サーバー起動中 — 自動で再接続します', 'loading');
    const status = document.getElementById('sync-status');
    if (status) {
      status.textContent = 'サーバー起動中… 自動で再接続します（' + url + '）';
      status.classList.add('warn');
    }
    scheduleSyncBackgroundRetry();
    hideBootSyncLine(3000);
    bootSyncRunning = false;
    return;
  }

  startGlobalSyncCore();
  showBootSyncLine('メッセージを同期中…', 'loading');
  await fastSyncAllConversations(Date.now() + 20000);

  syncStatusChecked = true;
  bootSyncDone = true;
  showBootSyncLine('同期完了', 'done');
  updateSyncServerDisplay();
  updateSyncStatusUIFast(true);
  hideBootSyncLine(1200);
  bootSyncRunning = false;
}

async function updateSyncStatusUIFast(forceCheck) {
  const status = document.getElementById('sync-status');
  if (!status) return;
  forceEnsureDefaultSyncUrl();
  updateSyncServerDisplay();

  if (!getUsableSyncUrl()) {
    const mixedBlocked = getSyncUrlCandidates().every(isMixedContentBlocked);
    status.textContent = mixedBlocked
      ? 'ローカルIP(http://)はこのページ(HTTPS)から接続できません'
      : '同期サーバー未設定';
    status.classList.add('warn');
    return;
  }

  if (!forceCheck && syncStatusChecked) {
    status.textContent = '✓ 接続済み — 他の端末にもメッセージが届きます';
    status.classList.remove('warn');
    if (!globalSyncTimer) startGlobalSyncCore();
    return;
  }

  status.textContent = '接続確認中…（サーバー起動に最大30秒かかることがあります）';
  status.classList.remove('warn');
  const ok = await wakeSyncServer(SYNC_WAKE_TIMEOUT_MS);
  syncStatusChecked = !!ok;
  if (ok) {
    status.textContent = '✓ 接続済み — 他の端末にもメッセージが届きます';
    if (!globalSyncTimer) startGlobalSyncCore();
  } else {
    status.textContent = 'サーバー起動中… 自動で再接続します（' + getUsableSyncUrl() + '）';
    status.classList.add('warn');
    scheduleSyncBackgroundRetry();
  }
}

updateSyncStatusUI = function (forceCheck) {
  applySyncSettingsVisibility();
  if (forceCheck) syncStatusChecked = false;
  updateSyncStatusUIFast(forceCheck);
};

startGlobalSync = function () {
  forceEnsureDefaultSyncUrl();
  queueFastBootSync();
  scheduleSyncBackgroundRetry();
};

const _cloudRequestExtV31 = cloudRequestExt;
cloudRequestExt = async function (path, options = {}, timeoutMs = 45000) {
  const isHealth = String(path || '').includes('/api/health');
  const ms = isHealth ? Math.max(timeoutMs, SYNC_WAKE_TIMEOUT_MS) : timeoutMs;
  return _cloudRequestExtV31(path, options, ms);
};

const _initV31 = init;
init = function () {
  forceEnsureDefaultSyncUrl();
  _initV31();
  applySyncSettingsVisibility();
  wakeSyncServer(SYNC_WAKE_TIMEOUT_MS).catch(() => {});

  const retryBtn = document.getElementById('btn-retry-sync');
  if (retryBtn) {
    const fresh = retryBtn.cloneNode(true);
    retryBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      bootSyncDone = false;
      syncStatusChecked = false;
      forceEnsureDefaultSyncUrl();
      runFastBootSync();
    });
  }
};

forceEnsureDefaultSyncUrl();
