/**
 * BlueChat v9 — 同期・称号・通話・管理者削除・配信の修正
 */
var APP_VERSION = 'v9';

const TITLE_CATALOG_MAX = 10;
const TITLE_TEXT_MAX = 20;

function applyV9Branding() {
  const title = 'BlueChat v9';
  document.title = title;
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.textContent = title;
  const logoTitle = document.querySelector('.logo-large h1');
  if (logoTitle) logoTitle.textContent = title;
}

function normalizeTitleText(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  if (trimmed.length > TITLE_TEXT_MAX) {
    showToast(`称号名は${TITLE_TEXT_MAX}文字までです`);
    return trimmed.slice(0, TITLE_TEXT_MAX);
  }
  return trimmed;
}

function getTitlePresets() {
  const data = getData();
  if (!data.titlePresets) data.titlePresets = [];
  return data.titlePresets;
}

function saveTitlePresetsLocal(presets) {
  const data = getData();
  data.titlePresets = (presets || []).slice(0, TITLE_CATALOG_MAX);
  saveData(data);
}

async function fetchTitlePresets() {
  if (!getEffectiveSyncUrl()) return getTitlePresets();
  const res = await cloudRequestExt('/api/title-presets');
  if (res && Array.isArray(res.presets)) {
    saveTitlePresetsLocal(res.presets);
    return res.presets;
  }
  return getTitlePresets();
}

async function pushTitlePresets(presets) {
  saveTitlePresetsLocal(presets);
  if (!getEffectiveSyncUrl()) return true;
  const res = await cloudRequestExt('/api/title-presets', {
    method: 'PUT',
    body: JSON.stringify({ presets: presets.slice(0, TITLE_CATALOG_MAX) })
  });
  if (res && Array.isArray(res.presets)) {
    saveTitlePresetsLocal(res.presets);
    return true;
  }
  return !!(res && res.ok);
}

async function addTitlePreset(text, color) {
  const normalized = normalizeTitleText(text);
  if (!normalized) return null;
  const presets = await fetchTitlePresets();
  if (presets.length >= TITLE_CATALOG_MAX) {
    showToast(`称号は最大${TITLE_CATALOG_MAX}個まで作成できます`);
    return null;
  }
  const preset = { id: generateId(), text: normalized, color: color || '#1a6fd4' };
  presets.push(preset);
  await pushTitlePresets(presets);
  return preset;
}

function messageSenderHtml(msg, convId, currentUser) {
  const isSent = String(msg.senderId) === String(currentUser.id);
  if (isSent) {
    const badges = typeof userBadgesHtml === 'function' ? userBadgesHtml(currentUser) : '';
    return `あなた${badges}`;
  }
  const sender = getUser(msg.senderId);
  if (!sender) return escapeHtml('不明');
  return typeof displayNameHtml === 'function' ? displayNameHtml(sender) : escapeHtml(sender.name);
}

function getConvDisplayNameHtml(conv, userId) {
  if (conv.type === 'group') return escapeHtml(conv.name);
  const otherId = conv.members.find(m => String(m) !== String(userId));
  const other = otherId ? getUser(otherId) : null;
  if (!other) return escapeHtml('不明');
  return typeof displayNameHtml === 'function' ? displayNameHtml(other) : escapeHtml(other.name);
}

async function adminDeleteUser(userId) {
  const uid = String(userId);
  if (getEffectiveSyncUrl()) {
    const res = await cloudRequestExt(`/api/users/${uid}`, { method: 'DELETE' }, 60000);
    if (!res || !res.ok) {
      showToast('サーバーからの削除に失敗しました');
      return false;
    }
  }
  deleteUser(uid);
  return true;
}

async function repairConversationHistoryOnce() {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl()) return;
  const key = 'bluechat_history_repaired_v2_' + user.id;
  if (localStorage.getItem(key)) return;
  await syncUserConversationList();
  const convs = getUserConversations(user.id);
  for (const conv of convs) {
    await syncConversation(conv.id);
  }
  localStorage.setItem(key, '1');
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
}

async function showTitlePresetManager() {
  if (adminRole !== 'super') {
    showToast('スーパー管理者のみ利用できます');
    return;
  }
  await fetchTitlePresets();
  const presets = getTitlePresets();
  const lines = presets.length
    ? presets.map((p, i) => `${i + 1}. ${p.text}`).join('\n')
    : '（まだありません）';
  const action = prompt(
    `称号プリセット管理（最大${TITLE_CATALOG_MAX}個）\n\n登録済み:\n${lines}\n\n操作:\n+文字 = 新規作成\n番号 = 削除\n例: +VIP`
  );
  if (action === null) return;
  const trimmed = action.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('+')) {
    const text = normalizeTitleText(trimmed.slice(1));
    if (!text) return;
    const color = await pickTitleColor('#1a6fd4');
    if (color === null) return;
    const created = await addTitlePreset(text, color);
    if (created) showToast(`称号「${created.text}」を登録しました（${getTitlePresets().length}/${TITLE_CATALOG_MAX}）`);
    return;
  }
  const idx = parseInt(trimmed, 10) - 1;
  if (idx >= 0 && idx < presets.length) {
    if (!confirm(`「${presets[idx].text}」を削除しますか？`)) return;
    const next = presets.filter((_, i) => i !== idx);
    await pushTitlePresets(next);
    showToast('称号プリセットを削除しました');
  } else {
    showToast('無効な操作です');
  }
}

const _setUserTitleV9 = setUserTitle;
setUserTitle = async function (userId, text, color) {
  return _setUserTitleV9(userId, normalizeTitleText(text), color);
};

renderSuperAdminTitlePanel = async function (userId) {
  const user = getUser(userId);
  if (!user) return;
  await fetchTitlePresets();
  const presets = getTitlePresets();
  const presetLines = presets.length
    ? presets.map((p, i) => `${i + 1}: ${p.text}`).join('\n')
    : '（プリセットなし）';
  const hint = user.title?.text
    ? `現在: ${user.title.text}\n空欄=削除 / 番号=プリセット選択 / +文字=新規作成`
    : `空欄=削除 / 番号=プリセット選択 / +文字=新規作成`;
  const input = prompt(
    `${hint}\n（最大${TITLE_CATALOG_MAX}個まで作成可）\n\nプリセット:\n${presetLines}\n\n入力`,
    user.title?.text || ''
  );
  if (input === null) return;

  const trimmed = input.trim();
  if (!trimmed) {
    const ok = await setUserTitle(userId, '', '');
    renderAdminUsers();
    refreshMainUI();
    showToast(ok ? '称号を削除しました' : '削除に失敗しました');
    return;
  }

  const num = parseInt(trimmed, 10);
  if (!trimmed.startsWith('+') && String(num) === trimmed && num >= 1 && num <= presets.length) {
    const preset = presets[num - 1];
    const ok = await setUserTitle(userId, preset.text, preset.color);
    renderAdminUsers();
    refreshMainUI();
    showToast(ok ? `称号「${preset.text}」を付与しました` : '付与に失敗しました');
    return;
  }

  let text = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  text = normalizeTitleText(text);
  if (!text) return;

  let color = user.title?.color || '#1a6fd4';
  const picked = await pickTitleColor(color);
  if (picked === null) return;
  color = picked;

  const existing = presets.find(p => p.text === text && p.color === color);
  if (!existing && presets.length < TITLE_CATALOG_MAX) {
    await addTitlePreset(text, color);
  } else if (!existing && presets.length >= TITLE_CATALOG_MAX) {
    showToast(`プリセットは${TITLE_CATALOG_MAX}個までです。既存から選ぶか、管理画面で削除してください`);
  }

  const ok = await setUserTitle(userId, text, color);
  renderAdminUsers();
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
  else refreshMainUI();
  showToast(ok ? '称号を更新しました（全端末に反映）' : '称号を保存しましたがサーバー反映に失敗しました');
};

// 称号色: 既存 + ゴールド / シルバー / ゴールドブルー / シルバーブルー
TITLE_COLOR_PALETTE.push(
  { name: 'ゴールド', color: '#d4af37' },
  { name: 'シルバー', color: '#c0c0c0' },
  { name: 'ゴールドブルー', color: '#3d7ea6' },
  { name: 'シルバーブルー', color: '#7eb8da' }
);

const _renderChatListV9 = renderChatList;
renderChatList = function () {
  _renderChatListV9();
  const user = getCurrentUser();
  if (!user) return;
  const convs = getUserConversations(user.id);
  const items = document.querySelectorAll('#chat-list .list-item');
  convs.forEach((conv, i) => {
    const item = items[i];
    if (!item || conv.type === 'group') return;
    const nameEl = item.querySelector('.list-name');
    if (nameEl) nameEl.innerHTML = getConvDisplayNameHtml(conv, user.id);
  });
};

const _openChatV9 = openChat;
openChat = function (convId) {
  _openChatV9(convId);
  const user = getCurrentUser();
  const conv = getData().conversations[convId];
  const titleEl = document.getElementById('chat-title');
  if (!user || !conv || !titleEl) return;
  if (conv.type === 'direct') {
    titleEl.innerHTML = getConvDisplayNameHtml(conv, user.id);
  }
};

const _createMessageElementV9 = createMessageElement;
createMessageElement = function (msg, convId, user) {
  return _createMessageElementV9(msg, convId, user);
};

const _handleRemoteActivityV9 = handleRemoteActivity;
handleRemoteActivity = async function () {
  await fetchTitlePresets().catch(() => {});
  return _handleRemoteActivityV9();
};

const _importTransferBackupV9 = importTransferBackup;
importTransferBackup = function (backup) {
  _importTransferBackupV9(backup);
  localStorage.removeItem(ACTIVITY_VERSION_KEY);
  localStorage.removeItem('bluechat_history_repaired_' + (getCurrentUser()?.id || ''));
  localStorage.removeItem('bluechat_history_repaired_v2_' + (getCurrentUser()?.id || ''));
};

const _startGlobalSyncV9Titles = startGlobalSync;
startGlobalSync = function () {
  _startGlobalSyncV9Titles();
  fetchTitlePresets().catch(() => {});
};

onAppInit(() => {
  repairConversationHistoryOnce();
  fetchTitlePresets().catch(() => {});
  bindClick('btn-admin-title-presets', () => showTitlePresetManager());
});
