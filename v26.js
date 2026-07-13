/**
 * BlueChat v26 — iOSホーム画面Webアプリ向けフィード更新の修正
 */
var APP_VERSION = 'v26';

function isIosWebApp() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  return ios && (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

function bindIosSafeTap(id, handler) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el || el.dataset.iosTapBound === '1') return;
  el.dataset.iosTapBound = '1';
  let lastAt = 0;
  const run = (e) => {
    if (e.type === 'touchend' && e.changedTouches?.length > 1) return;
    const now = Date.now();
    if (now - lastAt < 420) return;
    lastAt = now;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    handler(e);
  };
  el.addEventListener('click', run);
  el.addEventListener('touchend', run, { passive: false });
}

async function feedFetchJson(path, options = {}, timeoutMs = 30000) {
  const candidates = typeof getSyncUrlCandidates === 'function'
    ? getSyncUrlCandidates()
    : [getUsableSyncUrl()].filter(Boolean);
  const usable = candidates.filter(u =>
    typeof isMixedContentBlocked !== 'function' || !isMixedContentBlocked(u)
  );
  if (!usable.length) {
    return { ok: false, status: 0, data: null, error: 'no_sync', base: '' };
  }

  const bust = (path.includes('?') ? '&' : '?') + '_ts=' + Date.now();
  let last = { ok: false, status: 0, data: null, error: 'network', base: '' };
  for (let i = 0; i < usable.length; i++) {
    const base = usable[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(base + path + bust, {
        ...options,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          ...(options.headers || {})
        }
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-json */ }
      last = {
        ok: res.ok,
        status: res.status,
        data,
        error: data?.error || (res.ok ? null : 'request_failed'),
        base
      };
      if (res.ok) {
        if (i > 0 && typeof localStorage !== 'undefined' && typeof SYNC_URL_KEY !== 'undefined') {
          const promoted = [base, ...usable.filter((_, idx) => idx !== i)];
          localStorage.setItem(SYNC_URL_KEY, promoted.join(SYNC_URL_DELIMITER));
        }
        return last;
      }
    } catch (e) {
      last = {
        ok: false,
        status: 0,
        data: null,
        error: e?.name === 'AbortError' ? 'timeout' : 'network',
        base
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

refreshFeedFromServer = async function () {
  if (feedRefreshInProgress) {
    showToast('更新中です…');
    return;
  }
  const btn = document.getElementById('btn-refresh-feed');
  feedRefreshInProgress = true;
  const prevIds = new Set(getLocalPostCache().map(p => p.id));
  if (btn) {
    btn.disabled = true;
    btn.textContent = '取得中…';
    btn.classList.add('is-refreshing');
  }
  showToast('投稿を更新中…', 1200);

  let safetyTimer = setTimeout(() => {
    feedRefreshInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '更新';
      btn.classList.remove('is-refreshing');
    }
  }, 35000);

  try {
    const user = getCurrentUser();
    let posts = getLocalPostCache().map(normalizePostClient);
    let announcements = typeof getAnnouncementCache === 'function' ? getAnnouncementCache() : [];

    if (!getUsableSyncUrl()) {
      repaintFeedFromCache();
      showToast('同期サーバー未接続。表示中のキャッシュは更新できません');
      return;
    }

    if (typeof resyncOrphanPostsToServer === 'function') {
      await resyncOrphanPostsToServer();
    }

    const [postRes, annList] = await Promise.all([
      feedFetchJson('/api/posts', {}, 30000),
      typeof fetchAnnouncements === 'function' ? fetchAnnouncements() : Promise.resolve([])
    ]);

    if (!postRes.ok || !Array.isArray(postRes.data)) {
      throw new Error(feedActionErrorMessage(postRes));
    }

    const server = postRes.data.map(normalizePostClient);
    const serverIds = new Set(server.map(p => p.id));
    const localOnly = posts.filter(p => !serverIds.has(p.id));
    posts = mergePostLists(server, localOnly);
    saveLocalPostCache(posts);
    if (server.length < posts.length && typeof scheduleResyncOrphanPosts === 'function') {
      scheduleResyncOrphanPosts();
    }
    if (Array.isArray(annList)) announcements = annList;

    paintFeedList(buildFeedItems(posts, announcements), user);
    if (typeof updateTabBadges === 'function') updateTabBadges();

    const newOnServer = server.filter(p => !prevIds.has(p.id)).length;
    const total = buildFeedItems(posts, announcements).length;
    if (newOnServer > 0) {
      showToast('更新しました（新着' + newOnServer + '件 / 全' + total + '件）');
    } else {
      showToast('最新の投稿を取得しました（全' + total + '件）');
    }
  } catch (e) {
    repaintFeedFromCache();
    showToast(e?.message || '更新に失敗しました');
  } finally {
    clearTimeout(safetyTimer);
    feedRefreshInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '更新';
      btn.classList.remove('is-refreshing');
    }
  }
};

fetchPublicPosts = async function () {
  const local = getLocalPostCache().map(normalizePostClient);
  if (!getUsableSyncUrl()) return local;
  try {
    const remote = await feedFetchJson('/api/posts', {}, 30000);
    if (!remote.ok || !Array.isArray(remote.data)) return local;
    const server = remote.data.map(normalizePostClient);
    const merged = mergePostLists(server, local);
    saveLocalPostCache(merged);
    if (server.length < local.length && typeof scheduleResyncOrphanPosts === 'function') {
      scheduleResyncOrphanPosts();
    }
    return merged;
  } catch (e) {
    return local;
  }
};

function initFeedActionButtons() {
  bindIosSafeTap('btn-refresh-feed', () => refreshFeedFromServer());
  bindIosSafeTap('btn-create-post', () => {
    if (typeof showCreatePostModal === 'function') showCreatePostModal('photo');
  });
  bindIosSafeTap('btn-create-post-video', () => {
    if (typeof showCreatePostModal === 'function') showCreatePostModal('video');
  });
  bindIosSafeTap('btn-create-post-notice', () => {
    if (typeof showCreatePostModal === 'function') showCreatePostModal('notice');
  });
}

onAppInit(() => {
  initFeedActionButtons();
  if (isIosWebApp()) document.documentElement.classList.add('ios-webapp');
});
