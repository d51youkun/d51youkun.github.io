/**
 * BlueChat v30 — 同期サーバー冷起動対応（タイムアウト延長・自動再接続）
 */
var APP_VERSION = 'v30';

const BOOT_HEALTH_TIMEOUT_MS = 15000;
const BOOT_SYNC_BUDGET_MS = 8000;
const SYNC_BACKGROUND_RETRY_MS = 5000;

let syncBackgroundRetryTimer = null;

async function testSyncConnectionFast() {
  const result = await cloudRequest('/api/health', {}, BOOT_HEALTH_TIMEOUT_MS);
  return !!(result && result.ok && result.writable !== false);
}

async function testSyncConnection(retries = 4) {
  for (let i = 0; i < retries; i++) {
    const timeout = i < 2 ? BOOT_HEALTH_TIMEOUT_MS : 20000;
    const result = await cloudRequest('/api/health', {}, timeout);
    if (result && result.ok && result.writable !== false) return true;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1200));
  }
  return false;
}

function startGlobalSyncCore() {
  stopGlobalSync();
  if (!getUsableSyncUrl()) return;
  syncAllConversations();
  globalSyncTimer = setInterval(syncAllConversations, 2500);
}

function scheduleSyncBackgroundRetry() {
  if (syncBackgroundRetryTimer) return;
  syncBackgroundRetryTimer = setInterval(async () => {
    if (!getCurrentUser() || !getUsableSyncUrl()) return;
    const ok = await testSyncConnectionFast();
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

function showBootSyncWaiting(text) {
  showBootSyncLine(text || '同期サーバー起動中…', 'loading');
}

async function runFastBootSync() {
  if (bootSyncRunning) return;
  const user = getCurrentUser();
  if (!user) return;

  bootSyncRunning = true;
  const deadline = Date.now() + BOOT_SYNC_BUDGET_MS;

  if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
  updateSyncServerDisplay();
  startGlobalSyncCore();

  const url = getUsableSyncUrl();
  if (!url) {
    showBootSyncLine('同期サーバーURLが設定されていません', 'error');
    updateSyncStatusUIFast(false);
    hideBootSyncLine(4000);
    bootSyncRunning = false;
    return;
  }

  showBootSyncWaiting('同期サーバーに接続中…');

  let ok = await testSyncConnectionFast();
  if (!ok) {
    showBootSyncWaiting('同期サーバー起動中…（最大15秒待機）');
    if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
    ok = await testSyncConnection(3);
  }

  if (!ok) {
    showBootSyncLine('サーバー起動中 — バックグラウンドで再接続します', 'loading');
    updateSyncStatusUIFast(false);
    scheduleSyncBackgroundRetry();
    hideBootSyncLine(2500);
    bootSyncRunning = false;
    return;
  }

  showBootSyncLine('メッセージを同期中…');
  const remain = Math.max(500, deadline - Date.now());
  await Promise.race([
    fastSyncAllConversations(deadline + 12000),
    new Promise(r => setTimeout(r, remain + 12000))
  ]);

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

  status.textContent = '接続確認中…（サーバー起動に時間がかかることがあります）';
  status.classList.remove('warn');
  const ok = await testSyncConnectionFast();
  syncStatusChecked = !!ok;
  if (ok) {
    status.textContent = '✓ 接続済み — 他の端末にもメッセージが届きます';
    if (!globalSyncTimer) startGlobalSyncCore();
  } else {
    status.textContent = 'サーバー起動中… 自動で再接続します';
    status.classList.add('warn');
    startGlobalSyncCore();
    scheduleSyncBackgroundRetry();
  }
}

updateSyncStatusUI = function (forceCheck) {
  applySyncSettingsVisibility();
  if (forceCheck) syncStatusChecked = false;
  updateSyncStatusUIFast(forceCheck);
};

startGlobalSync = function () {
  if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
  startGlobalSyncCore();
  queueFastBootSync();
};

if (typeof getUsableSyncUrl === 'function' && getUsableSyncUrl()) {
  cloudRequest('/api/health', {}, 20000).catch(() => {});
}
