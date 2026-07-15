/**
 * BlueChat v25 — 投稿コメント・友達申請修正・同期URL非表示・高速化
 */
var APP_VERSION = 'v25';

const FEED_HYDRATE_CONCURRENCY = 2;
const FEED_RENDER_DEBOUNCE_MS = 1200;

let feedRenderDebounceTimer = null;

function isSuperAdminViewer() {
  return !!(typeof adminLoggedIn !== 'undefined' && adminLoggedIn &&
    typeof adminRole !== 'undefined' && adminRole === 'super');
}

function isSyncDeviceConfigured() {
  if (!getSyncUrl()) return false;
  if (localStorage.getItem(SYNC_CONFIGURED_KEY)) return true;
  if (typeof DEFAULT_SYNC_URL === 'string' && DEFAULT_SYNC_URL && DEFAULT_SYNC_URL !== '__DEFAULT_SYNC_URL__') {
    return true;
  }
  return false;
}

function applySyncSettingsVisibility() {
  const adminSection = document.getElementById('admin-sync-settings');
  const userSummary = document.getElementById('user-sync-summary');
  const userStatus = document.getElementById('user-sync-status-text');
  const isAdmin = isSuperAdminViewer();

  if (adminSection) adminSection.classList.toggle('hidden', !isAdmin);
  if (userSummary) userSummary.classList.toggle('hidden', isAdmin);

  if (userStatus && !isAdmin) {
    if (!getSyncUrl()) {
      userStatus.textContent = '同期の準備中です';
    } else if (!getUsableSyncUrl()) {
      userStatus.textContent = 'この端末からは同期に接続できません';
    } else {
      userStatus.textContent = '他の端末とデータを同期しています';
    }
  }
}

const _updateSyncStatusUIV25 = updateSyncStatusUI;
updateSyncStatusUI = function (forceCheck) {
  applySyncSettingsVisibility();

  if (!isSuperAdminViewer()) {
    const status = document.getElementById('sync-status');
    if (status) status.textContent = '';
    if (getUsableSyncUrl() && !(getSyncUrlCandidates().every(isMixedContentBlocked))) {
      if (!globalSyncTimer) startGlobalSync();
    }
    syncStatusChecked = true;
    return;
  }

  if (!forceCheck && isSyncDeviceConfigured()) {
    const status = document.getElementById('sync-status');
    const input = document.getElementById('input-sync-url');
    if (input) input.value = getSyncUrlCandidates().join(SYNC_URL_DELIMITER + ' ');
    if (status) {
      status.textContent = '✓ 同期サーバー設定済み（接続確認を省略）';
      status.classList.remove('warn');
    }
    syncStatusChecked = true;
    if (!globalSyncTimer) startGlobalSync();
    return;
  }

  return _updateSyncStatusUIV25(forceCheck);
};

const _renderProfileV25 = renderProfile;
renderProfile = function () {
  _renderProfileV25();
  applySyncSettingsVisibility();
};

function scheduleDebouncedFeedRender() {
  if (feedRenderDebounceTimer) clearTimeout(feedRenderDebounceTimer);
  feedRenderDebounceTimer = setTimeout(() => {
    feedRenderDebounceTimer = null;
    const tab = document.getElementById('tab-notices');
    if (tab && !tab.classList.contains('hidden') && typeof renderFeed === 'function') renderFeed();
  }, FEED_RENDER_DEBOUNCE_MS);
}

async function hydrateFeedMediaSlotsParallel() {
  const slots = document.querySelectorAll('[data-hydrate-post-id],[data-hydrate-attach-id]');
  const ids = new Set();
  slots.forEach(el => {
    const id = el.getAttribute('data-hydrate-post-id') || el.getAttribute('data-hydrate-attach-id');
    if (id) ids.add(id);
  });
  if (!ids.size) return;

  const queue = [...ids];
  const workers = Array.from({ length: FEED_HYDRATE_CONCURRENCY }, async () => {
    while (queue.length) {
      const postId = queue.shift();
      if (!postId || feedMediaHydrating.has(postId)) continue;
      feedMediaHydrating.add(postId);
      try {
        const full = await fetchFullFeedPost(postId);
        applyHydratedPostMedia(postId, full);
      } finally {
        feedMediaHydrating.delete(postId);
      }
    }
  });
  await Promise.all(workers);
}

hydrateFeedMediaSlots = hydrateFeedMediaSlotsParallel;

const _handleRemoteActivityV25 = handleRemoteActivity;
handleRemoteActivity = async function () {
  await _handleRemoteActivityV25();
  scheduleDebouncedFeedRender();
};

const _updateTabBadgesV25 = updateTabBadges;
updateTabBadges = async function () {
  const posts = typeof getFeedBaselinePosts === 'function' ? getFeedBaselinePosts() : [];
  const announcements = typeof fetchAnnouncements === 'function' ? await fetchAnnouncements() : [];
  const feedRead = getFeedReadMap();
  const annRead = typeof getAnnouncementReadMap === 'function' ? getAnnouncementReadMap() : {};
  let unread = 0;
  posts.forEach(p => { if (!feedRead['post_' + p.id]) unread++; });
  (announcements || []).forEach(a => { if (!annRead[a.id]) unread++; });
  setTabBadge('notices', unread);
  setTabBadge('chats', countUnreadChats());

  const user = getCurrentUser();
  if (user && getUsableSyncUrl()) {
    const reqs = await fetchFriendRequests();
    const incoming = reqs.filter(r => String(r.toId) === String(user.id)).length;
    setTabBadge('friends', incoming);
  }
};

const _updateAdminTabVisibilityV25 = typeof updateAdminTabVisibility === 'function' ? updateAdminTabVisibility : null;
if (_updateAdminTabVisibilityV25) {
  updateAdminTabVisibility = function () {
    _updateAdminTabVisibilityV25();
    applySyncSettingsVisibility();
    updateSyncStatusUI(false);
  };
}

applySyncSettingsVisibility();
