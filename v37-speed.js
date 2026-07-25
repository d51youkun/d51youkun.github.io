/**
 * BlueChat v37 — チャンク分割アップロード・並列同期・高速ポーリング
 */
var APP_VERSION = 'v37';

const CHUNK_THRESHOLD = 80000;
const CHUNK_SIZE = 120000;
const CHUNK_PARALLEL = 4;
const GLOBAL_SYNC_MS = 1000;
const ACTIVITY_POLL_MS = 800;
const CHAT_SYNC_MS = 800;
const SYNC_CONV_PARALLEL = 4;
const SYNC_PUSH_PARALLEL = 3;

const blobCache = new Map();
const blobInflight = new Map();

function makeUploadId(msgId, field) {
  return String(msgId).replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + field;
}

async function uploadChunkedMedia(uploadId, data, field, mimeType) {
  if (!data || typeof data !== 'string') return uploadId;
  const parts = [];
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    parts.push(data.slice(i, i + CHUNK_SIZE));
  }
  if (parts.length <= 1 && data.length <= CHUNK_THRESHOLD) return null;

  const totalParts = parts.length;
  const uploadOne = async (idx) => {
    await cloudRequest('/api/media/chunk/' + encodeURIComponent(uploadId) + '/' + idx, {
      method: 'PUT',
      body: JSON.stringify({ data: parts[idx], totalParts, mimeType, field })
    }, 120000);
  };

  for (let i = 0; i < parts.length; i += CHUNK_PARALLEL) {
    const batch = [];
    for (let j = i; j < Math.min(i + CHUNK_PARALLEL, parts.length); j++) batch.push(uploadOne(j));
    await Promise.all(batch);
  }

  await cloudRequest('/api/media/chunk/' + encodeURIComponent(uploadId) + '/complete', {
    method: 'POST',
    body: JSON.stringify({ totalParts, mimeType, field })
  }, 180000);

  blobCache.set(uploadId, { data, mimeType, field });
  return uploadId;
}

async function prepareMessageForCloudUpload(msg) {
  const out = { ...msg };
  const mediaFields = [
    { key: 'image', mime: 'image/jpeg' },
    { key: 'video', mime: 'video/mp4' },
    { key: 'fileData', mime: 'application/octet-stream' },
    { key: 'stickerImage', mime: 'image/png' }
  ];

  for (const { key, mime } of mediaFields) {
    const payload = out[key];
    if (typeof payload !== 'string' || payload.length <= CHUNK_THRESHOLD) continue;
    const uploadId = makeUploadId(out.id, key);
    try {
      await uploadChunkedMedia(uploadId, payload, key, out.mimeType || mime);
      out.blobRef = { id: uploadId, field: key, mimeType: out.mimeType || mime, size: payload.length };
      out[key] = null;
    } catch (e) {
      console.warn('chunk upload failed, inline fallback', key, e);
    }
  }

  if (typeof out.text === 'string' && out.text.length > CHUNK_THRESHOLD) {
    const uploadId = makeUploadId(out.id, 'text');
    try {
      await uploadChunkedMedia(uploadId, out.text, 'text', 'text/plain');
      out.blobRef = { id: uploadId, field: 'text', mimeType: 'text/plain', size: out.text.length };
      out.text = out.text.slice(0, 80) + '…';
    } catch (e) {
      console.warn('text chunk upload failed', e);
    }
  }

  return out;
}

async function fetchMediaBlob(uploadId) {
  if (blobCache.has(uploadId)) return blobCache.get(uploadId);
  if (blobInflight.has(uploadId)) return blobInflight.get(uploadId);

  const promise = cloudRequest('/api/media/blob/' + encodeURIComponent(uploadId), {}, 120000)
    .then((blob) => {
      if (blob && blob.data) blobCache.set(uploadId, blob);
      return blob;
    })
    .finally(() => blobInflight.delete(uploadId));

  blobInflight.set(uploadId, promise);
  return promise;
}

async function hydrateMessageMedia(msg, convId) {
  if (!msg || !msg.id) return msg;

  if (msg._needsFull && convId) {
    const full = await cloudRequest('/api/messages/' + encodeURIComponent(convId) + '/' + encodeURIComponent(msg.id), {}, 120000);
    if (full && full.id) {
      Object.assign(msg, full);
      delete msg._needsFull;
    }
  }

  const ref = msg.blobRef;
  if (!ref || !ref.id) return msg;

  const field = ref.field || 'image';
  if (field === 'text') {
    if (typeof msg.text === 'string' && msg.text.length > 200 && !msg.text.endsWith('…')) return msg;
  } else if (msg[field]) {
    return msg;
  }

  const blob = await fetchMediaBlob(ref.id);
  if (!blob || typeof blob.data !== 'string') return msg;

  if (field === 'text') msg.text = blob.data;
  else msg[field] = blob.data;

  const data = getData();
  if (convId && data.messages[convId]) {
    const idx = data.messages[convId].findIndex(m => m.id === msg.id);
    if (idx >= 0) {
      data.messages[convId][idx] = { ...data.messages[convId][idx], ...msg };
      saveData(data);
    }
  }
  return msg;
}

async function hydrateConversationMedia(convId) {
  const msgs = getMessages(convId);
  const targets = msgs.filter(m =>
    (m.blobRef && m.blobRef.id) || m._needsFull
  );
  for (let i = 0; i < targets.length; i += 2) {
    await Promise.all(targets.slice(i, i + 2).map(m => hydrateMessageMedia(m, convId)));
  }
}

async function runParallel(items, limit, worker) {
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

const _cloudPushMessageV37 = cloudPushMessage;
cloudPushMessage = async function (convId, msg) {
  if (!getUsableSyncUrl()) return false;
  let payload = msg;
  try {
    payload = await prepareMessageForCloudUpload(msg);
  } catch (e) {
    console.warn('prepareMessageForCloudUpload failed', e);
  }
  const res = await cloudRequest('/api/messages/' + convId + '/' + msg.id, {
    method: 'PUT',
    body: JSON.stringify(payload)
  }, messageUploadTimeout(msg));
  if (res && res.ok !== false) {
    markMessagePushed(convId, msg);
    return true;
  }
  return false;
};

const _cloudFetchMessagesV37 = cloudFetchMessages;
cloudFetchMessages = async function (convId, since = 0) {
  const data = await cloudRequest('/api/messages/' + convId + '?since=' + since + '&lite=1');
  return Array.isArray(data) ? data : [];
};

const _mergeRemoteMessageV37 = mergeRemoteMessage;
mergeRemoteMessage = function (convId, remoteMsg) {
  const added = _mergeRemoteMessageV37(convId, remoteMsg);
  if (remoteMsg && (remoteMsg.blobRef || remoteMsg._needsFull)) {
    hydrateMessageMedia(remoteMsg, convId).then(() => {
      if (currentConvId === convId) renderMessages(convId);
    }).catch(() => {});
  }
  return added;
};

const _syncPushLocalMessagesV37 = syncPushLocalMessages;
syncPushLocalMessages = async function (convId) {
  if (!getUsableSyncUrl() || !convId) return;
  const ids = await cloudRequest('/api/messages/' + convId + '/ids');
  const idSet = Array.isArray(ids) ? new Set(ids) : null;
  const pendingIds = getPendingMessageIds(convId);
  const toPush = getMessages(convId).filter(m =>
    pendingIds.has(m.id) || (idSet && !idSet.has(m.id))
  );
  if (!toPush.length) return;
  const conv = getData().conversations[convId];
  if (conv) await cloudPushConversation(conv);
  await runParallel(toPush, SYNC_PUSH_PARALLEL, async (msg) => {
    await cloudPushMessage(convId, msg);
  });
};

const _syncAllConversationsV37 = syncAllConversations;
syncAllConversations = async function () {
  if (!getUsableSyncUrl()) return;
  const user = getCurrentUser();
  if (!user) return;
  if (typeof syncCurrentUserModeration === 'function') await syncCurrentUserModeration();
  const friendsAdded = await syncFriendships();
  await syncUserConversationList();
  const convs = getUserConversations(user.id);
  const sorted = [...convs].sort((a, b) => {
    if (a.id === currentConvId) return -1;
    if (b.id === currentConvId) return 1;
    return (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
  });

  if (currentConvId) {
    await syncConversation(currentConvId);
    await hydrateConversationMedia(currentConvId);
  }

  const rest = sorted.filter(c => c.id !== currentConvId);
  let total = 0;
  await runParallel(rest, SYNC_CONV_PARALLEL, async (conv) => {
    total += await syncConversation(conv.id);
  });

  if (typeof updateTabBadges === 'function') updateTabBadges();
  if (typeof fetchFriendsPresence === 'function') await fetchFriendsPresence();
  refreshUIAfterSync();
  return total + friendsAdded;
};

const _startGlobalSyncCoreV37 = typeof startGlobalSyncCore === 'function' ? startGlobalSyncCore : null;
if (_startGlobalSyncCoreV37) {
  startGlobalSyncCore = function () {
    stopGlobalSync();
    if (!getUsableSyncUrl()) return;
    syncAllConversations();
    globalSyncTimer = setInterval(syncAllConversations, GLOBAL_SYNC_MS);
  };
}

const _startSyncVersionPollingV37 = startSyncVersionPolling;
startSyncVersionPolling = function () {
  if (syncVersionTimer) clearInterval(syncVersionTimer);
  if (!getUsableSyncUrl()) return;
  const poll = async () => {
    const res = await cloudRequest('/api/activity-version', {}, 4000);
    if (!res || res.version === undefined) return;
    const last = parseInt(localStorage.getItem(ACTIVITY_VERSION_KEY) || '0', 10);
    if (res.version > last) {
      localStorage.setItem(ACTIVITY_VERSION_KEY, String(res.version));
      await handleRemoteActivity();
      return;
    }
    if (last === 0) localStorage.setItem(ACTIVITY_VERSION_KEY, String(res.version));
  };
  poll();
  syncVersionTimer = setInterval(poll, ACTIVITY_POLL_MS);
};

const _startChatSyncV37 = startChatSync;
startChatSync = function (convId) {
  stopChatSync();
  if (!getUsableSyncUrl() || !convId) return;
  syncConversation(convId).then(() => {
    hydrateConversationMedia(convId).then(() => {
      if (currentConvId === convId) renderMessages(convId);
    });
  });
  chatSyncTimer = setInterval(async () => {
    await syncConversation(convId);
    await hydrateConversationMedia(convId);
    if (currentConvId === convId) renderMessages(convId);
    renderChatList();
  }, CHAT_SYNC_MS);
};

const _getMessageContentHtmlExtV37 = typeof getMessageContentHtmlExt === 'function' ? getMessageContentHtmlExt : null;
if (_getMessageContentHtmlExtV37) {
  getMessageContentHtmlExt = function (msg) {
    if (msg && msg.blobRef && msg.blobRef.id) {
      const field = msg.blobRef.field || 'image';
      if (field === 'text' && (!msg.text || msg.text.endsWith('…'))) {
        return '<span class="media-loading">📥 テキスト読込中…</span>';
      }
      if (field !== 'text' && !msg[field]) {
        const label = field === 'video' ? '動画' : field === 'fileData' ? 'ファイル' : '写真';
        return '<span class="media-loading">📥 ' + label + '読込中…</span>';
      }
    }
    return _getMessageContentHtmlExtV37(msg);
  };
}

const _renderMessagesV37 = typeof renderMessages === 'function' ? renderMessages : null;
if (_renderMessagesV37) {
  renderMessages = function (convId) {
    hydrateConversationMedia(convId).finally(() => _renderMessagesV37(convId));
  };
}
