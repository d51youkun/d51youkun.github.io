/**
 * BlueChat v22 — 起動時の同期で通知が出ないよう完全分離
 */
var APP_VERSION = 'v22';

const _syncAllConversationsV22 = syncAllConversations;
syncAllConversations = async function () {
  beginSyncNotifyMute(20000);
  suppressNotificationsFor(20000);
  try {
    return await _syncAllConversationsV22();
  } finally {
    if (typeof refreshNotifyBaselineFromLocal === 'function') refreshNotifyBaselineFromLocal();
    if (typeof pollRealtimeNotifications === 'function') pollRealtimeNotifications();
    if (typeof flushNotifyMemState === 'function') flushNotifyMemState();
  }
};
