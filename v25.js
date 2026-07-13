/**
 * BlueChat v25 — 投稿の即時完了 + フィード更新ボタンの実効化
 */
var APP_VERSION = 'v25';

let feedRefreshInProgress = false;

function resetPostSubmitUi(submitBtn) {
  postSubmitInProgress = false;
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = '投稿する';
  }
}

async function buildPostPayload(kind, text, mediaFile, attachmentFile, submitBtn) {
  const user = getCurrentUser();
  if (!user) throw new Error('ログインが必要です');
  if (!getUsableSyncUrl()) throw new Error('同期サーバーに接続できません。マイページで設定を確認してください');

  let media = null;
  let attachment = null;
  if (mediaFile) {
    if (submitBtn) submitBtn.textContent = 'メディアを処理中…';
    media = await withAsyncTimeout(
      readPostMediaFile(mediaFile),
      POST_MEDIA_TIMEOUT_MS,
      'メディアの処理がタイムアウトしました'
    );
  }
  if (attachmentFile) {
    if (submitBtn) submitBtn.textContent = '添付を処理中…';
    attachment = await withAsyncTimeout(
      readPostAttachmentFile(attachmentFile),
      POST_MEDIA_TIMEOUT_MS,
      '添付ファイルの処理がタイムアウトしました'
    );
  }
  if (kind === 'photo' && !media) throw new Error('写真を選択してください');
  if (kind === 'video' && !media) throw new Error('動画を選択してください');
  if (kind === 'notice' && !text.trim() && !media && !attachment) {
    throw new Error('説明・写真・動画・ファイルのいずれかを入力してください');
  }

  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind,
    text: text.trim(),
    authorId: user.id,
    authorName: user.name,
    authorAvatar: user.avatar || null,
    media,
    attachment,
    createdAt: Date.now(),
    likes: {},
    dislikes: {},
    comments: []
  };
}

function publishPostLocally(savedPost) {
  cachePostLocally(normalizePostClient(savedPost));
  showToast('投稿しました');
  repaintFeedFromCache();
  if (typeof updateTabBadges === 'function') updateTabBadges();
  uploadPostToServerAsync(savedPost)
    .then((ok) => {
      if (ok) fetchPublicPosts().then(() => repaintFeedFromCache());
      else if (typeof scheduleResyncOrphanPosts === 'function') scheduleResyncOrphanPosts();
    })
    .catch(() => {
      if (typeof scheduleResyncOrphanPosts === 'function') scheduleResyncOrphanPosts();
    });
}

createPublicPost = async function (kind, text, mediaFile, attachmentFile) {
  try {
    const savedPost = await buildPostPayload(kind, text, mediaFile, attachmentFile, null);
    publishPostLocally(savedPost);
    return true;
  } catch (e) {
    showToast(e?.message || '投稿に失敗しました');
    return false;
  }
};

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
    submitBtn.textContent = '準備中…';
  }

  try {
    const savedPost = await buildPostPayload(kind, text, mediaFile, attachFile, submitBtn);
    publishPostLocally(savedPost);
    hideModal('modal-create-post');
    const textEl = document.getElementById('input-post-text');
    const mediaEl = document.getElementById('input-post-media');
    const attachEl = document.getElementById('input-post-attachment');
    if (textEl) textEl.value = '';
    if (mediaEl) mediaEl.value = '';
    if (attachEl) attachEl.value = '';
  } catch (e) {
    showToast(e?.message || '投稿に失敗しました');
  } finally {
    resetPostSubmitUi(submitBtn);
  }
};

async function refreshFeedFromServer() {
  if (feedRefreshInProgress) return;
  const btn = document.getElementById('btn-refresh-feed');
  feedRefreshInProgress = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '取得中…';
  }
  try {
    if (typeof resyncOrphanPostsToServer === 'function') {
      await resyncOrphanPostsToServer();
    }
    const user = getCurrentUser();
    let posts = getLocalPostCache().map(normalizePostClient);
    let announcements = typeof getAnnouncementCache === 'function' ? getAnnouncementCache() : [];

    if (getUsableSyncUrl()) {
      const [postRes, annList] = await Promise.all([
        feedCloudRequest('/api/posts', {}, 30000),
        typeof fetchAnnouncements === 'function' ? fetchAnnouncements() : Promise.resolve([])
      ]);
      if (postRes.ok && Array.isArray(postRes.data)) {
        const server = postRes.data.map(normalizePostClient);
        const merged = mergePostLists(server, posts);
        if (server.length < posts.length && typeof scheduleResyncOrphanPosts === 'function') {
          scheduleResyncOrphanPosts();
        }
        posts = merged;
        saveLocalPostCache(posts);
      } else if (!postRes.ok) {
        throw new Error(feedActionErrorMessage(postRes));
      }
      if (Array.isArray(annList)) announcements = annList;
    }

    paintFeedList(buildFeedItems(posts, announcements), user);
    if (typeof updateTabBadges === 'function') updateTabBadges();
    const count = buildFeedItems(posts, announcements).length;
    showToast('フィードを更新しました（' + count + '件）');
  } catch (e) {
    repaintFeedFromCache();
    showToast(e?.message || '更新に失敗しました');
  } finally {
    feedRefreshInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '更新';
    }
  }
}

fetchPublicPosts = async function () {
  const local = getLocalPostCache().map(normalizePostClient);
  if (!getUsableSyncUrl()) return local;
  try {
    const remote = await feedCloudRequest('/api/posts', {}, 30000);
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
