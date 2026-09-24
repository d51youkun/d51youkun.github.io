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
    return row && !(table === 'users' && row.banned) ? json(row, 200, origin) : json({ error: 'not found' }, 404, origin);
  }
  if (request.method === 'POST' && !id) {
    const body = await request.json().catch(() => ({}));
    const row = { ...body, id: body.id || crypto.randomUUID(), created_at: body.created_at || Date.now() };
    rows.push(row); await writeTable(env, table, rows); return json(row, 201, origin);
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
    await writeTable(env, table, rows.filter((item) => String(item.id) !== id));
    if (table === 'users') {
      const [friendships, conversations, messages, stickers, calls, signals] = await Promise.all([
        readTable(env, 'friendships'), readTable(env, 'conversations'), readTable(env, 'messages'),
        readTable(env, 'stickers'), readTable(env, 'calls'), readTable(env, 'call_signals')
      ]);
      const removedConversationIds = new Set(conversations.filter((c) => Array.isArray(c.member_ids) && c.member_ids.includes(id)).map((c) => c.id));
      await Promise.all([
        writeTable(env, 'friendships', friendships.filter((r) => r.user_id !== id && r.friend_id !== id)),
        writeTable(env, 'conversations', conversations.filter((c) => !removedConversationIds.has(c.id))),
        writeTable(env, 'messages', messages.filter((m) => m.sender_id !== id && !removedConversationIds.has(m.conversation_id))),
        writeTable(env, 'stickers', stickers.filter((s) => s.user_id !== id)),
        writeTable(env, 'calls', calls.filter((c) => c.caller_id !== id && c.callee_id !== id)),
        writeTable(env, 'call_signals', signals.filter((s) => s.from_user_id !== id && s.to_user_id !== id))
      ]);
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
  if (url.pathname === '/api/admin/users' && request.method === 'GET') return json({ ok: true, users: await readTable(env, 'users') }, 200, origin);
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
    banned: Boolean(user.banned),
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
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BlueTalk 管理画面</title><style>body{margin:0;background:#f2f6fb;color:#24344d;font-family:system-ui,-apple-system,sans-serif}.wrap{max-width:980px;margin:0 auto;padding:24px}.card{background:#fff;border-radius:18px;padding:20px;margin:14px 0;box-shadow:0 8px 28px #2341  }.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #e5edf7;padding:12px 0}button{border:0;border-radius:10px;padding:9px 13px;background:#1877f2;color:#fff;font-weight:700;cursor:pointer}button.gray{background:#e8eef7;color:#24344d}input{padding:10px;border:1px solid #c7d9ee;border-radius:9px}small{color:#687b96}.danger{color:#a52828}</style></head><body><main class="wrap"><div id="root"></div></main><script>
  const root=document.getElementById('root'), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function login(){root.innerHTML='<section class="card"><h1>BlueTalk 管理画面</h1><p>管理者コードを入力してください。</p><input id="pw" type="password" placeholder="管理者コード"><button id="go">ログイン</button><p id="msg" class="danger"></p></section>';document.getElementById('go').onclick=async()=>{const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});const j=await r.json();if(!r.ok){document.getElementById('msg').textContent='認証に失敗しました';return}localStorage.setItem('bluetalk_admin_token',j.token);dashboard()}}
  async function dashboard(){const t=localStorage.getItem('bluetalk_admin_token');if(!t)return login();const h={Authorization:'Bearer '+t};const [ur,cr]=await Promise.all([fetch('/api/admin/users',{headers:h}),fetch('/api/admin/conversations',{headers:h})]);if(!ur.ok||!cr.ok){localStorage.removeItem('bluetalk_admin_token');return login()}const u=(await ur.json()).users||[], c=await cr.json(), names=Object.fromEntries(u.map(x=>[x.id,x.display_name||x.username]));root.innerHTML='<h1>BlueTalk 管理画面</h1><p><button id="logout" class="gray">管理者ログアウト</button>　<small>会話監視は利用規約に基づく安全・規約違反調査のために使用してください。</small></p><section class="card"><h2>アカウント管理・Ban情報</h2><p><small>Ban時は理由と利用者への案内文を保存します。解除時も誤Banについての案内文を登録できます。</small></p><div id="users"></div></section><section class="card"><h2>会話監視</h2><div id="convs"></div></section>';document.getElementById('logout').onclick=()=>{localStorage.removeItem('bluetalk_admin_token');login()};document.getElementById('users').innerHTML=u.map(x=>'<div class="row"><b>'+esc(x.display_name)+'</b><span>@'+esc(x.username)+'</span>'+(x.verified?' <span style="color:#d7a600;font-size:18px">✓</span>':'')+(x.title?' <span style="color:#b8860b">'+esc(x.title)+'</span>':'')+(x.banned?' <span class="danger">停止中</span>':'')+'<button data-act="verify" data-id="'+esc(x.id)+'">'+(x.verified?'認証解除':'Premium認証')+'</button><button data-act="ban" data-id="'+esc(x.id)+'">'+(x.banned?'Ban解除':'Ban')+'</button><input data-title="'+esc(x.id)+'" placeholder="ゴールド称号" value="'+esc(x.title||'')+'"><button data-act="title" data-id="'+esc(x.id)+'">称号を保存</button>'+(x.banned?'<small>理由: '+esc(x.ban_reason||'未登録')+'</small>':'')+'</div>').join('')||'アカウントはありません';document.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{const id=b.dataset.id, one=u.find(x=>x.id===id);let body;if(b.dataset.act==='verify'){body={verified:!one.verified}}else if(b.dataset.act==='ban'){if(one.banned){const appeal=prompt('誤Ban・解除に関する利用者へのメッセージ（任意）',one.ban_appeal_message||'');if(appeal===null)return;body={banned:false,ban_appeal_message:appeal}}else{const reason=prompt('Ban理由（利用規約のどの違反か）','');if(reason===null||!reason.trim())return;const message=prompt('利用者に表示する詳しい案内文（任意）','');if(message===null)return;body={banned:true,ban_reason:reason,ban_message:message,ban_appeal_message:''}}}else{body={title:document.querySelector('[data-title="'+CSS.escape(id)+'"]').value,admin_override:true}}await fetch('/api/admin/users/'+encodeURIComponent(id),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify(body)});dashboard()});const by={};(c.messages||[]).forEach(m=>(by[m.conversation_id]??=[]).push('<b>'+esc(names[m.sender_id]||m.sender_id)+'</b>: '+esc(m.content||'[スタンプ]')));document.getElementById('convs').innerHTML=(c.conversations||[]).map(x=>'<details><summary>'+esc(x.name||x.id)+'</summary><div class="row">'+(by[x.id]||[]).join('<br>')+'</div></details>').join('')||'会話はありません'}
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

const CALL_SCRIPT = `<script>(function(){
  if(window.__btCall)return;window.__btCall=1;
  var ICE=[],pc=null,callRow=null,peer=null,localStream=null,seenSig={},processed={},answered=false,sigTimer=null;
  function q(id){return document.getElementById(id)}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])})}
  function mode(){return callRow&&callRow.call_type==='video'?'video':'voice'}
  function modeOf(c){return c&&c.call_type==='video'?'video':'voice'}
  function toastMsg(s){var t=q('toastMsg');if(t){t.textContent=s;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2600)}}
  async function loadIce(){try{var r=await fetch('/api/turn-credentials');var j=await r.json();if(j&&j.ok&&Array.isArray(j.iceServers)&&j.iceServers.length)return j.iceServers}catch(e){}return [{urls:'stun:stun.l.google.com:19302'}]}
  async function sig(type,payload){if(!callRow||!peer)return;try{await fetch('/api/call-gateway/signal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:mode(),call_id:callRow.id,from:ME.id,to:peer.id,signal_type:type,payload:payload||null})})}catch(e){}}
  function stopMedia(){if(localStream){try{localStream.getTracks().forEach(function(t){t.stop()})}catch(e){}localStream=null}}
  function stopRing(){var a=q('ringtoneAudio');if(a){try{a.pause();a.currentTime=0}catch(e){}}}
  function cleanupUi(){var o=q('callOverlay');if(o)o.style.display='none';var t=q('incomingCallToast');if(t)t.style.display='none';stopRing();stopMedia();if(pc){try{pc.close()}catch(e){}pc=null}callRow=null;peer=null;answered=false;seenSig={};window.__btPendingOffer=null;if(sigTimer){clearInterval(sigTimer);sigTimer=null}var rv=q('remoteVideo'),lv=q('localVideo');if(rv){rv.srcObject=null;rv.style.display='none'}if(lv){lv.srcObject=null;lv.style.display='none'}}
  function showOverlay(u,status){var o=q('callOverlay');if(!o)return;o.style.display='flex';q('callOverlayAvatar').src=u&&u.avatar_url||'';q('callOverlayName').textContent=u?(u.display_name||u.username||''):'';q('callOverlayStatus').textContent=status}
  function startRing(){var a=q('ringtoneAudio');if(!a)return;try{a.loop=true;a.currentTime=0;a.play().catch(function(){})}catch(e){}}
  function newPC(){var p=new RTCPeerConnection({iceServers:ICE});p.onicecandidate=function(e){if(e.candidate)sig('candidate',e.candidate.toJSON?e.candidate.toJSON():e.candidate)};p.ontrack=function(e){var s=e.streams&&e.streams[0];if(!s)return;var rv=q('remoteVideo');if(rv){rv.srcObject=s;rv.style.display=callRow&&callRow.call_type==='video'?'block':'none'}q('callOverlayStatus').textContent='通話中'};p.onconnectionstatechange=function(){if(!pc)return;if(p.connectionState==='connected'){answered=true;q('callOverlayStatus').textContent='通話中'}else if(p.connectionState==='failed'){toastMsg('接続に失敗しました');hangup()}};return p}
  function startSigPoll(){if(sigTimer)clearInterval(sigTimer);sigTimer=setInterval(pollSignals,1000);pollSignals()}
  async function pollSignals(){if(!callRow||!pc)return;var list;try{var r=await fetch('/api/call-gateway/signals/'+encodeURIComponent(ME.id)+'?mode='+mode()+'&call_id='+encodeURIComponent(callRow.id));list=await r.json()}catch(e){return}if(!Array.isArray(list))return;for(const x of list){var id=x.id||((x.from||x.sender_id||'')+'_'+(x.type||x.signal_type||'')+'_'+String(JSON.stringify(x.sdp!==undefined?x.sdp:x.payload||'')).slice(0,40));if(seenSig[id])continue;seenSig[id]=1;try{await handleSignal(x)}catch(e){}}}
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
    var list;try{var r=await fetch('/api/call-gateway/signals/'+encodeURIComponent(ME.id)+'?mode='+modeOf(c)+'&call_id='+encodeURIComponent(c.id));list=await r.json()}catch(e){return}if(!Array.isArray(list))return;var offer=list.filter(function(x){return (x.type||x.signal_type)==='offer'&&!seenSig[x.id]})[0];if(!offer)return;seenSig[offer.id||'off']=1;
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

async function enhanceHtml(response) {
  const type = response.headers.get('content-type') || ''; if (!type.includes('text/html')) return response;
  const text = await response.text();
  const withManifest = text.includes('</head>') ? text.replace('</head>', '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="https://api.iconify.design/ic:baseline-chat-bubble.svg?color=%231877f2"></head>') : text;
  return new Response(withManifest.replace('</body>', APP_ENHANCEMENTS + CALL_SCRIPT + '</body>'), { status: response.status, headers: { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store', 'X-BlueTalk-Source': 'genspark-ui-cloudflare-kv' } });
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
  const accountStatus = await handleAccountStatus(request, env, incoming, origin);
  if (accountStatus) return accountStatus;
  const turnCredentials = await handleTurnCredentials(request, env, incoming, origin);
  if (turnCredentials) return turnCredentials;
  if (incoming.pathname.startsWith('/tables/')) return handleTables(request, env, incoming, origin);
  if (incoming.pathname.startsWith('/api/admin/')) return handleAdmin(request, env, incoming, origin);
  const upstream = new URL(UPSTREAM_ORIGIN); upstream.pathname = incoming.pathname; upstream.search = incoming.search;
  return enhanceHtml(await fetch(new Request(upstream.toString(), request), { redirect: 'manual' }));
} };
