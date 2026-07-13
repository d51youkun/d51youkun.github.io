/**
 * BlueChat v13 — QR端末ペアリング・管理者高速化・投稿バグ修正
 */
var APP_VERSION = 'v13';

const DEVICE_PAIR_PREFIX = 'bc-pair:';
const DEVICE_PAIR_EXPIRY_MS = 15 * 60 * 1000;
const ADMIN_CONV_CACHE_MS = 120000;
const POST_MEDIA_TIMEOUT_MS = 90000;
const POST_SUBMIT_TIMEOUT_MS = 120000;

let adminConvLastSync = 0;
let adminConvSyncPromise = null;

function withAsyncTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message || 'タイムアウト')), ms))
  ]);
}

function parseDevicePairFromScan(raw) {
  let text = extractQrDecodedText(raw) || String(raw || '').trim();
  try { text = decodeURIComponent(text); } catch (e) { /* keep */ }
  const lower = text.toLowerCase();
  const prefix = DEVICE_PAIR_PREFIX.toLowerCase();
  const idx = lower.indexOf(prefix);
  if (idx < 0) return null;
  return text.slice(idx).split(/[\s\r\n,;]+/)[0].trim();
}

async function createDevicePairSession() {
  const user = getCurrentUser();
  if (!user || !getEffectiveSyncUrl()) {
    showToast('同期サーバーに接続できません');
    return null;
  }
  let currentUser = user;
  if (!currentUser.passwordHash) {
    const pw = document.getElementById('input-account-password')?.value?.trim() || '';
    if (pw) {
      setUserAccountPassword(currentUser.id, pw);
      currentUser = getCurrentUser();
    } else {
      showToast('ペアリングにはパスワードが必要です。上で入力して「保存」を押してください');
      return null;
    }
  }
  const token = generateId() + generateId();
  if (typeof schedulePushAccountToCloud === 'function') {
    schedulePushAccountToCloud();
  } else if (typeof pushAccountToCloud === 'function') {
    pushAccountToCloud().catch(() => {});
  }
  const ok = await cloudRequestExt(`/api/device-pair/${token}`, {
    method: 'PUT',
    body: JSON.stringify({
      userId: currentUser.id,
      userName: currentUser.name,
      passwordHash: currentUser.passwordHash,
      syncUrl: getEffectiveSyncUrl(),
      expiresAt: Date.now() + DEVICE_PAIR_EXPIRY_MS
    })
  }, 30000);
  if (!ok || !ok.ok) {
    const fallback = await createDevicePairViaTransferFallback(token, currentUser);
    if (!fallback) {
      showToast('ペアリングQRの作成に失敗しました。同期サーバー接続を確認してください');
      return null;
    }
  }
  return DEVICE_PAIR_PREFIX + token;
}

async function createDevicePairViaTransferFallback(token, user) {
  let payload = typeof buildTransferBackupWithPassword === 'function'
    ? buildTransferBackupWithPassword(null)
    : null;
  if (payload && JSON.stringify(payload).length > 300000) {
    payload = {
      cloudBackupUserId: user.id,
      passwordHash: user.passwordHash || null,
      syncUrl: getEffectiveSyncUrl(),
      version: 2,
      exportedAt: Date.now(),
      pairMode: true
    };
  }
  if (!payload) return false;
  const res = await cloudRequestExt(`/api/transfer/${token}`, {
    method: 'PUT',
    body: JSON.stringify({ backup: payload, expiresAt: Date.now() + DEVICE_PAIR_EXPIRY_MS })
  }, 60000);
  return !!(res && res.ok);
}

function renderDevicePairQR() {
  const user = getCurrentUser();
  if (!user) return;
  const container = document.getElementById('device-pair-qr-canvas');
  const textEl = document.getElementById('device-pair-code-text');
  if (container) {
    container.innerHTML = '<p class="qr-hint" style="padding:32px;text-align:center">QRを生成中…</p>';
  }
  if (textEl) textEl.textContent = '';
  createDevicePairSession().then(code => {
    if (!code) {
      if (container) {
        container.innerHTML = '<p class="qr-hint" style="padding:32px;text-align:center">QRを表示できませんでした。<br>パスワードを保存してから再試行してください。</p>';
      }
      return;
    }
    if (!container) return;
    container.innerHTML = '';
    if (textEl) textEl.textContent = code;
    if (!renderScannableQr(container, code, 300)) {
      if (textEl) textEl.textContent = code + '（QR画像の生成に失敗。上のコードを手入力できます）';
      showToast('QR画像の生成に失敗しました。コードを表示しています');
      return;
    }
    pollDevicePairConsumed(code.slice(DEVICE_PAIR_PREFIX.length));
  });
}

async function pollDevicePairConsumed(token) {
  if (!getEffectiveSyncUrl()) return;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const modal = document.getElementById('modal-device-pair-qr');
    if (!modal || modal.classList.contains('hidden')) return;
    const status = await cloudRequestExt(`/api/device-pair/${token}/status`, {}, 30000);
    if (status && status.consumed) {
      hideModal('modal-device-pair-qr');
      if (typeof syncAccountAcrossDevices === 'function') {
        await syncAccountAcrossDevices();
      } else if (typeof syncAllConversations === 'function') {
        await syncAllConversations();
      }
      showToast('端末ペアリングが完了しました。同期を開始します');
      return;
    }
  }
}

async function redeemDevicePairCode(code) {
  const raw = String(code || '').trim();
  const idx = raw.toLowerCase().indexOf(DEVICE_PAIR_PREFIX);
  if (idx < 0) return { error: '無効なペアリングQRです' };
  const token = raw.slice(idx + DEVICE_PAIR_PREFIX.length).trim();
  if (!token) return { error: '無効なペアリングQRです' };
  ensureSyncUrlForRestore();
  if (!getEffectiveSyncUrl()) {
    return { error: '同期サーバーに接続できません' };
  }
  const info = await cloudRequestExt(`/api/device-pair/${token}`, {}, 30000);
  let pairInfo = info;
  if (!pairInfo || !pairInfo.userId) {
    const transfer = await cloudRequestExt(`/api/transfer/${token}`, {}, 30000);
    const backup = transfer && transfer.backup;
    if (backup && backup.cloudBackupUserId) {
      pairInfo = {
        userId: backup.cloudBackupUserId,
        userName: backup.data?.users?.[backup.cloudBackupUserId]?.name || 'ユーザー',
        requiresPassword: !!backup.passwordHash,
        syncUrl: backup.syncUrl || null
      };
    }
  }
  if (!pairInfo || !pairInfo.userId) {
    return { error: 'ペアリングQRの期限が切れたか、無効です' };
  }
  if (pairInfo.syncUrl && typeof setSyncUrl === 'function') {
    const migrated = typeof resolveSyncUrl === 'function' ? resolveSyncUrl(pairInfo.syncUrl) : pairInfo.syncUrl;
    if (migrated) setSyncUrl(migrated);
  }
  let password = '';
  const pwEl = document.getElementById('input-transfer-password');
  if (pwEl && pwEl.value) password = pwEl.value;
  if (pairInfo.requiresPassword && !password) {
    password = prompt('ペアリング用パスワードを入力してください') || '';
    if (!password) return { error: 'パスワードが必要です' };
  }
  const result = typeof loginAccountOnDevice === 'function'
    ? await loginAccountOnDevice(pairInfo.userId, password)
    : await restoreAccountByUserId(pairInfo.userId, password);
  if (result.error) return result;
  await cloudRequestExt(`/api/device-pair/${token}/consumed`, { method: 'POST', body: '{}' }, 30000)
    .catch(() => cloudRequestExt(`/api/transfer/${token}/consumed`, { method: 'POST', body: '{}' }, 30000));
  if (typeof pushAccountToCloud === 'function') {
    await pushAccountToCloud().catch(() => {});
  }
  return { success: true, source: 'pair' };
}

function handleDevicePairResult(result) {
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
  if (typeof updateAccountSyncStatusUI === 'function') updateAccountSyncStatusUI();
  showToast('ペアリング完了！同期を開始しました');
}

function showDevicePairScanModal() {
  ensureSyncUrlForRestore();
  if (typeof stopQrScanner === 'function') stopQrScanner();
  if (typeof stopTransferScanner === 'function') stopTransferScanner();
  transferScanHandled = false;
  showModal('modal-transfer-scan');
  setTimeout(() => startQrScannerForTransfer(), 350);
}

function showDevicePairQRModal() {
  const user = getCurrentUser();
  if (!user) {
    showToast('先にアカウントを作成してください');
    return;
  }
  showModal('modal-device-pair-qr');
  renderDevicePairQR();
}

function renderMainAdminConversationsCached() {
  const useMain = currentTab === 'admin' && document.getElementById('main-admin-conv-list');
  if (!useMain) return;
  const data = getData();
  const convs = Object.values(data.conversations)
    .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
  const list = document.getElementById('main-admin-conv-list');
  const empty = document.getElementById('main-admin-empty-conv');
  if (!list || !empty) return;
  list.innerHTML = '';
  if (convs.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
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
}

function ensureAdminConvSyncedBackground(force) {
  if (!adminLoggedIn || adminRole !== 'super' || !getEffectiveSyncUrl()) return Promise.resolve(false);
  const now = Date.now();
  if (!force && now - adminConvLastSync < ADMIN_CONV_CACHE_MS) return Promise.resolve(false);
  if (adminConvSyncPromise) return adminConvSyncPromise;
  adminConvSyncPromise = (typeof syncAdminAllConversations === 'function'
    ? syncAdminAllConversations()
    : Promise.resolve(false)
  ).then(ok => {
    if (ok) adminConvLastSync = Date.now();
    return ok;
  }).finally(() => {
    adminConvSyncPromise = null;
  });
  return adminConvSyncPromise;
}

showMainAdminTab = function () {
  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
  const adminTab = document.querySelector('.tab[data-tab="admin"]');
  if (adminTab) adminTab.classList.add('active');
  currentTab = 'admin';
  document.querySelectorAll('#screen-main .tab-content').forEach(c => c.classList.add('hidden'));
  const panel = document.getElementById('tab-admin');
  if (panel) panel.classList.remove('hidden');
  renderAdminUsers();
  if (typeof renderAdminFeedback === 'function') renderAdminFeedback();
};

const _renderAdminConversationsV13 = renderAdminConversations;
renderAdminConversations = function () {
  const useMain = currentTab === 'admin' && document.getElementById('main-admin-conv-list');
  if (useMain) {
    renderMainAdminConversationsCached();
    const convPanel = document.getElementById('main-admin-conversations');
    if (convPanel && !convPanel.classList.contains('hidden')) {
      ensureAdminConvSyncedBackground(false).then(() => renderMainAdminConversationsCached());
    }
    return;
  }
  if (typeof renderAdminConversationsList === 'function') {
    renderAdminConversationsList();
    ensureAdminConvSyncedBackground(false).then(() => {
      if (typeof renderAdminConversationsList === 'function') renderAdminConversationsList();
    });
  } else {
    _renderAdminConversationsV13();
  }
};

async function uploadPostToServerAsync(post) {
  if (!getUsableSyncUrl()) return false;
  const payload = {
    id: post.id,
    kind: post.kind,
    text: post.text || '',
    authorId: post.authorId,
    authorName: post.authorName,
    authorAvatar: post.authorAvatar || null,
    media: post.media || null,
    attachment: post.attachment || null,
    createdAt: post.createdAt || Date.now()
  };
  const res = await cloudRequest('/api/posts', {
    method: 'POST',
    body: JSON.stringify(payload)
  }, 120000);
  if (res && res.ok) {
    if (res.id && res.id !== post.id) {
      const others = getLocalPostCache().filter(p => p.id !== post.id);
      post.id = res.id;
      saveLocalPostCache(mergePostLists(others, [post]));
    }
    return true;
  }
  if (typeof scheduleResyncOrphanPosts === 'function') scheduleResyncOrphanPosts();
  return false;
}

if (typeof createPublicPost === 'function') {
  createPublicPost = async function (kind, text, mediaFile, attachmentFile) {
    const user = getCurrentUser();
    if (!user) {
      showToast('ログインが必要です');
      return false;
    }
    if (!getUsableSyncUrl()) {
      showToast('同期サーバーに接続できません。マイページで設定を確認してください');
      return false;
    }
    try {
      const media = mediaFile
        ? await withAsyncTimeout(readPostMediaFile(mediaFile), POST_MEDIA_TIMEOUT_MS, 'メディアの処理がタイムアウトしました')
        : null;
      const attachment = attachmentFile
        ? await withAsyncTimeout(readPostAttachmentFile(attachmentFile), POST_MEDIA_TIMEOUT_MS, '添付ファイルの処理がタイムアウトしました')
        : null;
      if (kind === 'photo' && !media) {
        showToast('写真を選択してください');
        return false;
      }
      if (kind === 'video' && !media) {
        showToast('動画を選択してください');
        return false;
      }
      if (kind === 'notice' && !text.trim() && !media && !attachment) {
        showToast('説明・写真・動画・ファイルのいずれかを入力してください');
        return false;
      }
      const postId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const savedPost = {
        id: postId,
        kind,
        text: text.trim(),
        authorId: user.id,
        authorName: user.name,
        authorAvatar: user.avatar || null,
        media,
        attachment,
        createdAt: Date.now()
      };
      cachePostLocally(savedPost);
      uploadPostToServerAsync(savedPost).catch(() => {
        if (typeof scheduleResyncOrphanPosts === 'function') scheduleResyncOrphanPosts();
      });
      showToast('投稿しました');
      renderFeed().catch(() => {});
      updateTabBadges();
      return true;
    } catch (e) {
      showToast(e.message || '投稿に失敗しました');
      return false;
    }
  };
}

if (typeof submitPublicPostFromModal === 'function') {
  submitPublicPostFromModal = async function () {
    if (postSubmitInProgress) return;
    const submitBtn = document.getElementById('btn-submit-post');
    const kind = document.getElementById('input-post-kind')?.value || 'photo';
    const text = document.getElementById('input-post-text')?.value || '';
    const mediaFile = document.getElementById('input-post-media')?.files?.[0];
    const attachFile = document.getElementById('input-post-attachment')?.files?.[0];

    postSubmitInProgress = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '投稿中…';
    }
    const safetyTimer = setTimeout(() => {
      if (!postSubmitInProgress) return;
      postSubmitInProgress = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '投稿する';
      }
      showToast('投稿がタイムアウトしました。接続を確認して再試行してください');
    }, POST_SUBMIT_TIMEOUT_MS);

    try {
      const ok = await createPublicPost(kind, text, mediaFile, attachFile);
      if (ok) {
        hideModal('modal-create-post');
        const textEl = document.getElementById('input-post-text');
        const mediaEl = document.getElementById('input-post-media');
        const attachEl = document.getElementById('input-post-attachment');
        if (textEl) textEl.value = '';
        if (mediaEl) mediaEl.value = '';
        if (attachEl) attachEl.value = '';
      }
    } catch (e) {
      showToast(e?.message || '投稿に失敗しました');
    } finally {
      clearTimeout(safetyTimer);
      postSubmitInProgress = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '投稿する';
      }
    }
  };
}

const _onTransferScanSuccessV13 = onTransferScanSuccess;
onTransferScanSuccess = function (decodedText) {
  if (transferScanHandled) return;
  const pairCode = parseDevicePairFromScan(decodedText);
  if (pairCode) {
    transferScanHandled = true;
    qrScanHandled = true;
    stopTransferScanner();
    showToast('ペアリング中…');
    redeemDevicePairCode(pairCode).then(handleDevicePairResult);
    return;
  }
  _onTransferScanSuccessV13(decodedText);
};

if (typeof updateAccountSyncStatusUI === 'function') {
  updateAccountSyncStatusUI = function () {
    const el = document.getElementById('account-sync-status');
    if (!el) return;
    const user = getCurrentUser();
    if (!user) {
      el.textContent = '';
      return;
    }
    if (!user.passwordHash) {
      el.textContent = 'パスワードを設定し、QRで端末をペアリングすると同期が始まります。';
      return;
    }
    const ts = parseInt(localStorage.getItem(ACCOUNT_SYNC_TS_KEY) || '0', 10);
    if (ts) {
      el.textContent = `QRペアリング同期: 有効（最終同期 ${formatTime(ts)}）`;
    } else {
      el.textContent = 'QRペアリング同期: パスワード設定済み — 「ペアリングQRを表示」で他端末と接続';
    }
  };
}

function initV13Features() {
  bindClick('btn-show-device-pair-qr', () => showDevicePairQRModal());
  bindClick('btn-scan-device-pair', () => showDevicePairScanModal());
  bindClick('btn-account-login-onboarding', () => showDevicePairScanModal());
  bindClick('btn-cloud-restore', () => showDevicePairScanModal());
  bindClick('btn-cloud-restore-onboarding', () => showDevicePairScanModal());
  bindClick('btn-admin-refresh-users', async () => {
    await ensureAdminConvSyncedBackground(true);
    renderAdminUsers();
    renderMainAdminConversationsCached();
  });
  document.querySelectorAll('[data-main-admin-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.mainAdminTab === 'conversations') {
        ensureAdminConvSyncedBackground(false).then(() => renderMainAdminConversationsCached());
      }
    });
  });
}

onAppInit(() => {
  initV13Features();
  if (typeof updateAccountSyncStatusUI === 'function') updateAccountSyncStatusUI();
});
