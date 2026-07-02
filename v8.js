/**
 * BlueChat v8 — 会話履歴の修復・短い友だちコード
 */
var APP_VERSION = 'v8';

function applyV8Branding() {
  const title = 'BlueChat v8';
  document.title = title;
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.textContent = title;
  const logoTitle = document.querySelector('.logo-large h1');
  if (logoTitle) logoTitle.textContent = title;
}

async function repairAllConversationHistory() {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  const convs = getUserConversations(user.id);
  for (const conv of convs) {
    await syncConversation(conv.id);
  }
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
  else refreshMainUI();
}

const _openChatV8 = openChat;
openChat = function (convId) {
  _openChatV8(convId);
  if (!getSyncUrl() || !convId) return;
  syncConversation(convId).then(() => {
    if (currentConvId === convId) renderMessages(convId);
  });
};

async function setUserTitle(userId, text, color) {
  const user = getUser(userId);
  if (!user) return false;
  const trimmed = (text || '').trim();
  if (trimmed) {
    user.title = {
      text: trimmed,
      color: (color || '#1a6fd4').trim() || '#1a6fd4'
    };
  } else {
    delete user.title;
  }
  saveData(getData());
  if (getSyncUrl()) return await cloudPushUser(user);
  return true;
}

const TITLE_COLOR_PALETTE = [
  { name: 'ブルー', color: '#1a6fd4' },
  { name: 'ネイビー', color: '#0d4a8f' },
  { name: 'スカイ', color: '#4a9af0' },
  { name: 'レッド', color: '#e53935' },
  { name: 'ピンク', color: '#ec407a' },
  { name: 'オレンジ', color: '#f57c00' },
  { name: 'イエロー', color: '#f9a825' },
  { name: 'グリーン', color: '#43a047' },
  { name: 'ティール', color: '#00897b' },
  { name: 'パープル', color: '#7b1fa2' },
  { name: 'グレー', color: '#546e7a' },
  { name: 'ブラック', color: '#212121' }
];

function ensureTitleColorModal() {
  let modal = document.getElementById('modal-title-color');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'modal-title-color';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-content glass-panel title-color-modal">
      <h3>称号の色を選択</h3>
      <div id="title-color-palette" class="title-color-palette"></div>
      <button type="button" id="btn-title-color-cancel" class="btn-secondary btn-sm">キャンセル</button>
    </div>`;
  document.body.appendChild(modal);
  bindClick('btn-title-color-cancel', () => {
    if (typeof modal._colorResolve === 'function') {
      modal._colorResolve(null);
      modal._colorResolve = null;
    }
    hideModal('modal-title-color');
  });
  return modal;
}

function pickTitleColor(currentColor) {
  return new Promise((resolve) => {
    const modal = ensureTitleColorModal();
    const palette = modal.querySelector('#title-color-palette');
    palette.innerHTML = '';
    const normalized = (currentColor || '#1a6fd4').toLowerCase();
    TITLE_COLOR_PALETTE.forEach(({ name, color }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'title-color-swatch' + (color.toLowerCase() === normalized ? ' selected' : '');
      btn.style.background = color;
      btn.setAttribute('aria-label', name);
      btn.title = name;
      btn.addEventListener('click', () => {
        hideModal('modal-title-color');
        resolve(color);
      });
      palette.appendChild(btn);
    });
    modal._colorResolve = resolve;
    showModal('modal-title-color');
  });
}

// モーダル外タップ・キャンセル時
document.addEventListener('click', (e) => {
  const modal = document.getElementById('modal-title-color');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.target === modal) {
    hideModal('modal-title-color');
    if (typeof modal._colorResolve === 'function') {
      modal._colorResolve(null);
      modal._colorResolve = null;
    }
  }
});

renderSuperAdminTitlePanel = async function (userId) {
  const user = getUser(userId);
  if (!user) return;
  const hint = user.title?.text
    ? `現在の称号: ${user.title.text}（空欄で削除）`
    : '称号なし（新しく付与できます）';
  const text = prompt(`${hint}\n\n称号の文字`, user.title?.text || '');
  if (text === null) return;
  let color = user.title?.color || '#1a6fd4';
  if (text.trim()) {
    const picked = await pickTitleColor(color);
    if (picked === null) return;
    color = picked;
  }
  const ok = await setUserTitle(userId, text, color);
  renderAdminUsers();
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
  else refreshMainUI();
  showToast(ok ? '称号を更新しました（全端末に反映）' : '称号を保存しましたがサーバー反映に失敗しました');
};

function showChatsTab() {
  currentTab = 'chats';
  document.querySelectorAll('.tab[data-tab]').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === 'chats');
  });
  document.querySelectorAll('#screen-main .tab-content').forEach(c => c.classList.add('hidden'));
  const chats = document.getElementById('tab-chats');
  if (chats) chats.classList.remove('hidden');
}

function bindChatsTabOnMainOpen() {
  const backBtn = document.getElementById('btn-back-chat');
  if (backBtn && !backBtn.dataset.v8Chats) {
    backBtn.dataset.v8Chats = '1';
    backBtn.addEventListener('click', () => requestAnimationFrame(showChatsTab));
  }
  const startBtn = document.getElementById('btn-start');
  if (startBtn && !startBtn.dataset.v8Chats) {
    startBtn.dataset.v8Chats = '1';
    startBtn.addEventListener('click', () => requestAnimationFrame(showChatsTab));
  }
}

// ─── Sticker sync across browsers + cloud merge ───────────
const STICKER_SYNC_TS_KEY = 'bluechat_stickers_sync_ts';
const CLOUD_MERGE_TS_KEY = 'bluechat_cloud_merged_at';

function mergeStickerPackLists(local, remote) {
  const byId = new Map();
  (local || []).forEach(p => { if (p && p.id) byId.set(p.id, p); });
  (remote || []).forEach(p => { if (p && p.id) byId.set(p.id, p); });
  return [...byId.values()];
}

async function pushUserStickerPacksToServer() {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl()) return false;
  const packs = typeof getCustomStickerPacks === 'function' ? getCustomStickerPacks() : [];
  const updatedAt = Date.now();
  const result = await cloudRequestExt(`/api/user-stickers/${user.id}`, {
    method: 'PUT',
    body: JSON.stringify({ packs, updatedAt })
  });
  if (result && result.ok !== false) {
    localStorage.setItem(STICKER_SYNC_TS_KEY, String(updatedAt));
    return true;
  }
  return false;
}

async function pullUserStickerPacksFromServer() {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl()) return;
  const remote = await cloudRequestExt(`/api/user-stickers/${user.id}`);
  if (!remote || !Array.isArray(remote.packs)) return;
  const data = getData();
  const localPacks = data.customStickerPacks || [];
  const merged = mergeStickerPackLists(localPacks, remote.packs);
  const localTs = parseInt(localStorage.getItem(STICKER_SYNC_TS_KEY) || '0', 10);
  const remoteTs = remote.updatedAt || 0;
  if (JSON.stringify(merged) !== JSON.stringify(localPacks)) {
    data.customStickerPacks = merged;
    saveData(data);
    if (typeof renderStickerPicker === 'function') renderStickerPicker();
  }
  if (remoteTs > localTs) {
    localStorage.setItem(STICKER_SYNC_TS_KEY, String(remoteTs));
  } else if (localTs > remoteTs) {
    await pushUserStickerPacksToServer();
  }
}

async function tryAutoCloudStickerMerge() {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl() || typeof fetchCloudBackup !== 'function') return;
  const remote = await fetchCloudBackup(user.id);
  if (!remote || !remote.backup || !remote.backup.data) return;
  const lastMerged = parseInt(localStorage.getItem(CLOUD_MERGE_TS_KEY) || '0', 10);
  if ((remote.updatedAt || 0) <= lastMerged) return;
  const remotePacks = remote.backup.data.customStickerPacks || [];
  if (remotePacks.length) {
    const data = getData();
    const merged = mergeStickerPackLists(data.customStickerPacks || [], remotePacks);
    if (JSON.stringify(merged) !== JSON.stringify(data.customStickerPacks || [])) {
      data.customStickerPacks = merged;
      saveData(data);
      if (typeof renderStickerPicker === 'function') renderStickerPicker();
    }
    await pushUserStickerPacksToServer();
  }
  localStorage.setItem(CLOUD_MERGE_TS_KEY, String(remote.updatedAt || Date.now()));
}

async function syncUserDataAcrossBrowsers() {
  await pullUserStickerPacksFromServer();
  await tryAutoCloudStickerMerge();
}

if (typeof saveCustomStickerPack === 'function') {
  const _saveCustomStickerPackV8 = saveCustomStickerPack;
  saveCustomStickerPack = function (pack) {
    _saveCustomStickerPackV8(pack);
    pushUserStickerPacksToServer().catch(() => {});
    if (typeof uploadCloudBackup === 'function') uploadCloudBackup().catch(() => {});
  };
}

if (typeof deleteCustomStickerPack === 'function') {
  const _deleteCustomStickerPackV8 = deleteCustomStickerPack;
  deleteCustomStickerPack = function (packId) {
    _deleteCustomStickerPackV8(packId);
    pushUserStickerPacksToServer().catch(() => {});
    if (typeof uploadCloudBackup === 'function') uploadCloudBackup().catch(() => {});
  };
}

const _startGlobalSyncV8 = startGlobalSync;
startGlobalSync = function () {
  _startGlobalSyncV8();
  syncUserDataAcrossBrowsers().catch(() => {});
};

onAppInit(() => {
  bindChatsTabOnMainOpen();
  requestAnimationFrame(showChatsTab);
  const user = getCurrentUser();
  if (user && getEffectiveSyncUrl()) {
    syncUserDataAcrossBrowsers().catch(() => {});
    if (typeof scheduleCloudBackup === 'function') scheduleCloudBackup();
  }
});
