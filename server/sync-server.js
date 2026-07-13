/**
 * BlueChat 同期サーバー
 * 起動: node server/sync-server.js
 * デフォルト: http://0.0.0.0:8766
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8766;
const SERVER_VERSION = '2026-07-13';

function resolveWritableDataFile() {
  const legacy = path.join(__dirname, 'data.json');
  const candidates = [
    process.env.DATA_DIR,
    process.env.TMPDIR,
    process.env.TEMP,
    '/tmp'
  ].filter(Boolean).map(dir => path.join(dir, 'bluechat-data.json'));
  candidates.push(legacy);
  for (const file of candidates) {
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.bluechat-write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      if (file !== legacy && fs.existsSync(legacy) && !fs.existsSync(file)) {
        try { fs.copyFileSync(legacy, file); } catch (e) { /* ignore */ }
      }
      return file;
    } catch (e) { /* try next */ }
  }
  return legacy;
}

const DATA_FILE = resolveWritableDataFile();

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq < 1) return;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] !== undefined) return;
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    });
  } catch (e) { /* ignore */ }
}

loadDotEnv();

// Upstash Redis (REST API) 経由の永続化。Render無料プランはディスクが消えるため、
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を設定すると自動でこちらを使う。
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);
const UPSTASH_KEY = 'bluechat:data';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MODERATOR_EMAIL = (process.env.MODERATOR_EMAIL || '').trim().toLowerCase();
const MODERATOR_PASSWORD = process.env.MODERATOR_PASSWORD || '';

function verifyAdminLogin(email, password) {
  const e = String(email || '').trim().toLowerCase();
  const p = String(password || '').trim();
  if (ADMIN_EMAIL && ADMIN_PASSWORD && e === ADMIN_EMAIL && p === ADMIN_PASSWORD) return 'super';
  if (MODERATOR_EMAIL && MODERATOR_PASSWORD && e === MODERATOR_EMAIL && p === MODERATOR_PASSWORD) return 'moderator';
  return null;
}

function issueAdminSession(data, role) {
  if (!data.adminSessions) data.adminSessions = {};
  const token = crypto.randomBytes(24).toString('hex');
  data.adminSessions[token] = { role, expiresAt: Date.now() + 86400000 };
  Object.keys(data.adminSessions).forEach(k => {
    if (data.adminSessions[k].expiresAt < Date.now()) delete data.adminSessions[k];
  });
  return token;
}

function verifyAdminSession(data, token, needSuper) {
  if (!token || !data.adminSessions) return null;
  const s = data.adminSessions[token];
  if (!s || s.expiresAt < Date.now()) return null;
  if (needSuper && s.role !== 'super') return null;
  return s.role;
}

function friendshipListForUser(data, userId) {
  const uid = String(userId);
  const out = [];
  const seen = new Set();
  const add = (f) => {
    if (!f || !f.user1 || !f.user2) return;
    const key = [String(f.user1), String(f.user2)].sort().join('_');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      user1: String(f.user1),
      user2: String(f.user2),
      createdAt: f.createdAt || Date.now()
    });
  };
  const raw = data.friendships || {};
  if (Array.isArray(raw)) raw.forEach(add);
  else Object.values(raw).forEach(f => {
    if (String(f.user1) === uid || String(f.user2) === uid) add(f);
  });
  const ufs = (data.userFriendships && data.userFriendships[uid]) || {};
  Object.keys(ufs).forEach(fid => add({ user1: uid, user2: fid, createdAt: Date.now() }));
  return out;
}

function buildUserSyncBundle(data, userId) {
  const uid = String(userId);
  const user = data.users && data.users[uid];
  if (!user) return null;

  const convIds = Object.keys((data.userConversations && data.userConversations[uid]) || {});
  const conversations = {};
  const messages = {};
  const users = { [uid]: user };
  const readReceipts = {};

  convIds.forEach(convId => {
    const conv = data.conversations && data.conversations[convId];
    if (!conv) return;
    conversations[convId] = conv;
    (conv.members || []).forEach(mid => {
      if (data.users[mid]) users[String(mid)] = data.users[mid];
    });
    const convMsgs = (data.messages && data.messages[convId]) || {};
    messages[convId] = Array.isArray(convMsgs)
      ? convMsgs
      : Object.values(convMsgs).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (data.readReceipts && data.readReceipts[convId]) {
      readReceipts[convId] = data.readReceipts[convId];
    }
  });

  return {
    version: 2,
    exportedAt: Date.now(),
    syncUrl: null,
    data: {
      currentUserId: uid,
      users,
      friendCodes: {},
      friendships: friendshipListForUser(data, uid),
      conversations,
      messages,
      readReceipts,
      customStickerPacks: (data.userStickers && data.userStickers[uid] && data.userStickers[uid].packs) || [],
      titlePresets: data.titlePresets || []
    }
  };
}

function assignDevicePairShortCode(data, token, expiresAt) {
  if (!data.shortDevicePairs) data.shortDevicePairs = {};
  const digits = '0123456789';
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += digits[Math.floor(Math.random() * digits.length)];
    }
    const prev = data.shortDevicePairs[code];
    if (!prev || Date.now() > (prev.expiresAt || 0)) {
      data.shortDevicePairs[code] = { token: String(token), expiresAt: expiresAt || Date.now() + 15 * 60 * 1000 };
      return code;
    }
  }
  return String(100000 + Math.floor(Math.random() * 900000));
}

function getDevicePairShortRef(data, shortCode) {
  if (!data.shortDevicePairs) return null;
  const ref = data.shortDevicePairs[String(shortCode || '').trim()];
  if (!ref || Date.now() > (ref.expiresAt || 0)) return null;
  return ref;
}

function createTransferEntry(data, backup, hours) {
  if (!data.transfers) data.transfers = {};
  if (!data.shortTransfers) data.shortTransfers = {};
  const token = Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
  const expiresAt = Date.now() + (hours || 24) * 60 * 60 * 1000;
  data.transfers[token] = {
    backup,
    expiresAt,
    consumed: false,
    createdAt: Date.now()
  };
  let shortCode = '';
  for (let i = 0; i < 8; i++) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    shortCode += chars[Math.floor(Math.random() * chars.length)];
  }
  data.shortTransfers[shortCode] = { token, expiresAt };
  return { token, shortCode, code: 'bluechat-transfer:' + token, expiresAt };
}

function emptyData() {
  return {
    conversations: {},
    messages: {},
    userConversations: {},
    users: {},
    friendships: {},
    userFriendships: {},
    readReceipts: {},
    transfers: {},
    shortTransfers: {},
    devicePairs: {},
    shortDevicePairs: {},
    adminSessions: {},
    callSignals: {},
    feedback: [],
    cloudBackups: {},
    presence: {},
    announcements: [],
    announcementReads: {},
    posts: [],
    friendRequests: [],
    sharedStickerPacks: {},
    activityVersion: 0,
    titlePresets: []
  };
}

function createFriendshipOnServer(data, id1, id2, createdAt) {
  const a = String(id1);
  const b = String(id2);
  if (!a || !b || a === b) return false;
  if (!data.friendships) data.friendships = {};
  if (!data.userFriendships) data.userFriendships = {};
  if (!data.conversations) data.conversations = {};
  if (!data.userConversations) data.userConversations = {};
  const key = 'f_' + [a, b].sort().join('_');
  if (!data.friendships[key]) {
    data.friendships[key] = { user1: a, user2: b, createdAt: createdAt || Date.now() };
  }
  [a, b].forEach(uid => {
    if (!data.userFriendships[uid]) data.userFriendships[uid] = {};
    data.userFriendships[uid][uid === a ? b : a] = true;
  });
  const convId = 'dm_' + [a, b].sort().join('_');
  if (!data.conversations[convId]) {
    data.conversations[convId] = {
      id: convId,
      type: 'direct',
      members: [a, b].sort(),
      createdAt: createdAt || Date.now(),
      lastMessageAt: null,
      lastMessagePreview: null
    };
  }
  [a, b].forEach(uid => {
    if (!data.userConversations[uid]) data.userConversations[uid] = {};
    data.userConversations[uid][convId] = true;
  });
  return true;
}

function normalizeData(data) {
  const base = emptyData();
  if (!data || typeof data !== 'object') return { ...base };
  for (const key of Object.keys(base)) {
    if (data[key] === undefined) data[key] = base[key];
  }
  return data;
}

// Upstash REST の pipeline エンドポイントに1コマンド投げるヘルパー
async function upstashCommand(command) {
  const res = await fetch(UPSTASH_URL + '/', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + UPSTASH_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error('Upstash HTTP ' + res.status);
  const json = await res.json();
  if (json.error) throw new Error('Upstash error: ' + json.error);
  return json.result;
}

async function loadDataFromStorage() {
  if (USE_UPSTASH) {
    try {
      const raw = await upstashCommand(['GET', UPSTASH_KEY]);
      return normalizeData(raw ? JSON.parse(raw) : emptyData());
    } catch (e) {
      console.error('Upstash loadData failed, falling back to empty data:', e.message);
      return emptyData();
    }
  }
  try {
    return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    return emptyData();
  }
}

let memData = null;
let dataLock = Promise.resolve();

function withDataLock(fn) {
  const run = dataLock.then(fn);
  dataLock = run.catch(() => {});
  return run;
}

async function loadData() {
  return withDataLock(async () => {
    if (!memData) memData = await loadDataFromStorage();
    return JSON.parse(JSON.stringify(memData));
  });
}

async function saveDataToStorage(data) {
  const normalized = normalizeData(data);
  if (USE_UPSTASH) {
    await upstashCommand(['SET', UPSTASH_KEY, JSON.stringify(normalized)]);
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(normalized));
}

async function saveData(data) {
  return withDataLock(async () => {
    memData = normalizeData(JSON.parse(JSON.stringify(data)));
    await saveDataToStorage(memData);
  });
}

async function saveDataWithActivity(data) {
  data.activityVersion = (data.activityVersion || 0) + 1;
  await saveData(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'GET' && parts.length === 0) {
      sendJson(res, 200, {
        ok: true,
        service: 'BlueChat Sync',
        health: '/api/health',
        usage: 'マイページの同期サーバーURLにこのサイトのURLを入力してください'
      });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'health') {
      let writable = true;
      if (USE_UPSTASH) {
        try {
          await upstashCommand(['SET', 'bluechat:health-probe', String(Date.now())]);
        } catch (e) {
          writable = false;
        }
      } else {
        try {
          const probe = path.join(path.dirname(DATA_FILE), '.bluechat-health-probe');
          fs.writeFileSync(probe, String(Date.now()));
          fs.unlinkSync(probe);
        } catch (e) {
          writable = false;
        }
      }
      sendJson(res, 200, {
        ok: writable,
        service: 'BlueChat Sync',
        version: SERVER_VERSION,
        writable,
        storage: USE_UPSTASH ? 'upstash' : 'file',
        dataFile: USE_UPSTASH ? null : DATA_FILE
      });
      return;
    }

    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'login') {
      const body = await readBody(req);
      const role = verifyAdminLogin(body.email, body.password);
      if (!role) {
        sendJson(res, 401, { error: 'invalid' });
        return;
      }
      const data = await loadData();
      const token = issueAdminSession(data, role);
      await saveData(data);
      sendJson(res, 200, { ok: true, role, token });
      return;
    }

    const data = await loadData();

    const adminToken = req.headers['x-admin-token'] || req.headers['X-Admin-Token'] || '';
    const adminRoleFromToken = verifyAdminSession(data, adminToken, false);

    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'force-sync') {
      let role = adminRoleFromToken;
      const body = await readBody(req);
      if (!role) role = verifyAdminLogin(body.email, body.password);
      if (!role) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true, version: data.activityVersion || 0 });
      return;
    }

    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'issue-transfer') {
      if (verifyAdminSession(data, adminToken, true) !== 'super') {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readBody(req);
      const userId = String(body.userId || '').trim();
      if (!userId) {
        sendJson(res, 400, { error: 'userId required' });
        return;
      }
      let backup = (data.cloudBackups && data.cloudBackups[userId] && data.cloudBackups[userId].backup) || null;
      if (!backup || !backup.data) {
        backup = buildUserSyncBundle(data, userId);
      }
      if (!backup || !backup.data) {
        sendJson(res, 404, { error: 'no_data' });
        return;
      }
      const entry = createTransferEntry(data, backup, body.hours || 72);
      await saveData(data);
      sendJson(res, 200, {
        ok: true,
        code: entry.code,
        shortCode: entry.shortCode,
        expiresAt: entry.expiresAt
      });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'user' && parts[2] && parts[3] === 'sync-bundle') {
      const userId = parts[2];
      const bundle = buildUserSyncBundle(data, userId);
      if (!bundle) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, bundle);
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'transfer-short' && parts[2]) {
      const short = String(parts[2] || '').trim().toUpperCase();
      const ref = (data.shortTransfers && data.shortTransfers[short]) || null;
      if (!ref || Date.now() > ref.expiresAt) {
        sendJson(res, 404, { error: 'expired' });
        return;
      }
      const t = data.transfers && data.transfers[ref.token];
      if (!t || Date.now() > t.expiresAt) {
        sendJson(res, 404, { error: 'expired' });
        return;
      }
      sendJson(res, 200, { code: 'bluechat-transfer:' + ref.token, backup: t.backup });
      return;
    }

    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'conversations' && parts[2]) {
      const conv = await readBody(req);
      const convId = parts[2];
      const isNewConv = !data.conversations[convId];
      data.conversations[convId] = { ...conv, id: convId };
      if (!data.userConversations) data.userConversations = {};
      (conv.members || []).forEach(memberId => {
        const mid = String(memberId);
        if (!data.userConversations[mid]) data.userConversations[mid] = {};
        data.userConversations[mid][convId] = true;
      });
      if (isNewConv) await saveDataWithActivity(data);
      else await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'messages' && parts[2] && parts[3]) {
      const convId = parts[2];
      const msgId = parts[3];
      if (data.messages[convId]) delete data.messages[convId][msgId];
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'messages' && parts[2] && parts[3] === 'ids') {
      const convId = parts[2];
      const convMsgs = data.messages[convId] || {};
      sendJson(res, 200, Object.keys(convMsgs));
      return;
    }

    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'messages' && parts[2] && parts[3]) {
      const convId = parts[2];
      const msgId = parts[3];
      const msg = await readBody(req);
      if (!data.messages) data.messages = {};
      if (!data.messages[convId]) data.messages[convId] = {};
      const isNew = !data.messages[convId][msgId];
      data.messages[convId][msgId] = { ...msg, id: msgId };
      if (isNew) await saveDataWithActivity(data);
      else await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'messages' && parts[2]) {
      const convId = parts[2];
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      const convMsgs = data.messages[convId] || {};
      const list = Object.values(convMsgs)
        .filter(m => (m.timestamp || 0) > since)
        .sort((a, b) => a.timestamp - b.timestamp);
      sendJson(res, 200, list);
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'conversations' && parts[2] === 'list') {
      const list = Object.values(data.conversations || {})
        .sort((a, b) => (b.lastMessageAt || b.createdAt || 0) - (a.lastMessageAt || a.createdAt || 0));
      sendJson(res, 200, list);
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'conversations' && parts[2]) {
      const conv = data.conversations[parts[2]] || null;
      sendJson(res, 200, conv);
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'user' && parts[2] && parts[3] === 'conversations') {
      const userId = String(parts[2]);
      const userConvs = (data.userConversations && data.userConversations[userId]) || {};
      sendJson(res, 200, Object.keys(userConvs));
      return;
    }

    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'users' && parts[2]) {
      const user = await readBody(req);
      if (!data.users) data.users = {};
      const prev = data.users[parts[2]] || {};
      data.users[parts[2]] = { ...user, id: parts[2] };
      const moderationChanged = prev.banned !== user.banned
        || prev.bannedUntil !== user.bannedUntil
        || prev.suspendedUntil !== user.suspendedUntil
        || prev.premium !== user.premium
        || prev.superPremium !== user.superPremium
        || JSON.stringify(prev.title) !== JSON.stringify(user.title);
      const profileChanged = prev.avatar !== user.avatar
        || (prev.avatarUpdatedAt || 0) !== (user.avatarUpdatedAt || 0)
        || prev.name !== user.name
        || prev.passwordHash !== user.passwordHash;
      if (moderationChanged || profileChanged) await saveDataWithActivity(data);
      else await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'users' && parts[2] === 'list') {
      const users = Object.values(data.users || {}).map(u => ({
        id: u.id,
        name: u.name,
        createdAt: u.createdAt,
        avatar: u.avatar || null,
        avatarUpdatedAt: u.avatarUpdatedAt || 0,
        title: u.title || null,
        suspendedUntil: u.suspendedUntil || null,
        banned: u.banned || false,
        bannedUntil: u.bannedUntil || null,
        premium: u.premium || false,
        superPremium: u.superPremium || false
      }));
      users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      sendJson(res, 200, users);
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'users' && parts[2]) {
      const user = (data.users && data.users[parts[2]]) || null;
      sendJson(res, 200, user);
      return;
    }

    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'users' && parts[2]) {
      const userId = String(parts[2]);
      if (data.users) delete data.users[userId];
      if (data.userFriendships && data.userFriendships[userId]) delete data.userFriendships[userId];
      if (data.cloudBackups && data.cloudBackups[userId]) delete data.cloudBackups[userId];
      if (data.userStickers && data.userStickers[userId]) delete data.userStickers[userId];
      if (data.presence && data.presence[userId]) delete data.presence[userId];
      if (data.announcementReads && data.announcementReads[userId]) delete data.announcementReads[userId];
      Object.keys(data.friendships || {}).forEach(key => {
        const f = data.friendships[key];
        if (f && (String(f.user1) === userId || String(f.user2) === userId)) delete data.friendships[key];
      });
      if (data.userConversations && data.userConversations[userId]) delete data.userConversations[userId];
      Object.keys(data.userConversations || {}).forEach(uid => {
        if (data.userConversations[uid] && data.userConversations[uid][userId]) {
          delete data.userConversations[uid][userId];
        }
      });
      Object.keys(data.conversations || {}).forEach(convId => {
        const conv = data.conversations[convId];
        if (!conv || !conv.members) return;
        if (conv.members.map(String).includes(userId)) {
          conv.members = conv.members.filter(m => String(m) !== userId);
          if (conv.members.length === 0) {
            delete data.conversations[convId];
            if (data.messages && data.messages[convId]) delete data.messages[convId];
            if (data.userConversations) {
              Object.keys(data.userConversations).forEach(uid => {
                if (data.userConversations[uid][convId]) delete data.userConversations[uid][convId];
              });
            }
          }
        }
      });
      Object.keys(data.callSignals || {}).forEach(uid => {
        if (String(uid) === userId) delete data.callSignals[uid];
      });
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'friendships' && parts[2]) {
      const body = await readBody(req);
      const id1 = String(body.user1 || '');
      const id2 = String(body.user2 || '');
      if (!id1 || !id2 || id1 === id2) {
        sendJson(res, 400, { error: 'invalid' });
        return;
      }
      if (!data.friendships) data.friendships = {};
      if (!data.userFriendships) data.userFriendships = {};
      if (!data.conversations) data.conversations = {};
      if (!data.userConversations) data.userConversations = {};
      data.friendships[parts[2]] = { user1: id1, user2: id2, createdAt: body.createdAt || Date.now() };
      [id1, id2].forEach(uid => {
        if (!data.userFriendships[uid]) data.userFriendships[uid] = {};
        data.userFriendships[uid][uid === id1 ? id2 : id1] = true;
      });
      const convId = 'dm_' + [id1, id2].sort().join('_');
      if (!data.conversations[convId]) {
        data.conversations[convId] = {
          id: convId,
          type: 'direct',
          members: [id1, id2].sort(),
          createdAt: body.createdAt || Date.now(),
          lastMessageAt: null,
          lastMessagePreview: null
        };
      }
      [id1, id2].forEach(uid => {
        if (!data.userConversations[uid]) data.userConversations[uid] = {};
        data.userConversations[uid][convId] = true;
      });
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'user' && parts[2] && parts[3] === 'friendships') {
      const userId = String(parts[2]);
      const friends = (data.userFriendships && data.userFriendships[userId]) || {};
      sendJson(res, 200, Object.keys(friends));
      return;
    }

    // Read receipts
    if (!data.readReceipts) data.readReceipts = {};
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'reads' && parts[2] && parts[3]) {
      const body = await readBody(req);
      if (!data.readReceipts[parts[2]]) data.readReceipts[parts[2]] = {};
      data.readReceipts[parts[2]][parts[3]] = body.timestamp || Date.now();
      await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'reads' && parts[2]) {
      sendJson(res, 200, data.readReceipts[parts[2]] || {});
      return;
    }

    // Device pair (QR multi-device sync)
    if (!data.devicePairs) data.devicePairs = {};
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'device-pair' && parts[2]) {
      const body = await readBody(req);
      if (!body.userId) {
        sendJson(res, 400, { error: 'user_required' });
        return;
      }
      data.devicePairs[parts[2]] = {
        userId: String(body.userId),
        userName: body.userName || 'ユーザー',
        passwordHash: body.passwordHash || null,
        syncUrl: body.syncUrl || null,
        expiresAt: body.expiresAt || Date.now() + 15 * 60 * 1000,
        consumed: false,
        consumedAt: null,
        createdAt: Date.now()
      };
      const shortCode = assignDevicePairShortCode(data, parts[2], data.devicePairs[parts[2]].expiresAt);
      data.devicePairs[parts[2]].shortCode = shortCode;
      await saveData(data);
      sendJson(res, 200, { ok: true, shortCode, token: parts[2] });
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'device-pair-short' && parts[2] === 'register') {
      const body = await readBody(req);
      const token = String(body.token || '').trim();
      if (!token || !data.devicePairs[token]) {
        sendJson(res, 404, { error: 'pair_not_found' });
        return;
      }
      const shortCode = assignDevicePairShortCode(data, token, body.expiresAt || data.devicePairs[token].expiresAt);
      data.devicePairs[token].shortCode = shortCode;
      await saveData(data);
      sendJson(res, 200, { ok: true, shortCode });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'device-pair-short' && parts[2]) {
      const ref = getDevicePairShortRef(data, parts[2]);
      if (!ref) {
        sendJson(res, 404, { error: 'expired' });
        return;
      }
      const entry = data.devicePairs[ref.token];
      if (!entry || Date.now() > entry.expiresAt) {
        sendJson(res, 404, { error: 'expired' });
        return;
      }
      sendJson(res, 200, {
        token: ref.token,
        userId: entry.userId,
        userName: entry.userName,
        requiresPassword: !!entry.passwordHash,
        syncUrl: entry.syncUrl || null,
        shortCode: parts[2]
      });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'device-pair' && parts[2] && parts[3] === 'status') {
      const entry = data.devicePairs[parts[2]];
      if (!entry || Date.now() > entry.expiresAt) {
        sendJson(res, 200, { consumed: false, exists: false });
        return;
      }
      sendJson(res, 200, {
        consumed: !!entry.consumed,
        exists: true,
        consumedAt: entry.consumedAt || null
      });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'device-pair' && parts[2]) {
      const entry = data.devicePairs[parts[2]];
      if (!entry || Date.now() > entry.expiresAt) {
        sendJson(res, 404, { error: 'expired' });
        return;
      }
      sendJson(res, 200, {
        userId: entry.userId,
        userName: entry.userName,
        requiresPassword: !!entry.passwordHash,
        syncUrl: entry.syncUrl || null
      });
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'device-pair' && parts[2] && parts[3] === 'consumed') {
      const entry = data.devicePairs[parts[2]];
      if (entry) {
        entry.consumed = true;
        entry.consumedAt = Date.now();
        await saveDataWithActivity(data);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // Device transfer
    if (!data.transfers) data.transfers = {};
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'transfer' && parts[2]) {
      const body = await readBody(req);
      data.transfers[parts[2]] = {
        backup: body.backup,
        expiresAt: body.expiresAt || Date.now() + 86400000,
        consumed: false,
        createdAt: Date.now()
      };
      await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'transfer' && parts[2] && parts[3] === 'status') {
      const t = data.transfers[parts[2]];
      sendJson(res, 200, { consumed: !!(t && t.consumed), exists: !!t });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'transfer' && parts[2]) {
      const t = data.transfers[parts[2]];
      if (!t || Date.now() > t.expiresAt) {
        sendJson(res, 404, { error: 'expired' });
        return;
      }
      sendJson(res, 200, { backup: t.backup });
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transfer' && parts[2] && parts[3] === 'consumed') {
      if (data.transfers[parts[2]]) {
        data.transfers[parts[2]].consumed = true;
        await saveData(data);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // WebRTC signaling
    if (!data.callSignals) data.callSignals = {};
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'call' && parts[2] === 'signal') {
      const body = await readBody(req);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (!data.callSignals[body.to]) data.callSignals[body.to] = [];
      data.callSignals[body.to].push({ id, ...body });
      if (data.callSignals[body.to].length > 100) {
        data.callSignals[body.to] = data.callSignals[body.to].slice(-50);
      }
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'call' && parts[2] === 'signals' && parts[3]) {
      const userId = String(parts[3]);
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      const all = data.callSignals[userId] || [];
      const list = all.filter(s => (s.timestamp || 0) > since);
      if (list.length) {
        const delivered = new Set(list.map(s => s.id));
        data.callSignals[userId] = all.filter(s => !delivered.has(s.id));
        await saveData(data);
      }
      sendJson(res, 200, list);
      return;
    }

    // Cloud backup (7-day retention, restore anytime)
    if (!data.cloudBackups) data.cloudBackups = {};
    // Title presets (max 10, shared across all clients)
    if (!data.titlePresets) data.titlePresets = [];
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'title-presets') {
      sendJson(res, 200, { presets: data.titlePresets || [] });
      return;
    }
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'title-presets') {
      const body = await readBody(req);
      const presets = Array.isArray(body.presets) ? body.presets.slice(0, 10) : [];
      data.titlePresets = presets.map(p => ({
        id: p.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        text: String(p.text || '').trim().slice(0, 20),
        color: String(p.color || '#1a6fd4').trim()
      })).filter(p => p.text);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true, presets: data.titlePresets });
      return;
    }

    // User sticker packs (sync across browsers on same account)
    if (!data.userStickers) data.userStickers = {};
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'user-stickers' && parts[2]) {
      const body = await readBody(req);
      data.userStickers[parts[2]] = {
        packs: body.packs || [],
        updatedAt: body.updatedAt || Date.now()
      };
      await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'user-stickers' && parts[2]) {
      const entry = data.userStickers[parts[2]] || { packs: [], updatedAt: 0 };
      sendJson(res, 200, entry);
      return;
    }

    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'cloud-backup' && parts[2]) {
      const body = await readBody(req);
      const userId = parts[2];
      data.cloudBackups[userId] = {
        backup: body.backup,
        updatedAt: body.updatedAt || Date.now(),
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
      };
      await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'cloud-backup' && parts[2]) {
      const entry = data.cloudBackups[parts[2]];
      if (!entry || Date.now() > entry.expiresAt) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, { backup: entry.backup, updatedAt: entry.updatedAt });
      return;
    }

    // Presence (online/offline)
    if (!data.presence) data.presence = {};
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'presence' && parts[2]) {
      const body = await readBody(req);
      data.presence[parts[2]] = { lastSeen: body.lastSeen || Date.now() };
      await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'presence') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const result = {};
      ids.forEach(id => {
        if (data.presence[id]) result[id] = data.presence[id];
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'line-stickers' && parts[2]) {
      const productId = parts[2];
      const https = require('https');
      const fetchJson = (fetchUrl) => new Promise((resolve, reject) => {
        https.get(fetchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json'
          }
        }, (resp) => {
          let d = '';
          resp.on('data', c => { d += c; });
          resp.on('end', () => {
            if (resp.statusCode && resp.statusCode >= 400) {
              reject(new Error('HTTP ' + resp.statusCode));
              return;
            }
            try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
          });
        }).on('error', reject);
      });
      const metaUrls = [
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/productInfo.meta`,
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/android/productInfo.meta`
      ];
      try {
        let meta = null;
        for (const metaUrl of metaUrls) {
          try {
            meta = await fetchJson(metaUrl);
            if (meta && Array.isArray(meta.stickers) && meta.stickers.length) break;
          } catch (e) { /* try next */ }
        }
        if (!meta || !Array.isArray(meta.stickers) || !meta.stickers.length) {
          sendJson(res, 404, {
            error: 'スタンプ情報を取得できませんでした。商品IDまたはURLを確認してください',
            stickers: []
          });
          return;
        }
        const titleObj = meta.title || {};
        const name = titleObj.ja || titleObj.en || titleObj['zh-Hant'] || ('LINE ' + productId);
        const isAnimated = !!(
          meta.hasAnimation
          || meta.stickerResourceType === 'ANIMATION'
          || meta.stickerResourceType === 'SOUND'
        );
        const stickers = meta.stickers.slice(0, 40).map(s => ({
          id: String(s.id),
          url: isAnimated
            ? `https://stickershop.line-scdn.net/stickershop/v1/sticker/${s.id}/IOS/sticker_animation.png`
            : `https://stickershop.line-scdn.net/stickershop/v1/sticker/${s.id}/android/sticker.png`,
          emoji: isAnimated ? '🎬' : '🎨',
          isAnimated
        }));
        sendJson(res, 200, { name, stickers, productId, isAnimated });
      } catch (e) {
        sendJson(res, 500, { error: e.message || '取得エラー', stickers: [] });
      }
      return;
    }

    // Activity version (meaningful actions only: messages, calls, announcements, etc.)
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'sync-version') {
      sendJson(res, 200, { version: data.activityVersion || 0 });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'activity-version') {
      sendJson(res, 200, { version: data.activityVersion || 0 });
      return;
    }

    // Announcements (お知らせ)
    if (!data.announcements) data.announcements = [];
    if (!data.announcementReads) data.announcementReads = {};
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'announcements') {
      const userId = url.searchParams.get('userId') || '';
      const groupIds = (url.searchParams.get('groupIds') || '').split(',').filter(Boolean);
      let list = [...data.announcements];
      if (userId) {
        const uid = String(userId);
        const groupSet = new Set(groupIds.map(String));
        list = list.filter(a => {
          if (a.type === 'global') return true;
          if (a.type === 'personal') {
            return (a.targetUserIds || []).some(id => String(id) === uid);
          }
          if (a.type === 'group') return groupSet.has(String(a.groupId));
          return false;
        });
      }
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      sendJson(res, 200, list);
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'announcements') {
      const body = await readBody(req);
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: body.title || '',
        body: body.body || '',
        type: body.type || 'global',
        targetUserIds: body.targetUserIds || [],
        groupId: body.groupId || null,
        authorId: body.authorId,
        authorName: body.authorName || '管理者',
        authorAvatar: body.authorAvatar || null,
        media: body.media || null,
        attachment: body.attachment || null,
        createdAt: Date.now(),
        comments: []
      };
      data.announcements.unshift(entry);
      if (data.announcements.length > 200) data.announcements = data.announcements.slice(0, 200);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true, id: entry.id });
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'announcements' && parts[2] && parts[3] === 'comments') {
      const body = await readBody(req);
      const ann = data.announcements.find(a => a.id === parts[2]);
      if (!ann) { sendJson(res, 404, { error: 'not_found' }); return; }
      if (!ann.comments) ann.comments = [];
      ann.comments.push({
        id: Date.now().toString(36),
        userId: body.userId,
        userName: body.userName || 'ユーザー',
        text: body.text || '',
        createdAt: Date.now()
      });
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'announcements' && parts[2] && parts[3] === 'comments' && parts[4]) {
      const ann = data.announcements.find(a => a.id === parts[2]);
      if (!ann) { sendJson(res, 404, { error: 'not_found' }); return; }
      const body = await readBody(req);
      const comment = (ann.comments || []).find(c => c.id === parts[4]);
      if (!comment || comment.userId !== body.userId) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      ann.comments = ann.comments.filter(c => c.id !== parts[4]);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'announcements' && parts[2]) {
      data.announcements = data.announcements.filter(a => a.id !== parts[2]);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'announcement-reads' && parts[2] && parts[3]) {
      const userId = parts[2];
      const annId = parts[3];
      if (!data.announcementReads[userId]) data.announcementReads[userId] = {};
      data.announcementReads[userId][annId] = Date.now();
      await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'announcement-reads' && parts[2]) {
      sendJson(res, 200, data.announcementReads[parts[2]] || {});
      return;
    }

    // Public feed posts (photo / video / notice)
    if (!data.posts) data.posts = [];
    const normalizePostEntry = (p) => {
      if (!p) return p;
      if (!p.likes || typeof p.likes !== 'object') p.likes = {};
      if (!p.dislikes || typeof p.dislikes !== 'object') p.dislikes = {};
      if (!Array.isArray(p.comments)) p.comments = [];
      return p;
    };
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'posts') {
      const list = data.posts.map(normalizePostEntry)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      sendJson(res, 200, list.slice(0, 300));
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'posts') {
      const body = await readBody(req);
      if (!body.authorId) {
        sendJson(res, 400, { error: 'author_required' });
        return;
      }
      const entry = normalizePostEntry({
        id: body.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        kind: body.kind || 'photo',
        text: body.text || '',
        authorId: String(body.authorId),
        authorName: body.authorName || 'ユーザー',
        authorAvatar: body.authorAvatar || null,
        media: body.media || null,
        attachment: body.attachment || null,
        createdAt: body.createdAt || Date.now(),
        likes: {},
        dislikes: {},
        comments: []
      });
      const exists = data.posts.find(p => p.id === entry.id);
      if (!exists) data.posts.unshift(entry);
      if (data.posts.length > 300) data.posts = data.posts.slice(0, 300);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true, id: entry.id });
      return;
    }
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'posts' && parts[2] && parts[3] === 'vote') {
      const body = await readBody(req);
      const userId = String(body.userId || '');
      const vote = body.vote;
      if (!userId) {
        sendJson(res, 400, { error: 'user_required' });
        return;
      }
      const post = data.posts.find(p => p.id === parts[2]);
      if (!post) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      normalizePostEntry(post);
      delete post.likes[userId];
      delete post.dislikes[userId];
      if (vote === 'up') post.likes[userId] = Date.now();
      else if (vote === 'down') post.dislikes[userId] = Date.now();
      await saveDataWithActivity(data);
      sendJson(res, 200, {
        ok: true,
        likes: Object.keys(post.likes).length,
        dislikes: Object.keys(post.dislikes).length
      });
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'posts' && parts[2] && parts[3] === 'comments') {
      const body = await readBody(req);
      const post = data.posts.find(p => p.id === parts[2]);
      if (!post) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      normalizePostEntry(post);
      post.comments.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
        userId: String(body.userId || ''),
        userName: body.userName || 'ユーザー',
        userAvatar: body.userAvatar || null,
        text: String(body.text || '').slice(0, 2000),
        createdAt: Date.now()
      });
      if (post.comments.length > 500) post.comments = post.comments.slice(-500);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'posts' && parts[2] && parts[3] === 'comments' && parts[4]) {
      const body = await readBody(req);
      const post = data.posts.find(p => p.id === parts[2]);
      if (!post) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const comment = (post.comments || []).find(c => c.id === parts[4]);
      if (!comment || String(comment.userId) !== String(body.userId || '')) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      post.comments = post.comments.filter(c => c.id !== parts[4]);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'posts' && parts[2]) {
      const body = await readBody(req);
      const post = data.posts.find(p => p.id === parts[2]);
      if (!post) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (String(post.authorId) !== String(body.userId || '')) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      data.posts = data.posts.filter(p => p.id !== parts[2]);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Friend requests (apply → accept → friendship without QR)
    if (!data.friendRequests) data.friendRequests = [];
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'friend-requests') {
      const userId = String(url.searchParams.get('userId') || '');
      if (!userId) {
        sendJson(res, 400, { error: 'user_required' });
        return;
      }
      const list = (data.friendRequests || []).filter(r =>
        r.status === 'pending' && (String(r.fromId) === userId || String(r.toId) === userId)
      );
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      sendJson(res, 200, list);
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'friend-requests') {
      const body = await readBody(req);
      const fromId = String(body.fromId || '');
      const toId = String(body.toId || '');
      if (!fromId || !toId || fromId === toId) {
        sendJson(res, 400, { error: 'invalid' });
        return;
      }
      const uf = (data.userFriendships && data.userFriendships[fromId]) || {};
      if (uf[toId]) {
        sendJson(res, 409, { error: 'already_friends' });
        return;
      }
      const existing = (data.friendRequests || []).find(r =>
        r.status === 'pending' &&
        ((String(r.fromId) === fromId && String(r.toId) === toId) ||
         (String(r.fromId) === toId && String(r.toId) === fromId))
      );
      if (existing) {
        sendJson(res, 200, { ok: true, id: existing.id, existing: true });
        return;
      }
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        fromId,
        fromName: body.fromName || 'ユーザー',
        fromAvatar: body.fromAvatar || null,
        toId,
        message: body.message || '',
        status: 'pending',
        createdAt: Date.now()
      };
      data.friendRequests.unshift(entry);
      if (data.friendRequests.length > 500) data.friendRequests = data.friendRequests.slice(0, 500);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true, id: entry.id });
      return;
    }
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'friend-requests' && parts[2]) {
      const body = await readBody(req);
      const reqId = parts[2];
      const userId = String(body.userId || '');
      const action = body.action || '';
      const fr = (data.friendRequests || []).find(r => r.id === reqId);
      if (!fr) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (String(fr.toId) !== userId) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (fr.status !== 'pending') {
        sendJson(res, 409, { error: 'already_handled' });
        return;
      }
      if (action === 'decline') {
        fr.status = 'declined';
        fr.handledAt = Date.now();
        await saveDataWithActivity(data);
        sendJson(res, 200, { ok: true, status: 'declined' });
        return;
      }
      if (action === 'accept') {
        fr.status = 'accepted';
        fr.handledAt = Date.now();
        createFriendshipOnServer(data, fr.fromId, fr.toId, Date.now());
        await saveDataWithActivity(data);
        sendJson(res, 200, { ok: true, status: 'accepted' });
        return;
      }
      sendJson(res, 400, { error: 'invalid_action' });
      return;
    }

    // Shared sticker packs (free share via bc-sticker:CODE)
    if (!data.sharedStickerPacks) data.sharedStickerPacks = {};
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'shared-sticker-packs') {
      const body = await readBody(req);
      const shareId = String(body.shareId || '').trim() ||
        (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 10);
      if (!body.stickers || !body.stickers.length) {
        sendJson(res, 400, { error: 'stickers_required' });
        return;
      }
      const entry = {
        shareId,
        packName: body.packName || '共有スタンプ',
        authorId: body.authorId || null,
        authorName: body.authorName || 'ユーザー',
        stickers: body.stickers.slice(0, 40),
        createdAt: Date.now()
      };
      data.sharedStickerPacks[shareId] = entry;
      const keys = Object.keys(data.sharedStickerPacks);
      if (keys.length > 200) {
        keys.sort((a, b) =>
          (data.sharedStickerPacks[a].createdAt || 0) - (data.sharedStickerPacks[b].createdAt || 0)
        );
        keys.slice(0, keys.length - 200).forEach(k => delete data.sharedStickerPacks[k]);
      }
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true, shareId, code: 'bc-sticker:' + shareId });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'shared-sticker-packs' && parts[2]) {
      const pack = data.sharedStickerPacks[parts[2]] || null;
      if (!pack) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, pack);
      return;
    }

    if (!data.feedback) data.feedback = [];
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'feedback') {
      const type = url.searchParams.get('type');
      let list = [...(data.feedback || [])];
      if (type) list = list.filter(f => f.type === type);
      list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      sendJson(res, 200, list);
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'feedback') {
      const body = await readBody(req);
      const entry = {
        ...body,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        receivedAt: Date.now()
      };
      data.feedback.push(entry);
      if (data.feedback.length > 500) data.feedback = data.feedback.slice(-200);
      await saveDataWithActivity(data);
      sendJson(res, 200, { ok: true, id: entry.id });
      return;
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'feedback' && parts[2]) {
      data.feedback = (data.feedback || []).filter(f => f.id !== parts[2]);
      await saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BlueChat sync server: http://0.0.0.0:${PORT}`);
  if (USE_UPSTASH) {
    console.log('Storage: Upstash Redis (persistent across restarts) —', UPSTASH_URL);
  } else {
    console.log('Storage: local file:', DATA_FILE);
  }
  console.log('Health check: GET /api/health');
});
