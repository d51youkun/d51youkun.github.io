/**
 * BlueChatX — branding & super-admin extensions
 */
var APP_VERSION = 'BlueChatX';
const BUILD_STAMP = 'BlueChatX-2026-07-15-stable-v28';

function applyAppBranding() {
  const title = 'BlueChatX';
  document.title = title;
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.textContent = title;
  const logoTitle = document.querySelector('.logo-large h1');
  if (logoTitle) logoTitle.textContent = title;
}

async function adminForceFriendship(userId1, userId2) {
  if (adminRole !== 'super') {
    showToast('スーパー管理者のみ利用できます');
    return false;
  }
  const a = String(userId1 || '').trim();
  const b = String(userId2 || '').trim();
  if (!a || !b) {
    showToast('ユーザーIDを入力してください');
    return false;
  }
  if (a === b) {
    showToast('同じユーザーは友だちにできません');
    return false;
  }

  if (getEffectiveSyncUrl()) {
    for (const uid of [a, b]) {
      if (!getUser(uid)) {
        const remote = await cloudFetchUser(uid);
        if (remote && remote.id) ensureLocalUser(remote);
      }
    }
  }
  if (!getUser(a) || !getUser(b)) {
    showToast('ユーザーが見つかりません');
    return false;
  }
  if (areFriends(a, b)) {
    showToast('すでに友だちです');
    renderAdminUsers();
    return true;
  }

  const convId = addFriendship(a, b);
  if (getEffectiveSyncUrl()) {
    await cloudPushFriendship(a, b);
    const conv = convId ? getData().conversations[convId] : null;
    if (conv) await cloudPushConversation(conv);
  }

  const u1 = getUser(a);
  const u2 = getUser(b);
  showToast(`「${u1?.name || a}」と「${u2?.name || b}」を友だちにしました`);
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
  else refreshMainUI();
  renderAdminUsers();
  return true;
}

function showAdminForceFriendPairDialog() {
  if (adminRole !== 'super') {
    showToast('スーパー管理者のみ利用できます');
    return;
  }
  const id1 = prompt('ユーザー1のID（友だちにする側）');
  if (id1 === null || !id1.trim()) return;
  const id2 = prompt('ユーザー2のID（友だちにされる側）');
  if (id2 === null || !id2.trim()) return;
  if (!confirm('QRなしでこの2人を友だちにしますか？')) return;
  adminForceFriendship(id1.trim(), id2.trim());
}

async function adminIssueTransferForUser(userId) {
  if (adminRole !== 'super') {
    showToast('スーパー管理者のみ利用できます');
    return;
  }
  ensureSyncUrlForRestore();
  const user = getUser(userId);
  const name = user ? user.name : userId;
  if (!confirm(`「${name}」の引き継ぎコードを発行しますか？\n（QR不要・72時間有効）`)) return;

  const res = await adminCloudRequest('/api/admin/issue-transfer', {
    method: 'POST',
    body: JSON.stringify({ userId: String(userId), hours: 72 })
  });
  if (!res || !res.ok) {
    showToast('引き継ぎコードの発行に失敗しました（サーバーデータがない可能性）');
    return;
  }

  const msg = [
    `引き継ぎコードを発行しました（${name}）`,
    '',
    `短縮コード: ${res.shortCode}`,
    '',
    `長いコード:`,
    res.code,
    '',
    '新しい端末の「引き継ぎ」画面で入力してください'
  ].join('\n');
  alert(msg);
  try {
    await navigator.clipboard.writeText(res.shortCode || res.code);
    showToast('短縮コードをコピーしました');
  } catch (e) {
    showToast('コードをメモしてください');
  }
}

async function adminRestoreUserToDevice(userId) {
  if (adminRole !== 'super') {
    showToast('スーパー管理者のみ利用できます');
    return;
  }
  const user = getUser(userId);
  const name = user ? user.name : userId;
  if (!confirm(`「${name}」のデータをこの端末に復元しますか？`)) return;
  const password = prompt('引き継ぎパスワード（未設定なら空欄）');
  if (password === null) return;
  showToast('サーバーから復元中…');
  const result = await restoreAccountByUserId(userId, password);
  finishAccountRestore(result);
}

async function adminForceGlobalSync() {
  if (adminRole !== 'super') {
    showToast('スーパー管理者のみ利用できます');
    return;
  }
  ensureSyncUrlForRestore();
  if (!getEffectiveSyncUrl()) {
    showToast('同期サーバーに接続できません');
    return;
  }
  const res = await adminForceSyncRequest();
  if (!res || !res.ok) {
    showToast('強制同期に失敗しました（サーバー接続または管理者認証を確認してください）');
    return;
  }
  localStorage.removeItem(ACTIVITY_VERSION_KEY);
  if (typeof syncAllConversations === 'function') await syncAllConversations();
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
  showToast('全端末への同期を通知しました');
}

onAppInit(() => {
  applyAppBranding();
  ensureSyncUrlForRestore();
  bindClick('btn-admin-force-friend', () => showAdminForceFriendPairDialog());
  bindClick('btn-admin-force-sync', () => adminForceGlobalSync());
  const user = getCurrentUser();
  if (user && getEffectiveSyncUrl() && typeof uploadCloudBackup === 'function') {
    uploadCloudBackup().catch(() => {});
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyAppBranding);
} else {
  applyAppBranding();
}
