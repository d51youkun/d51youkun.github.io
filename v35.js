/**
 * BlueChat v35 — 新ドメイン移行（github.io → workers.dev）+ 全員自動復元
 */
var APP_VERSION = 'v35';

var CANONICAL_APP_URL = 'https://bluechat.by-youhei.workers.dev';

(function redirectLegacyAppHost() {
  var host = String(location.hostname || '').toLowerCase();
  if (host.endsWith('.github.io')) {
    var target = CANONICAL_APP_URL + location.pathname + location.search + location.hash;
    location.replace(target);
  }
})();

function isCanonicalAppHost() {
  return /\.workers\.dev$/i.test(String(location.hostname || ''));
}

function domainMigrationStorageKey() {
  return 'bluechat_domain_restore_' + String(location.hostname || 'host');
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

const _runFastBootSyncV35 = runFastBootSync;
runFastBootSync = async function () {
  await _runFastBootSyncV35();
  if (getCurrentUser() && getUsableSyncUrl()) {
    await maybeAutoRestoreForDomainMigration();
  }
};
