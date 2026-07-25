/**
 * BlueChat v38 — セキュリティ強化（APIトークン・PBKDF2・起動時認証）
 */
var APP_VERSION = 'v38';

async function matchesPasswordHash(password, stored) {
  if (!stored) return true;
  if (typeof verifyPasswordSecure === 'function' && String(stored).startsWith('pbkdf2:')) {
    return verifyPasswordSecure(password, stored);
  }
  return simpleHash(password || '') === stored;
}

async function hashPasswordSecure(password) {
  const text = String(password || '');
  if (!text) return null;
  if (!crypto || !crypto.subtle) return simpleHash(text);
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(text), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    key,
    256
  );
  const hashBytes = new Uint8Array(bits);
  let hashBin = '';
  hashBytes.forEach(b => { hashBin += String.fromCharCode(b); });
  let saltBin = '';
  salt.forEach(b => { saltBin += String.fromCharCode(b); });
  return 'pbkdf2:120000:' + btoa(saltBin) + ':' + btoa(hashBin);
}

async function verifyPasswordSecure(password, stored) {
  const text = String(password || '');
  const hash = String(stored || '');
  if (!hash) return true;
  if (!hash.startsWith('pbkdf2:')) return simpleHash(text) === hash;
  const parts = hash.split(':');
  if (parts.length !== 4 || !crypto || !crypto.subtle) return false;
  const iterations = parseInt(parts[1], 10) || 120000;
  const salt = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
  const expected = parts[3];
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(text), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  const hashBytes = new Uint8Array(bits);
  let hashBin = '';
  hashBytes.forEach(b => { hashBin += String.fromCharCode(b); });
  return btoa(hashBin) === expected;
}

const _setUserAccountPasswordV38 = setUserAccountPassword;
setUserAccountPassword = function (userId, password) {
  hashPasswordSecure(password).then((hash) => {
    const data = getData();
    const user = data.users[userId];
    if (!user) return;
    if (hash) user.passwordHash = hash;
    else delete user.passwordHash;
    saveData(data);
    cloudPushUser(user);
  });
};

const _verifyUserPasswordV38 = typeof verifyUserPassword === 'function' ? verifyUserPassword : null;
if (_verifyUserPasswordV38) {
  verifyUserPassword = function (user, password) {
    const hash = user && user.passwordHash;
    if (!hash) return true;
    if (String(hash).startsWith('pbkdf2:')) {
      return verifyPasswordSecure(password, hash);
    }
    return _verifyUserPasswordV38(user, password);
  };
}

const _startGlobalSyncV38 = startGlobalSync;
startGlobalSync = function () {
  ensureApiTokenForCurrentUser().finally(() => _startGlobalSyncV38());
};

const _createUserV38 = createUser;
createUser = function (name) {
  const user = _createUserV38(name);
  ensureApiTokenForCurrentUser().catch(() => {});
  return user;
};

const _initV38 = init;
init = function () {
  _initV38();
  ensureApiTokenForCurrentUser().catch(() => {});
};

function isSafeMediaUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (u.startsWith('blob:')) return true;
  if (u.startsWith('data:image/')) return true;
  if (u.startsWith('https://')) return true;
  return false;
}

const _getMessageContentHtmlExtV38 = typeof getMessageContentHtmlExt === 'function' ? getMessageContentHtmlExt : null;
if (_getMessageContentHtmlExtV38) {
  getMessageContentHtmlExt = function (msg) {
    if (msg && msg.image && !isSafeMediaUrl(msg.image)) return escapeHtml('（安全でないメディアURL）');
    if (msg && msg.video && !isSafeMediaUrl(msg.video)) return escapeHtml('（安全でない動画URL）');
    return _getMessageContentHtmlExtV38(msg);
  };
}

loadAdminSession = function () {
  adminLoggedIn = localStorage.getItem(ADMIN_SESSION_KEY) === '1' && !!getAdminToken();
  adminRole = adminLoggedIn ? (localStorage.getItem(ADMIN_ROLE_KEY) || null) : null;
};
