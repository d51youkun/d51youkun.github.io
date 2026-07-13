/**
 * BlueChat v23 — 投稿フィード常時表示 + 高評価/低評価/コメント
 */
var APP_VERSION = 'v23';

let feedRenderGen = 0;
let feedAutoRefreshTimer = null;

function normalizePostClient(p) {
  if (!p) return p;
  return {
    ...p,
    likes: p.likes && typeof p.likes === 'object' ? p.likes : {},
    dislikes: p.dislikes && typeof p.dislikes === 'object' ? p.dislikes : {},
    comments: Array.isArray(p.comments) ? p.comments : []
  };
}

function countPostVotes(map) {
  return Object.keys(map || {}).length;
}

function getUserPostVote(post, userId) {
  if (!userId || !post) return null;
  const uid = String(userId);
  if (post.likes && post.likes[uid]) return 'up';
  if (post.dislikes && post.dislikes[uid]) return 'down';
  return null;
}

function renderPostEngageBar(post, user) {
  const likes = countPostVotes(post.likes);
  const dislikes = countPostVotes(post.dislikes);
  const myVote = user ? getUserPostVote(post, user.id) : null;
  return `
    <div class="feed-engage-bar" data-post-id="${escapeHtml(post.id)}">
      <button type="button" class="btn-feed-vote btn-feed-like${myVote === 'up' ? ' active-like' : ''}" data-post-id="${escapeHtml(post.id)}" data-vote="up">👍 <span>${likes}</span></button>
      <button type="button" class="btn-feed-vote btn-feed-dislike${myVote === 'down' ? ' active-dislike' : ''}" data-post-id="${escapeHtml(post.id)}" data-vote="down">👎 <span>${dislikes}</span></button>
    </div>`;
}

function renderPostCommentsBlock(postId, comments, user, isPost) {
  const idKey = isPost ? postId : postId;
  const annAttr = isPost ? '' : ` data-ann-id="${escapeHtml(idKey)}"`;
  const postAttr = isPost ? ` data-post-id="${escapeHtml(postId)}"` : '';
  return `
    <div class="feed-comments-wrap">
      <div class="feed-comments" id="feed-comments-${escapeHtml(idKey)}"></div>
      <div class="feed-comment-form">
        <input type="text" class="feed-comment-input" placeholder="コメントを追加…" ${postAttr}${annAttr}>
        <button type="button" class="btn-secondary btn-sm btn-feed-comment" ${postAttr}${annAttr}>送信</button>
      </div>
    </div>`;
}

function paintFeedComments(container, comments, user, item) {
  if (!container) return;
  container.innerHTML = '';
  (comments || []).forEach(c => {
    const cEl = document.createElement('div');
    cEl.className = 'feed-comment';
    const canDel = user && String(c.userId) === String(user.id);
    const meta = c.createdAt ? `<span class="feed-comment-meta">${new Date(c.createdAt).toLocaleString('ja-JP')}</span>` : '';
    const delPost = item.isPost
      ? ` data-post-id="${item.postId}" data-comment-id="${c.id}"`
      : ` data-ann-id="${item.annId}" data-comment-id="${c.id}"`;
    cEl.innerHTML = `<strong>${escapeHtml(c.userName || 'ユーザー')}</strong>${meta}: ${escapeHtml(c.text || '')}${canDel ? ` <button type="button" class="btn-delete-post btn-sm btn-delete-feed-comment"${delPost}>削除</button>` : ''}`;
    container.appendChild(cEl);
  });
}

function bindFeedItemEvents(el, item, user) {
  el.addEventListener('click', (e) => {
    if (e.target.closest('.feed-author-card, .feed-comment-form, .feed-engage-bar, .btn-delete-post, .feed-attachment-link, .btn-feed-vote')) return;
    if (item.isPost) markFeedItemRead(item.id);
    else if (typeof markAnnouncementRead === 'function') markAnnouncementRead(item.annId);
    el.classList.remove('unread');
  });

  el.querySelectorAll('.btn-feed-vote').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await voteOnPost(btn.dataset.postId, btn.dataset.vote);
    });
  });

  const commentsKey = item.isPost ? item.postId : item.annId;
  const commentsEl = el.querySelector(`#feed-comments-${commentsKey}`);
  paintFeedComments(commentsEl, item.comments, user, item);

  el.querySelector('.btn-feed-comment')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const input = el.querySelector('.feed-comment-input');
    const text = input?.value || '';
    if (item.isPost) await postPostComment(item.postId, text);
    else if (typeof postAnnouncementComment === 'function') await postAnnouncementComment(item.annId, text);
    if (input) input.value = '';
    await renderFeed({ force: true });
  });

  el.querySelectorAll('.btn-delete-feed-comment').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('コメントを削除しますか？')) return;
      if (btn.dataset.postId) await deletePostComment(btn.dataset.postId, btn.dataset.commentId);
      else if (typeof deleteAnnouncementComment === 'function') await deleteAnnouncementComment(btn.dataset.annId, btn.dataset.commentId);
      await renderFeed({ force: true });
    });
  });

  el.querySelectorAll('.btn-delete-post[data-comment-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('コメントを削除しますか？')) return;
      if (typeof deleteAnnouncementComment === 'function') await deleteAnnouncementComment(btn.dataset.annId, btn.dataset.commentId);
      await renderFeed({ force: true });
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
}

function buildFeedItems(posts, announcements) {
  const read = getFeedReadMap();
  const annRead = typeof getAnnouncementReadMap === 'function' ? getAnnouncementReadMap() : {};
  const feedItems = [];

  (posts || []).forEach(p => {
    const post = normalizePostClient(p);
    feedItems.push({
      id: 'post_' + post.id,
      postId: post.id,
      kind: post.kind || 'photo',
      text: post.text || '',
      authorId: post.authorId,
      authorName: post.authorName,
      authorAvatar: post.authorAvatar,
      media: post.media,
      attachment: post.attachment,
      createdAt: post.createdAt,
      likes: post.likes,
      dislikes: post.dislikes,
      comments: post.comments,
      isPost: true,
      unread: !read['post_' + post.id]
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
  return feedItems;
}

function paintFeedList(feedItems, user) {
  const list = document.getElementById('feed-list') || document.getElementById('notice-list');
  const empty = document.getElementById('feed-list-empty') || document.getElementById('notice-list-empty');
  if (!list) return;

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

    const engageHtml = item.isPost ? renderPostEngageBar(item, user) : '';
    const commentsHtml = item.isPost
      ? renderPostCommentsBlock(item.postId, item.comments, user, true)
      : renderPostCommentsBlock(item.annId, item.comments, user, false);

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
      ${engageHtml}
      ${commentsHtml}`;

    bindFeedItemEvents(el, item, user);
    list.appendChild(el);
  });
}

async function voteOnPost(postId, vote) {
  const user = getCurrentUser();
  if (!user || !getUsableSyncUrl()) {
    showToast('ログインと同期サーバーが必要です');
    return;
  }
  const post = normalizePostClient(getLocalPostCache().find(p => p.id === postId));
  const current = getUserPostVote(post, user.id);
  let nextVote = vote;
  if (current === vote) nextVote = 'none';
  const res = await cloudRequest(`/api/posts/${postId}/vote`, {
    method: 'PUT',
    body: JSON.stringify({ userId: user.id, vote: nextVote })
  });
  if (!res || !res.ok) {
    showToast('評価の保存に失敗しました');
    return;
  }
  const cached = getLocalPostCache().map(p => {
    if (p.id !== postId) return p;
    const n = normalizePostClient(p);
    delete n.likes[user.id];
    delete n.dislikes[user.id];
    if (nextVote === 'up') n.likes[user.id] = Date.now();
    else if (nextVote === 'down') n.dislikes[user.id] = Date.now();
    return n;
  });
  saveLocalPostCache(cached);
  await renderFeed({ force: true });
}

async function postPostComment(postId, text) {
  const user = getCurrentUser();
  if (!user || !getUsableSyncUrl()) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const res = await cloudRequest(`/api/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      userId: user.id,
      userName: user.name,
      userAvatar: user.avatar || null,
      text: trimmed
    })
  });
  if (!res || !res.ok) {
    showToast('コメントの送信に失敗しました');
    return;
  }
  await fetchPublicPosts();
}

async function deletePostComment(postId, commentId) {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return;
  await cloudRequest(`/api/posts/${postId}/comments/${commentId}`, {
    method: 'DELETE',
    body: JSON.stringify({ userId: user.id })
  });
  await fetchPublicPosts();
}

const _mergePostListsV23 = mergePostLists;
mergePostLists = function (...lists) {
  const map = new Map();
  lists.forEach(list => {
    (list || []).forEach(p => {
      if (!p || !p.id) return;
      const next = normalizePostClient(p);
      const prev = map.get(p.id);
      if (!prev) {
        map.set(p.id, next);
        return;
      }
      map.set(p.id, {
        ...prev,
        ...next,
        likes: Object.keys(next.likes || {}).length >= Object.keys(prev.likes || {}).length ? next.likes : prev.likes,
        dislikes: Object.keys(next.dislikes || {}).length >= Object.keys(prev.dislikes || {}).length ? next.dislikes : prev.dislikes,
        comments: (next.comments || []).length >= (prev.comments || []).length ? next.comments : prev.comments
      });
    });
  });
  return [...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
};

const _fetchPublicPostsV23 = fetchPublicPosts;
fetchPublicPosts = async function () {
  const local = getLocalPostCache().map(normalizePostClient);
  if (!getUsableSyncUrl()) return local;
  try {
    const remote = await cloudRequest('/api/posts');
    const server = Array.isArray(remote) ? remote.map(normalizePostClient) : [];
    const merged = mergePostLists(server, local);
    saveLocalPostCache(merged);
    if (server.length < local.length) scheduleResyncOrphanPosts();
    return merged;
  } catch (e) {
    return local;
  }
};

const _renderFeedV23 = renderFeed;
renderFeed = async function (options = {}) {
  const list = document.getElementById('feed-list') || document.getElementById('notice-list');
  if (!list) return;
  const gen = ++feedRenderGen;
  const user = getCurrentUser();

  if (!options.force) {
    const cachedPosts = getLocalPostCache().map(normalizePostClient);
    const cachedAnn = typeof getAnnouncementCache === 'function' ? getAnnouncementCache() : [];
    paintFeedList(buildFeedItems(cachedPosts, cachedAnn), user);
  }

  const [posts, announcements] = await Promise.all([
    fetchPublicPosts(),
    typeof fetchAnnouncements === 'function' ? fetchAnnouncements() : Promise.resolve([])
  ]);
  if (gen !== feedRenderGen) return;
  paintFeedList(buildFeedItems(posts, announcements || []), user);
  if (typeof updateTabBadges === 'function') updateTabBadges();
};

function getAnnouncementCache() {
  try {
    return JSON.parse(localStorage.getItem('bluechat_ann_cache') || '[]');
  } catch (e) { return []; }
}

function startFeedAutoRefresh() {
  if (feedAutoRefreshTimer) clearInterval(feedAutoRefreshTimer);
  feedAutoRefreshTimer = setInterval(() => {
    if (currentTab === 'notices') renderFeed({ force: true });
  }, 25000);
}

const _createPublicPostV23 = createPublicPost;
createPublicPost = async function (kind, text, mediaFile, attachmentFile) {
  const ok = await _createPublicPostV23(kind, text, mediaFile, attachmentFile);
  if (ok) await renderFeed({ force: true });
  return ok;
};

onAppInit(() => {
  startFeedAutoRefresh();
  if (getLocalPostCache().length) renderFeed();
});
