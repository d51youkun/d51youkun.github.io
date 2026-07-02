/**
 * BlueChat v4 features
 */

const ADMIN_ROLE_KEY = 'bluechat_admin_role';
const SUSPEND_DURATION_MS = 60 * 60 * 1000;

let adminRole = null;
let audioUnlocked = false;

// ─── Password helpers ────────────────────────────────────
function simpleHash(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return 'h' + Math.abs(h).toString(36);
}

function setUserAccountPassword(userId, password) {
  const data = getData();
  const user = data.users[userId];
  if (!user) return;
  if (password) user.passwordHash = simpleHash(password);
  else delete user.passwordHash;
  saveData(data);
  cloudPushUser(user);
}

function verifyUserPassword(user, password) {
  if (!user || !user.passwordHash) return true;
  return user.passwordHash === simpleHash(password);
}

function promptUserPasswordIfNeeded(user, actionLabel) {
  if (!user || !user.passwordHash) return true;
  const pw = prompt(`${user.name} のパスワードを入力してください（${actionLabel}）`);
  if (pw === null) return false;
  if (!verifyUserPassword(user, pw)) {
    showToast('パスワードが正しくありません');
    return false;
  }
  return true;
}

// ─── Suspension ────────────────────────────────────────────
function isUserSuspended(userId) {
  const user = getUser(userId);
  if (!user || !user.suspendedUntil) return false;
  if (Date.now() > user.suspendedUntil) {
    delete user.suspendedUntil;
    saveData(getData());
    cloudPushUser(user);
    return false;
  }
  return true;
}

function suspendUserForOneHour(userId) {
  const data = getData();
  const user = data.users[userId];
  if (!user) return;
  user.suspendedUntil = Date.now() + SUSPEND_DURATION_MS;
  saveData(data);
  cloudPushUser(user);
}

function formatSuspendedUntil(ts) {
  return new Date(ts).toLocaleString('ja-JP');
}

// ─── Admin roles ─────────────────────────────────────────
function saveAdminSession() {
  if (adminLoggedIn && adminRole) {
    localStorage.setItem(ADMIN_SESSION_KEY, '1');
    localStorage.setItem(ADMIN_ROLE_KEY, adminRole);
  } else {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.removeItem(ADMIN_ROLE_KEY);
  }
}

function loadAdminSession() {
  adminLoggedIn = localStorage.getItem(ADMIN_SESSION_KEY) === '1';
  adminRole = localStorage.getItem(ADMIN_ROLE_KEY) || null;
  if (adminLoggedIn && !adminRole) adminRole = 'super';
}

function titleBadgeHtml(user) {
  if (!user || !user.title || !user.title.text) return '';
  const color = user.title.color || '#1a6fd4';
  return `<span class="user-title-badge" style="background:${escapeHtml(color)}">${escapeHtml(user.title.text)}</span>`;
}

function displayNameHtml(user) {
  if (!user) return '不明';
  return `${escapeHtml(user.name)}${titleBadgeHtml(user)}`;
}

// ─── Scroll fix ──────────────────────────────────────────
function isMessagesNearBottom() {
  const c = document.getElementById('messages-container');
  if (!c) return true;
  return c.scrollHeight - c.scrollTop - c.clientHeight < 100;
}

const _scrollMessagesToBottomOrig = scrollMessagesToBottom;
scrollMessagesToBottom = function (force) {
  const container = document.getElementById('messages-container');
  if (!container) return;
  if (!force && !isMessagesNearBottom()) return;
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
};

function setupMessageScrollTracking() {
  const c = document.getElementById('messages-container');
  if (!c || c.dataset.scrollBound) return;
  c.dataset.scrollBound = '1';
  c.addEventListener('scroll', () => { /* tracked via isMessagesNearBottom */ });
}

// ─── In-app notification popup ───────────────────────────
function showInAppPopup(title, body, onClick) {
  let popup = document.getElementById('in-app-notify');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'in-app-notify';
    popup.className = 'in-app-notify hidden';
    popup.innerHTML = '<strong id="in-app-notify-title"></strong><p id="in-app-notify-body"></p>';
    document.body.appendChild(popup);
    popup.addEventListener('click', () => {
      popup.classList.add('hidden');
      if (typeof popup._onClick === 'function') popup._onClick();
    });
  }
  document.getElementById('in-app-notify-title').textContent = title;
  document.getElementById('in-app-notify-body').textContent = body;
  popup._onClick = onClick;
  popup.classList.remove('hidden');
  setTimeout(() => popup.classList.add('hidden'), 6000);
}

function unlockAudioOnce() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  } catch (e) { /* ignore */ }
}

const _onNewMessageReceivedOrig = onNewMessageReceived;
onNewMessageReceived = function (convId, msg) {
  _onNewMessageReceivedOrig(convId, msg);
  const user = getCurrentUser();
  if (!user || String(msg.senderId) === String(user.id)) return;
  if (!shouldNotifyForConv(convId)) return;
  const conv = getData().conversations[convId];
  if (!conv) return;
  const name = getConvDisplayName(conv, user.id);
  const preview = getMessagePreview(msg);
  showInAppPopup(name, preview, () => openChat(convId));
};

// ─── Friends / groups ────────────────────────────────────
function removeFriendship(id1, id2) {
  const data = getData();
  data.friendships = data.friendships.filter(f =>
    !((f.user1 === id1 && f.user2 === id2) || (f.user1 === id2 && f.user2 === id1))
  );
  saveData(data);
}

function addMembersToGroup(convId, memberIds) {
  const data = getData();
  const conv = data.conversations[convId];
  const user = getCurrentUser();
  if (!conv || conv.type !== 'group' || !user) return false;
  let changed = false;
  memberIds.forEach(id => {
    if (!conv.members.includes(id)) {
      conv.members.push(id);
      changed = true;
    }
  });
  if (changed) {
    saveData(data);
    cloudPushConversation(conv);
  }
  return changed;
}

function removeMemberFromGroup(convId, memberId) {
  const data = getData();
  const conv = data.conversations[convId];
  const user = getCurrentUser();
  if (!conv || conv.type !== 'group' || !user) return false;
  if (memberId === user.id) return leaveGroup(convId, user.id), true;
  if (conv.members.length <= 2) {
    showToast('メンバーが2人以下のため削除できません');
    return false;
  }
  conv.members = conv.members.filter(m => m !== memberId);
  saveData(data);
  cloudPushConversation(conv);
  return true;
}

function ensureGroupMemberUsers(conv) {
  if (!conv || conv.type !== 'group') return;
  conv.members.forEach(id => {
    if (!getUser(id) && getSyncUrl()) {
      cloudFetchUser(id).then(u => { if (u) ensureLocalUser(u); });
    }
  });
}

// ─── Stickers ────────────────────────────────────────────
function getCustomStickerPacks() {
  const data = getData();
  if (!data.customStickerPacks) data.customStickerPacks = [];
  return data.customStickerPacks;
}

function saveCustomStickerPack(pack) {
  const data = getData();
  if (!data.customStickerPacks) data.customStickerPacks = [];
  const idx = data.customStickerPacks.findIndex(p => p.id === pack.id);
  if (idx >= 0) data.customStickerPacks[idx] = pack;
  else data.customStickerPacks.push(pack);
  saveData(data);
}

function getAllStickerPacks() {
  return [...STICKER_PACKS, ...getCustomStickerPacks()];
}

async function importLineStickerPack(url) {
  const m = String(url).match(/product\/(\d+)/i) || String(url).match(/sticker\/(\d+)/i);
  if (!m) {
    showToast('LINEスタンプショップのURLを入力してください');
    return null;
  }
  const productId = m[1];
  showToast('スタンプを取得中…');
  const result = await cloudRequest(`/api/line-stickers/${productId}`);
  if (!result || !result.stickers || !result.stickers.length) {
    showToast('スタンプの取得に失敗しました。URLを確認してください');
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

async function createCustomPhotoStickerPack(name, files) {
  const stickers = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > 2 * 1024 * 1024) continue;
    const src = await readFileAsDataURL(file);
    stickers.push({ type: 'image', src, emoji: '🖼️' });
  }
  if (!stickers.length) {
    showToast('画像を選択してください');
    return null;
  }
  const pack = { id: 'custom_' + generateId(), name: name || 'マイスタンプ', stickers };
  saveCustomStickerPack(pack);
  showToast(`スタンプ帳「${pack.name}」を作成しました`);
  return pack;
}

const _renderStickerPickerOrig = renderStickerPicker;
renderStickerPicker = function () {
  const grid = document.getElementById('sticker-grid');
  if (!grid) return;
  grid.innerHTML = '';
  getAllStickerPacks().forEach(pack => {
    const label = document.createElement('div');
    label.className = 'sticker-pack-label';
    label.textContent = pack.name;
    grid.appendChild(label);
    pack.stickers.forEach(st => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sticker-btn';
      if (st.type === 'image' && st.src) {
        btn.innerHTML = `<img src="${st.src}" alt="sticker" class="sticker-img">`;
      } else {
        btn.textContent = st.emoji || st;
      }
      btn.addEventListener('click', () => {
        const user = getCurrentUser();
        if (!user || !currentConvId) return;
        let msg;
        if (st.type === 'image' && st.src) {
          msg = pushMessage(currentConvId, user.id, { type: 'sticker', stickerImage: st.src, text: '' });
        } else {
          msg = sendStickerMessage(currentConvId, user.id, st.emoji || st);
        }
        if (msg) {
          appendMessageToChat(msg, currentConvId);
          renderChatList();
        }
        hideModal('modal-stickers');
      });
      grid.appendChild(btn);
    });
  });
};

const _getMessageContentHtmlV4 = getMessageContentHtml;
getMessageContentHtml = function (msg) {
  if (msg.type === 'sticker' && msg.stickerImage) {
    return `<img src="${msg.stickerImage}" class="message-sticker-img" alt="スタンプ">`;
  }
  return _getMessageContentHtmlV4(msg);
};

// ─── Transfer QR fix + password ──────────────────────────
function buildTransferBackupWithPassword(password) {
  const backup = buildTransferBackup();
  if (password) backup.passwordHash = simpleHash(password);
  const user = getCurrentUser();
  if (user && user.passwordHash) backup.passwordHash = user.passwordHash;
  return backup;
}

async function createTransferSession() {
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
  const token = generateId() + generateId();
  const backup = buildTransferBackupWithPassword(password);
  const ok = await cloudRequestExt(`/api/transfer/${token}`, {
    method: 'PUT',
    body: JSON.stringify({ backup, expiresAt: Date.now() + TRANSFER_EXPIRY_MS })
  });
  if (!ok || !ok.ok) {
    showToast('引き継ぎデータのアップロードに失敗しました');
    return null;
  }
  return TRANSFER_PREFIX + token;
}

function renderTransferQR() {
  const user = getCurrentUser();
  if (!user) return;
  if (typeof QRCode === 'undefined') {
    showToast('QRコードライブラリを読み込めませんでした');
    return;
  }
  showModal('modal-transfer-qr');
  const container = document.getElementById('transfer-qr-canvas');
  if (container) container.innerHTML = '<p class="qr-hint">生成中…</p>';
  createTransferSession().then(code => {
    if (!code) return;
    if (!container) return;
    container.innerHTML = '';
    const codeEl = document.getElementById('transfer-code-text');
    if (codeEl) codeEl.textContent = code;
    try {
      new QRCode(container, {
        text: code,
        width: 220,
        height: 220,
        colorDark: '#1a6fd4',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.L
      });
    } catch (e) {
      showToast('QRコードの生成に失敗しました');
      return;
    }
    pollTransferConsumed(code.slice(TRANSFER_PREFIX.length));
  });
}

async function redeemTransferCode(code) {
  const raw = String(code || '').trim();
  const idx = raw.indexOf(TRANSFER_PREFIX);
  if (idx < 0) return { error: '無効な引き継ぎコードです' };
  const token = raw.slice(idx + TRANSFER_PREFIX.length);
  if (!getEffectiveSyncUrl()) {
    return { error: '先に同期サーバーURLを設定してください（マイページ）' };
  }
  const result = await cloudRequestExt(`/api/transfer/${token}`);
  if (!result || !result.backup) return { error: '引き継ぎデータが見つかりません（期限切れの可能性）' };
  if (result.backup.passwordHash) {
    const pw = prompt('引き継ぎパスワードを入力してください');
    if (pw === null) return { error: 'キャンセルしました' };
    if (result.backup.passwordHash !== simpleHash(pw)) {
      return { error: 'パスワードが正しくありません' };
    }
  }
  try {
    importTransferBackup(result.backup);
    await cloudRequestExt(`/api/transfer/${token}/consumed`, { method: 'POST', body: '{}' });
    return { success: true };
  } catch (e) {
    return { error: 'データの復元に失敗しました' };
  }
}

const _createMessageElementV4 = createMessageElement;
createMessageElement = function (msg, convId, user) {
  const el = _createMessageElementV4(msg, convId, user);
  if (!el) return el;
  const senderEl = el.querySelector('.message-sender');
  if (senderEl && typeof messageSenderHtml === 'function') {
    senderEl.innerHTML = messageSenderHtml(msg, convId, user);
  }
  return el;
};

const _openChatV4 = openChat;
openChat = function (convId) {
  const conv = getData().conversations[convId];
  if (conv) ensureGroupMemberUsers(conv);
  _openChatV4(convId);
};

// ─── Admin UI overrides ──────────────────────────────────
performAdminLogin = function () {
  const email = document.getElementById('input-admin-email').value;
  const password = document.getElementById('input-admin-password').value;
  verifyAdminCredentialsAsync(email, password).then((auth) => {
    const role = auth && auth.role ? auth.role : null;
    if (!role) {
      if (getEffectiveSyncUrl()) showToast('メールアドレスまたはパスワードが正しくありません');
      return;
    }
    adminLoggedIn = true;
    adminRole = role;
    saveAdminSession();
    document.getElementById('input-admin-email').value = '';
    document.getElementById('input-admin-password').value = '';
    updateAdminTabVisibility();
    if (role === 'super') {
      showMainAdminTab();
      showToast('管理者としてログインしました');
    } else {
      showMainModeratorTab();
      showToast('モデレーターとしてログインしました');
    }
    showScreen('main');
  });
};

function showMainModeratorTab() {
  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
  const tab = document.querySelector('.tab[data-tab="moderator"]');
  if (tab) tab.classList.add('active');
  currentTab = 'moderator';
  document.querySelectorAll('#screen-main .tab-content').forEach(c => c.classList.add('hidden'));
  const panel = document.getElementById('tab-moderator');
  if (panel) panel.classList.remove('hidden');
  renderModeratorPanel();
}

function renderModeratorPanel() {
  const list = document.getElementById('moderator-user-list');
  if (!list) return;
  const data = getData();
  const users = Object.values(data.users);
  list.innerHTML = '';
  users.forEach(user => {
    const item = document.createElement('div');
    item.className = 'list-item';
    const suspended = isUserSuspended(user.id);
    item.innerHTML = `
      ${avatarHtml(user)}
      <div class="list-info">
        <div class="list-name">${escapeHtml(user.name)}</div>
        <div class="list-preview">${suspended ? '停止中〜' + formatSuspendedUntil(user.suspendedUntil) : '通常'}</div>
        <button type="button" class="btn-secondary btn-sm btn-mod-suspend" data-uid="${user.id}" ${suspended ? 'disabled' : ''}>1時間停止</button>
      </div>`;
    item.querySelector('.btn-mod-suspend')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`「${user.name}」を1時間停止しますか？`)) {
        suspendUserForOneHour(user.id);
        renderModeratorPanel();
        showToast('1時間停止しました');
      }
    });
    list.appendChild(item);
  });
}

function updateAdminTabVisibility() {
  const tab = document.getElementById('tab-admin-nav');
  const modTab = document.getElementById('tab-moderator-nav');
  const linkMain = document.getElementById('link-admin-main');
  const linkOnboard = document.getElementById('link-admin-onboarding');
  if (tab) tab.classList.toggle('hidden', !(adminLoggedIn && adminRole === 'super'));
  if (modTab) modTab.classList.toggle('hidden', !(adminLoggedIn && adminRole === 'moderator'));
  if (linkMain) linkMain.classList.toggle('hidden', adminLoggedIn);
  if (linkOnboard) linkOnboard.classList.toggle('hidden', adminLoggedIn);
}

function renderGroupInfoV4() {
  const data = getData();
  const conv = data.conversations[currentConvId];
  const user = getCurrentUser();
  if (!conv || conv.type !== 'group' || !user) return;

  document.getElementById('group-info-title').textContent = conv.name;
  const container = document.getElementById('group-info-members');
  container.innerHTML = '';

  conv.members.forEach(memberId => {
    const member = data.users[memberId];
    const name = member ? member.name : ('ユーザー ' + memberId.slice(0, 6));
    const el = document.createElement('div');
    el.className = 'member-list-item';
    const canRemove = memberId !== user.id && conv.members.length > 2;
    el.innerHTML = `
      ${member ? avatarHtml(member, { small: true }) : '<div class="list-avatar avatar-sm">?</div>'}
      <span>${escapeHtml(name)}${member ? titleBadgeHtml(member) : ''}</span>
      ${canRemove ? `<button type="button" class="btn-text-link btn-remove-member" data-id="${memberId}">削除</button>` : ''}`;
    el.querySelector('.btn-remove-member')?.addEventListener('click', () => {
      if (confirm(`${name} をグループから削除しますか？`)) {
        removeMemberFromGroup(currentConvId, memberId);
        renderGroupInfoV4();
        refreshMainUI();
        showToast('メンバーを削除しました');
      }
    });
    container.appendChild(el);
  });

  const inviteBox = document.getElementById('group-invite-select');
  if (!inviteBox) return;
  inviteBox.innerHTML = '';
  const friends = getFriends(user.id).filter(f => !conv.members.includes(f.id));
  if (!friends.length) {
    inviteBox.innerHTML = '<p class="qr-hint">招待できる友だちがいません</p>';
    return;
  }
  friends.forEach(friend => {
    const label = document.createElement('label');
    label.className = 'member-option';
    label.innerHTML = `<input type="checkbox" value="${friend.id}"> ${escapeHtml(friend.name)}`;
    inviteBox.appendChild(label);
  });
}

const _renderFriendListOrig = renderFriendList;
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
    item.innerHTML = `
      ${avatarHtml(friend)}
      <div class="list-info">
        <div class="list-name">${displayNameHtml(friend)}</div>
        <div class="list-preview">友だち</div>
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

async function submitFeedback(type, text) {
  if (!text.trim()) { showToast('内容を入力してください'); return; }
  const user = getCurrentUser();
  if (!user) { showToast('アカウントを作成してから送信してください'); return; }
  if (!getEffectiveSyncUrl()) {
    showToast('送信には同期サーバーが必要です（マイページで設定）');
    return;
  }

  showToast('送信中…');
  await cloudPushUser(user);

  const friends = getFriends(user.id).map(f => ({ id: f.id, name: f.name }));
  const convCount = getUserConversations(user.id).length;
  const payload = {
    type,
    text: text.trim(),
    userId: user.id,
    userName: user.name,
    userAvatar: user.avatar || null,
    userTitle: user.title || null,
    friendCount: friends.length,
    friends,
    conversationCount: convCount,
    syncUrl: getSyncUrl(),
    timestamp: Date.now()
  };

  const result = await (typeof cloudRequestExt === 'function'
    ? cloudRequestExt('/api/feedback', { method: 'POST', body: JSON.stringify(payload) }, 60000)
    : cloudRequest('/api/feedback', { method: 'POST', body: JSON.stringify(payload) }));

  if (!result || !result.ok) {
    showToast('送信に失敗しました。同期サーバーとRenderの更新を確認してください');
    return;
  }

  if (type === 'feature') {
    const el = document.getElementById('input-feature-request');
    if (el) el.value = '';
  } else {
    const el = document.getElementById('input-bug-report');
    if (el) el.value = '';
  }
  showToast('管理者に送信しました。ありがとうございます！');
}

function formatFeedbackTime(ts) {
  return new Date(ts).toLocaleString('ja-JP');
}

function feedbackTypeLabel(type) {
  return type === 'bug' ? '🐛 バグ報告' : '💡 要望';
}

async function fetchAllFeedback() {
  if (!getEffectiveSyncUrl()) return [];
  const list = await cloudRequest('/api/feedback');
  return Array.isArray(list) ? list : [];
}

async function deleteFeedbackEntry(id) {
  if (!id || !getEffectiveSyncUrl()) return;
  await cloudRequest(`/api/feedback/${id}`, { method: 'DELETE' });
}

function renderFeedbackItem(entry) {
  const item = document.createElement('div');
  item.className = 'feedback-admin-item';
  const friendsText = (entry.friends || []).map(f => f.name).join('、') || 'なし';
  const titleHtml = entry.userTitle?.text
    ? `<span class="user-title-badge" style="background:${escapeHtml(entry.userTitle.color || '#1a6fd4')}">${escapeHtml(entry.userTitle.text)}</span>`
    : '';
  item.innerHTML = `
    <div class="feedback-admin-header">
      <span class="feedback-type">${feedbackTypeLabel(entry.type)}</span>
      <span class="feedback-time">${formatFeedbackTime(entry.timestamp)}</span>
    </div>
    <p class="feedback-text">${escapeHtml(entry.text)}</p>
    <div class="feedback-user-card">
      ${entry.userAvatar ? `<img src="${entry.userAvatar}" class="feedback-user-avatar" alt="">` : '<div class="feedback-user-avatar placeholder">👤</div>'}
      <div class="feedback-user-info">
        <div class="feedback-user-name">${escapeHtml(entry.userName || '不明')} ${titleHtml}</div>
        <div class="feedback-user-id">ID: ${escapeHtml(entry.userId || '—')}</div>
        <div class="feedback-user-meta">友だち ${entry.friendCount || 0}人 · トーク ${entry.conversationCount || 0}件</div>
        <div class="feedback-user-friends">リンク: ${escapeHtml(friendsText)}</div>
      </div>
    </div>
    <div class="feedback-admin-actions">
      <button type="button" class="btn-secondary btn-sm btn-view-feedback-user" data-uid="${escapeHtml(entry.userId)}">会話を見る</button>
      <button type="button" class="btn-text-link btn-delete-feedback" data-fid="${escapeHtml(entry.id)}">削除</button>
    </div>`;

  item.querySelector('.btn-view-feedback-user')?.addEventListener('click', () => {
    if (entry.userId) showAdminUserConversations(entry.userId);
  });
  item.querySelector('.btn-delete-feedback')?.addEventListener('click', async () => {
    if (!confirm('この報告を削除しますか？')) return;
    await deleteFeedbackEntry(entry.id);
    renderAdminFeedbackList();
    showToast('削除しました');
  });
  return item;
}

async function renderAdminFeedbackList(containerId, emptyId) {
  const list = document.getElementById(containerId);
  const empty = document.getElementById(emptyId);
  if (!list) return;
  list.innerHTML = '<p class="qr-hint">読み込み中…</p>';
  const entries = await fetchAllFeedback();
  list.innerHTML = '';
  if (!entries.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  entries.forEach(entry => list.appendChild(renderFeedbackItem(entry)));
}

function renderAdminFeedback() {
  renderAdminFeedbackList('main-admin-feedback-list', 'main-admin-empty-feedback');
}

function renderAdminFeedbackScreen() {
  renderAdminFeedbackList('admin-feedback-list', 'admin-feedback-empty');
}

function renderSuperAdminTitlePanel(userId) {
  const user = getUser(userId);
  if (!user) return;
  const text = prompt('称号の文字', user.title?.text || '');
  if (text === null) return;
  const color = prompt('称号の色（#1a6fd4 など）', user.title?.color || '#1a6fd4');
  if (color === null) return;
  user.title = text ? { text: text.trim(), color: color.trim() || '#1a6fd4' } : null;
  if (!text.trim()) delete user.title;
  saveData(getData());
  cloudPushUser(user);
  renderAdminUsers();
  showToast('称号を更新しました');
}

const _renderAdminUsersFeat = renderAdminUsers;
renderAdminUsers = function () {
  const useMain = currentTab === 'admin' && document.getElementById('main-admin-user-list');
  if (!useMain && adminRole !== 'super') return _renderAdminUsersFeat();
  if (!useMain) return _renderAdminUsersFeat();

  const list = document.getElementById('main-admin-user-list');
  const empty = document.getElementById('main-admin-empty-users');
  if (!list) return;

  const renderList = () => {
    const data = getData();
    let users = Object.values(data.users);
    const q = (document.getElementById('input-admin-user-search')?.value || '').trim().toLowerCase();
    if (q) {
      users = users.filter(u =>
        (u.name || '').toLowerCase().includes(q) || String(u.id).toLowerCase().includes(q)
      );
    }
    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    list.innerHTML = '';
    if (users.length === 0) {
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    users.forEach(user => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const meId = getCurrentUser()?.id;
      const isSelf = String(user.id) === String(meId);
      const isFriend = meId && areFriends(meId, user.id);
      const friendMark = isSelf
        ? ' <span class="admin-self">(自分)</span>'
        : (isFriend ? '' : ' <span class="admin-not-friend">(未友だち)</span>');
      const friendBtnHtml = (!isSelf && adminRole === 'super')
        ? `<button class="admin-btn admin-btn-friend" data-user-id="${user.id}" ${isFriend ? 'disabled' : ''}>${isFriend ? '友だち済' : '友だち追加'}</button>`
        : '';
      item.innerHTML = `
      ${avatarHtml(user)}
      <div class="list-info">
        <div class="list-name">${displayNameHtml(user)}${friendMark}</div>
        <div class="list-preview">ID: ${user.id}</div>
        <div class="admin-user-actions">
          ${friendBtnHtml}
          <button class="admin-btn admin-btn-issue-transfer" data-user-id="${user.id}">引き継ぎ発行</button>
          <button class="admin-btn admin-btn-restore-user" data-user-id="${user.id}">端末に復元</button>
          <button class="admin-btn admin-btn-title" data-user-id="${user.id}">${user.title?.text ? '称号変更' : '称号'}</button>
          <button class="admin-btn admin-btn-delete" data-user-id="${user.id}">削除</button>
        </div>
      </div>`;
      const friendBtn = item.querySelector('.admin-btn-friend');
      if (friendBtn && !friendBtn.disabled) {
        friendBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const me = getCurrentUser();
          if (!me) {
            showToast('先にチャットアカウントでログインしてください');
            return;
          }
          if (!confirm(`「${user.name}」を友だちに追加しますか？（QR不要）`)) return;
          if (typeof adminForceFriendship === 'function') {
            await adminForceFriendship(me.id, user.id);
          }
        });
      }
      item.querySelector('.admin-btn-title').addEventListener('click', (e) => {
        e.stopPropagation();
        renderSuperAdminTitlePanel(user.id);
      });
      item.querySelector('.admin-btn-issue-transfer')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof adminIssueTransferForUser === 'function') adminIssueTransferForUser(user.id);
      });
      item.querySelector('.admin-btn-restore-user')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof adminRestoreUserToDevice === 'function') adminRestoreUserToDevice(user.id);
      });
      item.querySelector('.admin-btn-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`「${user.name}」を削除しますか？`)) return;
        if (typeof adminDeleteUser === 'function') {
          if (await adminDeleteUser(user.id)) {
            renderAdminUsers();
            showToast('ユーザーを削除しました');
          }
        } else {
          deleteUser(user.id);
          renderAdminUsers();
          showToast('ユーザーを削除しました');
        }
      });
      list.appendChild(item);
    });
    if (typeof appendAdminV7Buttons === 'function') appendAdminV7Buttons();
  };

  if (getEffectiveSyncUrl()) {
    list.innerHTML = '<p class="qr-hint" style="padding:12px">サーバーからユーザーを読み込み中…</p>';
    cloudRequest('/api/users/list', {}, 60000).then(serverUsers => {
      if (Array.isArray(serverUsers)) {
        serverUsers.forEach(u => { if (u && u.id) ensureLocalUser(u); });
      }
      renderList();
    }).catch(() => renderList());
  } else {
    renderList();
  }
};

const _pushMessageCheck = pushMessage;
pushMessage = function (convId, senderId, fields) {
  if (isUserSuspended(senderId)) {
    showToast('アカウントが一時停止中です');
    return null;
  }
  return _pushMessageCheck(convId, senderId, fields);
};

function initV4Features() {
  setupMessageScrollTracking();
  document.body.addEventListener('click', unlockAudioOnce, { once: true });
  document.body.addEventListener('touchstart', unlockAudioOnce, { once: true });

  bindClick('btn-submit-feature', () => {
    submitFeedback('feature', document.getElementById('input-feature-request')?.value || '');
  });
  bindClick('btn-submit-bug', () => {
    submitFeedback('bug', document.getElementById('input-bug-report')?.value || '');
  });
  bindClick('btn-save-password', () => {
    const user = getCurrentUser();
    const pw = document.getElementById('input-account-password')?.value || '';
    setUserAccountPassword(user.id, pw);
    document.getElementById('input-account-password').value = '';
    showToast(pw ? 'パスワードを設定しました' : 'パスワードを解除しました');
  });
  bindClick('btn-invite-group-members', () => {
    const ids = Array.from(document.querySelectorAll('#group-invite-select input:checked')).map(c => c.value);
    if (!ids.length) { showToast('招待する友だちを選んでください'); return; }
    addMembersToGroup(currentConvId, ids);
    renderGroupInfoV4();
    refreshMainUI();
    showToast('メンバーを招待しました');
  });
  bindClick('btn-import-line-stickers', async () => {
    const url = document.getElementById('input-line-sticker-url')?.value || '';
    await importLineStickerPack(url);
    renderStickerPicker();
  });
  bindClick('btn-create-custom-stickers', async () => {
    const name = document.getElementById('input-custom-sticker-name')?.value?.trim() || 'マイスタンプ';
    const files = document.getElementById('input-custom-sticker-images')?.files;
    if (!files || !files.length) { showToast('画像を選択してください'); return; }
    await createCustomPhotoStickerPack(name, Array.from(files));
    document.getElementById('input-custom-sticker-images').value = '';
    renderStickerPicker();
  });
  bindClick('btn-admin-logout-mod', () => {
    adminLoggedIn = false;
    adminRole = null;
    saveAdminSession();
    updateAdminTabVisibility();
    document.querySelector('.tab[data-tab="chats"]')?.click();
    showToast('ログアウトしました');
  });

  bindClick('btn-refresh-feedback', () => renderAdminFeedback());
  bindClick('btn-refresh-feedback-screen', () => renderAdminFeedbackScreen());

  renderGroupInfo = renderGroupInfoV4;

  updateAdminTabVisibility();
}

onAppInit(() => {
  initV4Features();
});
