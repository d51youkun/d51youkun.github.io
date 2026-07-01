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

onAppInit(() => {
  applyV8Branding();
  repairAllConversationHistory();
});
