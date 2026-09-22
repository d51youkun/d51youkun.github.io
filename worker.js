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

const TERMS_NOTICE = `<div id="bluetalk-terms" style="position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui"><div style="max-width:720px;max-height:88vh;overflow:auto;background:#fff;border-radius:20px;padding:24px;color:#24344d;box-shadow:0 20px 60px #0004"><h2>BlueTalk 利用規約</h2><p>本規約は、本サービス「BlueTalk」（以下「本サービス」）の利用条件を定めるものです。利用者は、本サービスを利用することで本規約に同意したものとみなします。</p><h3>第1条（適用）</h3><p>本規約は、本サービスの利用に関わる一切の関係に適用されます。</p><h3>第2条（サービスの性質）</h3><p>本サービスは、個人が非営利で運営する友人・知人向けのチャットサービスです。法人・営利目的の利用は想定していません。</p><h3>第3条（利用資格）</h3><p>本サービスは、運営者から招待・案内を受けた者のみ利用できます。未成年者は保護者の同意を得て利用してください。</p><h3>第4条（禁止事項）</h3><p>法令・公序良俗違反、なりすまし、誹謗中傷・嫌がらせ、第三者の著作権・肖像権等の侵害、過度な負荷や不正アクセス、その他運営者が不適切と判断する行為を禁止します。</p><h3>第5条（スタンプ）</h3><p>登録画像URLは利用者自身の責任で登録してください。LINEスタンプ等、第三者が著作権を有する画像の無断利用による問題について運営者は責任を負いません。</p><h3>第6条（停止・変更・終了）</h3><p>運営者は事前通知なく内容を変更、停止、終了できます。</p><h3>第7条（データ）</h3><p>データの保存・バックアップは保証されず、通信障害・サーバー障害等で消失・破損する可能性があります。</p><h3>第8条（免責）</h3><p>安全性、正確性、動作保証等を保証せず、利用により生じた損害について責任を負いません。</p><h3>第9条（変更）</h3><p>変更後の規約は本サービス上に掲示した時点から効力を生じます。</p><h3>第10条（準拠法）</h3><p>日本法を準拠法とします。</p><h2>BlueTalk プライバシーポリシー</h2><p>アカウント情報、トーク履歴、友だちリスト、登録スタンプ画像URL、通話接続に必要な通信情報を取得・保存し、サービス提供・改善、不具合対応、不正利用防止に利用します。法令に基づく場合を除き、同意なく第三者へ提供しません。</p><p>データはCloudflare Workers上で保存・処理され、完全な永続性や安全性は保証されません。利用者は設定から自身のアカウント情報を変更・削除できます。未成年者は保護者の同意を得て利用してください。</p><p style="color:#8a3b12">管理者は、規約違反や安全上の問題を調査する必要がある場合、個人・グループを含む会話の内容、送信者、時刻を確認することがあります。</p><button id="bluetalk-terms-ok" style="width:100%;padding:12px;border:0;border-radius:12px;background:#1877f2;color:#fff;font-weight:700">同意して利用する</button></div></div>`;

const APP_ENHANCEMENTS = `<script>(function(){
  const termsKey='bluetalk_terms_v2';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function addProfileTools(){const panel=document.querySelector('#profileView .profile-card');if(!panel||document.querySelector('#bluetalk-extra-tools'))return;const box=document.createElement('div');box.id='bluetalk-extra-tools';box.style='margin-top:14px;display:grid;gap:8px';box.innerHTML='<button id="bluetalk-notify" class="btn-secondary">通知を許可</button><button id="bluetalk-delete" class="btn-secondary" style="color:#b42318">アカウントを削除</button><small>名前とアカウントIDは1か月に1回変更できます。</small>';panel.appendChild(box);box.querySelector('#bluetalk-notify').onclick=async()=>{if('Notification'in window){const p=await Notification.requestPermission();alert(p==='granted'?'通知を許可しました':'通知は許可されませんでした')}};box.querySelector('#bluetalk-delete').onclick=async()=>{if(!confirm('アカウントと関連データを削除しますか？この操作は戻せません。'))return;const id=localStorage.getItem('bt_current_user');if(!id)return;const r=await fetch('/tables/users/'+encodeURIComponent(id),{method:'DELETE'});if(r.ok){localStorage.clear();location.href='/index.html'}else alert('削除に失敗しました')}}
  function terms(){if(location.pathname.endsWith('index.html')&&!localStorage.getItem(termsKey)){document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(TERMS_NOTICE)});document.querySelector('#bluetalk-terms-ok').onclick=()=>{localStorage.setItem(termsKey,'1');document.querySelector('#bluetalk-terms').remove()}}}
  let keys='';let last=0;function adminTrigger(e){const now=Date.now();if(now-last>4000)keys='';last=now;keys+=(e.key||'');if(keys.length>40)keys=keys.slice(-40);if(keys.endsWith('d51-498go'))showAdminLogin()}
  function showAdminLogin(){location.href='/admin.html'}
  function showAdminPanel(token){if(document.querySelector('#bluetalk-admin-panel'))return;const d=document.createElement('div');d.id='bluetalk-admin-panel';d.style='position:fixed;inset:0;z-index:100000;background:#0008;padding:20px;overflow:auto';d.innerHTML='<div style="background:#fff;border-radius:18px;padding:22px;max-width:900px;margin:auto;color:#24344d"><div style="display:flex;justify-content:space-between;align-items:center"><h2>BlueTalk 管理画面</h2><button id="bt-admin-close">閉じる</button></div><p style="color:#8a3b12">会話監視は利用規約に基づく安全・規約違反調査のための機能です。</p><div id="bt-admin-users">読み込み中…</div><h3>会話監視</h3><div id="bt-admin-conversations">読み込み中…</div></div>';document.body.appendChild(d);d.querySelector('#bt-admin-close').onclick=()=>d.remove();const h={Authorization:'Bearer '+token};fetch('/api/admin/users',{headers:h}).then(r=>r.json()).then(j=>{d.querySelector('#bt-admin-users').innerHTML='<h3>ユーザー管理</h3>'+j.users.map(u=>'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #eee;padding:10px 0"><b>'+esc(u.display_name)+'</b><span>@'+esc(u.username)+'</span><button data-ban="'+esc(u.id)+'">'+(u.banned?'解除':'Ban')+'</button><button data-verify="'+esc(u.id)+'">'+(u.verified?'認証解除':'BlueTalkPremium')+'</button><button data-gold="'+esc(u.id)+'">ゴールド称号</button></div>').join('');d.querySelectorAll('[data-ban],[data-verify],[data-gold]').forEach(b=>b.onclick=async()=>{const id=b.dataset.ban||b.dataset.verify||b.dataset.gold;const u=j.users.find(x=>x.id===id)||{};const body=b.dataset.ban?{banned:!u.banned}:b.dataset.verify?{verified:!u.verified}:{title:'ゴールド'};await fetch('/api/admin/users/'+encodeURIComponent(id),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify(body)});showAdminPanel(token);d.remove()})});fetch('/api/admin/conversations',{headers:h}).then(r=>r.json()).then(j=>{const us=Object.fromEntries(j.users.map(u=>[u.id,u.display_name||u.username]));const by={};j.messages.forEach(m=>(by[m.conversation_id]??=[]).push('<b>'+esc(us[m.sender_id]||m.sender_id)+'</b>: '+esc(m.content||'[スタンプ]')));d.querySelector('#bt-admin-conversations').innerHTML=j.conversations.map(c=>'<details><summary>'+esc(c.name||c.id)+'</summary><div style="padding:8px">'+(by[c.id]||[]).join('<br>')+'</div></details>').join('')||'会話はありません'})}
  function wireLegacyStickerTools(){if(typeof API==='undefined'||window.__btLegacyStickerTools)return;const view=document.querySelector('#stickersView');if(!view||document.querySelector('#bluetalk-sticker-import'))return;window.__btLegacyStickerTools=1;const box=document.createElement('div');box.id='bluetalk-sticker-import';box.className='add-sticker-card';box.style='margin-top:12px';box.innerHTML='<label style="font-size:12px;color:var(--bt-text-light);font-weight:600">旧BlueChat方式：スタンプ帳を作成（複数選択・GIF/WebP/APNG対応）</label><div class="row" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><input id="bt-sticker-pack-name" type="text" placeholder="スタンプ帳の名前" value="マイスタンプ"><input id="bt-sticker-files" type="file" accept="image/*" multiple><button class="btn-primary" id="bt-sticker-import-btn" style="width:auto;padding:0 18px">取り込む</button></div><p class="hint">自分が利用する権利を持つ画像だけ登録してね。動くGIF・WebPは動いたまま保存するよ。</p>';view.querySelector('.add-sticker-card')?.after(box);box.querySelector('#bt-sticker-import-btn').onclick=async()=>{const files=[...box.querySelector('#bt-sticker-files').files];if(!files.length)return showToast('画像を選択してください');const name=box.querySelector('#bt-sticker-pack-name').value.trim()||'マイスタンプ';const ok=files.filter(f=>f.type.startsWith('image/')&&f.size<=5*1024*1024);if(!ok.length)return showToast('画像は1枚5MBまでです');try{showToast('スタンプを取り込み中…');for(const file of ok){const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)});await API.create('stickers',{user_id:ME.id,image_url:data,name});}box.querySelector('#bt-sticker-files').value='';if(typeof refreshStickers==='function')await refreshStickers();showToast(name+'を取り込みました（'+ok.length+'枚）')}catch(e){console.error(e);showToast('スタンプの取り込みに失敗しました')}}}
  function wireAdvancedChat(){if(typeof API==='undefined'||window.__btAdvancedChat)return;window.__btAdvancedChat=1;const rawCreate=API.create.bind(API),rawList=API.listAll.bind(API);const callIds={};API.create=async(table,body)=>{if(table==='calls'){const row=await rawCreate(table,body);callIds[row.id]={...body,...row};return row}if(table==='call_signals'){const call=(typeof currentCall!=='undefined'&&currentCall)||callIds[body.call_id]||{};const to=ME.id===call.caller_id?call.callee_id:call.caller_id;const mode=call.call_type==='video'?'video':'voice';const r=await fetch('/api/call-gateway/signal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,call_id:body.call_id,from:ME.id,to,signal_type:body.signal_type,payload:body.payload})});if(!r.ok)throw new Error('call signal failed');return {id:crypto.randomUUID(),...body}}return rawCreate(table,body)};API.listAll=async(table,params={})=>{if(table==='call_signals'){const call=(typeof currentCall!=='undefined'&&currentCall)||{};const mode=call.call_type==='video'?'video':'voice';const q=new URLSearchParams({mode,call_id:call.id||''});const r=await fetch('/api/call-gateway/signals/'+encodeURIComponent(ME.id)+'?'+q);const list=await r.json();return (Array.isArray(list)?list:[]).map(x=>({id:x.id,call_id:x.call_id,sender_id:x.from,signal_type:x.type,payload:x.sdp}))}return rawList(table,params)};const input=document.querySelector('#messageInput');if(!input)return;const bar=input.parentElement;const fileInput=document.createElement('input');fileInput.type='file';fileInput.accept='image/*,video/*,.html,text/html';fileInput.hidden=true;const fileBtn=document.createElement('button');fileBtn.className='round-btn';fileBtn.type='button';fileBtn.title='写真・動画・HTMLを送信';fileBtn.textContent='📎';bar.insertBefore(fileBtn,input);bar.appendChild(fileInput);fileBtn.onclick=()=>fileInput.click();fileInput.onchange=async()=>{const file=fileInput.files[0];fileInput.value='';if(!file||!activeConversationId)return;if(file.size>8*1024*1024)return showToast('ファイルは8MBまでです');const reader=new FileReader();reader.onload=async()=>{try{showToast('ファイルを送信中…');const up=await fetch('/api/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:reader.result,name:file.name,mimeType:file.type||'application/octet-stream'})}).then(r=>r.json());if(!up.ok)throw new Error(up.error);await rawCreate('messages',{conversation_id:activeConversationId,sender_id:ME.id,type:'file',content:file.name,attachment_url:up.url,file_name:file.name,mime_type:file.type,file_size:file.size,sent_at:Date.now()});await loadMessages(true);showToast('送信しました')}catch(e){console.error(e);showToast('ファイル送信に失敗しました')}};reader.readAsDataURL(file)};    const rawRender=renderMessageHtml;renderMessageHtml=function(m){let out;if(m.type==='file'&&m.attachment_url){const u=esc(m.attachment_url),name=esc(m.file_name||m.content||'ファイル'),mime=m.mime_type||'';const media=mime.startsWith('image/')?'<img src="'+u+'" alt="'+name+'" style="max-width:240px;border-radius:12px">':mime.startsWith('video/')?'<video src="'+u+'" controls playsinline style="max-width:260px;border-radius:12px"></video>':'<a href="'+u+'" download="'+name+'" target="_blank" rel="noopener">📎 '+name+'</a>';out='<div class="msg-row '+(m.sender_id===ME.id?'me':'')+'" data-message-id="'+esc(m.id)+'"><img class="avatar" src="'+esc(avatarFor(userById(m.sender_id)))+'" alt=""><div class="msg-bubble">'+media+'</div><div class="msg-meta"><span class="msg-time">'+(m.sent_at?new Date(m.sent_at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}):'')+'</span></div></div>'}else{out=rawRender(m);if(!out)return out;const div=document.createElement('div');div.innerHTML=out;const row=div.firstElementChild;if(row){if(m.id)row.setAttribute('data-message-id',m.id);const bubble=row.querySelector('.msg-bubble');const rawText=String(m.content||'').trim();const lowerText=rawText.toLowerCase();const leakedAvatar=lowerText.includes('api.dicebear.com/7.x/thumbs/svg?seed=')||lowerText.includes('alt=""');const text=leakedAvatar?'':rawText;if(bubble&&leakedAvatar)bubble.textContent='';if(bubble&&text&&m.type!=='sticker'){const cleanUrl=text.toLowerCase().split('?')[0].split('#')[0];const imageUrl=text.toLowerCase().startsWith('https://')&&(text.toLowerCase().includes('googleusercontent.com/')||['.png','.jpg','.jpeg','.gif','.webp','.avif'].some(ext=>cleanUrl.endsWith(ext)));const safeText=esc(text);if(imageUrl){bubble.innerHTML='<a href="'+safeText+'" target="_blank" rel="noopener noreferrer"><img src="'+safeText+'" alt="画像" style="max-width:260px;max-height:260px;object-fit:contain;border-radius:12px;display:block"></a>'}else if(text.includes('http://')||text.includes('https://')){bubble.innerHTML=safeText.split(' ').map(function(part){return part.indexOf('http://')===0||part.indexOf('https://')===0?'<a href="'+part+'" target="_blank" rel="noopener noreferrer">'+part+'</a>':part}).join(' ')}}out=div.innerHTML}}return out};let pressTimer;document.addEventListener('pointerdown',e=>{const row=e.target.closest('[data-message-id]');if(!row)return;pressTimer=setTimeout(async()=>{if(!row.classList.contains('me'))return;const id=row.dataset.messageId;if(!confirm('このメッセージを送信取り消ししますか？'))return;const r=await fetch('/tables/messages/'+encodeURIComponent(id),{method:'DELETE'});if(r.ok){row.remove();showToast('送信を取り消しました')}},650)});document.addEventListener('pointerup',()=>clearTimeout(pressTimer));document.addEventListener('pointercancel',()=>clearTimeout(pressTimer))}
  function exactFriendSearch(){const input=document.querySelector('#friendSearchInput');if(!input||input.dataset.btExact)return;input.dataset.btExact='1';input.addEventListener('input',async e=>{e.stopImmediatePropagation();const q=input.value.trim();const box=document.querySelector('#friendSearchResult');if(!q){box.innerHTML='';return}try{const j=await fetch('/tables/users?limit=1000').then(r=>r.json());const me=localStorage.getItem('bt_current_user');const u=(j.data||[]).find(x=>x.id!==me&&String(x.username||'')===q);if(!u){box.innerHTML='<p style="padding:10px 18px;color:var(--bt-text-light);font-size:13px">完全一致するIDが見つかりません</p>';return}box.innerHTML='<div class="friend-row"><img src="'+esc(u.avatar_url||'')+'" alt=""><div class="info"><div class="name">'+esc(u.display_name)+'</div><div class="status">@'+esc(u.username)+'</div></div><div class="row-actions"><button class="mini-btn" data-add="'+esc(u.id)+'">追加</button></div></div>';box.querySelector('[data-add]').onclick=async()=>{const b=box.querySelector('[data-add]');b.disabled=true;await fetch('/tables/friendships',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:me,friend_id:u.id})});await fetch('/tables/friendships',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:u.id,friend_id:me})});b.textContent='追加済';};}catch(err){box.innerHTML='<p style="padding:10px 18px;color:#b42318">検索に失敗しました</p>'}},true)}
  function addQrButton(){const view=document.querySelector('#friendsView');if(!view||document.querySelector('#bluetalk-my-qr'))return;const b=document.createElement('button');b.id='bluetalk-my-qr';b.className='btn-secondary';b.textContent='自分のQRを表示';b.style='margin:8px 16px';view.querySelector('h2,header, .view-header')?.after(b);b.onclick=()=>{const id=localStorage.getItem('bt_current_user');const box=document.createElement('div');box.style='position:fixed;inset:0;z-index:99998;background:#0008;display:grid;place-items:center';box.innerHTML='<div style="background:#fff;border-radius:18px;padding:22px;text-align:center"><h3>BlueTalkの友だち追加QR</h3><img alt="QR" width="240" height="240" src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&data='+encodeURIComponent(location.origin+'/index.html?add='+id)+'"><p style="font-size:12px;color:#667">QRはBlueTalkの友だち追加用です</p><button>閉じる</button></div>';document.body.appendChild(box);box.querySelector('button').onclick=()=>box.remove()}}
  function applyBadges(){if(typeof allUsers==='undefined'||!allUsers.length)return;const byName=Object.fromEntries(allUsers.map(u=>[u.display_name,u]));document.querySelectorAll('.name,#profileName').forEach(el=>{if(el.dataset.btBadge)return;const u=byName[el.textContent.trim()];if(!u||(!u.verified&&!u.title))return;el.dataset.btBadge='1';if(u.verified){const v=document.createElement('span');v.textContent='✓';v.title='BlueTalkPremium';v.style='display:inline-block;margin-left:5px;color:#d7a600;font-weight:900';el.appendChild(v)}if(u.title){const t=document.createElement('span');t.textContent=' '+u.title;t.style='margin-left:5px;color:#b8860b;font-weight:700';el.appendChild(t)}})}
  function bindAdminName(){const n=document.querySelector('#profileName');if(n&&!n.dataset.btAdminClick){n.dataset.btAdminClick='1';n.style.cursor='pointer';n.title='管理者メニュー';n.onclick=()=>{if(localStorage.getItem('bluetalk_admin_token'))location.href='/admin.html';else showAdminLogin()}}}
  function installDirectGateways(){if(window.__btDirectGateways)return;window.__btDirectGateways=1;const rawFetch=window.fetch.bind(window),media='https://bluechat-sync.by-youhei.workers.dev',voice='https://bluechat-call-1.by-youhei.workers.dev',video='https://bluechat-video-1.by-youhei.workers.dev';window.fetch=async(input,init={})=>{const href=typeof input==='string'?input:input.url;const u=new URL(href,location.origin);if(u.pathname==='/api/call-gateway/signal'&&init.body){const b=JSON.parse(init.body),base=b.mode==='video'?video:voice;return rawFetch(base+'/api/call/signal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:b.to,from:b.from,call_id:b.call_id,type:b.signal_type,sdp:b.payload,timestamp:Date.now()})})}if(u.pathname.startsWith('/api/call-gateway/signals/')){const b=new URLSearchParams(u.search);const base=b.get('mode')==='video'?video:voice;return rawFetch(base+'/api/call/signals/'+decodeURIComponent(u.pathname.split('/').pop())+u.search)}if(u.pathname==='/api/media'&&init.method==='POST'&&init.body){const b=JSON.parse(init.body),data=String(b.data||''),id=crypto.randomUUID(),size=180000,total=Math.ceil(data.length/size);const jobs=[];for(let i=0;i<total;i++)jobs.push(rawFetch(media+'/api/media/chunk/'+id+'/'+i,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:data.slice(i*size,(i+1)*size)})}));await Promise.all(jobs);await rawFetch(media+'/api/media/chunk/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({totalChunks:total,mimeType:b.mimeType||'application/octet-stream'})});return new Response(JSON.stringify({ok:true,uploadId:id,url:data.length<=5500000?data:media+'/api/media/blob/'+id}),{status:201,headers:{'Content-Type':'application/json'}})}return rawFetch(input,init)}}
  function repairImages(){document.querySelectorAll('img').forEach(img=>{if(img.dataset.btFallback)return;img.dataset.btFallback='1';img.addEventListener('error',()=>{if(img.dataset.btBroken)return;img.dataset.btBroken='1';img.src='https://api.dicebear.com/7.x/thumbs/svg?seed=bluetalk-fallback'})})}
  function patchIceQueue(){if(!window.RTCPeerConnection||window.__btIceQueue)return;window.__btIceQueue=1;const add=RTCPeerConnection.prototype.addIceCandidate,set=RTCPeerConnection.prototype.setRemoteDescription;RTCPeerConnection.prototype.addIceCandidate=function(candidate){if(!this.remoteDescription){(this.__btPendingIce||(this.__btPendingIce=[])).push(candidate);return Promise.resolve()}return add.call(this,candidate)};RTCPeerConnection.prototype.setRemoteDescription=async function(desc){const result=await set.call(this,desc);const pending=this.__btPendingIce||[];this.__btPendingIce=[];for(const candidate of pending){try{await add.call(this,candidate)}catch(e){console.warn('ICE candidate skipped',e)}}return result}}
  new MutationObserver(()=>{installDirectGateways();patchIceQueue();repairImages();addProfileTools();exactFriendSearch();addQrButton();bindAdminName();applyBadges();wireLegacyStickerTools();wireAdvancedChat()}).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('keydown',adminTrigger);document.addEventListener('DOMContentLoaded',()=>{terms();installDirectGateways();patchIceQueue();repairImages();addProfileTools();exactFriendSearch();addQrButton();bindAdminName();wireLegacyStickerTools();wireAdvancedChat();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{})});
})();</script>`;

const AVATAR_LEAK_GUARD = `<script>(function(){function clean(){document.querySelectorAll('.msg-bubble').forEach(function(b){var t=b.textContent||'';if(t.includes('api.dicebear.com/7.x/thumbs/svg?seed=')||t.includes('alt=""'))b.textContent=''})}clean();new MutationObserver(clean).observe(document.documentElement,{childList:true,subtree:true})})();</script>`;

const FILE_UPLOAD_FALLBACK = `<script>(function(){var media='https://bluechat-sync.by-youhei.workers.dev';function toast(s){if(typeof showToast==='function')showToast(s);else console.log(s)}async function upload(data,mime){var id=crypto.randomUUID(),size=180000,total=Math.ceil(data.length/size),jobs=[];for(var i=0;i<total;i++)jobs.push(fetch(media+'/api/media/chunk/'+id+'/'+i,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:data.slice(i*size,(i+1)*size)})}));await Promise.all(jobs);var done=await fetch(media+'/api/media/chunk/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({totalChunks:total,mimeType:mime||'application/octet-stream'})});if(!done.ok)throw new Error('media complete failed');return data.length<=5500000?data:media+'/api/media/blob/'+id}function install(){var input=document.querySelector('#messageInput');if(!input||document.querySelector('#bluetalk-file-fallback'))return;var bar=input.parentElement,file=document.createElement('input'),button=document.createElement('button');file.id='bluetalk-file-fallback';file.type='file';file.accept='image/*,video/*,.html,text/html';file.hidden=true;button.type='button';button.className='round-btn';button.title='写真・動画・HTMLを送信';button.textContent='📎';bar.insertBefore(button,input);bar.appendChild(file);button.onclick=function(){file.click()};file.onchange=async function(){var f=file.files&&file.files[0];file.value='';if(!f||typeof activeConversationId==='undefined'||!activeConversationId||typeof API==='undefined'||typeof ME==='undefined')return;if(f.size>8*1024*1024){toast('ファイルは8MBまでです');return}try{toast('ファイルを送信中…');var data=await new Promise(function(resolve,reject){var r=new FileReader();r.onload=function(){resolve(r.result)};r.onerror=reject;r.readAsDataURL(f)});var url=await upload(data,f.type);await API.create('messages',{conversation_id:activeConversationId,sender_id:ME.id,type:'file',content:f.name,attachment_url:url,file_name:f.name,mime_type:f.type,file_size:f.size,sent_at:Date.now()});if(typeof loadMessages==='function')await loadMessages(true);toast('送信しました')}catch(e){console.error(e);toast('ファイル送信に失敗しました')}}}new MutationObserver(install).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',install);install()})();</script>`;

const RECOVERY_SCRIPT = `<script>(function(){var voice='https://bluechat-call-1.by-youhei.workers.dev',video='https://bluechat-video-1.by-youhei.workers.dev';var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])})};function install(){if(typeof API==='undefined'||typeof ME==='undefined')return;if(!window.__btRecovery){window.__btRecovery=1;var create=API.create.bind(API),list=API.listAll.bind(API);API.create=async function(table,body){if(table==='call_signals'){var call=typeof currentCall!=='undefined'&&currentCall||{};var mode=call.call_type==='video'?'video':'voice';var to=ME.id===call.caller_id?call.callee_id:call.caller_id;return create('call_signals',{...body}).catch(async function(){return {id:crypto.randomUUID(),...body}}).then(function(x){return x})}return create(table,body)};API.listAll=async function(table,params){if(table==='call_signals'){var call=typeof currentCall!=='undefined'&&currentCall||{};var mode=call.call_type==='video'?'video':'voice';var q=new URLSearchParams({mode:mode,call_id:call.id||''});var r=await fetch('/api/call-gateway/signals/'+encodeURIComponent(ME.id)+'?'+q);var a=await r.json();return Array.isArray(a)?a.map(function(x){return{id:x.id,call_id:x.call_id,sender_id:x.from,signal_type:x.type,payload:x.sdp}}):[]}return list(table,params)};if(typeof renderMessageHtml==='function'){var rawRender=renderMessageHtml;renderMessageHtml=function(m){if(m.type==='file'&&m.attachment_url){var u=esc(m.attachment_url),name=esc(m.file_name||m.content||'ファイル'),mime=m.mime_type||'';var media=mime.indexOf('image/')===0?'<img src="'+u+'" alt="'+name+'" style="max-width:260px;border-radius:12px">':mime.indexOf('video/')===0?'<video src="'+u+'" controls playsinline style="max-width:280px;border-radius:12px"></video>':'<a href="'+u+'" target="_blank" rel="noopener">📎 '+name+'</a>';return '<div class="msg-row '+(m.sender_id===ME.id?'me':'')+'" data-message-id="'+esc(m.id)+'"><img class="avatar" src="'+esc(avatarFor(userById(m.sender_id)))+'" alt=""><div class="msg-bubble">'+media+'</div></div>'}return rawRender(m)}}}}new MutationObserver(install).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',install);install()})();</script>`;

const CALL_FETCH_GATE = `<script>(function(){if(window.__btCallFetchGate)return;window.__btCallFetchGate=1;var raw=window.fetch.bind(window),voice='https://bluechat-call-1.by-youhei.workers.dev',video='https://bluechat-video-1.by-youhei.workers.dev';window.fetch=function(input,init){var u=new URL(typeof input==='string'?input:input.url,location.origin);if((u.pathname==='/tables/call_signals'||u.pathname==='/api/call-gateway/signal')&&init&&init.body){var b=JSON.parse(init.body),call=typeof currentCall!=='undefined'&&currentCall||{},base=(call.call_type==='video'||b.mode==='video')?video:voice;return raw(base+'/api/call/signal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:b.to||'',from:b.from||b.sender_id||'',call_id:b.call_id,type:b.type||b.signal_type,sdp:b.sdp||b.payload,timestamp:Date.now()})})}if(u.pathname.indexOf('/api/call-gateway/signals/')===0){var q=new URLSearchParams(u.search),base=q.get('mode')==='video'?video:voice;return raw(base+'/api/call/signals/'+decodeURIComponent(u.pathname.split('/').pop())+u.search)}return raw(input,init)}})();</script>`;

const RESPONSIVE_UI = `<style>
:root{--bt-blue:#0b63ce;--bt-paper:#fff;--bt-surface:#f5f8fc;--bt-text:#142338;--bt-muted:#687c96}html[data-bt-theme="dark"]{--bt-paper:#172333;--bt-surface:#0e1724;--bt-text:#edf5ff;--bt-muted:#a7b6ca;color-scheme:dark}html[data-bt-theme="dark"] body,html[data-bt-theme="dark"] .app-shell,html[data-bt-theme="dark"] .list-panel,html[data-bt-theme="dark"] .main-panel,html[data-bt-theme="dark"] .chat-room{background:var(--bt-surface)!important;color:var(--bt-text)!important}html[data-bt-theme="dark"] .panel-header,html[data-bt-theme="dark"] .chat-header,html[data-bt-theme="dark"] .chat-input-bar,html[data-bt-theme="dark"] .profile-card,html[data-bt-theme="dark"] .modal-box{background:var(--bt-paper)!important;color:var(--bt-text)!important;border-color:#2c415b!important}html[data-bt-theme="dark"] input,html[data-bt-theme="dark"] textarea{background:#101d2c!important;color:var(--bt-text)!important;border-color:#34506e!important}.bt-qr-sheet{position:fixed;inset:0;z-index:100002;display:grid;place-items:center;background:#0009;padding:18px}.bt-qr-card{max-width:360px;width:100%;border-radius:24px;background:var(--bt-paper);color:var(--bt-text);padding:22px;text-align:center;box-shadow:0 20px 60px #0008}.bt-qr-card img{width:min(72vw,256px);height:min(72vw,256px);background:#fff;padding:8px;border-radius:12px}.bt-ban-detail{margin-top:14px;border:0;background:transparent;color:inherit;text-decoration:underline;font-weight:700}.bt-ban-details{margin-top:12px;text-align:left;padding:12px;border-radius:12px;background:#fff2f0;color:#7a2119;white-space:pre-wrap}.bt-ban-details.hidden{display:none}@media (max-width:480px){.app-shell{display:block!important;background:var(--bt-surface)!important}.nav-rail{position:fixed!important;z-index:1000;inset:auto 0 0 0!important;width:100%!important;height:66px!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:0!important;background:var(--bt-paper)!important;border-top:1px solid #dce5f0}.nav-rail .brand,.nav-rail .me-avatar{display:none!important}.nav-rail nav{height:100%;width:100%;display:flex!important;justify-content:space-around!important}.nav-rail .nav-item{flex:1!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;gap:3px!important;font-size:11px!important}.nav-rail .nav-item i{font-size:20px!important}.list-panel,.main-panel{position:fixed!important;inset:0 0 66px 0!important;width:100%!important;max-width:none!important;border:0!important}.main-panel{z-index:5}.list-panel{z-index:4}.chat-header{padding-top:max(10px,env(safe-area-inset-top))!important}.chat-input-bar{padding-bottom:max(10px,env(safe-area-inset-bottom))!important}}@media (min-width:481px) and (max-width:1120px){.app-shell{grid-template-columns:92px minmax(300px,40vw) minmax(0,1fr)!important}.nav-rail{width:auto!important}.nav-rail .nav-item{font-size:13px!important}.list-panel{min-width:300px!important}.main-panel{min-width:0!important}}@media (min-width:1121px){.app-shell{grid-template-columns:96px minmax(350px,420px) minmax(0,1fr)!important}.main-panel{min-width:520px!important}.messages,.chat-input-bar{max-width:980px;margin-inline:auto!important}}</style><script>(function(){var themeKey='bluetalk_theme_v1',turnServers=[],turnReady=false,turnPromise;function toast(s){if(typeof showToast==='function')showToast(s);else console.log(s)}function applyTheme(){document.documentElement.dataset.btTheme=localStorage.getItem(themeKey)||'light'}function ensureTurn(){if(turnPromise)return turnPromise;turnPromise=fetch('/api/turn-credentials',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){turnServers=Array.isArray(j&&j.iceServers)?j.iceServers:[];turnReady=true;return turnServers}).catch(function(){turnReady=true;return[]});return turnPromise}function patchTurn(){if(!window.RTCPeerConnection||window.__btMeteredTurn)return;window.__btMeteredTurn=1;var Native=window.RTCPeerConnection;function BlueTalkPeer(config,legacy){var next=Object.assign({},config||{});if(turnServers.length)next.iceServers=turnServers;return new Native(next,legacy)}BlueTalkPeer.prototype=Native.prototype;try{Object.setPrototypeOf(BlueTalkPeer,Native)}catch(e){}window.RTCPeerConnection=BlueTalkPeer;document.addEventListener('click',function(e){var b=e.target.closest('#voiceCallBtn,#videoCallBtn');if(!b||turnReady)return;e.preventDefault();e.stopImmediatePropagation();b.disabled=true;ensureTurn().finally(function(){b.disabled=false;b.click()})},true)}function ownId(){return String((typeof ME!=='undefined'&&ME&&ME.id)||localStorage.getItem('bt_current_user')||'')}function addFriend(id){var me=ownId();if(!id||!me||id===me)return toast('自分のQRコードは追加できません');Promise.all([fetch('/tables/friendships',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:me,friend_id:id})}),fetch('/tables/friendships',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:id,friend_id:me})})]).then(function(){toast('友だちに追加しました');document.querySelector('[data-view="friends"]')?.click()}).catch(function(){toast('友だち追加に失敗しました')})}function scanQr(){var card=document.querySelector('.bt-qr-card');if(!card)return;var video=document.createElement('video');video.autoplay=true;video.playsInline=true;video.style='width:100%;border-radius:14px;background:#111';card.querySelector('.bt-qr-body').replaceChildren(video);if(!('BarcodeDetector'in window)){card.querySelector('.bt-qr-body').innerHTML='<p>このブラウザではカメラQR読取に対応していません。BlueTalkを最新版のChromeまたはSafariで開いてください。</p>';return}var detector=new BarcodeDetector({formats:['qr_code']});navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}).then(function(stream){video.srcObject=stream;var timer=setInterval(function(){detector.detect(video).then(function(codes){if(!codes.length)return;var raw=String(codes[0].rawValue||'');var id=raw.indexOf('bluetalk:friend:')===0?raw.slice(17):'';if(!id)return;clearInterval(timer);stream.getTracks().forEach(function(t){t.stop()});document.querySelector('.bt-qr-sheet')?.remove();addFriend(id)}).catch(function(){})},350);card.dataset.timer=timer}).catch(function(){card.querySelector('.bt-qr-body').innerHTML='<p>カメラを起動できませんでした。ブラウザのカメラ許可を確認してください。</p>'})}function openQr(mode){var id=ownId();if(!id)return toast('アカウント情報を読み込んでいます');var sheet=document.createElement('div');sheet.className='bt-qr-sheet';var data='bluetalk:friend:'+id;sheet.innerHTML='<div class="bt-qr-card"><h2>'+ (mode==='scan'?'友だち追加QRを読み取る':'友だち追加用QR') +'</h2><div class="bt-qr-body"></div><button class="btn-secondary" style="margin-top:16px">閉じる</button></div>';document.body.appendChild(sheet);sheet.querySelector('button').onclick=function(){clearInterval(Number(sheet.querySelector('.bt-qr-card').dataset.timer||0));sheet.querySelectorAll('video').forEach(function(v){if(v.srcObject)v.srcObject.getTracks().forEach(function(t){t.stop()})});sheet.remove()};if(mode==='scan')return scanQr();sheet.querySelector('.bt-qr-body').innerHTML='<img alt="BlueTalk友だち追加QR" src="https://api.qrserver.com/v1/create-qr-code/?size=320x320&data='+encodeURIComponent(data)+'"><p>BlueTalk内の「QRを読み取る」から追加できます。</p>'}function addQrControls(){var view=document.querySelector('#friendsView');if(!view||document.querySelector('#bt-qr-controls'))return;var box=document.createElement('div');box.id='bt-qr-controls';box.style='display:flex;gap:8px;padding:8px 16px 0';box.innerHTML='<button class="btn-secondary" type="button">自分のQR</button><button class="btn-primary" type="button" style="width:auto;padding:0 14px">QRを読み取る</button>';view.querySelector('.panel-header')?.after(box);var bs=box.querySelectorAll('button');bs[0].onclick=function(){openQr('show')};bs[1].onclick=function(){openQr('scan')}}function addThemeControl(){var panel=document.querySelector('#profileView .profile-card');if(!panel||document.querySelector('#bt-theme-control'))return;var b=document.createElement('button');b.id='bt-theme-control';b.type='button';b.className='btn-secondary';b.style='width:100%;margin-top:10px';b.textContent='ダークモードを切り替え';panel.appendChild(b);b.onclick=function(){localStorage.setItem(themeKey,document.documentElement.dataset.btTheme==='dark'?'light':'dark');applyTheme()}}function banOverlay(status){if(!status.banned||document.querySelector('#bt-ban-overlay'))return;var d=document.createElement('div');d.id='bt-ban-overlay';d.className='bt-qr-sheet';d.innerHTML='<div class="bt-qr-card"><div style="font-size:42px">⛔</div><h2>お使いのアカウントは停止されました</h2><p>利用規約に違反したため、お使いのアカウントは停止されました。</p><button class="bt-ban-detail">詳細を表示</button><div class="bt-ban-details hidden"></div></div>';var detail=d.querySelector('.bt-ban-details');detail.textContent=status.message||status.reason||'管理者からの停止理由は登録されていません。';if(status.appealMessage)detail.textContent+='\\n\\n誤Banに関するご案内\\n'+status.appealMessage;d.querySelector('.bt-ban-detail').onclick=function(){detail.classList.toggle('hidden')};document.body.appendChild(d)}function checkBan(){var id=ownId();if(!id)return;fetch('/api/account-status/'+encodeURIComponent(id),{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(s){if(s)banOverlay(s)}).catch(function(){})}function install(){applyTheme();patchTurn();ensureTurn();addQrControls();addThemeControl();checkBan()}new MutationObserver(install).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',install);setInterval(checkBan,30000);install()})();</script>`;

async function enhanceHtml(response) {
  const type = response.headers.get('content-type') || ''; if (!type.includes('text/html')) return response;
  const text = await response.text();
  const withManifest = text.includes('</head>') ? text.replace('</head>', '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="https://api.iconify.design/ic:baseline-chat-bubble.svg?color=%231877f2"></head>') : text;
  return new Response(withManifest.replace('</body>', APP_ENHANCEMENTS + AVATAR_LEAK_GUARD + FILE_UPLOAD_FALLBACK + RECOVERY_SCRIPT + CALL_FETCH_GATE + RESPONSIVE_UI + '</body>'), { status: response.status, headers: { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store', 'X-BlueTalk-Source': 'genspark-ui-cloudflare-kv' } });
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
