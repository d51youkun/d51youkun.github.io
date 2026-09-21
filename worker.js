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

function pwaManifest() {
  return new Response(JSON.stringify({ name: 'BlueTalk', short_name: 'BlueTalk', start_url: '/index.html', display: 'standalone', background_color: '#fff', theme_color: '#1877f2', icons: [{ src: 'https://api.iconify.design/ic:baseline-chat-bubble.svg?color=%231877f2', sizes: 'any', type: 'image/svg+xml' }] }), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
}

function serviceWorker() {
  return new Response("self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>cs[0]?.focus()||clients.openWindow('/app.html')))});", { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' } });
}

const TERMS_NOTICE = `<div id="bluetalk-terms" style="position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui"><div style="max-width:720px;max-height:88vh;overflow:auto;background:#fff;border-radius:20px;padding:24px;color:#24344d;box-shadow:0 20px 60px #0004"><h2>BlueTalk 利用規約</h2><p>本規約は、本サービス「BlueTalk」（以下「本サービス」）の利用条件を定めるものです。利用者は、本サービスを利用することで本規約に同意したものとみなします。</p><h3>第1条（適用）</h3><p>本規約は、本サービスの利用に関わる一切の関係に適用されます。</p><h3>第2条（サービスの性質）</h3><p>本サービスは、個人が非営利で運営する友人・知人向けのチャットサービスです。法人・営利目的の利用は想定していません。</p><h3>第3条（利用資格）</h3><p>本サービスは、運営者から招待・案内を受けた者のみ利用できます。未成年者は保護者の同意を得て利用してください。</p><h3>第4条（禁止事項）</h3><p>法令・公序良俗違反、なりすまし、誹謗中傷・嫌がらせ、第三者の著作権・肖像権等の侵害、過度な負荷や不正アクセス、その他運営者が不適切と判断する行為を禁止します。</p><h3>第5条（スタンプ）</h3><p>登録画像URLは利用者自身の責任で登録してください。LINEスタンプ等、第三者が著作権を有する画像の無断利用による問題について運営者は責任を負いません。</p><h3>第6条（停止・変更・終了）</h3><p>運営者は事前通知なく内容を変更、停止、終了できます。</p><h3>第7条（データ）</h3><p>データの保存・バックアップは保証されず、通信障害・サーバー障害等で消失・破損する可能性があります。</p><h3>第8条（免責）</h3><p>安全性、正確性、動作保証等を保証せず、利用により生じた損害について責任を負いません。</p><h3>第9条（変更）</h3><p>変更後の規約は本サービス上に掲示した時点から効力を生じます。</p><h3>第10条（準拠法）</h3><p>日本法を準拠法とします。</p><h2>BlueTalk プライバシーポリシー</h2><p>アカウント情報、トーク履歴、友だちリスト、登録スタンプ画像URL、通話接続に必要な通信情報を取得・保存し、サービス提供・改善、不具合対応、不正利用防止に利用します。法令に基づく場合を除き、同意なく第三者へ提供しません。</p><p>データはCloudflare Workers上で保存・処理され、完全な永続性や安全性は保証されません。利用者は設定から自身のアカウント情報を変更・削除できます。未成年者は保護者の同意を得て利用してください。</p><p style="color:#8a3b12">管理者は、規約違反や安全上の問題を調査する必要がある場合、個人・グループを含む会話の内容、送信者、時刻を確認することがあります。</p><button id="bluetalk-terms-ok" style="width:100%;padding:12px;border:0;border-radius:12px;background:#1877f2;color:#fff;font-weight:700">同意して利用する</button></div></div>`;

const APP_ENHANCEMENTS = `<script>(function(){
  const termsKey='bluetalk_terms_v2';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function addProfileTools(){const panel=document.querySelector('#profileView .profile-card');if(!panel||document.querySelector('#bluetalk-extra-tools'))return;const box=document.createElement('div');box.id='bluetalk-extra-tools';box.style='margin-top:14px;display:grid;gap:8px';box.innerHTML='<button id="bluetalk-notify" class="btn-secondary">通知を許可</button><button id="bluetalk-delete" class="btn-secondary" style="color:#b42318">アカウントを削除</button><small>名前とアカウントIDは1か月に1回変更できます。</small>';panel.appendChild(box);box.querySelector('#bluetalk-notify').onclick=async()=>{if('Notification'in window){const p=await Notification.requestPermission();alert(p==='granted'?'通知を許可しました':'通知は許可されませんでした')}};box.querySelector('#bluetalk-delete').onclick=async()=>{if(!confirm('アカウントと関連データを削除しますか？この操作は戻せません。'))return;const id=localStorage.getItem('bt_current_user');if(!id)return;const r=await fetch('/tables/users/'+encodeURIComponent(id),{method:'DELETE'});if(r.ok){localStorage.clear();location.href='/index.html'}else alert('削除に失敗しました')}}
  function terms(){if(location.pathname.endsWith('index.html')&&!localStorage.getItem(termsKey)){document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(TERMS_NOTICE)});document.querySelector('#bluetalk-terms-ok').onclick=()=>{localStorage.setItem(termsKey,'1');document.querySelector('#bluetalk-terms').remove()}}}
  let keys='';let last=0;function adminTrigger(e){const now=Date.now();if(now-last>4000)keys='';last=now;keys+=(e.key||'');if(keys.length>40)keys=keys.slice(-40);if(keys.endsWith('d51-498go'))showAdminLogin()}
  function showAdminLogin(){if(document.querySelector('#bluetalk-admin-login'))return;const d=document.createElement('div');d.id='bluetalk-admin-login';d.style='position:fixed;inset:0;z-index:100000;background:#0008;display:grid;place-items:center;padding:20px';d.innerHTML='<div style="background:#fff;border-radius:18px;padding:22px;width:min(420px,100%);color:#24344d"><h2>管理者ログイン</h2><input id="bt-admin-pass" type="password" placeholder="管理者コード" style="width:100%;padding:12px;margin:8px 0"><button id="bt-admin-submit" style="width:100%;padding:12px;background:#1877f2;color:#fff;border:0;border-radius:10px">ログイン</button><button id="bt-admin-close" style="width:100%;padding:10px;margin-top:8px">閉じる</button></div>';document.body.appendChild(d);d.querySelector('#bt-admin-close').onclick=()=>d.remove();d.querySelector('#bt-admin-submit').onclick=async()=>{const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:d.querySelector('#bt-admin-pass').value})});const j=await r.json();if(!r.ok)return alert('認証に失敗しました');d.remove();showAdminPanel(j.token)}}
  function showAdminPanel(token){if(document.querySelector('#bluetalk-admin-panel'))return;const d=document.createElement('div');d.id='bluetalk-admin-panel';d.style='position:fixed;inset:0;z-index:100000;background:#0008;padding:20px;overflow:auto';d.innerHTML='<div style="background:#fff;border-radius:18px;padding:22px;max-width:900px;margin:auto;color:#24344d"><div style="display:flex;justify-content:space-between;align-items:center"><h2>BlueTalk 管理画面</h2><button id="bt-admin-close">閉じる</button></div><p style="color:#8a3b12">会話監視は利用規約に基づく安全・規約違反調査のための機能です。</p><div id="bt-admin-users">読み込み中…</div><h3>会話監視</h3><div id="bt-admin-conversations">読み込み中…</div></div>';document.body.appendChild(d);d.querySelector('#bt-admin-close').onclick=()=>d.remove();const h={Authorization:'Bearer '+token};fetch('/api/admin/users',{headers:h}).then(r=>r.json()).then(j=>{d.querySelector('#bt-admin-users').innerHTML='<h3>ユーザー管理</h3>'+j.users.map(u=>'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #eee;padding:10px 0"><b>'+esc(u.display_name)+'</b><span>@'+esc(u.username)+'</span><button data-ban="'+esc(u.id)+'">'+(u.banned?'解除':'Ban')+'</button><button data-verify="'+esc(u.id)+'">'+(u.verified?'認証解除':'BlueTalkPremium')+'</button><button data-gold="'+esc(u.id)+'">ゴールド称号</button></div>').join('');d.querySelectorAll('[data-ban],[data-verify],[data-gold]').forEach(b=>b.onclick=async()=>{const id=b.dataset.ban||b.dataset.verify||b.dataset.gold;const u=j.users.find(x=>x.id===id)||{};const body=b.dataset.ban?{banned:!u.banned}:b.dataset.verify?{verified:!u.verified}:{title:'ゴールド'};await fetch('/api/admin/users/'+encodeURIComponent(id),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify(body)});showAdminPanel(token);d.remove()})});fetch('/api/admin/conversations',{headers:h}).then(r=>r.json()).then(j=>{const us=Object.fromEntries(j.users.map(u=>[u.id,u.display_name||u.username]));const by={};j.messages.forEach(m=>(by[m.conversation_id]??=[]).push('<b>'+esc(us[m.sender_id]||m.sender_id)+'</b>: '+esc(m.content||'[スタンプ]')));d.querySelector('#bt-admin-conversations').innerHTML=j.conversations.map(c=>'<details><summary>'+esc(c.name||c.id)+'</summary><div style="padding:8px">'+(by[c.id]||[]).join('<br>')+'</div></details>').join('')||'会話はありません'})}
  function exactFriendSearch(){const input=document.querySelector('#friendSearchInput');if(!input||input.dataset.btExact)return;input.dataset.btExact='1';input.addEventListener('input',async e=>{e.stopImmediatePropagation();const q=input.value.trim();const box=document.querySelector('#friendSearchResult');if(!q){box.innerHTML='';return}try{const j=await fetch('/tables/users?limit=1000').then(r=>r.json());const me=localStorage.getItem('bt_current_user');const u=(j.data||[]).find(x=>x.id!==me&&String(x.username||'')===q);if(!u){box.innerHTML='<p style="padding:10px 18px;color:var(--bt-text-light);font-size:13px">完全一致するIDが見つかりません</p>';return}box.innerHTML='<div class="friend-row"><img src="'+esc(u.avatar_url||'')+'" alt=""><div class="info"><div class="name">'+esc(u.display_name)+'</div><div class="status">@'+esc(u.username)+'</div></div><div class="row-actions"><button class="mini-btn" data-add="'+esc(u.id)+'">追加</button></div></div>';box.querySelector('[data-add]').onclick=async()=>{const b=box.querySelector('[data-add]');b.disabled=true;await fetch('/tables/friendships',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:me,friend_id:u.id})});await fetch('/tables/friendships',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:u.id,friend_id:me})});b.textContent='追加済';};}catch(err){box.innerHTML='<p style="padding:10px 18px;color:#b42318">検索に失敗しました</p>'}},true)}
  function addQrButton(){const view=document.querySelector('#friendsView');if(!view||document.querySelector('#bluetalk-my-qr'))return;const b=document.createElement('button');b.id='bluetalk-my-qr';b.className='btn-secondary';b.textContent='自分のQRを表示';b.style='margin:8px 16px';view.querySelector('h2,header, .view-header')?.after(b);b.onclick=()=>{const id=localStorage.getItem('bt_current_user');const box=document.createElement('div');box.style='position:fixed;inset:0;z-index:99998;background:#0008;display:grid;place-items:center';box.innerHTML='<div style="background:#fff;border-radius:18px;padding:22px;text-align:center"><h3>BlueTalkの友だち追加QR</h3><img alt="QR" width="240" height="240" src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&data='+encodeURIComponent(location.origin+'/index.html?add='+id)+'"><p style="font-size:12px;color:#667">QRはBlueTalkの友だち追加用です</p><button>閉じる</button></div>';document.body.appendChild(box);box.querySelector('button').onclick=()=>box.remove()}}
  new MutationObserver(()=>{addProfileTools();exactFriendSearch();addQrButton()}).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('keydown',adminTrigger);document.addEventListener('DOMContentLoaded',()=>{terms();addProfileTools();exactFriendSearch();addQrButton();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{})});
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
