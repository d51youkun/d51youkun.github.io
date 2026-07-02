/**
 * BlueChat v9 — 同期・称号・通話・管理者削除・配信の修正
 */
var APP_VERSION = 'v9';

const TITLE_MAX_LEN = 10;

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
  if (trimmed.length > TITLE_MAX_LEN) {
    showToast(`称号は${TITLE_MAX_LEN}文字までです`);
    return trimmed.slice(0, TITLE_MAX_LEN);
  }
  return trimmed;
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
  const key = 'bluechat_history_repaired_' + user.id;
  if (localStorage.getItem(key)) return;
  const convs = getUserConversations(user.id);
  for (const conv of convs) {
    await syncConversation(conv.id);
  }
  localStorage.setItem(key, '1');
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
}

const _setUserTitleV9 = setUserTitle;
setUserTitle = async function (userId, text, color) {
  return _setUserTitleV9(userId, normalizeTitleText(text), color);
};

renderSuperAdminTitlePanel = async function (userId) {
  const user = getUser(userId);
  if (!user) return;
  const hint = user.title?.text
    ? `現在の称号: ${user.title.text}（空欄で削除・${TITLE_MAX_LEN}文字まで）`
    : `称号なし（${TITLE_MAX_LEN}文字まで）`;
  const text = prompt(`${hint}\n\n称号の文字`, user.title?.text || '');
  if (text === null) return;
  const normalized = normalizeTitleText(text);
  if (text.trim() && !normalized) return;
  let color = user.title?.color || '#1a6fd4';
  if (normalized) {
    const picked = await pickTitleColor(color);
    if (picked === null) return;
    color = picked;
  }
  const ok = await setUserTitle(userId, normalized, color);
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

const _importTransferBackupV9 = importTransferBackup;
importTransferBackup = function (backup) {
  _importTransferBackupV9(backup);
  localStorage.removeItem(ACTIVITY_VERSION_KEY);
  localStorage.removeItem('bluechat_history_repaired_' + (getCurrentUser()?.id || ''));
};

onAppInit(() => {
  applyV9Branding();
  repairConversationHistoryOnce();
});
