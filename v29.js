/**
 * BlueChat v29 — 起動5秒同期・同期サーバー全員表示・メッセージ配信強化
 */
var APP_VERSION = 'v29';

const BOOT_SYNC_BUDGET_MS = 5000;
const BOOT_HEALTH_TIMEOUT_MS = 3500;
const FAST_SYNC_POLL_MS = 1200;

let bootSyncRunning = false;
let bootSyncDone = false;

function updateSyncServerDisplay() {
  const display = document.getElementById('sync-server-display');
  const input = document.getElementById('input-sync-url');
  const adminEdit = document.getElementById('admin-sync-edit');
  const isAdmin = typeof isSuperAdminViewer === 'function' && isSuperAdminViewer();
  const candidates = getSyncUrlCandidates();
  const url = getUsableSyncUrl() || candidates[0] || '';

  if (display) {
    if (!url) {
      display.textContent = candidates.length && candidates.every(isMixedContentBlocked)
        ? 'HTTPSページからローカルIPには接続できません'
        : '未設定';
    } else {
      display.textContent = url;
    }
  }
  if (input) {
    input.value = candidates.join(SYNC_URL_DELIMITER + ' ');
    input.classList.toggle('hidden', !isAdmin);
  }
  if (adminEdit) adminEdit.classList.toggle('hidden', !isAdmin);
}

function showBootSyncLine(text, state) {
  const el = document.getElementById('boot-sync-status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden', 'loading', 'done', 'error');
  el.classList.add(state || 'loading');
}

function hideBootSyncLine(delayMs) {
  setTimeout(() => {
    const el = document.getElementById('boot-sync-status');
    if (el) el.classList.add('hidden');
  }, delayMs || 0);
}

async function testSyncConnectionFast() {
  const result = await cloudRequest('/api/health', {}, BOOT_HEALTH_TIMEOUT_MS);
  return !!(result && result.ok && result.writable !== false);
}

async function testSyncConnection(retries = 3) {
  for (let i = 0; i < retries; i++) {
    const ok = await testSyncConnectionFast();
    if (ok) return true;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

async function fastSyncAllConversations(deadline) {
  const user = getCurrentUser();
  if (!user || !getUsableSyncUrl()) return 0;

  await syncUserConversationList();
  const convs = getUserConversations(user.id);
  const sorted = [...convs].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));

  for (const conv of sorted) {
    if (Date.now() >= deadline) break;
    await syncPushLocalMessages(conv.id);
  }

  for (let i = 0; i < sorted.length; i += 4) {
    if (Date.now() >= deadline) break;
    const batch = sorted.slice(i, i + 4);
    await Promise.all(batch.map(conv => {
      const remain = Math.max(200, deadline - Date.now());
      return Promise.race([
        syncConversation(conv.id),
        new Promise(r => setTimeout(r, remain))
      ]);
    }));
  }

  await syncFriendships().catch(() => {});
  refreshUIAfterSync();
  if (typeof updateTabBadges === 'function') updateTabBadges();
}

async function runFastBootSync() {
  if (bootSyncRunning) return;
  const user = getCurrentUser();
  if (!user) return;

  bootSyncRunning = true;
  const deadline = Date.now() + BOOT_SYNC_BUDGET_MS;

  if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
  updateSyncServerDisplay();

  const url = getUsableSyncUrl();
  if (!url) {
    showBootSyncLine('同期サーバーに接続できません', 'error');
    updateSyncStatusUIFast(false);
    hideBootSyncLine(4000);
    bootSyncRunning = false;
    return;
  }

  showBootSyncLine('同期サーバーに接続中…');

  let ok = await testSyncConnectionFast();
  if (!ok) {
    if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
    ok = await testSyncConnectionFast();
  }

  if (!ok) {
    showBootSyncLine('同期サーバーに接続できません', 'error');
    updateSyncStatusUIFast(false);
    hideBootSyncLine(4000);
    bootSyncRunning = false;
    return;
  }

  showBootSyncLine('メッセージを同期中…');
  const remain = Math.max(300, deadline - Date.now());
  await Promise.race([
    fastSyncAllConversations(deadline),
    new Promise(r => setTimeout(r, remain))
  ]);

  syncStatusChecked = true;
  bootSyncDone = true;
  showBootSyncLine('同期完了', 'done');
  updateSyncServerDisplay();
  updateSyncStatusUIFast(true);
  hideBootSyncLine(1200);
  bootSyncRunning = false;
}

function queueFastBootSync() {
  if (bootSyncDone || bootSyncRunning || !getCurrentUser()) return;
  runFastBootSync();
}

applySyncSettingsVisibility = function () {
  const section = document.getElementById('sync-server-settings');
  if (section) section.classList.remove('hidden');
  updateSyncServerDisplay();
};

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
    if (!globalSyncTimer) startGlobalSync();
    return;
  }

  status.textContent = '接続確認中…';
  status.classList.add('warn');
  const ok = await testSyncConnectionFast();
  syncStatusChecked = !!ok;
  if (ok) {
    status.textContent = '✓ 接続済み — 他の端末にもメッセージが届きます';
    status.classList.remove('warn');
    if (!globalSyncTimer) startGlobalSync();
  } else {
    status.textContent = '同期サーバーに接続できません。「再接続」を押してください';
    status.classList.add('warn');
  }
}

updateSyncStatusUI = function (forceCheck) {
  applySyncSettingsVisibility();
  if (forceCheck) syncStatusChecked = false;
  updateSyncStatusUIFast(forceCheck);
};

const _renderProfileV29 = renderProfile;
renderProfile = function () {
  _renderProfileV29();
  applySyncSettingsVisibility();
};

const _cloudSyncAfterSendV29 = cloudSyncAfterSend;
cloudSyncAfterSend = async function (convId, msg) {
  if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
  if (!getUsableSyncUrl()) {
    trackPendingMessage(convId, msg.id);
    showToast('同期サーバー未接続。再接続後に送信されます');
    return;
  }

  trackPendingMessage(convId, msg.id);
  const data = getData();
  const conv = data.conversations[convId];
  if (conv) await cloudPushConversation(conv);

  let pushed = false;
  for (let i = 0; i < 4 && !pushed; i++) {
    pushed = await cloudPushMessage(convId, msg);
    if (!pushed) await new Promise(r => setTimeout(r, 250 + i * 200));
  }

  if (!pushed) {
    showToast('メッセージの送信に失敗しました。「再接続」をお試しください');
    return;
  }

  syncConversation(convId).catch(() => {});
};

const _startGlobalSyncV29 = startGlobalSync;
startGlobalSync = function () {
  _startGlobalSyncV29();
  queueFastBootSync();
};

const _startSyncVersionPollingV29 = startSyncVersionPolling;
startSyncVersionPolling = function () {
  if (syncVersionTimer) clearInterval(syncVersionTimer);
  if (!getUsableSyncUrl()) return;
  const poll = async () => {
    const res = await cloudRequest('/api/activity-version', {}, 4000);
    if (!res || res.version === undefined) return;
    const last = parseInt(localStorage.getItem(ACTIVITY_VERSION_KEY) || '0', 10);
    if (res.version > last) {
      localStorage.setItem(ACTIVITY_VERSION_KEY, String(res.version));
      await handleRemoteActivity();
      return;
    }
    if (last === 0) {
      localStorage.setItem(ACTIVITY_VERSION_KEY, String(res.version));
    }
  };
  poll();
  syncVersionTimer = setInterval(poll, FAST_SYNC_POLL_MS);
};

const _initV29 = init;
init = function () {
  _initV29();
  applySyncSettingsVisibility();

  const retryBtn = document.getElementById('btn-retry-sync');
  if (retryBtn) {
    const fresh = retryBtn.cloneNode(true);
    retryBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      bootSyncDone = false;
      syncStatusChecked = false;
      if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
      runFastBootSync();
      updateSyncStatusUIFast(true);
    });
  }
};

applySyncSettingsVisibility();
