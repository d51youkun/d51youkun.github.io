/**
 * BlueChat v24 — 投稿の評価・コメント即時反映 + サーバー同期の安定化
 */
var APP_VERSION = 'v24';

async function feedCloudRequest(path, options = {}, timeoutMs = 60000) {
  const base = getUsableSyncUrl();
  if (!base) return { ok: false, status: 0, data: null, error: 'no_sync' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-json */ }
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: data?.error || (res.ok ? null : 'request_failed')
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: e?.name === 'AbortError' ? 'timeout' : 'network'
    };
  } finally {
    clearTimeout(timer);
  }
}

function repaintFeedFromCache() {
  const user = getCurrentUser();
  const cachedPosts = getLocalPostCache().map(normalizePostClient);
  const cachedAnn = typeof getAnnouncementCache === 'function' ? getAnnouncementCache() : [];
  paintFeedList(buildFeedItems(cachedPosts, cachedAnn), user);
}

function updateLocalPostInCache(postId, updater) {
  const cached = getLocalPostCache().map(p => {
    if (p.id !== postId) return p;
    return updater(normalizePostClient(p));
  });
  saveLocalPostCache(cached);
}

function applyVoteToLocalPost(postId, userId, nextVote) {
  updateLocalPostInCache(postId, (n) => {
    delete n.likes[userId];
    delete n.dislikes[userId];
    if (nextVote === 'up') n.likes[userId] = Date.now();
    else if (nextVote === 'down') n.dislikes[userId] = Date.now();
    return n;
  });
}

function appendCommentToLocalPost(postId, comment) {
  updateLocalPostInCache(postId, (n) => {
    n.comments = [...(n.comments || []), comment];
    return n;
  });
}

function removeCommentFromLocalPost(postId, commentId) {
  updateLocalPostInCache(postId, (n) => {
    n.comments = (n.comments || []).filter(c => c.id !== commentId);
    return n;
  });
}

async function ensurePostOnServer(postId) {
  const post = getLocalPostCache().find(p => p.id === postId);
  if (!post || !getUsableSyncUrl()) return false;
  const res = await feedCloudRequest('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      id: post.id,
      kind: post.kind,
      text: post.text || '',
      authorId: post.authorId,
      authorName: post.authorName,
      authorAvatar: post.authorAvatar || null,
      media: post.media || null,
      attachment: post.attachment || null,
      createdAt: post.createdAt || Date.now()
    })
  }, 300000);
  return res.ok;
}

function feedActionErrorMessage(res) {
  if (!res) return '通信に失敗しました';
  if (res.error === 'no_sync') return '同期サーバーに接続できません';
  if (res.error === 'timeout') return 'サーバー応答がタイムアウトしました';
  if (res.status === 404) return '投稿がサーバーに見つかりません';
  if (res.status === 400) return '送信内容が不正です';
  return 'サーバーへの保存に失敗しました';
}

bindFeedItemEvents = function (el, item, user) {
  el.addEventListener('click', (e) => {
    if (e.target.closest('.feed-author-card, .feed-comment-form, .feed-engage-bar, .btn-delete-post, .feed-attachment-link, .btn-feed-vote, .btn-feed-comment')) return;
    if (item.isPost) markFeedItemRead(item.id);
    else if (typeof markAnnouncementRead === 'function') markAnnouncementRead(item.annId);
    el.classList.remove('unread');
  });

  el.querySelectorAll('.btn-feed-vote').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await voteOnPost(btn.dataset.postId, btn.dataset.vote);
      } finally {
        btn.disabled = false;
      }
    });
  });

  const commentsKey = item.isPost ? item.postId : item.annId;
  const commentsEl = el.querySelector(`#feed-comments-${commentsKey}`);
  paintFeedComments(commentsEl, item.comments, user, item);

  const commentBtn = el.querySelector('.btn-feed-comment');
  const commentInput = el.querySelector('.feed-comment-input');
  if (commentBtn) {
    commentBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (commentBtn.disabled) return;
      const text = commentInput?.value || '';
      commentBtn.disabled = true;
      try {
        if (item.isPost) await postPostComment(item.postId, text);
        else if (typeof postAnnouncementComment === 'function') await postAnnouncementComment(item.annId, text);
        if (commentInput) commentInput.value = '';
      } finally {
        commentBtn.disabled = false;
      }
    });
  }
  commentInput?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    commentBtn?.click();
  });

  el.querySelectorAll('.btn-delete-feed-comment').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('コメントを削除しますか？')) return;
      if (btn.dataset.postId) await deletePostComment(btn.dataset.postId, btn.dataset.commentId);
      else if (typeof deleteAnnouncementComment === 'function') await deleteAnnouncementComment(btn.dataset.annId, btn.dataset.commentId);
      repaintFeedFromCache();
      fetchPublicPosts().then(() => repaintFeedFromCache());
    });
  });

  el.querySelectorAll('.btn-delete-post[data-comment-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('コメントを削除しますか？')) return;
      if (typeof deleteAnnouncementComment === 'function') await deleteAnnouncementComment(btn.dataset.annId, btn.dataset.commentId);
      repaintFeedFromCache();
    });
  });

  el.querySelector('.btn-delete-post[data-post-id]:not([data-comment-id])')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await deletePublicPost(e.target.dataset.postId);
  });

  el.querySelector('.btn-feed-friend-request')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await sendFriendRequest(e.target.dataset.userId);
  });
};

voteOnPost = async function (postId, vote) {
  const user = getCurrentUser();
  if (!user || !getUsableSyncUrl()) {
    showToast('ログインと同期サーバーが必要です');
    return;
  }
  const post = normalizePostClient(getLocalPostCache().find(p => p.id === postId));
  if (!post) {
    showToast('投稿が見つかりません');
    return;
  }
  const current = getUserPostVote(post, user.id);
  let nextVote = vote;
  if (current === vote) nextVote = 'none';

  applyVoteToLocalPost(postId, user.id, nextVote);
  repaintFeedFromCache();

  let res = await feedCloudRequest(`/api/posts/${encodeURIComponent(postId)}/vote`, {
    method: 'PUT',
    body: JSON.stringify({ userId: user.id, vote: nextVote })
  });
  if (!res.ok && res.status === 404) {
    const synced = await ensurePostOnServer(postId);
    if (synced) {
      res = await feedCloudRequest(`/api/posts/${encodeURIComponent(postId)}/vote`, {
        method: 'PUT',
        body: JSON.stringify({ userId: user.id, vote: nextVote })
      });
    }
  }
  if (!res.ok) {
    applyVoteToLocalPost(postId, user.id, current === 'up' ? 'up' : current === 'down' ? 'down' : 'none');
    repaintFeedFromCache();
    showToast(feedActionErrorMessage(res));
    return;
  }
  fetchPublicPosts().then(() => repaintFeedFromCache());
};

postPostComment = async function (postId, text) {
  const user = getCurrentUser();
  if (!user || !getUsableSyncUrl()) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;

  const tempId = 'tmp_' + Date.now().toString(36);
  const optimistic = {
    id: tempId,
    userId: user.id,
    userName: user.name,
    userAvatar: user.avatar || null,
    text: trimmed,
    createdAt: Date.now()
  };
  appendCommentToLocalPost(postId, optimistic);
  repaintFeedFromCache();

  let res = await feedCloudRequest(`/api/posts/${encodeURIComponent(postId)}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      userId: user.id,
      userName: user.name,
      userAvatar: user.avatar || null,
      text: trimmed
    })
  });
  if (!res.ok && res.status === 404) {
    const synced = await ensurePostOnServer(postId);
    if (synced) {
      res = await feedCloudRequest(`/api/posts/${encodeURIComponent(postId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          userName: user.name,
          userAvatar: user.avatar || null,
          text: trimmed
        })
      });
    }
  }
  if (!res.ok) {
    removeCommentFromLocalPost(postId, tempId);
    repaintFeedFromCache();
    showToast('コメントの送信に失敗しました。' + feedActionErrorMessage(res));
    return;
  }
  if (res.data?.comment?.id) {
    removeCommentFromLocalPost(postId, tempId);
    appendCommentToLocalPost(postId, res.data.comment);
    repaintFeedFromCache();
  }
  fetchPublicPosts().then(() => repaintFeedFromCache());
};

deletePostComment = async function (postId, commentId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  const prev = normalizePostClient(getLocalPostCache().find(p => p.id === postId));
  const removed = (prev?.comments || []).find(c => c.id === commentId);
  removeCommentFromLocalPost(postId, commentId);
  repaintFeedFromCache();
  const res = await feedCloudRequest(`/api/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ userId: user.id })
  });
  if (!res.ok && removed) {
    appendCommentToLocalPost(postId, removed);
    repaintFeedFromCache();
    showToast(feedActionErrorMessage(res));
    return;
  }
  fetchPublicPosts().then(() => repaintFeedFromCache());
};

renderFeed = async function (options = {}) {
  const list = document.getElementById('feed-list') || document.getElementById('notice-list');
  if (!list) return;
  const gen = ++feedRenderGen;
  const user = getCurrentUser();

  repaintFeedFromCache();
  if (options.cacheOnly) return;

  const [posts, announcements] = await Promise.all([
    fetchPublicPosts(),
    typeof fetchAnnouncements === 'function' ? fetchAnnouncements() : Promise.resolve([])
  ]);
  if (gen !== feedRenderGen) return;
  paintFeedList(buildFeedItems(posts, announcements || []), user);
  if (typeof updateTabBadges === 'function') updateTabBadges();
};

createPublicPost = async function (kind, text, mediaFile, attachmentFile) {
  const ok = await _createPublicPostV23(kind, text, mediaFile, attachmentFile);
  if (ok) {
    repaintFeedFromCache();
    fetchPublicPosts().then(() => repaintFeedFromCache());
  }
  return ok;
};

startFeedAutoRefresh = function () {
  if (feedAutoRefreshTimer) clearInterval(feedAutoRefreshTimer);
  feedAutoRefreshTimer = setInterval(() => {
    if (currentTab === 'notices') renderFeed();
  }, 25000);
};
