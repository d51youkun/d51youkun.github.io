/**
 * BlueChat v17 — 古い通知の再表示を防止
 */
var APP_VERSION = 'v17';

const _mergeCloudBackupV17 = typeof mergeCloudBackupDataIntoLocal === 'function'
  ? mergeCloudBackupDataIntoLocal
  : null;

if (_mergeCloudBackupV17) {
  mergeCloudBackupDataIntoLocal = function (backup) {
    suppressNotificationsFor(8000);
    const changed = _mergeCloudBackupV17(backup);
    resetNotifiedIdsCache();
    refreshNotifyBaselineFromLocal();
    return changed;
  };
}
