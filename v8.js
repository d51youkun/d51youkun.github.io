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
    const picked = prompt('称号の色（#1a6fd4 など）', color);
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

onAppInit(() => {
  applyV8Branding();
  showChatsTab();
  bindChatsTabOnMainOpen();
  repairAllConversationHistory();
});
