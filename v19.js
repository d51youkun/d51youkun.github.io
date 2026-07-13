/**
 * BlueChat v19 — 起動時の通知地獄を防止
 */
var APP_VERSION = 'v19';

const _handleRemoteActivityV19 = handleRemoteActivity;
handleRemoteActivity = async function () {
  if (typeof beginSyncNotifyMute === 'function') beginSyncNotifyMute(10000);
  if (typeof suppressNotificationsFor === 'function') suppressNotificationsFor(10000);
  await _handleRemoteActivityV19();
};

const _mergeCloudBackupV19 = typeof mergeCloudBackupDataIntoLocal === 'function'
  ? mergeCloudBackupDataIntoLocal
  : null;

if (_mergeCloudBackupV19) {
  mergeCloudBackupDataIntoLocal = function (backup) {
    if (typeof beginSyncNotifyMute === 'function') beginSyncNotifyMute(20000);
    if (typeof suppressNotificationsFor === 'function') suppressNotificationsFor(20000);
    const changed = _mergeCloudBackupV19(backup);
    if (typeof refreshNotifyBaselineFromLocal === 'function') refreshNotifyBaselineFromLocal();
    return changed;
  };
}
