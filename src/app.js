'use strict';
/**
 * BlueChat app.js - clean rewrite
 * Single-file, no external dependencies, no global variable pollution.
 * All state in localStorage + synced to server via polling.
 */

// ── Config ──────────────────────────────────────────────────────────────────
const APP_VERSION = '2026-09-13-v2-ipad';
const DEFAULT_SYNC_URL = 'https://bluechat-sync.youheiapp.workers.dev';
const CALL_SERVERS = [
  'https://bluechat-call-1.youheiapp.workers.dev',
  'https://bluechat-call-2.youheiapp.workers.dev',
  'https://bluechat-call-3.youheiapp.workers.dev',
];

const STICKERS = ['😀','😂','😍','🥺','😎','🤔','😅','🎉','❤️','🔥',
  '👍','👏','🙏','💪','🤝','🌟','🎵','🍕','🐱','🐶',
  '💙','💬','🚀','🌈','⚡','💎','🏆','🎯','✨','💡'];

// ── Storage helpers ──────────────────────────────────────────────────────────
const LS = {
  get(k, def = null) {
    try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : def; } catch { return def; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ── ID generator ──────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Escape HTML ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Format time ───────────────────────────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'});
  if (diffDays === 1) return '昨日';
  if (diffDays < 7) return ['日','月','火','水','木','金','土'][d.getDay()] + '曜';
  return `${d.getMonth()+1}/${d.getDate()}`;
}

function fmtMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'});
}

function fmtDateLabel(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}

// ── Toast ──────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

// ── Screen navigation ─────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.add('hidden');
    s.classList.remove('active');
  });
  const s = document.getElementById('screen-' + name);
  if (s) { s.classList.remove('hidden'); s.classList.add('active'); }
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('hidden');
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('hidden');
}

// ── User data ─────────────────────────────────────────────────────────────────
function getCurrentUser() { return LS.get('bluechat_me', null); }
function saveCurrentUser(u) { LS.set('bluechat_me', u); }

function getUsers() { return LS.get('bluechat_users', {}); }
function saveUsers(u) { LS.set('bluechat_users', u); }

function getConversations() { return LS.get('bluechat_conversations', {}); }
function saveConversations(c) { LS.set('bluechat_conversations', c); }

function getMessages(convId) { return LS.get(`bluechat_msgs_${convId}`, {}); }
function saveMessages(convId, msgs) { LS.set(`bluechat_msgs_${convId}`, msgs); }

function getFriendships() { return LS.get('bluechat_friendships', {}); }
function saveFriendships(f) { LS.set('bluechat_friendships', f); }

function getApiToken() { return LS.get('bluechat_api_token', null); }
function saveApiToken(t) { LS.set('bluechat_api_token', t); }

function getSyncUrl() { return LS.get('bluechat_sync_url', DEFAULT_SYNC_URL) || DEFAULT_SYNC_URL; }
function saveSyncUrl(u) { LS.set('bluechat_sync_url', u); }

function getAdminToken() { return LS.get('bluechat_admin_token', null); }
function saveAdminToken(t) { LS.set('bluechat_admin_token', t); }

// ── Avatar helpers ────────────────────────────────────────────────────────────
function getInitial(name) {
  if (!name) return '?';
  const s = String(name).trim();
  for (const c of s) if (/\S/.test(c)) return c.toUpperCase();
  return '?';
}

function avatarHtml(user, size = 'avatar') {
  if (!user) return `<div class="${size}"><span class="avatar-text">?</span></div>`;
  const img = user.avatar ? `<img class="avatar-img" src="${esc(user.avatar)}" alt="">` : '';
  const initial = user.avatar ? '' : `<span class="avatar-text">${esc(getInitial(user.name))}</span>`;
  return `<div class="${size}" style="background:${userColor(user.id)}">${img}${initial}</div>`;
}

function userColor(id) {
  const colors = ['#0088CC','#00AABB','#0055AA','#0099DD','#1166BB','#0077CC','#0044AA','#0066BB'];
  let h = 0;
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + (id.charCodeAt(i))) & 0xFFFF;
  return colors[h % colors.length];
}

function renderAvatar(user, el, size = 'avatar') {
  if (!el) return;
  el.className = size;
  el.style.background = userColor(user?.id);
  el.innerHTML = '';
  if (user?.avatar) {
    const img = document.createElement('img');
    img.className = 'avatar-img';
    img.src = user.avatar;
    el.appendChild(img);
  } else {
    const sp = document.createElement('span');
    sp.className = 'avatar-text';
    sp.textContent = getInitial(user?.name);
    el.appendChild(sp);
  }
}

// ── API client ────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}, base = null, timeoutMs = 15000) {
  const url = (base || getSyncUrl()).replace(/\/$/, '') + path;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getApiToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, headers, signal: controller.signal });
    const data = await res.json();
    return data;
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(tid);
  }
}

async function apiGet(path, base) { return apiFetch(path, {}, base); }
async function apiPut(path, body, base) { return apiFetch(path, { method: 'PUT', body: JSON.stringify(body) }, base); }
async function apiPost(path, body, base) { return apiFetch(path, { method: 'POST', body: JSON.stringify(body) }, base); }
async function apiDelete(path, base) { return apiFetch(path, { method: 'DELETE' }, base); }

// Posts and chat data share one KV-backed source of truth. Randomly selecting
// separate Workers caused intermittent missing data and different auth state.
function randomPostServer() { return getSyncUrl(); }
function randomCallServer() { return CALL_SERVERS[0] || getSyncUrl(); }

// ── Auth / token ──────────────────────────────────────────────────────────────
async function ensureToken(userId) {
  const existing = getApiToken();
  if (existing) return existing;
  const data = await apiPost('/api/auth/claim-token', { userId });
  if (data?.ok && data.token) {
    saveApiToken(data.token);
    return data.token;
  }
  return null;
}

// ── Onboarding ────────────────────────────────────────────────────────────────
function initOnboarding() {
  const btn = document.getElementById('btn-start');
  const input = document.getElementById('input-username');
  if (!btn || !input) return;

  btn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) { toast('名前を入力してください'); return; }
    btn.disabled = true;
    btn.textContent = '接続中...';
    const userId = genId();
    const user = { id: userId, name, createdAt: Date.now() };
    saveCurrentUser(user);

    // register on server
    await ensureToken(userId);
    await apiPut(`/api/users/${userId}`, user);

    btn.disabled = false;
    btn.textContent = 'はじめる';
    startApp();
  });

  input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
}

// ── Main app startup ──────────────────────────────────────────────────────────
function startApp() {
  const me = getCurrentUser();
  if (!me) { showScreen('onboarding'); initOnboarding(); return; }
  showScreen('main');
  updateProfileUI();
  renderTalkList();
  renderFriendsList();
  renderMomentFeed();
  startSync();
  initCallPolling();
  checkInviteFromUrl();
}

// ── Tab navigation ────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-page').forEach(p => p.classList.add('hidden'));
      const page = document.getElementById('tab-' + tab);
      if (page) page.classList.remove('hidden');
      if (tab === 'moment') renderMomentFeed();
      if (tab === 'friends') renderFriendsList();
    });
  });
}

// ── Profile UI ────────────────────────────────────────────────────────────────
function updateProfileUI() {
  const me = getCurrentUser();
  if (!me) return;
  const nameEl = document.getElementById('my-display-name');
  const idEl = document.getElementById('my-user-id-display');
  const avatarWrap = document.getElementById('my-avatar-wrap');
  if (nameEl) nameEl.textContent = me.name;
  if (idEl) idEl.textContent = `ID: ${me.id}`;
  if (avatarWrap) renderAvatar(me, avatarWrap, 'avatar-lg');
}

// ── Conversations / Talk list ─────────────────────────────────────────────────
function getDirectConvId(a, b) { return [a, b].sort().join('_'); }

function renderTalkList() {
  const me = getCurrentUser();
  if (!me) return;
  const convs = getConversations();
  const users = getUsers();
  const list = document.getElementById('talk-list');
  const empty = document.getElementById('talk-empty');
  if (!list) return;

  const myConvs = Object.values(convs)
    .filter(c => c.participants && c.participants.includes(me.id))
    .sort((a, b) => (b.lastMsgTs || 0) - (a.lastMsgTs || 0));

  if (!myConvs.length) {
    list.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  list.innerHTML = myConvs.map(conv => {
    const otherId = conv.type === 'group' ? null :
      conv.participants.find(id => id !== me.id);
    const other = otherId ? (users[otherId] || { id: otherId, name: otherId }) : null;
    const name = conv.type === 'group' ? (conv.name || 'グループ') : (other?.name || '?');
    const preview = esc(conv.lastMsg || '');
    const time = fmtTime(conv.lastMsgTs);
    const unread = conv.unread?.[me.id] || 0;
    const initial = getInitial(name);
    const color = userColor(otherId || conv.id);
    const avatarContent = other?.avatar
      ? `<img class="avatar-img" src="${esc(other.avatar)}" alt="">`
      : `<span class="avatar-text">${esc(initial)}</span>`;
    return `<div class="talk-item" data-conv="${esc(conv.id)}">
      <div class="avatar" style="background:${color}">${avatarContent}</div>
      <div class="talk-info">
        <div class="talk-name">${esc(name)}</div>
        <div class="talk-preview">${preview}</div>
      </div>
      <div class="talk-meta">
        <div class="talk-time">${time}</div>
        ${unread > 0 ? `<div class="talk-unread">${unread}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.talk-item').forEach(item => {
    item.addEventListener('click', () => openChat(item.dataset.conv));
  });

  // update badge
  const totalUnread = myConvs.reduce((n, c) => n + (c.unread?.[me.id] || 0), 0);
  const badge = document.getElementById('badge-talks');
  if (badge) {
    badge.textContent = totalUnread;
    badge.classList.toggle('hidden', totalUnread === 0);
  }
}

// ── Open chat ─────────────────────────────────────────────────────────────────
let _currentConvId = null;
let _chatSyncTimer = null;

function openChat(convId) {
  _currentConvId = convId;
  const me = getCurrentUser();
  const convs = getConversations();
  const users = getUsers();
  const conv = convs[convId];
  if (!conv) return;

  const otherId = conv.type === 'group' ? null : conv.participants.find(id => id !== me.id);
  const other = otherId ? (users[otherId] || { id: otherId, name: otherId }) : null;
  const name = conv.type === 'group' ? (conv.name || 'グループ') : (other?.name || '?');

  // Update header
  document.getElementById('chat-header-name').textContent = name;
  document.getElementById('chat-header-status').textContent = '';

  const avatarEl = document.getElementById('chat-header-avatar');
  if (avatarEl) renderAvatar(other || { id: convId, name }, avatarEl, 'avatar-sm');

  // Store call target
  _callTargetUserId = otherId;

  showScreen('chat');
  renderMessages(convId);
  markRead(convId);

  // Start chat-specific sync
  if (_chatSyncTimer) clearInterval(_chatSyncTimer);
  _chatSyncTimer = setInterval(() => {
    syncConversation(convId);
    renderMessages(convId);
  }, 1500);
}

function closeChat() {
  if (_chatSyncTimer) { clearInterval(_chatSyncTimer); _chatSyncTimer = null; }
  _currentConvId = null;
  renderTalkList();
  showScreen('main');
}

// ── Render messages ───────────────────────────────────────────────────────────
function renderMessages(convId) {
  const me = getCurrentUser();
  const msgs = getMessages(convId);
  const users = getUsers();
  const convs = getConversations();
  const conv = convs[convId];
  const container = document.getElementById('messages-container');
  if (!container || !me) return;

  const sorted = Object.values(msgs).sort((a, b) => a.timestamp - b.timestamp);
  let lastDate = '';
  const html = sorted.map(msg => {
    const isSent = msg.senderId === me.id;
    const sender = users[msg.senderId] || { id: msg.senderId, name: '?' };
    const dateLabel = fmtDateLabel(msg.timestamp);
    let dateSep = '';
    if (dateLabel !== lastDate) {
      dateSep = `<div class="date-sep">${esc(dateLabel)}</div>`;
      lastDate = dateLabel;
    }
    const time = fmtMsgTime(msg.timestamp);
    const readMark = isSent ? `<span class="msg-read">既読</span>` : '';
    const senderName = (!isSent && conv?.type === 'group')
      ? `<div class="msg-sender-name">${esc(sender.name)}</div>` : '';

    let content = '';
    if (msg.type === 'image' || msg.image) {
      content = `<img class="msg-image" src="${esc(msg.image)}" alt="写真" data-src="${esc(msg.image)}">`;
    } else if (msg.type === 'sticker' || msg.sticker) {
      content = `<span class="msg-sticker">${esc(msg.sticker)}</span>`;
    } else {
      content = esc(msg.text || '');
    }

    const avatarPart = !isSent
      ? `<div class="avatar-sm" style="background:${userColor(sender.id)};margin-bottom:4px;">${sender.avatar ? `<img class="avatar-img" src="${esc(sender.avatar)}">` : `<span class="avatar-text">${esc(getInitial(sender.name))}</span>`}</div>`
      : '';

    return `${dateSep}
    <div class="msg-row ${isSent ? 'sent' : 'recv'}" data-msg-id="${esc(msg.id)}">
      ${!isSent ? avatarPart : ''}
      <div>
        ${senderName}
        <div style="display:flex;align-items:flex-end;gap:4px;${isSent?'flex-direction:row-reverse':''}">
          <div class="msg-bubble">${content}</div>
          <div class="msg-meta" style="flex-shrink:0">${time}<br>${readMark}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
  container.innerHTML = html;

  // bind image click
  container.querySelectorAll('.msg-image[data-src]').forEach(img => {
    img.addEventListener('click', () => openImageViewer(img.dataset.src));
  });

  if (wasAtBottom || sorted.length <= 3) {
    container.scrollTop = container.scrollHeight;
  }
}

// ── Send message ──────────────────────────────────────────────────────────────
async function sendMessage(convId, payload) {
  const me = getCurrentUser();
  if (!me || !convId) return;
  const msgId = genId();
  const msg = {
    id: msgId,
    convId,
    senderId: me.id,
    timestamp: Date.now(),
    ...payload,
  };

  // Save locally first for instant UI
  const msgs = getMessages(convId);
  msgs[msgId] = msg;
  saveMessages(convId, msgs);
  renderMessages(convId);

  // Update conversation
  const convs = getConversations();
  const conv = convs[convId] || {};
  conv.lastMsg = payload.text || (payload.type === 'image' ? '📷 写真' : '😊');
  conv.lastMsgTs = msg.timestamp;
  convs[convId] = conv;
  saveConversations(convs);

  // Push to server (fire and forget)
  apiPut(`/api/messages/${convId}/${msgId}`, msg).catch(() => {});
  apiPut(`/api/conversations/${convId}`, {
    ...conv,
    lastMsg: conv.lastMsg,
    lastMsgTs: conv.lastMsgTs,
  }).catch(() => {});
}

// ── Mark read ─────────────────────────────────────────────────────────────────
function markRead(convId) {
  const me = getCurrentUser();
  if (!me) return;
  const convs = getConversations();
  const conv = convs[convId];
  if (!conv) return;
  if (!conv.unread) conv.unread = {};
  conv.unread[me.id] = 0;
  saveConversations(convs);
  apiPut(`/api/reads/${convId}/${me.id}`, { lastRead: Date.now() }).catch(() => {});
  renderTalkList();
}

// ── Friends ───────────────────────────────────────────────────────────────────
function getFriends() {
  const me = getCurrentUser();
  if (!me) return [];
  const friendships = getFriendships();
  const users = getUsers();
  return Object.values(friendships)
    .filter(f => f.users.includes(me.id))
    .map(f => {
      const otherId = f.users.find(id => id !== me.id);
      return users[otherId] || null;
    })
    .filter(Boolean);
}

function renderFriendsList() {
  const me = getCurrentUser();
  if (!me) return;
  const friends = getFriends();
  const list = document.getElementById('friends-list');
  const empty = document.getElementById('friends-empty');
  if (!list) return;
  if (!friends.length) {
    list.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  list.innerHTML = friends.map(u => `
    <div class="friend-item" data-uid="${esc(u.id)}">
      <div class="avatar" style="background:${userColor(u.id)}">
        ${u.avatar ? `<img class="avatar-img" src="${esc(u.avatar)}">` : `<span class="avatar-text">${esc(getInitial(u.name))}</span>`}
      </div>
      <div class="friend-info">
        <div class="friend-name">${esc(u.name)}</div>
        ${u.title ? `<div class="friend-title">${esc(u.title)}</div>` : ''}
      </div>
      <div class="friend-actions">
        <button class="btn-friend-chat" data-uid="${esc(u.id)}" title="トーク">💬</button>
        <button class="btn-friend-call" data-uid="${esc(u.id)}" title="通話">📞</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('.btn-friend-chat').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      startDirectChat(btn.dataset.uid);
    });
  });
  list.querySelectorAll('.btn-friend-call').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      startCall(btn.dataset.uid, 'audio');
    });
  });
  list.querySelectorAll('.friend-item').forEach(item => {
    item.addEventListener('click', () => startDirectChat(item.dataset.uid));
  });
}

async function startDirectChat(otherId) {
  const me = getCurrentUser();
  if (!me || !otherId || otherId === me.id) return;
  const convId = getDirectConvId(me.id, otherId);
  const convs = getConversations();
  const users = getUsers();
  if (!convs[convId]) {
    const other = users[otherId] || { id: otherId, name: otherId };
    convs[convId] = {
      id: convId,
      type: 'direct',
      participants: [me.id, otherId],
      createdAt: Date.now(),
      lastMsgTs: 0,
    };
    saveConversations(convs);
    await apiPut(`/api/conversations/${convId}`, convs[convId]);
  }
  openChat(convId);
}

// ── Friend invite / QR ────────────────────────────────────────────────────────
function buildInvitePayload(user) {
  return btoa(JSON.stringify({ id: user.id, name: user.name, ts: Date.now() }));
}

function parseInvitePayload(str) {
  try { return JSON.parse(atob(str)); } catch { return null; }
}

function getInviteUrl(user) {
  const base = window.location.origin + window.location.pathname;
  return `${base}?invite=${buildInvitePayload(user)}`;
}

async function addFriend(invitePayload) {
  const me = getCurrentUser();
  if (!me) return false;
  const invite = parseInvitePayload(invitePayload);
  if (!invite || !invite.id || invite.id === me.id) { toast('無効な招待コードです'); return false; }

  // fetch their user data from server
  const data = await apiGet(`/api/users/${invite.id}`);
  const theirUser = data?.user || { id: invite.id, name: invite.name };
  const users = getUsers();
  users[invite.id] = theirUser;
  saveUsers(users);

  // save friendship locally and on server
  const key = [me.id, invite.id].sort().join(':');
  const friendships = getFriendships();
  if (friendships[key]) { toast(`${theirUser.name}はすでに友だちです`); return false; }
  friendships[key] = { users: [me.id, invite.id], ts: Date.now() };
  saveFriendships(friendships);

  await apiPut(`/api/friendships/${me.id}`, { friendId: invite.id });
  await apiPut(`/api/users/${me.id}`, getCurrentUser());

  toast(`${theirUser.name}を友だちに追加しました！`);
  renderFriendsList();
  return true;
}

function checkInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  if (invite) {
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
    addFriend(invite).then(ok => { if (ok) renderFriendsList(); });
  }
}

// ── QR code rendering ─────────────────────────────────────────────────────────
function renderMyQR() {
  const me = getCurrentUser();
  if (!me) return;
  const container = document.getElementById('my-qr-container');
  if (!container) return;
  const url = getInviteUrl(me);

  container.innerHTML = '';
  if (window.QRCode) {
    new QRCode(container, {
      text: url,
      width: 220,
      height: 220,
      colorDark: '#0A84FF',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } else {
    container.innerHTML = `<p style="word-break:break-all;font-size:12px;padding:12px;">${esc(url)}</p>`;
  }

  const linkEl = document.getElementById('my-invite-link-text');
  if (linkEl) linkEl.textContent = url;
}

// ── QR Camera Scanner ─────────────────────────────────────────────────────────
let _html5QrScanner = null;

async function startQrScanner() {
  const area = document.getElementById('qr-scanner-area');
  if (!area) return;
  if (!window.Html5QrcodeScanner && !window.Html5Qrcode) {
    area.innerHTML = '<p style="color:red;font-size:13px;padding:8px;">カメラライブラリが読み込まれていません</p>';
    return;
  }

  try {
    if (window.Html5QrcodeScanner) {
      _html5QrScanner = new Html5QrcodeScanner('qr-scanner-area', {
        fps: 10,
        qrbox: { width: 240, height: 240 },
        rememberLastUsedCamera: true,
      }, false);
      _html5QrScanner.render(
        (text) => {
          stopQrScanner();
          handleScannedCode(text);
        },
        (error) => { /* ignore scan errors */ }
      );
    }
  } catch (e) {
    area.innerHTML = `<p style="color:red;font-size:13px;padding:8px;">カメラエラー: ${esc(e.message)}</p>`;
  }
}

function stopQrScanner() {
  if (_html5QrScanner) {
    try { _html5QrScanner.clear(); } catch {}
    _html5QrScanner = null;
  }
  if (window.Html5Qrcode) {
    // cleanup any running scanner
  }
}

async function handleScannedCode(text) {
  // Try as invite URL
  let code = text;
  try {
    const u = new URL(text);
    const inv = u.searchParams.get('invite');
    if (inv) code = inv;
  } catch {}

  const ok = await addFriend(code);
  if (ok) {
    closeModal('modal-add-friend');
    renderFriendsList();
  }
}

async function scanFromImageFile(file) {
  if (!file || !window.Html5Qrcode) return;
  const tmpId = 'qr-file-scan-tmp';
  let div = document.getElementById(tmpId);
  if (!div) { div = document.createElement('div'); div.id = tmpId; div.style.display = 'none'; document.body.appendChild(div); }
  try {
    const html5qr = new Html5Qrcode(tmpId);
    const result = await html5qr.scanFile(file, false);
    await html5qr.clear();
    handleScannedCode(result);
  } catch {
    toast('QRコードが読み取れませんでした');
  }
}

// ── Sync engine ───────────────────────────────────────────────────────────────
let _syncTimer = null;
let _lastSyncVersion = 0;
let _syncing = false;

async function syncConversation(convId) {
  const since = LS.get(`bluechat_msgs_since_${convId}`, 0);
  const data = await apiGet(`/api/messages/${convId}?since=${since}`);
  if (!data?.messages) return;
  const msgs = getMessages(convId);
  let changed = false;
  for (const [id, msg] of Object.entries(data.messages)) {
    if (!msgs[id] || msg.timestamp > (msgs[id]?.timestamp || 0)) {
      msgs[id] = msg;
      changed = true;
    }
  }
  if (changed) {
    saveMessages(convId, msgs);
    LS.set(`bluechat_msgs_since_${convId}`, Date.now());
    if (_currentConvId === convId) renderMessages(convId);
  }
}

async function syncAllConversations() {
  if (_syncing) return;
  _syncing = true;
  try {
    const me = getCurrentUser();
    if (!me) return;

    // Sync users
    const usersData = await apiGet('/api/users/list');
    if (usersData?.users) {
      const local = getUsers();
      for (const [id, u] of Object.entries(usersData.users)) {
        if (!local[id] || u.updatedAt > (local[id]?.updatedAt || 0)) local[id] = u;
      }
      saveUsers(local);
    }

    // Sync conversations
    const convData = await apiGet(`/api/user/${me.id}/conversations`);
    if (convData?.conversations) {
      const local = getConversations();
      for (const [id, c] of Object.entries(convData.conversations)) {
        if (!local[id] || c.lastMsgTs > (local[id]?.lastMsgTs || 0)) local[id] = c;
      }
      saveConversations(local);
    }

    // Sync friendships
    const fsData = await apiGet(`/api/user/${me.id}/friendships`);
    if (fsData?.friendships) {
      const local = getFriendships();
      for (const [k, v] of Object.entries(fsData.friendships)) {
        if (!local[k]) local[k] = v;
      }
      saveFriendships(local);
    }

    // Sync messages for current conv
    if (_currentConvId) await syncConversation(_currentConvId);

    renderTalkList();
    renderFriendsList();

  } finally {
    _syncing = false;
  }
}

function startSync() {
  ensureToken(getCurrentUser()?.id);
  syncAllConversations();
  _syncTimer = setInterval(syncAllConversations, 5000);
}

// ── Moment (BlueMoment posts) ─────────────────────────────────────────────────
async function renderMomentFeed() {
  const me = getCurrentUser();
  if (!me) return;
  const feed = document.getElementById('moment-feed');
  const empty = document.getElementById('moment-empty');
  if (!feed) return;

  const data = await apiGet('/api/posts', randomPostServer());
  const posts = data?.posts || [];

  if (!posts.length) {
    feed.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  const users = getUsers();
  feed.innerHTML = posts.map(post => {
    const user = users[post.userId] || { id: post.userId, name: '?' };
    const likes = (post.likes || []).length;
    const dislikes = (post.dislikes || []).length;
    const myLike = (post.likes || []).includes(me.id);
    const myDislike = (post.dislikes || []).includes(me.id);
    const comments = (post.comments || []).map(c => {
      const cu = users[c.userId] || { name: '?' };
      return `<div class="post-comment">
        <div class="post-comment-user">${esc(cu.name)}</div>
        <div class="post-comment-text">${esc(c.text)}</div>
      </div>`;
    }).join('');

    return `<div class="post-card" data-post-id="${esc(post.id)}">
      <div class="post-header">
        <div class="avatar-sm" style="background:${userColor(user.id)}">${user.avatar ? `<img class="avatar-img" src="${esc(user.avatar)}">` : `<span class="avatar-text">${esc(getInitial(user.name))}</span>`}</div>
        <div style="flex:1">
          <div class="post-user-name">${esc(user.name)}</div>
        </div>
        <div class="post-time">${fmtTime(post.timestamp)}</div>
      </div>
      <div class="post-body">
        ${post.text ? `<div class="post-text">${esc(post.text)}</div>` : ''}
        ${post.image ? `<img class="post-image" src="${esc(post.image)}" alt="" data-src="${esc(post.image)}">` : ''}
      </div>
      <div class="post-actions">
        <button class="post-action-btn ${myLike?'active':''}" data-action="like" data-post="${esc(post.id)}">👍 ${likes}</button>
        <button class="post-action-btn ${myDislike?'active':''}" data-action="dislike" data-post="${esc(post.id)}">👎 ${dislikes}</button>
        <button class="post-action-btn" data-action="comment" data-post="${esc(post.id)}">💬 ${(post.comments||[]).length}</button>
        ${post.userId === me.id ? `<button class="post-action-btn" data-action="delete" data-post="${esc(post.id)}" style="margin-left:auto">🗑</button>` : ''}
      </div>
      ${comments ? `<div class="post-comments">${comments}</div>` : ''}
      <div class="post-comment-input-row">
        <input class="post-comment-input" placeholder="コメントを入力..." data-post="${esc(post.id)}">
        <button class="post-comment-send" data-post="${esc(post.id)}">送信</button>
      </div>
    </div>`;
  }).join('');

  // Bind events
  feed.querySelectorAll('[data-action="like"],[data-action="dislike"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const postId = btn.dataset.post;
      const action = btn.dataset.action;
      const post = posts.find(p => p.id === postId);
      const current = action === 'like'
        ? (post?.likes||[]).includes(me.id) ? null : 'like'
        : (post?.dislikes||[]).includes(me.id) ? null : 'dislike';
      await apiPut(`/api/posts/${postId}/vote`, { userId: me.id, vote: current }, randomPostServer());
      renderMomentFeed();
    });
  });

  feed.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('この投稿を削除しますか？')) return;
      await apiDelete(`/api/posts/${btn.dataset.post}`, randomPostServer());
      renderMomentFeed();
    });
  });

  feed.querySelectorAll('.post-comment-send').forEach(btn => {
    btn.addEventListener('click', async () => {
      const postId = btn.dataset.post;
      const input = feed.querySelector(`.post-comment-input[data-post="${postId}"]`);
      const text = input?.value.trim();
      if (!text) return;
      input.value = '';
      await apiPost(`/api/posts/${postId}/comments`, { userId: me.id, text }, randomPostServer());
      renderMomentFeed();
    });
  });

  feed.querySelectorAll('.post-image[data-src]').forEach(img => {
    img.addEventListener('click', () => openImageViewer(img.dataset.src));
  });
}

// ── Image viewer ──────────────────────────────────────────────────────────────
function openImageViewer(src) {
  const img = document.getElementById('image-viewer-img');
  if (img) img.src = src;
  openModal('modal-image-viewer');
}

// ── Image compression ─────────────────────────────────────────────────────────
function compressImage(file, maxPx = 1280, quality = 0.8) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── WebRTC calling ────────────────────────────────────────────────────────────
let _pc = null;
let _localStream = null;
let _callType = null;
let _callTargetUserId = null;
let _callPollingTimer = null;
let _incomingOffer = null;
let _audioCtx = null;
let _callMuted = false;

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function showCallUI(name, status, isIncoming = false) {
  const overlay = document.getElementById('call-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  document.getElementById('call-name').textContent = name;
  document.getElementById('call-status').textContent = status;

  const answerBtn = document.getElementById('btn-call-answer');
  const endBtn = document.getElementById('btn-call-end');
  const muteBtn = document.getElementById('btn-call-mute');

  if (answerBtn) answerBtn.classList.toggle('hidden', !isIncoming);
  if (endBtn) endBtn.classList.remove('hidden');
  if (muteBtn) muteBtn.classList.remove('hidden');
}

function hideCallUI() {
  const overlay = document.getElementById('call-overlay');
  if (overlay) overlay.classList.add('hidden');
  const vr = document.getElementById('video-remote');
  const vl = document.getElementById('video-local');
  if (vr) { vr.srcObject = null; vr.classList.add('hidden'); }
  if (vl) { vl.srcObject = null; vl.classList.add('hidden'); }
}

async function sendCallSignal(toUserId, type, data) {
  const me = getCurrentUser();
  if (!me) return;
  const server = randomCallServer();
  await apiPost('/api/call/signal', { to: toUserId, from: me.id, type, data }, server);
}

async function startCall(targetUserId, callType = 'audio') {
  const me = getCurrentUser();
  const users = getUsers();
  const target = users[targetUserId] || { id: targetUserId, name: '?' };
  if (!me || !targetUserId) return;

  _callType = callType;
  _callTargetUserId = targetUserId;

  // Init AudioContext on user gesture
  try { getAudioCtx(); } catch {}

  // Get media
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    });
  } catch (e) {
    toast('マイク/カメラへのアクセスが必要です');
    return;
  }

  if (callType === 'video') {
    const vl = document.getElementById('video-local');
    if (vl) { vl.srcObject = _localStream; vl.classList.remove('hidden'); }
  }

  showCallUI(target.name, '発信中...', false);

  // Create peer connection
  _pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

  _pc.ontrack = e => {
    const vr = document.getElementById('video-remote');
    if (callType === 'video' && vr) {
      vr.srcObject = e.streams[0];
      vr.classList.remove('hidden');
    } else {
      // Audio only: play through hidden element
      const audio = document.getElementById('remote-audio') || (() => {
        const a = document.createElement('audio');
        a.id = 'remote-audio';
        a.autoplay = true;
        document.body.appendChild(a);
        return a;
      })();
      audio.srcObject = e.streams[0];
    }
    document.getElementById('call-status').textContent = '通話中';
  };

  _pc.onicecandidate = e => {
    if (e.candidate) sendCallSignal(targetUserId, 'ice', e.candidate.toJSON());
  };

  _pc.onconnectionstatechange = () => {
    if (_pc.connectionState === 'disconnected' || _pc.connectionState === 'failed') {
      endCall();
    }
  };

  const offer = await _pc.createOffer();
  await _pc.setLocalDescription(offer);
  await sendCallSignal(targetUserId, 'offer', { sdp: offer.sdp, type: offer.type, callType });

  // Poll for answer
  startCallSignalPolling();
}

async function answerCall() {
  const me = getCurrentUser();
  if (!me || !_incomingOffer) return;
  const { from, data: offerData } = _incomingOffer;
  _callType = offerData.callType || 'audio';
  _callTargetUserId = from;

  try { getAudioCtx(); } catch {}

  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: _callType === 'video',
    });
  } catch {
    toast('マイク/カメラへのアクセスが必要です');
    return;
  }

  if (_callType === 'video') {
    const vl = document.getElementById('video-local');
    if (vl) { vl.srcObject = _localStream; vl.classList.remove('hidden'); }
  }

  document.getElementById('call-status').textContent = '接続中...';
  document.getElementById('btn-call-answer').classList.add('hidden');

  _pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

  _pc.ontrack = e => {
    const vr = document.getElementById('video-remote');
    if (_callType === 'video' && vr) {
      vr.srcObject = e.streams[0];
      vr.classList.remove('hidden');
    } else {
      const audio = document.getElementById('remote-audio') || (() => {
        const a = document.createElement('audio'); a.id='remote-audio'; a.autoplay=true;
        document.body.appendChild(a); return a;
      })();
      audio.srcObject = e.streams[0];
    }
    document.getElementById('call-status').textContent = '通話中';
  };

  _pc.onicecandidate = e => {
    if (e.candidate) sendCallSignal(from, 'ice', e.candidate.toJSON());
  };

  _pc.onconnectionstatechange = () => {
    if (_pc.connectionState === 'disconnected' || _pc.connectionState === 'failed') endCall();
  };

  await _pc.setRemoteDescription({ type: offerData.type, sdp: offerData.sdp });
  const answer = await _pc.createAnswer();
  await _pc.setLocalDescription(answer);
  await sendCallSignal(from, 'answer', { sdp: answer.sdp, type: answer.type });

  _incomingOffer = null;
  startCallSignalPolling();
}

function endCall() {
  if (_pc) { _pc.close(); _pc = null; }
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }
  if (_callPollingTimer) { clearInterval(_callPollingTimer); _callPollingTimer = null; }
  _callTargetUserId = null;
  _incomingOffer = null;
  hideCallUI();
  toast('通話を終了しました');
}

let _lastCallSignalTs = 0;

function startCallSignalPolling() {
  if (_callPollingTimer) clearInterval(_callPollingTimer);
  _callPollingTimer = setInterval(pollCallSignals, 500);
}

async function pollCallSignals() {
  const me = getCurrentUser();
  if (!me) return;
  const data = await apiGet(`/api/call/signals/${me.id}?since=${_lastCallSignalTs}`, randomCallServer());
  const signals = data?.signals || [];
  for (const sig of signals) {
    _lastCallSignalTs = Math.max(_lastCallSignalTs, sig.ts);
    if (sig.type === 'answer' && _pc && _pc.signalingState === 'have-local-offer') {
      await _pc.setRemoteDescription({ type: sig.data.type, sdp: sig.data.sdp });
    } else if (sig.type === 'ice' && _pc && _pc.remoteDescription) {
      try { await _pc.addIceCandidate(sig.data); } catch {}
    }
  }
}

function initCallPolling() {
  // Poll for incoming calls globally (even outside call UI)
  let _incomingPollTimer = null;
  _incomingPollTimer = setInterval(async () => {
    const me = getCurrentUser();
    if (!me || _pc) return; // Don't poll if already in a call
    const data = await apiGet(`/api/call/signals/${me.id}?since=${_lastCallSignalTs}&peek=1`, randomCallServer());
    const signals = data?.signals || [];
    for (const sig of signals) {
      _lastCallSignalTs = Math.max(_lastCallSignalTs, sig.ts);
      if (sig.type === 'offer' && !_incomingOffer) {
        _incomingOffer = sig;
        // Consume the signal
        await apiGet(`/api/call/signals/${me.id}?since=${sig.ts - 1}`, randomCallServer());
        const users = getUsers();
        const caller = users[sig.from] || { id: sig.from, name: '?' };
        showCallUI(caller.name, '着信中...', true);
        break;
      }
    }
  }, 1000);
}

// ── Admin ──────────────────────────────────────────────────────────────────────
async function adminLogin(email, password) {
  const errEl = document.getElementById('admin-login-error');
  const btn = document.getElementById('btn-admin-login-submit');

  if (btn) { btn.disabled = true; btn.textContent = 'ログイン中...'; }
  if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }

  const timeoutId = setTimeout(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'ログイン'; }
    if (errEl) { errEl.textContent = 'タイムアウト。もう一度お試しください。'; errEl.classList.remove('hidden'); }
  }, 15000);

  try {
    const res = await fetch(getSyncUrl() + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password: password.trim() }),
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (btn) { btn.disabled = false; btn.textContent = 'ログイン'; }
    if (!data.ok || !data.role) {
      if (errEl) { errEl.textContent = data.error || 'メールアドレスまたはパスワードが違います'; errEl.classList.remove('hidden'); }
      return;
    }
    saveAdminToken(data.token);
    showScreen('admin');
    loadAdminUsers();
    toast('管理者としてログインしました');
  } catch (e) {
    clearTimeout(timeoutId);
    if (btn) { btn.disabled = false; btn.textContent = 'ログイン'; }
    if (errEl) { errEl.textContent = '接続エラー: ' + e.message; errEl.classList.remove('hidden'); }
  }
}

async function loadAdminUsers() {
  const token = getAdminToken();
  if (!token) return;
  const data = await apiFetch('/api/admin/users', { headers: { Authorization: 'Bearer ' + token } });
  const list = document.getElementById('admin-user-list');
  if (!list || !data?.users) return;
  const users = Object.values(data.users);
  if (!users.length) { list.innerHTML = '<div class="empty-state"><p>ユーザーがいません</p></div>'; return; }
  list.innerHTML = users.map(u => `
    <div class="admin-user-item">
      <div class="avatar-sm" style="background:${userColor(u.id)}">${esc(getInitial(u.name))}</div>
      <div class="admin-user-info">
        <div class="admin-user-name">${esc(u.name)}</div>
        <div class="admin-user-id">${esc(u.id)}</div>
      </div>
      <div class="admin-actions">
        <button class="btn-sm btn-secondary" data-uid="${esc(u.id)}" data-action="delete-user">削除</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-action="delete-user"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`${btn.dataset.uid} を削除しますか？`)) return;
      await apiFetch(`/api/admin/delete-user/${btn.dataset.uid}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer ' + getAdminToken() } });
      loadAdminUsers();
    });
  });
}

async function loadAdminConvs() {
  const token = getAdminToken();
  if (!token) return;
  const data = await apiFetch('/api/admin/conversations', { headers: { Authorization: 'Bearer ' + token } });
  const list = document.getElementById('admin-conv-list');
  if (!list || !data?.conversations) return;
  const convs = Object.values(data.conversations);
  list.innerHTML = convs.map(c => `
    <div class="admin-user-item">
      <div class="admin-user-info">
        <div class="admin-user-name">${esc(c.id)}</div>
        <div class="admin-user-id">${(c.participants || []).join(', ')}</div>
      </div>
    </div>`).join('') || '<div class="empty-state"><p>会話がありません</p></div>';
}

async function loadAdminAnnouncements() {
  const data = await apiGet('/api/announcements');
  const list = document.getElementById('admin-announce-list');
  if (!list) return;
  const anns = data?.announcements || [];
  if (!anns.length) { list.innerHTML = '<div class="empty-state"><p>お知らせなし</p></div>'; return; }
  list.innerHTML = anns.map(a => `
    <div class="admin-user-item">
      <div class="admin-user-info" style="flex:1">
        <div class="admin-user-name">${esc(a.text || '')}</div>
        <div class="admin-user-id">${fmtTime(a.ts)}</div>
      </div>
      <button class="btn-sm btn-secondary" data-id="${esc(a.id)}" data-action="delete-ann">削除</button>
    </div>`).join('');

  list.querySelectorAll('[data-action="delete-ann"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/announcements/${btn.dataset.id}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer ' + getAdminToken() } });
      loadAdminAnnouncements();
    });
  });
}

// ── Image upload flow ─────────────────────────────────────────────────────────
async function uploadImage(dataUrl) {
  // Store image as data URL directly in message (for simplicity)
  // For large images, we could use the /api/media/chunk endpoint
  return dataUrl;
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  // Close modals
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal.id);
    });
  });

  // Modal tabs
  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const paneId = tab.dataset.modalTab;
      const modal = tab.closest('.modal-content');
      if (!modal) return;
      modal.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      modal.querySelectorAll('.modal-tab-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      const pane = document.getElementById('modal-tab-' + paneId);
      if (pane) pane.classList.remove('hidden');
      if (paneId === 'qr-show') renderMyQR();
      if (paneId === 'invite-link') {
        const me = getCurrentUser();
        if (me) {
          const url = getInviteUrl(me);
          const el = document.getElementById('invite-link-display');
          if (el) el.textContent = url;
        }
      }
    });
  });

  // Admin sub-tabs
  document.querySelectorAll('.sub-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.adminTab;
      document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.admin-panel').forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none';
      });
      tab.classList.add('active');
      const panel = document.getElementById('admin-tab-' + tabId);
      if (panel) { panel.classList.add('active'); panel.style.display = 'flex'; }
      if (tabId === 'users') loadAdminUsers();
      if (tabId === 'convs') loadAdminConvs();
      if (tabId === 'announce') loadAdminAnnouncements();
    });
  });

  // Onboarding
  initOnboarding();

  // Chat back button
  const chatBack = document.getElementById('btn-chat-back');
  if (chatBack) chatBack.addEventListener('click', closeChat);

  // Chat send
  const sendBtn = document.getElementById('btn-send');
  const msgInput = document.getElementById('input-message');
  const doSend = () => {
    const text = msgInput?.value.trim();
    if (!text || !_currentConvId) return;
    msgInput.value = '';
    sendMessage(_currentConvId, { type: 'text', text });
  };
  if (sendBtn) sendBtn.addEventListener('click', doSend);
  if (msgInput) msgInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });

  // Attach toolbar
  const attachBtn = document.getElementById('btn-attach');
  const attachToolbar = document.getElementById('attach-toolbar');
  if (attachBtn) attachBtn.addEventListener('click', () => attachToolbar?.classList.toggle('hidden'));

  // Send image
  const sendImageBtn = document.getElementById('btn-send-image');
  const fileChat = document.getElementById('file-chat-image');
  if (sendImageBtn && fileChat) {
    sendImageBtn.addEventListener('click', () => { attachToolbar?.classList.add('hidden'); fileChat.click(); });
    fileChat.addEventListener('change', async () => {
      const f = fileChat.files[0];
      if (!f || !_currentConvId) return;
      const dataUrl = await compressImage(f, 800, 0.8);
      await sendMessage(_currentConvId, { type: 'image', image: dataUrl });
      fileChat.value = '';
    });
  }

  // Sticker
  const stickerBtn = document.getElementById('btn-send-sticker');
  if (stickerBtn) {
    stickerBtn.addEventListener('click', () => {
      attachToolbar?.classList.add('hidden');
      const grid = document.getElementById('sticker-grid');
      if (grid) {
        grid.innerHTML = STICKERS.map(s => `<button class="sticker-btn">${s}</button>`).join('');
        grid.querySelectorAll('.sticker-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            if (_currentConvId) sendMessage(_currentConvId, { type: 'sticker', sticker: btn.textContent });
            closeModal('modal-sticker-picker');
          });
        });
      }
      openModal('modal-sticker-picker');
    });
  }

  // New chat button
  const newChatBtn = document.getElementById('btn-new-chat');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      const friends = getFriends();
      if (!friends.length) {
        toast('まず友だちを追加してください');
        openModal('modal-add-friend');
        return;
      }
      // Show friend picker (simple alert for now, could be a modal)
      // Open add friend modal as shortcut
      openModal('modal-add-friend');
    });
  }

  // Add friend button
  const addFriendBtn = document.getElementById('btn-add-friend');
  if (addFriendBtn) {
    addFriendBtn.addEventListener('click', () => {
      renderMyQR();
      openModal('modal-add-friend');
      // Start scanner on the QR scan tab (active by default)
      setTimeout(startQrScanner, 300);
    });
  }

  // Close modal stops scanner
  document.querySelectorAll('[data-close="modal-add-friend"]').forEach(btn => {
    btn.addEventListener('click', stopQrScanner);
  });

  // Redeem invite code
  const redeemBtn = document.getElementById('btn-redeem-code');
  if (redeemBtn) {
    redeemBtn.addEventListener('click', async () => {
      const code = document.getElementById('input-invite-code')?.value.trim();
      if (!code) { toast('コードを入力してください'); return; }
      const ok = await addFriend(code);
      if (ok) closeModal('modal-add-friend');
    });
  }

  // Copy invite
  document.getElementById('btn-copy-invite')?.addEventListener('click', () => {
    const me = getCurrentUser();
    if (!me) return;
    const url = getInviteUrl(me);
    navigator.clipboard?.writeText(url).then(() => toast('コピーしました！'));
  });
  document.getElementById('btn-copy-link')?.addEventListener('click', () => {
    const me = getCurrentUser();
    if (!me) return;
    const url = getInviteUrl(me);
    navigator.clipboard?.writeText(url).then(() => toast('コピーしました！'));
  });

  // New post
  const newPostBtn = document.getElementById('btn-new-post');
  if (newPostBtn) {
    newPostBtn.addEventListener('click', () => {
      openModal('modal-new-post');
    });
  }

  // Post image
  const postImgBtn = document.getElementById('btn-post-add-image');
  const filePost = document.getElementById('file-post-image');
  if (postImgBtn && filePost) {
    postImgBtn.addEventListener('click', () => filePost.click());
    filePost.addEventListener('change', async () => {
      const f = filePost.files[0];
      if (!f) return;
      const dataUrl = await compressImage(f, 1080, 0.85);
      const preview = document.getElementById('post-image-preview');
      if (preview) {
        preview.innerHTML = `<img src="${dataUrl}" style="max-width:100%;border-radius:8px;margin-top:8px;">`;
        preview.classList.remove('hidden');
        preview._imgData = dataUrl;
      }
    });
  }

  const submitPostBtn = document.getElementById('btn-submit-post');
  if (submitPostBtn) {
    submitPostBtn.addEventListener('click', async () => {
      const me = getCurrentUser();
      if (!me) return;
      const text = document.getElementById('input-post-text')?.value.trim();
      const preview = document.getElementById('post-image-preview');
      const image = preview?._imgData || null;
      if (!text && !image) { toast('テキストまたは画像を入力してください'); return; }
      submitPostBtn.disabled = true;
      await apiPost('/api/posts', { userId: me.id, text, image }, randomPostServer());
      submitPostBtn.disabled = false;
      if (document.getElementById('input-post-text')) document.getElementById('input-post-text').value = '';
      if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); preview._imgData = null; }
      if (filePost) filePost.value = '';
      closeModal('modal-new-post');
      renderMomentFeed();
    });
  }

  // Edit profile
  const editProfileBtn = document.getElementById('btn-edit-profile');
  if (editProfileBtn) {
    editProfileBtn.addEventListener('click', () => {
      const me = getCurrentUser();
      if (!me) return;
      const nameInput = document.getElementById('input-new-name');
      const titleInput = document.getElementById('input-new-title');
      if (nameInput) nameInput.value = me.name;
      if (titleInput) titleInput.value = me.title || '';
      openModal('modal-edit-profile');
    });
  }

  const saveProfileBtn = document.getElementById('btn-save-profile');
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', async () => {
      const me = getCurrentUser();
      if (!me) return;
      const name = document.getElementById('input-new-name')?.value.trim();
      const title = document.getElementById('input-new-title')?.value.trim();
      if (!name) { toast('名前を入力してください'); return; }
      me.name = name;
      me.title = title;
      me.updatedAt = Date.now();
      saveCurrentUser(me);
      await apiPut(`/api/users/${me.id}`, me);
      updateProfileUI();
      closeModal('modal-edit-profile');
      toast('プロフィールを更新しました');
    });
  }

  // Avatar change
  const changeAvatarBtn = document.getElementById('btn-change-avatar');
  const fileAvatar = document.getElementById('file-avatar');
  if (changeAvatarBtn && fileAvatar) {
    changeAvatarBtn.addEventListener('click', () => fileAvatar.click());
    fileAvatar.addEventListener('change', async () => {
      const f = fileAvatar.files[0];
      if (!f) return;
      const dataUrl = await compressImage(f, 256, 0.85);
      const me = getCurrentUser();
      if (!me) return;
      me.avatar = dataUrl;
      me.updatedAt = Date.now();
      saveCurrentUser(me);
      await apiPut(`/api/users/${me.id}`, me);
      updateProfileUI();
      toast('アバターを更新しました');
      fileAvatar.value = '';
    });
  }

  // Profile card click
  document.getElementById('my-profile-card')?.addEventListener('click', () => {
    const me = getCurrentUser();
    if (!me) return;
    const nameInput = document.getElementById('input-new-name');
    const titleInput = document.getElementById('input-new-title');
    if (nameInput) nameInput.value = me.name;
    if (titleInput) titleInput.value = me.title || '';
    openModal('modal-edit-profile');
  });

  // Theme toggle
  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.dataset.theme === 'dark';
    html.dataset.theme = isDark ? 'light' : 'dark';
    LS.set('bluechat_theme', html.dataset.theme);
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) {
      const icon = btn.querySelector('.menu-icon');
      if (icon) icon.textContent = isDark ? '🌙' : '☀️';
    }
  });

  // Sync server settings
  document.getElementById('btn-sync-server')?.addEventListener('click', () => {
    const input = document.getElementById('input-sync-url');
    if (input) input.value = getSyncUrl();
    openModal('modal-sync-settings');
  });

  document.getElementById('btn-save-sync-url')?.addEventListener('click', async () => {
    const url = document.getElementById('input-sync-url')?.value.trim();
    if (!url) return;
    const statusEl = document.getElementById('sync-url-status');
    if (statusEl) statusEl.textContent = '確認中...';
    const data = await apiGet('/api/health', url);
    if (data?.ok) {
      saveSyncUrl(url);
      if (statusEl) statusEl.textContent = '✅ 接続成功';
      toast('サーバーURLを保存しました');
    } else {
      if (statusEl) statusEl.textContent = '❌ 接続失敗: ' + (data?.error || '不明なエラー');
    }
  });

  // Admin
  document.getElementById('btn-admin-link')?.addEventListener('click', () => {
    if (getAdminToken()) {
      showScreen('admin');
      loadAdminUsers();
    } else {
      showScreen('admin-login');
    }
  });

  document.getElementById('btn-admin-login-back')?.addEventListener('click', () => showScreen('main'));

  document.getElementById('btn-admin-login-submit')?.addEventListener('click', () => {
    const email = document.getElementById('input-admin-email')?.value || '';
    const password = document.getElementById('input-admin-password')?.value || '';
    adminLogin(email, password);
  });

  document.getElementById('input-admin-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-admin-login-submit')?.click();
  });

  document.getElementById('btn-admin-back')?.addEventListener('click', () => showScreen('main'));

  document.getElementById('btn-admin-logout')?.addEventListener('click', () => {
    LS.del('bluechat_admin_token');
    showScreen('main');
    toast('管理者ログアウトしました');
  });

  document.getElementById('btn-admin-refresh')?.addEventListener('click', loadAdminUsers);

  document.getElementById('btn-admin-post-announce')?.addEventListener('click', async () => {
    const text = document.getElementById('admin-announce-text')?.value.trim();
    if (!text) return;
    await apiFetch('/api/announcements', {
      method: 'POST',
      body: JSON.stringify({ text }),
      headers: { Authorization: 'Bearer ' + getAdminToken() },
    });
    if (document.getElementById('admin-announce-text')) document.getElementById('admin-announce-text').value = '';
    loadAdminAnnouncements();
    toast('お知らせを投稿しました');
  });

  // Admin search
  document.getElementById('admin-search')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.admin-user-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = text.includes(q) ? '' : 'none';
    });
  });

  // Call buttons in chat
  document.getElementById('btn-call-audio')?.addEventListener('click', () => {
    if (_callTargetUserId) startCall(_callTargetUserId, 'audio');
    else toast('通話相手が不明です');
  });
  document.getElementById('btn-call-video')?.addEventListener('click', () => {
    if (_callTargetUserId) startCall(_callTargetUserId, 'video');
    else toast('通話相手が不明です');
  });

  // Call UI buttons
  document.getElementById('btn-call-answer')?.addEventListener('click', answerCall);
  document.getElementById('btn-call-end')?.addEventListener('click', () => {
    if (_callTargetUserId) sendCallSignal(_callTargetUserId, 'end', {}).catch(() => {});
    endCall();
  });
  document.getElementById('btn-call-mute')?.addEventListener('click', () => {
    _callMuted = !_callMuted;
    if (_localStream) {
      _localStream.getAudioTracks().forEach(t => { t.enabled = !_callMuted; });
    }
    const btn = document.getElementById('btn-call-mute');
    if (btn) btn.textContent = _callMuted ? '🔇' : '🎤';
  });

  // Logout
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    if (!confirm('ログアウトしますか？データは端末に残ります。')) return;
    saveApiToken(null);
    showScreen('onboarding');
    initOnboarding();
  });

  // Feedback
  document.getElementById('btn-feedback')?.addEventListener('click', () => openModal('modal-feedback'));
  document.getElementById('btn-submit-feedback')?.addEventListener('click', async () => {
    const me = getCurrentUser();
    if (!me) return;
    const text = document.getElementById('input-feedback')?.value.trim();
    if (!text) return;
    await apiPost('/api/posts', { userId: me.id, text: `[フィードバック] ${text}`, image: null }, randomPostServer());
    if (document.getElementById('input-feedback')) document.getElementById('input-feedback').value = '';
    closeModal('modal-feedback');
    toast('送信しました！ありがとうございます');
  });
}

// ── Initialize ─────────────────────────────────────────────────────────────────
(function init() {
  // Apply saved theme
  const theme = LS.get('bluechat_theme', 'light');
  document.documentElement.dataset.theme = theme;
  const themeBtn = document.getElementById('btn-theme-toggle');
  if (themeBtn) {
    const icon = themeBtn.querySelector('.menu-icon');
    if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  // Bind all events
  bindEvents();
  initTabs();

  // Start app if user exists, else show onboarding
  const me = getCurrentUser();
  if (me) {
    startApp();
  } else {
    showScreen('onboarding');
    initOnboarding();
  }
})();
