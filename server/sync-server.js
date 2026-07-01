/**
 * BlueChat 同期サーバー
 * 起動: node server/sync-server.js
 * デフォルト: http://0.0.0.0:8766
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8766;
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { conversations: {}, messages: {}, userConversations: {}, users: {}, friendships: {}, userFriendships: {}, readReceipts: {}, transfers: {}, callSignals: {}, feedback: [], cloudBackups: {}, presence: {}, announcements: [], announcementReads: {}, activityVersion: 0 };
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
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
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
      sendJson(res, 200, { ok: true, service: 'BlueChat Sync' });
      return;
    }

    const data = loadData();

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
        premium: u.premium || false
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

    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'friendships' && parts[2]) {
      const body = await readBody(req);
      const id1 = body.user1;
      const id2 = body.user2;
      if (!data.friendships) data.friendships = {};
      if (!data.userFriendships) data.userFriendships = {};
      data.friendships[parts[2]] = { user1: id1, user2: id2, createdAt: body.createdAt || Date.now() };
      [id1, id2].forEach(uid => {
        if (!uid) return;
        if (!data.userFriendships[uid]) data.userFriendships[uid] = {};
        data.userFriendships[uid][id1 === uid ? id2 : id1] = true;
      });
      saveDataWithActivity(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'user' && parts[2] && parts[3] === 'friendships') {
      const userId = parts[2];
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
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'cloud-backup' && parts[2]) {
      const body = await readBody(req);
      const userId = parts[2];
      data.cloudBackups[userId] = {
        backup: body.backup,
        updatedAt: body.updatedAt || Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
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
      const fetchText = (fetchUrl) => new Promise((resolve, reject) => {
        https.get(fetchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (resp) => {
          let d = '';
          resp.on('data', c => { d += c; });
          resp.on('end', () => resolve(d));
        }).on('error', reject);
      });
      const extractStickerIds = (html) => {
        const ids = new Set();
        const patterns = [
          /stickershop\/v1\/sticker\/(\d+)/g,
          /"stickerId"\s*:\s*(\d+)/g,
          /"sticker_id"\s*:\s*(\d+)/g,
          /stickerId=(\d+)/g
        ];
        patterns.forEach(p => {
          let m;
          while ((m = p.exec(html)) !== null) ids.add(m[1]);
        });
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextMatch) {
          try {
            const json = JSON.parse(nextMatch[1]);
            const str = JSON.stringify(json);
            const re = /"stickerId"\s*:\s*(\d+)/g;
            let m;
            while ((m = re.exec(str)) !== null) ids.add(m[1]);
          } catch (e) { /* ignore */ }
        }
        return [...ids];
      };
      const pageUrls = [
        `https://store.line.me/stickershop/product/${productId}/ja`,
        `https://store.line.me/stickershop/product/${productId}/en`,
        `https://store.line.me/stickershop/product/${productId}`
      ];
      try {
        let html = '';
        let ids = [];
        for (const pageUrl of pageUrls) {
          try {
            html = await fetchText(pageUrl);
            ids = extractStickerIds(html);
            if (ids.length) break;
          } catch (e) { /* try next */ }
        }
        if (!ids.length) {
          sendJson(res, 404, { error: 'スタンプIDを取得できませんでした。URLまたは商品IDを確認してください', stickers: [] });
          return;
        }
        const stickers = ids.slice(0, 40).map(id => ({
          id,
          url: `https://stickershop.line-scdn.net/stickershop/v1/sticker/${id}/android/sticker.png`,
          emoji: '🎨'
        }));
        const nameMatch = html.match(/<title>([^<]+)<\/title>/i);
        const name = nameMatch ? nameMatch[1].replace(/LINE STORE|スタンプ・絵文字ショップ/gi, '').trim() : ('LINE ' + productId);
        sendJson(res, 200, { name, stickers, productId });
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
        list = list.filter(a => {
          if (a.type === 'global') return true;
          if (a.type === 'personal') return (a.targetUserIds || []).includes(userId);
          if (a.type === 'group') return groupIds.includes(a.groupId);
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
      saveData(data);
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
  console.log('Health check: GET /api/health');
});
