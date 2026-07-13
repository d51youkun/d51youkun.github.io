/**
 * BlueChat v21 — 既読・同期済みメッセージの再通知を完全停止
 */
var APP_VERSION = 'v21';

const _syncAllConversationsV21 = syncAllConversations;
syncAllConversations = async function () {
  beginSyncNotifyMute(8000);
  suppressNotificationsFor(8000);
  try {
    return await _syncAllConversationsV21();
  } finally {
    if (typeof refreshNotifyBaselineFromLocal === 'function') refreshNotifyBaselineFromLocal();
  }
};
