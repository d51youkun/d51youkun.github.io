/**
 * BlueChat v23 — フィード更新ステータス表示 + 他ユーザー投稿の消失バグ修正
 */
var APP_VERSION = 'v23';

const FEED_SERVER_CACHE_KEY = 'bluechat_feed_server_cache';
const FEED_CACHE_STRIP_BYTES = 48000;

let feedRefreshInProgress = false;
let feedStatusHideTimer = null;

function getCurrentUserId() {
  const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  return user ? String(user.id) : '';
}

function stripBlobField(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.data && typeof obj.data === 'string' && obj.data.length > FEED_CACHE_STRIP_BYTES) {
    return { ...obj, data: null, _cachedStripped: true };
  }
  return obj;
}

function stripPostMediaForCache(post) {
  if (!post) return post;
  const copy = { ...post };
  if (copy.media) copy.media = stripBlobField(copy.media);
  if (copy.attachment) copy.attachment = stripBlobField(copy.attachment);
  return copy;
}

function stripPostsForCache(posts) {
  return (posts || []).map(stripPostMediaForCache);
}

function getServerPostCache() {
  try {
    const list = JSON.parse(localStorage.getItem(FEED_SERVER_CACHE_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function saveServerPostCache(posts) {
  try {
    localStorage.setItem(
      FEED_SERVER_CACHE_KEY,
      JSON.stringify(stripPostsForCache((posts || []).slice(0, 300)))
    );
  } catch (e) { /* quota */ }
}

function mergePostListsSmart(server, local) {
  const map = new Map();
  const uid = getCurrentUserId();

  (server || []).forEach(p => {
    if (p && p.id) map.set(p.id, p);
  });

  (local || []).forEach(p => {
    if (!p || !p.id) return;
    const existing = map.get(p.id);
    const isOwn = uid && String(p.authorId) === uid;
    if (!existing) {
      map.set(p.id, p);
      return;
    }
    if (isOwn) {
      const localHasMedia = !!(p.media && p.media.data) || !!(p.attachment && p.attachment.data);
      const serverHasMedia = !!(existing.media && existing.media.data) || !!(existing.attachment && existing.attachment.data);
      if (localHasMedia && !serverHasMedia) {
        map.set(p.id, { ...existing, ...p });
      } else {
        map.set(p.id, {
          ...existing,
          ...p,
          media: (p.media && p.media.data) ? p.media : existing.media,
          attachment: (p.attachment && p.attachment.data) ? p.attachment : existing.attachment
        });
      }
    }
  });

  return [...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function getFeedBaselinePosts() {
  return mergePostListsSmart(getServerPostCache(), getLocalPostCache());
}

mergePostLists = mergePostListsSmart;

saveLocalPostCache = function (posts) {
  try {
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(stripPostsForCache((posts || []).slice(0, 300))));
  } catch (e) { /* quota */ }
};

const _fetchPublicPostsV11 = fetchPublicPosts;
fetchPublicPosts = async function () {
  const local = getLocalPostCache();
  const baseline = getFeedBaselinePosts();

  if (!getUsableSyncUrl()) {
    return baseline.length ? baseline : local;
  }

  const remote = await cloudRequest('/api/posts');
  if (!Array.isArray(remote)) {
    return baseline.length ? baseline : local;
  }

  const merged = mergePostListsSmart(remote, local);
  saveServerPostCache(remote);
  saveLocalPostCache(merged);
  if (remote.length < local.length && typeof scheduleResyncOrphanPosts === 'function') {
    scheduleResyncOrphanPosts();
  }
  return merged;
};

function ensureFeedRefreshStatusEl() {
  let el = document.getElementById('feed-refresh-status');
  if (el) return el;
  const tab = document.getElementById('tab-notices');
  if (!tab) return null;
  el = document.createElement('div');
  el.id = 'feed-refresh-status';
  el.className = 'feed-refresh-status hidden';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  tab.appendChild(el);
  return el;
}

function showFeedRefreshStatus(text, state) {
  const el = ensureFeedRefreshStatusEl();
  if (!el) return;
  if (feedStatusHideTimer) {
    clearTimeout(feedStatusHideTimer);
    feedStatusHideTimer = null;
  }
  el.textContent = text;
  el.classList.remove('hidden', 'loading', 'done', 'error');
  if (state) el.classList.add(state);
}

function hideFeedRefreshStatus(delayMs) {
  if (feedStatusHideTimer) clearTimeout(feedStatusHideTimer);
  feedStatusHideTimer = setTimeout(() => {
    const el = document.getElementById('feed-refresh-status');
    if (el) el.classList.add('hidden');
    feedStatusHideTimer = null;
  }, delayMs || 0);
}

async function refreshFeedFromServer() {
  if (feedRefreshInProgress) return;
  feedRefreshInProgress = true;
  const btn = document.getElementById('btn-refresh-feed');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中…';
  }
  showFeedRefreshStatus('投稿を更新中…', 'loading');

  try {
    const posts = await fetchPublicPosts();
    const _fetch = fetchPublicPosts;
    fetchPublicPosts = async () => posts;
    try {
      await renderFeed();
    } finally {
      fetchPublicPosts = _fetch;
    }
    showFeedRefreshStatus('更新しました', 'done');
    hideFeedRefreshStatus(2500);
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
}

const _renderFeedV11 = renderFeed;
renderFeed = async function () {
  await _renderFeedV11();
};

function bindIosSafeTap(el, handler) {
  const node = typeof el === 'string' ? document.getElementById(el) : el;
  if (!node || node.dataset.iosTapBound === '1') return;
  node.dataset.iosTapBound = '1';
  let lastAt = 0;
  const run = (e) => {
    if (e.type === 'touchend' && e.changedTouches && e.changedTouches.length > 1) return;
    const now = Date.now();
    if (now - lastAt < 420) return;
    lastAt = now;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    handler(e);
  };
  node.addEventListener('click', run);
  node.addEventListener('touchend', run, { passive: false });
}

function rebindRefreshFeedButton() {
  const btn = document.getElementById('btn-refresh-feed');
  if (!btn) return;
  const clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn);
  bindIosSafeTap(clone, () => refreshFeedFromServer());
}

rebindRefreshFeedButton();
