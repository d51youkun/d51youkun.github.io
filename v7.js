/**
 * BlueChat v7 — テーマ・Ban・お知らせ・プレミアム・引き継ぎ改善・通話修正
 */
const THEME_KEY = 'bluechat_theme';
const ACTIVITY_VERSION_KEY = 'bluechat_activity_version';
const ACTIVITY_POLL_MS = 4000;
const ANNOUNCE_READ_KEY = 'bluechat_ann_read';

const RTC_CONFIG_V7 = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

let iceCandidateQueue = [];
let syncVersionTimer = null;
let unreadBadgeTimer = null;

// ─── Slim backup (fix storage quota on transfer) ─────────
function slimDataUrl(val, maxLen) {
  if (!val || typeof val !== 'string') return val;
  if (val.startsWith('data:') && val.length > (maxLen || 500)) return null;
  return val;
}

function slimMessageForBackup(msg) {
  if (!msg) return msg;
  const m = { ...msg };
  m.image = slimDataUrl(m.image, 500);
  m.video = slimDataUrl(m.video, 500);
  m.fileData = slimDataUrl(m.fileData, 500);
  m.stickerImage = slimDataUrl(m.stickerImage, 500);
  return m;
}

function slimBackupPayload(backup) {
  const b = JSON.parse(JSON.stringify(backup));
  if (b.data) {
    if (b.data.messages) {
      Object.keys(b.data.messages).forEach(cid => {
        b.data.messages[cid] = (b.data.messages[cid] || []).map(slimMessageForBackup);
      });
    }
    if (b.data.users) {
      Object.values(b.data.users).forEach(u => {
        if (u.avatar) u.avatar = slimDataUrl(u.avatar, 500);
      });
    }
    if (b.data.customStickerPacks) {
      b.data.customStickerPacks = b.data.customStickerPacks.map(pack => ({
        ...pack,
        stickers: (pack.stickers || []).map(s => ({
          ...s,
          src: slimDataUrl(s.src, 80000)
        }))
      }));
    }
  }
  return b;
}

const _buildTransferBackupV7 = buildTransferBackup;
buildTransferBackup = function () {
  return slimBackupPayload(_buildTransferBackupV7());
};

const _importTransferBackupV7 = importTransferBackup;
importTransferBackup = function (backup) {
  const slim = slimBackupPayload(backup);
  _importTransferBackupV7(slim);
  if (getSyncUrl()) {
    setTimeout(() => syncAllConversations(), 800);
  }
};

// ─── Theme ───────────────────────────────────────────────
function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'dark';
}

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'dark' ? '#0d1b2a' : '#1a6fd4';
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.textContent = t === 'dark' ? '☀️ ライトテーマ' : '🌙 ダークテーマ';
}

function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

// ─── Premium badge ─────────────────────────────────────────
function premiumBadgeHtml(user) {
  if (!user || !user.premium || user.superPremium) return '';
  return '<span class="premium-check" title="BlueChatプレミアム">✓</span>';
}

function superPremiumBadgeHtml(user) {
  if (!user || !user.superPremium) return '';
  return '<span class="super-premium-check" title="BlueChatスーパープレミアム">⭐️</span>';
}

function userBadgesHtml(user) {
  if (!user) return '';
  let html = '';
  if (user.superPremium) html += superPremiumBadgeHtml(user);
  else if (user.premium) html += premiumBadgeHtml(user);
  if (typeof titleBadgeHtml === 'function') html += titleBadgeHtml(user);
  else if (user.title && user.title.text) {
    const color = user.title.color || '#1a6fd4';
    html += `<span class="user-title-badge" style="background:${escapeHtml(color)}">${escapeHtml(user.title.text)}</span>`;
  }
  return html;
}

function userHasTalkBadge(user) {
  if (!user) return false;
  return !!user.superPremium || !!user.premium || !!(user.title && user.title.text);
}

displayNameHtml = function (user) {
  if (!user) return '不明';
  return `${escapeHtml(user.name)}${userBadgesHtml(user)}`;
};

// ─── Global Ban ────────────────────────────────────────────
function isUserBanned(userId) {
  const user = getUser(userId);
  if (!user) return false;
  if (user.banned) {
    if (user.bannedUntil && Date.now() > user.bannedUntil) {
      user.banned = false;
      delete user.bannedUntil;
      saveData(getData());
      cloudPushUser(user);
      return false;
    }
    return true;
  }
  return false;
}

const _isUserSuspendedV7 = isUserSuspended;
isUserSuspended = function (userId) {
  if (isUserBanned(userId)) return true;
  return _isUserSuspendedV7(userId);
};

async function syncCurrentUserModeration() {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  const remote = await cloudFetchUser(user.id);
  if (!remote || !remote.id) return;
  const data = getData();
  const local = data.users[user.id];
  if (!local) return;
  ['banned', 'bannedUntil', 'suspendedUntil', 'premium', 'superPremium', 'title'].forEach(k => {
    if (remote[k] !== undefined) local[k] = remote[k];
  });
  saveData(data);
  if (isUserBanned(user.id)) showBannedScreen();
}

function showBannedScreen() {
  stopGlobalSync();
  stopPresenceHeartbeat?.();
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('screen-banned')?.classList.remove('hidden');
}

async function adminBanUser(userId, hours) {
  let user = getUser(userId);
  if (!user) return false;
  user.banned = true;
  if (hours > 0) user.bannedUntil = Date.now() + hours * 60 * 60 * 1000;
  else delete user.bannedUntil;
  saveData(getData());
  const ok = await cloudPushUser(user);
  if (ok) showToast('アカウントを停止しました（全端末に反映）');
  else showToast('Banを保存しましたがサーバー反映に失敗。再試行してください');
  return ok;
}

async function adminBanUserAsync(userId, hours) {
  let user = getUser(userId);
  if (!user && getSyncUrl()) {
    const remote = await cloudFetchUser(userId);
    if (remote) { ensureLocalUser(remote); user = getUser(userId); }
  }
  if (!user) { showToast('ユーザーが見つかりません'); return; }
  await adminBanUser(userId, hours);
}

async function adminUnbanUser(userId) {
  const user = getUser(userId);
  if (!user) return;
  user.banned = false;
  delete user.bannedUntil;
  delete user.suspendedUntil;
  saveData(getData());
  await cloudPushUser(user);
  showToast('停止を解除しました');
}

function adminSetPremium(userId, premium) {
  const user = getUser(userId);
  if (!user) return;
  user.premium = !!premium;
  if (!premium && user.superPremium) user.superPremium = false;
  saveData(getData());
  cloudPushUser(user);
  showToast(premium ? 'プレミアムを付与しました' : 'プレミアムを解除しました');
}

function adminSetSuperPremium(userId, enabled) {
  const user = getUser(userId);
  if (!user) return;
  user.superPremium = !!enabled;
  if (enabled) user.premium = true;
  saveData(getData());
  cloudPushUser(user);
  showToast(enabled ? 'スーパープレミアムを付与しました' : 'スーパープレミアムを解除しました');
}

async function adminSuspendUserHours(userId, hours) {
  const user = getUser(userId);
  if (!user) return;
  user.suspendedUntil = Date.now() + hours * 60 * 60 * 1000;
  saveData(getData());
  await cloudPushUser(user);
  showToast(`${hours}時間停止しました`);
}

// ─── Sync on meaningful activity only (no constant reload) ───
async function handleRemoteActivity() {
  await syncAllConversations();
  if (typeof syncCurrentUserModeration === 'function') await syncCurrentUserModeration();
  if (typeof syncUserDataAcrossBrowsers === 'function') await syncUserDataAcrossBrowsers();
  if (currentTab === 'notices') await renderAnnouncements();
  if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
  else refreshMainUI();
}

function startSyncVersionPolling() {
  if (syncVersionTimer) clearInterval(syncVersionTimer);
  if (!getSyncUrl()) return;
  const poll = async () => {
    const res = await cloudRequest('/api/activity-version');
    if (!res || res.version === undefined) return;
    const last = parseInt(localStorage.getItem(ACTIVITY_VERSION_KEY) || '0', 10);
    if (res.version > last) {
      localStorage.setItem(ACTIVITY_VERSION_KEY, String(res.version));
      await handleRemoteActivity();
      return;
    }
    if (last === 0) {
      localStorage.setItem(ACTIVITY_VERSION_KEY, String(res.version));
      await handleRemoteActivity();
      return;
    }
  };
  poll();
  syncVersionTimer = setInterval(poll, ACTIVITY_POLL_MS);
}

// ─── Announcements (お知らせ) ──────────────────────────────
function getAnnouncementReadMap() {
  try {
    return JSON.parse(localStorage.getItem(ANNOUNCE_READ_KEY) || '{}');
  } catch (e) { return {}; }
}

function markAnnouncementRead(annId) {
  const map = getAnnouncementReadMap();
  map[annId] = Date.now();
  localStorage.setItem(ANNOUNCE_READ_KEY, JSON.stringify(map));
  const user = getCurrentUser();
  if (user && getSyncUrl()) {
    cloudRequest(`/api/announcement-reads/${user.id}/${annId}`, { method: 'PUT', body: '{}' });
  }
  updateTabBadges();
}

async function fetchAnnouncements() {
  const user = getCurrentUser();
  const syncBase = typeof getEffectiveSyncUrl === 'function' ? getEffectiveSyncUrl() : getSyncUrl();
  if (!user || !syncBase) return [];
  const groups = getUserConversations(user.id).filter(c => c.type === 'group').map(c => c.id);
  const url = `/api/announcements?userId=${encodeURIComponent(user.id)}&groupIds=${encodeURIComponent(groups.join(','))}`;
  const list = await (typeof cloudRequestExt === 'function'
    ? cloudRequestExt(url)
    : cloudRequest(url));
  return Array.isArray(list) ? list : [];
}

async function postAnnouncement(type, title, body, extras) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) { showToast('同期サーバーが必要です'); return; }
  await cloudRequest('/api/announcements', {
    method: 'POST',
    body: JSON.stringify({
      type, title, body,
      authorId: user.id,
      authorName: user.name,
      ...extras
    })
  });
  showToast('お知らせを投稿しました');
  renderAnnouncements();
  updateTabBadges();
}

async function postAnnouncementComment(annId, text) {
  const user = getCurrentUser();
  if (!user || !text.trim()) return;
  await cloudRequest(`/api/announcements/${annId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ userId: user.id, userName: user.name, text: text.trim() })
  });
  renderAnnouncements();
}

function countUnreadAnnouncements(list) {
  const read = getAnnouncementReadMap();
  return list.filter(a => !read[a.id]).length;
}

function countUnreadChats() {
  const user = getCurrentUser();
  if (!user) return 0;
  const data = getData();
  let count = 0;
  getUserConversations(user.id).forEach(conv => {
    const msgs = getMessages(conv.id);
    if (!msgs.length) return;
    const last = msgs[msgs.length - 1];
    if (String(last.senderId) === String(user.id)) return;
    const reads = data.readReceipts?.[conv.id] || {};
    const myRead = reads[user.id] || 0;
    if (last.timestamp > myRead) count++;
  });
  return count;
}

function setTabBadge(tabName, count) {
  const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (!tab) return;
  let badge = tab.querySelector('.tab-badge');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tab-badge';
      tab.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.remove('hidden');
  } else if (badge) {
    badge.classList.add('hidden');
  }
}

async function updateTabBadges() {
  const ann = await fetchAnnouncements();
  setTabBadge('notices', countUnreadAnnouncements(ann));
  setTabBadge('chats', countUnreadChats());
}

async function deleteAnnouncement(annId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  const list = await fetchAnnouncements();
  const ann = list.find(a => a.id === annId);
  if (!ann || ann.authorId !== user.id) {
    showToast('削除できません');
    return;
  }
  if (!confirm('このお知らせを削除しますか？')) return;
  await cloudRequest(`/api/announcements/${annId}`, { method: 'DELETE' });
  showToast('お知らせを削除しました');
  renderAnnouncements();
  updateTabBadges();
}

async function deleteAnnouncementComment(annId, commentId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  await cloudRequest(`/api/announcements/${annId}/comments/${commentId}`, {
    method: 'DELETE',
    body: JSON.stringify({ userId: user.id })
  });
  renderAnnouncements();
}

async function renderAnnouncements() {
  const list = document.getElementById('notice-list');
  const empty = document.getElementById('notice-list-empty');
  if (!list) return;
  const user = getCurrentUser();
  const announcements = await fetchAnnouncements();
  list.innerHTML = '';
  if (!announcements.length) {
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  const read = getAnnouncementReadMap();
  announcements.forEach(ann => {
    const item = document.createElement('div');
    item.className = 'notice-item glass-panel' + (read[ann.id] ? '' : ' unread');
    const typeLabel = ann.type === 'personal' ? '個人' : ann.type === 'group' ? 'グループ' : '全体';
    const canDeleteAnn = user && ann.authorId === user.id;
    item.innerHTML = `
      <div class="notice-header">
        <span class="notice-type">${typeLabel}</span>
        <span class="notice-date">${new Date(ann.createdAt).toLocaleString('ja-JP')}</span>
        ${canDeleteAnn ? `<button type="button" class="btn-delete-post btn-sm" data-ann-id="${ann.id}">削除</button>` : ''}
      </div>
      <h3 class="notice-title">${escapeHtml(ann.title)}</h3>
      <p class="notice-body">${escapeHtml(ann.body)}</p>
      <p class="notice-author">by ${escapeHtml(ann.authorName || '')}</p>
      <div class="notice-comments" id="notice-comments-${ann.id}"></div>
      <div class="notice-comment-form">
        <input type="text" class="notice-comment-input" placeholder="コメント…" data-ann-id="${ann.id}">
        <button type="button" class="btn-secondary btn-sm btn-notice-comment" data-ann-id="${ann.id}">送信</button>
      </div>`;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.notice-comment-form')) return;
      markAnnouncementRead(ann.id);
      item.classList.remove('unread');
    });
    const commentsEl = item.querySelector(`#notice-comments-${ann.id}`);
    (ann.comments || []).forEach(c => {
      const cEl = document.createElement('div');
      cEl.className = 'notice-comment';
      const canDeleteComment = user && c.userId === user.id;
      cEl.innerHTML = `<strong>${escapeHtml(c.userName)}</strong>: ${escapeHtml(c.text)}${canDeleteComment ? ` <button type="button" class="btn-delete-post btn-sm" data-ann-id="${ann.id}" data-comment-id="${c.id}">削除</button>` : ''}`;
      commentsEl.appendChild(cEl);
    });
    item.querySelectorAll('.btn-delete-post').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const annId = btn.dataset.annId;
        const commentId = btn.dataset.commentId;
        if (commentId) {
          if (!confirm('コメントを削除しますか？')) return;
          await deleteAnnouncementComment(annId, commentId);
        } else {
          await deleteAnnouncement(annId);
        }
      });
    });
    item.querySelector('.btn-notice-comment')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const input = item.querySelector('.notice-comment-input');
      await postAnnouncementComment(ann.id, input?.value || '');
      if (input) input.value = '';
    });
    list.appendChild(item);
  });
  updateTabBadges();
}

function showAdminPostNoticeModal() {
  const type = prompt('種類: global / personal / group', 'global');
  if (!type) return;
  const title = prompt('タイトル');
  if (!title) return;
  const body = prompt('本文');
  if (!body) return;
  const extras = {};
  if (type === 'personal') {
    const ids = prompt('対象ユーザーID（カンマ区切り）');
    if (!ids) return;
    extras.targetUserIds = ids.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (type === 'group') {
    extras.groupId = prompt('グループ会話ID');
    if (!extras.groupId) return;
  }
  postAnnouncement(type, title, body, extras);
}

// ─── Stickers: GIF + delete packs ──────────────────────────
function deleteCustomStickerPack(packId) {
  const data = getData();
  if (!data.customStickerPacks) return;
  data.customStickerPacks = data.customStickerPacks.filter(p => p.id !== packId);
  saveData(data);
  renderStickerPicker();
  showToast('スタンプ帳を削除しました');
}

async function createCustomPhotoStickerPackV7(name, files) {
  const stickers = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const maxSize = file.type === 'image/gif' ? 5 * 1024 * 1024 : 3 * 1024 * 1024;
    if (file.size > maxSize) continue;
    const src = await readFileAsDataURL(file);
    const isAnimated = file.type === 'image/gif' || file.type === 'image/webp';
    stickers.push({
      type: 'image',
      src,
      emoji: isAnimated ? '🎬' : '🖼️',
      isGif: isAnimated,
      isAnimated
    });
  }
  if (!stickers.length) {
    showToast('画像・GIF・動くWebPを選択してください');
    return null;
  }
  const pack = { id: 'custom_' + generateId(), name: name || 'マイスタンプ', stickers };
  saveCustomStickerPack(pack);
  showToast(`スタンプ帳「${pack.name}」を作成しました（${stickers.length}枚）`);
  return pack;
}
createCustomPhotoStickerPack = createCustomPhotoStickerPackV7;

const _renderStickerPickerV7 = renderStickerPicker;
renderStickerPicker = function () {
  const grid = document.getElementById('sticker-grid');
  if (!grid) return;
  grid.innerHTML = '';
  getAllStickerPacks().forEach(pack => {
    const header = document.createElement('div');
    header.className = 'sticker-pack-header';
    header.innerHTML = `<span class="sticker-pack-label">${escapeHtml(pack.name)}</span>`;
    if (pack.id.startsWith('custom_') || pack.id.startsWith('line_')) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-text-link btn-delete-pack';
      del.textContent = '削除';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`「${pack.name}」を削除しますか？`)) deleteCustomStickerPack(pack.id);
      });
      header.appendChild(del);
    }
    grid.appendChild(header);
    pack.stickers.forEach(st => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sticker-btn';
      if (st.type === 'image' && st.src) {
        const animated = st.isGif || st.isAnimated || isAnimatedStickerSource(st.src);
        if (animated) {
          btn.innerHTML = `<img src="${st.src}" alt="gif" class="sticker-img sticker-gif">`;
        } else {
          btn.innerHTML = `<img src="${st.src}" alt="sticker" class="sticker-img">`;
        }
      } else {
        btn.textContent = st.emoji || st;
      }
      btn.addEventListener('click', () => {
        const user = getCurrentUser();
        if (!user || !currentConvId) return;
        let msg;
        if (st.type === 'image' && st.src) {
          const animated = st.isGif || st.isAnimated || isAnimatedStickerSource(st.src);
          msg = pushMessage(currentConvId, user.id, {
            type: 'sticker',
            stickerImage: st.src,
            stickerAnimated: animated,
            text: ''
          });
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

// ─── Video/file inline view ────────────────────────────────
const _getMessageContentHtmlV7 = getMessageContentHtml;
getMessageContentHtml = function (msg) {
  if (msg.type === 'video' && msg.video) {
    return `<video src="${msg.video}" class="message-video" controls playsinline preload="metadata"></video>`;
  }
  if (msg.type === 'file' && msg.fileData) {
    const name = escapeHtml(msg.fileName || 'file');
    const mime = msg.mimeType || '';
    if (mime.startsWith('video/')) {
      return `<video src="${msg.fileData}" class="message-video" controls playsinline preload="metadata"></video><p class="file-name">${name}</p>`;
    }
    if (mime.startsWith('image/')) {
      return `<img src="${msg.fileData}" alt="${name}" class="message-image" loading="lazy">`;
    }
    if (mime.startsWith('audio/')) {
      return `<audio src="${msg.fileData}" controls class="message-audio"></audio><p class="file-name">${name}</p>`;
    }
    return `<a href="${msg.fileData}" download="${name}" class="message-file-link">📎 ${name}</a>`;
  }
  return _getMessageContentHtmlV7(msg);
};

// ─── WebRTC cross-device fix ───────────────────────────────
if (typeof RTC_CONFIG !== 'undefined') {
  Object.assign(RTC_CONFIG, RTC_CONFIG_V7);
}

function queueIceCandidate(candidate) {
  iceCandidateQueue.push(candidate);
}

async function flushIceCandidates(pc) {
  while (iceCandidateQueue.length) {
    const c = iceCandidateQueue.shift();
    try { await pc.addIceCandidate(c); } catch (e) { /* ignore */ }
  }
}

const _handleCallSignalV7 = handleCallSignal;
handleCallSignal = async function (sig) {
  if (sig.type === 'ice' && peerConnection && sig.payload?.candidate) {
    if (!peerConnection.remoteDescription) {
      queueIceCandidate(sig.payload.candidate);
      return;
    }
    try { await peerConnection.addIceCandidate(sig.payload.candidate); } catch (e) { /* */ }
    return;
  }
  await _handleCallSignalV7(sig);
  if (peerConnection && sig.type === 'answer' && peerConnection.remoteDescription) {
    await flushIceCandidates(peerConnection);
  }
};

const _endCallV7 = endCall;
endCall = async function () {
  iceCandidateQueue.length = 0;
  return _endCallV7();
};

// ─── Notification guide for unsupported devices ────────────
function showNotificationGuide() {
  const supported = typeof Notification !== 'undefined';
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  let msg = '【通知の設定方法】\n\n';
  if (!supported) {
    msg += 'このブラウザはプッシュ通知に非対応です。\n';
    msg += '代わりにアプリ内ポップアップ通知を使用します（自動で有効）。\n\n';
  }
  if (ios) {
    msg += 'iPhone/iPadの場合:\n';
    msg += '1. Safariで共有ボタン →「ホーム画面に追加」\n';
    msg += '2. ホーム画面のアイコンから起動\n';
    msg += '3. マイページ →「通知を許可する」\n';
  } else {
    msg += '1. マイページ →「通知を許可する」をタップ\n';
    msg += '2. ブラウザの許可ダイアログで「許可」\n';
    msg += '3. 通話の着信も同じ通知で届きます\n';
  }
  alert(msg);
}

const _requestNotificationPermission = requestNotificationPermission;
requestNotificationPermission = async function () {
  if (!notificationsSupported()) {
    showNotificationGuide();
    showToast('アプリ内通知は有効です（画面上にポップアップ表示）');
    return;
  }
  return _requestNotificationPermission();
};

// ─── Admin UI extensions ───────────────────────────────────
const _renderAdminUsersV7 = renderAdminUsers;

function appendAdminV7Buttons() {
  if (adminRole !== 'super') return;
  const useMain = currentTab === 'admin' && document.getElementById('main-admin-user-list');
  if (!useMain) return;
  document.querySelectorAll('#main-admin-user-list .list-item').forEach(item => {
    const actions = item.querySelector('.admin-user-actions');
    const userId = item.querySelector('.admin-btn-title')?.dataset?.userId;
    if (!actions || !userId || actions.querySelector('.admin-btn-ban')) return;
    const banBtn = document.createElement('button');
    banBtn.className = 'admin-btn admin-btn-ban';
    banBtn.textContent = 'Ban';
    banBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const h = prompt('停止時間（時間）。永久=0', '0');
      if (h === null) return;
      adminBanUserAsync(userId, parseInt(h, 10) || 0);
      renderAdminUsers();
    });
    const unbanBtn = document.createElement('button');
    unbanBtn.className = 'admin-btn admin-btn-unban';
    unbanBtn.textContent = '解除';
    unbanBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      adminUnbanUser(userId);
      renderAdminUsers();
    });
    const premBtn = document.createElement('button');
    premBtn.className = 'admin-btn admin-btn-premium';
    premBtn.textContent = 'Premium';
    premBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const u = getUser(userId);
      adminSetPremium(userId, !u?.premium);
      renderAdminUsers();
    });
    const spBtn = document.createElement('button');
    spBtn.className = 'admin-btn admin-btn-super-premium';
    spBtn.textContent = 'S.Premium';
    spBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const u = getUser(userId);
      adminSetSuperPremium(userId, !u?.superPremium);
      renderAdminUsers();
    });
    const suspBtn = document.createElement('button');
    suspBtn.className = 'admin-btn admin-btn-suspend';
    suspBtn.textContent = '時間停止';
    suspBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const h = prompt('停止時間（時間）', '1');
      if (h === null) return;
      adminSuspendUserHours(userId, parseInt(h, 10) || 1);
      renderAdminUsers();
    });
    actions.appendChild(banBtn);
    actions.appendChild(unbanBtn);
    actions.appendChild(suspBtn);
    actions.appendChild(premBtn);
    actions.appendChild(spBtn);
  });
}

renderAdminUsers = function () {
  _renderAdminUsersV7();
};

// Override suspendUserForOneHour to use cloud
suspendUserForOneHour = function (userId) {
  adminSuspendUserHours(userId, 1);
};

// ─── Ban check on message send ─────────────────────────────
const _pushMessageV7 = pushMessage;
pushMessage = function (convId, senderId, fields) {
  if (isUserBanned(senderId)) {
    showBannedScreen();
    return null;
  }
  return _pushMessageV7(convId, senderId, fields);
};

// ─── Init ──────────────────────────────────────────────────
function initV7Features() {
  applyTheme(getTheme());

  const logoIcon = document.querySelector('.logo-icon');
  if (logoIcon) {
    logoIcon.innerHTML = '<img src="icon.png" alt="BlueChat" class="logo-icon-img">';
  }

  bindClick('btn-theme-toggle', () => toggleTheme());
  bindClick('btn-notify-guide', () => showNotificationGuide());
  bindClick('btn-admin-post-notice', () => showAdminPostNoticeModal());
  bindClick('btn-refresh-notices', () => renderAnnouncements());
  bindClick('btn-retry-sync', () => updateSyncStatusUI(true));
  bindClick('btn-admin-refresh-users', async () => {
    if (typeof syncAdminAllConversations === 'function') await syncAdminAllConversations();
    renderAdminUsers();
    if (currentTab === 'admin') renderAdminConversations();
  });

  const adminSearch = document.getElementById('input-admin-user-search');
  if (adminSearch) {
    adminSearch.addEventListener('input', () => {
      if (currentTab === 'admin') renderAdminUsers();
    });
  }

  syncCurrentUserModeration();
  startSyncVersionPolling();
  updateTabBadges();
  unreadBadgeTimer = setInterval(updateTabBadges, 10000);

  document.querySelectorAll('.tab[data-tab="notices"]').forEach(tab => {
    tab.addEventListener('click', () => renderAnnouncements());
  });

  const user = getCurrentUser();
  if (user && isUserBanned(user.id)) showBannedScreen();
}

const _startGlobalSyncV7 = startGlobalSync;
startGlobalSync = function () {
  _startGlobalSyncV7();
  syncCurrentUserModeration();
  startSyncVersionPolling();
  updateTabBadges();
};

const _refreshMainUIV7 = refreshMainUI;
refreshMainUI = function () {
  _refreshMainUIV7();
  updateTabBadges();
};

onAppInit(() => {
  initV7Features();
});
