const UPSTREAM_ORIGIN = 'https://nfieyeke.gensparkspace.com';
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
    return json({ data: rows.slice(start, start + limit), total: rows.length, page, limit }, 200, origin);
  }
  if (request.method === 'GET' && id) {
    const row = rows.find((item) => String(item.id) === id);
    return row ? json(row, 200, origin) : json({ error: 'not found' }, 404, origin);
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
    rows[index] = { ...rows[index], ...body, id: rows[index].id, updated_at: Date.now() };
    await writeTable(env, table, rows); return json(rows[index], 200, origin);
  }
  if (request.method === 'DELETE' && id) {
    await writeTable(env, table, rows.filter((item) => String(item.id) !== id));
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

function pwaManifest() {
  return new Response(JSON.stringify({ name: 'BlueTalk', short_name: 'BlueTalk', start_url: '/index.html', display: 'standalone', background_color: '#fff', theme_color: '#1877f2', icons: [{ src: 'https://api.iconify.design/ic:baseline-chat-bubble.svg?color=%231877f2', sizes: 'any', type: 'image/svg+xml' }] }), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
}

function serviceWorker() {
  return new Response("self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>cs[0]?.focus()||clients.openWindow('/app.html')))});", { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' } });
}

const TERMS_NOTICE = `<div id="bluetalk-terms" style="position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui"><div style="max-width:620px;max-height:85vh;overflow:auto;background:#fff;border-radius:20px;padding:24px;color:#24344d;box-shadow:0 20px 60px #0004"><h2>BlueTalk 利用規約・プライバシーポリシー</h2><p>BlueTalkは友人・知人向けの個人運営チャットサービスです。利用者は規約とプライバシーポリシーに同意して利用してください。</p><p>アカウント情報、トーク履歴、友だち、登録スタンプURL、通話接続情報をサービス提供・不正利用防止のため保存します。管理者は規約違反調査のため、会話の内容・参加者・送信時刻を確認する場合があります。</p><p>著作権を侵害する画像やLINEスタンプの無断登録・再配布は禁止です。利用者自身が権利を持つ画像、または利用許諾を得た画像だけを登録してください。</p><button id="bluetalk-terms-ok" style="width:100%;padding:12px;border:0;border-radius:12px;background:#1877f2;color:#fff;font-weight:700">同意して利用する</button></div></div>`;

const APP_ENHANCEMENTS = `<script>(function(){
  const termsKey='bluetalk_terms_v1';
  function addProfileTools(){const panel=document.querySelector('#profileView .profile-card');if(!panel||document.querySelector('#bluetalk-extra-tools'))return;const box=document.createElement('div');box.id='bluetalk-extra-tools';box.style='margin-top:14px;display:grid;gap:8px';box.innerHTML='<button id="bluetalk-notify" class="btn-secondary">通知を許可</button><button id="bluetalk-delete" class="btn-secondary" style="color:#b42318">アカウントを削除</button><small>名前とアカウントIDは1か月に1回変更できます。</small>';panel.appendChild(box);box.querySelector('#bluetalk-notify').onclick=async()=>{if('Notification'in window)await Notification.requestPermission()};box.querySelector('#bluetalk-delete').onclick=async()=>{if(!confirm('アカウントと公開プロフィールを削除しますか？'))return;const id=localStorage.getItem('bt_current_user');if(!id)return;const r=await fetch('/tables/users/'+encodeURIComponent(id),{method:'DELETE'});if(r.ok){localStorage.removeItem('bt_current_user');location.href='/index.html'}}}
  function terms(){if(location.pathname.endsWith('index.html')&&!localStorage.getItem(termsKey)){document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(TERMS_NOTICE)});document.querySelector('#bluetalk-terms-ok').onclick=()=>{localStorage.setItem(termsKey,'1');document.querySelector('#bluetalk-terms').remove()}}}
  new MutationObserver(addProfileTools).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',()=>{terms();addProfileTools();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{})});
})();</script>`;

async function enhanceHtml(response) {
  const type = response.headers.get('content-type') || ''; if (!type.includes('text/html')) return response;
  const text = await response.text();
  const withManifest = text.includes('</head>') ? text.replace('</head>', '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="https://api.iconify.design/ic:baseline-chat-bubble.svg?color=%231877f2"></head>') : text;
  return new Response(withManifest.replace('</body>', APP_ENHANCEMENTS + '</body>'), { status: response.status, headers: { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store', 'X-BlueTalk-Source': 'genspark-ui-cloudflare-kv' } });
}

export default { async fetch(request, env) {
  const incoming = new URL(request.url); const origin = request.headers.get('Origin') || incoming.origin;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (incoming.pathname === '/manifest.webmanifest') return pwaManifest();
  if (incoming.pathname === '/sw.js') return serviceWorker();
  if (incoming.pathname.startsWith('/tables/')) return handleTables(request, env, incoming, origin);
  if (incoming.pathname.startsWith('/api/admin/')) return handleAdmin(request, env, incoming, origin);
  const upstream = new URL(UPSTREAM_ORIGIN); upstream.pathname = incoming.pathname; upstream.search = incoming.search;
  return enhanceHtml(await fetch(new Request(upstream.toString(), request), { redirect: 'manual' }));
} };
