/**
 * BlueChat v27 — 動画投稿をサーバー共有ストレージ経由で全端末に配信
 */
var APP_VERSION = 'v27';

if (typeof FILE_LIMITS !== 'undefined') {
  FILE_LIMITS.postVideo = Math.min(FILE_LIMITS.postVideo || 200 * 1024 * 1024, 80 * 1024 * 1024);
  FILE_LIMITS.postVideoData = 48 * 1024 * 1024;
}

const POST_VIDEO_UPLOAD_TIMEOUT_MS = 600000;

function isVideoMedia(media) {
  return !!media && (media.type === 'video' || String(media.mimeType || '').startsWith('video/'));
}

function resolveFeedMediaSrc(media) {
  if (!media) return '';
  if (media.data) return media.data;
  if (media.mediaId && typeof getUsableSyncUrl === 'function' && getUsableSyncUrl()) {
    const base = getUsableSyncUrl().replace(/\/$/, '');
    return base + '/api/posts/media/' + encodeURIComponent(media.mediaId);
  }
  return '';
}

function stripPostMediaForCache(post) {
  if (!post) return post;
  const next = { ...post };
  if (next.media && isVideoMedia(next.media)) {
    next.media = {
      type: 'video',
      mediaId: next.media.mediaId || (next.id ? next.id + '_v' : null),
      mimeType: next.media.mimeType || 'video/mp4',
      fileName: next.media.fileName || 'video.mp4'
    };
  }
  return next;
}

saveLocalPostCache = function (posts) {
  try {
    const trimmed = (posts || []).slice(0, 300).map(stripPostMediaForCache);
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(trimmed));
  } catch (e) { /* quota */ }
};

const _readPostMediaFileV27 = readPostMediaFile;
readPostMediaFile = async function (file) {
  const media = await _readPostMediaFileV27(file);
  if (media && isVideoMedia(media) && media.data) {
    const limit = FILE_LIMITS.postVideoData || (48 * 1024 * 1024);
    if (media.data.length > limit) {
      throw new Error('動画が大きすぎます（' + formatFileLimit(limit) + '以下）');
    }
  }
  return media;
};

const _buildPostPayloadV27 = buildPostPayload;
buildPostPayload = async function (kind, text, mediaFile, attachmentFile, submitBtn) {
  const savedPost = await _buildPostPayloadV27(kind, text, mediaFile, attachmentFile, submitBtn);
  if (savedPost.media && isVideoMedia(savedPost.media)) {
    savedPost.media.mediaId = savedPost.id + '_v';
  }
  return savedPost;
};

renderFeedMedia = function (media) {
  if (!media) return '';
  const src = resolveFeedMediaSrc(media);
  if (!src) {
    return '<p class="feed-media-missing">動画を読み込めません（同期サーバーから取得できませんでした）</p>';
  }
  if (isVideoMedia(media)) {
    return `<video src="${src}" class="feed-media feed-video" controls playsinline preload="metadata"></video>`;
  }
  const anim = isAnimatedStickerSource(src);
  const cls = anim ? 'feed-media feed-image feed-animated' : 'feed-media feed-image';
  return `<img src="${src}" alt="" class="${cls}" loading="lazy">`;
};

async function uploadPostVideoMedia(post) {
  if (!post?.media?.data) return true;
  const mediaId = post.media.mediaId || (post.id + '_v');
  const res = await feedFetchJson('/api/posts/media/' + encodeURIComponent(mediaId), {
    method: 'PUT',
    body: JSON.stringify({
      authorId: post.authorId,
      mimeType: post.media.mimeType || 'video/mp4',
      fileName: post.media.fileName || 'video.mp4',
      kind: 'video',
      data: post.media.data
    })
  }, POST_VIDEO_UPLOAD_TIMEOUT_MS);
  if (!res.ok) {
    if (res.error === 'too_large' || res.status === 413) {
      throw new Error('動画が大きすぎます。短い動画にしてください');
    }
    throw new Error('動画のアップロードに失敗しました');
  }
  post.media = {
    type: 'video',
    mediaId,
    mimeType: post.media.mimeType || 'video/mp4',
    fileName: post.media.fileName || 'video.mp4'
  };
  return true;
}

async function uploadPostMeta(post) {
  const res = await feedFetchJson('/api/posts', {
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
  if (!res.ok || !res.data?.ok) {
    throw new Error('投稿の保存に失敗しました');
  }
  if (res.data.id && res.data.id !== post.id) post.id = res.data.id;
  return true;
}

async function publishPostWithSync(savedPost, submitBtn) {
  const isVideo = savedPost.kind === 'video' || isVideoMedia(savedPost.media);
  if (isVideo) {
    if (submitBtn) submitBtn.textContent = '動画をアップロード中…';
    showToast('動画をサーバーにアップロード中…', 1800);
    await uploadPostVideoMedia(savedPost);
  }
  if (submitBtn) submitBtn.textContent = isVideo ? '投稿を保存中…' : 'サーバーへ送信中…';
  await uploadPostMeta(savedPost);
  await fetchPublicPosts();
  repaintFeedFromCache();
  showToast('投稿しました');
  if (typeof updateTabBadges === 'function') updateTabBadges();
}

createPublicPost = async function (kind, text, mediaFile, attachmentFile) {
  try {
    const savedPost = await buildPostPayload(kind, text, mediaFile, attachmentFile, null);
    await publishPostWithSync(savedPost, null);
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
    await publishPostWithSync(savedPost, submitBtn);
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

resyncOrphanPostsToServer = async function () {
  if (!getUsableSyncUrl()) return;
  const user = getCurrentUser();
  if (!user) return;
  const local = getLocalPostCache();
  if (!local.length) return;
  const remote = await feedFetchJson('/api/posts', {}, 30000);
  const server = remote.ok && Array.isArray(remote.data) ? remote.data : [];
  const serverIds = new Set(server.map(p => p.id));
  const orphans = local.filter(p => p.authorId === user.id && !serverIds.has(p.id));
  for (const post of orphans.slice(0, 10)) {
    const working = normalizePostClient({ ...post, media: post.media ? { ...post.media } : null });
    await uploadPostToServerAsync(working);
  }
};

uploadPostToServerAsync = async function (post) {
  if (!getUsableSyncUrl()) return false;
  try {
    const working = { ...post, media: post.media ? { ...post.media } : null };
    if (working.kind === 'video' || isVideoMedia(working.media)) {
      if (working.media?.data) {
        const ok = await uploadPostVideoMedia(working);
        if (!ok) return false;
      } else if (!working.media?.mediaId) {
        return false;
      }
    }
    await uploadPostMeta(working);
    const cached = getLocalPostCache().filter(p => p.id !== post.id);
    saveLocalPostCache(mergePostLists(cached, [stripPostMediaForCache(working)]));
    return true;
  } catch (e) {
    return false;
  }
};
