/**
 * BlueChat v29 — 動画投稿のフリーズ修正（分割送信 + 進捗表示）
 */
var APP_VERSION = 'v29';

const POST_VIDEO_CHUNK_SIZE = 1536 * 1024;
const POST_VIDEO_CHUNK_TIMEOUT_MS = 120000;
const POST_VIDEO_WATCHDOG_MS = 180000;
const POST_FEED_VIDEO_MAX_FILE_V29 = 40 * 1024 * 1024;

let postVideoUploadAbort = null;
let postVideoWatchdogTimer = null;

function postFeedYieldUi() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function ensurePostUploadOverlay() {
  let el = document.getElementById('post-upload-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'post-upload-overlay';
  el.className = 'post-upload-overlay hidden';
  el.innerHTML = `
    <div class="post-upload-panel glass-panel">
      <p id="post-upload-status" class="post-upload-status">投稿を準備中…</p>
      <div class="post-upload-bar"><div id="post-upload-bar-fill" class="post-upload-bar-fill"></div></div>
      <button type="button" id="btn-cancel-post-upload" class="btn-secondary btn-sm">キャンセル</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#btn-cancel-post-upload')?.addEventListener('click', () => {
    if (postVideoUploadAbort) postVideoUploadAbort.abort();
    hidePostUploadOverlay();
    resetPostSubmitUi(document.getElementById('btn-submit-post'));
    showToast('投稿をキャンセルしました');
  });
  return el;
}

function showPostUploadOverlay(message, progress) {
  const el = ensurePostUploadOverlay();
  const status = document.getElementById('post-upload-status');
  const fill = document.getElementById('post-upload-bar-fill');
  if (status) status.textContent = message || '投稿中…';
  if (fill) fill.style.width = Math.max(0, Math.min(100, progress || 0)) + '%';
  el.classList.remove('hidden');
}

function hidePostUploadOverlay() {
  document.getElementById('post-upload-overlay')?.classList.add('hidden');
  if (postVideoWatchdogTimer) {
    clearTimeout(postVideoWatchdogTimer);
    postVideoWatchdogTimer = null;
  }
  postVideoUploadAbort = null;
}

function startPostVideoWatchdog() {
  if (postVideoWatchdogTimer) clearTimeout(postVideoWatchdogTimer);
  postVideoWatchdogTimer = setTimeout(() => {
    if (postVideoUploadAbort) postVideoUploadAbort.abort();
    hidePostUploadOverlay();
    resetPostSubmitUi(document.getElementById('btn-submit-post'));
    showToast('投稿がタイムアウトしました。短い動画で再試行してください');
  }, POST_VIDEO_WATCHDOG_MS);
}

async function postFeedUploadVideoChunked(draft) {
  const file = draft._videoFile;
  if (!file || !draft.media?.mediaId) throw new Error('動画がありません');
  if (file.size > POST_FEED_VIDEO_MAX_FILE_V29) {
    throw new Error('動画は' + formatFileLimit(POST_FEED_VIDEO_MAX_FILE_V29) + '以下にしてください');
  }

  const totalChunks = Math.max(1, Math.ceil(file.size / POST_VIDEO_CHUNK_SIZE));
  postVideoUploadAbort = new AbortController();
  startPostVideoWatchdog();

  let lastMsg = '動画のアップロードに失敗しました';
  for (const base of postFeedSyncBases()) {
    const root = base.replace(/\/$/, '');
    let failed = false;
    for (let i = 0; i < totalChunks; i++) {
      if (postVideoUploadAbort.signal.aborted) throw new Error('投稿をキャンセルしました');
      const start = i * POST_VIDEO_CHUNK_SIZE;
      const chunk = file.slice(start, start + POST_VIDEO_CHUNK_SIZE);
      const pct = Math.round(((i + 0.2) / totalChunks) * 85);
      showPostUploadOverlay('動画を送信 ' + (i + 1) + '/' + totalChunks + '…', pct);
      await postFeedYieldUi();

      const url = root + '/api/posts/media/' + encodeURIComponent(draft.media.mediaId) + '/chunk/' + i;
      const timer = setTimeout(() => postVideoUploadAbort.abort(), POST_VIDEO_CHUNK_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Bluechat-Author': String(draft.authorId),
            'X-Bluechat-Mime': draft.media.mimeType,
            'X-Bluechat-Filename': draft.media.fileName,
            'X-Bluechat-Encoding': 'raw',
            'X-Bluechat-Total-Chunks': String(totalChunks),
            'X-Bluechat-Chunk-Index': String(i)
          },
          body: chunk,
          signal: postVideoUploadAbort.signal
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-json */ }
        if (!res.ok) {
          failed = true;
          lastMsg = data?.error === 'too_large'
            ? '動画が大きすぎます'
            : ('動画送信失敗(' + res.status + ')');
          break;
        }
        if (data?.complete) {
          draft.media = {
            type: 'video',
            mediaId: draft.media.mediaId,
            mimeType: draft.media.mimeType,
            fileName: draft.media.fileName
          };
          delete draft._videoFile;
          showPostUploadOverlay('動画の送信が完了しました', 90);
          return true;
        }
      } catch (e) {
        if (e?.name === 'AbortError') throw new Error('投稿をキャンセルしました');
        failed = true;
        lastMsg = 'ネットワークエラー';
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!failed) return true;
  }
  throw new Error(lastMsg);
}

postFeedUploadVideo = async function (draft, submitBtn) {
  if (!draft._videoFile) return;
  hideModal('modal-create-post');
  showPostUploadOverlay('動画の送信を開始…', 5);
  if (submitBtn) submitBtn.textContent = '動画をアップロード中…';
  await postFeedUploadVideoChunked(draft);
};

postFeedPublish = async function (draft, submitBtn) {
  try {
    if (draft.kind === 'video' || postFeedIsVideo(draft.media)) {
      await postFeedUploadVideo(draft, submitBtn);
    }
    showPostUploadOverlay('投稿を保存中…', 92);
    if (submitBtn) submitBtn.textContent = '投稿を保存中…';
    await postFeedSaveRecord(draft);
    showPostUploadOverlay('フィードを更新中…', 96);
    setTimeout(() => {
      fetchPublicPosts().then(() => repaintFeedFromCache()).catch(() => {});
    }, 0);
    repaintFeedFromCache();
    showToast('投稿しました');
    if (typeof updateTabBadges === 'function') updateTabBadges();
  } finally {
    hidePostUploadOverlay();
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
    hidePostUploadOverlay();
    showToast(e?.message || '投稿に失敗しました');
  } finally {
    resetPostSubmitUi(submitBtn);
  }
};

const _postFeedPrepareDraftV29 = postFeedPrepareDraft;
postFeedPrepareDraft = async function (kind, text, mediaFile, attachmentFile, submitBtn) {
  const draft = await _postFeedPrepareDraftV29(kind, text, mediaFile, attachmentFile, submitBtn);
  if (kind === 'video' && draft._videoFile && draft._videoFile.size > POST_FEED_VIDEO_MAX_FILE_V29) {
    throw new Error('動画は' + formatFileLimit(POST_FEED_VIDEO_MAX_FILE_V29) + '以下にしてください');
  }
  return draft;
};
