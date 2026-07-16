/**
 * BlueChat v32 — サーバーからデータ復元（消失・ゴミ化対策）
 */
var APP_VERSION = 'v32';

function countLocalMessages() {
  const data = getData();
  let total = 0;
  for (const convId of Object.keys(data.messages || {})) {
    total += (data.messages[convId] || []).length;
  }
  return total;
}

async function afterServerRestore() {
  if (typeof fetchPublicPosts === 'function') await fetchPublicPosts();
  if (typeof updateTabBadges === 'function') await updateTabBadges();
  refreshMainUI();
  if (currentScreen === 'chat' && currentConvId) renderMessages(currentConvId);
  if (typeof renderFeed === 'function' && currentTab === 'notices') renderFeed();
  syncStatusChecked = true;
  bootSyncDone = true;
  startGlobalSyncCore();
}

async function restoreCurrentUserFromServer() {
  const user = getCurrentUser();
  if (!user) {
    showToast('ユーザー情報がありません');
    return false;
  }

  forceEnsureDefaultSyncUrl();
  if (!getUsableSyncUrl()) {
    showToast('同期サーバーに接続できません');
    return false;
  }

  showBootSyncLine('サーバーから復元中…（最大30秒）', 'loading');

  const ok = await wakeSyncServer(SYNC_WAKE_TIMEOUT_MS);
  if (!ok) {
    showToast('サーバーに接続できません。しばらく待ってから再試行してください');
    hideBootSyncLine(2500);
    return false;
  }

  try {
    if (typeof fetchCloudBackup === 'function') {
      const cloud = await fetchCloudBackup(user.id);
      if (cloud?.backup?.data) {
        importTransferBackup(cloud.backup);
        await afterServerRestore();
        showToast('クラウドバックアップから復元しました');
        hideBootSyncLine(1500);
        return true;
      }
    }

    const bundle = typeof pullServerSyncBundle === 'function'
      ? await pullServerSyncBundle(user.id)
      : await cloudRequest(`/api/user/${encodeURIComponent(user.id)}/sync-bundle`, {}, 120000);

    if (bundle?.data) {
      importTransferBackup(bundle);
      await afterServerRestore();
      showToast('サーバーからデータを復元しました');
      hideBootSyncLine(1500);
      return true;
    }

    await syncFriendships();
    await syncUserConversationList();
    const convIds = await cloudRequest(`/api/user/${user.id}/conversations`);
    if (Array.isArray(convIds)) {
      for (const convId of convIds) {
        const msgs = await cloudFetchMessages(convId, 0);
        for (const msg of msgs) mergeRemoteMessage(convId, msg);
      }
    }
    await afterServerRestore();
    showToast('会話データをサーバーから取得しました');
    hideBootSyncLine(1500);
    return true;
  } catch (e) {
    showToast(e.message || '復元に失敗しました');
    hideBootSyncLine(2500);
    return false;
  }
}

async function maybeAutoRestoreFromServer() {
  const user = getCurrentUser();
  if (!user || !getUsableSyncUrl()) return false;

  const localMsgs = countLocalMessages();
  const localConvs = getUserConversations(user.id).length;
  if (localMsgs >= 10 && localConvs >= 2) return false;

  const bundle = typeof pullServerSyncBundle === 'function'
    ? await pullServerSyncBundle(user.id)
    : null;
  if (!bundle?.data) return false;

  const serverMsgs = Object.values(bundle.data.messages || {}).reduce((n, arr) => {
    return n + (Array.isArray(arr) ? arr.length : 0);
  }, 0);
  const serverConvs = Object.keys(bundle.data.conversations || {}).length;
  if (serverMsgs <= localMsgs && serverConvs <= localConvs) return false;

  importTransferBackup(bundle);
  await afterServerRestore();
  showBootSyncLine('サーバーから自動復元しました', 'done');
  hideBootSyncLine(2000);
  return true;
}

const _runFastBootSyncV32 = runFastBootSync;
runFastBootSync = async function () {
  await _runFastBootSyncV32();
  if (getCurrentUser() && getUsableSyncUrl()) {
    await maybeAutoRestoreFromServer();
  }
};

const _initV32 = init;
init = function () {
  _initV32();
  const btn = document.getElementById('btn-restore-from-server');
  if (btn) {
    btn.addEventListener('click', () => restoreCurrentUserFromServer());
  }
};
