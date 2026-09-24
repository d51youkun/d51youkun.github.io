const UPSTREAM_ORIGIN = 'https://nfieyeke.gensparkspace.com';
const MEDIA_ORIGIN = 'https://bluechat-sync.by-youhei.workers.dev';
const CALL_SERVERS = [1, 2, 3].map((i) => `https://bluechat-call-${i}.by-youhei.workers.dev`);
const VIDEO_SERVERS = ['https://bluechat-video-1.by-youhei.workers.dev'];
const ADMIN_PASSWORD_SHA256 = '627841443a7a334c0bbafb4ad0d02e0f69f2e040bae6af9e45cc8d5683aa4dd9';
const TABLE_PREFIX = 'bluetalk:table:';
const SESSION_PREFIX = 'bluetalk:admin-session:';
const ADMIN_SESSION_TTL = 60 * 60 * 8;

function corsHeaders(origin) {
  const allowed = origin && (origin.endsWith('.workers.dev') || origin.endsWith('.pages.dev'))
    ? origin : 'https://bluetalk.by-youhei.workers.dev';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

function validTable(name) { return /^[A-Za-z0-9_-]{1,64}$/.test(name); }
function tableKey(name) { return TABLE_PREFIX + name; }

async function readTable(env, name) {
  const raw = await env.BLUETALK_KV.get(tableKey(name));
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

async function writeTable(env, name, rows) {
  await env.BLUETALK_KV.put(tableKey(name), JSON.stringify(rows));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function requestAdminToken(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : request.headers.get('X-Admin-Token') || '';
}

async function isAdmin(request, env) {
  const token = requestAdminToken(request);
  return Boolean(token && await env.BLUETALK_KV.get(SESSION_PREFIX + token));
}

async function handleBtMedia(request, env, url) {
  const store = /^(?:\/bt-media)(?:\/([A-Za-z0-9-]+))(?:\/(\d+)|\/complete)?/.exec(url.pathname);
  if (!store) return null;
  const id = store[1];
  if (!id) return json({ ok: false, error: 'missing id' }, 400, url ? undefined : undefined);
  if (request.method === 'PUT' && store[2] !== undefined) {
    const body = await request.json().catch(() => ({}));
    const data = String(body.data || '');
    if (!data) return json({ ok: false, error: 'missing chunk' }, 400, undefined);
    await env.BLUETALK_KV.put(`bluetalk:media:${id}:${store[2]}`, data);
    return json({ ok: true }, 200, undefined);
  }
  if (request.method === 'POST' && url.pathname.endsWith('/complete')) {
    const body = await request.json().catch(() => ({}));
    const total = Math.max(1, Number(body.totalChunks || 1));
    const mime = String(body.mimeType || 'application/octet-stream').slice(0, 120);
    await env.BLUETALK_KV.put(`bluetalk:media:${id}:meta`, JSON.stringify({ totalChunks: total, mimeType: mime, created_at: Date.now() }));
    return json({ ok: true, url: `/bt-media/${id}` }, 201, undefined);
  }
  if (request.method === 'GET' && !url.pathname.endsWith('/complete') && store[2] === undefined) {
    const metaRaw = await env.BLUETALK_KV.get(`bluetalk:media:${id}:meta`);
    if (!metaRaw) return new Response('Not found', { status: 404 });
    const meta = JSON.parse(metaRaw);
    const parts = [];
    for (let i = 0; i < meta.totalChunks; i++) {
      const c = await env.BLUETALK_KV.get(`bluetalk:media:${id}:${i}`);
      if (c === null) return new Response('Not found', { status: 404 });
      parts.push(c);
    }
    const data = parts.join('');
    const comma = data.indexOf(',');
    const encoded = comma >= 0 ? data.slice(comma + 1) : '';
    const bytes = data.slice(0, comma).includes(';base64') ? Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(encoded));
    return new Response(bytes, { headers: { 'Content-Type': meta.mimeType, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  return null;
}

async function cascadeDeleteUserData(env, id) {
  const [friendships, conversations, messages, stickers, calls, signals, appeals] = await Promise.all([
    readTable(env, 'friendships'), readTable(env, 'conversations'), readTable(env, 'messages'),
    readTable(env, 'stickers'), readTable(env, 'calls'), readTable(env, 'call_signals'), readTable(env, 'appeals')
  ]);
  const removedConversationIds = new Set(conversations.filter((c) => Array.isArray(c.member_ids) && c.member_ids.includes(id)).map((c) => c.id));
  await Promise.all([
    writeTable(env, 'friendships', friendships.filter((r) => r.user_id !== id && r.friend_id !== id)),
    writeTable(env, 'conversations', conversations.filter((c) => !removedConversationIds.has(c.id))),
    writeTable(env, 'messages', messages.filter((m) => m.sender_id !== id && !removedConversationIds.has(m.conversation_id))),
    writeTable(env, 'stickers', stickers.filter((s) => s.user_id !== id)),
    writeTable(env, 'calls', calls.filter((c) => c.caller_id !== id && c.callee_id !== id)),
    writeTable(env, 'call_signals', signals.filter((s) => s.from_user_id !== id && s.to_user_id !== id)),
    writeTable(env, 'appeals', appeals.filter((a) => a.user_id !== id))
  ]);
}

async function handleTables(request, env, url, origin) {
  const parts = url.pathname.replace(/^\/tables\/?/, '').split('/').filter(Boolean);
  const table = parts[0] || '';
  const id = parts[1] || '';
  if (!validTable(table)) return json({ error: 'invalid table' }, 400, origin);
  const rows = await readTable(env, table);
  if (request.method === 'GET' && !id) {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 1000);
    const page = Math.max(Number(url.searchParams.get('page') || 1), 1);
    const start = (page - 1) * limit;
    const visibleRows = table === 'users' ? rows.filter((item) => !item.banned) : rows;
    return json({ data: visibleRows.slice(start, start + limit), total: visibleRows.length, page, limit }, 200, origin);
  }
  if (request.method === 'GET' && id) {
    const row = rows.find((item) => String(item.id) === id);
    if (!row) return json({ error: 'not found' }, 404, origin);
    if (table === 'users' && (row.banned || row.deleted)) return json({ ...row, password: '' }, 200, origin);
    return json(row, 200, origin);
  }
  if (request.method === 'POST' && !id) {
    const body = await request.json().catch(() => ({}));
    const row = { ...body, id: body.id || crypto.randomUUID(), created_at: body.created_at || Date.now() };
    rows.push(row); await writeTable(env, table, rows);
    if (table === 'messages' && row.conversation_id) {
      const convs = await readTable(env, 'conversations');
      const ci = convs.findIndex((c) => String(c.id) === String(row.conversation_id));
      if (ci >= 0 && Array.isArray(convs[ci].hidden_for) && convs[ci].hidden_for.length) {
        convs[ci] = { ...convs[ci], hidden_for: [], updated_at: Date.now() };
        await writeTable(env, 'conversations', convs);
      }
    }
    return json(row, 201, origin);
  }
  if ((request.method === 'PATCH' || request.method === 'PUT') && id) {
    const index = rows.findIndex((item) => String(item.id) === id);
    if (index < 0) return json({ error: 'not found' }, 404, origin);
    const body = await request.json().catch(() => ({}));
    if (table === 'users' && !body.admin_override && (Object.prototype.hasOwnProperty.call(body, 'display_name') || Object.prototype.hasOwnProperty.call(body, 'username'))) {
      const last = Number(rows[index].profile_changed_at || 0);
      if (last && Date.now() - last < 30 * 24 * 60 * 60 * 1000) {
        return json({ error: 'profile changes are limited to once every 30 days', nextChangeAt: last + 30 * 24 * 60 * 60 * 1000 }, 429, origin);
      }
      body.profile_changed_at = Date.now();
    }
    rows[index] = { ...rows[index], ...body, id: rows[index].id, updated_at: Date.now() };
    await writeTable(env, table, rows); return json(rows[index], 200, origin);
  }
  if (request.method === 'DELETE' && id) {
    if (table === 'users') {
      const index = rows.findIndex((item) => String(item.id) === id);
      if (index >= 0) {
        rows[index] = { ...rows[index], deleted: true, banned: true, password: '', ban_reason: rows[index].ban_reason || 'self', deleted_at: Date.now() };
        await writeTable(env, 'users', rows);
        await cascadeDeleteUserData(env, id);
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    await writeTable(env, table, rows.filter((item) => String(item.id) !== id));
    if (table === 'conversations') {
      const messages = await readTable(env, 'messages');
      await writeTable(env, 'messages', messages.filter((m) => String(m.conversation_id) !== id));
    }
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  return json({ error: 'method not allowed' }, 405, origin);
}

async function handleAdmin(request, env, url, origin) {
  if (url.pathname === '/api/admin/login' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if ((await sha256(String(body.password || ''))) !== ADMIN_PASSWORD_SHA256) return json({ ok: false, error: 'invalid credentials' }, 401, origin);
    const token = crypto.randomUUID() + crypto.randomUUID().replaceAll('-', '');
    await env.BLUETALK_KV.put(SESSION_PREFIX + token, 'super', { expirationTtl: ADMIN_SESSION_TTL });
    return json({ ok: true, token, expiresIn: ADMIN_SESSION_TTL }, 200, origin);
  }
  if (!(await isAdmin(request, env))) return json({ ok: false, error: 'forbidden' }, 403, origin);
  if (url.pathname === '/api/admin/users' && request.method === 'GET') return json({ ok: true, users: (await readTable(env, 'users')).filter((item) => !item.deleted) }, 200, origin);
  if (url.pathname === '/api/admin/conversations' && request.method === 'GET') {
    const [conversations, messages, users] = await Promise.all([readTable(env, 'conversations'), readTable(env, 'messages'), readTable(env, 'users')]);
    return json({ ok: true, conversations, messages, users }, 200, origin);
  }
  const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (match && request.method === 'PATCH') {
    const rows = await readTable(env, 'users'); const index = rows.findIndex((item) => String(item.id) === match[1]);
    if (index < 0) return json({ ok: false, error: 'not found' }, 404, origin);
    rows[index] = { ...rows[index], ...(await request.json().catch(() => ({}))), id: rows[index].id, updated_at: Date.now() };
    await writeTable(env, 'users', rows); return json({ ok: true, user: rows[index] }, 200, origin);
  }
  if (url.pathname === '/api/admin/appeals' && request.method === 'GET') return json({ ok: true, appeals: await readTable(env, 'appeals') }, 200, origin);
  const appealMatch = url.pathname.match(/^\/api\/admin\/appeals\/([^/]+)$/);
  if (appealMatch && request.method === 'PATCH') {
    const rows = await readTable(env, 'appeals'); const index = rows.findIndex((item) => String(item.id) === appealMatch[1]);
    if (index < 0) return json({ ok: false, error: 'not found' }, 404, origin);
    rows[index] = { ...rows[index], ...(await request.json().catch(() => ({}))), id: rows[index].id, updated_at: Date.now() };
    await writeTable(env, 'appeals', rows); return json({ ok: true, appeal: rows[index] }, 200, origin);
  }
  const userDelMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userDelMatch && request.method === 'DELETE') {
    const rows = await readTable(env, 'users'); const index = rows.findIndex((item) => String(item.id) === userDelMatch[1]);
    if (index < 0) return json({ ok: false, error: 'not found' }, 404, origin);
    rows[index] = { ...rows[index], deleted: true, banned: true, password: '', ban_reason: rows[index].ban_reason || 'violation', deleted_at: Date.now() };
    await writeTable(env, 'users', rows);
    await cascadeDeleteUserData(env, userDelMatch[1]);
    return json({ ok: true }, 200, origin);
  }
  return json({ ok: false, error: 'not found' }, 404, origin);
}

async function handleAccountStatus(request, env, url, origin) {
  const match = url.pathname.match(/^\/api\/account-status\/([A-Za-z0-9-]+)$/);
  if (!match || request.method !== 'GET') return null;
  const users = await readTable(env, 'users');
  const user = users.find((item) => String(item.id) === match[1]);
  if (!user) return json({ ok: false, error: 'not found' }, 404, origin);
  return json({
    ok: true,
    banned: Boolean(user.banned || user.deleted),
    deleted: Boolean(user.deleted),
    selfDeleted: Boolean(user.deleted && user.ban_reason === 'self'),
    reason: String(user.ban_reason || ''),
    message: String(user.ban_message || ''),
    appealMessage: String(user.ban_appeal_message || ''),
    updatedAt: Number(user.updated_at || 0),
  }, 200, origin);
}

async function handleTurnCredentials(request, env, url, origin) {
  if (url.pathname !== '/api/turn-credentials' || request.method !== 'GET') return null;
  const endpoint = String(env.METERED_TURN_ENDPOINT || '').trim();
  const apiKey = String(env.METERED_TURN_API_KEY || '').trim();
  // Metered Open Relay publishes a shared, card-free fallback for testing.
  // Prefer account-scoped short-lived credentials whenever the secrets exist.
  if (!endpoint || !apiKey) return json({
    ok: true,
    configured: false,
    shared: true,
    iceServers: [
      { urls: 'stun:openrelay.metered.ca:80' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  }, 200, origin);
  let upstream;
  try {
    upstream = new URL(endpoint);
    if (upstream.protocol !== 'https:' || !upstream.hostname.endsWith('.metered.live')) {
      return json({ ok: false, error: 'TURN endpoint is invalid' }, 500, origin);
    }
    upstream.searchParams.set('apiKey', apiKey);
  } catch {
    return json({ ok: false, error: 'TURN endpoint is invalid' }, 500, origin);
  }
  try {
    const response = await fetch(upstream.toString(), { headers: { Accept: 'application/json' } });
    if (!response.ok) return json({ ok: false, error: 'TURN credentials are unavailable' }, 502, origin);
    const iceServers = await response.json();
    if (!Array.isArray(iceServers)) return json({ ok: false, error: 'TURN response is invalid' }, 502, origin);
    const safeServers = iceServers
      .filter((item) => item && typeof item === 'object' && item.urls)
      .slice(0, 16)
      .map((item) => ({ urls: item.urls, username: String(item.username || ''), credential: String(item.credential || '') }));
    return json({ ok: true, configured: true, iceServers: safeServers }, 200, origin);
  } catch {
    return json({ ok: false, error: 'TURN credentials are unavailable' }, 502, origin);
  }
}

function pwaManifest() {
  return new Response(JSON.stringify({ name: 'BlueTalk', short_name: 'BlueTalk', start_url: '/index.html', display: 'standalone', background_color: '#fff', theme_color: '#1877f2', icons: [{ src: 'https://api.iconify.design/ic:baseline-chat-bubble.svg?color=%231877f2', sizes: 'any', type: 'image/svg+xml' }] }), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
}

function serviceWorker() {
  return new Response("self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>cs[0]?.focus()||clients.openWindow('/app.html')))});", { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' } });
}

async function handleMedia(request, env, url, origin) {
  if (url.pathname === '/api/media' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const data = String(body.data || '');
    const mimeType = String(body.mimeType || 'application/octet-stream').slice(0, 120);
    if (!data.startsWith('data:') || data.length > 12 * 1024 * 1024) return json({ ok: false, error: 'file is missing or too large (8MB max)' }, 413, origin);
    const uploadId = crypto.randomUUID();
    const chunkSize = 180000;
    const totalChunks = Math.ceil(data.length / chunkSize);
    for (let i = 0; i < totalChunks; i++) {
      const r = await fetch(`${MEDIA_ORIGIN}/api/media/chunk/${uploadId}/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://bluetalk.by-youhei.workers.dev' }, body: JSON.stringify({ data: data.slice(i * chunkSize, (i + 1) * chunkSize) }) });
      if (!r.ok) return json({ ok: false, error: 'media chunk upload failed' }, 502, origin);
    }
    const done = await fetch(`${MEDIA_ORIGIN}/api/media/chunk/${uploadId}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://bluetalk.by-youhei.workers.dev' }, body: JSON.stringify({ totalChunks, mimeType }) });
    if (!done.ok) return json({ ok: false, error: 'media upload could not be completed' }, 502, origin);
    return json({ ok: true, uploadId, url: `/media/${uploadId}`, name: String(body.name || 'file').slice(0, 160), mimeType }, 201, origin);
  }
  const mediaMatch = url.pathname.match(/^\/media\/([A-Za-z0-9-]+)$/);
  if (mediaMatch && request.method === 'GET') {
    const upstream = await fetch(`${MEDIA_ORIGIN}/api/media/blob/${mediaMatch[1]}`, { headers: { Origin: 'https://bluetalk.by-youhei.workers.dev' } });
    if (!upstream.ok) return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
    const payload = await upstream.json().catch(() => null);
    const data = String(payload?.data || '');
    const mimeType = payload?.mimeType || 'application/octet-stream';
    if (!data.startsWith('data:')) return new Response('Invalid media', { status: 502, headers: corsHeaders(origin) });
    const comma = data.indexOf(',');
    const encoded = comma >= 0 ? data.slice(comma + 1) : '';
    const bytes = data.slice(0, comma).includes(';base64')
      ? Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(encoded));
    return new Response(bytes, { headers: { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=31536000, immutable', ...corsHeaders(origin) } });
  }
  return null;
}

async function handleLineStickers(request, env, url, origin) {
  const m = url.pathname.match(/^\/api\/line-stickers\/(\d{6,12})$/);
  if (!m) return null;
  const pid = m[1];
  const cacheKey = `bluetalk:linepack:${pid}`;
  const cached = await env.BLUETALK_KV.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept-Language': 'ja,en;q=0.8' };
  let html = '';
  try {
    const r = await fetch(`https://store.line.me/stickershop/product/${pid}/ja`, { headers });
    if (r.ok) html = await r.text();
  } catch {}
  if (!html) {
    try {
      const r = await fetch(`https://store.line.me/stickershop/product/${pid}/en`, { headers });
      if (r.ok) html = await r.text();
    } catch {}
  }
  if (!html) return json({ ok: false, error: 'sticker pack not found' }, 404, origin);
  const t = html.match(/<title>([^<]*?)\s*[-|]\s*LINE/);
  const title = t ? t[1].replace(/&amp;/g, '&').slice(0, 60) : 'LINEスタンプ';
  const ids = []; const seen = new Set();
  const re = /stickershop\.line-scdn\.net\/stickershop\/v1\/sticker\/(\d+)\//g;
  let mm;
  while ((mm = re.exec(html)) !== null) {
    if (!seen.has(mm[1])) { seen.add(mm[1]); ids.push(mm[1]); }
    if (ids.length >= 60) break;
  }
  if (!ids.length) return json({ ok: false, error: 'no stickers found' }, 404, origin);
  const stickers = ids.map((sid) => `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sid}/android/sticker.png?v=1`);
  const payload = { ok: true, title, productId: pid, stickers };
  await env.BLUETALK_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 86400 });
  return json(payload, 200, origin);
}

async function handleCallGateway(request, url, origin) {
  const signalMatch = url.pathname.match(/^\/api\/call-gateway\/signals?\/?([^/]*)$/);
  if (!signalMatch) return null;
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const mode = String(body.mode || url.searchParams.get('mode') || 'voice') === 'video' ? 'video' : 'voice';
  const key = String(body.call_id || url.searchParams.get('call_id') || body.to || signalMatch[1] || '0');
  const servers = mode === 'video' ? VIDEO_SERVERS : CALL_SERVERS;
  let hash = 0; for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const target = servers[hash % servers.length];
  if (request.method === 'POST' && url.pathname === '/api/call-gateway/signal') {
    const upstream = await fetch(`${target}/api/call/signal`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://bluetalk.by-youhei.workers.dev' }, body: JSON.stringify({
      to: body.to, from: body.from, call_id: body.call_id, type: body.signal_type, sdp: body.payload, timestamp: Date.now()
    }) });
    return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
  }
  if (request.method === 'GET' && signalMatch[1]) {
    const upstream = await fetch(`${target}/api/call/signals/${encodeURIComponent(signalMatch[1])}${url.search}`, { headers: { Origin: 'https://bluetalk.by-youhei.workers.dev' } });
    return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
  }
  return json({ ok: false, error: 'method not allowed' }, 405, origin);
}

function adminPage() {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BlueTalk 管理画面</title><style>body{margin:0;background:#f2f6fb;color:#24344d;font-family:system-ui,-apple-system,sans-serif}.wrap{max-width:980px;margin:0 auto;padding:24px}.card{background:#fff;border-radius:18px;padding:20px;margin:14px 0;box-shadow:0 8px 28px #2341  }.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #e5edf7;padding:12px 0}button{border:0;border-radius:10px;padding:9px 13px;background:#1877f2;color:#fff;font-weight:700;cursor:pointer}button.gray{background:#e8eef7;color:#24344d}input{padding:10px;border:1px solid #c7d9ee;border-radius:9px}small{color:#687b96}.danger{color:#a52828}#btConvModal{position:fixed;inset:0;z-index:9999;background:rgba(10,16,28,.72);display:flex;align-items:center;justify-content:center;padding:14px}.bt-cm-card{background:#fff;border-radius:16px;width:min(560px,96vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.45)}.bt-cm-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 16px;background:#1877f2;color:#fff}.bt-cm-head button{background:#fff!important;color:#1877f2!important;border:0;border-radius:8px;padding:7px 12px;cursor:pointer;font-weight:700}.bt-cm-msgs{overflow:auto;padding:14px;background:#eef3fa;flex:1}.bt-cm-row{display:flex;gap:8px;margin-bottom:10px;align-items:flex-end}.bt-cm-row.bt-me{flex-direction:row-reverse}.bt-cm-ava{width:30px;height:30px;border-radius:50%;flex:none}.bt-cm-col{max-width:78%;display:flex;flex-direction:column;gap:2px}.bt-cm-row.bt-me .bt-cm-col{align-items:flex-end}.bt-cm-name{font-size:11px;color:#5b6b81}.bt-cm-bubble{background:#fff;color:#24344d;border-radius:12px;padding:8px 12px;font-size:13.5px;line-height:1.5;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.08)}.bt-cm-row.bt-me .bt-cm-bubble{background:#1877f2;color:#fff}.bt-cm-time{font-size:10px;color:#8296ad}.bt-cm-media{max-width:220px;max-height:200px;border-radius:8px;display:block}.bt-cm-empty{color:#5b6b81}</style></head><body><main class="wrap"><div id="root"></div></main><script>
  const root=document.getElementById('root'), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function login(){root.innerHTML='<section class="card"><h1>BlueTalk 管理画面</h1><p>管理者コードを入力してください。</p><input id="pw" type="password" placeholder="管理者コード"><button id="go">ログイン</button><p id="msg" class="danger"></p></section>';document.getElementById('go').onclick=async()=>{const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});const j=await r.json();if(!r.ok){document.getElementById('msg').textContent='認証に失敗しました';return}localStorage.setItem('bluetalk_admin_token',j.token);dashboard()}}
  async function dashboard(){const t=localStorage.getItem('bluetalk_admin_token');if(!t)return login();const h={Authorization:'Bearer '+t};const [ur,cr,ar]=await Promise.all([fetch('/api/admin/users',{headers:h}),fetch('/api/admin/conversations',{headers:h}),fetch('/api/admin/appeals',{headers:h}).catch(function(){return {ok:false}})]);if(!ur.ok||!cr.ok||!ar.ok){localStorage.removeItem('bluetalk_admin_token');return login()}const u=(await ur.json()).users||[], c=await cr.json(), ap=ar.ok?((await ar.json()).appeals||[]):[], names=Object.fromEntries(u.map(x=>[x.id,x.display_name||x.username]));root.innerHTML='<h1>BlueTalk 管理画面</h1><p><button id="logout" class="gray">管理者ログアウト</button>　<small>会話監視は利用規約に基づく安全・規約違反調査のために使用してください。</small></p><section class="card"><h2>アカウント管理・Ban情報</h2><p><small>Ban時は理由と利用者への案内文を保存します。解除時も誤Banについての案内文を登録できます。</small></p><div id="users"></div></section><section class="card"><h2>会話監視</h2><div id="convs"></div></section><section class="card"><h2>誤Ban申し立て（利用者から管理者へ）</h2><div id="appeals"></div></section>';document.getElementById('logout').onclick=()=>{localStorage.removeItem('bluetalk_admin_token');login()};document.getElementById('users').innerHTML=u.map(x=>'<div class="row"><b>'+esc(x.display_name)+'</b><span>@'+esc(x.username)+'</span>'+(x.verified?' <span style="color:#d7a600;font-size:18px">✓</span>':'')+(x.title?' <span style="color:#b8860b">'+esc(x.title)+'</span>':'')+(x.banned?' <span class="danger">停止中</span>':'')+'<button data-act="verify" data-id="'+esc(x.id)+'">'+(x.verified?'認証解除':'Premium認証')+'</button><button data-act="ban" data-id="'+esc(x.id)+'">'+(x.banned?'Ban解除':'Ban')+'</button><input data-title="'+esc(x.id)+'" placeholder="ゴールド称号" value="'+esc(x.title||'')+'"><button data-act="title" data-id="'+esc(x.id)+'">称号を保存</button>'+(x.banned?'<small>理由: '+esc(x.ban_reason||'未登録')+'</small>':'')+'<button data-act="pass" data-id="'+esc(x.id)+'">パスワード変更</button><button data-act="del" data-id="'+esc(x.id)+'">強制削除</button></div>').join('')||'アカウントはありません';document.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{const id=b.dataset.id, one=u.find(x=>x.id===id);let body;if(b.dataset.act==='verify'){body={verified:!one.verified}}else if(b.dataset.act==='ban'){if(one.banned){const appeal=prompt('誤Ban・解除に関する利用者へのメッセージ（任意）',one.ban_appeal_message||'');if(appeal===null)return;body={banned:false,ban_appeal_message:appeal}}else{const reason=prompt('Ban理由（利用規約のどの違反か）','');if(reason===null||!reason.trim())return;const message=prompt('利用者に表示する詳しい案内文（任意）','');if(message===null)return;body={banned:true,ban_reason:reason,ban_message:message,ban_appeal_message:''}}}else if(b.dataset.act==='pass'){const np=prompt('このアカウントの新しいパスワードを入力してください（パスワードを強制変更）','');if(!np||!np.trim())return;body={password:np}}else if(b.dataset.act==='del'){if(!confirm('このアカウントを強制削除しますか？利用者の全データ（会話・メッセージ等）が削除され、元に戻せません。'))return;await fetch('/api/admin/users/'+encodeURIComponent(id),{method:'DELETE',headers:h});dashboard();return}else{body={title:document.querySelector('[data-title="'+CSS.escape(id)+'"]').value,admin_override:true}}await fetch('/api/admin/users/'+encodeURIComponent(id),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify(body)});dashboard()});const by={};(c.messages||[]).forEach(m=>(by[m.conversation_id]??=[]).push('<b>'+esc(names[m.sender_id]||m.sender_id)+'</b>: '+esc(m.content||'[スタンプ]')));document.getElementById('convs').innerHTML=(c.conversations||[]).map(x=>{const ids=(x.member_ids||[]);const title=x.type==='group'?('👥 '+(x.name||'グループ')+'（'+ids.length+'名・'+ids.map(i=>names[i]||i).slice(0,6).join('、')+'）'):ids.map(i=>names[i]||i).join(' ⇔ ');const ms=(c.messages||[]).filter(m=>m.conversation_id===x.id).sort((a,b)=>(a.sent_at||a.created_at||0)-(b.sent_at||b.created_at||0));const last=ms.length?ms[ms.length-1]:null;const when=last?new Date(last.sent_at||last.created_at||0).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';return '<div class="row"><b>'+esc(title)+'</b><small>'+ms.length+'件'+(when?'・最終 '+when:'')+'</small><button data-conv="'+esc(x.id)+'">トークを見る</button></div>'}).join('')||'会話はありません';window.__btMon={convs:c.conversations||[],msgs:c.messages||[],names:names,users:u};document.querySelectorAll('[data-conv]').forEach(b=>b.onclick=()=>openConv(b.dataset.conv));document.getElementById('appeals').innerHTML=ap.slice().reverse().map(x=>'<div class="row"><b>'+esc(names[x.user_id]||x.user_id)+'</b><span style="display:block;width:100%">'+esc(x.message)+'</span>'+(x.status==='resolved'?'<small>対応済み</small>':'')+'<button data-ap="resolve" data-aid="'+esc(x.id)+'">対応済みにする</button><button data-ap="reply" data-uid="'+esc(x.user_id)+'">返信する</button></div>').join('')||'申し立てはありません';document.querySelectorAll('[data-ap]').forEach(b=>b.onclick=async()=>{if(b.dataset.ap==='resolve'){await fetch('/api/admin/appeals/'+encodeURIComponent(b.dataset.aid),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({status:'resolved'})})}else{const msg=prompt('返信内容（利用者の削除通知画面に表示されます）','');if(msg===null)return;await fetch('/api/admin/users/'+encodeURIComponent(b.dataset.uid),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({ban_appeal_message:msg,admin_override:true})})}dashboard()})}
  function openConv(cid){const M=window.__btMon;if(!M)return;const cv=M.convs.filter(x=>x.id===cid)[0];if(!cv)return;const ids=cv.member_ids||[];const title=cv.type==='group'?('👥 '+(cv.name||'グループ')+'（'+ids.length+'名）'):ids.map(i=>M.names[i]||i).join(' ⇔ ');const ms=M.msgs.filter(m=>m.conversation_id===cid).sort((a,b)=>(a.sent_at||a.created_at||0)-(b.sent_at||b.created_at||0));const ava=(uid)=>{const uu=(M.users||[]).filter(x=>x.id===uid)[0];return (uu&&uu.avatar_url)||'https://api.dicebear.com/7.x/thumbs/svg?seed='+encodeURIComponent(uid)};let h='<div class="bt-cm-head"><b>'+esc(title)+'</b><button id="btCmClose">閉じる</button></div><div class="bt-cm-msgs">';if(!ms.length)h+='<p class="bt-cm-empty">メッセージはまだありません</p>';ms.forEach(m=>{const left=cv.type==='group'||m.sender_id===ids[0];const name=M.names[m.sender_id]||m.sender_id;const t=(m.sent_at||m.created_at)?new Date(m.sent_at||m.created_at).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';let body='';if(m.type==='sticker'&&m.sticker_url)body='<img class="bt-cm-media" src="'+esc(m.sticker_url)+'">';else if(m.type==='image'&&m.media_data)body='<img class="bt-cm-media" src="'+esc(m.media_data)+'">';else if(m.type==='video'&&m.media_data)body='<video class="bt-cm-media" src="'+esc(m.media_data)+'" controls></video>';else if(m.type==='file'&&m.media_data)body='<a href="'+esc(m.media_data)+'" download="'+esc(m.file_name||'file')+'">📎 '+esc(m.file_name||'ファイル')+'</a>';else if(m.type==='call')body='<i>📞 通話</i>';else body=esc(m.content||'');if(!body&&m.media_data)body='<img class="bt-cm-media" src="'+esc(m.media_data)+'">';h+='<div class="bt-cm-row '+(left?'':'bt-me')+'">'+(left?'<img class="bt-cm-ava" src="'+esc(ava(m.sender_id))+'">':'')+'<div class="bt-cm-col"><span class="bt-cm-name">'+esc(name)+'</span><span class="bt-cm-bubble">'+body+'</span><span class="bt-cm-time">'+esc(t)+'</span></div></div>'});h+='</div>';let mo=document.getElementById('btConvModal');if(mo)mo.remove();mo=document.createElement('div');mo.id='btConvModal';mo.innerHTML='<div class="bt-cm-card">'+h+'</div>';mo.addEventListener('click',e=>{if(e.target===mo)mo.remove()});document.body.appendChild(mo);document.getElementById('btCmClose').onclick=()=>mo.remove()}
if(localStorage.getItem('bluetalk_admin_token'))dashboard();else login();
  </script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const APP_ENHANCEMENTS = `<script>(function(){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let keys='';let last=0;function adminTrigger(e){const now=Date.now();if(now-last>4000)keys='';last=now;keys+=(e.key||'');if(keys.length>40)keys=keys.slice(-40);if(keys.endsWith('d51-498go'))showAdminLogin()}
  function showAdminLogin(){location.href='/admin.html'}
  function applyBadges(){if(typeof allUsers==='undefined'||!allUsers.length)return;const byName=Object.fromEntries(allUsers.map(u=>[u.display_name,u]));document.querySelectorAll('.name,#profileName').forEach(el=>{if(el.dataset.btBadge)return;const u=byName[el.textContent.trim()];if(!u||(!u.verified&&!u.title))return;el.dataset.btBadge='1';if(u.verified){const v=document.createElement('span');v.textContent='\u2713';v.title='BlueTalkPremium';v.style='display:inline-block;margin-left:5px;color:#d7a600;font-weight:900';el.appendChild(v)}if(u.title){const t=document.createElement('span');t.textContent=' '+u.title;t.style='margin-left:5px;color:#b8860b;font-weight:700';el.appendChild(t)}})}
  function bindAdminName(){const n=document.querySelector('#profileName');if(!n||n.dataset.btAdminClick)return;n.dataset.btAdminClick='1';n.style.cursor='pointer';n.title='管理者メニュー';n.onclick=()=>{if(localStorage.getItem('bluetalk_admin_token'))location.href='/admin.html';else showAdminLogin()}}
  function repairImages(){document.querySelectorAll('img').forEach(img=>{if(img.dataset.btFallback)return;img.dataset.btFallback='1';img.addEventListener('error',()=>{if(img.dataset.btBroken)return;img.dataset.btBroken='1';img.src='https://api.dicebear.com/7.x/thumbs/svg?seed=bluetalk-fallback'})})}
  new MutationObserver(()=>{repairImages();applyBadges();bindAdminName()}).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('keydown',adminTrigger);
  document.addEventListener('DOMContentLoaded',()=>{repairImages();applyBadges();bindAdminName();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{})});
})();
</script>`;

const EARLY_THEME = `<script>try{var q=new URLSearchParams(location.search).get('theme');if(q==='dark'||q==='light')localStorage.setItem('bt_dark_mode',q==='dark'?'1':'0');if(localStorage.getItem('bt_dark_mode')===null)localStorage.setItem('bt_dark_mode','1');document.documentElement.setAttribute('data-bt-theme',localStorage.getItem('bt_dark_mode')==='1'?'dark':'light')}catch(e){}</script>`;
const DARK_CSS = `<style>
html[data-bt-theme="dark"]{--bt-bg:#05070c;--bt-white:#0e1421;--bt-text:#ffffff;--bt-text-light:#d5dee9;--bt-border:#42536a;--bt-bubble-me:#1a3a5f;--bt-bubble-other:#141d2b;--bt-primary-light:#1c3350;color-scheme:dark}
html[data-bt-theme="dark"] body,html[data-bt-theme="dark"] .app-shell{background:var(--bt-bg)!important;color:#fff!important}
html[data-bt-theme="dark"] .nav-rail,html[data-bt-theme="dark"] .list-panel,html[data-bt-theme="dark"] .main-panel,html[data-bt-theme="dark"] .chat-room{background:var(--bt-bg)!important;color:#fff!important}
html[data-bt-theme="dark"] button{background:#000!important;color:#fff!important;border:2px solid #fff!important;box-shadow:none!important;text-shadow:none!important}
html[data-bt-theme="dark"] button:hover{background:#1d1d1d!important;color:#fff!important}
html[data-bt-theme="dark"] button:disabled{opacity:.5}
html[data-bt-theme="dark"] .nav-rail .brand,html[data-bt-theme="dark"] .nav-item.active{background:#000!important;color:#fff!important;border:2px solid #fff!important;box-shadow:none!important}
html[data-bt-theme="dark"] .chat-header,html[data-bt-theme="dark"] .chat-input-bar,html[data-bt-theme="dark"] .profile-card,html[data-bt-theme="dark"] .panel-header{background:var(--bt-white)!important;color:#fff!important;border-color:var(--bt-border)!important}
html[data-bt-theme="dark"] input,html[data-bt-theme="dark"] textarea{background:#05070c!important;color:#fff!important;border:2px solid var(--bt-border)!important}
html[data-bt-theme="dark"] input::placeholder,html[data-bt-theme="dark"] textarea::placeholder{color:#8fa0b5!important}
html[data-bt-theme="dark"] .modal-backdrop{background:rgba(0,0,0,.78)!important}
html[data-bt-theme="dark"] .modal-box{background:var(--bt-white)!important;color:#fff!important;border:2px solid var(--bt-border)!important}
html[data-bt-theme="dark"] .msg-row .msg-bubble{background:var(--bt-bubble-other)!important;color:#fff!important}
html[data-bt-theme="dark"] .msg-row.me .msg-bubble{background:var(--bt-bubble-me)!important;color:#fff!important}
html[data-bt-theme="dark"] .msg-file,html[data-bt-theme="dark"] .msg-call-log,html[data-bt-theme="dark"] .msg-media{background:#10161f!important;color:#fff!important;border:2px solid var(--bt-border)!important}
html[data-bt-theme="dark"] .msg-meta,html[data-bt-theme="dark"] .msg-time{color:#d5dee9!important}
html[data-bt-theme="dark"] .name{color:#fff!important}
html[data-bt-theme="dark"] .chat-row .preview,html[data-bt-theme="dark"] .status,html[data-bt-theme="dark"] .uid,html[data-bt-theme="dark"] .hint,html[data-bt-theme="dark"] small,html[data-bt-theme="dark"] .empty-state,html[data-bt-theme="dark"] .call-status{color:#d5dee9!important}
html[data-bt-theme="dark"] .chat-row,html[data-bt-theme="dark"] .friend-row{background:transparent!important;color:#fff!important}
html[data-bt-theme="dark"] .chat-row:hover,html[data-bt-theme="dark"] .friend-row:hover{background:#111a27!important}
html[data-bt-theme="dark"] .chat-row.active{background:#16233a!important}
html[data-bt-theme="dark"] .call-overlay{background:rgba(4,7,12,.97)!important;color:#fff!important}
html[data-bt-theme="dark"] .incoming-call-toast{background:var(--bt-white)!important;color:#fff!important;border:2px solid var(--bt-border)!important}
html[data-bt-theme="dark"] #toastMsg,html[data-bt-theme="dark"] .toast{background:#10161f!important;color:#fff!important;border:2px solid var(--bt-border)!important}
html[data-bt-theme="dark"] .sticker-item,html[data-bt-theme="dark"] .sticker-card,html[data-bt-theme="dark"] .add-sticker-card{background:#10161f!important;color:#fff!important;border:2px solid var(--bt-border)!important;box-shadow:none!important}
html[data-bt-theme="dark"] .sticker-picker{background:var(--bt-white)!important;color:#fff!important}
html[data-bt-theme="dark"] .auth-page{background:var(--bt-bg)!important}
html[data-bt-theme="dark"] .auth-card{background:var(--bt-white)!important;color:#fff!important;border:2px solid var(--bt-border)!important;box-shadow:0 10px 40px #000a!important}
html[data-bt-theme="dark"] .auth-tabs button{color:#d5dee9!important}
html[data-bt-theme="dark"] .auth-tabs button.active{background:#000!important;color:#fff!important;border:2px solid #fff!important}
html[data-bt-theme="dark"] .close-x,html[data-bt-theme="dark"] .nav-item{color:#d5dee9!important}
html[data-bt-theme="dark"] .switch-slider{background:#42536a!important}
html[data-bt-theme="dark"] .chat-input-bar{position:relative;z-index:60;padding-bottom:calc(10px + env(safe-area-inset-bottom))!important}
html[data-bt-theme="dark"] .nav-rail,html[data-bt-theme="dark"] .app-shell nav{padding-bottom:env(safe-area-inset-bottom)!important}
html[data-bt-theme="dark"] .round-btn,html[data-bt-theme="dark"] .mini-btn{pointer-events:auto!important;touch-action:manipulation}
html[data-bt-theme="dark"] ::-webkit-scrollbar{width:8px;height:8px}
html[data-bt-theme="dark"] ::-webkit-scrollbar-thumb{background:#42536a;border-radius:8px}
html[data-bt-theme="dark"] ::-webkit-scrollbar-track{background:transparent}
</style>`;
const MEDIA_SHIM = `<script>(function(){
  if(window.__btMediaShim)return;window.__btMediaShim=1;
  var raw=window.fetch.bind(window);
  window.fetch=async function(input,init){
    try{
      var url=typeof input==='string'?input:(input&&input.url)||'';
      if(url.indexOf('/tables/messages')>=0&&init&&init.method==='POST'&&init.body){
        var b=JSON.parse(init.body);
        var d=String(b.media_data||'');
        if(d.indexOf('data:')===0&&d.length>150000){
          var id=(crypto.randomUUID?crypto.randomUUID():'m'+Date.now()+Math.random().toString(16).slice(2));
          var size=150000,total=Math.ceil(d.length/size),mime=(d.slice(5,d.indexOf(';'))||'application/octet-stream');
          for(var i=0;i<total;i++){var r=await raw('/bt-media/'+id+'/'+i,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d.slice(i*size,(i+1)*size)})});if(!r.ok)throw new Error('chunk failed')}
          var c=await raw('/bt-media/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({totalChunks:total,mimeType:mime})});
          if(!c.ok)throw new Error('complete failed');
          b.media_data='/bt-media/'+id;
          init={...init,body:JSON.stringify(b)};
        }
      }
    }catch(e){console.warn('[bt] media upload failed',e)}
    return raw(input,init);
  };
  function closePicker(){var p=document.getElementById('stickerPicker');if(p&&p.classList.contains('open'))p.classList.remove('open')}
  document.addEventListener('click',function(e){
    if(!e.target.closest('#stickerPicker')&&!e.target.closest('#openStickerPickerBtn'))closePicker();
  },true);
})();</script>`;
const CALL_SCRIPT = `<script>(function(){
  if(window.__btCall)return;window.__btCall=1;
  var VOICE=['https://bluechat-call-1.by-youhei.workers.dev','https://bluechat-call-2.by-youhei.workers.dev','https://bluechat-call-3.by-youhei.workers.dev'];
  var VIDEO=['https://bluechat-video-1.by-youhei.workers.dev'];
  var ICE=[],pc=null,callRow=null,peer=null,localStream=null,seenSig={},processed={},answered=false,sigTimer=null;
  function q(id){return document.getElementById(id)}
  function mode(){return callRow&&callRow.call_type==='video'?'video':'voice'}
  function modeOf(c){return c&&c.call_type==='video'?'video':'voice'}
  function base(c){var key=String(c.id||'0'),hash=0;for(var i=0;i<key.length;i++)hash=(hash*31+key.charCodeAt(i))>>>0;var pool=c.call_type==='video'?VIDEO:VOICE;return pool[hash%pool.length]}
  function toastMsg(s){var t=q('toastMsg');if(t){t.textContent=s;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2600)}}
  async function loadIce(){try{var r=await fetch('/api/turn-credentials');var j=await r.json();if(j&&j.ok&&Array.isArray(j.iceServers)&&j.iceServers.length)return j.iceServers}catch(e){}return [{urls:'stun:stun.l.google.com:19302'}]}
  async function sig(type,payload){if(!callRow||!peer)return;try{await fetch(base(callRow)+'/api/call/signal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:peer.id,from:ME.id,call_id:callRow.id,type:type,sdp:payload||null,timestamp:Date.now()})})}catch(e){}}
  function stopMedia(){if(localStream){try{localStream.getTracks().forEach(function(t){t.stop()})}catch(e){}localStream=null}}
  function stopRing(){var a=q('ringtoneAudio');if(a){try{a.pause();a.currentTime=0}catch(e){}}}
  function cleanupUi(){var o=q('callOverlay');if(o)o.style.display='none';var t=q('incomingCallToast');if(t)t.style.display='none';stopRing();stopMedia();if(pc){try{pc.close()}catch(e){}pc=null}callRow=null;peer=null;answered=false;seenSig={};window.__btPendingOffer=null;if(sigTimer){clearInterval(sigTimer);sigTimer=null}var rv=q('remoteVideo'),lv=q('localVideo');if(rv){rv.srcObject=null;rv.style.display='none'}if(lv){lv.srcObject=null;lv.style.display='none'}}
  function showOverlay(u,status){var o=q('callOverlay');if(!o)return;o.style.display='flex';q('callOverlayAvatar').src=u&&u.avatar_url||'';q('callOverlayName').textContent=u?(u.display_name||u.username||''):'';q('callOverlayStatus').textContent=status}
  function startRing(){var a=q('ringtoneAudio');if(!a)return;try{a.loop=true;a.currentTime=0;a.play().catch(function(){})}catch(e){}}
  function newPC(){var p=new RTCPeerConnection({iceServers:ICE});p.onicecandidate=function(e){if(e.candidate)sig('candidate',e.candidate.toJSON?e.candidate.toJSON():e.candidate)};p.ontrack=function(e){var s=e.streams&&e.streams[0];if(!s)return;var rv=q('remoteVideo');if(rv){rv.srcObject=s;rv.style.display=callRow&&callRow.call_type==='video'?'block':'none'}q('callOverlayStatus').textContent='通話中'};p.onconnectionstatechange=function(){if(!pc)return;if(p.connectionState==='connected'){answered=true;q('callOverlayStatus').textContent='通話中'}else if(p.connectionState==='failed'){toastMsg('接続に失敗しました');hangup()}};return p}
  function startSigPoll(){if(sigTimer)clearInterval(sigTimer);sigTimer=setInterval(pollSignals,1000);pollSignals()}
  async function fetchSignals(c){var r=await fetch(base(c)+'/api/call/signals/'+encodeURIComponent(ME.id)+'?call_id='+encodeURIComponent(c.id));var list=await r.json();return Array.isArray(list)?list:[]}
  async function pollSignals(){if(!callRow||!pc)return;var list;try{list=await fetchSignals(callRow)}catch(e){return}for(const x of list){var id=x.id||((x.from||'')+'_'+(x.type||'')+'_'+String(JSON.stringify(x.sdp||'')).slice(0,40));if(seenSig[id])continue;seenSig[id]=1;try{await handleSignal(x)}catch(e){}}}
  async function handleSignal(x){var type=x.type||x.signal_type,data=x.sdp!==undefined?x.sdp:x.payload;
    if(type==='answer'){answered=true;q('callOverlayStatus').textContent='接続中…';if(pc&&data)await pc.setRemoteDescription(data)}
    else if(type==='candidate'){if(pc&&data){try{await pc.addIceCandidate(data)}catch(e){}}}
    else if(type==='decline'){toastMsg('呼び出しを拒否されました');cleanupUi()}
    else if(type==='bye'){cleanupUi()}}
  function findUser(id){try{if(typeof allUsers!=='undefined'&&allUsers&&allUsers.length){var u=allUsers.filter(function(x){return x.id===id})[0];if(u)return u}}catch(e){}return null}
  async function userOf(id){var u=findUser(id);if(u)return u;try{var u2=await API.get('users',id);return u2||{display_name:'ユーザー',username:''}}catch(e){return {display_name:'ユーザー',username:''}}}
  async function startCall(type){if(!ME||!activeConversationId||callRow)return;var convs;try{convs=await API.listAll('conversations')}catch(e){return}var conv=(convs||[]).filter(function(c){return c.id===activeConversationId})[0];if(!conv)return;var ids=conv.member_ids||[];var pid=ids.filter(function(x){return x!==ME.id})[0];if(!pid)return toastMsg('通話相手がいません');
    try{localStream=await navigator.mediaDevices.getUserMedia(type==='video'?{video:true,audio:true}:{audio:true})}catch(e){toastMsg('マイク・カメラへのアクセスが必要です');return}
    ICE=await loadIce();var u=await userOf(pid);peer=u;var row;try{row=await API.create('calls',{caller_id:ME.id,callee_id:pid,call_type:type})}catch(e){stopMedia();toastMsg('通話を開始できませんでした');return}callRow=row;pc=newPC();localStream.getTracks().forEach(function(tr){try{pc.addTrack(tr,localStream)}catch(e){}});
    if(type==='video'){var lv=q('localVideo');if(lv){lv.srcObject=localStream;lv.style.display='block'}var rv=q('remoteVideo');if(rv)rv.style.display='block'}
    var offer=await pc.createOffer();await pc.setLocalDescription(offer);await sig('offer',{type:offer.type,sdp:offer.sdp});showOverlay(u,'呼び出し中…');startSigPoll();
    setTimeout(function(){if(callRow&&!answered){toastMsg('呼び出しに応答がありません');sig('bye');cleanupUi()}},45000)}
  async function checkIncoming(){if(callRow||!ME||typeof API==='undefined'||!q('callOverlay'))return;var calls;try{calls=await API.listAll('calls')}catch(e){return}var now=Date.now();var c=(calls||[]).filter(function(x){return x&&x.callee_id===ME.id&&x.caller_id!==ME.id&&!x.status&&!processed[x.id]&&now-(x.created_at||0)<60000}).sort(function(a,b){return (b.created_at||0)-(a.created_at||0)})[0];if(!c)return;processed[c.id]=1;
    var list;try{list=await fetchSignals(c)}catch(e){return}var offer=list.filter(function(x){return (x.type||x.signal_type)==='offer'&&!seenSig[x.id]})[0];if(!offer)return;seenSig[offer.id||'off']=1;
    callRow=c;peer=await userOf(c.caller_id);window.__btPendingOffer=offer.sdp!==undefined?offer.sdp:offer.payload;var u=peer||{};var t=q('incomingCallToast');if(t){q('incomingCallAvatar').src=u.avatar_url||'';q('incomingCallName').textContent=u.display_name||u.username||'';q('incomingCallSub').textContent=c.call_type==='video'?'ビデオ通話の着信':'音声通話の着信';t.style.display='flex'}startRing()}
  async function acceptCall(){if(!callRow||!window.__btPendingOffer)return;var t=q('incomingCallToast');if(t)t.style.display='none';stopRing();try{localStream=await navigator.mediaDevices.getUserMedia(callRow.call_type==='video'?{video:true,audio:true}:{audio:true})}catch(e){toastMsg('マイク・カメラへのアクセスが必要です');sig('decline');cleanupUi();return}
    ICE=ICE.length?ICE:await loadIce();pc=newPC();localStream.getTracks().forEach(function(tr){try{pc.addTrack(tr,localStream)}catch(e){}});
    if(callRow.call_type==='video'){var lv=q('localVideo');if(lv){lv.srcObject=localStream;lv.style.display='block'}var rv=q('remoteVideo');if(rv)rv.style.display='block'}
    try{API.update('calls',callRow.id,{status:'answered'}).catch(function(){})}catch(e){}
    await pc.setRemoteDescription(window.__btPendingOffer);var ans=await pc.createAnswer();await pc.setLocalDescription(ans);showOverlay(peer,'接続中…');startSigPoll();await sig('answer',{type:ans.type,sdp:ans.sdp});window.__btPendingOffer=null}
  async function declineCall(){if(callRow){try{API.update('calls',callRow.id,{status:'declined'}).catch(function(){})}catch(e){}await sig('decline')}cleanupUi()}
  async function hangup(){if(callRow){try{API.update('calls',callRow.id,{status:'ended'}).catch(function(){})}catch(e){}await sig('bye')}cleanupUi()}
  function bind(){var v=q('voiceCallBtn'),d=q('videoCallBtn'),a=q('acceptCallBtn'),r=q('rejectCallBtn'),e=q('endCallBtn'),m=q('toggleMuteBtn'),t=q('toggleVideoBtn');
    if(v&&!v.__bt)v.__bt=1,v.onclick=function(){startCall('voice')};
    if(d&&!d.__bt)d.__bt=1,d.onclick=function(){startCall('video')};
    if(a&&!a.__bt)a.__bt=1,a.onclick=acceptCall;
    if(r&&!r.__bt)r.__bt=1,r.onclick=declineCall;
    if(e&&!e.__bt)e.__bt=1,e.onclick=hangup;
    if(m&&!m.__bt)m.__bt=1,m.onclick=function(){if(!localStream)return;var tr=localStream.getAudioTracks()[0];if(!tr)return;tr.enabled=!tr.enabled;m.innerHTML=tr.enabled?'<i class="fa-solid fa-microphone"></i>':'<i class="fa-solid fa-microphone-slash"></i>';m.style.color=tr.enabled?'':'#e05252'};
    if(t&&!t.__bt)t.__bt=1,t.onclick=function(){if(!localStream)return;var tr=localStream.getVideoTracks()[0];if(!tr)return toastMsg('この通話にはビデオがありません');tr.enabled=!tr.enabled;t.innerHTML=tr.enabled?'<i class="fa-solid fa-video"></i>':'<i class="fa-solid fa-video-slash"></i>';t.style.color=tr.enabled?'':'#e05252'}}
  function boot(){bind();setInterval(checkIncoming,3000);setInterval(bind,4000)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
</script>`;

const GROUP_SCRIPT = `<script>(function(){
  if(window.__btGroup)return;window.__btGroup=1;
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function q(id){return document.getElementById(id)}
  function toast(s){try{if(typeof showToast==='function')showToast(s)}catch(e){}}
  function myId(){return(typeof ME!=='undefined'&&ME)?ME.id:null}
  var css=document.createElement('style');
  css.textContent='#btMembersBtn{display:none;background:transparent!important;border:none!important;color:inherit!important;font-size:18px;cursor:pointer;padding:4px 6px}.chat-row{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}.msg-row[data-btsender]:not(.me){position:relative;margin-top:20px}.msg-row[data-btsender]:not(.me)::before{content:attr(data-btsender);position:absolute;top:0;left:44px;font-size:11px;font-weight:600;color:var(--bt-text-light,#8a97a8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%}#btSheet{position:fixed;inset:0;z-index:10000;display:none;align-items:flex-end;justify-content:center;background:rgba(3,6,12,.62)}#btSheet.open{display:flex}.bt-sheet{background:#141b26;color:#fff;width:min(430px,100%);border-radius:18px 18px 0 0;padding:12px 14px calc(16px + env(safe-area-inset-bottom));box-shadow:0 -8px 40px rgba(0,0,0,.55)}.bt-sheet h4{margin:6px 8px 8px;font-size:13px;color:#9fb2c9;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bt-sheet button,.bt-members-foot button{display:block;width:100%;text-align:left;background:transparent!important;border:none!important;color:#fff!important;padding:13px 12px!important;font-size:15px;border-radius:12px!important;cursor:pointer}.bt-sheet button:active{background:#223047!important}.bt-sheet button.danger,.bt-members-foot button.danger{color:#ff7070!important}#btMembers{position:fixed;inset:0;z-index:10001;display:none;align-items:center;justify-content:center;background:rgba(3,6,12,.7)}#btMembers.open{display:flex}.bt-members-card{background:#141b26;color:#fff;width:min(360px,92vw);max-height:72vh;border-radius:18px;padding:16px;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,.6)}.bt-members-card h4{margin:0 0 10px;font-size:15px;color:#fff}.bt-member-list{overflow:auto;flex:1;min-height:40px}.bt-member{display:flex;gap:10px;align-items:center;padding:8px 4px;border-bottom:1px solid #24324a}.bt-member img{width:36px;height:36px;border-radius:50%;flex:none}.bt-member .n{font-size:14px;font-weight:600;color:#fff}.bt-member .u{font-size:12px;color:#9fb2c9}#btGroupSection{padding:10px 12px;border-bottom:1px solid rgba(120,140,170,.25)}.bt-members-foot{padding-top:10px}.bt-members-foot hr{border:none;border-top:1px solid #2a3950;margin:6px 0}';
  document.head.appendChild(css);
  function convById(id){var list=(typeof conversations!=='undefined'&&Array.isArray(conversations))?conversations:[];for(var i=0;i<list.length;i++){if(list[i]&&list[i].id===id)return list[i]}return null}
  function nameOfConv(c){if(!c)return 'トーク';if(c.type==='group')return c.name||'グループ';var ids=Array.isArray(c.member_ids)?c.member_ids:[];var oid=null;for(var i=0;i<ids.length;i++){if(ids[i]!==myId())oid=ids[i]}var u=(typeof userById==='function')?userById(oid):null;return u?(u.display_name||u.username||'トーク'):'トーク'}
  function ensureSheet(){if(q('btSheet'))return;var d=document.createElement('div');d.id='btSheet';d.innerHTML='<div class="bt-sheet"><h4 id="btSheetTitle"></h4><div id="btSheetBtns"></div></div>';document.body.appendChild(d);d.addEventListener('click',function(e){if(e.target===d)closeSheet()})}
  function closeSheet(){var s=q('btSheet');if(s)s.classList.remove('open')}
  function addBtn(box,label,fn,danger){var el=document.createElement('button');if(danger)el.className='danger';el.textContent=label;el.addEventListener('click',fn);box.appendChild(el)}
  function openSheet(convId){var c=convById(convId);if(!c)return;ensureSheet();q('btSheetTitle').textContent=(c.type==='group'?'👥 ':'💬 ')+nameOfConv(c);var b=q('btSheetBtns');b.innerHTML='';addBtn(b,'メンバーを見る',function(){closeSheet();openMembers(convId)});if(c.type==='group'){addBtn(b,'グループから脱退',function(){closeSheet();leaveGroup(convId)},true)}else{addBtn(b,'トークを削除',function(){closeSheet();deleteDirect(convId)},true)}addBtn(b,'キャンセル',function(){closeSheet()});q('btSheet').classList.add('open')}
  async function deleteDirect(convId){
    var c=null;try{c=await API.get('conversations',convId)}catch(e){}
    if(!c)return;
    if(!confirm('このトークを削除しますか？（自分のトーク一覧から削除されます）'))return;
    try{
      var hidden=Array.isArray(c.hidden_for)?c.hidden_for.slice():[];
      if(hidden.indexOf(myId())<0)hidden.push(myId());
      var others=Array.isArray(c.member_ids)?c.member_ids.filter(function(x){return x!==myId()}):[];
      var othersGone=true;
      for(var i=0;i<others.length;i++){if(hidden.indexOf(others[i])<0){othersGone=false;break}}
      if(othersGone){await API.remove('conversations',convId)}
      else{await API.update('conversations',convId,{hidden_for:hidden})}
      if(typeof activeConversationId!=='undefined'&&activeConversationId===convId&&typeof backToList==='function')backToList();
      if(typeof refreshConversations==='function')await refreshConversations();
      toast('トークを削除しました');
    }catch(e){toast('削除に失敗しました')}
  }
  async function leaveGroup(convId){
    var c=null;try{c=await API.get('conversations',convId)}catch(e){}
    if(!c||c.type!=='group')return;
    if(!confirm('「'+(c.name||'グループ')+'」から脱退しますか？'))return;
    try{
      var rest=(Array.isArray(c.member_ids)?c.member_ids:[]).filter(function(x){return x!==myId()});
      if(rest.length===0){await API.remove('conversations',convId)}
      else{await API.update('conversations',convId,{member_ids:rest})}
      if(typeof activeConversationId!=='undefined'&&activeConversationId===convId&&typeof backToList==='function')backToList();
      if(typeof refreshConversations==='function')await refreshConversations();
      toast('グループから脱退しました');
    }catch(e){toast('脱退に失敗しました')}
  }
  function ensureMembers(){if(q('btMembers'))return;var d=document.createElement('div');d.id='btMembers';d.innerHTML='<div class="bt-members-card"><h4 id="btMembersTitle"></h4><div class="bt-member-list" id="btMembersList"></div><div class="bt-members-foot" id="btMembersFoot"></div></div>';document.body.appendChild(d);d.addEventListener('click',function(e){if(e.target===d)closeMembers()})}
  function closeMembers(){var m=q('btMembers');if(m)m.classList.remove('open')}
  async function openMembers(convId){
    var c=null;try{c=await API.get('conversations',convId)}catch(e){}
    if(!c)return;
    ensureMembers();
    var ids=Array.isArray(c.member_ids)?c.member_ids:[];
    q('btMembersTitle').textContent=(c.type==='group'?(c.name||'グループ'):'トーク')+'（'+ids.length+'名）';
    var list=q('btMembersList');list.innerHTML='';
    for(var i=0;i<ids.length;i++){
      var id=ids[i];
      var u=(typeof userById==='function')?userById(id):null;
      var row=document.createElement('div');row.className='bt-member';
      var av=(typeof avatarFor==='function')?avatarFor(u||{username:id}):'';
      row.innerHTML='<img src="'+esc(av)+'" alt=""><div><div class="n">'+esc(u?(u.display_name||u.username||'メンバー'):'メンバー')+'</div><div class="u">'+esc(u?('@'+(u.username||'')):'')+'</div></div>';
      list.appendChild(row);
      if(!u)(function(rowEl,uid){API.get('users',uid).then(function(u2){if(!u2)return;if(typeof allUsers!=='undefined'&&Array.isArray(allUsers)){var dup=false;for(var j=0;j<allUsers.length;j++){if(allUsers[j]&&allUsers[j].id===uid){dup=true;break}}if(!dup)allUsers.push(u2)}rowEl.querySelector('.n').textContent=u2.display_name||u2.username||'メンバー';rowEl.querySelector('.u').textContent='@'+(u2.username||'');var im=rowEl.querySelector('img');if(typeof avatarFor==='function')im.src=avatarFor(u2)}).catch(function(){})})(row,id);
    }
    var foot=q('btMembersFoot');foot.innerHTML='';
    if(c.type==='group'&&myId()&&ids.indexOf(myId())>=0){addBtn(foot,'グループから脱退',function(){closeMembers();leaveGroup(convId)},true);var hr=document.createElement('hr');foot.appendChild(hr)}
    addBtn(foot,'閉じる',function(){closeMembers()});
    q('btMembers').classList.add('open');
  }
  var groupMode=false;
  function addGroupUi(){
    var list=q('newChatFriendList');if(!list)return;
    if(!groupMode)list._btOrig=list.innerHTML;
    var sec=q('btGroupSection');
    if(!sec){sec=document.createElement('div');sec.id='btGroupSection';list.parentNode.insertBefore(sec,list)}
    sec.innerHTML='<input id="btGroupName" placeholder="グループ名を入力" maxlength="30"><button id="btGroupToggle" type="button">'+(groupMode?'💬 個人トークに戻る':'👥 グループを作る')+'</button>';
    q('btGroupToggle').addEventListener('click',function(){groupMode=!groupMode;applyGroupMode()});
    applyGroupMode();
  }
  function applyGroupMode(){
    var list=q('newChatFriendList');if(!list)return;
    if(!groupMode){
      if(list._btOrig!=null){list.innerHTML=list._btOrig;list._btOrig=null;
        var rows=list.querySelectorAll('[data-select]');
        for(var i=0;i<rows.length;i++){(function(r){r.addEventListener('click',function(){if(typeof openOrCreateDirectChat==='function')openOrCreateDirectChat(r.getAttribute('data-select'))})})(rows[i])}
      }
      return;
    }
    var friends=[];var fids=(typeof friendIds!=='undefined'&&friendIds)?friendIds:new Set();
    fids.forEach(function(id){var u=(typeof userById==='function')?userById(id):null;if(u)friends.push(u)});
    if(friends.length===0){list.innerHTML='<p style="padding:12px;color:var(--bt-text-light);font-size:13px;">友だちがいません。先に友だちを追加してください。</p>';return}
    var html='';
    for(var i=0;i<friends.length;i++){var f=friends[i];var av=(typeof avatarFor==='function')?avatarFor(f):'';html+='<label class="friend-row" style="display:flex;cursor:pointer"><input type="checkbox" class="bt-gpick" value="'+esc(f.id)+'" style="margin-right:8px"><img src="'+esc(av)+'" alt=""><div class="info"><div class="name">'+esc(f.display_name)+'</div></div></label>'}
    html+='<button id="btGroupCreate" type="button" style="width:100%;margin-top:10px;padding:12px;font-weight:700">グループを作成する</button>';
    list.innerHTML=html;
    q('btGroupCreate').addEventListener('click',createGroup);
  }
  async function createGroup(){
    var nameEl=q('btGroupName');var name=nameEl?nameEl.value.trim():'';
    if(!name){toast('グループ名を入力してください');return}
    var picked=[];var boxes=document.querySelectorAll('.bt-gpick:checked');
    for(var i=0;i<boxes.length;i++)picked.push(boxes[i].value);
    if(picked.length===0){toast('メンバーを1人以上選んでください');return}
    try{
      var conv=await API.create('conversations',{type:'group',name:name,member_ids:[myId()].concat(picked),last_message:'',last_message_at:Date.now()});
      groupMode=false;
      var m=q('newChatModal');if(m)m.classList.remove('show');
      if(typeof refreshConversations==='function')await refreshConversations();
      if(typeof openConversation==='function'&&conv&&conv.id)openConversation(conv.id);
      toast('グループを作成しました');
    }catch(e){toast('グループ作成に失敗しました')}
  }
  try{
    if(typeof openNewChatModal==='function'&&!window.__btOrigOpenNewChat){window.__btOrigOpenNewChat=openNewChatModal;window.openNewChatModal=async function(){var r=await window.__btOrigOpenNewChat.apply(this,arguments);try{addGroupUi()}catch(e){}return r}}
    if(typeof openConversation==='function'&&!window.__btOrigOpenConv){window.__btOrigOpenConv=openConversation;window.openConversation=async function(){var r=await window.__btOrigOpenConv.apply(this,arguments);try{updateHeaderBtn()}catch(e){}return r}}
    if(typeof renderMessageHtml==='function'&&!window.__btOrigRenderMsg){window.__btOrigRenderMsg=renderMessageHtml;window.renderMessageHtml=function(m){var html=window.__btOrigRenderMsg.apply(this,arguments);try{var c=(typeof activeConversation!=='undefined')?activeConversation:null;if(c&&c.type==='group'&&m&&m.sender_id!==myId()&&m.type!=='call'){var u=(typeof userById==='function')?userById(m.sender_id):null;var nm=u?(u.display_name||u.username||'メンバー'):'メンバー';html=html.replace('class="msg-row ','data-btsender="'+esc(nm)+'" class="msg-row ')}}catch(e){}return html}}
    if(typeof refreshConversations==='function'&&!window.__btOrigRefreshConv){window.__btOrigRefreshConv=refreshConversations;window.refreshConversations=async function(){var r=await window.__btOrigRefreshConv.apply(this,arguments);try{if(myId()&&typeof conversations!=='undefined'&&Array.isArray(conversations)){var vis=[];var changed=false;for(var i=0;i<conversations.length;i++){var c=conversations[i];var hidden=c&&Array.isArray(c.hidden_for)&&c.hidden_for.indexOf(myId())>=0;if(hidden)changed=true;else vis.push(c)}if(changed){conversations=vis;if(typeof renderChatList==='function')renderChatList()}}}catch(e){}return r}}
  }catch(e){}
  function ensureHeaderBtn(){var h=document.querySelector('.chat-header .actions');if(!h||q('btMembersBtn'))return;var b=document.createElement('button');b.id='btMembersBtn';b.innerHTML='&#128101;';b.title='メンバー';b.addEventListener('click',function(){if(typeof activeConversationId!=='undefined'&&activeConversationId)openMembers(activeConversationId)});h.appendChild(b)}
  function updateHeaderBtn(){var b=q('btMembersBtn');if(!b)return;var c=(typeof activeConversation!=='undefined')?activeConversation:null;b.style.display=(c&&c.type==='group')?'block':'none'}
  function bindLongPress(){
    var list=q('chatList');if(!list||list.__btLP)return;list.__btLP=1;
    var timer=null,fired=false,sx=0,sy=0;
    list.addEventListener('pointerdown',function(e){var row=e.target.closest?e.target.closest('.chat-row'):null;if(!row)return;fired=false;sx=e.clientX;sy=e.clientY;var id=row.getAttribute('data-conv');timer=setTimeout(function(){fired=true;try{if(navigator.vibrate)navigator.vibrate(25)}catch(err){}openSheet(id)},550)});
    var clear=function(){if(timer){clearTimeout(timer);timer=null}};
    list.addEventListener('pointerup',clear);list.addEventListener('pointercancel',clear);list.addEventListener('pointerleave',clear);
    list.addEventListener('pointermove',function(e){if(timer&&(Math.abs(e.clientX-sx)>10||Math.abs(e.clientY-sy)>10))clear()});
    list.addEventListener('click',function(e){if(fired){e.stopImmediatePropagation();e.preventDefault();fired=false}},true);
    list.addEventListener('contextmenu',function(e){var row=e.target.closest?e.target.closest('.chat-row'):null;if(row){e.preventDefault();openSheet(row.getAttribute('data-conv'))}});
  }
  function boot(){ensureSheet();ensureMembers();ensureHeaderBtn();try{updateHeaderBtn()}catch(e){}bindLongPress()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
  setInterval(function(){try{updateHeaderBtn()}catch(e){}},4000);
  window.__btDebug={openSheet:openSheet,openMembers:openMembers,addGroupUi:addGroupUi,leaveGroup:leaveGroup,deleteDirect:deleteDirect};
})();
</script>`;

const STICKER_SHIM = `<script>(function(){
  if(window.__btStickerShim)return;window.__btStickerShim=1;
  function toast(s){try{if(typeof showToast==='function')showToast(s)}catch(e){}}
  function lineProduct(v){var m=v.match(/store\.line\.me\/stickershop\/product\/(\d+)/)||v.match(/line\.me\/S?\/sticker\/(\d+)/)||v.match(/^\s*(\d{6,12})\s*$/);return m?m[1]:null}
  function lineSingle(v){var m=v.match(/stickershop\.line-scdn\.net\/stickershop\/v1\/sticker\/(\d+)\//);return m?{url:v,name:'LINEスタンプ'}:null}
  async function importProduct(pid){
    toast('LINEスタンプを取得中...');
    try{
      var r=await fetch('/api/line-stickers/'+encodeURIComponent(pid));var j=await r.json();
      if(!r.ok||!j.ok||!j.stickers||!j.stickers.length){toast('スタンプを取得できませんでした（無料スタンプのURLをお試しください）');return}
      var cnt=0;
      for(var i=0;i<j.stickers.length;i++){try{await API.create('stickers',{user_id:(typeof ME!=='undefined'&&ME)?ME.id:'',image_url:j.stickers[i],name:j.title||'LINEスタンプ'});cnt++}catch(e){}}
      if(typeof refreshStickers==='function')await refreshStickers();
      var input=document.getElementById('stickerUrlInput');if(input)input.value='';
      toast((j.title||'スタンプ')+'を'+cnt+'枚取り込みました');
    }catch(e){toast('取り込みに失敗しました')}
  }
  async function importSingle(item){
    try{await API.create('stickers',{user_id:(typeof ME!=='undefined'&&ME)?ME.id:'',image_url:item.url,name:item.name});if(typeof refreshStickers==='function')await refreshStickers();var input=document.getElementById('stickerUrlInput');if(input)input.value='';toast('スタンプを取り込みました')}catch(e){toast('取り込みに失敗しました')}
  }
  function smart(){
    var input=document.getElementById('stickerUrlInput');var v=input?input.value.trim():'';
    if(!v)return;
    var pid=lineProduct(v);if(pid){importProduct(pid);return}
    var single=lineSingle(v);if(single){importSingle(single);return}
    if(typeof window.__btOrigAddSticker==='function')window.__btOrigAddSticker();
  }
  function rebind(){
    var btn=document.getElementById('addStickerBtn');
    if(btn&&!btn.__btRebound){
      btn.__btRebound=1;
      if(typeof window.addStickerFromUrl==='function')window.__btOrigAddSticker=window.addStickerFromUrl;
      var clone=btn.cloneNode(true);btn.parentNode.replaceChild(clone,btn);clone.__btRebound=1;
      clone.addEventListener('click',function(e){e.preventDefault();smart()});
      return true;
    }
    return false;
  }
  window.addStickerFromUrl=smart;
  var tries=0;var t=setInterval(function(){if(rebind()||++tries>20)clearInterval(t)},1200);
  if(document.readyState!=='loading')rebind();else document.addEventListener('DOMContentLoaded',rebind);
})();
</script>`;

const BAN_SCRIPT = `<script>(function(){
  if(window.__btBan)return;window.__btBan=1;
  var CACHE_KEY='bt_ban_active';
  function myId(){try{return localStorage.getItem('bt_current_user')}catch(e){return null}}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function lock(){window.__btBanActive=1}
  try{(function(){var d=Object.getOwnPropertyDescriptor(Storage.prototype,'removeItem');if(d&&d.configurable){var orig=d.value;Object.defineProperty(Storage.prototype,'removeItem',{value:function(k){if(k==='bt_current_user'&&window.__btBanActive)return;return orig.call(this,k)},writable:true,configurable:true})}})()}catch(e){}
  var css=document.createElement('style');
  css.textContent='#btBanScreen{position:fixed;inset:0;z-index:2147483647;background:rgba(7,11,18,.97);display:none;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,sans-serif}#btBanScreen .bt-ban-card{background:#0e1421;color:#fff;border:2px solid #42536a;border-radius:18px;max-width:430px;width:100%;max-height:88vh;overflow:auto;padding:26px 22px;text-align:center;box-shadow:0 16px 60px rgba(0,0,0,.8)}#btBanScreen .bt-ban-icon{font-size:40px;margin-bottom:6px}#btBanScreen h2{margin:4px 0 8px;font-size:19px}#btBanScreen .bt-ban-lead{color:#ffd9d9;font-weight:700;font-size:14px;line-height:1.7;margin:0 0 12px}#btBanScreen .bt-ban-box{background:#101827;border:1px solid #2a3950;border-radius:10px;padding:10px 12px;text-align:left;font-size:13px;line-height:1.6;color:#e7eef7;margin:8px 0}#btBanScreen .bt-ban-box b{color:#9fb2c9;font-size:12px}#btBanScreen .bt-ban-appeal{border-top:1px solid #2a3950;margin-top:14px;padding-top:12px;text-align:left}#btBanScreen .bt-ban-appeal p{font-size:13px;color:#c7d3e2;margin:0 0 8px}#btBanScreen textarea{width:100%;box-sizing:border-box;min-height:84px;background:#05070c;color:#fff;border:2px solid #42536a;border-radius:10px;padding:10px;font-size:14px;resize:vertical}#btBanScreen button{width:100%;margin-top:10px;background:#000!important;color:#fff!important;border:2px solid #fff!important;border-radius:10px;padding:12px;font-size:15px;font-weight:700;cursor:pointer}#btBanScreen #btAppealOk{color:#8fd49f;font-size:13px;margin:8px 0 0}';
  document.head.appendChild(css);
  function ensure(){var s=document.getElementById('btBanScreen');if(s)return s;s=document.createElement('div');s.id='btBanScreen';document.body.appendChild(s);return s}
  function box(t,b){return b?'<div class="bt-ban-box"><b>'+esc(t)+'</b><br>'+esc(b)+'</div>':''}
  function show(st){
    var s=ensure();lock();
    try{sessionStorage.setItem(CACHE_KEY,'1')}catch(e){}
    var self=st&&st.selfDeleted;
    var title=self?'アカウントを削除しました':'アカウントが削除されました';
    var lead=self?'このアカウントは削除されました。':'利用規約に反したため、このアカウントは削除されました。';
    var h='<div class="bt-ban-card"><div class="bt-ban-icon">&#9940;</div><h2>'+esc(title)+'</h2><p class="bt-ban-lead">'+esc(lead)+'</p>';
    h+=box('違反内容',st&&st.reason);
    h+=box('管理者からのメッセージ',st&&st.message);
    h+=box('管理者からの返信',st&&st.appealMessage);
    if(!self){
      h+='<div class="bt-ban-appeal"><p>誤った削除・停止と思われる場合は、管理者へメッセージを送れます。</p>';
      h+='<textarea id="btAppealText" maxlength="2000" placeholder="状況を詳しくご記入ください"></textarea>';
      h+='<button id="btAppealSend" type="button">管理者へメッセージを送る</button>';
      h+='<p id="btAppealOk" style="display:none">送信しました。管理者からの返信をお待ちください。</p></div>';
    }
    h+='</div>';
    s.innerHTML=h;s.style.display='flex';
    var btn=document.getElementById('btAppealSend');
    if(btn)btn.addEventListener('click',async function(){
      var ta=document.getElementById('btAppealText');var v=ta?ta.value.trim():'';
      if(!v){if(typeof showToast==='function')showToast('メッセージを入力してください');else alert('メッセージを入力してください');return}
      btn.disabled=true;btn.textContent='送信中...';
      try{
        await fetch('/tables/appeals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:myId()||'',message:v.slice(0,2000),status:'open',created_at:Date.now()})});
        var ok=document.getElementById('btAppealOk');if(ok)ok.style.display='block';btn.textContent='送信しました';ta.value='';ta.disabled=true;
      }catch(e){btn.disabled=false;btn.textContent='管理者へメッセージを送る'}
    });
  }
  function hide(){try{if(sessionStorage.getItem(CACHE_KEY))sessionStorage.removeItem(CACHE_KEY)}catch(e){}window.__btBanActive=0;var s=document.getElementById('btBanScreen');if(s)s.style.display='none'}
  async function check(){
    var id=myId();if(!id)return;
    var r;try{r=await fetch('/api/account-status/'+encodeURIComponent(id),{cache:'no-store'})}catch(e){return}
    if(r.status===404){show({});return}
    var j=null;try{j=await r.json()}catch(e){return}
    if(j&&j.ok&&(j.banned||j.deleted))show(j);
    else if(j&&j.ok&&!j.banned&&!j.deleted)hide();
  }
  try{if(sessionStorage.getItem(CACHE_KEY)){lock();var s=ensure();s.innerHTML='<div class="bt-ban-card"><div class="bt-ban-icon">&#9940;</div><h2>アカウントが削除されました</h2><p class="bt-ban-lead">利用規約に反したため、このアカウントは削除されました。</p></div>';s.style.display='flex'}}catch(e){}
  window.__btBanDebug={show:show,check:check};
  var t=null;function boot(){if(t)clearInterval(t);check();t=setInterval(check,45000)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
</script>`;

async function enhanceHtml(response) {
  const type = response.headers.get('content-type') || ''; if (!type.includes('text/html')) return response;
  const text = await response.text();
  const withManifest = text.includes('</head>') ? text.replace('</head>', EARLY_THEME + '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="https://api.iconify.design/ic:baseline-chat-bubble.svg?color=%231877f2"></head>') : text;
  return new Response(withManifest.replace('</body>', DARK_CSS + APP_ENHANCEMENTS + MEDIA_SHIM + CALL_SCRIPT + GROUP_SCRIPT + STICKER_SHIM + BAN_SCRIPT + '</body>'), { status: response.status, headers: { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store', 'X-BlueTalk-Source': 'genspark-ui-cloudflare-kv' } });
}

export default { async fetch(request, env) {
  const incoming = new URL(request.url); const origin = request.headers.get('Origin') || incoming.origin;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (incoming.pathname === '/manifest.webmanifest') return pwaManifest();
  if (incoming.pathname === '/sw.js') return serviceWorker();
  if (incoming.pathname === '/admin.html') return adminPage();
  const callGateway = await handleCallGateway(request, incoming, origin);
  if (callGateway) return callGateway;
  const mediaResponse = await handleMedia(request, env, incoming, origin);
  if (mediaResponse) return mediaResponse;
  const lineStickers = await handleLineStickers(request, env, incoming, origin);
  if (lineStickers) return lineStickers;
  const accountStatus = await handleAccountStatus(request, env, incoming, origin);
  if (accountStatus) return accountStatus;
  const turnCredentials = await handleTurnCredentials(request, env, incoming, origin);
  if (turnCredentials) return turnCredentials;
  const btMedia = await handleBtMedia(request, env, incoming);
  if (btMedia) return btMedia;
  if (incoming.pathname.startsWith('/tables/')) return handleTables(request, env, incoming, origin);
  if (incoming.pathname.startsWith('/api/admin/')) return handleAdmin(request, env, incoming, origin);
  const upstream = new URL(UPSTREAM_ORIGIN); upstream.pathname = incoming.pathname; upstream.search = incoming.search;
  return enhanceHtml(await fetch(new Request(upstream.toString(), request), { redirect: 'manual' }));
} };
