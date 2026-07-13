/**
 * BlueChat v14 — 6桁ペアリングコード・QR表示の修正
 */
var APP_VERSION = 'v14';

function ensurePairSyncUrl() {
  if (typeof ensureSyncUrlForRestore === 'function') ensureSyncUrlForRestore();
  if (!getEffectiveSyncUrl() && typeof initSyncFromQuery === 'function') initSyncFromQuery();
}

function trySavePairPasswordFromInput() {
  const user = getCurrentUser();
  if (!user || user.passwordHash) return user;
  const pw = document.getElementById('input-account-password')?.value?.trim() || '';
  if (pw && typeof setUserAccountPassword === 'function') {
    setUserAccountPassword(user.id, pw);
    return getCurrentUser();
  }
  return user;
}

function drawDevicePairQrImage(container, text) {
  if (!container || !text) return false;
  container.innerHTML = '';
  if (typeof renderScannableQr === 'function' && renderScannableQr(container, text, 280)) {
    return true;
  }
  if (typeof QRCode !== 'undefined') {
    try {
      new QRCode(container, {
        text: String(text),
        width: 280,
        height: 280,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.L
      });
      return true;
    } catch (e) { /* fall through */ }
  }
  return false;
}

function showDevicePairShortCode(shortCode) {
  const el = document.getElementById('device-pair-short-code');
  if (!el) return;
  el.textContent = shortCode || '------';
  el.classList.toggle('hidden', !shortCode);
}

createDevicePairSession = async function () {
  ensurePairSyncUrl();
  const user = trySavePairPasswordFromInput();
  if (!user) {
    showToast('先にアカウントを作成してください');
    return null;
  }
  if (!getEffectiveSyncUrl()) {
    showToast('同期サーバーに接続できません。マイページでURLを確認してください');
    return null;
  }
  const token = generateId() + generateId();
  if (typeof schedulePushAccountToCloud === 'function') {
    schedulePushAccountToCloud();
  } else if (typeof pushAccountToCloud === 'function') {
    pushAccountToCloud().catch(() => {});
  }
  const expiresAt = Date.now() + DEVICE_PAIR_EXPIRY_MS;
  const payload = {
    userId: user.id,
    userName: user.name,
    passwordHash: user.passwordHash || null,
    syncUrl: getEffectiveSyncUrl(),
    expiresAt
  };
  let shortCode = '';
  const ok = await cloudRequestExt(`/api/device-pair/${token}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  }, 30000);
  if (ok && ok.ok) {
    shortCode = String(ok.shortCode || '').trim();
  } else {
    const fallback = await createDevicePairViaTransferFallback(token, user);
    if (!fallback) return null;
  }
  if (!shortCode) {
    const reg = await cloudRequestExt(`/api/device-pair-short/register`, {
      method: 'POST',
      body: JSON.stringify({ token, expiresAt })
    }, 30000);
    if (reg && reg.shortCode) shortCode = String(reg.shortCode);
  }
  return {
    token,
    shortCode,
    fullCode: DEVICE_PAIR_PREFIX + token
  };
};

renderDevicePairQR = function () {
  const user = getCurrentUser();
  if (!user) return;
  const container = document.getElementById('device-pair-qr-canvas');
  const textEl = document.getElementById('device-pair-code-text');
  showDevicePairShortCode('');
  if (container) {
    container.innerHTML = '<p class="qr-hint" style="padding:24px;text-align:center">コードを生成中…</p>';
  }
  if (textEl) textEl.textContent = '';
  createDevicePairSession().then(session => {
    if (!session) {
      showDevicePairShortCode('');
      if (container) {
        container.innerHTML = '<p class="qr-hint" style="padding:24px;text-align:center">コードを表示できませんでした。<br>同期サーバー接続を確認してください。</p>';
      }
      return;
    }
    showDevicePairShortCode(session.shortCode || '------');
    if (textEl) {
      textEl.textContent = session.shortCode
        ? `6桁コード: ${session.shortCode}（15分間有効）`
        : session.fullCode;
    }
    if (container) container.innerHTML = '';
    if (container && session.fullCode) {
      const drawn = drawDevicePairQrImage(container, session.fullCode);
      if (!drawn && container) {
        container.innerHTML = '<p class="qr-hint" style="padding:16px;text-align:center">QR画像は表示できませんでした。<br>上の6桁コードをお使いください。</p>';
      }
    }
    pollDevicePairConsumed(session.token);
  });
};

pollDevicePairConsumed = async function (token) {
  if (!getEffectiveSyncUrl() || !token) return;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const modal = document.getElementById('modal-device-pair-qr');
    if (!modal || modal.classList.contains('hidden')) return;
    const status = await cloudRequestExt(`/api/device-pair/${token}/status`, {}, 20000);
    let consumed = status && status.consumed;
    if (!consumed) {
      const tStatus = await cloudRequestExt(`/api/transfer/${token}/status`, {}, 20000);
      consumed = !!(tStatus && tStatus.consumed);
    }
    if (consumed) {
      hideModal('modal-device-pair-qr');
      if (typeof syncAccountAcrossDevices === 'function') await syncAccountAcrossDevices();
      else if (typeof syncAllConversations === 'function') await syncAllConversations();
      showToast('端末ペアリングが完了しました。同期を開始します');
      return;
    }
  }
};

async function resolveDevicePairInfo(token) {
  const info = await cloudRequestExt(`/api/device-pair/${token}`, {}, 30000);
  if (info && info.userId) return { ...info, token };
  const transfer = await cloudRequestExt(`/api/transfer/${token}`, {}, 30000);
  const backup = transfer && transfer.backup;
  if (backup && backup.cloudBackupUserId) {
    return {
      userId: backup.cloudBackupUserId,
      userName: backup.data?.users?.[backup.cloudBackupUserId]?.name || 'ユーザー',
      requiresPassword: !!backup.passwordHash,
      syncUrl: backup.syncUrl || null,
      token
    };
  }
  return null;
}

async function redeemDevicePairShortCode(shortCode) {
  const digits = String(shortCode || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(digits)) return { error: '6桁の数字を入力してください' };
  ensurePairSyncUrl();
  if (!getEffectiveSyncUrl()) return { error: '同期サーバーに接続できません' };
  const lookup = await cloudRequestExt(`/api/device-pair-short/${digits}`, {}, 30000);
  if (!lookup || !lookup.userId || !lookup.token) {
    return { error: 'コードが見つかりません。期限切れの可能性があります' };
  }
  return redeemDevicePairCode(DEVICE_PAIR_PREFIX + lookup.token);
}

redeemDevicePairCode = async function (code) {
  const raw = String(code || '').trim();
  if (/^\d{6}$/.test(raw.replace(/\D/g, '')) && raw.replace(/\D/g, '').length === 6 && !raw.includes(':')) {
    return redeemDevicePairShortCode(raw);
  }
  const digitsOnly = raw.replace(/\D/g, '');
  if (/^\d{6}$/.test(digitsOnly) && !raw.toLowerCase().includes('pair')) {
    return redeemDevicePairShortCode(digitsOnly);
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
  const result = typeof loginAccountOnDevice === 'function'
    ? await loginAccountOnDevice(pairInfo.userId, password)
    : await restoreAccountByUserId(pairInfo.userId, password);
  if (result.error) return result;
  await cloudRequestExt(`/api/device-pair/${token}/consumed`, { method: 'POST', body: '{}' }, 30000)
    .catch(() => cloudRequestExt(`/api/transfer/${token}/consumed`, { method: 'POST', body: '{}' }, 30000));
  if (typeof pushAccountToCloud === 'function') await pushAccountToCloud().catch(() => {});
  return { success: true, source: 'pair' };
};

showDevicePairQRModal = function () {
  const user = getCurrentUser();
  if (!user) {
    showToast('先にアカウントを作成してください');
    return;
  }
  ensurePairSyncUrl();
  showModal('modal-device-pair-qr');
  requestAnimationFrame(() => setTimeout(() => renderDevicePairQR(), 80));
};

function redeemPairShortCodeFromModal() {
  const code = document.getElementById('input-pair-short-code')?.value?.trim() || '';
  if (!code) {
    showToast('6桁コードを入力してください');
    return;
  }
  if (typeof stopTransferScanner === 'function') stopTransferScanner();
  showToast('ペアリング中…');
  redeemDevicePairCode(code).then(result => {
    if (typeof handleDevicePairResult === 'function') handleDevicePairResult(result);
    else handleTransferRedeemResult(result);
  });
}

function initV14Features() {
  bindClick('btn-redeem-pair-short-code', () => redeemPairShortCodeFromModal());
  bindClick('btn-show-device-pair-qr', () => showDevicePairQRModal());
  bindClick('btn-copy-pair-short-code', async () => {
    const code = document.getElementById('device-pair-short-code')?.textContent?.trim() || '';
    if (!code || code === '------') {
      showToast('コードがまだ生成されていません');
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      showToast('6桁コードをコピーしました');
    } catch (e) {
      showToast('コピーできませんでした: ' + code);
    }
  });
}

onAppInit(() => {
  initV14Features();
});
