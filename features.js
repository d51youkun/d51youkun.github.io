/**
 * BlueChat extended features
 */

const LINE_STICKER_SHOP_URL = 'https://creator.line.me/ja/';
const STICKER_PACKS = [
  { id: 'emoji', name: '基本', stickers: ['😀','😂','🥰','😍','🤔','😭','👍','👏','🎉','❤️','🔥','✨','🙏','💪','🎵','🌸','🍕','⚽','🐱','🐶'] },
  { id: 'blue', name: 'ブルー', stickers: ['💙','🫧','🌊','🐳','💎','🧊','🌀','🦋','🫐','🎐'] }
];

let callPollTimer = null;
let callConnectTimeout = null;
let peerConnection = null;
let localStream = null;
let callState = { active: false, type: null, remoteUserId: null, convId: null };
let transferScanner = null;
let transferScanHandled = false;
let pendingIncomingCall = null;
let ringToneTimer = null;
let audioCtx = null;

// ─── Notifications ───────────────────────────────────────
function notificationsSupported() {
  return typeof Notification !== 'undefined';
}

async function requestNotificationPermission() {
  if (!notificationsSupported()) {
    showToast('このブラウザは通知に対応していません');
    return false;
  }
  if (Notification.permission === 'granted') {
    showToast('通知はすでに許可されています');
    updateNotifyButtonLabel();
    return true;
  }
  if (Notification.permission === 'denied') {
    showToast('通知がブロックされています。ブラウザの設定から許可してください');
    return false;
  }
  const result = await Notification.requestPermission();
  updateNotifyButtonLabel();
  if (result === 'granted') {
    showToast('通知を許可しました');
    registerServiceWorker();
    return true;
  }
  showToast('通知が許可されませんでした');
  return false;
}

function updateNotifyButtonLabel() {
  const btn = document.getElementById('btn-enable-notify');
  if (!btn) return;
  const label = btn.querySelector('span:last-child');
  if (!label) return;
  if (!notificationsSupported()) {
    label.textContent = '通知非対応';
    btn.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    label.textContent = '通知：許可済み ✓';
  } else if (Notification.permission === 'denied') {
    label.textContent = '通知：ブロック中';
  } else {
    label.textContent = '通知を許可する';
  }
}

function showAppNotification(title, body, options = {}) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const { tag, onClick, convId } = options;
  const n = new Notification(title, {
    body,
    tag: tag || 'bluechat',
    icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#4a90d9" width="100" height="100" rx="20"/><text x="50" y="68" font-size="50" text-anchor="middle" fill="white">💬</text></svg>'),
    data: { convId, url: location.href }
  });
  n.onclick = () => {
    window.focus();
    n.close();
    if (typeof onClick === 'function') onClick();
  };
}

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

function playTone(freq, durationSec) {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + durationSec);
}

function playMessageSound() {
  playTone(880, 0.08);
  setTimeout(() => playTone(1100, 0.1), 90);
}

function startRingtone() {
  stopRingtone();
  const ring = () => {
    playTone(800, 0.2);
    setTimeout(() => playTone(1000, 0.2), 220);
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  };
  ring();
  ringToneTimer = setInterval(ring, 2200);
}

function stopRingtone() {
  if (ringToneTimer) {
    clearInterval(ringToneTimer);
    ringToneTimer = null;
  }
  if (navigator.vibrate) navigator.vibrate(0);
}

function shouldNotifyForConv(convId) {
  const chatScreen = document.getElementById('screen-chat');
  const onChat = chatScreen && !chatScreen.classList.contains('hidden') && currentConvId === convId;
  return document.hidden || !onChat;
}

function onNewMessageReceived(convId, msg) {
  const user = getCurrentUser();
  if (!user || String(msg.senderId) === String(user.id)) return;
  if (!shouldNotifyForConv(convId)) return;
  const conv = getData().conversations[convId];
  if (!conv) return;
  const name = getConvDisplayName(conv, user.id);
  const preview = getMessagePreview(msg);
  playMessageSound();
  showAppNotification(name, preview, {
    tag: 'msg-' + convId,
    convId,
    onClick: () => openChat(convId)
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register('sw.js?v=BlueChatX');
  } catch (e) { /* ignore */ }
}

function setupNotificationClickHandler() {
  if (!navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'notification-click' && e.data.convId) {
      openChat(e.data.convId);
    }
  });
}

function getEffectiveSyncUrl() {
  const u = getSyncUrl();
  if (u) return u;
  if (DEFAULT_SYNC_URL && DEFAULT_SYNC_URL !== '__DEFAULT_SYNC_URL__') return DEFAULT_SYNC_URL;
  return '';
}

const ADMIN_TOKEN_KEY = 'bluechat_admin_token';

function ensureSyncUrlForRestore() {
  if (!getSyncUrl() && typeof DEFAULT_SYNC_URL === 'string' && DEFAULT_SYNC_URL && DEFAULT_SYNC_URL !== '__DEFAULT_SYNC_URL__') {
    setSyncUrl(DEFAULT_SYNC_URL);
  }
}

function getAdminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) || '';
}

function saveAdminToken(token) {
  if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
  else localStorage.removeItem(ADMIN_TOKEN_KEY);
}

async function adminCloudRequest(path, options = {}, timeoutMs = 120000) {
  const base = getEffectiveSyncUrl();
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getAdminToken(),
        ...(options.headers || {})
      }
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pullServerSyncBundle(userId) {
  ensureSyncUrlForRestore();
  if (!getEffectiveSyncUrl()) return null;
  return cloudRequestExt(`/api/user/${encodeURIComponent(userId)}/sync-bundle`, {}, 120000);
}

async function restoreAccountByUserId(userId, password) {
  const uid = String(userId || '').trim();
  if (!uid) return { error: 'ユーザーIDを入力してください' };
  ensureSyncUrlForRestore();
  if (!getEffectiveSyncUrl()) {
    return { error: '同期サーバーに接続できません。マイページでURLを確認してください' };
  }

  const cloud = await fetchCloudBackup(uid);
  if (cloud && cloud.backup && cloud.backup.data) {
    const backup = cloud.backup;
    if (backup.passwordHash) {
      if (password === null || password === undefined) return { error: 'パスワードが必要です' };
      if (backup.passwordHash !== simpleHash(password || '')) {
        return { error: 'パスワードが正しくありません' };
      }
    }
    try {
      importTransferBackup(backup);
      return { success: true, source: 'cloud' };
    } catch (e) {
      return { error: e.message || 'クラウド復元に失敗しました' };
    }
  }

  const bundle = await pullServerSyncBundle(uid);
  if (bundle && bundle.data) {
    try {
      importTransferBackup(bundle);
      return { success: true, source: 'server' };
    } catch (e) {
      return { error: e.message || 'サーバーからの復元に失敗しました' };
    }
  }

  return { error: 'バックアップが見つかりません。古い端末で一度アプリを開いてください' };
}

function finishAccountRestore(result) {
  if (result.error) {
    showToast(result.error);
    return false;
  }
  hideModal('modal-transfer-scan');
  stopTransferScanner();
  showScreen('main');
  refreshMainUI();
  startGlobalSync();
  if (typeof startPresenceHeartbeat === 'function') startPresenceHeartbeat();
  if (typeof scheduleCloudBackup === 'function') scheduleCloudBackup();
  showToast('引き継ぎが完了しました！');
  return true;
}

async function redeemTransferCodeExt(code) {
  const raw = String(code || '').trim();
  if (!raw) return { error: 'コードを入力してください' };
  ensureSyncUrlForRestore();

  let transferCode = raw;
  if (!raw.includes(TRANSFER_PREFIX)) {
    const short = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (short.length >= 6 && short.length <= 12) {
      const shortRes = await cloudRequestExt(`/api/transfer-short/${encodeURIComponent(short)}`, {}, 120000);
      if (shortRes && shortRes.code) transferCode = shortRes.code;
      else if (shortRes && shortRes.backup) {
        try {
          importTransferBackup(shortRes.backup);
          return { success: true };
        } catch (e) {
          return { error: e.message || '復元に失敗しました' };
        }
      }
    }
    if (!transferCode.includes(TRANSFER_PREFIX) && /^[a-z0-9]{10,}$/i.test(raw)) {
      transferCode = TRANSFER_PREFIX + raw;
    }
  }

  if (typeof redeemTransferCode === 'function') {
    return redeemTransferCode(transferCode);
  }
  return { error: '引き継ぎ機能が利用できません' };
}

async function verifyAdminCredentialsAsync(email, password) {
  const base = getEffectiveSyncUrl();
  if (!base) {
    showToast('管理者ログインには同期サーバーの設定が必要です');
    return null;
  }
  try {
    const res = await fetch(base + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: String(email || '').trim(),
        password: String(password || '')
      })
    });
    if (res.status === 401) return null;
    if (!res.ok) {
      showToast('認証サーバーに接続できません');
      return null;
    }
    const data = await res.json();
    if (data.token) saveAdminToken(data.token);
    return data.role ? { role: data.role, token: data.token } : null;
  } catch (e) {
    showToast('認証サーバーに接続できません');
    return null;
  }
}

async function cloudRequestExt(path, options = {}, timeoutMs = 45000) {
  const base = getEffectiveSyncUrl();
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function loadAdminSession() {
  adminLoggedIn = localStorage.getItem(ADMIN_SESSION_KEY) === '1';
}

function saveAdminSession() {
  if (adminLoggedIn) localStorage.setItem(ADMIN_SESSION_KEY, '1');
  else localStorage.removeItem(ADMIN_SESSION_KEY);
}

function updateAdminTabVisibility() {
  const tab = document.getElementById('tab-admin-nav');
  const linkMain = document.getElementById('link-admin-main');
  const linkOnboard = document.getElementById('link-admin-onboarding');
  if (tab) tab.classList.toggle('hidden', !adminLoggedIn);
  if (linkMain) linkMain.classList.toggle('hidden', adminLoggedIn);
  if (linkOnboard) linkOnboard.classList.toggle('hidden', adminLoggedIn);
}

function showMainAdminTab() {
  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
  const adminTab = document.querySelector('.tab[data-tab="admin"]');
  if (adminTab) adminTab.classList.add('active');
  currentTab = 'admin';
  document.querySelectorAll('#screen-main .tab-content').forEach(c => c.classList.add('hidden'));
  const panel = document.getElementById('tab-admin');
  if (panel) panel.classList.remove('hidden');
  renderAdminUsers();
  renderAdminConversations();
  if (typeof renderAdminFeedback === 'function') renderAdminFeedback();
}

// Override admin login flow — v4.js で上書き

// ─── Read receipts ─────────────────────────────────────────
function getReadReceipts(convId) {
  const data = getData();
  if (!data.readReceipts) data.readReceipts = {};
  if (!data.readReceipts[convId]) data.readReceipts[convId] = {};
  return data.readReceipts[convId];
}

async function markConversationRead(convId) {
  const user = getCurrentUser();
  if (!user || !convId) return;
  const data = getData();
  if (!data.readReceipts) data.readReceipts = {};
  if (!data.readReceipts[convId]) data.readReceipts[convId] = {};
  data.readReceipts[convId][user.id] = Date.now();
  saveData(data);
  if (getSyncUrl()) {
    await cloudRequest(`/api/reads/${convId}/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ timestamp: Date.now() })
    });
  }
}

async function syncReadReceipts(convId) {
  if (!getSyncUrl() || !convId) return;
  const remote = await cloudRequest(`/api/reads/${convId}`);
  if (!remote || typeof remote !== 'object') return;
  const data = getData();
  if (!data.readReceipts) data.readReceipts = {};
  if (!data.readReceipts[convId]) data.readReceipts[convId] = {};
  let changed = false;
  for (const [uid, ts] of Object.entries(remote)) {
    if ((data.readReceipts[convId][uid] || 0) < ts) {
      data.readReceipts[convId][uid] = ts;
      changed = true;
    }
  }
  if (changed) saveData(data);
}

function isMessageReadByOther(msg, convId, myId) {
  const conv = getData().conversations[convId];
  if (!conv || String(msg.senderId) !== String(myId)) return false;
  const reads = getReadReceipts(convId);
  const others = conv.members.filter(m => String(m) !== String(myId));
  if (others.length === 0) return false;
  return others.every(uid => (reads[uid] || 0) >= msg.timestamp);
}

// ─── Extended message rendering ──────────────────────────
function getMessageContentHtmlExt(msg) {
  if (msg.type === 'sticker') {
    if (msg.stickerImage) {
      return `<img src="${msg.stickerImage}" class="message-sticker-img" alt="スタンプ">`;
    }
    return `<div class="message-sticker">${msg.stickerEmoji || '🎨'}</div>`;
  }
  if (msg.type === 'video' && msg.video) {
    return `<video src="${msg.video}" class="message-video" controls playsinline></video>`;
  }
  if (msg.type === 'file' && msg.fileData) {
    const name = escapeHtml(msg.fileName || 'file');
    return `<a href="${msg.fileData}" download="${name}" class="message-file-link">📎 ${name}</a>`;
  }
  if (msg.type === 'image' || msg.image) {
    return `
      <div class="message-image-wrap">
        <img src="${msg.image}" alt="写真" class="message-image" loading="lazy">
        <button type="button" class="btn-download-image">⬇ 保存</button>
      </div>`;
  }
  return escapeHtml(msg.text || '');
}

function createMessageElementExt(msg, convId, user) {
  if (!user) return null;
  const data = getData();
  const conv = data.conversations[convId];
  const isGroup = conv && conv.type === 'group';
  const isSent = String(msg.senderId) === String(user.id);
  const sender = data.users[msg.senderId];
  const showSender = isGroup || isSent || (sender && (
    typeof userHasTalkBadge === 'function' ? userHasTalkBadge(sender) : (
      !!(sender.title && sender.title.text) || !!sender.premium || !!sender.superPremium
    )
  ));
  const senderHtml = typeof messageSenderHtml === 'function'
    ? messageSenderHtml(msg, convId, user)
    : escapeHtml(isSent ? 'あなた' : (sender ? sender.name : '不明'));
  const isMedia = ['image', 'video', 'sticker'].includes(msg.type) || msg.image;

  const readLabel = isSent && isMessageReadByOther(msg, convId, user.id)
    ? '<span class="read-badge">既読</span>' : '';

  const el = document.createElement('div');
  el.className = `message ${isSent ? 'sent' : 'received'}`;
  el.dataset.msgId = msg.id;
  el.innerHTML = `
    <div class="message-bubble${isMedia ? ' message-bubble-image' : ''}">
      ${showSender ? `<div class="message-sender">${senderHtml}</div>` : ''}
      ${getMessageContentHtmlExt(msg)}
      ${isSent ? '<button type="button" class="btn-delete-message" aria-label="削除">×</button>' : ''}
    </div>
    <div class="message-meta">
      ${readLabel}
      <span class="message-time">${formatMessageTime(msg.timestamp)}</span>
    </div>
  `;
  bindMessageImageEvents(el, msg);
  const fileLink = el.querySelector('.message-file-link');
  if (fileLink) {
    fileLink.addEventListener('click', (e) => {
      e.preventDefault();
      downloadImage(msg.fileData, msg.fileName || 'file');
    });
  }
  const delBtn = el.querySelector('.btn-delete-message');
  if (delBtn) {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('このメッセージを削除しますか？')) return;
      if (await deleteMessage(convId, msg.id)) {
        el.remove();
        renderChatList();
        showToast('メッセージを削除しました');
      }
    });
  }
  return el;
}

createMessageElement = createMessageElementExt;
getMessageContentHtml = getMessageContentHtmlExt;

const _mergeRemoteMessageOrig = mergeRemoteMessage;
mergeRemoteMessage = function (convId, remoteMsg) {
  const added = _mergeRemoteMessageOrig(convId, remoteMsg);
  if (added) {
    onNewMessageReceived(convId, remoteMsg);
    if (currentScreen === 'chat' && currentConvId === convId) {
      appendMessageToChat(remoteMsg, convId);
    }
  }
  return added;
};

const _openChatOrig = openChat;
openChat = function (convId) {
  _openChatOrig(convId);
  markConversationRead(convId);
  syncReadReceipts(convId).then(() => renderMessages(convId));
  updateCallButtons(convId);
};

const _renderMessagesOrig = renderMessages;
renderMessages = function (convId) {
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
  scrollMessagesToBottom(true);
};

// Patch chat sync to include reads
const _syncConversationOrig = syncConversation;
syncConversation = async function (convId) {
  const added = await _syncConversationOrig(convId);
  await syncReadReceipts(convId);
  if (currentConvId === convId) renderMessages(convId);
  return added;
};

// ─── Video / file messages ───────────────────────────────
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('読み込み失敗'));
    reader.readAsDataURL(file);
  });
}

function sendVideoMessage(convId, senderId, videoData) {
  return pushMessage(convId, senderId, { type: 'video', video: videoData, text: '' });
}

function sendFileMessage(convId, senderId, fileData, fileName, mimeType) {
  return pushMessage(convId, senderId, {
    type: 'file', fileData, fileName, mimeType, text: ''
  });
}

function sendStickerMessage(convId, senderId, emoji) {
  return pushMessage(convId, senderId, { type: 'sticker', stickerEmoji: emoji, text: '' });
}

function renderStickerPicker() {
  const grid = document.getElementById('sticker-grid');
  if (!grid) return;
  grid.innerHTML = '';
  STICKER_PACKS.forEach(pack => {
    pack.stickers.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sticker-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        const user = getCurrentUser();
        if (!user || !currentConvId) return;
        const msg = sendStickerMessage(currentConvId, user.id, emoji);
        if (msg) {
          appendMessageToChat(msg, currentConvId);
          renderChatList();
        }
        hideModal('modal-stickers');
      });
      grid.appendChild(btn);
    });
  });
}

// ─── Device transfer ───────────────────────────────────────
function buildTransferBackup() {
  const data = getData();
  const syncUrl = getSyncUrl();
  return {
    version: 2,
    exportedAt: Date.now(),
    syncUrl,
    data: {
      currentUserId: data.currentUserId,
      users: data.users,
      friendCodes: data.friendCodes || {},
      friendships: data.friendships,
      conversations: data.conversations,
      messages: data.messages,
      readReceipts: data.readReceipts || {},
      customStickerPacks: data.customStickerPacks || [],
      titlePresets: data.titlePresets || []
    }
  };
}

function importTransferBackup(backup) {
  if (!backup) throw new Error('無効なバックアップ');
  if (backup.cloudBackupUserId && !backup.data) {
    throw new Error('クラウド参照のみのバックアップです');
  }
  if (!backup.data) throw new Error('無効なバックアップ');
  const payload = backup.data;
  if (!payload.currentUserId || !payload.users || !payload.users[payload.currentUserId]) {
    throw new Error('バックアップにユーザー情報がありません');
  }
  const merged = {
    currentUserId: payload.currentUserId,
    users: payload.users || {},
    friendCodes: payload.friendCodes || {},
    friendships: payload.friendships || [],
    conversations: payload.conversations || {},
    messages: payload.messages || {},
    readReceipts: payload.readReceipts || {},
    customStickerPacks: payload.customStickerPacks || [],
    titlePresets: payload.titlePresets || []
  };
  try {
    saveData(merged);
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      throw new Error('この端末の保存容量が足りません。ブラウザのデータを削除するか、別のブラウザをお試しください');
    }
    throw e;
  }
  if (backup.syncUrl && !localStorage.getItem(SYNC_CONFIGURED_KEY)) setSyncUrl(backup.syncUrl);
  localStorage.removeItem(ACTIVITY_VERSION_KEY);
}

async function createTransferSession() {
  if (!getEffectiveSyncUrl()) {
    showToast('引き継ぎには同期サーバーURLの設定が必要です');
    return null;
  }
  const token = generateId() + generateId();
  const backup = buildTransferBackup();
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
  createTransferSession().then(code => {
    if (!code) return;
    const container = document.getElementById('transfer-qr-canvas');
    if (!container) return;
    container.innerHTML = '';
    document.getElementById('transfer-code-text').textContent = code;
    new QRCode(container, {
      text: code,
      width: 220,
      height: 220,
      colorDark: '#1a6fd4',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L
    });
    pollTransferConsumed(code.slice(TRANSFER_PREFIX.length));
  });
}

async function pollTransferConsumed(token) {
  if (!getEffectiveSyncUrl()) return;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const status = await cloudRequestExt(`/api/transfer/${token}/status`);
    if (status && status.consumed) {
      hideModal('modal-transfer-qr');
      const keep = confirm('引き継ぎが完了しました。\nこの端末のデータを残しますか？\n\nOK＝残す / キャンセル＝削除');
      if (!keep) {
        resetAllData();
        localStorage.removeItem(ADMIN_SESSION_KEY);
        showScreen('onboarding');
        showToast('この端末のデータを削除しました');
      } else {
        showToast('引き継ぎ完了。この端末のデータは残しています');
      }
      return;
    }
  }
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
  try {
    importTransferBackup(result.backup);
    await cloudRequestExt(`/api/transfer/${token}/consumed`, { method: 'POST', body: '{}' });
    return { success: true };
  } catch (e) {
    return { error: 'データの復元に失敗しました' };
  }
}

function parseTransferCodeFromScan(raw) {
  const text = String(raw || '').trim();
  const idx = text.indexOf(TRANSFER_PREFIX);
  if (idx < 0) return null;
  return text.slice(idx).split(/\s/)[0].trim();
}

function handleTransferRedeemResult(result) {
  if (result.error) {
    showToast(result.error);
    transferScanHandled = false;
    qrScanHandled = false;
    const modal = document.getElementById('modal-transfer-scan');
    if (modal && !modal.classList.contains('hidden')) {
      setTimeout(() => startQrScannerForTransfer(), 400);
    }
    return;
  }
  hideModal('modal-transfer-scan');
  stopTransferScanner();
  showScreen('main');
  refreshMainUI();
  startGlobalSync();
  if (typeof startPresenceHeartbeat === 'function') startPresenceHeartbeat();
  if (typeof scheduleCloudBackup === 'function') scheduleCloudBackup();
  showToast('引き継ぎが完了しました！');
}

function openTransferScanModal() {
  ensureSyncUrlForRestore();
  if (typeof stopQrScanner === 'function') stopQrScanner();
  stopTransferScanner();
  transferScanHandled = false;
  qrScanHandled = false;
  showModal('modal-transfer-scan');
  setTimeout(() => startQrScannerForTransfer(), 350);
}

function restoreByUserIdFromModal() {
  ensureSyncUrlForRestore();
  const userId = document.getElementById('input-transfer-user-id')?.value?.trim() || '';
  if (!userId) {
    showToast('ユーザーIDを入力してください');
    return;
  }
  const password = prompt('引き継ぎパスワード（未設定なら空欄でOK）');
  if (password === null) return;
  showToast('サーバーから復元中…');
  restoreAccountByUserId(userId, password).then(finishAccountRestore);
}

async function startQrScannerForTransfer() {
  if (typeof Html5Qrcode === 'undefined') {
    showToast('QRスキャナーを読み込めませんでした');
    return;
  }
  if (!window.isSecureContext) {
    showToast('カメラはHTTPSまたはlocalhostでのみ使えます');
    return;
  }
  const modal = document.getElementById('modal-transfer-scan');
  if (!modal || modal.classList.contains('hidden')) return;

  if (typeof stopQrScanner === 'function') {
    try { await stopQrScanner(); } catch (e) { /* ignore */ }
  }
  await stopTransferScanner();
  transferScanHandled = false;

  if (!document.getElementById('qr-reader-transfer')) return;

  const config = { fps: 10, qrbox: { width: 220, height: 220 }, aspectRatio: 1.0 };
  const onSuccess = (text) => onTransferScanSuccess(text);
  const onError = () => {};

  try {
    transferScanner = new Html5Qrcode('qr-reader-transfer', { verbose: false });
    try {
      await transferScanner.start({ facingMode: 'environment' }, config, onSuccess, onError);
      return;
    } catch (e1) {
      try {
        await transferScanner.start({ facingMode: 'user' }, config, onSuccess, onError);
        return;
      } catch (e2) {
        const cameras = await Html5Qrcode.getCameras();
        if (cameras && cameras.length) {
          const back = cameras.find(c => /back|rear|環境/i.test(c.label || ''));
          const camId = (back || cameras[cameras.length - 1]).id;
          await transferScanner.start(camId, config, onSuccess, onError);
          return;
        }
        throw e2;
      }
    }
  } catch (e) {
    transferScanner = null;
    showToast('カメラを起動できません。下のコード入力も使えます');
  }
}

async function stopTransferScanner() {
  if (!transferScanner) return;
  try {
    if (transferScanner.isScanning) await transferScanner.stop();
    transferScanner.clear();
  } catch (e) { /* ignore */ }
  transferScanner = null;
}

function onTransferScanSuccess(decodedText) {
  if (transferScanHandled) return;
  const code = parseTransferCodeFromScan(decodedText);
  if (!code) return;
  transferScanHandled = true;
  qrScanHandled = true;
  stopTransferScanner();
  showToast('引き継ぎ中…');
  redeemTransferCodeExt(code).then(handleTransferRedeemResult);
}

// ─── WebRTC calls ────────────────────────────────────────
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function updateCallButtons(convId) {
  const bar = document.getElementById('chat-call-bar');
  if (!bar) return;
  const user = getCurrentUser();
  const conv = getData().conversations[convId];
  const isDirect = conv && conv.type === 'direct';
  bar.classList.toggle('hidden', !isDirect);
}

async function sendCallSignal(toUserId, type, payload) {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl()) return;
  const req = typeof cloudRequestExt === 'function' ? cloudRequestExt : cloudRequest;
  await req('/api/call/signal', {
    method: 'POST',
    body: JSON.stringify({ from: user.id, to: toUserId, type, payload, timestamp: Date.now() })
  }, 60000);
}

function getOtherUserIdInConv(convId) {
  const user = getCurrentUser();
  const conv = getData().conversations[convId];
  if (!conv || conv.type !== 'direct') return null;
  return conv.members.find(m => String(m) !== String(user.id)) || null;
}

function showCallOverlay(title, sub) {
  document.getElementById('call-overlay-title').textContent = title;
  document.getElementById('call-overlay-sub').textContent = sub || '';
  document.getElementById('modal-call').classList.remove('hidden');
}

function updateCallOverlaySub(sub) {
  const el = document.getElementById('call-overlay-sub');
  if (el) el.textContent = sub || '';
}

function normalizeSdp(sdp) {
  if (!sdp) return null;
  if (typeof sdp === 'object' && sdp.type && sdp.sdp) return sdp;
  return sdp;
}

function rewindCallSignalSince() {
  lastSignalTs = Math.min(lastSignalTs, Date.now() - 30000);
}

function clearCallConnectTimeout() {
  if (callConnectTimeout) {
    clearTimeout(callConnectTimeout);
    callConnectTimeout = null;
  }
}

function startCallConnectTimeout(callType) {
  clearCallConnectTimeout();
  callConnectTimeout = setTimeout(() => {
    if (!peerConnection || !callState.active) return;
    const ice = peerConnection.iceConnectionState;
    if (ice === 'connected' || ice === 'completed') return;
    updateCallOverlaySub('接続に失敗しました');
    showToast('通話の接続がタイムアウトしました');
    setTimeout(() => endCall(), 2000);
  }, 35000);
}

function setupCallConnectionHandlers(pc, callType) {
  const connectedLabel = callType === 'video' ? 'ビデオ通話中' : '音声通話中';
  const onConnected = () => {
    updateCallOverlaySub(connectedLabel);
    clearCallConnectTimeout();
  };
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') onConnected();
    else if (s === 'failed') {
      updateCallOverlaySub('接続に失敗しました');
      showToast('通話の接続に失敗しました');
      setTimeout(() => endCall(), 2000);
    } else if (s === 'checking' || s === 'new') {
      updateCallOverlaySub('接続中…');
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') onConnected();
    else if (pc.connectionState === 'failed') {
      showToast('通話を確立できませんでした');
      setTimeout(() => endCall(), 2000);
    }
  };
}

function attachCallPeerHandlers(pc, remoteUserId, callType) {
  setupCallConnectionHandlers(pc, callType);
  pc.ontrack = (e) => {
    const remoteV = document.getElementById('call-remote-video');
    if (remoteV) {
      remoteV.srcObject = e.streams[0];
      remoteV.classList.toggle('hidden', callType !== 'video');
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) sendCallSignal(remoteUserId, 'ice', { candidate: e.candidate.toJSON() });
  };
}

function hideCallOverlay() {
  document.getElementById('modal-call').classList.add('hidden');
  const localV = document.getElementById('call-local-video');
  const remoteV = document.getElementById('call-remote-video');
  if (localV) localV.srcObject = null;
  if (remoteV) remoteV.srcObject = null;
}

async function endCall() {
  clearCallConnectTimeout();
  if (callState.remoteUserId) {
    await sendCallSignal(callState.remoteUserId, 'hangup', {});
  }
  pendingIncomingCall = null;
  stopRingtone();
  hideIncomingCallUI();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  callState = { active: false, type: null, remoteUserId: null, convId: null };
  hideCallOverlay();
  stopCallPolling();
}

function hideIncomingCallUI() {
  const modal = document.getElementById('modal-incoming-call');
  if (modal) modal.classList.add('hidden');
}

function showIncomingCallUI(sig) {
  const caller = getUser(sig.from);
  const name = caller?.name || '不明';
  const callType = sig.payload?.callType || 'audio';
  const titleEl = document.getElementById('incoming-call-title');
  const subEl = document.getElementById('incoming-call-sub');
  const iconEl = document.querySelector('.incoming-call-icon');
  if (titleEl) titleEl.textContent = callType === 'video' ? 'ビデオ通話の着信' : '音声通話の着信';
  if (subEl) subEl.textContent = `${name} さんから`;
  if (iconEl) iconEl.textContent = callType === 'video' ? '📹' : '📞';
  document.getElementById('modal-incoming-call')?.classList.remove('hidden');
  startRingtone();
  showAppNotification(
    `${name}から着信`,
    callType === 'video' ? 'ビデオ通話' : '音声通話',
    { tag: 'incoming-call' }
  );
}

async function acceptIncomingOffer(sig) {
  const callType = sig.payload?.callType || 'audio';
  const user = getCurrentUser();
  const convId = user ? getDirectConvId(user.id, sig.from) : null;
  if (convId) openChat(convId);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video'
    });
  } catch (e) {
    await sendCallSignal(sig.from, 'hangup', {});
    showToast('マイク/カメラの許可が必要です');
    return;
  }

  callState = {
    active: true,
    type: callType,
    remoteUserId: sig.from,
    convId: convId || currentConvId
  };
  peerConnection = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

  const localV = document.getElementById('call-local-video');
  if (localV) {
    if (callType === 'video') {
      localV.srcObject = localStream;
      localV.classList.remove('hidden');
    } else {
      localV.classList.add('hidden');
    }
  }

  attachCallPeerHandlers(peerConnection, sig.from, callType);

  await peerConnection.setRemoteDescription(normalizeSdp(sig.payload.sdp));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  await sendCallSignal(sig.from, 'answer', { sdp: answer });
  if (typeof flushIceCandidates === 'function') await flushIceCandidates(peerConnection);
  rewindCallSignalSince();
  showCallOverlay(callType === 'video' ? 'ビデオ通話中' : '音声通話中', '接続中…');
  startCallConnectTimeout(callType);
  startCallPolling();
}

async function declineIncomingCall() {
  stopRingtone();
  hideIncomingCallUI();
  if (pendingIncomingCall) {
    await sendCallSignal(pendingIncomingCall.from, 'hangup', {});
    pendingIncomingCall = null;
  }
}

async function answerIncomingCall() {
  if (!pendingIncomingCall) return;
  const sig = pendingIncomingCall;
  pendingIncomingCall = null;
  stopRingtone();
  hideIncomingCallUI();
  await acceptIncomingOffer(sig);
}

async function startCall(type) {
  if (!currentConvId || !getEffectiveSyncUrl()) {
    showToast('通話には同期サーバーが必要です');
    return;
  }
  const remoteId = getOtherUserIdInConv(currentConvId);
  if (!remoteId) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video'
    });
  } catch (e) {
    showToast('マイク/カメラの許可が必要です');
    return;
  }
  callState = { active: true, type, remoteUserId: remoteId, convId: currentConvId };
  peerConnection = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
  const localV = document.getElementById('call-local-video');
  if (localV && type === 'video') {
    localV.srcObject = localStream;
    localV.classList.remove('hidden');
  } else if (localV) localV.classList.add('hidden');

  attachCallPeerHandlers(peerConnection, remoteId, type);

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await sendCallSignal(remoteId, 'offer', { sdp: offer, callType: type });
  rewindCallSignalSince();
  showCallOverlay(type === 'video' ? 'ビデオ通話中' : '音声通話中', '接続中…');
  startCallConnectTimeout(type);
  startCallPolling();
  showToast('発信中…');
}

async function handleCallSignal(sig) {
  const user = getCurrentUser();
  if (!user || !sig || String(sig.to) !== String(user.id)) return;

  if (sig.type === 'hangup') {
    if (pendingIncomingCall && String(pendingIncomingCall.from) === String(sig.from)) {
      pendingIncomingCall = null;
      stopRingtone();
      hideIncomingCallUI();
    }
    if (callState.active) endCall();
    return;
  }

  if (sig.type === 'offer' && !callState.active && !pendingIncomingCall) {
    pendingIncomingCall = sig;
    showIncomingCallUI(sig);
    return;
  }

  if (sig.type === 'answer' && peerConnection && !peerConnection.remoteDescription) {
    await peerConnection.setRemoteDescription(normalizeSdp(sig.payload.sdp));
    if (typeof flushIceCandidates === 'function') await flushIceCandidates(peerConnection);
  } else if (sig.type === 'ice' && peerConnection && sig.payload?.candidate) {
    if (!peerConnection.remoteDescription) return;
    try {
      await peerConnection.addIceCandidate(sig.payload.candidate);
    } catch (e) { /* ignore */ }
  }
}

let lastSignalTs = 0;
function startCallPolling() {
  stopCallPolling();
  const req = typeof cloudRequestExt === 'function' ? cloudRequestExt : cloudRequest;
  const poll = async () => {
    const user = getCurrentUser();
    if (!user || !getEffectiveSyncUrl() || !callState.active) return;
    const signals = await req(`/api/call/signals/${user.id}?since=${lastSignalTs}`, {}, 60000);
    if (Array.isArray(signals)) {
      for (const sig of signals) {
        lastSignalTs = Math.max(lastSignalTs, sig.timestamp || 0);
        await handleCallSignal(sig);
      }
    }
  };
  poll();
  callPollTimer = setInterval(poll, 800);
}

function stopCallPolling() {
  if (callPollTimer) {
    clearInterval(callPollTimer);
    callPollTimer = null;
  }
}

// Global signal poll for incoming calls
function startGlobalCallPolling() {
  const req = typeof cloudRequestExt === 'function' ? cloudRequestExt : cloudRequest;
  setInterval(async () => {
    const user = getCurrentUser();
    if (!user || !getEffectiveSyncUrl()) return;
    if (callState.active) return;
    const signals = await req(`/api/call/signals/${user.id}?since=${lastSignalTs}`, {}, 60000);
    if (!Array.isArray(signals)) return;
    for (const sig of signals) {
      lastSignalTs = Math.max(lastSignalTs, sig.timestamp || 0);
      if (sig.type === 'offer' && !callState.active) {
        await handleCallSignal(sig);
      } else if (sig.type === 'hangup' && pendingIncomingCall) {
        await handleCallSignal(sig);
      }
    }
  }, 1500);
}

// ─── Feature init ────────────────────────────────────────
function initExtendedFeatures() {
  loadAdminSession();
  updateAdminTabVisibility();

  updateNotifyButtonLabel();
  setupNotificationClickHandler();
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    registerServiceWorker();
  }

  const fileInput = document.getElementById('input-chat-file');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file || !currentConvId) return;
      if (file.size > 5 * 1024 * 1024) {
        showToast('5MB以下のファイルを選択してください');
        return;
      }
      try {
        const dataUrl = await readFileAsDataURL(file);
        const user = getCurrentUser();
        const msg = sendFileMessage(currentConvId, user.id, dataUrl, file.name, file.type);
        if (msg) {
          appendMessageToChat(msg, currentConvId);
          renderChatList();
          showToast('ファイルを送信しました');
        }
      } catch (e) {
        showToast('ファイルの送信に失敗しました');
      }
    });
  }

  const videoInput = document.getElementById('input-chat-video');
  if (videoInput) {
    videoInput.addEventListener('change', async () => {
      const file = videoInput.files[0];
      videoInput.value = '';
      if (!file || !currentConvId) return;
      if (!file.type.startsWith('video/')) {
        showToast('動画ファイルを選択してください');
        return;
      }
      if (file.size > 1024 * 1024 * 1024) {
        showToast('1GB以下の動画を選択してください');
        return;
      }
      try {
        const dataUrl = await readFileAsDataURL(file);
        const user = getCurrentUser();
        const msg = sendVideoMessage(currentConvId, user.id, dataUrl);
        if (msg) {
          appendMessageToChat(msg, currentConvId);
          renderChatList();
          showToast('動画を送信しました');
        }
      } catch (e) {
        showToast('動画の送信に失敗しました');
      }
    });
  }

  // Admin tab in main nav
  document.querySelectorAll('.tab[data-tab="admin"]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = 'admin';
      document.querySelectorAll('#screen-main .tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById('tab-admin').classList.remove('hidden');
      renderAdminUsers();
      renderAdminConversations();
    });
  });

  document.querySelectorAll('[data-main-admin-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-main-admin-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.mainAdminTab;
      document.getElementById('main-admin-users').classList.toggle('hidden', name !== 'users');
      document.getElementById('main-admin-conversations').classList.toggle('hidden', name !== 'conversations');
      document.getElementById('main-admin-feedback').classList.toggle('hidden', name !== 'feedback');
      if (name === 'users') renderAdminUsers();
      if (name === 'conversations') renderAdminConversations();
      if (name === 'feedback' && typeof renderAdminFeedback === 'function') renderAdminFeedback();
    });
  });

  // 管理者タブ・通話・添付ボタンは setupGlobalClickDelegation で処理

  // Override admin exit to persist
  const exitBtn = document.getElementById('btn-admin-exit');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      showScreen('main');
      refreshMainUI();
    }, { capture: true });
  }

  startGlobalCallPolling();
}

// Override admin render for main tab
const _renderAdminUsersOrig = renderAdminUsers;
renderAdminUsers = function () {
  const useMain = currentTab === 'admin' && document.getElementById('main-admin-user-list');
  if (!useMain) return _renderAdminUsersOrig();
  const data = getData();
  const users = Object.values(data.users);
  const list = document.getElementById('main-admin-user-list');
  const empty = document.getElementById('main-admin-empty-users');
  list.innerHTML = '';
  if (users.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  users.forEach(user => {
    const friends = getFriends(user.id);
    const convs = getUserConversations(user.id);
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      ${avatarHtml(user)}
      <div class="list-info">
        <div class="list-name">${escapeHtml(user.name)}</div>
        <div class="list-preview">友だち ${friends.length}人 · トーク ${convs.length}件</div>
        <div class="admin-user-actions">
          <button class="admin-btn admin-btn-delete" data-user-id="${user.id}">削除</button>
        </div>
      </div>`;
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
};

const _renderAdminConversationsOrig = renderAdminConversations;
renderAdminConversations = function () {
  const useMain = currentTab === 'admin' && document.getElementById('main-admin-conv-list');
  if (!useMain) return _renderAdminConversationsOrig();
  const data = getData();
  const convs = Object.values(data.conversations)
    .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
  const list = document.getElementById('main-admin-conv-list');
  const empty = document.getElementById('main-admin-empty-conv');
  list.innerHTML = '';
  if (convs.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  convs.forEach(conv => {
    const members = conv.members.map(id => (data.users[id]?.name || '不明')).join(', ');
    const title = conv.type === 'group' ? conv.name : members;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="list-avatar ${conv.type === 'group' ? 'group' : ''}">${conv.type === 'group' ? '👥' : '💬'}</div>
      <div class="list-info">
        <div class="list-name">${escapeHtml(title)}</div>
        <div class="list-preview">${conv.lastMessagePreview ? escapeHtml(conv.lastMessagePreview) : 'メッセージなし'}</div>
      </div>`;
    item.addEventListener('click', () => openAdminChat(conv.id));
    list.appendChild(item);
  });
};

const _hideAllModalsOrig = hideAllModals;
hideAllModals = function () {
  _hideAllModalsOrig();
  transferScanHandled = false;
  stopTransferScanner();
};

// ─── グローバルクリック委譲（ボタンが確実に反応する） ───
function setupGlobalClickDelegation() {
  const actions = {
    'btn-attach-video': () => document.getElementById('input-chat-video')?.click(),
    'btn-attach-file': () => document.getElementById('input-chat-file')?.click(),
    'btn-attach-image': () => document.getElementById('input-chat-image')?.click(),
    'btn-stickers': () => { renderStickerPicker(); showModal('modal-stickers'); },
    'btn-voice-call': () => startCall('audio'),
    'btn-video-call': () => startCall('video'),
    'btn-end-call': () => endCall(),
    'btn-answer-call': () => answerIncomingCall(),
    'btn-decline-call': () => declineIncomingCall(),
    'btn-enable-notify': () => requestNotificationPermission(),
    'btn-transfer-qr': () => {
      if (!getEffectiveSyncUrl()) { showToast('同期サーバーURLを設定してください'); return; }
      renderTransferQR();
      showModal('modal-transfer-qr');
    },
    'btn-transfer-onboarding': () => {
      if (!getEffectiveSyncUrl()) showToast('同期サーバーが未設定です。引き継ぎ後にマイページで設定できます');
      openTransferScanModal();
    },
    'btn-start-transfer-camera': () => startQrScannerForTransfer(),
    'btn-stop-transfer-camera': () => stopTransferScanner(),
    'btn-redeem-transfer-code': () => {
      const code = document.getElementById('input-transfer-code')?.value?.trim() || '';
      if (!code) { showToast('引き継ぎコードを入力してください'); return; }
      stopTransferScanner();
      showToast('引き継ぎ中…');
      redeemTransferCodeExt(code).then(handleTransferRedeemResult);
    },
    'btn-restore-by-user-id': () => restoreByUserIdFromModal(),
    'btn-line-sticker-shop': () => window.open(LINE_STICKER_SHOP_URL, '_blank'),
    'btn-admin-logout': () => {
      adminLoggedIn = false;
      adminRole = null;
      saveAdminToken('');
      saveAdminSession();
      updateAdminTabVisibility();
      document.querySelector('.tab[data-tab="chats"]')?.click();
      showToast('管理者ログアウトしました');
    },
    'btn-admin-logout-mod': () => {
      adminLoggedIn = false;
      adminRole = null;
      saveAdminToken('');
      saveAdminSession();
      updateAdminTabVisibility();
      document.querySelector('.tab[data-tab="chats"]')?.click();
      showToast('ログアウトしました');
    },
    'btn-refresh-feedback': () => { if (typeof renderAdminFeedback === 'function') renderAdminFeedback(); },
    'btn-refresh-feedback-screen': () => { if (typeof renderAdminFeedbackScreen === 'function') renderAdminFeedbackScreen(); },
    'btn-submit-feature': () => submitFeedback('feature', document.getElementById('input-feature-request')?.value || ''),
    'btn-submit-bug': () => submitFeedback('bug', document.getElementById('input-bug-report')?.value || ''),
    'btn-save-password': () => {
      const user = getCurrentUser();
      const pw = document.getElementById('input-account-password')?.value || '';
      if (typeof setUserAccountPassword === 'function') setUserAccountPassword(user.id, pw);
      document.getElementById('input-account-password').value = '';
      showToast(pw ? 'パスワードを設定しました' : 'パスワードを解除しました');
    },
    'btn-invite-group-members': () => {
      const ids = Array.from(document.querySelectorAll('#group-invite-select input:checked')).map(c => c.value);
      if (!ids.length) { showToast('招待する友だちを選んでください'); return; }
      addMembersToGroup(currentConvId, ids);
      if (typeof renderGroupInfoV4 === 'function') renderGroupInfoV4();
      refreshMainUI();
      showToast('メンバーを招待しました');
    },
    'btn-import-line-stickers': () => {
      const url = document.getElementById('input-line-sticker-url')?.value || '';
      if (typeof importLineStickerPack === 'function') importLineStickerPack(url).then(() => renderStickerPicker());
    },
    'btn-create-custom-stickers': async () => {
      const name = document.getElementById('input-custom-sticker-name')?.value?.trim() || 'マイスタンプ';
      const files = document.getElementById('input-custom-sticker-images')?.files;
      if (!files || !files.length) { showToast('画像を選択してください'); return; }
      if (typeof createCustomPhotoStickerPack === 'function') {
        await createCustomPhotoStickerPack(name, Array.from(files));
        document.getElementById('input-custom-sticker-images').value = '';
        renderStickerPicker();
      }
    }
  };

  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('button[id], a[id]');
    if (!el || !actions[el.id]) return;
    if (el.tagName === 'A') e.preventDefault();
    actions[el.id]();
  });
}

onAppInit(() => {
  initExtendedFeatures();
  setupGlobalClickDelegation();
});

function bootBlueChat() {
  init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootBlueChat);
} else {
  bootBlueChat();
}
