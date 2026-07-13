/**
 * BlueChat v15 — ペアリング完了が止まらない問題の修正
 */
var APP_VERSION = 'v15';

const PAIR_REDEEM_TIMEOUT_MS = 60000;
let pairRedeemInProgress = false;

async function restoreAccountForPairing(pairInfo, password) {
  const uid = String(pairInfo.userId || '').trim();
  if (!uid) return { error: 'ユーザーIDが不正です' };

  const remote = await cloudFetchUser(uid);
  if (remote && remote.passwordHash) {
    if (!password) return { error: 'パスワードが必要です' };
    if (remote.passwordHash !== simpleHash(password)) {
      return { error: 'パスワードが正しくありません' };
    }
  }

  const restored = await restoreAccountByUserId(uid, password);
  if (!restored.error) return restored;

  if (!remote || !remote.id) {
    return { error: restored.error || 'アカウント情報を取得できませんでした' };
  }

  const data = getData();
  data.currentUserId = remote.id;
  data.users[remote.id] = {
    id: remote.id,
    name: remote.name || pairInfo.userName || 'ユーザー',
    createdAt: remote.createdAt || Date.now(),
    avatar: remote.avatar || null,
    avatarUpdatedAt: remote.avatarUpdatedAt || 0,
    passwordHash: remote.passwordHash || null,
    title: remote.title || null,
    premium: remote.premium || false,
    superPremium: remote.superPremium || false
  };
  saveData(data);
  return { success: true, source: 'pair-bootstrap' };
}

function markDevicePairConsumedAsync(token) {
  if (!token || !getEffectiveSyncUrl()) return;
  cloudRequestExt(`/api/device-pair/${token}/consumed`, { method: 'POST', body: '{}' }, 15000)
    .catch(() => cloudRequestExt(`/api/transfer/${token}/consumed`, { method: 'POST', body: '{}' }, 15000))
    .catch(() => {});
}

async function runDevicePairRedeem(code) {
  if (pairRedeemInProgress) return { error: 'ペアリング処理中です' };
  pairRedeemInProgress = true;
  try {
    return await withAsyncTimeout(
      redeemDevicePairCodeFast(code),
      PAIR_REDEEM_TIMEOUT_MS,
      'ペアリングがタイムアウトしました。コードを再確認してください'
    );
  } catch (e) {
    return { error: e?.message || 'ペアリングに失敗しました' };
  } finally {
    pairRedeemInProgress = false;
  }
}

async function redeemDevicePairShortCodeDirect(shortCode) {
  const digits = String(shortCode || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(digits)) return { error: '6桁の数字を入力してください' };
  ensurePairSyncUrl();
  if (!getEffectiveSyncUrl()) return { error: '同期サーバーに接続できません' };
  const lookup = await cloudRequestExt(`/api/device-pair-short/${digits}`, {}, 20000);
  if (!lookup || !lookup.userId || !lookup.token) {
    return { error: 'コードが見つかりません。期限切れの可能性があります' };
  }
  return redeemDevicePairCodeFast(DEVICE_PAIR_PREFIX + lookup.token);
}

redeemDevicePairShortCode = redeemDevicePairShortCodeDirect;

async function redeemDevicePairCodeFast(code) {
  const raw = String(code || '').trim();
  if (/^\d{6}$/.test(raw.replace(/\D/g, '')) && raw.replace(/\D/g, '').length === 6 && !raw.includes(':')) {
    return redeemDevicePairShortCodeDirect(raw);
  }
  const digitsOnly = raw.replace(/\D/g, '');
  if (/^\d{6}$/.test(digitsOnly) && !raw.toLowerCase().includes('pair')) {
    return redeemDevicePairShortCodeDirect(digitsOnly);
  }
  const idx = raw.toLowerCase().indexOf(DEVICE_PAIR_PREFIX);
  if (idx < 0) return { error: '無効なペアリングコードです' };
  const token = raw.slice(idx + DEVICE_PAIR_PREFIX.length).trim();
  if (!token) return { error: '無効なペアリングコードです' };

  ensurePairSyncUrl();
  if (!getEffectiveSyncUrl()) return { error: '同期サーバーに接続できません' };

  const pairInfo = await resolveDevicePairInfo(token);
  if (!pairInfo || !pairInfo.userId) {
    return { error: 'ペアリングコードの期限が切れたか、無効です' };
  }

  if (pairInfo.syncUrl && typeof setSyncUrl === 'function') {
    const migrated = typeof resolveSyncUrl === 'function' ? resolveSyncUrl(pairInfo.syncUrl) : pairInfo.syncUrl;
    if (migrated) setSyncUrl(migrated);
  }

  let password = document.getElementById('input-transfer-password')?.value || '';
  if (pairInfo.requiresPassword && !password) {
    password = prompt('ペアリング用パスワードを入力してください') || '';
    if (!password) return { error: 'パスワードが必要です' };
  }

  markDevicePairConsumedAsync(token);

  const result = await restoreAccountForPairing(pairInfo, password);
  if (result.error) return result;

  localStorage.setItem(ACCOUNT_SYNC_TS_KEY, String(Date.now()));
  if (typeof schedulePushAccountToCloud === 'function') {
    schedulePushAccountToCloud();
  } else if (typeof pushAccountToCloud === 'function') {
    pushAccountToCloud().catch(() => {});
  }

  return { success: true, source: 'pair' };
}

redeemDevicePairCode = function (code) {
  return runDevicePairRedeem(code);
};

handleDevicePairResult = function (result) {
  if (result.error) {
    showToast(result.error);
    transferScanHandled = false;
    qrScanHandled = false;
    pairRedeemInProgress = false;
    const modal = document.getElementById('modal-transfer-scan');
    if (modal && !modal.classList.contains('hidden')) {
      setTimeout(() => startQrScannerForTransfer(), 400);
    }
    return;
  }
  hideModal('modal-transfer-scan');
  if (typeof stopTransferScanner === 'function') stopTransferScanner();
  showScreen('main');
  refreshMainUI();
  if (typeof startGlobalSync === 'function') startGlobalSync();
  if (typeof startPresenceHeartbeat === 'function') startPresenceHeartbeat();
  if (typeof scheduleCloudBackup === 'function') scheduleCloudBackup();
  if (typeof updateAccountSyncStatusUI === 'function') updateAccountSyncStatusUI();
  if (typeof syncAllConversations === 'function') {
    syncAllConversations().catch(() => {});
  }
  showToast('ペアリング完了！同期を開始しました');
};

loginAccountOnDevice = async function (userId, password) {
  const v = await verifyRemoteAccountPassword(userId, password);
  if (v.error) return v;
  const result = await restoreAccountForPairing({ userId }, password);
  if (result.error) return result;
  localStorage.setItem(ACCOUNT_SYNC_TS_KEY, String(Date.now()));
  if (typeof syncAllConversations === 'function') syncAllConversations().catch(() => {});
  return { success: true, source: result.source };
};

onTransferScanSuccess = function (decodedText) {
  if (transferScanHandled || pairRedeemInProgress) return;
  const pairCode = typeof parseDevicePairFromScan === 'function' ? parseDevicePairFromScan(decodedText) : null;
  if (pairCode) {
    transferScanHandled = true;
    qrScanHandled = true;
    if (typeof stopTransferScanner === 'function') stopTransferScanner();
    showToast('ペアリング中…');
    runDevicePairRedeem(pairCode)
      .then(handleDevicePairResult)
      .catch(e => handleDevicePairResult({ error: e?.message || 'ペアリングに失敗しました' }));
    return;
  }
  const transferCode = typeof parseTransferCodeFromScan === 'function' ? parseTransferCodeFromScan(decodedText) : null;
  if (!transferCode) return;
  transferScanHandled = true;
  qrScanHandled = true;
  if (typeof stopTransferScanner === 'function') stopTransferScanner();
  showToast('引き継ぎ中…');
  if (typeof redeemTransferCodeExt === 'function') {
    redeemTransferCodeExt(transferCode)
      .then(handleTransferRedeemResult)
      .catch(e => handleTransferRedeemResult({ error: e?.message || '引き継ぎに失敗しました' }));
  }
};

redeemPairShortCodeFromModal = function () {
  const code = document.getElementById('input-pair-short-code')?.value?.trim() || '';
  if (!code) {
    showToast('6桁コードを入力してください');
    return;
  }
  if (typeof stopTransferScanner === 'function') stopTransferScanner();
  showToast('ペアリング中…');
  runDevicePairRedeem(code)
    .then(result => {
      if (typeof handleDevicePairResult === 'function') handleDevicePairResult(result);
      else handleTransferRedeemResult(result);
    })
    .catch(e => {
      if (typeof handleDevicePairResult === 'function') {
        handleDevicePairResult({ error: e?.message || 'ペアリングに失敗しました' });
      } else {
        showToast(e?.message || 'ペアリングに失敗しました');
      }
    });
};

onAppInit(() => {});
