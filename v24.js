/**
 * BlueChat v24 — iOS/iPadOS 向け軽量フィード取得 + メディア遅延読み込み
 */
var APP_VERSION = 'v24';

const FEED_FETCH_TIMEOUT_MS = 90000;
const FEED_MEDIA_TIMEOUT_MS = 120000;
const FEED_AVATAR_CACHE_STRIP_BYTES = 512;

const feedMediaHydrating = new Set();
const feedMediaHydrated = new Map();

function stripPostForLocalCache(post) {
  if (!post) return post;
  const copy = { ...post };
  if (copy.authorAvatar && String(copy.authorAvatar).length > FEED_AVATAR_CACHE_STRIP_BYTES) {
    copy.authorAvatar = null;
  }
  if (copy.media) copy.media = stripBlobField(copy.media);
  if (copy.attachment) copy.attachment = stripBlobField(copy.attachment);
  return copy;
}

function stripPostsForCacheV24(posts) {
  return (posts || []).map(stripPostForLocalCache);
}

saveLocalPostCache = function (posts) {
  try {
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(stripPostsForCacheV24((posts || []).slice(0, 300))));
  } catch (e) { /* quota */ }
};

saveServerPostCache = function (posts) {
  try {
    localStorage.setItem(
      FEED_SERVER_CACHE_KEY,
      JSON.stringify(stripPostsForCacheV24((posts || []).slice(0, 300)))
    );
  } catch (e) { /* quota */ }
};

function countDistinctAuthors(posts) {
  const ids = new Set();
  (posts || []).forEach(p => { if (p && p.authorId) ids.add(String(p.authorId)); });
  return ids.size;
}

function stripPostForClientList(post) {
  if (!post) return post;
  const copy = { ...post };
  if (copy.authorAvatar && String(copy.authorAvatar).length > FEED_AVATAR_CACHE_STRIP_BYTES) {
    copy.authorAvatar = null;
  }
  if (copy.media && copy.media.data) {
    copy.media = {
      type: copy.media.type || 'image',
      mimeType: copy.media.mimeType || '',
      fileName: copy.media.fileName || '',
      _hasRemoteData: true
    };
  }
  if (copy.attachment && copy.attachment.data) {
    copy.attachment = {
      fileName: copy.attachment.fileName || 'file',
      mimeType: copy.attachment.mimeType || '',
      size: copy.attachment.size || 0,
      _hasRemoteData: true
    };
  }
  return copy;
}

function normalizeRemoteFeedPosts(posts, liteHint) {
  if (!Array.isArray(posts)) return [];
  const hasRemoteFlag = posts.some(p =>
    (p.media && p.media._hasRemoteData) || (p.attachment && p.attachment._hasRemoteData)
  );
  if (liteHint || hasRemoteFlag) return posts;
  const heavy = posts.some(p =>
    (p.media && p.media.data && p.media.data.length > FEED_CACHE_STRIP_BYTES) ||
    (p.attachment && p.attachment.data && p.attachment.data.length > FEED_CACHE_STRIP_BYTES) ||
    (p.authorAvatar && String(p.authorAvatar).length > FEED_AVATAR_CACHE_STRIP_BYTES)
  );
  return heavy ? posts.map(stripPostForClientList) : posts;
}

async function fetchPostsFromServerRemote() {
  const paths = ['/api/posts?lite=1', '/api/posts'];
  for (const path of paths) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remote = await cloudRequest(path, { cache: 'no-store' }, FEED_FETCH_TIMEOUT_MS);
      if (Array.isArray(remote)) {
        const lite = path.indexOf('lite=1') >= 0;
        return { ok: true, posts: normalizeRemoteFeedPosts(remote, lite), lite };
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 700));
    }
  }
  return { ok: false, posts: null };
}

fetchPublicPosts = async function () {
  const local = getLocalPostCache();
  const baseline = getFeedBaselinePosts();

  if (!getUsableSyncUrl()) {
    return baseline.length ? baseline : local;
  }

  const result = await fetchPostsFromServerRemote();
  if (!result.ok || !Array.isArray(result.posts)) {
    return baseline.length ? baseline : local;
  }

  const merged = mergePostListsSmart(result.posts, local);
  saveServerPostCache(result.posts);
  saveLocalPostCache(merged);
  if (result.posts.length < local.length && typeof scheduleResyncOrphanPosts === 'function') {
    scheduleResyncOrphanPosts();
  }
  return merged;
};

async function fetchFullFeedPost(postId) {
  if (!postId || !getUsableSyncUrl()) return null;
  if (feedMediaHydrated.has(postId)) return feedMediaHydrated.get(postId);
  const full = await cloudRequest(
    '/api/posts/' + encodeURIComponent(postId),
    { cache: 'no-store' },
    FEED_MEDIA_TIMEOUT_MS
  );
  if (full && full.id) {
    feedMediaHydrated.set(postId, full);
    return full;
  }
  return null;
}

function applyHydratedPostMedia(postId, full) {
  if (!full) return;
  const mediaSlot = document.querySelector(`[data-hydrate-post-id="${postId}"]`);
  if (mediaSlot && full.media && full.media.data) {
    mediaSlot.outerHTML = renderFeedMedia(full.media, postId);
  } else if (mediaSlot && (!full.media || !full.media.data)) {
    mediaSlot.outerHTML = '<p class="feed-media-missing">メディアを表示できません</p>';
  }

  const attachSlot = document.querySelector(`[data-hydrate-attach-id="${postId}"]`);
  if (attachSlot && full.attachment && full.attachment.data) {
    attachSlot.outerHTML = renderFeedAttachment(full.attachment, postId);
  } else if (attachSlot && (!full.attachment || !full.attachment.data)) {
    attachSlot.remove();
  }
}

async function hydrateFeedMediaSlots() {
  const slots = document.querySelectorAll('[data-hydrate-post-id],[data-hydrate-attach-id]');
  const ids = new Set();
  slots.forEach(el => {
    const id = el.getAttribute('data-hydrate-post-id') || el.getAttribute('data-hydrate-attach-id');
    if (id) ids.add(id);
  });
  for (const postId of ids) {
    if (feedMediaHydrating.has(postId)) continue;
    feedMediaHydrating.add(postId);
    try {
      const full = await fetchFullFeedPost(postId);
      applyHydratedPostMedia(postId, full);
    } finally {
      feedMediaHydrating.delete(postId);
    }
  }
}

const _renderFeedV23 = renderFeed;
renderFeed = async function () {
  await _renderFeedV23();
  hydrateFeedMediaSlots();
};

const _refreshFeedFromServerV23 = refreshFeedFromServer;
refreshFeedFromServer = async function () {
  if (feedRefreshInProgress) return;
  feedRefreshInProgress = true;
  const btn = document.getElementById('btn-refresh-feed');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中…';
  }
  showFeedRefreshStatus('投稿を更新中…', 'loading');

  try {
    const result = await fetchPostsFromServerRemote();
    let posts;
    if (result.ok && Array.isArray(result.posts)) {
      posts = mergePostListsSmart(result.posts, getLocalPostCache());
      saveServerPostCache(result.posts);
      saveLocalPostCache(posts);
    } else {
      posts = getFeedBaselinePosts();
    }

    const _fetch = fetchPublicPosts;
    fetchPublicPosts = async () => posts;
    try {
      await renderFeed();
    } finally {
      fetchPublicPosts = _fetch;
    }

    const uid = getCurrentUserId();
    const others = posts.filter(p => uid && String(p.authorId) !== uid).length;
    if (result.ok) {
      const suffix = others > 0 ? `（${posts.length}件・${countDistinctAuthors(posts)}人）` : `（${posts.length}件）`;
      showFeedRefreshStatus('更新しました' + suffix, 'done');
    } else {
      showFeedRefreshStatus('サーバーに接続できません（保存済みを表示）', 'error');
    }
    hideFeedRefreshStatus(result.ok ? 2800 : 4200);
  } catch (e) {
    showFeedRefreshStatus('更新に失敗しました', 'error');
    hideFeedRefreshStatus(3500);
  } finally {
    feedRefreshInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '更新';
    }
  }
};
