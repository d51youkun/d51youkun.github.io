/**
 * BlueChat v28 — 投稿システム再定義（動画バイナリアップロード + 全端末同期）
 */
var APP_VERSION = 'v28';

const POST_FEED_VIDEO_MAX_FILE = 60 * 1024 * 1024;
const POST_FEED_VIDEO_INLINE_MAX = 8 * 1024 * 1024;
const POST_VIDEO_UPLOAD_TIMEOUT_MS = 600000;

const _readPostMediaForFeed = readPostMediaFile;

function postFeedIsVideo(media) {
  return !!media && (media.type === 'video' || String(media.mimeType || '').startsWith('video/'));
}

function postFeedMediaUrl(media) {
  if (!media) return '';
  if (media.data) return media.data;
  if (media.mediaId && getUsableSyncUrl()) {
    return getUsableSyncUrl().replace(/\/$/, '') + '/api/posts/media/' + encodeURIComponent(media.mediaId);
  }
  return '';
}

function postFeedStripForCache(post) {
  if (!post) return post;
  const next = { ...post };
  if (next.media && postFeedIsVideo(next.media)) {
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
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify((posts || []).slice(0, 300).map(postFeedStripForCache)));
  } catch (e) { /* quota */ }
};

renderFeedMedia = function (media) {
  if (!media) return '';
  const src = postFeedMediaUrl(media);
  if (!src) {
    return '<p class="feed-media-missing">動画を読み込めません</p>';
  }
  if (postFeedIsVideo(media)) {
    return `<video src="${src}" class="feed-media feed-video" controls playsinline preload="metadata"></video>`;
  }
  const anim = isAnimatedStickerSource(src);
  const cls = anim ? 'feed-media feed-image feed-animated' : 'feed-media feed-image';
  return `<img src="${src}" alt="" class="${cls}" loading="lazy">`;
};

function postFeedSyncBases() {
  const candidates = typeof getSyncUrlCandidates === 'function'
    ? getSyncUrlCandidates()
    : [getUsableSyncUrl()].filter(Boolean);
  return candidates.filter(u => typeof isMixedContentBlocked !== 'function' || !isMixedContentBlocked(u));
}

async function postFeedPrepareDraft(kind, text, mediaFile, attachmentFile, submitBtn) {
  const user = getCurrentUser();
  if (!user) throw new Error('ログインが必要です');
  if (!postFeedSyncBases().length) throw new Error('同期サーバーに接続できません');

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let media = null;
  let videoFile = null;
  let attachment = null;

  if (kind === 'video') {
    if (!mediaFile) throw new Error('動画を選択してください');
    if (mediaFile.size > POST_FEED_VIDEO_MAX_FILE) {
      throw new Error('動画は' + formatFileLimit(POST_FEED_VIDEO_MAX_FILE) + '以下にしてください');
    }
    videoFile = mediaFile;
    media = {
      type: 'video',
      mediaId: id + '_v',
      mimeType: mediaFile.type || 'video/mp4',
      fileName: mediaFile.name || 'video.mp4'
    };
  } else if (mediaFile) {
    if (submitBtn) submitBtn.textContent = 'メディアを処理中…';
    media = await withAsyncTimeout(
      _readPostMediaForFeed(mediaFile),
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
  if (kind === 'notice' && !text.trim() && !media && !attachment) {
    throw new Error('説明・写真・動画・ファイルのいずれかを入力してください');
  }

  return {
    id,
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
    comments: [],
    _videoFile: videoFile
  };
}

async function postFeedUploadVideoBinary(draft) {
  const file = draft._videoFile;
  if (!file || !draft.media?.mediaId) throw new Error('動画がありません');

  let lastMsg = '動画のアップロードに失敗しました';
  for (const base of postFeedSyncBases()) {
    const url = base.replace(/\/$/, '') + '/api/posts/media/' + encodeURIComponent(draft.media.mediaId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_VIDEO_UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Bluechat-Author': String(draft.authorId),
          'X-Bluechat-Mime': draft.media.mimeType,
          'X-Bluechat-Filename': draft.media.fileName,
          'X-Bluechat-Encoding': 'raw'
        },
        body: file,
        signal: controller.signal
      });
      let data = null;
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-json */ }
      if (res.ok) {
        draft.media = {
          type: 'video',
          mediaId: draft.media.mediaId,
          mimeType: draft.media.mimeType,
          fileName: draft.media.fileName
        };
        delete draft._videoFile;
        return true;
      }
      lastMsg = data?.error === 'too_large'
        ? '動画が大きすぎます。短い動画にしてください'
        : ('動画アップロード失敗(' + res.status + ')');
    } catch (e) {
      lastMsg = e?.name === 'AbortError' ? '動画アップロードがタイムアウトしました' : 'ネットワークエラー';
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastMsg);
}

async function postFeedUploadVideoFallback(draft) {
  const file = draft._videoFile;
  if (!file || file.size > POST_FEED_VIDEO_INLINE_MAX) return false;
  const dataUrl = await withAsyncTimeout(
    readFileAsDataURL(file),
    POST_MEDIA_TIMEOUT_MS,
    '動画の変換がタイムアウトしました'
  );
  const res = await feedFetchJson('/api/posts/media/' + encodeURIComponent(draft.media.mediaId), {
    method: 'PUT',
    body: JSON.stringify({
      authorId: draft.authorId,
      mimeType: draft.media.mimeType,
      fileName: draft.media.fileName,
      kind: 'video',
      data: dataUrl
    })
  }, POST_VIDEO_UPLOAD_TIMEOUT_MS);
  if (res.ok) {
    draft.media = {
      type: 'video',
      mediaId: draft.media.mediaId,
      mimeType: draft.media.mimeType,
      fileName: draft.media.fileName
    };
    delete draft._videoFile;
    return true;
  }
  draft.media = {
    type: 'video',
    mediaId: draft.media.mediaId,
    mimeType: draft.media.mimeType,
    fileName: draft.media.fileName,
    data: dataUrl
  };
  delete draft._videoFile;
  return true;
}

async function postFeedUploadVideo(draft, submitBtn) {
  if (!draft._videoFile) return;
  if (submitBtn) submitBtn.textContent = '動画をアップロード中…';
  showToast('動画をアップロード中…', 1500);
  try {
    await postFeedUploadVideoBinary(draft);
    return;
  } catch (binaryErr) {
    const ok = await postFeedUploadVideoFallback(draft);
    if (ok) return;
    throw binaryErr;
  }
}

async function postFeedSaveRecord(draft) {
  const payload = {
    id: draft.id,
    kind: draft.kind,
    text: draft.text || '',
    authorId: draft.authorId,
    authorName: draft.authorName,
    authorAvatar: draft.authorAvatar || null,
    media: draft.media || null,
    attachment: draft.attachment || null,
    createdAt: draft.createdAt || Date.now()
  };
  const res = await feedFetchJson('/api/posts', {
    method: 'POST',
    body: JSON.stringify(payload)
  }, 300000);
  if (!res.ok || !res.data?.ok) {
    const err = res.data?.error;
    if (err === 'video_media_required') throw new Error('動画の保存に失敗しました。サーバーを更新してください');
    if (err === 'too_large') throw new Error('投稿データが大きすぎます');
    throw new Error('投稿の保存に失敗しました');
  }
  if (res.data.id && res.data.id !== draft.id) draft.id = res.data.id;
}

async function postFeedPublish(draft, submitBtn) {
  if (draft.kind === 'video' || postFeedIsVideo(draft.media)) {
    await postFeedUploadVideo(draft, submitBtn);
  }
  if (submitBtn) submitBtn.textContent = '投稿を保存中…';
  await postFeedSaveRecord(draft);
  await fetchPublicPosts();
  repaintFeedFromCache();
  showToast('投稿しました');
  if (typeof updateTabBadges === 'function') updateTabBadges();
}

createPublicPost = async function (kind, text, mediaFile, attachmentFile) {
  try {
    const draft = await postFeedPrepareDraft(kind, text, mediaFile, attachmentFile, null);
    await postFeedPublish(draft, null);
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
    const draft = await postFeedPrepareDraft(kind, text, mediaFile, attachFile, submitBtn);
    await postFeedPublish(draft, submitBtn);
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

uploadPostToServerAsync = async function (post) {
  if (!postFeedSyncBases().length) return false;
  try {
    const draft = normalizePostClient({
      ...post,
      media: post.media ? { ...post.media } : null,
      _videoFile: null
    });
    if ((draft.kind === 'video' || postFeedIsVideo(draft.media)) && draft.media?.data && !draft._videoFile) {
      const res = await feedFetchJson('/api/posts/media/' + encodeURIComponent(draft.media.mediaId || (draft.id + '_v')), {
        method: 'PUT',
        body: JSON.stringify({
          authorId: draft.authorId,
          mimeType: draft.media.mimeType,
          fileName: draft.media.fileName,
          kind: 'video',
          data: draft.media.data
        })
      }, POST_VIDEO_UPLOAD_TIMEOUT_MS);
      if (!res.ok) return false;
      draft.media = {
        type: 'video',
        mediaId: draft.media.mediaId || (draft.id + '_v'),
        mimeType: draft.media.mimeType,
        fileName: draft.media.fileName
      };
    }
    await postFeedSaveRecord(draft);
    return true;
  } catch (e) {
    return false;
  }
};

resyncOrphanPostsToServer = async function () {
  const user = getCurrentUser();
  if (!user || !postFeedSyncBases().length) return;
  const remote = await feedFetchJson('/api/posts', {}, 30000);
  const server = remote.ok && Array.isArray(remote.data) ? remote.data : [];
  const serverIds = new Set(server.map(p => p.id));
  const orphans = getLocalPostCache().filter(p => p.authorId === user.id && !serverIds.has(p.id));
  for (const post of orphans.slice(0, 10)) {
    await uploadPostToServerAsync(post);
  }
};
