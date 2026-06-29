/**
 * BlueChat - LINE-like chat app (on-device, localStorage)
 */

const STORAGE_KEY = 'bluechat_data';
const ADMIN_EMAIL = 'd51498go@icloud.com';
const ADMIN_PASSWORD = 'D51498Go';
const CODE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// ─── State ───────────────────────────────────────────────
let currentScreen = 'onboarding';
let currentTab = 'chats';
let currentAdminTab = 'users';
let currentConvId = null;
let adminViewConvId = null;
let adminLoggedIn = false;
let returnScreenAfterAdmin = 'onboarding';

// ─── Data Layer ──────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return {
    currentUserId: null,
    users: {},
    friendCodes: {},
    friendships: [],
    conversations: {},
    messages: {}
  };
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getData() { return loadData(); }

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getUser(id) {
  const data = getData();
  return data.users[id] || null;
}

function getCurrentUser() {
  const data = getData();
  if (!data.currentUserId) return null;
  return data.users[data.currentUserId] || null;
}

function getInitial(name) {
  return (name || '?').charAt(0).toUpperCase();
}

function avatarHtml(user, opts = {}) {
  const { group = false, small = false } = opts;
  const classes = ['list-avatar'];
  if (group) classes.push('group');
  if (small) classes.push('avatar-sm');

  if (group) {
    return `<div class="${classes.join(' ')}">👥</div>`;
  }

  if (user && user.avatar) {
    return `<div class="${classes.join(' ')} has-image"><img src="${user.avatar}" alt="${escapeHtml(user.name)}"></div>`;
  }

  const name = user ? user.name : '?';
  return `<div class="${classes.join(' ')}">${getInitial(name)}</div>`;
}

function getConvAvatarUser(conv, currentUserId) {
  const data = getData();
  if (conv.type === 'group') return null;
  const otherId = conv.members.find(m => m !== currentUserId);
  return otherId ? data.users[otherId] : null;
}

function compressImage(file, maxSize = 256, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) {
            h = Math.round((h / w) * maxSize);
            w = maxSize;
          } else {
            w = Math.round((w / h) * maxSize);
            h = maxSize;
          }
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });
}

function setUserAvatar(userId, dataUrl) {
  const data = getData();
  if (!data.users[userId]) return false;
  data.users[userId].avatar = dataUrl;
  try {
    saveData(data);
    return true;
  } catch (e) {
    return false;
  }
}

function removeUserAvatar(userId) {
  const data = getData();
  if (!data.users[userId]) return;
  delete data.users[userId].avatar;
  saveData(data);
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨日';
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

function formatMessageTime(ts) {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function formatDateLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今日';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨日';
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── User Management ─────────────────────────────────────
function createUser(name) {
  const data = getData();
  const id = generateId();
  data.users[id] = {
    id,
    name: name.trim(),
    createdAt: Date.now()
  };
  data.currentUserId = id;
  saveData(data);
  return data.users[id];
}

function getFriends(userId) {
  const data = getData();
  const friends = new Set();
  data.friendships.forEach(f => {
    if (f.user1 === userId) friends.add(f.user2);
    if (f.user2 === userId) friends.add(f.user1);
  });
  return Array.from(friends).map(id => data.users[id]).filter(Boolean);
}

function areFriends(id1, id2) {
  const data = getData();
  return data.friendships.some(f =>
    (f.user1 === id1 && f.user2 === id2) || (f.user1 === id2 && f.user2 === id1)
  );
}

function addFriendship(id1, id2) {
  if (id1 === id2 || areFriends(id1, id2)) return null;
  const data = getData();
  data.friendships.push({ user1: id1, user2: id2, createdAt: Date.now() });
  const convId = getOrCreateDirectConv(id1, id2);
  saveData(data);
  return convId;
}

// ─── Friend Codes ────────────────────────────────────────
function createFriendCode(userId) {
  const data = getData();
  // Remove old codes for this user
  Object.keys(data.friendCodes).forEach(code => {
    if (data.friendCodes[code].userId === userId) delete data.friendCodes[code];
  });
  const code = generateCode();
  data.friendCodes[code] = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + CODE_EXPIRY_MS
  };
  saveData(data);
  return code;
}

function redeemFriendCode(code, currentUserId) {
  const data = getData();
  const entry = data.friendCodes[code.toUpperCase()];
  if (!entry) return { error: 'パスワードが見つかりません' };
  if (Date.now() > entry.expiresAt) {
    delete data.friendCodes[code.toUpperCase()];
    saveData(data);
    return { error: 'パスワードの有効期限が切れています' };
  }
  if (entry.userId === currentUserId) return { error: '自分のパスワードは使えません' };
  const targetUser = data.users[entry.userId];
  if (!targetUser) return { error: 'ユーザーが見つかりません' };
  if (areFriends(currentUserId, entry.userId)) return { error: 'すでに友だちです' };

  addFriendship(currentUserId, entry.userId);
  delete data.friendCodes[code.toUpperCase()];
  saveData(data);
  return { success: true, user: targetUser };
}

function cleanExpiredCodes() {
  const data = getData();
  let changed = false;
  Object.keys(data.friendCodes).forEach(code => {
    if (Date.now() > data.friendCodes[code].expiresAt) {
      delete data.friendCodes[code];
      changed = true;
    }
  });
  if (changed) saveData(data);
}

// ─── Conversations ───────────────────────────────────────
function getOrCreateDirectConv(id1, id2) {
  const data = getData();
  const members = [id1, id2].sort();
  const existing = Object.values(data.conversations).find(c =>
    c.type === 'direct' &&
    c.members.length === 2 &&
    c.members.slice().sort().join() === members.join()
  );
  if (existing) return existing.id;

  const convId = generateId();
  data.conversations[convId] = {
    id: convId,
    type: 'direct',
    members: [id1, id2],
    createdAt: Date.now(),
    lastMessageAt: null,
    lastMessagePreview: null
  };
  data.messages[convId] = [];
  saveData(data);
  return convId;
}

function createGroup(name, creatorId, memberIds) {
  const data = getData();
  const allMembers = [...new Set([creatorId, ...memberIds])];
  const convId = generateId();
  data.conversations[convId] = {
    id: convId,
    type: 'group',
    name: name.trim(),
    members: allMembers,
    createdBy: creatorId,
    createdAt: Date.now(),
    lastMessageAt: null,
    lastMessagePreview: null
  };
  data.messages[convId] = [];
  saveData(data);
  return convId;
}

function getUserConversations(userId) {
  const data = getData();
  return Object.values(data.conversations)
    .filter(c => c.members.includes(userId))
    .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
}

function getConvDisplayName(conv, userId) {
  const data = getData();
  if (conv.type === 'group') return conv.name;
  const otherId = conv.members.find(m => m !== userId);
  const other = data.users[otherId];
  return other ? other.name : '不明';
}

function leaveGroup(convId, userId) {
  const data = getData();
  const conv = data.conversations[convId];
  if (!conv || conv.type !== 'group') return;
  conv.members = conv.members.filter(m => m !== userId);
  if (conv.members.length === 0) {
    delete data.conversations[convId];
    delete data.messages[convId];
  }
  saveData(data);
}

// ─── Messages ────────────────────────────────────────────
function sendMessage(convId, senderId, text) {
  const data = getData();
  const conv = data.conversations[convId];
  if (!conv) return null;
  const msg = {
    id: generateId(),
    senderId,
    text: text.trim(),
    timestamp: Date.now()
  };
  if (!data.messages[convId]) data.messages[convId] = [];
  data.messages[convId].push(msg);
  conv.lastMessageAt = msg.timestamp;
  conv.lastMessagePreview = text.trim().slice(0, 50);
  saveData(data);
  return msg;
}

function getMessages(convId) {
  const data = getData();
  return data.messages[convId] || [];
}

// ─── Admin ───────────────────────────────────────────────
function deleteUser(userId) {
  const data = getData();
  delete data.users[userId];
  data.friendships = data.friendships.filter(f => f.user1 !== userId && f.user2 !== userId);
  Object.keys(data.friendCodes).forEach(code => {
    if (data.friendCodes[code].userId === userId) delete data.friendCodes[code];
  });
  Object.keys(data.conversations).forEach(convId => {
    const conv = data.conversations[convId];
    conv.members = conv.members.filter(m => m !== userId);
    if (conv.members.length === 0) {
      delete data.conversations[convId];
      delete data.messages[convId];
    }
  });
  if (data.currentUserId === userId) data.currentUserId = null;
  saveData(data);
}

function resetAllData() {
  localStorage.removeItem(STORAGE_KEY);
}

// ─── UI Helpers ──────────────────────────────────────────
function showToast(msg, duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.add('hidden');
    s.classList.remove('active');
  });
  const screen = document.getElementById('screen-' + name);
  if (screen) {
    screen.classList.remove('hidden');
    screen.classList.add('active');
  }
  currentScreen = name;
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function hideAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

// ─── Render Functions ────────────────────────────────────
function renderChatList() {
  const user = getCurrentUser();
  if (!user) return;
  const convs = getUserConversations(user.id);
  const list = document.getElementById('chat-list');
  const empty = document.getElementById('chat-list-empty');
  list.innerHTML = '';

  if (convs.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  convs.forEach(conv => {
    const name = getConvDisplayName(conv, user.id);
    const isGroup = conv.type === 'group';
    const avatarUser = isGroup ? null : getConvAvatarUser(conv, user.id);
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      ${avatarHtml(avatarUser, { group: isGroup })}
      <div class="list-info">
        <div class="list-name">${escapeHtml(name)}</div>
        <div class="list-preview">${conv.lastMessagePreview ? escapeHtml(conv.lastMessagePreview) : 'メッセージはありません'}</div>
      </div>
      <div class="list-meta">
        ${conv.lastMessageAt ? `<div class="list-time">${formatTime(conv.lastMessageAt)}</div>` : ''}
      </div>
    `;
    item.addEventListener('click', () => openChat(conv.id));
    list.appendChild(item);
  });
}

function renderFriendList() {
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
        <div class="list-name">${escapeHtml(friend.name)}</div>
        <div class="list-preview">友だち</div>
      </div>
    `;
    item.addEventListener('click', () => {
      const convId = getOrCreateDirectConv(user.id, friend.id);
      openChat(convId);
    });
    list.appendChild(item);
  });
}

function renderProfile() {
  const user = getCurrentUser();
  if (!user) return;
  const avatarEl = document.getElementById('profile-avatar');
  avatarEl.classList.remove('has-image');
  avatarEl.innerHTML = '';
  if (user.avatar) {
    avatarEl.classList.add('has-image');
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = user.name;
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = getInitial(user.name);
  }
  document.getElementById('btn-remove-avatar').classList.toggle('hidden', !user.avatar);
  document.getElementById('profile-name').textContent = user.name;
  document.getElementById('profile-id').textContent = 'ID: ' + user.id;
}

function renderMessages(convId) {
  const user = getCurrentUser();
  const messages = getMessages(convId);
  const container = document.getElementById('messages-container');
  container.innerHTML = '';

  let lastDate = '';
  messages.forEach(msg => {
    const dateLabel = formatDateLabel(msg.timestamp);
    if (dateLabel !== lastDate) {
      lastDate = dateLabel;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${dateLabel}</span>`;
      container.appendChild(sep);
    }

    const isSent = msg.senderId === user.id;
    const data = getData();
    const conv = data.conversations[convId];
    const isGroup = conv && conv.type === 'group';

    const el = document.createElement('div');
    el.className = `message ${isSent ? 'sent' : 'received'}`;
    const sender = data.users[msg.senderId];
    el.innerHTML = `
      <div class="message-bubble">
        ${!isSent && isGroup ? `<div class="message-sender">${escapeHtml(sender ? sender.name : '不明')}</div>` : ''}
        ${escapeHtml(msg.text)}
      </div>
      <div class="message-meta">
        <span class="message-time">${formatMessageTime(msg.timestamp)}</span>
      </div>
    `;
    container.appendChild(el);
  });

  container.scrollTop = container.scrollHeight;
}

function openChat(convId) {
  const user = getCurrentUser();
  const data = getData();
  const conv = data.conversations[convId];
  if (!conv) return;

  currentConvId = convId;
  const name = getConvDisplayName(conv, user.id);
  document.getElementById('chat-title').textContent = name;

  const subtitle = document.getElementById('chat-subtitle');
  const infoBtn = document.getElementById('btn-chat-info');
  if (conv.type === 'group') {
    subtitle.textContent = `${conv.members.length}人のメンバー`;
    subtitle.classList.remove('hidden');
    infoBtn.classList.remove('hidden');
  } else {
    subtitle.classList.add('hidden');
    infoBtn.classList.add('hidden');
  }

  document.getElementById('input-message').value = '';
  document.getElementById('btn-send').disabled = true;
  renderMessages(convId);
  showScreen('chat');
}

function renderGroupMemberSelect() {
  const user = getCurrentUser();
  const friends = getFriends(user.id);
  const container = document.getElementById('group-member-select');
  container.innerHTML = '';

  if (friends.length === 0) {
    container.innerHTML = '<p style="padding:16px;color:#8b95a5;font-size:14px;">友だちがいません。先に友だちを追加してください。</p>';
    return;
  }

  friends.forEach(friend => {
    const label = document.createElement('label');
    label.className = 'member-option';
    label.innerHTML = `
      <input type="checkbox" value="${friend.id}">
      ${avatarHtml(friend, { small: true })}
      <span>${escapeHtml(friend.name)}</span>
    `;
    label.querySelector('input').addEventListener('change', updateCreateGroupBtn);
    container.appendChild(label);
  });
}

function updateCreateGroupBtn() {
  const name = document.getElementById('input-group-name').value.trim();
  const checked = document.querySelectorAll('#group-member-select input:checked');
  document.getElementById('btn-create-group').disabled = !name || checked.length === 0;
}

function renderGroupInfo() {
  const data = getData();
  const conv = data.conversations[currentConvId];
  if (!conv || conv.type !== 'group') return;

  document.getElementById('group-info-title').textContent = conv.name;
  const container = document.getElementById('group-info-members');
  container.innerHTML = '';

  conv.members.forEach(memberId => {
    const member = data.users[memberId];
    if (!member) return;
    const el = document.createElement('div');
    el.className = 'member-list-item';
    el.innerHTML = `
      ${avatarHtml(member, { small: true })}
      <span>${escapeHtml(member.name)}</span>
    `;
    container.appendChild(el);
  });
}

// ─── Admin Render ────────────────────────────────────────
function renderAdminUsers() {
  const data = getData();
  const users = Object.values(data.users);
  const list = document.getElementById('admin-user-list');
  const empty = document.getElementById('admin-user-empty');
  list.innerHTML = '';

  if (users.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  users.forEach(user => {
    const friends = getFriends(user.id);
    const convs = getUserConversations(user.id);
    const item = document.createElement('div');
    item.className = 'list-item';
    item.style.cursor = 'default';
    item.innerHTML = `
      ${avatarHtml(user)}
      <div class="list-info">
        <div class="list-name">${escapeHtml(user.name)}</div>
        <div class="list-preview">友だち ${friends.length}人 · トーク ${convs.length}件</div>
        <div class="admin-user-actions">
          <button class="admin-btn admin-btn-view" data-user-id="${user.id}">会話を見る</button>
          <button class="admin-btn admin-btn-delete" data-user-id="${user.id}">削除</button>
        </div>
      </div>
    `;
    item.querySelector('.admin-btn-view').addEventListener('click', (e) => {
      e.stopPropagation();
      showAdminUserConversations(user.id);
    });
    item.querySelector('.admin-btn-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`「${user.name}」を削除しますか？関連する会話も削除されます。`)) {
        deleteUser(user.id);
        renderAdminUsers();
        renderAdminConversations();
        showToast('ユーザーを削除しました');
      }
    });
    list.appendChild(item);
  });
}

function showAdminUserConversations(userId) {
  const data = getData();
  const user = data.users[userId];
  if (!user) return;

  document.querySelectorAll('[data-admin-tab]').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-admin-tab="conversations"]').classList.add('active');
  document.getElementById('admin-tab-users').classList.add('hidden');
  document.getElementById('admin-tab-conversations').classList.remove('hidden');
  currentAdminTab = 'conversations';

  const convs = getUserConversations(userId);
  const list = document.getElementById('admin-conv-list');
  const empty = document.getElementById('admin-conv-empty');
  list.innerHTML = '';

  if (convs.length === 0) {
    empty.classList.remove('hidden');
    empty.querySelector('p').textContent = `「${user.name}」の会話はありません`;
    return;
  }
  empty.classList.add('hidden');

  convs.forEach(conv => {
    const members = conv.members.map(id => {
      const u = data.users[id];
      return u ? u.name : '不明';
    }).join(', ');

    const item = document.createElement('div');
    item.className = 'list-item';
    const title = conv.type === 'group' ? conv.name : members.filter(n => n !== user.name).join(', ') || members.join(', ');
    item.innerHTML = `
      <div class="list-avatar ${conv.type === 'group' ? 'group' : ''}">${conv.type === 'group' ? '👥' : '💬'}</div>
      <div class="list-info">
        <div class="list-name">${escapeHtml(title)}</div>
        <div class="admin-conv-members">参加者: ${escapeHtml(members)}</div>
        <div class="list-preview">${conv.lastMessagePreview ? escapeHtml(conv.lastMessagePreview) : 'メッセージなし'}</div>
      </div>
      <div class="list-meta">
        ${conv.lastMessageAt ? `<div class="list-time">${formatTime(conv.lastMessageAt)}</div>` : ''}
      </div>
    `;
    item.addEventListener('click', () => openAdminChat(conv.id));
    list.appendChild(item);
  });
}

function renderAdminConversations() {
  const data = getData();
  const convs = Object.values(data.conversations)
    .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
  const list = document.getElementById('admin-conv-list');
  const empty = document.getElementById('admin-conv-empty');
  list.innerHTML = '';

  if (convs.length === 0) {
    empty.classList.remove('hidden');
    empty.querySelector('p').textContent = '会話がありません';
    return;
  }
  empty.classList.add('hidden');

  convs.forEach(conv => {
    const members = conv.members.map(id => {
      const u = data.users[id];
      return u ? u.name : '不明';
    }).join(', ');

    const item = document.createElement('div');
    item.className = 'list-item';
    const title = conv.type === 'group' ? conv.name : members.join(' ↔ ');
    item.innerHTML = `
      <div class="list-avatar ${conv.type === 'group' ? 'group' : ''}">${conv.type === 'group' ? '👥' : '💬'}</div>
      <div class="list-info">
        <div class="list-name">${escapeHtml(title)}</div>
        <div class="admin-conv-members">参加者: ${escapeHtml(members)}</div>
        <div class="list-preview">${conv.lastMessagePreview ? escapeHtml(conv.lastMessagePreview) : 'メッセージなし'}</div>
      </div>
      <div class="list-meta">
        ${conv.lastMessageAt ? `<div class="list-time">${formatTime(conv.lastMessageAt)}</div>` : ''}
      </div>
    `;
    item.addEventListener('click', () => openAdminChat(conv.id));
    list.appendChild(item);
  });
}

function openAdminChat(convId) {
  const data = getData();
  const conv = data.conversations[convId];
  if (!conv) return;

  adminViewConvId = convId;
  const members = conv.members.map(id => {
    const u = data.users[id];
    return u ? u.name : '不明';
  }).join(', ');

  const title = conv.type === 'group' ? conv.name : members.join(' ↔ ');
  document.getElementById('admin-chat-title').textContent = title;
  document.getElementById('admin-chat-subtitle').textContent = `参加者: ${members}`;

  const messages = getMessages(convId);
  const container = document.getElementById('admin-messages-container');
  container.innerHTML = '';

  let lastDate = '';
  messages.forEach(msg => {
    const dateLabel = formatDateLabel(msg.timestamp);
    if (dateLabel !== lastDate) {
      lastDate = dateLabel;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${dateLabel}</span>`;
      container.appendChild(sep);
    }

    const sender = data.users[msg.senderId];
    const el = document.createElement('div');
    el.className = 'message received';
    el.innerHTML = `
      <div class="message-bubble">
        <div class="message-sender">${escapeHtml(sender ? sender.name : '不明')}</div>
        ${escapeHtml(msg.text)}
      </div>
      <div class="message-meta">
        <span class="message-time">${formatMessageTime(msg.timestamp)}</span>
      </div>
    `;
    container.appendChild(el);
  });

  if (messages.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>メッセージはありません</p></div>';
  }

  container.scrollTop = container.scrollHeight;
  showScreen('admin-chat');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function refreshMainUI() {
  renderChatList();
  renderFriendList();
  renderProfile();
}

// ─── Event Handlers ──────────────────────────────────────
function init() {
  cleanExpiredCodes();

  const user = getCurrentUser();
  if (user) {
    showScreen('main');
    refreshMainUI();
  } else {
    showScreen('onboarding');
  }

  // Onboarding
  document.getElementById('btn-start').addEventListener('click', () => {
    const name = document.getElementById('input-name').value.trim();
    if (!name) { showToast('名前を入力してください'); return; }
    createUser(name);
    showScreen('main');
    refreshMainUI();
    showToast(`ようこそ、${name}さん！`);
  });

  document.getElementById('input-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-start').click();
  });

  // Tabs
  document.querySelectorAll('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      document.querySelectorAll('#screen-main .tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById('tab-' + currentTab).classList.remove('hidden');
    });
  });

  // Add friend
  document.getElementById('btn-add-friend').addEventListener('click', () => {
    document.getElementById('input-friend-code').value = '';
    document.getElementById('generated-code-display').classList.add('hidden');
    showModal('modal-add-friend');
  });

  document.getElementById('btn-generate-code').addEventListener('click', () => {
    showModal('modal-add-friend');
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.modal-tab[data-modal-tab="generate"]').classList.add('active');
    document.getElementById('modal-tab-enter').classList.add('hidden');
    document.getElementById('modal-tab-generate').classList.remove('hidden');
  });

  // Modal tabs
  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('modal-tab-enter').classList.toggle('hidden', tab.dataset.modalTab !== 'enter');
      document.getElementById('modal-tab-generate').classList.toggle('hidden', tab.dataset.modalTab !== 'generate');
    });
  });

  document.getElementById('btn-submit-code').addEventListener('click', () => {
    const code = document.getElementById('input-friend-code').value.trim();
    if (!code) { showToast('パスワードを入力してください'); return; }
    const user = getCurrentUser();
    const result = redeemFriendCode(code, user.id);
    if (result.error) { showToast(result.error); return; }
    hideModal('modal-add-friend');
    refreshMainUI();
    showToast(`${result.user.name}さんと友だちになりました！`);
  });

  document.getElementById('btn-generate-new-code').addEventListener('click', () => {
    const user = getCurrentUser();
    const code = createFriendCode(user.id);
    document.getElementById('generated-code-text').textContent = code;
    document.getElementById('generated-code-display').classList.remove('hidden');
    showToast('パスワードを発行しました');
  });

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = document.getElementById('generated-code-text').textContent;
    navigator.clipboard.writeText(code).then(() => showToast('コピーしました'));
  });

  // Close modals
  document.querySelectorAll('.btn-close-modal, .modal-backdrop').forEach(el => {
    el.addEventListener('click', () => hideAllModals());
  });

  // Group
  document.getElementById('btn-new-group').addEventListener('click', () => {
    document.getElementById('input-group-name').value = '';
    renderGroupMemberSelect();
    document.getElementById('btn-create-group').disabled = true;
    showModal('modal-create-group');
  });

  document.getElementById('input-group-name').addEventListener('input', updateCreateGroupBtn);

  document.getElementById('btn-create-group').addEventListener('click', () => {
    const name = document.getElementById('input-group-name').value.trim();
    const memberIds = Array.from(document.querySelectorAll('#group-member-select input:checked')).map(c => c.value);
    const user = getCurrentUser();
    const convId = createGroup(name, user.id, memberIds);
    hideModal('modal-create-group');
    refreshMainUI();
    openChat(convId);
    showToast('グループを作成しました');
  });

  document.getElementById('btn-chat-info').addEventListener('click', () => {
    renderGroupInfo();
    showModal('modal-group-info');
  });

  document.getElementById('btn-leave-group').addEventListener('click', () => {
    if (!confirm('グループを退出しますか？')) return;
    const user = getCurrentUser();
    leaveGroup(currentConvId, user.id);
    hideAllModals();
    currentConvId = null;
    showScreen('main');
    refreshMainUI();
    showToast('グループを退出しました');
  });

  // Chat
  document.getElementById('btn-back-chat').addEventListener('click', () => {
    currentConvId = null;
    showScreen('main');
    refreshMainUI();
  });

  const msgInput = document.getElementById('input-message');
  const sendBtn = document.getElementById('btn-send');

  msgInput.addEventListener('input', () => {
    sendBtn.disabled = !msgInput.value.trim();
  });

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && msgInput.value.trim()) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  sendBtn.addEventListener('click', () => {
    const text = msgInput.value.trim();
    if (!text || !currentConvId) return;
    const user = getCurrentUser();
    sendMessage(currentConvId, user.id, text);
    msgInput.value = '';
    sendBtn.disabled = true;
    renderMessages(currentConvId);
  });

  // Profile image
  const avatarInput = document.getElementById('input-avatar');

  document.getElementById('btn-change-avatar').addEventListener('click', () => {
    avatarInput.click();
  });

  document.getElementById('profile-avatar').addEventListener('click', () => {
    avatarInput.click();
  });

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    avatarInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('画像ファイルを選択してください');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast('10MB以下の画像を選択してください');
      return;
    }
    try {
      const dataUrl = await compressImage(file);
      const user = getCurrentUser();
      if (!setUserAvatar(user.id, dataUrl)) {
        showToast('保存に失敗しました。画像サイズを小さくしてください');
        return;
      }
      renderProfile();
      refreshMainUI();
      showToast('プロフィール画像を設定しました');
    } catch (e) {
      showToast('画像の読み込みに失敗しました');
    }
  });

  document.getElementById('btn-remove-avatar').addEventListener('click', () => {
    const user = getCurrentUser();
    removeUserAvatar(user.id);
    renderProfile();
    refreshMainUI();
    showToast('プロフィール画像を削除しました');
  });

  // Reset data
  document.getElementById('btn-reset-data').addEventListener('click', () => {
    if (!confirm('このデバイスのすべてのデータを削除しますか？元に戻せません。')) return;
    resetAllData();
    showScreen('onboarding');
    document.getElementById('input-name').value = '';
    showToast('データをリセットしました');
  });

  // Admin links
  document.getElementById('link-admin-onboarding').addEventListener('click', (e) => {
    e.preventDefault();
    returnScreenAfterAdmin = 'onboarding';
    showScreen('admin-login');
  });

  document.getElementById('link-admin-main').addEventListener('click', (e) => {
    e.preventDefault();
    returnScreenAfterAdmin = 'main';
    showScreen('admin-login');
  });

  document.getElementById('btn-admin-back').addEventListener('click', () => {
    showScreen(returnScreenAfterAdmin);
  });

  document.getElementById('btn-admin-login').addEventListener('click', () => {
    const email = document.getElementById('input-admin-email').value.trim();
    const password = document.getElementById('input-admin-password').value;
    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      adminLoggedIn = true;
      document.getElementById('input-admin-email').value = '';
      document.getElementById('input-admin-password').value = '';
      renderAdminUsers();
      renderAdminConversations();
      showScreen('admin');
      showToast('管理者としてログインしました');
    } else {
      showToast('メールアドレスまたはパスワードが正しくありません');
    }
  });

  document.getElementById('input-admin-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-admin-login').click();
  });

  document.getElementById('btn-admin-exit').addEventListener('click', () => {
    adminLoggedIn = false;
    showScreen(returnScreenAfterAdmin);
    if (returnScreenAfterAdmin === 'main') refreshMainUI();
  });

  // Admin tabs
  document.querySelectorAll('[data-admin-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-admin-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentAdminTab = tab.dataset.adminTab;
      document.getElementById('admin-tab-users').classList.toggle('hidden', currentAdminTab !== 'users');
      document.getElementById('admin-tab-conversations').classList.toggle('hidden', currentAdminTab !== 'conversations');
      if (currentAdminTab === 'users') renderAdminUsers();
      if (currentAdminTab === 'conversations') renderAdminConversations();
    });
  });

  document.getElementById('btn-admin-chat-back').addEventListener('click', () => {
    adminViewConvId = null;
    showScreen('admin');
  });
}

document.addEventListener('DOMContentLoaded', init);
