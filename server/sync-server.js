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
    return { conversations: {}, messages: {}, userConversations: {}, users: {}, friendships: {}, userFriendships: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
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
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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
      data.conversations[convId] = { ...conv, id: convId };
      if (!data.userConversations) data.userConversations = {};
      (conv.members || []).forEach(memberId => {
        if (!data.userConversations[memberId]) data.userConversations[memberId] = {};
        data.userConversations[memberId][convId] = true;
      });
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'messages' && parts[2] && parts[3]) {
      const convId = parts[2];
      const msgId = parts[3];
      const msg = await readBody(req);
      if (!data.messages[convId]) data.messages[convId] = {};
      data.messages[convId][msgId] = { ...msg, id: msgId };
      saveData(data);
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
      data.users[parts[2]] = { ...user, id: parts[2] };
      saveData(data);
      sendJson(res, 200, { ok: true });
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
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'user' && parts[2] && parts[3] === 'friendships') {
      const userId = parts[2];
      const friends = (data.userFriendships && data.userFriendships[userId]) || {};
      sendJson(res, 200, Object.keys(friends));
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
