/**
 * BlueChat v6 — クラウド復元・同期改善・オンライン表示・LINEスタンプ修正
 */
var APP_VERSION = 'v6';
const CLOUD_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLOUD_BACKUP_DIRECT_MAX = 350000;
const PRESENCE_ONLINE_MS = 90000;
const PRESENCE_HEARTBEAT_MS = 30000;

let presenceCache = {};
let presenceTimer = null;
let cloudBackupTimer = null;

function parseLineProductId(url) {
  const s = String(url || '').trim();
  const patterns = [
    /stickershop\/product\/(\d+)/i,
    /stickers\/product\/(\d+)/i,
    /\/sticker\/(\d+)/i,
    /shop\/detail\/(\d+)/i,
    /productId[=:](\d+)/i,
    /^(\d{5,})$/
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

async function uploadCloudBackup(backup) {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl()) return false;
  const payload = backup || buildTransferBackupWithPassword(null);
  const result = await cloudRequestExt(`/api/cloud-backup/${user.id}`, {
    method: 'PUT',
    body: JSON.stringify({ backup: payload, updatedAt: Date.now() })
  }, 120000);
  return !!(result && result.ok);
}

async function fetchCloudBackup(userId) {
  if (!getEffectiveSyncUrl()) return null;
  return cloudRequestExt(`/api/cloud-backup/${userId}`, {}, 120000);
}

async function restoreFromCloudBackup(userId, password) {
  if (!userId) return { error: 'ユーザーIDを入力してください' };
  if (!getEffectiveSyncUrl()) {
    return { error: '先に同期サーバーURLを設定してください（マイページ）' };
  }
  const result = await fetchCloudBackup(userId.trim());
  if (!result || !result.backup) {
    return { error: 'クラウドバックアップが見つかりません。古い端末で一度ログインし同期してください' };
  }
  const backup = result.backup;
  if (backup.passwordHash) {
    if (!password) return { error: 'パスワードが必要です' };
    if (backup.passwordHash !== simpleHash(password)) {
      return { error: 'パスワードが正しくありません' };
    }
  }
  try {
    importTransferBackup(backup);
    return { success: true };
  } catch (e) {
    return { error: e.message || 'データの復元に失敗しました' };
  }
}

function showCloudRestoreModal() {
  const userId = prompt('復元するアカウントのユーザーIDを入力してください\n（マイページに表示されています）');
  if (!userId || !userId.trim()) return;
  const password = prompt('引き継ぎパスワード（設定していない場合は空欄でOK）');
  if (password === null) return;
  showToast('クラウドから復元中…');
  restoreFromCloudBackup(userId.trim(), password).then(result => {
    if (result.error) {
      showToast(result.error);
      return;
    }
    showScreen('main');
    refreshMainUI();
    startGlobalSync();
    startPresenceHeartbeat();
    scheduleCloudBackup();
    showToast('クラウドから復元しました！');
  });
}

async function createTransferSessionV6() {
  if (!getEffectiveSyncUrl()) {
    showToast('引き継ぎには同期サーバーURLの設定が必要です');
    return null;
  }
  const user = getCurrentUser();
  let password = null;
  if (user && user.passwordHash) {
    password = prompt('引き継ぎ用パスワードを入力してください');
    if (password === null) return null;
    if (!verifyUserPassword(user, password)) {
      showToast('パスワードが正しくありません');
      return null;
    }
  } else {
    const custom = prompt('引き継ぎ用パスワードを設定しますか？（空欄でスキップ）');
    if (custom) password = custom;
  }

  const fullBackup = buildTransferBackupWithPassword(password);
  await uploadCloudBackup(fullBackup);

  const token = generateId() + generateId();
  const backupJson = JSON.stringify(fullBackup);
  let transferPayload;

  if (backupJson.length > CLOUD_BACKUP_DIRECT_MAX) {
    transferPayload = {
      cloudBackupUserId: user.id,
      passwordHash: fullBackup.passwordHash || null,
      syncUrl: fullBackup.syncUrl,
      version: 2,
      exportedAt: Date.now()
    };
  } else {
    transferPayload = fullBackup;
  }

  const ok = await cloudRequestExt(`/api/transfer/${token}`, {
    method: 'PUT',
    body: JSON.stringify({ backup: transferPayload, expiresAt: Date.now() + TRANSFER_EXPIRY_MS })
  }, 120000);
  if (!ok || !ok.ok) {
    showToast('引き継ぎデータのアップロードに失敗しました');
    return null;
  }
  return TRANSFER_PREFIX + token;
}

createTransferSession = createTransferSessionV6;

async function redeemTransferCodeV6(code) {
  const raw = String(code || '').trim();
  const idx = raw.indexOf(TRANSFER_PREFIX);
  if (idx < 0) return { error: '無効な引き継ぎコードです' };
  const token = raw.slice(idx + TRANSFER_PREFIX.length);
  if (!getEffectiveSyncUrl()) {
    return { error: '先に同期サーバーURLを設定してください（マイページ）' };
  }
  const result = await cloudRequestExt(`/api/transfer/${token}`, {}, 120000);
  if (!result || !result.backup) {
    return { error: '引き継ぎデータが見つかりません（期限切れの可能性）' };
  }

  let backup = result.backup;
  if (backup.cloudBackupUserId && !backup.data) {
    const cloud = await fetchCloudBackup(backup.cloudBackupUserId);
    if (!cloud || !cloud.backup) {
      return { error: 'クラウドバックアップが見つかりません。古い端末がオンラインか確認してください' };
    }
    backup = cloud.backup;
    if (result.backup.syncUrl && !backup.syncUrl) backup.syncUrl = result.backup.syncUrl;
    if (result.backup.passwordHash) backup.passwordHash = result.backup.passwordHash;
  }

  if (backup.passwordHash) {
    const pw = prompt('引き継ぎパスワードを入力してください');
    if (pw === null) return { error: 'キャンセルしました' };
    if (backup.passwordHash !== simpleHash(pw)) {
      return { error: 'パスワードが正しくありません' };
    }
  }

  try {
    importTransferBackup(backup);
    await cloudRequestExt(`/api/transfer/${token}/consumed`, { method: 'POST', body: '{}' });
    return { success: true };
  } catch (e) {
    return { error: e.message || 'データの復元に失敗しました' };
  }
}

redeemTransferCode = redeemTransferCodeV6;

function onTransferScanSuccessV6(decodedText) {
  if (qrScanHandled) return;
  const code = String(decodedText || '').trim();
  if (!code.includes(TRANSFER_PREFIX)) return;
  qrScanHandled = true;
  if (typeof stopTransferScanner === 'function') stopTransferScanner();
  else if (typeof stopQrScanner === 'function') stopQrScanner();
  hideModal('modal-transfer-scan');
  redeemTransferCode(code).then(result => {
    if (result.error) {
      showToast(result.error);
      qrScanHandled = false;
      return;
    }
    showScreen('main');
    refreshMainUI();
    startGlobalSync();
    startPresenceHeartbeat();
    scheduleCloudBackup();
    showToast('引き継ぎが完了しました！');
  });
}

onTransferScanSuccess = onTransferScanSuccessV6;

async function importLineStickerPackV6(url) {
  const productId = parseLineProductId(url);
  if (!productId) {
    showToast('LINEスタンプショップのURLを入力してください\n例: https://store.line.me/stickershop/product/1234/ja');
    return null;
  }
  if (!getEffectiveSyncUrl()) {
    showToast('スタンプ取得には同期サーバーが必要です（マイページで設定）');
    return null;
  }
  showToast('スタンプを取得中…');
  const result = await cloudRequestExt(`/api/line-stickers/${productId}`, {}, 60000);
  if (!result || !result.stickers || !result.stickers.length) {
    const msg = (result && result.error) ? result.error : 'スタンプの取得に失敗しました';
    showToast(msg);
    return null;
  }
  const pack = {
    id: 'line_' + productId,
    name: result.name || ('LINE ' + productId),
    stickers: result.stickers.map(s => ({ type: 'image', src: s.url, emoji: s.emoji || '🎨' }))
  };
  saveCustomStickerPack(pack);
  showToast(`スタンプ「${pack.name}」を追加しました（${pack.stickers.length}個）`);
  return pack;
}

importLineStickerPack = importLineStickerPackV6;

async function sendPresenceHeartbeat() {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  await cloudRequest(`/api/presence/${user.id}`, {
    method: 'PUT',
    body: JSON.stringify({ lastSeen: Date.now() })
  });
}

async function fetchFriendsPresence() {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  const friends = getFriends(user.id);
  if (!friends.length) return;
  const ids = friends.map(f => f.id).join(',');
  const result = await cloudRequest(`/api/presence?ids=${encodeURIComponent(ids)}`);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    presenceCache = result;
    updatePresenceUI();
  }
}

function isUserOnline(userId) {
  const p = presenceCache[userId];
  if (!p || !p.lastSeen) return false;
  return Date.now() - p.lastSeen < PRESENCE_ONLINE_MS;
}

function presenceStatusText(userId) {
  return isUserOnline(userId) ? 'オンライン' : 'オフライン';
}

function presenceDotHtml(userId) {
  const online = isUserOnline(userId);
  return `<span class="presence-dot ${online ? 'online' : 'offline'}" title="${online ? 'オンライン' : 'オフライン'}"></span>`;
}

function updatePresenceUI() {
  const user = getCurrentUser();
  if (!user) return;
  if (currentConvId) {
    const conv = getData().conversations[currentConvId];
    if (conv && conv.type === 'direct') {
      const otherId = conv.members.find(m => String(m) !== String(user.id));
      const statusEl = document.getElementById('chat-presence-status');
      if (statusEl && otherId) {
        statusEl.textContent = presenceStatusText(otherId);
        statusEl.className = 'chat-presence-status ' + (isUserOnline(otherId) ? 'online' : 'offline');
      }
    }
  }
  const friendTab = document.getElementById('tab-friends');
  if (friendTab && !friendTab.classList.contains('hidden')) {
    renderFriendList();
  }
}

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  if (!getSyncUrl()) return;
  sendPresenceHeartbeat();
  fetchFriendsPresence();
  presenceTimer = setInterval(() => {
    sendPresenceHeartbeat();
    fetchFriendsPresence();
  }, PRESENCE_HEARTBEAT_MS);
}

function stopPresenceHeartbeat() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
}

function scheduleCloudBackup() {
  if (cloudBackupTimer) clearInterval(cloudBackupTimer);
  if (!getSyncUrl() || !getCurrentUser()) return;
  const run = () => uploadCloudBackup().catch(() => {});
  run();
  cloudBackupTimer = setInterval(run, 5 * 60 * 1000);
}

const _renderFriendListV6 = renderFriendList;
renderFriendList = function () {
  const user = getCurrentUser();
  if (!user) return;
  const friends = getFriends(user.id);
  const list = document.getElementById('friend-list');
  const empty = document.getElementById('friend-list-empty');
  list.innerHTML = '';
  if (friends.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  friends.forEach(friend => {
    const item = document.createElement('div');
    item.className = 'list-item';
    const status = presenceStatusText(friend.id);
    item.innerHTML = `
      <div class="avatar-with-presence">
        ${avatarHtml(friend)}
        ${presenceDotHtml(friend.id)}
      </div>
      <div class="list-info">
        <div class="list-name">${displayNameHtml(friend)}</div>
        <div class="list-preview presence-label ${isUserOnline(friend.id) ? 'online' : 'offline'}">${status}</div>
      </div>
      <button type="button" class="btn-text-link btn-unfriend" data-id="${friend.id}">解除</button>`;
    item.querySelector('.list-info').addEventListener('click', () => {
      openChat(getOrCreateDirectConv(user.id, friend.id));
    });
    item.querySelector('.btn-unfriend').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`${friend.name} との友だち関係を解除しますか？`)) {
        removeFriendship(user.id, friend.id);
        refreshMainUI();
        showToast('友だちを解除しました');
      }
    });
    list.appendChild(item);
  });
};

const _openChatV6 = openChat;
openChat = function (convId) {
  _openChatV6(convId);
  const user = getCurrentUser();
  const conv = getData().conversations[convId];
  const statusEl = document.getElementById('chat-presence-status');
  if (!statusEl) return;
  if (conv && conv.type === 'direct' && user) {
    const otherId = conv.members.find(m => String(m) !== String(user.id));
    statusEl.classList.remove('hidden');
    if (otherId) {
      statusEl.textContent = presenceStatusText(otherId);
      statusEl.className = 'chat-presence-status ' + (isUserOnline(otherId) ? 'online' : 'offline');
    }
  } else {
    statusEl.classList.add('hidden');
  }
};

const _startGlobalSyncV6 = startGlobalSync;
startGlobalSync = function () {
  _startGlobalSyncV6();
  startPresenceHeartbeat();
  scheduleCloudBackup();
};

const _stopGlobalSyncV6 = stopGlobalSync;
stopGlobalSync = function () {
  _stopGlobalSyncV6();
  stopPresenceHeartbeat();
  if (cloudBackupTimer) {
    clearInterval(cloudBackupTimer);
    cloudBackupTimer = null;
  }
};

function initV6Features() {
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.textContent = 'BlueChat v6';

  const logoTitle = document.querySelector('.logo-large h1');
  if (logoTitle) logoTitle.textContent = 'BlueChat v6';

  bindClick('btn-cloud-restore', () => showCloudRestoreModal());
  bindClick('btn-cloud-restore-onboarding', () => {
    const url = prompt('同期サーバーURL（空欄でデフォルト）', getEffectiveSyncUrl() || '');
    if (url !== null && url.trim()) setSyncUrl(url.trim());
    showCloudRestoreModal();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && getCurrentUser()) {
      uploadCloudBackup().catch(() => {});
      sendPresenceHeartbeat().catch(() => {});
    }
  });
}

onAppInit(() => {
  initV6Features();
});
