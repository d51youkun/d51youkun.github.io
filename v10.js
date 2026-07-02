/**
 * BlueChatX — branding & super-admin extensions
 */
var APP_VERSION = 'BlueChatX';
const BUILD_STAMP = 'BlueChatX-2026-07-02';

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

onAppInit(() => {
  applyAppBranding();
  bindClick('btn-admin-force-friend', () => showAdminForceFriendPairDialog());
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyAppBranding);
} else {
  applyAppBranding();
}
