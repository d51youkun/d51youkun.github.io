/**
 * BlueChat v12 — マルチ端末同期（パスワード + クラウドバックアップ）
 */
var APP_VERSION = 'v12';

const ACCOUNT_SYNC_TS_KEY = 'bluechat_account_sync_ts';
const ACCOUNT_MERGE_MS = 45000;
let accountMergeTimer = null;
let pushAccountDebounce = null;

async function pushAccountToCloud() {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl()) return false;
  await cloudPushUser(user);
  if (typeof uploadCloudBackup === 'function') {
    const ok = await uploadCloudBackup(buildTransferBackupWithPassword(null));
    if (ok) localStorage.setItem(ACCOUNT_SYNC_TS_KEY, String(Date.now()));
    return ok;
  }
  return true;
}

function schedulePushAccountToCloud() {
  if (pushAccountDebounce) clearTimeout(pushAccountDebounce);
  pushAccountDebounce = setTimeout(() => {
    pushAccountDebounce = null;
    pushAccountToCloud().catch(() => {});
  }, 800);
}

function mergeCloudBackupDataIntoLocal(backup) {
  if (!backup || !backup.data) return false;
  const payload = backup.data;
  const data = getData();
  const user = getCurrentUser();
  if (!user || payload.currentUserId !== user.id) return false;
  let changed = false;

  Object.keys(payload.users || {}).forEach(uid => {
    const remote = payload.users[uid];
    if (!remote || !remote.id) return;
    let local = data.users[uid];
    if (!local) {
      data.users[uid] = { ...remote, isRemote: uid !== user.id };
      changed = true;
      return;
    }
    const remoteAt = remote.avatarUpdatedAt || 0;
    const localAt = local.avatarUpdatedAt || 0;
    if (remoteAt > localAt) {
      if (remote.avatar) local.avatar = remote.avatar;
      else delete local.avatar;
      local.avatarUpdatedAt = remoteAt;
      changed = true;
    }
    if (remote.name && remote.name !== local.name) {
      local.name = remote.name;
      changed = true;
    }
    if (uid === user.id && remote.passwordHash && remote.passwordHash !== local.passwordHash) {
      local.passwordHash = remote.passwordHash;
      changed = true;
    }
  });

  (payload.friendships || []).forEach(f => {
    if (f.user1 && f.user2 && !areFriends(f.user1, f.user2)) {
      addFriendship(f.user1, f.user2, { skipCloud: true });
      changed = true;
    }
  });

  Object.keys(payload.conversations || {}).forEach(convId => {
    const remoteConv = payload.conversations[convId];
    if (!remoteConv || !remoteConv.members || !remoteConv.members.includes(user.id)) return;
    if (!data.conversations[convId]) {
      data.conversations[convId] = remoteConv;
      if (!data.messages[convId]) data.messages[convId] = [];
      changed = true;
    }
  });

  Object.keys(payload.messages || {}).forEach(convId => {
    const conv = data.conversations[convId];
    if (!conv || !conv.members || !conv.members.includes(user.id)) return;
    (payload.messages[convId] || []).forEach(msg => {
      if (mergeRemoteMessage(convId, msg)) changed = true;
    });
  });

  Object.keys(payload.readReceipts || {}).forEach(convId => {
    if (!data.readReceipts[convId]) data.readReceipts[convId] = {};
    const merged = { ...data.readReceipts[convId], ...(payload.readReceipts[convId] || {}) };
    if (JSON.stringify(merged) !== JSON.stringify(data.readReceipts[convId])) {
      data.readReceipts[convId] = merged;
      changed = true;
    }
  });

  if (changed) saveData(data);
  return changed;
}

async function pullAccountFromCloudIfNewer() {
  const user = getCurrentUser();
  if (!user || !user.passwordHash || !getEffectiveSyncUrl()) return false;
  const remote = await fetchCloudBackup(user.id);
  if (!remote || !remote.backup || !remote.backup.data) return false;
  if (remote.backup.passwordHash && remote.backup.passwordHash !== user.passwordHash) return false;
  const remoteTs = remote.updatedAt || 0;
  const localTs = parseInt(localStorage.getItem(ACCOUNT_SYNC_TS_KEY) || '0', 10);
  if (remoteTs <= localTs) return false;
  const changed = mergeCloudBackupDataIntoLocal(remote.backup);
  localStorage.setItem(ACCOUNT_SYNC_TS_KEY, String(remoteTs));
  return changed;
}

async function syncAccountAcrossDevices() {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl()) return;
  await pullAccountFromCloudIfNewer();
  await syncAllConversations();
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
  else refreshMainUI();
  updateAccountSyncStatusUI();
}

function updateAccountSyncStatusUI() {
  const el = document.getElementById('account-sync-status');
  if (!el) return;
  const user = getCurrentUser();
  if (!user) {
    el.textContent = '';
    return;
  }
  if (!user.passwordHash) {
    el.textContent = 'パスワードを設定すると、iPad・Macなど別の端末でも同じトークが見られます。';
    return;
  }
  const ts = parseInt(localStorage.getItem(ACCOUNT_SYNC_TS_KEY) || '0', 10);
  if (ts) {
    el.textContent = `複数端末同期: 有効（最終同期 ${formatTime(ts)}）`;
  } else {
    el.textContent = '複数端末同期: 有効 — 他の端末でも同じIDとパスワードでログインできます';
  }
}

async function verifyRemoteAccountPassword(userId, password) {
  const uid = String(userId || '').trim();
  if (!uid) return { error: 'ユーザーIDを入力してください' };
  ensureSyncUrlForRestore();
  if (!getEffectiveSyncUrl()) return { error: '同期サーバーに接続できません' };
  const remote = await cloudFetchUser(uid);
  if (!remote || !remote.id) return { error: 'ユーザーが見つかりません。IDを確認してください' };
  if (remote.passwordHash) {
    if (!password) return { error: 'パスワードが必要です' };
    if (remote.passwordHash !== simpleHash(password)) return { error: 'パスワードが正しくありません' };
  }
  return { ok: true, user: remote };
}

async function loginAccountOnDevice(userId, password) {
  const v = await verifyRemoteAccountPassword(userId, password);
  if (v.error) return v;
  const result = await restoreAccountByUserId(userId, password);
  if (result.error) return result;
  localStorage.setItem(ACCOUNT_SYNC_TS_KEY, String(Date.now()));
  await syncAllConversations();
  return { success: true, source: result.source };
}

function showAccountLoginModal() {
  ensureSyncUrlForRestore();
  const uidInput = document.getElementById('input-account-login-id');
  const pwInput = document.getElementById('input-account-login-password');
  if (uidInput) uidInput.value = '';
  if (pwInput) pwInput.value = '';
  showModal('modal-account-login');
}

function finishAccountLogin(result) {
  if (result.error) {
    showToast(result.error);
    return;
  }
  hideModal('modal-account-login');
  hideModal('modal-transfer-scan');
  if (typeof stopTransferScanner === 'function') stopTransferScanner();
  finishAccountRestore(result);
}

function startAccountMergePolling() {
  stopAccountMergePolling();
  if (!getEffectiveSyncUrl()) return;
  const user = getCurrentUser();
  if (!user || !user.passwordHash) return;
  const tick = () => pullAccountFromCloudIfNewer().then(changed => {
    if (changed) {
      if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
      else refreshMainUI();
    }
    updateAccountSyncStatusUI();
  }).catch(() => {});
  tick();
  accountMergeTimer = setInterval(tick, ACCOUNT_MERGE_MS);
}

function stopAccountMergePolling() {
  if (accountMergeTimer) {
    clearInterval(accountMergeTimer);
    accountMergeTimer = null;
  }
}

const _setUserAvatarV12 = setUserAvatar;
setUserAvatar = function (userId, dataUrl) {
  const ok = _setUserAvatarV12(userId, dataUrl);
  if (ok) schedulePushAccountToCloud();
  return ok;
};

const _removeUserAvatarV12 = removeUserAvatar;
removeUserAvatar = function (userId) {
  _removeUserAvatarV12(userId);
  schedulePushAccountToCloud();
};

const _setUserAccountPasswordV12 = setUserAccountPassword;
setUserAccountPassword = function (userId, password) {
  _setUserAccountPasswordV12(userId, password);
  schedulePushAccountToCloud();
};

const _cloudSyncAfterSendV12 = cloudSyncAfterSend;
cloudSyncAfterSend = async function (convId, msg) {
  await _cloudSyncAfterSendV12(convId, msg);
  const user = getCurrentUser();
  if (user && user.passwordHash) schedulePushAccountToCloud();
};

const _importTransferBackupV12 = importTransferBackup;
importTransferBackup = function (backup) {
  _importTransferBackupV12(backup);
  localStorage.setItem(ACCOUNT_SYNC_TS_KEY, String(Date.now()));
};

const _syncFriendshipsV12 = syncFriendships;
syncFriendships = async function () {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return 0;
  const before = JSON.stringify(getFriends(user.id).map(f => ({
    id: f.id,
    avatarAt: f.avatarUpdatedAt || 0,
    name: f.name
  })));
  const added = await _syncFriendshipsV12();
  const after = JSON.stringify(getFriends(user.id).map(f => ({
    id: f.id,
    avatarAt: f.avatarUpdatedAt || 0,
    name: f.name
  })));
  if (before !== after) refreshMainUI();
  return added;
};

const _startGlobalSyncV12 = startGlobalSync;
startGlobalSync = function () {
  _startGlobalSyncV12();
  startAccountMergePolling();
  const user = getCurrentUser();
  if (user && user.passwordHash) {
    pullAccountFromCloudIfNewer().then(changed => {
      if (changed) {
        if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
        else refreshMainUI();
      }
      updateAccountSyncStatusUI();
    }).catch(() => {});
  }
};

const _stopGlobalSyncV12 = stopGlobalSync;
stopGlobalSync = function () {
  _stopGlobalSyncV12();
  stopAccountMergePolling();
};

if (typeof handleRemoteActivity === 'function') {
  const _handleRemoteActivityV12 = handleRemoteActivity;
  handleRemoteActivity = async function () {
    await _handleRemoteActivityV12();
    updateAccountSyncStatusUI();
  };
}

const _renderProfileV12 = renderProfile;
renderProfile = function () {
  _renderProfileV12();
  updateAccountSyncStatusUI();
};

function initV12Features() {
  bindClick('btn-account-sync-now', async () => {
    showToast('同期中…');
    await pushAccountToCloud();
    await syncAccountAcrossDevices();
    showToast('全端末へ同期しました');
  });
  bindClick('btn-login-other-device', () => showAccountLoginModal());
  bindClick('btn-account-login-onboarding', () => showAccountLoginModal());
  bindClick('btn-account-login-submit', async () => {
    const uid = document.getElementById('input-account-login-id')?.value?.trim() || '';
    const pw = document.getElementById('input-account-login-password')?.value || '';
    if (!uid) {
      showToast('ユーザーIDを入力してください');
      return;
    }
    showToast('ログイン中…');
    finishAccountLogin(await loginAccountOnDevice(uid, pw));
  });
  bindClick('btn-cloud-restore', () => showAccountLoginModal());
  bindClick('btn-cloud-restore-onboarding', () => showAccountLoginModal());
  bindClick('btn-save-password', () => {
    const user = getCurrentUser();
    const pw = document.getElementById('input-account-password')?.value || '';
    setUserAccountPassword(user.id, pw);
    document.getElementById('input-account-password').value = '';
    showToast(pw
      ? 'パスワードを設定しました。他の端末でも同じIDとパスワードでログインできます'
      : 'パスワードを解除しました');
    updateAccountSyncStatusUI();
  });
}

onAppInit(() => {
  initV12Features();
  updateAccountSyncStatusUI();
});
