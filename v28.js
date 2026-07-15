/**
 * BlueChat v28 — ChromeOS/Apple 間の同期修正（HTTPS同期URLの自動修復）
 */
var APP_VERSION = 'v28';

if (typeof repairSyncUrlForCurrentPage === 'function') {
  repairSyncUrlForCurrentPage();
}

const _startGlobalSyncV28 = startGlobalSync;
startGlobalSync = function () {
  if (typeof repairSyncUrlForCurrentPage === 'function') repairSyncUrlForCurrentPage();
  return _startGlobalSyncV28();
};
