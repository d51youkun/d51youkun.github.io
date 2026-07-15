/**
 * BlueChat v26 — 投稿読み込み失敗時に空表示にならないよう修正
 */
var APP_VERSION = 'v26';

const FEED_ANN_CACHE_KEY = 'bluechat_feed_ann_cache';

let lastPostsFetchMode = 'unknown';
let lastAnnFetchMode = 'unknown';

function getAnnouncementCache() {
  try {
    const list = JSON.parse(localStorage.getItem(FEED_ANN_CACHE_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function saveAnnouncementCache(list) {
  if (!Array.isArray(list) || !list.length) {
    if (getAnnouncementCache().length) return;
  }
  try {
    localStorage.setItem(FEED_ANN_CACHE_KEY, JSON.stringify((list || []).slice(0, 100)));
  } catch (e) { /* quota */ }
}

function saveServerPostCacheSafe(posts) {
  if (!Array.isArray(posts) || !posts.length) {
    if (typeof getServerPostCache === 'function' && getServerPostCache().length) return;
  }
  saveServerPostCache(posts);
}

function setFeedEmptyMessage(emptyEl) {
  const title = document.getElementById('feed-empty-title') || emptyEl?.querySelector('p');
  const sub = document.getElementById('feed-empty-sub') || emptyEl?.querySelector('.sub');
  const failed = lastPostsFetchMode === 'failed' || lastAnnFetchMode === 'failed';
  const cached = lastPostsFetchMode === 'cache' || lastAnnFetchMode === 'cache';

  if (failed) {
    if (title) title.textContent = '投稿を読み込めませんでした';
    if (sub) sub.textContent = '通信状況を確認して「更新」ボタンを押してください。管理者の投稿がある場合も、接続できないと表示されません。';
  } else if (cached) {
    if (title) title.textContent = '最新の投稿を取得できませんでした';
    if (sub) sub.textContent = '保存済みの投稿を表示しています。「更新」ボタンで再取得できます。';
  } else {
    if (title) title.textContent = '投稿はありません';
    if (sub) sub.textContent = '写真・動画・告知を投稿してみましょう';
  }
}

const _fetchAnnouncementsV7 = fetchAnnouncements;
fetchAnnouncements = async function () {
  const cached = getAnnouncementCache();
  const user = getCurrentUser();
  if (!user || !getUsableSyncUrl()) {
    lastAnnFetchMode = cached.length ? 'cache' : 'failed';
    return cached;
  }
  const groups = getUserConversations(user.id).filter(c => c.type === 'group').map(c => c.id);
  const url = `/api/announcements?userId=${encodeURIComponent(user.id)}&groupIds=${encodeURIComponent(groups.join(','))}`;
  const list = await cloudRequest(url);
  if (!Array.isArray(list)) {
    lastAnnFetchMode = cached.length ? 'cache' : 'failed';
    return cached;
  }
  if (!list.length && cached.length) {
    lastAnnFetchMode = 'cache';
    return cached;
  }
  lastAnnFetchMode = list.length ? 'ok' : 'empty';
  saveAnnouncementCache(list);
  return list;
};

fetchPublicPosts = async function () {
  const local = getLocalPostCache();
  const baseline = getFeedBaselinePosts();

  if (!getUsableSyncUrl()) {
    lastPostsFetchMode = baseline.length ? 'cache' : (local.length ? 'cache' : 'failed');
    return baseline.length ? baseline : local;
  }

  const result = await fetchPostsFromServerRemote();
  if (!result.ok || !Array.isArray(result.posts)) {
    lastPostsFetchMode = baseline.length ? 'cache' : (local.length ? 'cache' : 'failed');
    return baseline.length ? baseline : local;
  }

  if (!result.posts.length && baseline.length) {
    lastPostsFetchMode = 'cache';
    return baseline;
  }

  const merged = mergePostListsSmart(result.posts, local);
  saveServerPostCacheSafe(result.posts);
  saveLocalPostCache(merged);
  lastPostsFetchMode = merged.length ? 'ok' : 'empty';
  if (result.posts.length < local.length && typeof scheduleResyncOrphanPosts === 'function') {
    scheduleResyncOrphanPosts();
  }
  return merged;
};

saveServerPostCache = function (posts) {
  saveServerPostCacheSafe(posts);
};

const _renderFeedV26 = renderFeed;
renderFeed = async function () {
  const list = document.getElementById('feed-list');
  const baseline = getFeedBaselinePosts();
  const annCache = getAnnouncementCache();
  if (list && !list.children.length && (baseline.length || annCache.length)) {
    const _fp = fetchPublicPosts;
    const _fa = fetchAnnouncements;
    lastPostsFetchMode = 'cache';
    lastAnnFetchMode = annCache.length ? 'cache' : 'unknown';
    fetchPublicPosts = async () => baseline;
    fetchAnnouncements = async () => annCache;
    try {
      await _renderFeedV26();
    } finally {
      fetchPublicPosts = _fp;
      fetchAnnouncements = _fa;
    }
  }
  await _renderFeedV26();
  if (lastPostsFetchMode === 'cache' || lastAnnFetchMode === 'cache') {
    showFeedRefreshStatus('保存済みの投稿を表示中…', 'loading');
    hideFeedRefreshStatus(2200);
  } else if (lastPostsFetchMode === 'failed' || lastAnnFetchMode === 'failed') {
    showFeedRefreshStatus('投稿の取得に失敗しました', 'error');
    hideFeedRefreshStatus(3500);
  }
};

const _refreshFeedFromServerV26 = refreshFeedFromServer;
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
    let usedCache = false;
    const baseline = getFeedBaselinePosts();

    if (result.ok && Array.isArray(result.posts) && result.posts.length) {
      posts = mergePostListsSmart(result.posts, getLocalPostCache());
      saveServerPostCacheSafe(result.posts);
      saveLocalPostCache(posts);
      lastPostsFetchMode = 'ok';
    } else if (result.ok && Array.isArray(result.posts) && !result.posts.length && baseline.length) {
      posts = baseline;
      usedCache = true;
      lastPostsFetchMode = 'cache';
    } else if (baseline.length) {
      posts = baseline;
      usedCache = true;
      lastPostsFetchMode = 'cache';
    } else {
      posts = getLocalPostCache();
      lastPostsFetchMode = posts.length ? 'cache' : 'failed';
    }

    const _fetch = fetchPublicPosts;
    fetchPublicPosts = async () => posts;
    try {
      await _renderFeedV26();
    } finally {
      fetchPublicPosts = _fetch;
    }

    if (result.ok && !usedCache) {
      const suffix = `（${posts.length}件・${countDistinctAuthors(posts)}人）`;
      showFeedRefreshStatus('更新しました' + suffix, 'done');
    } else if (usedCache && posts.length) {
      showFeedRefreshStatus(`保存済みを表示（${posts.length}件）`, 'error');
    } else {
      showFeedRefreshStatus('投稿を取得できませんでした', 'error');
    }
    hideFeedRefreshStatus(usedCache ? 4200 : 2800);
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

const _updateTabBadgesV26 = updateTabBadges;
updateTabBadges = async function () {
  const posts = typeof getFeedBaselinePosts === 'function' ? getFeedBaselinePosts() : [];
  const announcements = getAnnouncementCache();
  const feedRead = getFeedReadMap();
  const annRead = typeof getAnnouncementReadMap === 'function' ? getAnnouncementReadMap() : {};
  let unread = 0;
  posts.forEach(p => { if (!feedRead['post_' + p.id]) unread++; });
  announcements.forEach(a => { if (!annRead[a.id]) unread++; });
  setTabBadge('notices', unread);
  setTabBadge('chats', countUnreadChats());

  const user = getCurrentUser();
  if (user && getUsableSyncUrl()) {
    const reqs = await fetchFriendRequests();
    const incoming = reqs.filter(r => String(r.toId) === String(user.id)).length;
    setTabBadge('friends', incoming);
  }

  if (typeof _fetchAnnouncementsV7 === 'function') {
    fetchAnnouncements().catch(() => {});
  }
};
