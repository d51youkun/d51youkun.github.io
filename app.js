/**
 * BlueChat - LINE-like chat app (on-device, localStorage)
 */

const STORAGE_KEY = 'bluechat_data';
const CODE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const INVITE_PREFIX = 'bc:';
const INVITE_PREFIX_LEGACY = 'bluechat:';
const SYNC_URL_KEY = 'bluechat_sync_url';
const SYNC_CONFIGURED_KEY = 'bluechat_sync_configured';
const DEFAULT_SYNC_URL = '__DEFAULT_SYNC_URL__';
const ADMIN_SESSION_KEY = 'bluechat_admin_session';
const TRANSFER_PREFIX = 'bluechat-transfer:';
const TRANSFER_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ─── State ───────────────────────────────────────────────
let currentScreen = 'onboarding';
let currentTab = 'chats';
let currentAdminTab = 'users';
let currentConvId = null;
let adminViewConvId = null;
let adminFocusUserId = null;
let adminLoggedIn = false;
let returnScreenAfterAdmin = 'onboarding';
let qrScanner = null;
let qrScanHandled = false;
let globalSyncTimer = null;
let chatSyncTimer = null;
const _afterInitCallbacks = [];

function onAppInit(fn) {
  if (typeof fn === 'function') _afterInitCallbacks.push(fn);
}

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
    messages: {},
    readReceipts: {},
    customStickerPacks: [],
    titlePresets: []
  };
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getData() { return loadData(); }

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getUser(id) {
  const data = getData();
  if (!id) return null;
  return data.users[id] || data.users[String(id)] || null;
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
  const uid = String(currentUserId);
  const otherId = conv.members.find(m => String(m) !== uid);
  return otherId ? getUser(otherId) : null;
}

function compressImage(file, maxSize = 256, quality = 0.82) {
  return compressImageFile(file, maxSize, quality);
}

function compressChatImage(file) {
  return compressImageFile(file, 1024, 0.85);
}

function compressImageFile(file, maxSize, quality) {
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

function getMessagePreview(msg) {
  if (msg.type === 'sticker') return msg.stickerEmoji || '🎨 スタンプ';
  if (msg.type === 'video') return '🎬 動画';
  if (msg.type === 'file') return '📎 ' + (msg.fileName || 'ファイル');
  if (msg.type === 'image' || msg.image) return '📷 写真';
  return (msg.text || '').slice(0, 50);
}

function downloadImage(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename || 'bluechat-photo.jpg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('画像を保存しました');
}

function openImageViewer(imageSrc) {
  document.getElementById('image-view-full').src = imageSrc;
  document.getElementById('btn-download-full-image').dataset.imageSrc = imageSrc;
  showModal('modal-image-view');
}

function setUserAvatar(userId, dataUrl) {
  const data = getData();
  if (!data.users[userId]) return false;
  data.users[userId].avatar = dataUrl;
  data.users[userId].avatarUpdatedAt = Date.now();
  try {
    saveData(data);
    cloudPushUser(data.users[userId]);
    return true;
  } catch (e) {
    return false;
  }
}

function removeUserAvatar(userId) {
  const data = getData();
  if (!data.users[userId]) return;
  delete data.users[userId].avatar;
  data.users[userId].avatarUpdatedAt = Date.now();
  saveData(data);
  cloudPushUser(data.users[userId]);
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
  cloudPushUser(data.users[id]);
  return data.users[id];
}

function getFriends(userId) {
  const data = getData();
  const uid = String(userId);
  const friends = new Set();
  data.friendships.forEach(f => {
    if (String(f.user1) === uid) friends.add(String(f.user2));
    if (String(f.user2) === uid) friends.add(String(f.user1));
  });
  return Array.from(friends).map(id => {
    const u = data.users[id];
    if (u) return u;
    return { id, name: 'ユーザー', createdAt: 0 };
  });
}

function areFriends(id1, id2) {
  const a = String(id1);
  const b = String(id2);
  const data = getData();
  return data.friendships.some(f =>
    (String(f.user1) === a && String(f.user2) === b) ||
    (String(f.user1) === b && String(f.user2) === a)
  );
}

function addFriendship(id1, id2, options = {}) {
  const { skipCloud = false } = options;
  const a = String(id1);
  const b = String(id2);
  if (a === b || areFriends(a, b)) return null;
  const data = getData();
  data.friendships.push({ user1: a, user2: b, createdAt: Date.now() });
  saveData(data);
  const convId = getOrCreateDirectConv(a, b);
  if (!skipCloud) cloudPushFriendship(a, b);
  return convId;
}

function ensureLocalUser(userInfo) {
  if (!userInfo || !userInfo.id) return null;
  const uid = String(userInfo.id);
  const data = getData();
  if (!data.users[uid]) {
    data.users[uid] = {
      id: uid,
      name: userInfo.name || '不明',
      createdAt: userInfo.createdAt || Date.now(),
      isRemote: true
    };
    saveData(data);
  } else if (userInfo.name && data.users[uid].name !== userInfo.name) {
    data.users[uid].name = userInfo.name;
    saveData(data);
  }
  if (userInfo.avatar !== undefined) {
    const local = data.users[uid];
    const remoteTs = userInfo.avatarUpdatedAt || 0;
    const localTs = local.avatarUpdatedAt || 0;
    if (userInfo.avatar && remoteTs >= localTs && local.avatar !== userInfo.avatar) {
      local.avatar = userInfo.avatar;
      local.avatarUpdatedAt = remoteTs;
      saveData(data);
    } else if (!userInfo.avatar && remoteTs > localTs && local.avatar) {
      delete local.avatar;
      local.avatarUpdatedAt = remoteTs;
      saveData(data);
    }
  }
  if (userInfo.title !== undefined) {
    if (userInfo.title && userInfo.title.text) data.users[uid].title = userInfo.title;
    else delete data.users[uid].title;
    saveData(data);
  }
  if (userInfo.suspendedUntil !== undefined) {
    data.users[uid].suspendedUntil = userInfo.suspendedUntil;
    saveData(data);
  }
  if (userInfo.banned !== undefined) {
    data.users[uid].banned = userInfo.banned;
    saveData(data);
  }
  if (userInfo.bannedUntil !== undefined) {
    data.users[uid].bannedUntil = userInfo.bannedUntil;
    saveData(data);
  }
  if (userInfo.premium !== undefined) {
    data.users[uid].premium = userInfo.premium;
    saveData(data);
  }
  if (userInfo.superPremium !== undefined) {
    data.users[uid].superPremium = userInfo.superPremium;
    saveData(data);
  }
  return data.users[uid];
}

// ─── Friend QR Invites ───────────────────────────────────
function encodeInvite(user) {
  const payload = {
    i: user.id,
    e: Math.floor((Date.now() + CODE_EXPIRY_MS) / 1000)
  };
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return INVITE_PREFIX + b64;
}

function decodeInvite(str) {
  if (!str) return null;
  const text = String(str).trim().replace(/^\uFEFF/, '');
  if (text.startsWith(TRANSFER_PREFIX)) return null;
  let raw = null;
  let prefixLen = 0;
  for (const prefix of [INVITE_PREFIX, INVITE_PREFIX_LEGACY]) {
    const idx = text.toLowerCase().indexOf(prefix);
    if (idx >= 0) {
      raw = text.slice(idx).split(/[\s\r\n]/)[0];
      prefixLen = prefix.length;
      break;
    }
  }
  if (!raw) return null;
  try {
    let b64 = raw.slice(prefixLen).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = decodeURIComponent(escape(atob(b64)));
    const payload = JSON.parse(json);
    if (!payload || !payload.i) return null;
    payload.i = String(payload.i);
    if (payload.e < 1e12) payload.e = payload.e * 1000;
    return payload;
  } catch (e) {
    return null;
  }
}

function normalizeInviteFromScan(raw) {
  const text = String(raw || '').trim().replace(/^\uFEFF/, '');
  if (!text || text.startsWith(TRANSFER_PREFIX)) return null;
  const match = text.match(/(?:bc|bluechat):[A-Za-z0-9_-]+/i);
  return match ? match[0] : null;
}

async function redeemFriendInvite(inviteStr, currentUserId) {
  const normalized = normalizeInviteFromScan(inviteStr) || String(inviteStr || '').trim();
  const payload = decodeInvite(normalized);
  if (!payload || !payload.i) {
    return { error: '無効なコードです。もう一度お試しください' };
  }
  if (Date.now() > payload.e) {
    return { error: 'コードの有効期限が切れています。QRを更新してください' };
  }
  const meId = String(currentUserId);
  const friendId = String(payload.i);
  if (friendId === meId) {
    return { error: '自分のコードは使えません' };
  }
  if (areFriends(meId, friendId)) {
    return { error: 'すでに友だちです' };
  }

  const me = getCurrentUser();
  let friendName = payload.n || null;
  if (getSyncUrl()) {
    const remote = await cloudFetchUser(friendId);
    if (remote && remote.id) {
      ensureLocalUser(remote);
      friendName = remote.name || friendName;
    }
  }
  ensureLocalUser({ id: friendId, name: friendName || '友だち' });
  if (me) await cloudPushUser(me);
  await cloudPushUser(getUser(friendId) || { id: friendId, name: friendName || '友だち', createdAt: Date.now() });

  addFriendship(meId, friendId);
  const targetUser = getUser(friendId);
  if (!targetUser) {
    return { error: '友だち情報の保存に失敗しました' };
  }
  return { success: true, user: targetUser };
}

async function handleFriendInviteSuccess(result) {
  qrScanHandled = true;
  await stopQrScanner();
  hideModal('modal-add-friend');
  const me = getCurrentUser();
  if (me && result.user) {
    await cloudPushUser(me);
    await cloudPushUser(result.user);
    let pushed = false;
    for (let i = 0; i < 4 && !pushed; i++) {
      pushed = await cloudPushFriendship(me.id, result.user.id);
      if (!pushed && i < 3) await new Promise(r => setTimeout(r, 2000));
    }
    const convId = getOrCreateDirectConv(me.id, result.user.id);
    const conv = getData().conversations[convId];
    if (conv) await cloudPushConversation(conv);
    if (getSyncUrl()) await syncFriendships();
    if (!pushed && getSyncUrl()) {
      showToast('友だちは追加しました（サーバー反映は後で再試行されます）');
    }
  }
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
  else refreshMainUI();
  showToast(`${result.user.name}さんと友だちになりました！`);
  document.querySelector('.tab[data-tab="friends"]')?.click();
}

async function tryRedeemInviteCode(code) {
  const user = getCurrentUser();
  if (!user) return;
  const result = await redeemFriendInvite(code, user.id);
  if (result.error) {
    showToast(result.error);
    return;
  }
  await handleFriendInviteSuccess(result);
}

function renderMyQR() {
  const user = getCurrentUser();
  if (!user) return;
  if (typeof QRCode === 'undefined') {
    showToast('QRコードライブラリを読み込めませんでした');
    return;
  }
  const container = document.getElementById('qr-canvas');
  if (!container) return;
  container.innerHTML = '';
  const invite = encodeInvite(user);
  document.getElementById('qr-user-name').textContent = user.name;
  document.getElementById('qr-expiry-note').textContent = '有効期限: 24時間（更新ボタンで再発行）';
  const codeEl = document.getElementById('invite-code-text');
  if (codeEl) codeEl.textContent = invite;
  try {
    new QRCode(container, {
      text: invite,
      width: 220,
      height: 220,
      colorDark: '#1a6fd4',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L
    });
  } catch (e) {
    showToast('QRコードの生成に失敗しました');
  }
}

async function startQrScanner() {
  if (typeof Html5Qrcode === 'undefined') {
    showToast('カメラ機能を読み込めませんでした');
    return false;
  }
  if (!window.isSecureContext) {
    showToast('カメラはHTTPSまたはlocalhostでのみ使えます');
    return false;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('このブラウザはカメラに対応していません');
    return false;
  }
  if (qrScanner && qrScanner.isScanning) return true;

  qrScanHandled = false;
  document.getElementById('qr-scan-idle').classList.add('hidden');
  document.getElementById('qr-scan-active').classList.remove('hidden');

  try {
    if (!qrScanner) {
      qrScanner = new Html5Qrcode('qr-reader', { verbose: false });
    }

    const configs = [
      { facingMode: 'environment' },
      { facingMode: 'user' }
    ];

    let started = false;
    let lastError = null;
    for (const config of configs) {
      try {
        await qrScanner.start(
          config,
          { fps: 10, qrbox: { width: 220, height: 220 }, aspectRatio: 1.0 },
          onQrScanSuccess,
          () => {}
        );
        started = true;
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!started) {
      const cameras = await Html5Qrcode.getCameras();
      if (cameras.length > 0) {
        await qrScanner.start(
          cameras[0].id,
          { fps: 10, qrbox: { width: 220, height: 220 }, aspectRatio: 1.0 },
          onQrScanSuccess,
          () => {}
        );
        started = true;
      }
    }

    if (!started) {
      throw lastError || new Error('カメラを起動できません');
    }
    return true;
  } catch (e) {
    resetScanUI();
    const msg = (e && e.name === 'NotAllowedError')
      ? 'カメラの使用が拒否されました。ブラウザの設定で許可してください'
      : 'カメラを起動できません。権限を確認してください';
    showToast(msg);
    return false;
  }
}

function resetScanUI() {
  document.getElementById('qr-scan-idle').classList.remove('hidden');
  document.getElementById('qr-scan-active').classList.add('hidden');
  updateSecureContextHint();
}

function updateSecureContextHint() {
  const hint = document.getElementById('qr-secure-hint');
  if (!hint) return;
  if (!window.isSecureContext) {
    hint.textContent = '※ カメラを使うには https:// または localhost で開いてください';
    hint.classList.add('warn');
  } else if (typeof Html5Qrcode === 'undefined') {
    hint.textContent = '※ カメラ機能の読み込みに失敗しました。ページを再読み込みしてください';
    hint.classList.add('warn');
  } else {
    hint.textContent = '※ ボタンを押すとカメラの使用許可を求められます';
    hint.classList.remove('warn');
  }
}

async function stopQrScanner() {
  if (!qrScanner) {
    resetScanUI();
    return;
  }
  try {
    if (qrScanner.isScanning) {
      await qrScanner.stop();
    }
    qrScanner.clear();
  } catch (e) { /* ignore */ }
  qrScanner = null;
  qrScanHandled = false;
  resetScanUI();
}

function onQrScanSuccess(decodedText) {
  if (qrScanHandled) return;
  const code = normalizeInviteFromScan(decodedText);
  if (!code) return;
  const user = getCurrentUser();
  if (!user) {
    showToast('先にアカウントを作成してください');
    return;
  }
  qrScanHandled = true;
  (async () => {
    try {
      if (qrScanner && qrScanner.isScanning) {
        try { await qrScanner.stop(); } catch (e) { /* ignore */ }
      }
      const result = await redeemFriendInvite(code, user.id);
      if (result.error) {
        qrScanHandled = false;
        showToast(result.error);
        return;
      }
      await handleFriendInviteSuccess(result);
    } catch (e) {
      qrScanHandled = false;
      showToast('友だち追加に失敗しました。もう一度お試しください');
    }
  })();
}

function switchAddFriendTab(tab) {
  document.querySelectorAll('#modal-add-friend .modal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.modalTab === tab);
  });
  const scanEl = document.getElementById('modal-tab-scan');
  const enterEl = document.getElementById('modal-tab-enter');
  const showEl = document.getElementById('modal-tab-show');
  if (scanEl) scanEl.classList.toggle('hidden', tab !== 'scan');
  if (enterEl) enterEl.classList.toggle('hidden', tab !== 'enter');
  if (showEl) showEl.classList.toggle('hidden', tab !== 'show');

  if (tab === 'scan') {
    stopQrScanner();
    updateSecureContextHint();
  } else {
    stopQrScanner();
    if (tab === 'show') setTimeout(() => renderMyQR(), 150);
    if (tab === 'enter') {
      const input = document.getElementById('input-friend-invite');
      if (input) input.value = '';
    }
  }
}

function openAddFriendModal(tab = 'scan') {
  qrScanHandled = false;
  showModal('modal-add-friend');
  switchAddFriendTab(tab);
}

function getDirectConvId(id1, id2) {
  return 'dm_' + [String(id1), String(id2)].sort().join('_');
}

// ─── Cloud Sync ────────────────────────────────────────────
function getSyncUrl() {
  const stored = (localStorage.getItem(SYNC_URL_KEY) || '').replace(/\/$/, '');
  if (stored) return stored;
  if (typeof DEFAULT_SYNC_URL === 'string' && DEFAULT_SYNC_URL && DEFAULT_SYNC_URL !== '__DEFAULT_SYNC_URL__') {
    return DEFAULT_SYNC_URL;
  }
  return '';
}

function setSyncUrl(url) {
  const trimmed = (url || '').trim().replace(/\/$/, '');
  if (trimmed) {
    localStorage.setItem(SYNC_URL_KEY, trimmed);
    localStorage.setItem(SYNC_CONFIGURED_KEY, '1');
  } else {
    localStorage.removeItem(SYNC_URL_KEY);
  }
}

function initSyncFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const sync = params.get('sync');
  if (sync) {
    setSyncUrl(sync);
    return;
  }
  if (localStorage.getItem(SYNC_CONFIGURED_KEY)) return;
  if (DEFAULT_SYNC_URL && DEFAULT_SYNC_URL !== '__DEFAULT_SYNC_URL__') {
    setSyncUrl(DEFAULT_SYNC_URL);
  }
}

async function cloudRequest(path, options = {}, timeoutMs = 45000) {
  const base = getSyncUrl();
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const text = await res.text();
    if (!res.ok) return null;
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function testSyncConnection(retries = 5) {
  for (let i = 0; i < retries; i++) {
    const result = await cloudRequest('/api/health', {}, 60000);
    if (result && result.ok) return true;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 4000));
  }
  return false;
}

async function cloudPushConversation(conv) {
  if (!conv || !getSyncUrl()) return;
  await cloudRequest(`/api/conversations/${conv.id}`, {
    method: 'PUT',
    body: JSON.stringify(conv)
  });
}

async function cloudDeleteMessage(convId, msgId) {
  if (!getSyncUrl()) return false;
  const res = await cloudRequest(`/api/messages/${convId}/${msgId}`, { method: 'DELETE' });
  return !!(res && res.ok);
}

const PENDING_MSG_KEY = 'bluechat_pending_msgs';

function getPendingMessageIds(convId) {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_MSG_KEY) || '{}');
    return new Set(all[convId] || []);
  } catch (e) {
    return new Set();
  }
}

function trackPendingMessage(convId, msgId) {
  if (!convId || !msgId) return;
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_MSG_KEY) || '{}');
    if (!all[convId]) all[convId] = [];
    if (!all[convId].includes(msgId)) all[convId].push(msgId);
    localStorage.setItem(PENDING_MSG_KEY, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}

function untrackPendingMessage(convId, msgId) {
  if (!convId || !msgId) return;
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_MSG_KEY) || '{}');
    if (!all[convId]) return;
    all[convId] = all[convId].filter(id => id !== msgId);
    if (!all[convId].length) delete all[convId];
    localStorage.setItem(PENDING_MSG_KEY, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}

function markMessagePushed(convId, msg) {
  if (!convId || !msg) return;
  untrackPendingMessage(convId, msg.id);
  const key = 'bluechat_last_push_' + convId;
  const last = parseInt(localStorage.getItem(key) || '0', 10);
  localStorage.setItem(key, String(Math.max(last, msg.timestamp || Date.now())));
}

async function syncMessageDeletions(convId) {
  if (!getSyncUrl() || !convId) return;
  const ids = await cloudRequest(`/api/messages/${convId}/ids`);
  if (!Array.isArray(ids)) return;
  // サーバーにまだメッセージが無い場合はローカル履歴を消さない
  if (ids.length === 0) return;

  const data = getData();
  if (!data.messages[convId] || !data.messages[convId].length) return;

  const idSet = new Set(ids);
  const pendingIds = getPendingMessageIds(convId);
  const key = 'bluechat_last_push_' + convId;
  const lastPush = parseInt(localStorage.getItem(key) || '0', 10);
  const before = data.messages[convId].length;
  data.messages[convId] = data.messages[convId].filter(m => {
    if (pendingIds.has(m.id)) return true;
    if (idSet.has(m.id)) {
      untrackPendingMessage(convId, m.id);
      return true;
    }
    return (m.timestamp || 0) > lastPush;
  });
  if (data.messages[convId].length !== before) {
    syncConversationMeta(convId);
    saveData(data);
  }
}

async function cloudPushMessage(convId, msg) {
  if (!getSyncUrl()) return false;
  const res = await cloudRequest(`/api/messages/${convId}/${msg.id}`, {
    method: 'PUT',
    body: JSON.stringify(msg)
  });
  if (res && res.ok !== false) {
    markMessagePushed(convId, msg);
    return true;
  }
  return false;
}

async function cloudFetchMessages(convId, since = 0) {
  const data = await cloudRequest(`/api/messages/${convId}?since=${since}`);
  return Array.isArray(data) ? data : [];
}

async function cloudFetchConversation(convId) {
  return cloudRequest(`/api/conversations/${convId}`);
}

function mergeRemoteMessage(convId, remoteMsg) {
  if (!remoteMsg || !remoteMsg.id) return false;
  const data = getData();
  if (!data.messages[convId]) data.messages[convId] = [];
  const idx = data.messages[convId].findIndex(m => m.id === remoteMsg.id);
  if (idx >= 0) {
    data.messages[convId][idx] = { ...data.messages[convId][idx], ...remoteMsg };
    saveData(data);
    return false;
  }
  data.messages[convId].push(remoteMsg);
  data.messages[convId].sort((a, b) => a.timestamp - b.timestamp);
  const conv = data.conversations[convId];
  if (conv) {
    const last = data.messages[convId][data.messages[convId].length - 1];
    conv.lastMessageAt = last.timestamp;
    conv.lastMessagePreview = getMessagePreview(last);
    conv.lastMessageSenderId = last.senderId;
  }
  saveData(data);
  return true;
}

async function syncPushLocalMessages(convId) {
  if (!getSyncUrl() || !convId) return;
  const key = 'bluechat_last_push_' + convId;
  const lastPush = parseInt(localStorage.getItem(key) || '0', 10);
  const pendingIds = getPendingMessageIds(convId);
  const pending = getMessages(convId).filter(m =>
    pendingIds.has(m.id) || (m.timestamp || 0) > lastPush
  );
  if (!pending.length) return;
  const conv = getData().conversations[convId];
  if (conv) await cloudPushConversation(conv);
  for (const msg of pending) {
    await cloudPushMessage(convId, msg);
  }
}

async function syncConversation(convId) {
  if (!getSyncUrl() || !convId) return 0;

  await syncPushLocalMessages(convId);
  await syncMessageDeletions(convId);

  const remoteConv = await cloudFetchConversation(convId);
  if (remoteConv && remoteConv.id) {
    const data = getData();
    if (!data.conversations[convId]) {
      data.conversations[convId] = remoteConv;
      if (!data.messages[convId]) data.messages[convId] = [];
      saveData(data);
    }
  }

  const remote = await cloudFetchMessages(convId, 0);
  let added = 0;
  for (const msg of remote) {
    if (mergeRemoteMessage(convId, msg)) added++;
  }
  return added;
}

async function cloudPushUser(user) {
  if (!user || !user.id || !getSyncUrl()) return false;
  const payload = {
    id: user.id,
    name: user.name,
    createdAt: user.createdAt || Date.now(),
    avatar: user.avatar || null,
    avatarUpdatedAt: user.avatarUpdatedAt || 0,
    title: user.title || null,
    suspendedUntil: user.suspendedUntil || null,
    banned: !!user.banned,
    bannedUntil: user.bannedUntil || null,
    premium: !!user.premium,
    superPremium: !!user.superPremium,
    passwordHash: user.passwordHash || null
  };
  for (let i = 0; i < 4; i++) {
    const res = await cloudRequest(`/api/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }, 60000);
    if (res && res.ok) return true;
    if (i < 3) await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function cloudFetchUser(userId) {
  return cloudRequest(`/api/users/${userId}`);
}

async function cloudPushFriendship(id1, id2) {
  if (!getSyncUrl()) return false;
  const key = [String(id1), String(id2)].sort().join('_');
  for (let i = 0; i < 4; i++) {
    const res = await cloudRequest(`/api/friendships/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ user1: String(id1), user2: String(id2), createdAt: Date.now() })
    }, 60000);
    if (res && res.ok) return true;
    if (i < 3) await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

async function cloudFetchFriendIds(userId) {
  const data = await cloudRequest(`/api/user/${userId}/friendships`);
  return Array.isArray(data) ? data : [];
}

async function syncFriendships() {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return 0;

  cloudPushUser(user);
  const friendIds = await cloudFetchFriendIds(user.id);
  let added = 0;
  let avatarsUpdated = false;

  for (const friendId of friendIds) {
    if (String(friendId) === String(user.id)) continue;
    const remoteUser = await cloudFetchUser(friendId);
    if (remoteUser && remoteUser.id) {
      const before = getUser(friendId)?.avatar;
      ensureLocalUser(remoteUser);
      if (getUser(friendId)?.avatar !== before) avatarsUpdated = true;
      const u = getUser(friendId);
      if (u) {
        if (remoteUser.title !== undefined) {
          if (remoteUser.title && remoteUser.title.text) u.title = remoteUser.title;
          else delete u.title;
        }
        if (remoteUser.suspendedUntil !== undefined) u.suspendedUntil = remoteUser.suspendedUntil;
        if (remoteUser.banned !== undefined) u.banned = remoteUser.banned;
        if (remoteUser.bannedUntil !== undefined) u.bannedUntil = remoteUser.bannedUntil;
        if (remoteUser.premium !== undefined) u.premium = remoteUser.premium;
        if (remoteUser.superPremium !== undefined) u.superPremium = remoteUser.superPremium;
        if (remoteUser.name) u.name = remoteUser.name;
        saveData(getData());
      }
    }
    if (!areFriends(user.id, friendId)) {
      addFriendship(user.id, friendId, { skipCloud: true });
      added++;
    }
  }
  if (avatarsUpdated) refreshMainUI();
  return added;
}

async function syncUserConversationList() {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  const convIds = await cloudRequest(`/api/user/${user.id}/conversations`);
  if (!Array.isArray(convIds)) return;
  const data = getData();
  let changed = false;
  for (const convId of convIds) {
    if (!data.conversations[convId]) {
      const remoteConv = await cloudFetchConversation(convId);
      if (remoteConv && remoteConv.members && remoteConv.members.includes(user.id)) {
        data.conversations[convId] = remoteConv;
        if (!data.messages[convId]) data.messages[convId] = [];
        saveData(data);
        const remoteMsgs = await cloudFetchMessages(convId, 0);
        for (const msg of remoteMsgs) {
          mergeRemoteMessage(convId, msg);
        }
        changed = true;
      }
    }
  }
  if (changed) saveData(data);
}

async function syncAllConversations() {
  if (!getSyncUrl()) return;
  const user = getCurrentUser();
  if (!user) return;
  if (typeof syncCurrentUserModeration === 'function') await syncCurrentUserModeration();
  const friendsAdded = await syncFriendships();
  await syncUserConversationList();
  const convs = getUserConversations(user.id);
  let total = 0;
  for (const conv of convs) {
    total += await syncConversation(conv.id);
  }
  if (typeof updateTabBadges === 'function') updateTabBadges();
  if (typeof fetchFriendsPresence === 'function') await fetchFriendsPresence();
  refreshUIAfterSync();
  return total + friendsAdded;
}

function refreshUIAfterSync() {
  renderChatList();
  if (currentScreen === 'chat' && currentConvId) {
    renderMessages(currentConvId);
  } else {
    renderFriendList();
    renderProfile();
  }
}

async function cloudSyncAfterSend(convId, msg) {
  if (!getSyncUrl()) return;
  trackPendingMessage(convId, msg.id);
  const data = getData();
  const conv = data.conversations[convId];
  if (conv) await cloudPushConversation(conv);
  await cloudPushMessage(convId, msg);
}

function startGlobalSync() {
  stopGlobalSync();
  if (!getSyncUrl()) return;
  syncAllConversations();
  globalSyncTimer = setInterval(syncAllConversations, 4000);
}

function stopGlobalSync() {
  if (globalSyncTimer) {
    clearInterval(globalSyncTimer);
    globalSyncTimer = null;
  }
}

function startChatSync(convId) {
  stopChatSync();
  if (!getSyncUrl() || !convId) return;
  syncConversation(convId).then(() => {
    if (currentConvId === convId) renderMessages(convId);
  });
  chatSyncTimer = setInterval(async () => {
    await syncConversation(convId);
    if (currentConvId === convId) renderMessages(convId);
    renderChatList();
  }, 2000);
}

function stopChatSync() {
  if (chatSyncTimer) {
    clearInterval(chatSyncTimer);
    chatSyncTimer = null;
  }
}

let syncStatusChecked = false;

function updateSyncStatusUI(forceCheck) {
  const status = document.getElementById('sync-status');
  const input = document.getElementById('input-sync-url');
  if (!status || !input) return;
  input.value = getSyncUrl();
  if (!getSyncUrl()) {
    status.textContent = '未設定 — 他の端末とメッセージを共有するには同期サーバーURLを入力してください';
    status.classList.add('warn');
    return;
  }
  if (!forceCheck && syncStatusChecked) {
    status.textContent = '✓ 同期サーバーに接続済み — 他の端末にもメッセージが届きます';
    status.classList.remove('warn');
    if (!globalSyncTimer) startGlobalSync();
    return;
  }
  status.textContent = '接続確認中…（Renderは起動に最大1分かかることがあります）';
  status.classList.add('warn');
  testSyncConnection(5).then((ok) => {
    syncStatusChecked = !!ok;
    if (ok) {
      status.textContent = '✓ 同期サーバーに接続済み — 他の端末にもメッセージが届きます';
      status.classList.remove('warn');
    } else {
      status.textContent = '同期サーバーに接続できません。「再試行」を押すか、1分待ってから再度お試しください';
      status.classList.add('warn');
    }
    if (!globalSyncTimer) startGlobalSync();
  });
}

// ─── Conversations ───────────────────────────────────────
function getOrCreateDirectConv(id1, id2) {
  const a = String(id1);
  const b = String(id2);
  const data = getData();
  const members = [a, b].sort();
  const convId = getDirectConvId(a, b);
  const existing = data.conversations[convId] || Object.values(data.conversations).find(c =>
    c.type === 'direct' &&
    c.members.length === 2 &&
    c.members.map(m => String(m)).sort().join() === members.join()
  );

  if (existing) {
    if (!data.conversations[convId] && existing.id !== convId) {
      data.conversations[convId] = { ...existing, id: convId, members: members };
      data.messages[convId] = data.messages[existing.id] || [];
      delete data.conversations[existing.id];
      delete data.messages[existing.id];
      saveData(data);
    } else if (existing.members && existing.members.map(m => String(m)).sort().join() !== members.join()) {
      existing.members = members;
      saveData(data);
    }
    cloudPushConversation(data.conversations[convId] || existing);
    return convId;
  }

  data.conversations[convId] = {
    id: convId,
    type: 'direct',
    members: members,
    createdAt: Date.now(),
    lastMessageAt: null,
    lastMessagePreview: null
  };
  data.messages[convId] = [];
  saveData(data);
  cloudPushConversation(data.conversations[convId]);
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
  cloudPushConversation(data.conversations[convId]);
  return convId;
}

function getUserConversations(userId) {
  const data = getData();
  const uid = String(userId);
  return Object.values(data.conversations)
    .filter(c => Array.isArray(c.members) && c.members.some(m => String(m) === uid))
    .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
}

function getConvDisplayName(conv, userId) {
  const data = getData();
  if (conv.type === 'group') return conv.name;
  const uid = String(userId);
  const otherId = conv.members.find(m => String(m) !== uid);
  const other = otherId ? getUser(otherId) : null;
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
function pushMessage(convId, senderId, msgData) {
  const data = getData();
  const conv = data.conversations[convId];
  if (!conv) return null;
  const msg = {
    id: generateId(),
    senderId,
    timestamp: Date.now(),
    type: 'text',
    text: '',
    image: null,
    ...msgData
  };
  if (!data.messages[convId]) data.messages[convId] = [];
  data.messages[convId].push(msg);
  conv.lastMessageAt = msg.timestamp;
  conv.lastMessagePreview = getMessagePreview(msg);
  conv.lastMessageSenderId = senderId;
  try {
    saveData(data);
    if (getSyncUrl()) trackPendingMessage(convId, msg.id);
    cloudSyncAfterSend(convId, msg);
    return msg;
  } catch (e) {
    data.messages[convId].pop();
    showToast('保存に失敗しました。画像サイズを小さくしてください');
    return null;
  }
}

function sendMessage(convId, senderId, text) {
  return pushMessage(convId, senderId, { type: 'text', text: text.trim() });
}

function sendImageMessage(convId, senderId, imageData) {
  return pushMessage(convId, senderId, { type: 'image', image: imageData, text: '' });
}

function getMessages(convId) {
  const data = getData();
  return data.messages[convId] || [];
}

async function deleteMessage(convId, msgId) {
  const user = getCurrentUser();
  if (!user) return false;
  const data = getData();
  const msgs = data.messages[convId];
  if (!msgs) return false;
  const msg = msgs.find(m => m.id === msgId);
  if (!msg || String(msg.senderId) !== String(user.id)) return false;
  data.messages[convId] = msgs.filter(m => m.id !== msgId);
  syncConversationMeta(convId);
  saveData(data);
  if (getSyncUrl()) await cloudDeleteMessage(convId, msgId);
  return true;
}

function syncConversationMeta(convId) {
  const data = getData();
  const conv = data.conversations[convId];
  const messages = data.messages[convId];
  if (!conv || !messages || messages.length === 0) return;
  const last = messages[messages.length - 1];
  conv.lastMessageAt = last.timestamp;
  conv.lastMessagePreview = getMessagePreview(last);
  conv.lastMessageSenderId = last.senderId;
  saveData(data);
}

function getConvPreview(conv, userId) {
  const messages = getMessages(conv.id);
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    const preview = getMessagePreview(last);
    return last.senderId === userId ? 'あなた: ' + preview : preview;
  }
  if (conv.lastMessagePreview) {
    return conv.lastMessageSenderId === userId
      ? 'あなた: ' + conv.lastMessagePreview
      : conv.lastMessagePreview;
  }
  return 'メッセージはありません';
}

function getMessageContentHtml(msg) {
  if (msg.type === 'image' || msg.image) {
    return `
      <div class="message-image-wrap">
        <img src="${msg.image}" alt="写真" class="message-image" loading="lazy">
        <button type="button" class="btn-download-image">⬇ 保存</button>
      </div>`;
  }
  return escapeHtml(msg.text || '');
}

function bindMessageImageEvents(el, msg) {
  if (!(msg.type === 'image' || msg.image)) return;
  const img = el.querySelector('.message-image');
  const btn = el.querySelector('.btn-download-image');
  if (img) {
    img.addEventListener('click', () => openImageViewer(msg.image));
  }
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadImage(msg.image, `bluechat-${msg.id}.jpg`);
    });
  }
}

function createMessageElement(msg, convId, user) {
  if (!user) return null;
  const data = getData();
  const conv = data.conversations[convId];
  const isGroup = conv && conv.type === 'group';
  const isSent = String(msg.senderId) === String(user.id);
  const sender = data.users[msg.senderId];
  const senderLabel = isSent ? 'あなた' : (sender ? sender.name : '不明');
  const showSender = isGroup || isSent;
  const isImage = msg.type === 'image' || msg.image;

  const el = document.createElement('div');
  el.className = `message ${isSent ? 'sent' : 'received'}`;
  el.innerHTML = `
    <div class="message-bubble${isImage ? ' message-bubble-image' : ''}">
      ${showSender ? `<div class="message-sender">${escapeHtml(senderLabel)}</div>` : ''}
      ${getMessageContentHtml(msg)}
    </div>
    <div class="message-meta">
      <span class="message-time">${formatMessageTime(msg.timestamp)}</span>
    </div>
  `;
  bindMessageImageEvents(el, msg);
  return el;
}

function scrollMessagesToBottom() {
  const container = document.getElementById('messages-container');
  if (!container) return;
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function appendMessageToChat(msg, convId) {
  const user = getCurrentUser();
  const container = document.getElementById('messages-container');
  if (!user || !container || !msg) return;
  if (container.querySelector(`[data-msg-id="${msg.id}"]`)) return;

  const messages = getMessages(convId);
  const prev = messages.length > 1 ? messages[messages.length - 2] : null;
  const dateLabel = formatDateLabel(msg.timestamp);
  const prevDateLabel = prev ? formatDateLabel(prev.timestamp) : '';

  if (dateLabel !== prevDateLabel) {
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.innerHTML = `<span>${dateLabel}</span>`;
    container.appendChild(sep);
  }

  const el = createMessageElement(msg, convId, user);
  if (el) {
    el.dataset.msgId = msg.id;
    container.appendChild(el);
  }
  scrollMessagesToBottom(true);
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
  if (id === 'modal-add-friend') stopQrScanner();
  document.getElementById(id).classList.add('hidden');
}

function hideAllModals() {
  stopQrScanner();
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
    syncConversationMeta(conv.id);
    const name = getConvDisplayName(conv, user.id);
    const isGroup = conv.type === 'group';
    const avatarUser = isGroup ? null : getConvAvatarUser(conv, user.id);
    const preview = getConvPreview(conv, user.id);
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      ${avatarHtml(avatarUser, { group: isGroup })}
      <div class="list-info">
        <div class="list-name">${escapeHtml(name)}</div>
        <div class="list-preview">${escapeHtml(preview)}</div>
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
  const nameEl = document.getElementById('profile-name');
  if (nameEl) nameEl.innerHTML = typeof displayNameHtml === 'function' ? displayNameHtml(user) : escapeHtml(user.name);
  document.getElementById('profile-id').textContent = 'ID: ' + user.id;
  updateSyncStatusUI();
}

function renderMessages(convId) {
  const user = getCurrentUser();
  if (!user) return;
  const messages = getMessages(convId);
  const container = document.getElementById('messages-container');
  if (!container) return;
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

    const el = createMessageElement(msg, convId, user);
    if (el) {
      el.dataset.msgId = msg.id;
      container.appendChild(el);
    }
  });
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
  scrollMessagesToBottom(true);
  startChatSync(convId);
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
    item.querySelector('.admin-btn-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`「${user.name}」を削除しますか？関連する会話も削除されます。`)) return;
      if (typeof adminDeleteUser === 'function') {
        if (await adminDeleteUser(user.id)) {
          renderAdminUsers();
          renderAdminConversations();
          showToast('ユーザーを削除しました');
        }
      } else {
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

  adminFocusUserId = userId;

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
    item.addEventListener('click', () => {
      adminFocusUserId = null;
      openAdminChat(conv.id);
    });
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
    item.addEventListener('click', () => {
      adminFocusUserId = null;
      openAdminChat(conv.id);
    });
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
    const isFocusUser = adminFocusUserId && msg.senderId === adminFocusUserId;
    const isImage = msg.type === 'image' || msg.image;
    const el = document.createElement('div');
    el.className = `message ${isFocusUser ? 'sent' : 'received'}`;
    el.innerHTML = `
      <div class="message-bubble${isImage ? ' message-bubble-image' : ''}">
        <div class="message-sender">${escapeHtml(sender ? sender.name : '不明')}</div>
        ${getMessageContentHtml(msg)}
      </div>
      <div class="message-meta">
        <span class="message-time">${formatMessageTime(msg.timestamp)}</span>
      </div>
    `;
    bindMessageImageEvents(el, msg);
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
function bindClick(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', handler);
}

function saveAdminSession() {
  if (adminLoggedIn) localStorage.setItem(ADMIN_SESSION_KEY, '1');
  else localStorage.removeItem(ADMIN_SESSION_KEY);
}

function performAdminLogin() {
  const email = document.getElementById('input-admin-email').value;
  const password = document.getElementById('input-admin-password').value;
  verifyAdminCredentialsAsync(email, password).then((role) => {
    if (!role) {
      if (getEffectiveSyncUrl()) showToast('メールアドレスまたはパスワードが正しくありません');
      return;
    }
    adminLoggedIn = true;
    adminRole = role;
    saveAdminSession();
    document.getElementById('input-admin-email').value = '';
    document.getElementById('input-admin-password').value = '';
    try {
      renderAdminUsers();
      renderAdminConversations();
    } catch (e) {
      console.error(e);
    }
    showScreen('admin');
    showToast('管理者としてログインしました');
  });
}

function setupAdminHandlers() {
  bindClick('link-admin-onboarding', (e) => {
    e.preventDefault();
    returnScreenAfterAdmin = 'onboarding';
    showScreen('admin-login');
  });

  bindClick('link-admin-main', (e) => {
    e.preventDefault();
    returnScreenAfterAdmin = 'main';
    showScreen('admin-login');
  });

  bindClick('btn-admin-back', () => {
    showScreen(returnScreenAfterAdmin);
  });

  bindClick('btn-admin-login', (e) => {
    e.preventDefault();
    performAdminLogin();
  });

  const adminPassword = document.getElementById('input-admin-password');
  if (adminPassword) {
    adminPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') performAdminLogin();
    });
  }

  const adminEmail = document.getElementById('input-admin-email');
  if (adminEmail) {
    adminEmail.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') performAdminLogin();
    });
  }

  bindClick('btn-admin-exit', () => {
    showScreen(returnScreenAfterAdmin);
    if (returnScreenAfterAdmin === 'main') refreshMainUI();
  });

  document.querySelectorAll('[data-admin-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-admin-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentAdminTab = tab.dataset.adminTab;
      document.getElementById('admin-tab-users').classList.toggle('hidden', currentAdminTab !== 'users');
      document.getElementById('admin-tab-conversations').classList.toggle('hidden', currentAdminTab !== 'conversations');
      document.getElementById('admin-tab-feedback').classList.toggle('hidden', currentAdminTab !== 'feedback');
      if (currentAdminTab === 'users') renderAdminUsers();
      if (currentAdminTab === 'conversations') renderAdminConversations();
      if (currentAdminTab === 'feedback' && typeof renderAdminFeedbackScreen === 'function') renderAdminFeedbackScreen();
    });
  });

  bindClick('btn-admin-chat-back', () => {
    adminViewConvId = null;
    showScreen('admin');
  });
}

function init() {
  setupAdminHandlers();
  initSyncFromQuery();

  const user = getCurrentUser();
  if (user) {
    showScreen('main');
    refreshMainUI();
    startGlobalSync();
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
    startGlobalSync();
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

  // Add friend (QR)
  document.getElementById('btn-add-friend').addEventListener('click', () => {
    openAddFriendModal('scan');
  });

  document.getElementById('btn-show-qr').addEventListener('click', () => {
    openAddFriendModal('show');
  });

  document.querySelectorAll('#modal-add-friend .modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchAddFriendTab(tab.dataset.modalTab);
    });
  });

  document.getElementById('btn-start-camera').addEventListener('click', () => {
    startQrScanner();
  });

  document.getElementById('btn-stop-camera').addEventListener('click', () => {
    stopQrScanner();
  });

  document.getElementById('btn-refresh-qr').addEventListener('click', () => {
    renderMyQR();
    showToast('QRコードを更新しました');
  });

  bindClick('btn-submit-invite', () => {
    const code = (document.getElementById('input-friend-invite')?.value || '').trim();
    if (!code) {
      showToast('コードを入力してください');
      return;
    }
    tryRedeemInviteCode(code);
  });

  bindClick('btn-copy-invite', async () => {
    const code = document.getElementById('invite-code-text')?.textContent || '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast('コードをコピーしました');
    } catch (e) {
      showToast('コピーに失敗しました');
    }
  });

  const inputFriendInvite = document.getElementById('input-friend-invite');
  if (inputFriendInvite) {
    inputFriendInvite.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('btn-submit-invite')?.click();
      }
    });
  }

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
    stopChatSync();
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
    if (!user) return;
    const msg = sendMessage(currentConvId, user.id, text);
    msgInput.value = '';
    sendBtn.disabled = true;
    if (msg) {
      appendMessageToChat(msg, currentConvId);
      renderChatList();
    } else {
      renderMessages(currentConvId);
    }
  });

  const chatImageInput = document.getElementById('input-chat-image');
  document.getElementById('btn-attach-image').addEventListener('click', () => {
    chatImageInput.click();
  });

  chatImageInput.addEventListener('change', async () => {
    const file = chatImageInput.files[0];
    chatImageInput.value = '';
    if (!file || !currentConvId) return;
    if (!file.type.startsWith('image/')) {
      showToast('画像ファイルを選択してください');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      showToast('15MB以下の画像を選択してください');
      return;
    }
    try {
      const dataUrl = await compressChatImage(file);
      const user = getCurrentUser();
      if (!user) return;
      const msg = sendImageMessage(currentConvId, user.id, dataUrl);
      if (msg) {
        appendMessageToChat(msg, currentConvId);
        renderChatList();
        showToast('写真を送信しました');
      }
    } catch (e) {
      showToast('画像の送信に失敗しました');
    }
  });

  document.getElementById('btn-download-full-image').addEventListener('click', () => {
    const src = document.getElementById('btn-download-full-image').dataset.imageSrc;
    if (src) downloadImage(src, 'bluechat-photo.jpg');
  });

  document.getElementById('btn-save-sync').addEventListener('click', async () => {
    const url = document.getElementById('input-sync-url').value.trim();
    setSyncUrl(url);
    stopGlobalSync();
    stopChatSync();
    syncStatusChecked = false;
    if (url) {
      const ok = await testSyncConnection();
      syncStatusChecked = !!ok;
      if (ok) {
        showToast('同期サーバーを設定しました');
        startGlobalSync();
        await syncAllConversations();
        refreshMainUI();
      } else {
        showToast('同期サーバーに接続できません');
      }
    } else {
      localStorage.removeItem(SYNC_CONFIGURED_KEY);
      showToast('同期をオフにしました');
    }
    updateSyncStatusUI(true);
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

  _afterInitCallbacks.forEach(fn => {
    try { fn(); } catch (err) { console.error('BlueChat init extension error:', err); }
  });
}
