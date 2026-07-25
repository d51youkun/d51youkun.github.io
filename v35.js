/**
 * BlueChat v35 — 旧URL（github.io等）→ workers.dev + サーバーから自動復元
 */
var APP_VERSION = 'v36';

var CANONICAL_APP_URL = 'https://bluechat.by-youhei.workers.dev';
var migrationRestoreRunning = false;

(function redirectLegacyAppHost() {
  var host = String(location.hostname || '').toLowerCase();
  if (!host.endsWith('.github.io')) return;

  var uid = '';
  try {
    var raw = localStorage.getItem('bluechat_data');
    if (raw) {
      var data = JSON.parse(raw);
      if (data && data.currentUserId) uid = String(data.currentUserId);
    }
  } catch (e) { /* ignore */ }

  var target = CANONICAL_APP_URL + location.pathname + location.search;
  if (uid) {
    target += (target.indexOf('?') >= 0 ? '&' : '?') + 'bc_restore=' + encodeURIComponent(uid);
  }
  target += location.hash;
  location.replace(target);
})();

function isCanonicalAppHost() {
  return /\.workers\.dev$/i.test(String(location.hostname || ''));
}

function domainMigrationStorageKey() {
  return 'bluechat_domain_restore_' + String(location.hostname || 'host');
}

function peekMigrationRestoreUserId() {
  try {
    return String(new URLSearchParams(location.search).get('bc_restore') || '').trim();
  } catch (e) {
    return '';
  }
}

function clearMigrationRestoreParam() {
  try {
    const params = new URLSearchParams(location.search);
    if (!params.has('bc_restore')) return;
    params.delete('bc_restore');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  } catch (e) { /* ignore */ }
}

async function maybeRestoreFromMigrationParam() {
  if (migrationRestoreRunning) return false;
  if (!isCanonicalAppHost()) return false;
  if (getCurrentUser()) return false;

  const uid = peekMigrationRestoreUserId();
  if (!uid) return false;

  migrationRestoreRunning = true;
  if (typeof forceEnsureDefaultSyncUrl === 'function') forceEnsureDefaultSyncUrl();
  if (!getUsableSyncUrl()) {
    migrationRestoreRunning = false;
    return false;
  }

  showBootSyncLine('以前のURLからデータを復元中…', 'loading');

  try {
    const ok = await wakeSyncServer(SYNC_WAKE_TIMEOUT_MS);
    if (!ok) {
      showToast('サーバー接続中です。しばらく待ってから再度お試しください');
      hideBootSyncLine(2500);
      return false;
    }

    const result = await restoreAccountByUserId(uid, '');
    if (result && !result.error) {
      clearMigrationRestoreParam();
      finishAccountRestore(result);
      if (typeof afterServerRestore === 'function') await afterServerRestore();
      localStorage.setItem(domainMigrationStorageKey(), '1');
      showToast('以前のURLからデータを引き継ぎました');
      hideBootSyncLine(1500);
      return true;
    }

    hideBootSyncLine(2500);
    if (result && result.error) showToast(result.error);
  } catch (e) {
    hideBootSyncLine(2500);
    showToast(e.message || '復元に失敗しました');
  } finally {
    migrationRestoreRunning = false;
  }
  return false;
}

async function maybeAutoRestoreForDomainMigration() {
  const user = getCurrentUser();
  if (!user || !getUsableSyncUrl()) return false;
  if (!isCanonicalAppHost()) return false;

  const flagKey = domainMigrationStorageKey();
  const localMsgs = countLocalMessages();
  const localConvs = getUserConversations(user.id).length;
  const alreadyDone = localStorage.getItem(flagKey) === '1';

  if (alreadyDone && localMsgs >= 10 && localConvs >= 2) return false;

  showBootSyncLine('新しいURLからデータを復元中…', 'loading');
  const ok = await restoreCurrentUserFromServer();
  if (ok) {
    localStorage.setItem(flagKey, '1');
    showToast('新ドメインへデータを移しました');
  }
  return ok;
}

async function queueDomainMigrationRestore() {
  try {
    if (!getCurrentUser() && peekMigrationRestoreUserId()) {
      await maybeRestoreFromMigrationParam();
      return;
    }
    if (getCurrentUser() && getUsableSyncUrl()) {
      await maybeAutoRestoreForDomainMigration();
    }
  } catch (e) {
    console.error('domain migration restore failed:', e);
    hideBootSyncLine(0);
  }
}

const _initV35 = init;
init = function () {
  _initV35();
  queueDomainMigrationRestore();
};

const _runFastBootSyncV35 = runFastBootSync;
runFastBootSync = async function () {
  await _runFastBootSyncV35();
  if (getCurrentUser() && getUsableSyncUrl() && !peekMigrationRestoreUserId()) {
    await maybeAutoRestoreForDomainMigration();
  }
};

function bootBlueChatFinal() {
  try {
    init();
  } catch (err) {
    console.error('BlueChat init error:', err);
  }
  if (typeof ensureVisibleScreen === 'function') ensureVisibleScreen();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootBlueChatFinal);
} else {
  bootBlueChatFinal();
}
