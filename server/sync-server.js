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
const SERVER_VERSION = '2026-07-03';

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

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { conversations: {}, messages: {}, userConversations: {}, users: {}, friendships: {}, userFriendships: {}, readReceipts: {}, transfers: {}, shortTransfers: {}, adminSessions: {}, callSignals: {}, feedback: [], cloudBackups: {}, presence: {}, announcements: [], announcementReads: {}, activityVersion: 0, titlePresets: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
}

function saveDataWithActivity(data) {
  data.activityVersion = (data.activityVersion || 0) + 1;
  saveData(data);
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
      try {
        const probe = path.join(path.dirname(DATA_FILE), '.bluechat-health-probe');
        fs.writeFileSync(probe, String(Date.now()));
        fs.unlinkSync(probe);
      } catch (e) {
        writable = false;
      }
      sendJson(res, 200, { ok: writable, service: 'BlueChat Sync', version: SERVER_VERSION, writable, dataFile: DATA_FILE });
      return;
    }

    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'login') {
      const body = await readBody(req);
      const role = verifyAdminLogin(body.email, body.password);
      if (!role) {
        sendJson(res, 401, { error: 'invalid' });
        return;
      }
      const data = loadData();
      const token = issueAdminSession(data, role);
      saveData(data);
      sendJson(res, 200, { ok: true, role, token });
      return;
    }

    const data = loadData();

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
      saveDataWithActivity(data);
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
      saveData(data);
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
        if (!data.userConversations[memberId]) data.userConversations[memberId] = {};
        data.userConversations[memberId][convId] = true;
      });
      if (isNewConv) saveDataWithActivity(data);
      else saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'messages' && parts[2] && parts[3]) {
      const convId = parts[2];
      const msgId = parts[3];
      if (data.messages[convId]) delete data.messages[convId][msgId];
      saveDataWithActivity(data);
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
      if (!data.messages[convId]) data.messages[convId] = {};
      const isNew = !data.messages[convId][msgId];
      data.messages[convId][msgId] = { ...msg, id: msgId };
      if (isNew) saveDataWithActivity(data);
      else saveData(data);
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
      const userId = parts[2];
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
      if (moderationChanged) saveDataWithActivity(data);
      else saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'users' && parts[2] === 'list') {
      const users = Object.values(data.users || {}).map(u => ({
        id: u.id,
        name: u.name,
        createdAt: u.createdAt,
        avatar: u.avatar || null,
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
      saveDataWithActivity(data);
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
      saveDataWithActivity(data);
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
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'reads' && parts[2]) {
      sendJson(res, 200, data.readReceipts[parts[2]] || {});
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
      saveData(data);
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
        saveData(data);
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
      saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'call' && parts[2] === 'signals' && parts[3]) {
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      const list = (data.callSignals[parts[3]] || []).filter(s => (s.timestamp || 0) > since);
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
      saveDataWithActivity(data);
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
      saveData(data);
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
      saveData(data);
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
      saveData(data);
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
        createdAt: Date.now(),
        comments: []
      };
      data.announcements.unshift(entry);
      if (data.announcements.length > 200) data.announcements = data.announcements.slice(0, 200);
      saveDataWithActivity(data);
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
      saveDataWithActivity(data);
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
      saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'announcements' && parts[2]) {
      data.announcements = data.announcements.filter(a => a.id !== parts[2]);
      saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'announcement-reads' && parts[2] && parts[3]) {
      const userId = parts[2];
      const annId = parts[3];
      if (!data.announcementReads[userId]) data.announcementReads[userId] = {};
      data.announcementReads[userId][annId] = Date.now();
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'announcement-reads' && parts[2]) {
      sendJson(res, 200, data.announcementReads[parts[2]] || {});
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
      saveDataWithActivity(data);
      sendJson(res, 200, { ok: true, id: entry.id });
      return;
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'feedback' && parts[2]) {
      data.feedback = (data.feedback || []).filter(f => f.id !== parts[2]);
      saveData(data);
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
  console.log('Data file:', DATA_FILE);
  console.log('Health check: GET /api/health');
});
