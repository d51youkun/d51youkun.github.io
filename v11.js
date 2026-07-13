// v11 — 公開投稿フィード・友だち申請・スタンプ共有

const FEED_READ_KEY = 'bluechat_feed_read';
const STICKER_SHARE_PREFIX = 'bc-sticker:';

function getFeedReadMap() {
  try {
    return JSON.parse(localStorage.getItem(FEED_READ_KEY) || '{}');
  } catch (e) { return {}; }
}

function markFeedItemRead(itemId) {
  const map = getFeedReadMap();
  map[itemId] = Date.now();
  localStorage.setItem(FEED_READ_KEY, JSON.stringify(map));
  updateTabBadges();
}

async function fetchPublicPosts() {
  if (!getUsableSyncUrl()) return [];
  const list = await cloudRequest('/api/posts');
  return Array.isArray(list) ? list : [];
}

function getUsableSyncUrl() {
  const candidates = typeof getSyncUrlCandidates === 'function'
    ? getSyncUrlCandidates()
    : [getSyncUrl()].filter(Boolean);
  const usable = candidates.filter(u =>
    typeof isMixedContentBlocked !== 'function' || !isMixedContentBlocked(u)
  );
  return usable[0] || '';
}

let postSubmitInProgress = false;

async function submitPublicPostFromModal() {
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
  showToast('投稿中…', 1200);

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
    postSubmitInProgress = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '投稿する';
    }
  }
}

async function compressPostImage(file) {
  if (file.type === 'image/gif' || file.type === 'image/webp') {
    if (file.size > FILE_LIMITS.postAnimated) {
      throw new Error('GIF/WebPは' + formatFileLimit(FILE_LIMITS.postAnimated) + '以下にしてください');
    }
    return readFileAsDataURL(file);
  }
  if (file.size > FILE_LIMITS.postImageInput) {
    throw new Error('画像は' + formatFileLimit(FILE_LIMITS.postImageInput) + '以下にしてください');
  }
  return compressImageFile(file, 2048, 0.88);
}

async function readPostMediaFile(file) {
  if (!file) return null;
  if (file.type.startsWith('image/')) {
    const data = await compressPostImage(file);
    if (data.length > FILE_LIMITS.postImageData) {
      throw new Error('画像が大きすぎます（' + formatFileLimit(FILE_LIMITS.postImageData) + '以下）');
    }
    return { type: 'image', data, mimeType: file.type, fileName: file.name };
  }
  if (file.type.startsWith('video/')) {
    if (file.size > FILE_LIMITS.postVideo) {
      throw new Error('動画は' + formatFileLimit(FILE_LIMITS.postVideo) + '以下にしてください');
    }
    const data = await readFileAsDataURL(file);
    return { type: 'video', data, mimeType: file.type, fileName: file.name };
  }
  return null;
}

async function readPostAttachmentFile(file) {
  if (!file) return null;
  if (file.size > FILE_LIMITS.postAttachment) {
    throw new Error('添付ファイルは' + formatFileLimit(FILE_LIMITS.postAttachment) + '以下にしてください');
  }
  const data = await readFileAsDataURL(file);
  return { fileName: file.name, data, mimeType: file.type || 'application/octet-stream', size: file.size };
}

async function createPublicPost(kind, text, mediaFile, attachmentFile) {
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
    const media = await readPostMediaFile(mediaFile);
    const attachment = await readPostAttachmentFile(attachmentFile);
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
    const res = await cloudRequest('/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        kind,
        text: text.trim(),
        authorId: user.id,
        authorName: user.name,
        authorAvatar: user.avatar || null,
        media,
        attachment
      })
    }, 300000);
    if (!res || !res.ok) {
      showToast('投稿に失敗しました。同期サーバー接続を確認してください');
      return false;
    }
    showToast('投稿しました');
    await renderFeed();
    updateTabBadges();
    return true;
  } catch (e) {
    showToast(e.message || '投稿に失敗しました');
    return false;
  }
}

async function deletePublicPost(postId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  if (!confirm('この投稿を削除しますか？')) return;
  await cloudRequest(`/api/posts/${postId}`, {
    method: 'DELETE',
    body: JSON.stringify({ userId: user.id })
  });
  showToast('投稿を削除しました');
  renderFeed();
}

function feedAuthorCardHtml(authorId, authorName, authorAvatar) {
  const user = getCurrentUser();
  const aid = String(authorId || '');
  const isMe = user && String(user.id) === aid;
  const avatar = authorAvatar
    ? `<img src="${authorAvatar}" alt="" class="feed-author-avatar-img">`
    : `<span class="feed-author-initial">${escapeHtml((authorName || '?').charAt(0))}</span>`;
  let actionBtn = '';
  if (user && !isMe) {
    if (areFriends(user.id, aid)) {
      actionBtn = '<span class="feed-friend-status">友だち</span>';
    } else {
      actionBtn = `<button type="button" class="btn-secondary btn-sm btn-feed-friend-request" data-user-id="${escapeHtml(aid)}">友だち申請</button>`;
    }
  }
  return `
    <div class="feed-author-card" data-author-id="${escapeHtml(aid)}">
      <div class="feed-author-avatar">${avatar}</div>
      <div class="feed-author-info">
        <span class="feed-author-name">${escapeHtml(authorName || 'ユーザー')}</span>
        ${actionBtn}
      </div>
    </div>`;
}

function renderFeedMedia(media) {
  if (!media || !media.data) return '';
  if (media.type === 'video' || (media.mimeType || '').startsWith('video/')) {
    return `<video src="${media.data}" class="feed-media feed-video" controls playsinline preload="metadata"></video>`;
  }
  const anim = isAnimatedStickerSource(media.data);
  const cls = anim ? 'feed-media feed-image feed-animated' : 'feed-media feed-image';
  return `<img src="${media.data}" alt="" class="${cls}" loading="lazy">`;
}

function renderFeedAttachment(att) {
  if (!att || !att.data) return '';
  const name = escapeHtml(att.fileName || 'file');
  return `<a href="${att.data}" download="${name}" class="feed-attachment-link">📎 ${name} をダウンロード</a>`;
}

function feedKindLabel(kind) {
  if (kind === 'video') return '動画';
  if (kind === 'notice') return '告知';
  return '写真';
}

async function renderFeed() {
  const list = document.getElementById('feed-list') || document.getElementById('notice-list');
  const empty = document.getElementById('feed-list-empty') || document.getElementById('notice-list-empty');
  if (!list) return;
  const user = getCurrentUser();
  const [posts, announcements] = await Promise.all([
    fetchPublicPosts(),
    typeof fetchAnnouncements === 'function' ? fetchAnnouncements() : []
  ]);
  const read = getFeedReadMap();
  const annRead = typeof getAnnouncementReadMap === 'function' ? getAnnouncementReadMap() : {};
  const feedItems = [];

  posts.forEach(p => {
    feedItems.push({
      id: 'post_' + p.id,
      postId: p.id,
      kind: p.kind || 'photo',
      text: p.text || '',
      authorId: p.authorId,
      authorName: p.authorName,
      authorAvatar: p.authorAvatar,
      media: p.media,
      attachment: p.attachment,
      createdAt: p.createdAt,
      isPost: true,
      unread: !read['post_' + p.id]
    });
  });

  (announcements || []).forEach(a => {
    feedItems.push({
      id: 'ann_' + a.id,
      annId: a.id,
      kind: 'notice',
      text: (a.title ? a.title + '\n' : '') + (a.body || ''),
      title: a.title,
      body: a.body,
      authorId: a.authorId,
      authorName: a.authorName,
      authorAvatar: a.authorAvatar || null,
      media: a.media,
      attachment: a.attachment,
      createdAt: a.createdAt,
      isPost: false,
      unread: !annRead[a.id],
      comments: a.comments || []
    });
  });

  feedItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  list.innerHTML = '';

  if (!feedItems.length) {
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  feedItems.forEach(item => {
    const el = document.createElement('div');
    el.className = 'feed-item glass-panel' + (item.unread ? ' unread' : '');
    const canDelete = user && item.isPost && String(item.authorId) === String(user.id);
    const textHtml = item.title
      ? `<h3 class="feed-title">${escapeHtml(item.title)}</h3><p class="feed-text">${escapeHtml(item.body || '')}</p>`
      : (item.text ? `<p class="feed-text">${escapeHtml(item.text)}</p>` : '');

    el.innerHTML = `
      <div class="feed-header">
        <span class="feed-kind">${feedKindLabel(item.kind)}</span>
        <span class="feed-date">${new Date(item.createdAt).toLocaleString('ja-JP')}</span>
        ${canDelete ? `<button type="button" class="btn-delete-post btn-sm" data-post-id="${item.postId}">削除</button>` : ''}
      </div>
      ${textHtml}
      ${renderFeedMedia(item.media)}
      ${renderFeedAttachment(item.attachment)}
      ${feedAuthorCardHtml(item.authorId, item.authorName, item.authorAvatar)}
      ${!item.isPost ? `<div class="feed-comments" id="feed-comments-${item.annId}"></div>
        <div class="feed-comment-form">
          <input type="text" class="feed-comment-input" placeholder="コメント…" data-ann-id="${item.annId}">
          <button type="button" class="btn-secondary btn-sm btn-feed-comment" data-ann-id="${item.annId}">送信</button>
        </div>` : ''}`;

    el.addEventListener('click', (e) => {
      if (e.target.closest('.feed-author-card, .feed-comment-form, .btn-delete-post, .feed-attachment-link')) return;
      if (item.isPost) markFeedItemRead(item.id);
      else if (typeof markAnnouncementRead === 'function') markAnnouncementRead(item.annId);
      el.classList.remove('unread');
    });

    if (!item.isPost) {
      const commentsEl = el.querySelector(`#feed-comments-${item.annId}`);
      (item.comments || []).forEach(c => {
        const cEl = document.createElement('div');
        cEl.className = 'feed-comment';
        const canDel = user && c.userId === user.id;
        cEl.innerHTML = `<strong>${escapeHtml(c.userName)}</strong>: ${escapeHtml(c.text)}${canDel ? ` <button type="button" class="btn-delete-post btn-sm" data-ann-id="${item.annId}" data-comment-id="${c.id}">削除</button>` : ''}`;
        commentsEl?.appendChild(cEl);
      });
      el.querySelector('.btn-feed-comment')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const input = el.querySelector('.feed-comment-input');
        if (typeof postAnnouncementComment === 'function') {
          await postAnnouncementComment(item.annId, input?.value || '');
          input.value = '';
          renderFeed();
        }
      });
      el.querySelectorAll('.btn-delete-post[data-comment-id]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('コメントを削除しますか？')) return;
          if (typeof deleteAnnouncementComment === 'function') {
            await deleteAnnouncementComment(btn.dataset.annId, btn.dataset.commentId);
            renderFeed();
          }
        });
      });
    }

    el.querySelector('.btn-delete-post[data-post-id]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deletePublicPost(e.target.dataset.postId);
    });

    el.querySelector('.btn-feed-friend-request')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await sendFriendRequest(e.target.dataset.userId);
    });

    list.appendChild(el);
  });
  updateTabBadges();
}

// ─── Friend requests ───────────────────────────────────────
async function fetchFriendRequests() {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return [];
  const list = await cloudRequest(`/api/friend-requests?userId=${encodeURIComponent(user.id)}`);
  return Array.isArray(list) ? list : [];
}

async function sendFriendRequest(toUserId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) {
    showToast('同期サーバーが必要です');
    return;
  }
  const toId = String(toUserId);
  if (toId === String(user.id)) return;
  if (areFriends(user.id, toId)) {
    showToast('すでに友だちです');
    return;
  }
  const pending = await fetchFriendRequests();
  const existing = pending.find(r =>
    (String(r.fromId) === String(user.id) && String(r.toId) === toId) ||
    (String(r.fromId) === toId && String(r.toId) === String(user.id))
  );
  if (existing) {
    if (String(existing.fromId) === String(user.id)) {
      showToast('申請済みです');
    } else {
      showToast('相手から申請が届いています。友だちタブで承認してください');
    }
    return;
  }
  const res = await cloudRequest('/api/friend-requests', {
    method: 'POST',
    body: JSON.stringify({
      fromId: user.id,
      fromName: user.name,
      fromAvatar: user.avatar || null,
      toId
    })
  });
  if (res && res.error === 'already_friends') {
    showToast('すでに友だちです');
    return;
  }
  showToast('友だち申請を送りました');
  renderFriendRequests();
}

async function acceptFriendRequest(requestId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  const res = await cloudRequest(`/api/friend-requests/${requestId}`, {
    method: 'PUT',
    body: JSON.stringify({ userId: user.id, action: 'accept' })
  });
  if (!res || !res.ok) {
    showToast('承認に失敗しました');
    return;
  }
  const list = await fetchFriendRequests();
  const fr = list.find(r => r.id === requestId);
  if (fr) {
    ensureLocalUser({ id: fr.fromId, name: fr.fromName, avatar: fr.fromAvatar });
    addFriendship(user.id, fr.fromId, { skipCloud: true });
    await cloudPushFriendship(user.id, fr.fromId);
    if (typeof syncAllConversations === 'function') await syncAllConversations();
  }
  showToast('友だちになりました');
  renderFriendRequests();
  renderFriendList();
  renderFeed();
}

async function declineFriendRequest(requestId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  await cloudRequest(`/api/friend-requests/${requestId}`, {
    method: 'PUT',
    body: JSON.stringify({ userId: user.id, action: 'decline' })
  });
  showToast('申請を辞退しました');
  renderFriendRequests();
}

async function renderFriendRequests() {
  const container = document.getElementById('friend-request-list');
  const section = document.getElementById('friend-requests-section');
  if (!container) return;
  const user = getCurrentUser();
  if (!user) return;
  const list = await fetchFriendRequests();
  const incoming = list.filter(r => String(r.toId) === String(user.id));
  container.innerHTML = '';
  if (!incoming.length) {
    section?.classList.add('hidden');
    return;
  }
  section?.classList.remove('hidden');
  incoming.forEach(fr => {
    const item = document.createElement('div');
    item.className = 'friend-request-item glass-panel';
    const avatar = fr.fromAvatar
      ? `<img src="${fr.fromAvatar}" alt="" class="friend-request-avatar">`
      : `<span class="friend-request-initial">${escapeHtml((fr.fromName || '?').charAt(0))}</span>`;
    item.innerHTML = `
      <div class="friend-request-user">
        ${avatar}
        <div>
          <div class="friend-request-name">${escapeHtml(fr.fromName || 'ユーザー')}</div>
          <div class="friend-request-hint">友だち申請が届きました</div>
        </div>
      </div>
      <div class="friend-request-actions">
        <button type="button" class="btn-primary btn-sm btn-accept-friend" data-req-id="${fr.id}">承認</button>
        <button type="button" class="btn-secondary btn-sm btn-decline-friend" data-req-id="${fr.id}">辞退</button>
      </div>`;
    item.querySelector('.btn-accept-friend')?.addEventListener('click', () => acceptFriendRequest(fr.id));
    item.querySelector('.btn-decline-friend')?.addEventListener('click', () => declineFriendRequest(fr.id));
    container.appendChild(item);
  });
}

// ─── Sticker pack sharing ──────────────────────────────────
function parseStickerShareCode(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/bc-sticker:([a-zA-Z0-9_-]+)/i);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{6,12}$/.test(s)) return s;
  return null;
}

async function shareStickerPack(packId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) {
    showToast('同期サーバーが必要です');
    return;
  }
  const pack = getCustomStickerPacks().find(p => p.id === packId);
  if (!pack) {
    showToast('スタンプ帳が見つかりません');
    return;
  }
  const stickers = (pack.stickers || []).slice(0, 40).map(st => ({
    type: st.type || 'image',
    src: st.src,
    emoji: st.emoji || '🎨',
    isGif: st.isGif || st.isAnimated || isAnimatedStickerSource(st.src),
    isAnimated: st.isGif || st.isAnimated || isAnimatedStickerSource(st.src)
  }));
  showToast('共有コードを作成中…');
  const res = await cloudRequestExt('/api/shared-sticker-packs', {
    method: 'POST',
    body: JSON.stringify({
      packName: pack.name,
      authorId: user.id,
      authorName: user.name,
      stickers
    })
  }, 300000);
  if (!res || !res.shareId) {
    showToast('共有に失敗しました');
    return;
  }
  const code = res.code || (STICKER_SHARE_PREFIX + res.shareId);
  const shareEl = document.getElementById('sticker-share-code');
  if (shareEl) shareEl.textContent = code;
  try {
    await navigator.clipboard.writeText(code);
    showToast('共有コードをコピーしました: ' + code);
  } catch (e) {
    showToast('共有コード: ' + code);
  }
}

async function importStickerPackByCode(raw) {
  const shareId = parseStickerShareCode(raw);
  if (!shareId) {
    showToast('bc-sticker:コード を入力してください');
    return;
  }
  if (!getSyncUrl()) {
    showToast('同期サーバーが必要です');
    return;
  }
  showToast('スタンプを取得中…');
  const remote = await cloudRequest(`/api/shared-sticker-packs/${encodeURIComponent(shareId)}`);
  if (!remote || !remote.stickers || !remote.stickers.length) {
    showToast('スタンプが見つかりません');
    return;
  }
  const pack = {
    id: 'shared_' + shareId + '_' + generateId().slice(0, 4),
    name: (remote.packName || '共有スタンプ') + ' (共有)',
    stickers: remote.stickers.map(st => ({
      type: 'image',
      src: st.src,
      emoji: st.emoji || (st.isAnimated ? '🎬' : '🖼️'),
      isGif: st.isGif || st.isAnimated,
      isAnimated: st.isGif || st.isAnimated
    }))
  };
  saveCustomStickerPack(pack);
  renderStickerPicker();
  showToast(`「${pack.name}」を追加しました（${pack.stickers.length}枚）`);
}

function showCreatePostModal(kind) {
  const modal = document.getElementById('modal-create-post');
  if (!modal) return;
  const kindInput = document.getElementById('input-post-kind');
  if (kindInput) kindInput.value = kind || 'photo';
  updateCreatePostForm(kind || 'photo');
  showModal('modal-create-post');
}

function updateCreatePostForm(kind) {
  const mediaLabel = document.getElementById('label-post-media');
  const mediaInput = document.getElementById('input-post-media');
  const attachWrap = document.getElementById('post-attachment-wrap');
  if (!mediaInput) return;
  if (kind === 'photo') {
    if (mediaLabel) mediaLabel.textContent = '写真';
    mediaInput.accept = 'image/*';
    if (attachWrap) attachWrap.classList.add('hidden');
  } else if (kind === 'video') {
    if (mediaLabel) mediaLabel.textContent = '動画';
    mediaInput.accept = 'video/*';
    if (attachWrap) attachWrap.classList.add('hidden');
  } else {
    if (mediaLabel) mediaLabel.textContent = '写真・動画（任意）';
    mediaInput.accept = 'image/*,video/*';
    if (attachWrap) attachWrap.classList.remove('hidden');
  }
}

// ─── Wrap v7 hooks ─────────────────────────────────────────
const _renderAnnouncementsV11 = renderAnnouncements;
renderAnnouncements = function () {
  return renderFeed();
};

const _handleRemoteActivityV11 = handleRemoteActivity;
handleRemoteActivity = async function () {
  await _handleRemoteActivityV11();
  if (currentTab === 'notices') await renderFeed();
  await renderFriendRequests();
};

const _updateTabBadgesV11 = updateTabBadges;
updateTabBadges = async function () {
  const [posts, announcements] = await Promise.all([
    fetchPublicPosts(),
    typeof fetchAnnouncements === 'function' ? fetchAnnouncements() : []
  ]);
  const feedRead = getFeedReadMap();
  const annRead = typeof getAnnouncementReadMap === 'function' ? getAnnouncementReadMap() : {};
  let unread = 0;
  posts.forEach(p => { if (!feedRead['post_' + p.id]) unread++; });
  (announcements || []).forEach(a => { if (!annRead[a.id]) unread++; });
  setTabBadge('notices', unread);
  setTabBadge('chats', countUnreadChats());

  const user = getCurrentUser();
  if (user && getSyncUrl()) {
    const reqs = await fetchFriendRequests();
    const incoming = reqs.filter(r => String(r.toId) === String(user.id)).length;
    setTabBadge('friends', incoming);
  }
};

const _renderFriendListV11 = renderFriendList;
renderFriendList = function () {
  _renderFriendListV11();
  renderFriendRequests();
};

const _renderStickerPickerV11 = renderStickerPicker;
renderStickerPicker = function () {
  _renderStickerPickerV11();
  const grid = document.getElementById('sticker-grid');
  if (!grid) return;
  getCustomStickerPacks().forEach(pack => {
    const headers = grid.querySelectorAll('.sticker-pack-header');
    headers.forEach(header => {
      const label = header.querySelector('.sticker-pack-label');
      if (!label || label.textContent !== pack.name) return;
      if (header.querySelector('.btn-share-pack')) return;
      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'btn-text-link btn-share-pack';
      shareBtn.textContent = '共有';
      shareBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        shareStickerPack(pack.id);
      });
      header.appendChild(shareBtn);
    });
  });
};

function initV11Features() {
  bindClick('btn-create-post', () => showCreatePostModal('photo'));
  bindClick('btn-create-post-video', () => showCreatePostModal('video'));
  bindClick('btn-create-post-notice', () => showCreatePostModal('notice'));
  bindClick('btn-refresh-feed', () => renderFeed());

  document.querySelectorAll('.tab[data-tab="notices"]').forEach(tab => {
    tab.addEventListener('click', () => renderFeed());
  });
  document.querySelectorAll('.tab[data-tab="friends"]').forEach(tab => {
    tab.addEventListener('click', () => renderFriendRequests());
  });

  const postKind = document.getElementById('input-post-kind');
  if (postKind) {
    postKind.addEventListener('change', () => updateCreatePostForm(postKind.value));
  }

  bindClick('btn-import-sticker-share', () => {
    const code = document.getElementById('input-sticker-share-code')?.value || '';
    importStickerPackByCode(code);
  });

  renderFriendRequests();
}

onAppInit(() => {
  initV11Features();
});
