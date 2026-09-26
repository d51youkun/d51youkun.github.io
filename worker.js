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

function adminTokenIdentity(request) {
  const token = requestAdminToken(request) || '';
  return token ? token.slice(0, 8) : '';
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
    const key = `bluetalk:media:${id}:${store[2]}`;
    const ctype = String(request.headers.get('Content-Type') || '').toLowerCase();
    if (ctype.indexOf('application/octet-stream') === 0) {
      // 生バイナリ経路: ストリームのまま KV へ（メモリ・CPU を消費しない）
      const len = Number(request.headers.get('Content-Length') || 0);
      if (!request.body) return json({ ok: false, error: 'missing chunk' }, 400, undefined);
      if (len > KV_PART_BYTES) return json({ ok: false, error: 'chunk_too_large', maxChunkBytes: KV_PART_BYTES }, 413, undefined);
      await env.BLUETALK_KV.put(key, request.body);
      return json({ ok: true, bytes: len, encoding: 'binary' }, 200, undefined);
    }
    // 旧経路（base64 文字列）: 既存データとの互換のため残す
    const body = await request.json().catch(() => ({}));
    const data = String(body.data || '');
    if (!data) return json({ ok: false, error: 'missing chunk' }, 400, undefined);
    await env.BLUETALK_KV.put(key, data);
    return json({ ok: true, encoding: 'base64' }, 200, undefined);
  }
  if (request.method === 'POST' && url.pathname.endsWith('/complete')) {
    const body = await request.json().catch(() => ({}));
    const total = Math.max(1, Number(body.totalChunks || 1));
    const mime = String(body.mimeType || 'application/octet-stream').slice(0, 120);
    const encoding = body.encoding === 'binary' ? 'binary' : 'base64';
    const sizeBytes = Number(body.sizeBytes || 0);
    const limitCfg = await readSettings(env);
    if (sizeBytes > limitCfg.maxFileBytes) return json({ ok: false, error: 'too_large', maxFileBytes: limitCfg.maxFileBytes }, 413, origin);
    const chunkBytes = Number(body.chunkBytes || 0) || (encoding === 'binary' ? KV_PART_BYTES : 0);
    const metaObj = { totalChunks: total, mimeType: mime, sizeBytes, chunkBytes, encoding, created_at: Date.now() };
    await env.BLUETALK_KV.put(`bluetalk:media:${id}:meta`, JSON.stringify(metaObj), { metadata: { sizeBytes, mimeType: mime.slice(0, 60), encoding } });
    return json({ ok: true, url: `/bt-media/${id}` }, 201, undefined);
  }
  if (request.method === 'GET' && !url.pathname.endsWith('/complete') && store[2] === undefined) {
    const metaRaw = await env.BLUETALK_KV.get(`bluetalk:media:${id}:meta`);
    if (!metaRaw) return new Response('Not found', { status: 404 });
    const meta = JSON.parse(metaRaw);
    const headers0 = { 'Content-Type': meta.mimeType, 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' };
    const binary = meta.encoding === 'binary';
    const totalBytes = Number(meta.sizeBytes || 0);
    const chunkBytes = Number(meta.chunkBytes || 0) || (binary ? KV_PART_BYTES : 0);
    if (!totalBytes || !chunkBytes) {
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
      return new Response(bytes, { headers: headers0 });
    }
    const getChunk = async (i) => {
      for (let t = 0; t < 3; t++) {
        const c = binary
          ? await env.BLUETALK_KV.get(`bluetalk:media:${id}:${i}`, 'arrayBuffer')
          : await env.BLUETALK_KV.get(`bluetalk:media:${id}:${i}`);
        if (c !== null) return c;
        await new Promise((r) => setTimeout(r, 400));
      }
      return null;
    };
    const decodeChunk = (raw0) => {
      let s = raw0;
      if (s.charCodeAt(0) === 100 && s.indexOf('data:') === 0) { const cm = s.indexOf(','); if (cm >= 0) s = s.slice(cm + 1); }
      const bin = atob(s);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    };
    const asBytes = (raw0) => (binary ? new Uint8Array(raw0) : decodeChunk(raw0));
    let start = 0, end = totalBytes - 1, partial = false;
    const range = request.headers.get('Range');
    const rm = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (rm) {
      if (rm[1] === '' && rm[2]) { start = Math.max(0, totalBytes - Number(rm[2])); end = totalBytes - 1; }
      else { start = Number(rm[1] || 0); end = rm[2] ? Math.min(Number(rm[2]), totalBytes - 1) : totalBytes - 1; }
      if (Number.isNaN(start) || start > end || start >= totalBytes) return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${totalBytes}` } });
      partial = true;
    }
    const i0 = Math.floor(start / chunkBytes), iN = Math.floor(end / chunkBytes);
    let chunkStart = i0 * chunkBytes, ci = i0;
    // 生バイナリはチャンクが大きいので、1回の pull で抱えるメモリを抑える
    const BATCH = binary ? 2 : 6;
    const stream = new ReadableStream({
      async pull(ctrl) {
        for (let b = 0; b < BATCH; b++) {
          if (ci > iN) { ctrl.close(); return; }
          const raw0 = await getChunk(ci);
          if (raw0 === null) { ctrl.error(new Error('media chunk missing')); return; }
          let bytes = asBytes(raw0);
          const cs = chunkStart; chunkStart += bytes.length; ci++;
          if (partial) {
            const s2 = Math.max(cs, start), e2 = Math.min(cs + bytes.length - 1, end);
            if (e2 < s2) continue;
            bytes = bytes.slice(s2 - cs, e2 - cs + 1);
          }
          ctrl.enqueue(bytes);
        }
      }
    });
    if (partial) { headers0['Content-Range'] = `bytes ${start}-${end}/${totalBytes}`; headers0['Content-Length'] = String(end - start + 1); }
    else headers0['Content-Length'] = String(totalBytes);
    return new Response(stream, { status: partial ? 206 : 200, headers: headers0 });
  }
  return null;
}

// ===== 大容量メディア（Cloudflare R2 マルチパート） =====
// 8K・数分の動画は数GBになり、KV（値25MiB上限 / 無料枠1GB）には格納できない。
// R2 バインディング BLUETALK_MEDIA があればマルチパートへ中継し、無ければ 503 を返す
// （クライアントは従来の KV 経路へ自動フォールバックする）。
const BIG_MAX_BYTES = 6 * 1024 * 1024 * 1024;
const BIG_PART_BYTES = 32 * 1024 * 1024;
// KV 経路: 値サイズ上限 25MiB に対し余裕をみて 8MiB。
// 生バイナリで格納するため base64 の 33% 膨張がなく、書き込み回数も大幅に減る。
const KV_PART_BYTES = 8 * 1024 * 1024;
const KV_FREE_STORAGE_BYTES = 1024 * 1024 * 1024;

const SETTINGS_KEY = 'bluetalk:settings';
const GIB = 1024 * 1024 * 1024;
const MIN_FILE_BYTES = 8 * 1024 * 1024;
const HARD_MAX_BYTES = 100 * GIB;

// 上限は管理画面（/admin.html）から設定でき、KV に保存して即時反映する。
// 未設定のときは Worker 変数（BT_MAX_FILE_BYTES / BT_MAX_TRANSFER_BYTES）、
// それも無ければ既定値を使う。
async function readSettings(env) {
  let stored = {};
  try {
    const raw = await env.BLUETALK_KV.get(SETTINGS_KEY);
    if (raw) stored = JSON.parse(raw) || {};
  } catch (e) { stored = {}; }
  const pick = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : d; };
  const envFile = Number((env && env.BT_MAX_FILE_BYTES) || 0);
  const envTransfer = Number((env && env.BT_MAX_TRANSFER_BYTES) || 0);
  const fallbackFile = envFile > 0 ? envFile : (bigMediaEnabled(env) ? BIG_MAX_BYTES : 900 * 1024 * 1024);
  const clamp = (n) => Math.max(MIN_FILE_BYTES, Math.min(HARD_MAX_BYTES, n));
  const maxFileBytes = clamp(pick(stored.maxFileBytes, fallbackFile));
  let maxTransferBytes = pick(stored.maxTransferBytes, 0);
  if (Number(stored.maxTransferBytes) === 0) maxTransferBytes = 0;
  if (envTransfer > 0 && !Number(stored.maxTransferBytes)) maxTransferBytes = envTransfer;
  maxTransferBytes = Math.max(0, Math.min(HARD_MAX_BYTES, maxTransferBytes));
  return {
    maxFileBytes,
    maxTransferBytes,
    kvPartBytes: KV_PART_BYTES,
    kvStorageBytes: KV_FREE_STORAGE_BYTES,
    updated_at: Number(stored.updated_at || 0),
    updated_by: String(stored.updated_by || '')
  };
}

// メディア使用量（KV list のメタデータ利用。旧データのみ値を読んで補完）
async function mediaUsage(env) {
  const out = { files: 0, bytes: 0, listing_capped: false, kvStorageBytes: KV_FREE_STORAGE_BYTES };
  try {
    let cursor;
    let guard = 0;
    const metaKeys = [];
    do {
      const page = await env.BLUETALK_KV.list({ prefix: 'bluetalk:media:', cursor });
      for (const k of page.keys) if (k.name.endsWith(':meta')) metaKeys.push(k);
      cursor = page.list_complete ? undefined : page.cursor;
      guard++;
    } while (cursor && guard < 5);
    if (cursor) out.listing_capped = true;
    let fallbackReads = 0;
    for (const k of metaKeys) {
      let size = Number((k.metadata && k.metadata.sizeBytes) || 0);
      if (!size && fallbackReads < 200) {
        fallbackReads++;
        const raw = await env.BLUETALK_KV.get(k.name);
        if (raw) { try { size = Number(JSON.parse(raw).sizeBytes || 0); } catch (e) { size = 0; } }
      }
      if (size > 0) { out.files++; out.bytes += size; }
    }
  } catch (e) { /* 集計できなくても管理画面は動かす */ }
  return out;
}

function bigMediaEnabled(env) { return Boolean(env && env.BLUETALK_MEDIA); }

function bigRangeHeader(range, size) {
  if (!range) return null;
  if (typeof range.suffix === 'number') {
    const start = Math.max(0, size - range.suffix);
    return { header: 'bytes ' + start + '-' + (size - 1) + '/' + size, length: size - start };
  }
  const start = Number(range.offset || 0);
  const length = Number(range.length || (size - start));
  return { header: 'bytes ' + start + '-' + (start + length - 1) + '/' + size, length };
}

async function handleBtBig(request, env, url, origin) {
  if (url.pathname === '/bt-big/config') {
    const cfg = await readSettings(env);
    const base = { ok: true, enabled: bigMediaEnabled(env), partSize: BIG_PART_BYTES, minPartBytes: 5 * 1024 * 1024, maxBytes: BIG_MAX_BYTES, kvPartBytes: KV_PART_BYTES, kvStorageBytes: KV_FREE_STORAGE_BYTES, maxFileBytes: cfg.maxFileBytes, maxTransferBytes: cfg.maxTransferBytes, kvReadOnly: false };
    if (url.searchParams.get('usage') === '1') {
      const u = await mediaUsage(env);
      const used = Number(u.bytes || 0);
      return json(Object.assign(base, { usedBytes: used, remainingBytes: Math.max(0, KV_FREE_STORAGE_BYTES - used) }), 200, origin);
    }
    return json(base, 200, origin);
  }
  const m = /^\/bt-big\/([A-Za-z0-9-]{6,64})(?:\/(init|complete|abort)|\/part\/(\d+))?$/.exec(url.pathname);
  if (!m) return null;
  const id = m[1];
  const action = m[2] || '';
  const partNo = m[3] ? Number(m[3]) : 0;
  const metaKey = 'bluetalk:big:' + id + ':meta';
  if (!bigMediaEnabled(env)) return json({ ok: false, error: 'r2_disabled' }, 503, origin);
  const bucket = env.BLUETALK_MEDIA;

  if (request.method === 'POST' && action === 'init') {
    const body = await request.json().catch(() => ({}));
    const mime = String(body.mimeType || 'application/octet-stream').slice(0, 120);
    const name = String(body.name || '').slice(0, 200);
    const sizeBytes = Math.max(0, Number(body.sizeBytes || 0));
    if (sizeBytes > BIG_MAX_BYTES) return json({ ok: false, error: 'too_large', maxBytes: BIG_MAX_BYTES }, 413, origin);
    const mp = await bucket.createMultipartUpload('media/' + id, { httpMetadata: { contentType: mime } });
    await env.BLUETALK_KV.put(metaKey, JSON.stringify({ uploadId: mp.uploadId, key: 'media/' + id, mime, name, sizeBytes, done: false, created_at: Date.now() }));
    return json({ ok: true, uploadId: mp.uploadId, partSize: BIG_PART_BYTES, minPartBytes: 5 * 1024 * 1024, maxBytes: BIG_MAX_BYTES }, 201, origin);
  }

  const metaRaw = await env.BLUETALK_KV.get(metaKey);
  if (!metaRaw) return json({ ok: false, error: 'not_found' }, 404, origin);
  const meta = JSON.parse(metaRaw);

  if (request.method === 'PUT' && action === 'part' && partNo >= 1 && partNo <= 10000) {
    if (!request.body) return json({ ok: false, error: 'empty_part' }, 400, origin);
    const mp = bucket.resumeMultipartUpload(meta.key, meta.uploadId);
    const uploaded = await mp.uploadPart(partNo, request.body);
    return json({ ok: true, partNumber: partNo, etag: uploaded.etag }, 200, origin);
  }

  if (request.method === 'POST' && action === 'complete') {
    const body = await request.json().catch(() => ({}));
    const parts = (Array.isArray(body.parts) ? body.parts : [])
      .map((p) => ({ partNumber: Number(p.partNumber || p.n || 0), etag: String(p.etag || '') }))
      .filter((p) => p.partNumber >= 1 && p.etag);
    if (!parts.length) return json({ ok: false, error: 'no_parts' }, 400, origin);
    parts.sort((a, b) => a.partNumber - b.partNumber);
    const mp = bucket.resumeMultipartUpload(meta.key, meta.uploadId);
    const obj = await mp.complete(parts);
    meta.done = true;
    meta.parts = parts.length;
    meta.sizeBytes = Number(body.sizeBytes || meta.sizeBytes || (obj && obj.size) || 0);
    meta.completed_at = Date.now();
    await env.BLUETALK_KV.put(metaKey, JSON.stringify(meta));
    return json({ ok: true, url: '/bt-big/' + id, sizeBytes: meta.sizeBytes, parts: parts.length }, 201, origin);
  }

  if (request.method === 'POST' && action === 'abort') {
    try { await bucket.resumeMultipartUpload(meta.key, meta.uploadId).abort(); } catch (e) {}
    await env.BLUETALK_KV.delete(metaKey);
    return json({ ok: true }, 200, origin);
  }

  if (request.method === 'DELETE' && !action) {
    if (!await isAdmin(request, env)) return json({ ok: false, error: 'forbidden' }, 403, origin);
    try { await bucket.delete(meta.key); } catch (e) {}
    await env.BLUETALK_KV.delete(metaKey);
    return json({ ok: true }, 200, origin);
  }

  if (request.method === 'GET' && !action && meta.done) {
    const obj = await bucket.get(meta.key, { range: request.headers.get('Range') ? request.headers : undefined });
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    if (!headers.get('Content-Type')) headers.set('Content-Type', meta.mime || 'application/octet-stream');
    headers.set('ETag', obj.httpEtag);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    const r = bigRangeHeader(obj.range, obj.size);
    if (r) {
      headers.set('Content-Range', r.header);
      headers.set('Content-Length', String(r.length));
      return new Response(obj.body, { status: 206, headers });
    }
    headers.set('Content-Length', String(obj.size));
    return new Response(obj.body, { status: 200, headers });
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
    if (table === 'messages') {
      let __light = false;
      try { __light = (url.searchParams.get('bt_light') === '1'); } catch (e) {}
      if (__light) { for (let __i = 0; __i < rows.length; __i++) { const __r = rows[__i];
        if (__r && __r.media_data) { __r.bt_media_len = String(__r.media_data).length; __r.bt_pending = 1; __r.media_data = ''; } } }
    }

  if (request.method === 'GET' && !id) {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 1000);
    const page = Math.max(Number(url.searchParams.get('page') || 1), 1);
    const start = (page - 1) * limit;
    let base = rows;
    const btConv = table === 'messages' ? url.searchParams.get('bt_conv') : null;
    if (btConv) base = rows.filter((item) => String(item.conversation_id) === btConv);
    const visibleRows = table === 'users' ? base.filter((item) => !item.banned) : base;
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
  if (url.pathname === '/api/admin/settings' && request.method === 'GET') {
    return json({ ok: true, settings: await readSettings(env), storage: await mediaUsage(env) }, 200, origin);
  }
  if (url.pathname === '/api/admin/settings' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const cur = await readSettings(env);
    const toBytes = (v) => Math.round(Number(v) * GIB);
    const clamp = (n) => Math.max(MIN_FILE_BYTES, Math.min(HARD_MAX_BYTES, n));
    let maxFileBytes = cur.maxFileBytes;
    let maxTransferBytes = cur.maxTransferBytes;
    if (body.maxFileBytesGb !== undefined && body.maxFileBytesGb !== '') {
      const n = toBytes(body.maxFileBytesGb);
      if (!Number.isFinite(n) || n <= 0) return json({ ok: false, error: 'invalid_max_file' }, 400, origin);
      maxFileBytes = clamp(n);
    }
    if (body.maxTransferBytesGb !== undefined && body.maxTransferBytesGb !== '') {
      const n = toBytes(body.maxTransferBytesGb);
      if (!Number.isFinite(n) || n < 0) return json({ ok: false, error: 'invalid_max_transfer' }, 400, origin);
      maxTransferBytes = n === 0 ? 0 : Math.min(HARD_MAX_BYTES, n);
    }
    const payload = { maxFileBytes, maxTransferBytes, updated_at: Date.now(), updated_by: adminTokenIdentity(request) };
    await env.BLUETALK_KV.put(SETTINGS_KEY, JSON.stringify(payload));
    return json({ ok: true, settings: await readSettings(env), storage: await mediaUsage(env) }, 200, origin);
  }
  if (url.pathname === '/api/admin/storage' && request.method === 'GET') {
    return json({ ok: true, storage: await mediaUsage(env), settings: await readSettings(env) }, 200, origin);
  }
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
  const heal = "self.addEventListener('install',e=>{self.skipWaiting()});self.addEventListener('activate',e=>{e.waitUntil((async()=>{try{const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)))}catch(x){}try{await self.registration.unregister()}catch(x){}try{const cs=await self.clients.matchAll({type:'window'});cs.forEach(c=>c.navigate(c.url))}catch(x){}})())});self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>cs[0]?.focus()||clients.openWindow('/app.html')))});";
  return new Response(heal, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' } });
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
  const m = url.pathname.match(/^\/api\/line-stickers\/(\d{4,12})$/);
  if (!m) return null;
  const pid = m[1];
  const cacheKey = `bluetalk:linepack:v3:${pid}`;
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
  let animated = false;
  try {
    const probeUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${ids[0]}/iphone/sticker_animation@2x.png?v=1`;
    const head = await fetch(probeUrl, { method: 'HEAD', headers });
    if (head.ok) animated = true;
    else if (head.status === 405 || head.status === 501) {
      const g = await fetch(probeUrl, { headers });
      animated = g.ok;
    }
  } catch (e) { animated = false; }
  let sound = false;
  try {
    const soundUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${ids[0]}/iphone/sticker_sound.m4a?v=1`;
    const sh = await fetch(soundUrl, { method: 'HEAD', headers });
    if (sh.ok) sound = true;
    else if (sh.status === 405 || sh.status === 501) { const g = await fetch(soundUrl, { headers }); sound = g.ok; }
  } catch (e) { sound = false; }
  const variant = animated ? 'iphone/sticker_animation.png' : 'android/sticker.png';
  const stickers = ids.map((sid) => `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sid}/${variant}?v=1`);
  const sounds = sound ? ids.map((sid) => `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sid}/iphone/sticker_sound.m4a?v=1`) : null;
  const payload = { ok: true, title, productId: pid, animated, sound, stickers, sounds };
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
  async function dashboard(){const t=localStorage.getItem('bluetalk_admin_token');if(!t)return login();const h={Authorization:'Bearer '+t};const [ur,cr,ar]=await Promise.all([fetch('/api/admin/users',{headers:h}),fetch('/api/admin/conversations',{headers:h}),fetch('/api/admin/appeals',{headers:h}).catch(function(){return {ok:false}})]);if(!ur.ok||!cr.ok||!ar.ok){localStorage.removeItem('bluetalk_admin_token');return login()}const u=(await ur.json()).users||[], c=await cr.json(), ap=ar.ok?((await ar.json()).appeals||[]):[], names=Object.fromEntries(u.map(x=>[x.id,x.display_name||x.username]));root.innerHTML='<h1>BlueTalk 管理画面</h1><p><button id="logout" class="gray">管理者ログアウト</button>　<small>会話監視は利用規約に基づく安全・規約違反調査のために使用してください。</small></p><section class="card"><h2>アカウント管理・Ban情報</h2><p><small>Ban時は理由と利用者への案内文を保存します。解除時も誤Banについての案内文を登録できます。</small></p><div id="users"></div></section><section class="card"><h2>会話監視</h2><div id="convs"></div></section><section class="card"><h2>誤Ban申し立て（利用者から管理者へ）</h2><div id="appeals"></div></section><section class="card"><h2>アップロード上限設定</h2><div id="limitsCard">読み込み中...</div></section>';document.getElementById('logout').onclick=()=>{localStorage.removeItem('bluetalk_admin_token');login()};limits();document.getElementById('users').innerHTML=u.map(x=>'<div class="row"><b>'+esc(x.display_name)+'</b><span>@'+esc(x.username)+'</span>'+(x.verified?' <span style="color:#d7a600;font-size:18px">✓</span>':'')+(x.title?' <span style="color:#b8860b">'+esc(x.title)+'</span>':'')+(x.banned?' <span class="danger">停止中</span>':'')+'<button data-act="verify" data-id="'+esc(x.id)+'">'+(x.verified?'認証解除':'Premium認証')+'</button><button data-act="ban" data-id="'+esc(x.id)+'">'+(x.banned?'Ban解除':'Ban')+'</button><input data-title="'+esc(x.id)+'" placeholder="ゴールド称号" value="'+esc(x.title||'')+'"><button data-act="title" data-id="'+esc(x.id)+'">称号を保存</button>'+(x.banned?'<small>理由: '+esc(x.ban_reason||'未登録')+'</small>':'')+'<button data-act="pass" data-id="'+esc(x.id)+'">パスワード変更</button><button data-act="del" data-id="'+esc(x.id)+'">強制削除</button></div>').join('')||'アカウントはありません';document.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{const id=b.dataset.id, one=u.find(x=>x.id===id);let body;if(b.dataset.act==='verify'){body={verified:!one.verified}}else if(b.dataset.act==='ban'){if(one.banned){const appeal=prompt('誤Ban・解除に関する利用者へのメッセージ（任意）',one.ban_appeal_message||'');if(appeal===null)return;body={banned:false,ban_appeal_message:appeal}}else{const reason=prompt('Ban理由（利用規約のどの違反か）','');if(reason===null||!reason.trim())return;const message=prompt('利用者に表示する詳しい案内文（任意）','');if(message===null)return;body={banned:true,ban_reason:reason,ban_message:message,ban_appeal_message:''}}}else if(b.dataset.act==='pass'){const np=prompt('このアカウントの新しいパスワードを入力してください（パスワードを強制変更）','');if(!np||!np.trim())return;body={password:np}}else if(b.dataset.act==='del'){if(!confirm('このアカウントを強制削除しますか？利用者の全データ（会話・メッセージ等）が削除され、元に戻せません。'))return;await fetch('/api/admin/users/'+encodeURIComponent(id),{method:'DELETE',headers:h});dashboard();return}else{body={title:document.querySelector('[data-title="'+CSS.escape(id)+'"]').value,admin_override:true}}await fetch('/api/admin/users/'+encodeURIComponent(id),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify(body)});dashboard()});const by={};(c.messages||[]).forEach(m=>(by[m.conversation_id]??=[]).push('<b>'+esc(names[m.sender_id]||m.sender_id)+'</b>: '+esc(m.content||'[スタンプ]')));document.getElementById('convs').innerHTML=(c.conversations||[]).map(x=>{const ids=(x.member_ids||[]);const title=x.type==='group'?('👥 '+(x.name||'グループ')+'（'+ids.length+'名・'+ids.map(i=>names[i]||i).slice(0,6).join('、')+'）'):ids.map(i=>names[i]||i).join(' ⇔ ');const ms=(c.messages||[]).filter(m=>m.conversation_id===x.id).sort((a,b)=>(a.sent_at||a.created_at||0)-(b.sent_at||b.created_at||0));const last=ms.length?ms[ms.length-1]:null;const when=last?new Date(last.sent_at||last.created_at||0).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';return '<div class="row"><b>'+esc(title)+'</b><small>'+ms.length+'件'+(when?'・最終 '+when:'')+'</small><button data-conv="'+esc(x.id)+'">トークを見る</button></div>'}).join('')||'会話はありません';window.__btMon={convs:c.conversations||[],msgs:c.messages||[],names:names,users:u};document.querySelectorAll('[data-conv]').forEach(b=>b.onclick=()=>openConv(b.dataset.conv));document.getElementById('appeals').innerHTML=ap.slice().reverse().map(x=>'<div class="row"><b>'+esc(names[x.user_id]||x.user_id)+'</b><span style="display:block;width:100%">'+esc(x.message)+'</span>'+(x.status==='resolved'?'<small>対応済み</small>':'')+'<button data-ap="resolve" data-aid="'+esc(x.id)+'">対応済みにする</button><button data-ap="reply" data-uid="'+esc(x.user_id)+'">返信する</button></div>').join('')||'申し立てはありません';document.querySelectorAll('[data-ap]').forEach(b=>b.onclick=async()=>{if(b.dataset.ap==='resolve'){await fetch('/api/admin/appeals/'+encodeURIComponent(b.dataset.aid),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({status:'resolved'})})}else{const msg=prompt('返信内容（利用者の削除通知画面に表示されます）','');if(msg===null)return;await fetch('/api/admin/users/'+encodeURIComponent(b.dataset.uid),{method:'PATCH',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({ban_appeal_message:msg,admin_override:true})})}dashboard()})}
  async function limits(){
    var t=localStorage.getItem('bluetalk_admin_token'),box=document.getElementById('limitsCard');
    if(!t||!box)return;
    var h={Authorization:'Bearer '+t};
    function fmt(n){n=Number(n)||0;if(n>=1073741824)return (n/1073741824).toFixed(2)+'GB';if(n>=1048576)return (n/1048576).toFixed(1)+'MB';return n+'B'}
    function gb(n){return ((Number(n)||0)/1073741824).toFixed(2)}
    var s={},st={};
    try{var r=await fetch('/api/admin/settings',{headers:h});if(!r.ok){box.innerHTML='<p class="danger">設定を取得できませんでした（ログインし直してください）</p>';return}var j=await r.json();s=j.settings||{};st=j.storage||{}}catch(e){box.innerHTML='<p class="danger">通信に失敗しました</p>';return}
    var cap=Number(s.kvStorageBytes)||1073741824,the=Number(st.bytes)||0,pct=cap?Math.round(1000*the/cap)/10:0;
    var warn=pct>=80?' style="color:#a52828"':'';
    var inp='padding:10px;border:1px solid #c7d9ee;border-radius:9px;width:110px';
    box.innerHTML='<p><small>ここで設定した上限は、保存するとすぐ全端末に反映されます（利用者が次に送信するときに適用）。</small></p>'
      +'<div class="row"><b>1ファイルの上限</b><input id="maxFileGb" type="number" step="0.1" min="0.1" style="'+inp+'" value="'+gb(s.maxFileBytes)+'"><span>GB</span><small>現在 '+fmt(s.maxFileBytes)+'　（1回の送信で扱う1ファイルの最大サイズ）</small></div>'
      +'<div class="row"><b>合計の上限</b><input id="maxTfGb" type="number" step="0.1" min="0" style="'+inp+'" value="'+gb(s.maxTransferBytes)+'"><span>GB</span><small>0 = 無制限　'+(Number(s.maxTransferBytes)?('現在 '+fmt(s.maxTransferBytes)):'現在 無制限')+'（分割して送る場合の総量の目安・超過時に警告）</small></div>'
      +'<div class="row"><small>転送チャンク: '+fmt(s.kvPartBytes)+' 固定（Workers KV の値上限は 25MiB。チャンクを上げると書き込み回数が減ります）</small></div>'
      +'<div class="row"><button id="saveLimits">上限を保存</button><small id="limMsg">'+(s.updated_at?('前回更新: '+new Date(s.updated_at).toLocaleString('ja-JP')):'未設定（既定値を使用中）')+'</small></div>'
      +'<div class="row"><b>メディア使用量</b><small'+warn+'>'+Number(st.files||0)+' 件 ・ '+fmt(the)+' ／ プラン枠 '+fmt(cap)+'（'+pct+'%）'+(st.listing_capped?' ・ 一部のみ集計':'')+'</small></div>'
      +'<p><small>目安: Workers Free の KV 保存枠は 1GB です。1ファイルの上限を大きくしても、合計がこの枠を超えると書き込みに失敗します。Workers Paid なら保存量は無制限（+$0.50/GB月）です。</small></p>';
    document.getElementById('saveLimits').onclick=async()=>{
      var a=Number(document.getElementById('maxFileGb').value||0),b=Number(document.getElementById('maxTfGb').value||0),m=document.getElementById('limMsg'),NL=String.fromCharCode(10);
      if(!(a>0)){m.textContent='1ファイルの上限は0より大きい値を入力してください';return}
      if(b<0){m.textContent='合計の上限は0以上で入力してください';return}
      if(a>100||b>100){m.textContent='100GB以下で入力してください';return}
      if(!confirm('上限を変更します。'+NL+'1ファイル: '+a+'GB'+NL+'合計: '+(b>0?b+'GB':'無制限')+NL+NL+'保存しますか？'))return;
      m.textContent='保存中...';
      try{
        var r2=await fetch('/api/admin/settings',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({maxFileBytesGb:a,maxTransferBytesGb:b})});
        var j2=await r2.json().catch(function(){return {}});
        if(!r2.ok){m.textContent='保存に失敗しました: '+((j2&&j2.error)||r2.status);return}
        m.textContent='保存しました（1ファイル '+fmt(j2.settings.maxFileBytes)+' ／ 合計 '+(Number(j2.settings.maxTransferBytes)?fmt(j2.settings.maxTransferBytes):'無制限')+'）';
        limits();
      }catch(e){m.textContent='通信に失敗しました'}
    };
  }
  function openConv(cid){const M=window.__btMon;if(!M)return;const cv=M.convs.filter(x=>x.id===cid)[0];if(!cv)return;const ids=cv.member_ids||[];const title=cv.type==='group'?('👥 '+(cv.name||'グループ')+'（'+ids.length+'名）'):ids.map(i=>M.names[i]||i).join(' ⇔ ');const ms=M.msgs.filter(m=>m.conversation_id===cid).sort((a,b)=>(a.sent_at||a.created_at||0)-(b.sent_at||b.created_at||0));const ava=(uid)=>{const uu=(M.users||[]).filter(x=>x.id===uid)[0];return (uu&&uu.avatar_url)||'https://api.dicebear.com/7.x/thumbs/svg?seed='+encodeURIComponent(uid)};let h='<div class="bt-cm-head"><b>'+esc(title)+'</b><button id="btCmClose">閉じる</button></div><div class="bt-cm-msgs">';if(!ms.length)h+='<p class="bt-cm-empty">メッセージはまだありません</p>';ms.forEach(m=>{const left=cv.type==='group'||m.sender_id===ids[0];const name=M.names[m.sender_id]||m.sender_id;const t=(m.sent_at||m.created_at)?new Date(m.sent_at||m.created_at).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';let body='';if(m.type==='sticker'&&m.sticker_url)body='<img class="bt-cm-media" src="'+esc(m.sticker_url)+'">';else if(m.type==='image'&&m.media_data)body='<img class="bt-cm-media" src="'+esc(m.media_data)+'">';else if(m.type==='video'&&m.media_data)body='<video class="bt-cm-media" src="'+esc(m.media_data)+'" controls></video>';else if(m.type==='file'&&m.media_data)body='<a href="'+esc(m.media_data)+'" download="'+esc(m.file_name||'file')+'">📎 '+esc(m.file_name||'ファイル')+'</a>';else if(m.type==='call')body='<i>📞 通話</i>';else body=esc(m.content||'');if(!body&&m.media_data)body='<img class="bt-cm-media" src="'+esc(m.media_data)+'">';h+='<div class="bt-cm-row '+(left?'':'bt-me')+'">'+(left?'<img class="bt-cm-ava" src="'+esc(ava(m.sender_id))+'">':'')+'<div class="bt-cm-col"><span class="bt-cm-name">'+esc(name)+'</span><span class="bt-cm-bubble">'+body+'</span><span class="bt-cm-time">'+esc(t)+'</span></div></div>'});h+='</div>';let mo=document.getElementById('btConvModal');if(mo)mo.remove();mo=document.createElement('div');mo.id='btConvModal';mo.innerHTML='<div class="bt-cm-card">'+h+'</div>';mo.addEventListener('click',e=>{if(e.target===mo)mo.remove()});document.body.appendChild(mo);document.getElementById('btCmClose').onclick=()=>mo.remove()}
if(localStorage.getItem('bluetalk_admin_token'))dashboard();else login();
  </script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const APP_ENHANCEMENTS = `<script>(function(){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let keys='';let last=0;function adminTrigger(e){const now=Date.now();if(now-last>4000)keys='';last=now;keys+=(e.key||'');if(keys.length>40)keys=keys.slice(-40);if(keys.endsWith('d51-498go'))showAdminLogin()}
  function showAdminLogin(){location.href='/admin.html'}
  function applyBadges(){if(typeof allUsers==='undefined'||!allUsers.length)return;const byName=Object.fromEntries(allUsers.map(u=>[u.display_name,u]));document.querySelectorAll('.name,#profileName').forEach(el=>{if(el.dataset.btBadge)return;const u=byName[el.textContent.trim()];if(!u||(!u.verified&&!u.title))return;el.dataset.btBadge='1';if(u.verified){const v=document.createElement('span');v.textContent='\\u2713';v.title='BlueTalkPremium';v.style='display:inline-block;margin-left:5px;color:#d7a600;font-weight:900';el.appendChild(v)}if(u.title){const t=document.createElement('span');t.textContent=' '+u.title;t.style='margin-left:5px;color:#b8860b;font-weight:700';el.appendChild(t)}})}
  function bindAdminName(){const n=document.querySelector('#profileName');if(!n||n.dataset.btAdminClick)return;n.dataset.btAdminClick='1';n.style.cursor='pointer';n.title='管理者メニュー';n.onclick=()=>{if(localStorage.getItem('bluetalk_admin_token'))location.href='/admin.html';else showAdminLogin()}}
  function repairImages(){document.querySelectorAll('img').forEach(img=>{if(img.dataset.btFallback)return;img.dataset.btFallback='1';img.addEventListener('error',()=>{if(img.dataset.btBroken)return;img.dataset.btBroken='1';img.src='https://api.dicebear.com/7.x/thumbs/svg?seed=bluetalk-fallback'})})}
  new MutationObserver(()=>{repairImages();applyBadges();bindAdminName()}).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('keydown',adminTrigger);
  document.addEventListener('DOMContentLoaded',()=>{repairImages();applyBadges();bindAdminName();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{})});
})();
</script>`;

const BUILD_CHIP = `<script>(function(){function c(){var d=document.createElement('div');d.id='btBuild';d.textContent='BT 0926-A';d.style.cssText='position:fixed;right:6px;bottom:4px;z-index:2147482000;font-size:10px;color:rgba(160,180,205,.55);pointer-events:none';(document.body||document.documentElement).appendChild(d)}if(document.readyState!=='loading')c();else document.addEventListener('DOMContentLoaded',c)})();</script>`;
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
const MESSAGE_SHIM = `<script>(function(){
  if(window.__btMsg)return;window.__btMsg=1;
  var CACHE={};
  function cid(){try{return window.activeConversationId||null}catch(e){return null}}
  function esc(v){try{return escapeHtml(v)}catch(e){return String(v==null?'':v)}}
  function render(node,m){
    if(!node||!node.isConnected||!m)return;
    var d=m.media_data||'',t=m.type||'';node.innerHTML='';
    if(t==='image'){var i=document.createElement('img');i.src=d;i.alt='画像';i.addEventListener('click',function(){try{openMediaViewer('image',d)}catch(e){}});node.appendChild(i)}
    else if(t==='video'){var v=document.createElement('video');v.src=d;v.controls=true;v.setAttribute('playsinline','');v.style.maxWidth='240px';node.appendChild(v)}
    else if(t==='file'){var a=document.createElement('a');a.href=d;a.setAttribute('download',m.file_name||'file');a.textContent='📎 '+(m.file_name||'ファイル');node.appendChild(a)}
    else if(t==='sticker'){var g=document.createElement('img');g.src=m.sticker_url||'';g.alt='スタンプ';g.style.width='120px';node.appendChild(g)}
  }
  function fill(){
    var ns=document.querySelectorAll('[data-btmedia]');
    for(var i=0;i<ns.length;i++){
      var n=ns[i],id=n.getAttribute('data-btmedia');if(!id)continue;n.removeAttribute('data-btmedia');
      if(CACHE[id]){render(n,CACHE[id]);continue}
      (function(node,mid){fetch('/tables/messages/'+encodeURIComponent(mid),{cache:'no-store'}).then(function(r){return r.json()}).then(function(m){CACHE[mid]=m;render(node,m)}).catch(function(){})})(n,id);
    }
  }
  function install(){
    try{
      if(typeof API==='object'&&API.listAll&&!API.__btW){
        var o=API.listAll;
        API.listAll=function(table,params){
          var p=params||{};
          if(table==='messages'){var c=cid();if(c){var q={};for(var k in params){q[k]=params[k]}q.bt_conv=c;q.bt_light='1';return o.call(this,table,q)}}
          return o.call(this,table,p);
        };
        API.__btW=1;
      }
      if(typeof renderMessageHtml==='function'&&!window.__btR){
        var r=renderMessageHtml;
        window.renderMessageHtml=function(m){
          if(m&&m.bt_pending&&(m.type==='image'||m.type==='video'||m.type==='file')){
            var me=false;try{me=(ME&&m.sender_id===ME.id)}catch(e){}
            var sd=null;try{sd=userById(m.sender_id)}catch(e){}
            var av='';try{av=avatarFor(sd)}catch(e){}
            var tm=m.sent_at?new Date(m.sent_at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}):'';
            return '<div class="msg-row '+(me?'me':'')+'"><img class="avatar" src="'+esc(av)+'" alt=""><div class="msg-media bt-lazy" data-btmedia="'+esc(m.id)+'"></div><div class="msg-meta"><span class="msg-time">'+esc(tm)+'</span></div></div>';
          }
          return r.apply(this,arguments);
        };
        window.__btR=1;
      }
    }catch(e){}
    return !!(window.__btR);
  }
  var n=0,iv=setInterval(function(){n++;if(install()||n>40)clearInterval(iv)},300);install();
  try{new MutationObserver(function(){fill()}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}
  setInterval(fill,1200);
})();</script>`;

const MEDIA_SHIM = `<script>(function(){
  if(window.__btMediaShim)return;window.__btMediaShim=1;
  var raw=window.fetch.bind(window);
  var MAX_CHUNK=150000,IMAGE_CAP=30*1024*1024,SLICE=1536*1024;
  var KV_PART=8*1024*1024,MAX_SEND=900*1024*1024;
  var BIG={enabled:false,partSize:32*1024*1024,maxBytes:6*1024*1024*1024,kvPartBytes:KV_PART,maxFileBytes:MAX_SEND,maxTransferBytes:0,kvStorageBytes:0,ready:null};
  window.__btBig=BIG;
  BIG.lastAt=0;
  BIG.sync=async function(){
    if(BIG.lastAt&&Date.now()-BIG.lastAt<20000)return BIG;
    try{
      var r=await raw('/bt-big/config');var j=await r.json();
      if(j&&j.ok){
        BIG.enabled=!!j.enabled;
        BIG.partSize=Number(j.partSize)||BIG.partSize;
        BIG.maxBytes=Number(j.maxBytes)||BIG.maxBytes;
        if(Number(j.kvPartBytes)){BIG.kvPartBytes=Number(j.kvPartBytes);KV_PART=BIG.kvPartBytes}
        if(Number(j.maxFileBytes)){BIG.maxFileBytes=Number(j.maxFileBytes);MAX_SEND=BIG.maxFileBytes}
        BIG.maxTransferBytes=Number(j.maxTransferBytes)||0;
        if(Number(j.kvStorageBytes))BIG.kvStorageBytes=Number(j.kvStorageBytes);
        BIG.lastAt=Date.now();
      }
    }catch(e){}
    return BIG;
  };
  BIG.ready=(async function(){await BIG.sync();return BIG})();
  function isVideoFile(f){return Boolean(f)&&((f.type&&f.type.indexOf('video/')===0)||/\\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts|m2ts)$/i.test(f.name||''))}
  function isImageFile(f){return Boolean(f)&&((f.type&&f.type.indexOf('image/')===0)||/\\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(f.name||''))}
  async function uploadKVDataUrl(d){
    await BIG.sync();
    if(d.length>4*1024*1024){
      var blb=await (await raw(d)).blob();
      if(!blb||!blb.size)throw new Error('メディアを読み込めませんでした');
      try{blb.name='upload.bin'}catch(e){}
      return await uploadKVFile(blb,null);
    }
    var id=(crypto.randomUUID?crypto.randomUUID():'m'+Date.now()+Math.random().toString(16).slice(2));
    var total=Math.ceil(d.length/MAX_CHUNK),mime=(d.slice(5,d.indexOf(';'))||'application/octet-stream');
    for(var i=0;i<total;i++){var r=await raw('/bt-media/'+id+'/'+i,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d.slice(i*MAX_CHUNK,(i+1)*MAX_CHUNK)})});if(!r.ok)throw new Error('chunk failed')}
    var c=await raw('/bt-media/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({totalChunks:total,mimeType:mime})});
    if(!c.ok)throw new Error('complete failed');
    return '/bt-media/'+id;
  };
  function b64buf(buf){
    var u=new Uint8Array(buf),s='',STEP=0x8000;
    for(var i=0;i<u.length;i+=STEP){s+=String.fromCharCode.apply(null,u.subarray(i,i+STEP))}
    return btoa(s);
  }
  async function uploadKVFile(file,onprog){
    var id=(crypto.randomUUID?crypto.randomUUID():'v'+Date.now()+Math.random().toString(16).slice(2));
    var PART=KV_PART,mime=file.type||'application/octet-stream';
    var total=Math.max(1,Math.ceil(file.size/PART)),sent=0;
    if(onprog)onprog(0);
    for(var i=1;i<=total;i++){
      var blob=file.slice((i-1)*PART,Math.min(i*PART,file.size));
      var ok=false,err=null;
      for(var a=0;a<4&&!ok;a++){
        try{
          var r=await raw('/bt-media/'+id+'/'+(i-1),{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:blob});
          if(r.ok){ok=true}
          else{err=new Error('part '+i+' HTTP '+r.status);if(r.status===413||r.status===507||r.status===400||r.status===401||r.status===403){break}await new Promise(function(z){setTimeout(z,600*(a+1))})}
        }catch(e){err=e;await new Promise(function(z){setTimeout(z,600*(a+1))})}
      }
      if(!ok){btProgEnd();throw err||new Error('アップロードに失敗しました')}
      sent+=blob.size;
      if(onprog)onprog(Math.min(99,Math.round(100*sent/Math.max(1,file.size))));
    }
    var c=await raw('/bt-media/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({totalChunks:total,mimeType:mime,sizeBytes:file.size,chunkBytes:PART,encoding:'binary'})});
    if(!c.ok){btProgEnd();throw new Error('完了処理に失敗しました (HTTP '+c.status+')')}
    return '/bt-media/'+id;
  };
  // ── 大容量（8K動画など）アップロード: R2 マルチパート ──
  function btProg(label,pct,sub){
    try{
      var el=document.getElementById('__btBigBar');
      if(!el){
        el=document.createElement('div');el.id='__btBigBar';
        el.style.cssText='position:fixed;left:10px;right:10px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:99998;background:#0d1626;color:#fff;border-radius:14px;padding:10px 13px;font:600 13px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.42)';
        el.innerHTML='<div style="display:flex;justify-content:space-between;gap:10px"><span data-lbl></span><span data-pct></span></div><div style="height:6px;background:#26374f;border-radius:4px;margin-top:8px;overflow:hidden"><div data-bar style="height:100%;width:0%;background:#1877f2;transition:width .2s"></div></div><div data-sub style="opacity:.72;font-weight:500;font-size:11.5px;margin-top:6px"></div>';
        document.body.appendChild(el);
      }
      el.querySelector('[data-lbl]').textContent=label||'';
      el.querySelector('[data-pct]').textContent=pct>0?pct+'%':'';
      el.querySelector('[data-bar]').style.width=Math.max(0,Math.min(100,pct||0))+'%';
      el.querySelector('[data-sub]').textContent=sub||'';
    }catch(e){}
  }
  function btProgEnd(){try{var el=document.getElementById('__btBigBar');if(el)el.remove()}catch(e){}}
  function mb(n){return (n/1048576).toFixed(1)+'MB'}
  async function btUploadBig(file,onprog){
    var id=(crypto.randomUUID?crypto.randomUUID():'b'+Date.now()+Math.random().toString(16).slice(2));
    var mime=file.type||'application/octet-stream';
    var r0=await raw('/bt-big/'+id+'/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mimeType:mime,name:file.name||'',sizeBytes:file.size})});
    if(!r0.ok)throw new Error('アップロードを開始できませんでした (HTTP '+r0.status+')');
    var j0=await r0.json();
    var uploadId=j0.uploadId;
    var PART=Math.max(5*1024*1024,Number(j0.partSize)||BIG.partSize);
    var total=Math.max(1,Math.ceil(file.size/PART));
    var parts=[],sent=0,t0=Date.now();
    btProg('アップロードを準備中',0,'0% ・ '+mb(file.size)+' の動画');
    for(var i=1;i<=total;i++){
      var blob=file.slice((i-1)*PART,Math.min(i*PART,file.size));
      var ok=false,err=null;
      for(var a=0;a<4&&!ok;a++){
        try{
          var r=await raw('/bt-big/'+id+'/part/'+i+'?u='+encodeURIComponent(uploadId),{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:blob});
          if(r.ok){var pj=await r.json();parts.push({partNumber:i,etag:pj.etag});ok=true;}
          else{err=new Error('part '+i+' HTTP '+r.status);await new Promise(function(z){setTimeout(z,700*(a+1))});}
        }catch(e){err=e;await new Promise(function(z){setTimeout(z,700*(a+1))});}
      }
      if(!ok){
        try{await raw('/bt-big/'+id+'/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uploadId:uploadId})})}catch(e){}
        btProgEnd();
        throw err||new Error('part '+i+' の送信に失敗しました');
      }
      sent+=blob.size;
      var pct=Math.min(100,Math.round(100*sent/file.size));
      var spd=sent/Math.max(0.5,(Date.now()-t0)/1000);
      btProg('アップロード中',pct,mb(sent)+' / '+mb(file.size)+' ・ '+(spd/1048576).toFixed(1)+'MB/s ・ 残り約'+Math.max(1,Math.round((file.size-sent)/Math.max(1,spd)))+'秒');
      if(onprog)onprog(pct);
    }
    var r1=await raw('/bt-big/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uploadId:uploadId,parts:parts,sizeBytes:file.size})});
    if(!r1.ok){btProgEnd();throw new Error('完了処理に失敗しました (HTTP '+r1.status+')')}
    btProg('アップロード完了',100,'送信を確定しています...');
    setTimeout(btProgEnd,1200);
    return '/bt-big/'+id;
  }
  window.__btUploadFileSlices=async function(file,onprog){
    await BIG.sync();
    if(BIG.enabled&&file.size>24*1024*1024)return await btUploadBig(file,onprog);
    return await uploadKVFile(file,onprog);
  };
  window.__btUploadDataUrl=async function(d){
    await BIG.sync();
    if(BIG.enabled&&d.length>24*1024*1024){
      var blob=await (await raw(d)).blob();
      if(!blob||!blob.size)throw new Error('メディアを読み込めませんでした');
      return await btUploadBig(blob,null);
    }
    return await uploadKVDataUrl(d);
  };
  // ── 端末内圧縮（上限を超える 8K 動画などを 1080p/720p に落とす）──
  function fmtMB(n){n=Number(n)||0;return (n/1048576).toFixed(n<10485760?1:0)+'MB'}
  async function btVideoDuration(file){
    return new Promise(function(res){
      var u=null,v=null,fin=false;
      function done(x){if(fin)return;fin=true;try{URL.revokeObjectURL(u)}catch(e){}res(x||0)}
      try{
        u=URL.createObjectURL(file);v=document.createElement('video');v.preload='metadata';v.muted=true;v.src=u;
        v.onloadedmetadata=function(){done(v.duration)};
        v.onerror=function(){done(0)};
        setTimeout(function(){done(0)},8000);
      }catch(e){done(0)}
    });
  }
  async function btDownscale(file,maxHeight,onprog){
    var objectUrl=URL.createObjectURL(file),ac=null,stream=null,rec=null;
    try{
      var v=document.createElement('video');
      v.playsInline=true;v.setAttribute('playsinline','');v.preload='auto';v.volume=1;v.muted=false;v.src=objectUrl;
      await new Promise(function(res,rej){
        var t=setTimeout(function(){rej(new Error('動画の読み込みがタイムアウトしました'))},20000);
        v.onloadedmetadata=function(){clearTimeout(t);res()};
        v.onerror=function(){clearTimeout(t);rej(new Error('この形式の動画は圧縮できません'))};
      });
      var sw=v.videoWidth||0,sh=v.videoHeight||0;
      if(!sw||!sh)throw new Error('動画の解像度を取得できませんでした');
      var sc=Math.min(1,maxHeight/sh);
      var w=Math.max(2,Math.round(sw*sc/2)*2),h=Math.max(2,Math.round(sh*sc/2)*2);
      var cv=document.createElement('canvas');cv.width=w;cv.height=h;
      var ctx=cv.getContext('2d');
      stream=cv.captureStream(30);
      try{
        var AC=window.AudioContext||window.webkitAudioContext;
        if(AC){
          ac=new AC();try{ac.resume()}catch(e){};
          var srcNode=ac.createMediaElementSource(v);
          var dst=ac.createMediaStreamDestination();
          var g=ac.createGain();g.gain.value=0;
          srcNode.connect(g);g.connect(ac.destination);
          srcNode.connect(dst);
          dst.stream.getAudioTracks().forEach(function(t){stream.addTrack(t)});
        }
      }catch(e){ac=null}
      var mime='video/webm';
      try{
        if(MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus'))mime='video/webm;codecs=vp9,opus';
        else if(MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus'))mime='video/webm;codecs=vp8,opus';
        else if(MediaRecorder.isTypeSupported('video/mp4'))mime='video/mp4';
      }catch(e){}
      var bps=h>=1080?6000000:(h>=720?3000000:1500000);
      rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:bps,audioBitsPerSecond:96000});
      var chunks=[];rec.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data)};
      var stopped=new Promise(function(res){rec.onstop=res});
      var dur=v.duration||0;
      if(!isFinite(dur)||dur<=0)throw new Error('動画の長さを取得できませんでした。この動画は圧縮できません');
      rec.start(2000);
      try{await v.play()}catch(e){
        try{v.muted=true;await v.play()}catch(e2){throw new Error('再生を開始できませんでした。もう一度お試しください')}
      }
      var stall=null,lastT=-1,lastMove=Date.now();
      if(onprog)onprog(1);
      var wd=setInterval(function(){
        var t=v.currentTime||0;
        if(t>lastT+0.05){lastT=t;lastMove=Date.now();return}
        var el=Date.now()-lastMove;
        if(document.hidden&&el>15000)stall=new Error('アプリが背面になったため圧縮を継続できません。画面を開いたままお試しください');
        else if(el>25000)stall=new Error('動画の再生が止まりました。この端末では圧縮を継続できません');
      },1000);
      await new Promise(function(res){
        var fin=false;
        function done(){if(fin)return;fin=true;clearInterval(wd);clearInterval(iv);res()}
        v.onended=done;
        function draw(){
          try{ctx.drawImage(v,0,0,w,h)}catch(e){}
          if(onprog)onprog(Math.max(1,Math.min(99,Math.round(100*(v.currentTime||0)/Math.max(1,dur)))));
        }
        function tick(){draw();if(stall||v.ended)return done();requestAnimationFrame(tick)}
        var iv=setInterval(function(){draw();if(stall)return done();if(v.ended||v.currentTime>=dur-0.03)return done()},200);
        tick();
        setTimeout(done,((dur||900)+120)*1000);
      });
      if(stall)throw stall;
      try{rec.stop()}catch(e){}
      await Promise.race([stopped,new Promise(function(r){setTimeout(r,15000)})]);
      if(!chunks.length)throw new Error('圧縮結果が空でした');
      var out=new Blob(chunks,{type:mime.indexOf('mp4')>=0?'video/mp4':'video/webm'});
      try{out.name=String(file.name||'video').replace(/\\.[^.]+$/,'')+(mime.indexOf('mp4')>=0?'.mp4':'.webm')}catch(e){}
      return out;
    }finally{
      try{if(rec&&rec.state!=='inactive')rec.stop()}catch(e){}
      try{if(stream)stream.getTracks().forEach(function(t){t.stop()})}catch(e){}
      if(ac){try{ac.close()}catch(e){}}
      try{URL.revokeObjectURL(objectUrl)}catch(e){}
    }
  }
  async function btCompressPrompt(file,label){
    await BIG.sync();
    if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream){
      toast(label+'が大きすぎます（'+fmtMB(file.size)+'／上限'+fmtMB(MAX_SEND)+'）。この端末では圧縮できません');
      return null;
    }
    var dur=await btVideoDuration(file);
    if(!dur||dur<=0||!isFinite(dur)){
      toast(label+'が大きすぎます（'+fmtMB(file.size)+'／上限'+fmtMB(MAX_SEND)+'）');
      return null;
    }
    var target=dur*6000000/8>MAX_SEND*0.9?720:1080;
    var est=dur*(target>=1080?6000000:3000000)/8;
    var mins=Math.ceil(dur/60);
    var ok=window.confirm(label+'が大きすぎます（'+fmtMB(file.size)+'／上限'+fmtMB(MAX_SEND)+'）。\\n\\n端末内で'+target+'pに圧縮してから送信します。\\n・推定サイズ: 約'+fmtMB(est)+'\\n・所要時間: 動画と同じ長さ（約'+mins+'分）\\n\\nこのまま圧縮を開始しますか？\\n（「キャンセル」で送信を中止します）');
    if(!ok){toast('送信を中止しました');return null}
    btProg('圧縮中',0,'動画と同じ長さの時間がかかります（約'+mins+'分）・画面を開いたままお待ちください');
    var out=null;
    try{out=await btDownscale(file,target,function(p){btProg('圧縮中',p,'このままお待ちください（約'+mins+'分）')})}
    catch(e){btProgEnd();toast('圧縮に失敗しました: '+(e&&e.message?e.message:''));return null}
    btProgEnd();
    if(!out||!out.size){toast('圧縮に失敗しました');return null}
    if(out.size>MAX_SEND){toast('圧縮後も上限を超えています（'+fmtMB(out.size)+'／上限'+fmtMB(MAX_SEND)+'）。動画を短くしてお試しください');return null}
    toast('圧縮しました: '+fmtMB(file.size)+' → '+fmtMB(out.size));
    return out;
  }
  // ══════════ 分割転送（上限超過ファイル）: 送信＝分割 / 受信＝自動結合 ══════════
  var XFER={byPart:{},list:{}};
  window.__btXfer=XFER;
  function xesc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function xferId(){return 'tx'+(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):Date.now().toString(36)+Math.random().toString(36).slice(2))}
  function btCompressible(mime){mime=String(mime||'').toLowerCase();if(!mime)return true;return mime.indexOf('text/')===0||/(json|xml|csv|log|svg|bmp|tiff|wav|plain|pdf|rtf|sql|yaml|sh|js)/.test(mime)}
  function btTrustedGz(){try{return 'CompressionStream' in window&&'DecompressionStream' in window}catch(e){return false}}
  function xferIndex(payload){
    try{
      var rows=(payload&&payload.data)?payload.data:(Array.isArray(payload)?payload:[]);
      for(var i=0;i<rows.length;i++){var r=rows[i];if(r&&r.bt_transfer&&r.bt_transfer.tid)xferRegister(r.bt_transfer)}
    }catch(e){}
  }
  function xferRegister(t){
    try{
      if(!t||!t.tid||!t.parts||!t.parts.length)return null;
      if(XFER.list[t.tid])return XFER.list[t.tid];
      XFER.list[t.tid]=t;
      t.parts.forEach(function(p){if(p&&p.u){var m=/^\\/bt-media\\/([A-Za-z0-9-]+)$/.exec(p.u);if(m)XFER.byPart[m[1]]=t}});
      xferNotify(t);
      return t;
    }catch(e){return null}
  }
  function xferNotify(t){
    try{
      if(t.__done||document.getElementById('__btXF'+t.tid))return;
      var nParts=t.parts.length,total=Number(t.size||0);
      var d=document.createElement('div');
      d.id='__btXF'+t.tid;
      d.style.cssText='position:fixed;left:10px;right:10px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:99996;background:#0d1626;color:#fff;border-radius:14px;padding:11px 13px;font:600 13px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.42);display:flex;gap:10px;align-items:center';
      d.innerHTML='<div style="flex:1;min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📦 '+xesc(t.name||'ファイル')+'</div><div style="opacity:.72;font-weight:500;font-size:11.5px;margin-top:2px">'+(nParts>1?('分割 '+nParts+'パート ・ '):'')+fmtMB(total)+(t.zip?'（圧縮済み）':'')+'</div><div style="height:6px;background:#26374f;border-radius:4px;margin-top:7px;overflow:hidden"><div data-xb style="height:100%;width:0%;background:#1877f2;transition:width .2s"></div></div><div data-xs style="opacity:.72;font-weight:500;font-size:11.5px;margin-top:5px">タップで結合し、1つのファイルとして保存できます</div></div><button data-xsave style="border:0;border-radius:10px;padding:11px 15px;background:#1877f2;color:#fff;font-weight:700">保存</button><button data-xclose style="border:0;border-radius:10px;padding:11px 12px;background:#26374f;color:#fff;font-weight:700">×</button>';
      document.body.appendChild(d);
      var go=d.querySelector('[data-xsave]'),cl=d.querySelector('[data-xclose]'),xb=d.querySelector('[data-xb]'),xs=d.querySelector('[data-xs]');
      cl.onclick=function(){d.remove()};
      go.onclick=async function(){
        if(go.disabled)return;
        go.disabled=true;go.textContent='受信中...';
        try{
          var r=await btJoinDownload(t,function(p,msg){xb.style.width=Math.max(0,Math.min(100,p||0))+'%';if(msg)xs.textContent=msg});
          if(r==='aborted'){xs.textContent='中止しました';go.disabled=false;go.textContent='保存';return}
          t.__done=1;d.remove();toast('保存しました: '+(t.name||'ファイル'));
        }catch(e){xs.textContent='失敗: '+(e&&e.message?e.message:'');go.disabled=false;go.textContent='再試行'}
      };
    }catch(e){}
  }
  async function btJoinDownload(t,onp){
    var mt=t.parts.reduce(function(a,p){return a+Number(p.c||p.s||0)},0)||Number(t.size||0);
    var fh=null,w=null,bufs=[],got=0;
    if(window.showSaveFilePicker){
      try{fh=await window.showSaveFilePicker({suggestedName:String(t.name||'file')})}
      catch(e){if(e&&(e.name==='AbortError'||e.name==='NotAllowedError'||e.name==='SecurityError'))return 'aborted'}
    }
    if(fh){try{w=await fh.createWritable()}catch(e){w=null;fh=null}}
    try{
      for(var i=0;i<t.parts.length;i++){
        var p=t.parts[i];
        if(onp)onp(100*got/Math.max(1,mt),'パート '+(i+1)+'/'+t.parts.length+' を受信しています');
        var resp=await raw(p.u);
        if(!resp.ok)throw new Error('パート '+(i+1)+' を取得できませんでした (HTTP '+resp.status+')');
        var rs=resp.body;
        if(p.e==='gzip'){
          if(!btTrustedGz())throw new Error('この端末は解凍（gzip）に対応していません');
          rs=rs.pipeThrough(new DecompressionStream('gzip'));
        }
        var rd=rs.getReader();
        for(;;){
          var st=await rd.read();
          if(st.done)break;
          var v=st.value;
          if(w)await w.write(v);else bufs.push(v);
          got+=v.length;
          if(onp)onp(100*got/Math.max(1,mt),fmtMB(got)+' / '+fmtMB(mt));
        }
      }
    }catch(e){
      try{if(w)await w.abort()}catch(e2){}
      throw e;
    }
    if(w){await w.close()}
    else{
      var blob=new Blob(bufs,{type:t.mime||'application/octet-stream'});
      bufs.length=0;
      var a=document.createElement('a'),u=URL.createObjectURL(blob);
      a.href=u;a.download=String(t.name||'file');
      document.body.appendChild(a);a.click();
      setTimeout(function(){try{URL.revokeObjectURL(u)}catch(e){}a.remove()},60000);
    }
    if(Number(t.size)>0&&got!==Number(t.size))throw new Error('サイズが一致しません（受信'+got+' / 元'+Number(t.size)+'）');
    return 'ok';
  }
  async function btUploadObject(blob,onprog){
    await BIG.sync();
    if(BIG.enabled&&blob.size>24*1024*1024)return await btUploadBig(blob,onprog);
    return await uploadKVFile(blob,onprog);
  }
  async function btSendTransfer(file,onp){
    await BIG.sync();
    var PART_MAX=Math.max(8*1024*1024,Math.floor(MAX_SEND*0.98));
    var nparts=Math.max(1,Math.ceil(file.size/PART_MAX));
    if(BIG.maxTransferBytes>0&&file.size>BIG.maxTransferBytes){
      var go=window.confirm('合計 '+fmtMB(file.size)+' は、このアカウントの保存枠（'+fmtMB(BIG.maxTransferBytes)+'）を超えます。\\n保存枠を超えるとアップロードが途中で失敗します。続けますか？');
      if(!go)return null;
    }
    var kvRemain=0;
    if(!BIG.enabled){
      try{var ru=await raw('/bt-big/config?usage=1');var ju=await ru.json();if(ju&&ju.ok&&Number(ju.remainingBytes)>=0)kvRemain=Number(ju.remainingBytes)}catch(e){}
      var cap=Number(BIG.kvStorageBytes)||0;
      var free=kvRemain>0?kvRemain:cap;
      if(free>0&&file.size>free*0.95){btProgEnd();toast('このファイルは分割しても保存できません（合計 '+fmtMB(file.size)+' ／ 保存できる残り約 '+fmtMB(free)+'）。圧縮して送るか、サーバー側でR2（大容量ストレージ）を有効にしてください');return null}
    }
    if(onp)onp(0,'送信の準備をしています...');
    var tid=xferId(),parts=[];
    for(var i=0;i<nparts;i++){
      var blob=file.slice(i*PART_MAX,Math.min((i+1)*PART_MAX,file.size));
      var enc='',payload=blob;
      if(btCompressible(file.type)&&blob.size<=384*1024*1024&&btTrustedGz()){
        try{
          if(onp)onp(Math.round(100*i/nparts),'パート '+(i+1)+'/'+nparts+' を圧縮中...');
          var gz=await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
          if(gz&&gz.size&&gz.size<blob.size*0.95){payload=gz;enc='gzip'}
        }catch(e){enc='';payload=blob}
      }
      var url=await btUploadObject(payload,function(pr){if(onp)onp(Math.min(99,Math.round(100*(i+pr/100)/nparts)),'パート '+(i+1)+'/'+nparts+' をアップロード中 '+pr+'%')});
      parts.push({i:i,u:url,s:blob.size,c:payload.size,e:enc});
    }
    if(onp)onp(100,'送信を確定しています...');
    return {tid:tid,name:String(file.name||'file'),size:Number(file.size||0),mime:file.type||'application/octet-stream',parts:parts,zip:parts.some(function(p){return p.e==='gzip'}),created_at:Date.now()};
  }
  async function btSendBigFile(file,onp){
    var t=await btSendTransfer(file,onp);
    if(!t){btProgEnd();return null}
    var first=(t.parts[0]&&t.parts[0].u)||'';
    await sendMessage({type:'file',media_data:first,file_name:t.name,bt_transfer:t});
    xferRegister(t);
    // アプリ側が追加フィールドを落とした場合に備え、マニフェスト保存を確認して補完する
    try{
      var cid=(typeof activeConversationId!=='undefined')?activeConversationId:'';
      if(cid){
        var r=await raw('/tables/messages?bt_conv='+encodeURIComponent(cid)+'&limit=20');
        var j=await r.json();
        var rows=(j&&j.data)?j.data:[];
        var found=rows.some(function(x){return x&&x.bt_transfer&&x.bt_transfer.tid===t.tid});
        if(!found){
          await raw('/tables/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
            conversation_id:cid,sender_id:myId(),type:'file',content:'',media_data:first,file_name:t.name,bt_transfer:t,sent_at:Date.now(),created_at:Date.now()
          })});
        }
      }
    }catch(e){}
    btProgEnd();
    toast('送信しました: '+t.name+(t.parts.length>1?('（'+t.parts.length+'分割）'):''));
    return t;
  }
  function btChoice(title,body,opts){
    return new Promise(function(res){
      try{
        var d=document.createElement('div');
        d.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(6,10,18,.74);display:flex;align-items:center;justify-content:center;padding:18px';
        var h='<div style="background:#0d1626;color:#fff;border-radius:16px;padding:16px;max-width:430px;width:100%;font:500 13.5px/1.65 system-ui,-apple-system,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="font-weight:800;font-size:15px;margin-bottom:7px">'+xesc(title)+'</div><div style="opacity:.86;white-space:pre-wrap">'+xesc(body)+'</div>';
        opts.forEach(function(o,i){h+='<button data-i="'+i+'" style="display:block;width:100%;margin-top:9px;border:0;border-radius:12px;padding:13px;font:700 14px system-ui,sans-serif;background:'+(o.primary?'#1877f2':'#26374f')+';color:#fff;cursor:pointer">'+xesc(o.label)+'</button>'});
        d.innerHTML=h+'</div>';
        d.addEventListener('click',function(e){
          var b=(e.target&&e.target.closest)?e.target.closest('button[data-i]'):null;
          if(b){var v=opts[Number(b.getAttribute('data-i'))].value;d.remove();res(v);return}
          if(e.target===d){d.remove();res(null)}
        },true);
        document.body.appendChild(d);
      }catch(e){res(null)}
    });
  }
  // ファイルリンクをタップした時、そのパートが分割転送の一部なら結合保存に横取りする
  document.addEventListener('click',function(e){
    try{
      var a=(e.target&&e.target.closest)?e.target.closest('a[href]'):null;
      if(!a)return;
      var m=/^\\/bt-media\\/([A-Za-z0-9-]+)$/.exec(a.getAttribute('href')||'');
      if(!m)return;
      var t=XFER.byPart[m[1]];
      if(!t)return;
      e.preventDefault();e.stopImmediatePropagation();
      t.__done=0;xferNotify(t);
      var bar=document.getElementById('__btXF'+t.tid);
      if(bar){var b=bar.querySelector('[data-xsave]');if(b)b.click()}
    }catch(err){}
  },true);
  window.fetch=async function(input,init){
    try{
      var url=typeof input==='string'?input:(input&&input.url)||'';
      if(init&&init.method==='POST'&&init.body&&url.indexOf('/tables/')===0){
        var b=JSON.parse(init.body);
        var field=(url.indexOf('/tables/messages')===0)?'media_data':(url.indexOf('/tables/stickers')===0)?'image_url':(url.indexOf('/tables/users')===0)?'avatar_url':null;
        if(field){
          var d=String(b[field]||'');
          if(d.indexOf('data:')===0&&d.length>MAX_CHUNK){
            b[field]=await window.__btUploadDataUrl(d);
            init={...init,body:JSON.stringify(b)};
          }
        }
      }else if(!init&&typeof input==='string'&&input.indexOf('/tables/messages')===0&&(typeof activeConversationId!=='undefined')&&activeConversationId){
        input=input+(input.indexOf('?')>=0?'&':'?')+'bt_conv='+encodeURIComponent(activeConversationId);
      }
    }catch(e){console.warn('[bt] media upload failed',e)}
    var res;
    try{res=await raw(input,init)}
    catch(netErr){
      var isGet=!init||!init.method||String(init.method).toUpperCase()==='GET';
      var su2=typeof input==='string'?input:'';
      var alt='https://bluetalk.pages.dev';
      if(isGet&&su2&&su2.charAt(0)==='/'&&location.host!==alt.replace('https://','')){
        res=await raw(alt+su2,init);
      }else{throw netErr}
    }
    try{
      var su=typeof input==='string'?input:'';
      if(su.indexOf('/tables/messages')===0){var cl=res.clone();cl.json().then(xferIndex).catch(function(){})}
    }catch(e){}
    return res;
  };
  function toast(s){try{if(typeof showToast==='function')showToast(s)}catch(e){}}
  function myId(){return(typeof ME!=='undefined'&&ME)?ME.id:''}
  function readFile(f){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(r.result)};r.onerror=rej;r.readAsDataURL(f)})}
  function compressImage(file,maxDim,q){return new Promise(function(res,rej){
    if(file.type==='image/gif'||file.type==='image/webp'){readFile(file).then(res,rej);return}
    var img=new Image();var u=URL.createObjectURL(file);
    img.onload=function(){try{var s=Math.min(1,maxDim/Math.max(img.width,img.height));var c=document.createElement('canvas');c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext('2d').drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(u);res(c.toDataURL('image/jpeg',q))}catch(e){rej(e)}};
    img.onerror=function(){URL.revokeObjectURL(u);rej(new Error('img'))};
    img.src=u;
  })}
  window.compressImageFile=function(f,maxDim,q){return compressImage(f,maxDim||2560,q||0.9)};
  async function sendMedia(file){
    if((typeof activeConversationId==='undefined')||!activeConversationId){toast('トークを開いてください');return}
    try{
      await BIG.sync();
      if(isImageFile(file)){
        if(file.size>IMAGE_CAP){toast('画像が大きすぎます（30MBまで）');return}
        var d=await compressImage(file,2560,0.9);await sendMessage({type:'image',media_data:d});
      }else if(isVideoFile(file)){
        var vsend=file;
        if(file.size>MAX_SEND){
          var how=await btChoice('動画が上限を超えています','サイズ: '+fmtMB(file.size)+' ／ 上限: '+fmtMB(MAX_SEND)+'\\n送信方法を選んでください。',[
            {label:'圧縮して送る（1080p・容量を大幅に削減）',value:'zip',primary:true},
            {label:'分割してそのまま送る（無劣化・'+Math.ceil(file.size/(MAX_SEND*0.98))+'分割）',value:'split'},
            {label:'キャンセル',value:null}
          ]);
          if(how==='split'){
            btProg('アップロードを準備中',0,'');
            await btSendBigFile(file,function(p,msg){btProg('送信中',p,msg||'')});
            return;
          }
          if(how!=='zip')return;
          vsend=await btCompressPrompt(file,'動画');
          if(!vsend)return;
          if(vsend.size>MAX_SEND){
            btProg('アップロードを準備中',0,'');
            await btSendBigFile(vsend,function(p,msg){btProg('送信中',p,msg||'')});
            return;
          }
        }
        btProg('アップロードを準備中',0,'');
        var url=await window.__btUploadFileSlices(vsend,function(p){btProg('アップロード中',p,fmtMB(Math.round(vsend.size*p/100))+' / '+fmtMB(vsend.size))});
        await sendMessage({type:'video',media_data:url});
      }else{toast('画像または動画ファイルを選んでください')}
    }catch(e){console.error(e);toast('送信に失敗しました')}
  }
  async function sendGeneric(file){
    if((typeof activeConversationId==='undefined')||!activeConversationId){toast('トークを開いてください');return}
    await BIG.sync();
    if(file.size>MAX_SEND){
      if(isVideoFile(file)){
        var fsend=await btCompressPrompt(file,'動画');
        if(!fsend)return;
        file=fsend;
      }else{
        var howg=await btChoice('ファイルが上限を超えています','サイズ: '+fmtMB(file.size)+' ／ 上限: '+fmtMB(MAX_SEND)+'\\n分割して送信し、受信側で1つのファイルに自動結合できます。',[
          {label:'分割して送る（'+Math.ceil(file.size/(MAX_SEND*0.98))+'分割・圧縮できる形式は自動で圧縮）',value:'split',primary:true},
          {label:'キャンセル',value:null}
        ]);
        if(howg!=='split')return;
        btProg('アップロードを準備中',0,'');
        await btSendBigFile(file,function(p,msg){btProg('送信中',p,msg||'')});
        return;
      }
    }
    try{
      if(isImageFile(file)||isVideoFile(file)){await sendMedia(file);return}
      var media;
      if(file.size>8*1024*1024){btProg('アップロードを準備中',0,'');media=await window.__btUploadFileSlices(file,function(p){btProg('アップロード中',p,fmtMB(Math.round(file.size*p/100))+' / '+fmtMB(file.size))})}
      else{media=await readFile(file)}
      await sendMessage({type:'file',media_data:media,file_name:file.name});
    }catch(e){console.error(e);toast('送信に失敗しました')}
  }
  async function importStickers(files,packName){
    if(!files||!files.length){toast('画像を選択してください');return}
    var ok=0;
    for(var i=0;i<files.length;i++){var f=files[i];if(!f.type.startsWith('image/'))continue;if(f.size>12*1024*1024){toast((f.name||'ファイル')+' は12MBを超えています');continue}
      try{var d=await readFile(f);await API.create('stickers',{user_id:myId(),image_url:d,name:packName||'マイスタンプ'});ok++}catch(e){}}
    if(ok){if(typeof refreshStickers==='function')await refreshStickers();toast(ok+'枚取り込みました')}
  }
  document.addEventListener('change',function(e){
    var t=e.target;if(!t||!t.id)return;
    try{
      if(t.id==='mediaFileInput'){e.stopImmediatePropagation();e.preventDefault();var f=t.files[0];t.value='';if(f)sendMedia(f)}
      else if(t.id==='genericFileInput'){e.stopImmediatePropagation();e.preventDefault();var f2=t.files[0];t.value='';if(f2)sendGeneric(f2)}
      else if(t.id==='stickerFilesInput'){e.stopImmediatePropagation();e.preventDefault();var fs=[].slice.call(t.files);var pn=(document.getElementById('stickerPackName')||{value:''}).value||'マイスタンプ';t.value='';importStickers(fs,pn)}
    }catch(err){console.error(err)}
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
  function myId(){return(typeof ME!=='undefined'&&ME)?ME.id:''}
  function lineProduct(v){var m=v.match(/store\\.line\\.me\\/stickershop\\/product\\/(\\d+)/)||v.match(/line\\.me\\/S?\\/sticker\\/(\\d+)/)||v.match(/^\\s*(\\d{6,12})\\s*$/);return m?m[1]:null}
  function lineSingle(v){var m=v.match(/stickershop\\.line-scdn\\.net\\/stickershop\\/v1\\/sticker\\/(\\d+)\\//);return m?{url:v,name:'LINEスタンプ'}:null}
  function rows(){try{return(typeof myStickers!=='undefined'&&Array.isArray(myStickers))?myStickers:[]}catch(e){return[]}}
  function packOf(row){return row&&Array.isArray(row.pack_stickers)?row:null}
  async function importProduct(pid){
    toast('LINEスタンプを取得中...');
    try{
      var r=await fetch('/api/line-stickers/'+encodeURIComponent(pid));var j=await r.json();
      if(!r.ok||!j.ok||!j.stickers||!j.stickers.length){toast('スタンプを取得できませんでした（無料スタンプのURLをお試しください）');return}
      var main='https://stickershop.line-scdn.net/stickershop/v1/product/'+pid+'/LINEStorePC/main.png?v=1';
      var dup=null;rows().forEach(function(x){if(x&&String(x.pack_id||'')===String(pid))dup=x});
      if(dup){
        if(!confirm('「'+(j.title||'LINEスタンプ')+'」はすでに取り込んでいます。\\n上書き（更新）しますか？')){toast('取り込みを中止しました');return}
        await API.update('stickers',dup.id,{image_url:main,name:j.title||'LINEスタンプ',pack_stickers:j.stickers,animated:!!j.animated,pack_sounds:j.sounds||null});
        await btRefreshStickers();
        toast((j.title||'スタンプ')+'（'+j.stickers.length+'枚）を更新しました');
        return;
      }
      await API.create('stickers',{user_id:myId(),image_url:main,name:j.title||'LINEスタンプ',pack_id:String(pid),pack_stickers:j.stickers,animated:!!j.animated,pack_sounds:j.sounds||null});
      if(typeof refreshStickers==='function')await refreshStickers();
      var input=document.getElementById('stickerUrlInput');if(input)input.value='';
      toast((j.title||'スタンプ')+'（'+j.stickers.length+'枚）を取り込みました');
    }catch(e){toast('取り込みに失敗しました')}
  }
  async function importSingle(item){
    try{
      var dupS=null;rows().forEach(function(x){if(x&&x.image_url===item.url)dupS=x});
      if(dupS){toast('このスタンプはすでに取り込んでいます');return}
      await API.create('stickers',{user_id:myId(),image_url:item.url,name:item.name});
      if(typeof refreshStickers==='function')await refreshStickers();
      var input=document.getElementById('stickerUrlInput');if(input)input.value='';
      toast('スタンプを取り込みました')
    }catch(e){toast('取り込みに失敗しました')}
  }
  function smart(){
    var input=document.getElementById('stickerUrlInput');var v=input?input.value.trim():'';
    if(!v)return;
    var pid=lineProduct(v);if(pid){importProduct(pid);return}
    var single=lineSingle(v);if(single){importSingle(single);return}
    toast('画像URLまたはLINEスタンプのURLを入力してください');
  }
  window.addStickerFromUrl=smart;
  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('#addStickerBtn'):null;
    if(!b)return;
    e.stopImmediatePropagation();e.preventDefault();
    smart();
  },true);
  document.addEventListener('keydown',function(e){
    if(e.key!=='Enter')return;var i=document.getElementById('stickerUrlInput');
    if(!i||e.target!==i)return;
    e.stopImmediatePropagation();e.preventDefault();
    smart();
  },true);
  var css=document.createElement('style');
  css.textContent='.bt-pack-badge{position:absolute;bottom:4px;right:6px;background:rgba(0,0,0,.72);color:#fff;font-size:10px;padding:2px 6px;border-radius:8px;pointer-events:none}.bt-sticker-card,.bt-sticker-item{position:relative;cursor:pointer}#btPackModal{position:fixed;inset:0;z-index:10002;background:rgba(3,6,12,.78);display:flex;align-items:center;justify-content:center;padding:14px}#btPackModal .bt-pk-card{background:#141b26;color:#fff;width:min(430px,94vw);max-height:80vh;border-radius:18px;padding:14px;display:flex;flex-direction:column;box-shadow:0 16px 60px rgba(0,0,0,.6)}#btPackModal .bt-pk-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}#btPackModal .bt-pk-head b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#btPackModal .bt-pk-head small{color:#9fb2c9;flex:none}#btPackModal .bt-pk-close{background:#223047!important;border:none!important;color:#fff!important;border-radius:10px;padding:7px 12px;cursor:pointer;font-size:13px}#btPackModal .bt-pk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:10px;overflow:auto;padding:4px}#btPackModal .bt-pk-grid img{width:100%;border-radius:10px;background:#0d121c;cursor:pointer;transition:transform .12s}#btPackModal .bt-pk-grid img:hover{transform:scale(1.06)}#btPackModal .bt-pk-hint{font-size:11px;color:#9fb2c9;margin:10px 4px 0}#btPackModal .bt-pk-del{background:#3a1f26!important;border:none!important;color:#ff9d9d!important;border-radius:10px;padding:7px 12px;cursor:pointer;font-size:13px;margin-right:6px}';
  document.head.appendChild(css);
  async function btRefreshStickers(){
    try{if(typeof refreshStickers==='function'){await refreshStickers();return true}}catch(e){}
    try{if(typeof window.refreshStickers==='function'){await window.refreshStickers();return true}}catch(e){}
    try{location.reload();return true}catch(e){}
    return false
  }
  async function btDeleteSticker(row){
    if(!row||!row.id)return;
    var label=(row.name||'スタンプ')+(row.pack_stickers?('（'+row.pack_stickers.length+'枚）'):'');
    if(!confirm('「'+label+'」を削除しますか？\\nこの端末のスタンプ一覧から消えます。'))return;
    try{await API.remove('stickers',row.id);await btRefreshStickers();toast('スタンプを削除しました')}
    catch(e){toast('削除に失敗しました: '+(e&&e.message?e.message:''))}
  }
  function openPack(row){
    if(!row)return;
    var old=document.getElementById('btPackModal');if(old)old.remove();
    var mo=document.createElement('div');mo.id='btPackModal';
    var h='<div class="bt-pk-card"><div class="bt-pk-head"><b>'+esc(row.name||'LINEスタンプ')+'</b><small>'+(row.sound?'🔊音付き・':'')+(row.animated?'🎬動く・':'')+row.pack_stickers.length+'枚</small><button class="bt-pk-del" id="btPkDel">削除</button><button class="bt-pk-close" id="btPkClose">閉じる</button></div><div class="bt-pk-grid" id="btPkGrid">';
    for(var i=0;i<row.pack_stickers.length;i++){h+='<img src="'+esc(row.pack_stickers[i])+'" data-btsticker="'+esc(row.pack_stickers[i])+'" alt="">'}
    h+='</div><p class="bt-pk-hint">スタンプをタップするとトークに送信されます</p></div>';
    mo.innerHTML=h;
    mo.addEventListener('click',function(e){if(e.target===mo)mo.remove()});
    document.body.appendChild(mo);
    document.getElementById('btPkClose').addEventListener('click',function(){mo.remove()});
    document.getElementById('btPkDel').addEventListener('click',async function(){
      if(!confirm('「'+(row.name||'LINEスタンプ')+'」を削除しますか？\\nこのパック（'+row.pack_stickers.length+'枚）が一覧から消えます。'))return;
      try{await API.remove('stickers',row.id);mo.remove();await btRefreshStickers();toast('スタンプを削除しました')}
      catch(e){toast('削除に失敗しました')}
    });
    document.getElementById('btPkGrid').addEventListener('click',async function(e){
      var im=e.target.closest?e.target.closest('img[data-btsticker]'):null;if(!im)return;
      if(typeof activeConversationId==='undefined'||!activeConversationId||(typeof sendMessage!=='function')){toast('送信するにはトークを開いてください');return}
      var sUrl=im.getAttribute('data-btsticker');
      if(Array.isArray(row.pack_sounds)){var si=row.pack_stickers.indexOf(sUrl);if(si>=0&&row.pack_sounds[si]){try{var au=new Audio(row.pack_sounds[si]);au.play().catch(function(){})}catch(e){}}}
      try{await sendMessage({type:'sticker',sticker_url:sUrl,sticker_sound:(Array.isArray(row.pack_sounds)&&row.pack_sounds[row.pack_stickers.indexOf(sUrl)])||null});mo.remove();toast('スタンプを送りました')}catch(err){toast('送信に失敗しました')}
    });
  }
  function btSoundMap(url){try{var rs=rows();for(var i=0;i<rs.length;i++){var r=rs[i];if(!r||!Array.isArray(r.pack_sounds)||!Array.isArray(r.pack_stickers))continue;var ix=r.pack_stickers.indexOf(url);if(ix>=0&&r.pack_sounds[ix])return r.pack_sounds[ix]}}catch(e){}return null}
  document.addEventListener('click',function(e){
    var el2=e.target&&e.target.closest?e.target.closest('.sticker-item,.sticker-card'):null;
    if(el2){try{var rs2=rows();var k2=el2.getAttribute('data-send')||((el2.querySelector('img')||{}).src||'');for(var i2=0;i2<rs2.length;i2++){var r2=rs2[i2];if(r2&&r2.image_url===k2&&Array.isArray(r2.pack_stickers)&&r2.pack_stickers.length){el2.setAttribute('data-send',r2.pack_stickers[0]);break}}}catch(e2){}}
    var im=e.target&&e.target.closest?e.target.closest('img'):null;if(!im)return;
    var src=im.getAttribute('src')||'';if(!src)return;
    var su=btSoundMap(src);if(!su)return;
    try{var a=new Audio(su);a.play().catch(function(){})}catch(err){}
  },true);
  window.__btOpenPack=openPack;
  /* 動くスタンプ: 初回は自動で再生し、停止後はタップで再生 */
  (function(){
    var AUTO_MS=2600,REPLAY_MS=2600;
    var SEL='#messagesArea .msg-sticker img[src*="sticker_animation"]';
    function freeze(img){
      if(!img||!img.parentNode||img.__btFrozen||img.tagName!=='IMG')return;
      var w=img.clientWidth||0,h=img.clientHeight||0;
      if(!w||!h){img.__btT=setTimeout(function(){freeze(img)},400);return}
      try{
        var c=document.createElement('canvas'),nw=img.naturalWidth||w,nh=img.naturalHeight||h;
        c.width=nw;c.height=nh;c.getContext('2d').drawImage(img,0,0,nw,nh);
        c.className=(img.className||'')+' bt-anim-canvas';
        c.style.width=w+'px';c.style.height=h+'px';c.style.cursor='pointer';c.style.borderRadius='10px';
        c.title='タップで再生';c.__btAnimUrl=img.getAttribute('src');
        img.__btFrozen=1;clearTimeout(img.__btT);
        img.parentNode.replaceChild(c,img);
      }catch(e){}
    }
    function arm(img,ms){if(!img||img.__btArmed||img.__btFrozen)return;img.__btArmed=1;clearTimeout(img.__btT);img.__btT=setTimeout(function(){freeze(img)},ms||AUTO_MS)}
    function scan(root){
      var box=(root&&root.querySelectorAll)?root:document;
      try{var ims=box.querySelectorAll(SEL);for(var i=0;i<ims.length;i++)arm(ims[i],AUTO_MS)}catch(e){}
      try{if(box!==document&&box.matches&&box.matches(SEL))arm(box,AUTO_MS)}catch(e){}
    }
    document.addEventListener('click',function(e){
      var t=e.target;if(!t||t.tagName!=='CANVAS'||!t.__btAnimUrl)return;
      if(!t.closest||!t.closest('.msg-sticker'))return;
      e.preventDefault();e.stopPropagation();
      var img=document.createElement('img');
      img.setAttribute('src',t.__btAnimUrl);img.setAttribute('alt','スタンプ');
      img.className=String(t.className||'').replace('bt-anim-canvas','').replace(/\s+/g,' ').trim();
      if(t.parentNode)t.parentNode.replaceChild(img,t);
      arm(img,REPLAY_MS);
    },true);
    scan(document);
    try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var n=ms[i].target;if(n&&n.nodeType===1)scan(n);else if(n&&n.parentNode)scan(n.parentNode)}}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}
  })();
  function enhance(){
    var map={};rows().forEach(function(r){if(r&&r.image_url)map[r.image_url]=r});
    document.querySelectorAll('.sticker-card,.sticker-item').forEach(function(el){
      var url=el.classList.contains('sticker-item')?(el.getAttribute('data-send')||''):(el.querySelector('img')?el.querySelector('img').src:'');
      var row=map[url];if(!row||el.__btPack)return;
      try{if(row.animated&&Array.isArray(row.pack_stickers)&&row.pack_stickers.length){var _u=el.getAttribute('data-send')||'';if(_u.indexOf('/product/')>=0){el.setAttribute('data-send',row.pack_stickers[0]);var _imq=el.querySelector('img');if(_imq)_imq.setAttribute('src',row.pack_stickers[0])}}}catch(e){}
      el.__btPack=1;el.classList.add(el.classList.contains('sticker-item')?'bt-sticker-item':'bt-sticker-card');
      if(packOf(row)){var bd=document.createElement('span');bd.className='bt-pack-badge';bd.textContent=(row.sound?'🔊':(row.animated?'🎬':'📦'))+row.pack_stickers.length+'枚';el.appendChild(bd);
        el.addEventListener('click',function(e){e.stopImmediatePropagation();e.preventDefault();openPack(row)},true);}
      (function(r){
        var t=null;
        el.addEventListener('touchstart',function(){if(t)clearTimeout(t);t=setTimeout(function(){t=null;btDeleteSticker(r)},650)},{passive:true});
        ['touchend','touchmove','touchcancel'].forEach(function(ev){el.addEventListener(ev,function(){if(t){clearTimeout(t);t=null}},{passive:true})});
        el.addEventListener('contextmenu',function(e){e.preventDefault();btDeleteSticker(r)});
      })(row);
    });
  }
  function ensureLineRow(){
    if(document.getElementById('btLineRow'))return;
    var anchor=document.getElementById('stickerGrid')||document.getElementById('stickerUrlInput')||document.getElementById('stickerFilesInput');
    var view=document.getElementById('stickersView');
    if(!anchor&&view)anchor=view.firstChild;
    if(!anchor)return;
    var row=document.createElement('div');row.id='btLineRow';
    row.style.cssText='display:flex;gap:8px;margin:0 0 12px;padding:10px;background:#101827;border:2px solid #42536a;border-radius:12px;flex-wrap:wrap';
    row.innerHTML='<input id="btLineUrlInput" type="text" placeholder="LINEスタンプのURLを貼り付け（例: store.line.me/stickershop/product/1263049/ja）" style="flex:1;min-width:180px;background:#05070c;color:#fff;border:2px solid #42536a;border-radius:9px;padding:10px"><button id="btLineImportBtn" type="button" style="background:#000;color:#fff;border:2px solid #fff;border-radius:9px;padding:10px 14px;font-weight:700;cursor:pointer">📦 LINEスタンプを取り込む</button>';
    row.parentNode=anchor.parentNode;anchor.parentNode.insertBefore(row,anchor);
    document.getElementById('btLineImportBtn').addEventListener('click',function(){var i=document.getElementById('btLineUrlInput');if(i)i.value=i.value.trim();smart()});
    document.getElementById('btLineUrlInput').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();smart()}});
  }
  new MutationObserver(function(){try{enhance();ensureLineRow()}catch(e){}}).observe(document.documentElement,{childList:true,subtree:true});
  if(document.readyState!=='loading'){try{enhance();ensureLineRow()}catch(e){}}else document.addEventListener('DOMContentLoaded',function(){try{enhance();ensureLineRow()}catch(e){}});
  if(document.readyState!=='loading')enhance();else document.addEventListener('DOMContentLoaded',enhance);
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
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

// 上流（Genspark UI）のHTMLに古い世代の注入スクリプトが残っていると、
// 二重注入や壊れたスクリプトの実行でアプリ全体がエラーになる。
// 現行版を注入する前に、定義済みマーカーを持つ古い <script> を取り除く。
const STALE_MARKERS = ['if(window.__btMsg)return', 'if(window.__btKeep)return', 'if(window.__btMediaShim)return', 'if(window.__btCall)return', 'if(window.__btGroup)return', 'if(window.__btStickerShim)return', 'if(window.__btBan)return', 'BT 0925-', 'BT 0926-'];
function stripStaleInjection(html) {
  try {
    return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => {
      for (const m of STALE_MARKERS) if (block.indexOf(m) >= 0) return '';
      return block;
    });
  } catch (e) { return html; }
}

const KEEP_SHIM = `<script>(function(){
  if(window.__btKeep)return;window.__btKeep=1;
  var TABLE='keep_memos';
  var TERMS_KEY='bluetalk_keep_terms_v1';
  var TERMS=[
    '本規約は、BlueTalk（以下「本サービス」）が提供する「Keepメモ」（以下「本機能」）の利用条件を定めるものです。',
    '本機能は、利用者本人が自分用のメモやリンク、画像などを保存し、あとから取り出せる非公開の機能です。保存した内容は本人のアカウントに紐づき、他の利用者には表示されません。',
    '保存できる内容は、テキストメモ、URL、および画像・動画・ファイルなどの添付です。添付の容量は本サービスのアップロード上限設定に従います。',
    '次の内容を保存しないでください。法令に違反する内容、第三者の著作権・肖像権・プライバシー等の権利を侵害する内容、本サービスの運営を妨げる内容。本機能は非公開ですが、禁止内容が確認された場合は管理者が削除することがあります。',
    '保存容量は本サービス全体の保存枠を共有します。上限に達すると新しく保存できなくなります。',
    'メモは暗号化されずに保存されます。パスワードやカード番号などの機密情報の保存は推奨しません。',
    '本機能に自動バックアップはありません。利用者が削除したメモ、およびアカウント削除に伴うメモは復元できません。',
    '本機能の利用により生じた損害について、運営は故意または重大な過失がある場合を除き、責任を負いません。',
    '運営は、本機能の内容を変更し、または提供を終了することがあります。重要な変更は本サービス上で告知します。',
    '本規約に同意いただけない場合、本機能をご利用いただけません。'
  ];
  function q(id){return document.getElementById(id)}
  function myid(){try{return (typeof myId==='function')?myId():''}catch(e){return ''}}
  function esc2(v){var d=document.createElement('div');d.textContent=(v==null?'':String(v));return d.innerHTML}
  function toast2(m){try{if(typeof toast==='function'){toast(m);return}}catch(e){}try{var t=q('toastMsg');if(t){t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2600)}}catch(e){}}
  var css=document.createElement('style');
  css.textContent='#btKeepRow .bt-keep-av{width:48px;height:48px;border-radius:50%;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;flex:none}#btKeepRow .bt-keep-badge{background:#1877f2;color:#fff;border-radius:8px;font-size:10px;padding:2px 6px;margin-left:6px;vertical-align:middle}#btKeepModal{position:fixed;inset:0;z-index:2147483000;background:rgba(3,6,12,.78);display:flex;align-items:center;justify-content:center;padding:14px}#btKeepModal .bt-keep-card{background:#141b26;color:#fff;width:520px;max-width:96vw;max-height:86vh;border-radius:18px;padding:16px;display:flex;flex-direction:column;box-shadow:0 16px 60px rgba(0,0,0,.6)}#btKeepModal h3{margin:0 0 4px;font-size:17px}#btKeepModal .bt-keep-sub{color:#9fb2c9;font-size:12px;margin:0 0 12px}#btKeepModal textarea{width:100%;box-sizing:border-box;min-height:96px;background:#05070c;color:#fff;border:2px solid #42536a;border-radius:12px;padding:10px;font-size:14px;resize:vertical}#btKeepModal .bt-keep-actions{display:flex;gap:8px;margin:10px 0 4px}#btKeepModal .bt-keep-actions button{flex:1;border-radius:12px;padding:11px;font-weight:700;cursor:pointer;border:2px solid #fff;background:#000;color:#fff}#btKeepModal .bt-keep-save{background:#1877f2!important;border-color:#1877f2!important}#btKeepModal .bt-keep-close{background:#223047!important;border:none!important}#btKeepModal .bt-keep-list{overflow:auto;margin-top:12px}#btKeepModal .bt-keep-item{background:#101827;border:1px solid #2a3950;border-radius:12px;padding:10px;margin-bottom:8px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}#btKeepModal .bt-keep-meta{color:#9fb2c9;font-size:11px;margin-top:6px;display:flex;justify-content:space-between;align-items:center}#btKeepModal .bt-keep-del{background:#3a1f26;border:none;color:#ff9d9d;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px}#btKeepTerms{position:fixed;inset:0;z-index:2147483001;background:rgba(3,6,12,.85);display:flex;align-items:center;justify-content:center;padding:14px}#btKeepTerms .bt-keep-tcard{background:#141b26;color:#fff;width:560px;max-width:96vw;max-height:88vh;border-radius:18px;padding:18px;display:flex;flex-direction:column}#btKeepTerms h3{margin:0 0 8px;font-size:17px}#btKeepTerms ol{overflow:auto;padding-left:20px;margin:0 0 12px;font-size:13px;line-height:1.75;color:#dfe8f3}#btKeepTerms li{margin-bottom:8px}#btKeepTerms .bt-keep-tactions{display:flex;gap:8px}#btKeepTerms button{flex:1;border-radius:12px;padding:12px;font-weight:700;cursor:pointer;border:2px solid #fff;background:#000;color:#fff}#btKeepTerms .bt-keep-agree{background:#1877f2!important;border-color:#1877f2!important}';
  document.head.appendChild(css);
  var css2=document.createElement('style');css2.textContent='#btKeepRow{cursor:pointer}#btKeepRow .bt-keep-av{width:44px;height:44px;border-radius:50%;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;flex:none;margin-right:10px}#btKeepRow .bt-keep-badge{background:#1877f2;color:#fff;border-radius:8px;font-size:10px;padding:2px 6px;margin-left:6px;vertical-align:middle}#btKeepRow .name,#btKeepRow .list-name{font-weight:600}';document.head.appendChild(css2);
  /* ===== 友達リスト: 削除ボタン ===== */
  function meId(){try{if(typeof ME==='object'&&ME&&ME.id)return ME.id}catch(e){}return myid()}
  function decorate(){
    try{
      var list=listEl();if(!list)return;
      var rs=list.querySelectorAll('.friend-row');
      for(var i=0;i<rs.length;i++){
        var row=rs[i];
        if(row.id==='btKeepRow'||row.__btDel)continue;
        var act=row.querySelector('.row-actions');if(!act)continue;
        var btn=row.querySelector('[data-chat]');var uid=btn?btn.getAttribute('data-chat'):null;
        if(!uid)continue;
        row.__btDel=1;
        var d=document.createElement('button');
        d.className='mini-btn danger';d.title='友達を削除';d.setAttribute('data-btunfriend',uid);
        d.innerHTML='<i class="fa-solid fa-user-minus"></i>';
        act.appendChild(d);
      }
    }catch(e){}
  }
  async function btUnfriend(uid){
    var nm='';try{var u=(allUsers||[]).filter(function(x){return String(x.id)===String(uid)})[0];nm=u?(u.display_name||u.username||''):''}catch(e){}
    if(!confirm('「'+(nm||uid)+'」を友達から削除しますか？\\nトーク履歴は残ります（トーク一覧から開けます）。'))return;
    try{
      var my=meId();
      var rels=await API.listAll('friendships');
      var tg=rels.filter(function(r){
        return (String(r.user_id)===String(my)&&String(r.friend_id)===String(uid))||(String(r.user_id)===String(uid)&&String(r.friend_id)===String(my));
      });
      var n=0;
      for(var i=0;i<tg.length;i++){try{if(await API.remove('friendships',tg[i].id))n++}catch(e){}}
      toast2(n?'友達から削除しました':'削除できませんでした');
      if(typeof refreshFriends==='function')await refreshFriends();
      decorate();
    }catch(e){toast2('削除に失敗しました')}
  }
  document.addEventListener('click',function(e){
    var t=e.target&&e.target.closest?e.target.closest('[data-btunfriend]'):null;if(!t)return;
    e.preventDefault();e.stopImmediatePropagation();
    btUnfriend(t.getAttribute('data-btunfriend'));
  },true);
  window.__btUnfriend=btUnfriend;
  function listEl(){
    var ids=['friendList','friend-list','friendsList','friends-list','friend_list'];
    for(var i=0;i<ids.length;i++){var el=q(ids[i]);if(el)return el}
    var r=document.querySelector('.friend-row');if(r&&r.parentNode)return r.parentNode;
    return null;
  }
  function ensureRow(){
    var list=listEl();if(!list)return false;
    if(q('btKeepRow'))return true;
    var item=document.createElement('div');item.id='btKeepRow';
    var nat=(list.id==='friendList'||list.id==='friendsList'||!!list.querySelector('.friend-row'));
    if(nat){item.className='friend-row';item.innerHTML='<div class="bt-keep-av">📝</div><div class="info"><div class="name">Keepメモ <span class="bt-keep-badge">自分用</span></div><div class="status">通話以外の全機能が使えます（自分専用）</div></div>'}
    else{item.className='list-item';item.innerHTML='<div class="bt-keep-av">📝</div><div class="list-info"><div class="list-name">Keepメモ<span class="bt-keep-badge">自分用</span></div><div class="list-preview">通話以外の全機能が使えます（自分専用）</div></div>'}
    item.addEventListener('click',function(e){e.stopImmediatePropagation();e.preventDefault();enterKeep()},true);
    list.insertBefore(item,list.firstChild);
    return true;
  }
  var tries=0;
  var iv=setInterval(function(){tries++;try{ensureRow();decorate()}catch(e){}if(tries>600)clearInterval(iv)},500);
  try{new MutationObserver(function(){try{ensureRow();decorate()}catch(e){}}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}
  function agreed(){try{return localStorage.getItem(TERMS_KEY)==='1'}catch(e){return false}}
  function showTerms(cb){
    var old=q('btKeepTerms');if(old)old.remove();
    var mo=document.createElement('div');mo.id='btKeepTerms';
    var ol='';for(var i=0;i<TERMS.length;i++){ol+='<li>'+esc2(TERMS[i])+'</li>'}
    mo.innerHTML='<div class="bt-keep-tcard"><h3>Keepメモ 利用規約</h3><p class="bt-keep-sub">はじめてお使いになる前に、以下の内容をご確認ください。</p><ol>'+ol+'</ol><div class="bt-keep-tactions"><button class="bt-keep-agree" id="btKeepAgree">同意して始める</button><button id="btKeepDeny">同意しない</button></div></div>';
    document.body.appendChild(mo);
    q('btKeepAgree').addEventListener('click',function(){try{localStorage.setItem(TERMS_KEY,'1')}catch(e){}mo.remove();if(cb)cb()});
    q('btKeepDeny').addEventListener('click',function(){mo.remove();toast2('利用規約に同意しないとKeepメモは利用できません')});
  }
  async function loadMemos(){
    var uid=myid();var out=[];
    try{
      var r=await fetch('/tables/'+TABLE+'?limit=500',{cache:'no-store'});var j=await r.json();
      var rows=(j&&j.data)?j.data:(Array.isArray(j)?j:[]);
      for(var i=0;i<rows.length;i++){if(!uid||String(rows[i].user_id)===String(uid))out.push(rows[i])}
    }catch(e){}
    out.sort(function(a,b){return (Number(b.created_at)||0)-(Number(a.created_at)||0)});
    return out;
  }
  async function saveMemo(text){
    var r=await fetch('/tables/'+TABLE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:myid(),text:text,created_at:Date.now()})});
    if(!r.ok)throw new Error('HTTP '+r.status);
    return await r.json();
  }
  async function delMemo(id){
    var r=await fetch('/tables/'+TABLE+'/'+encodeURIComponent(id),{method:'DELETE'});
    if(!r.ok&&r.status!==204)throw new Error('HTTP '+r.status);
  }
  async function openKeep(){
    if(!agreed()){showTerms(function(){openKeep()});return}
    var old=q('btKeepModal');if(old)old.remove();
    var mo=document.createElement('div');mo.id='btKeepModal';
    mo.innerHTML='<div class="bt-keep-card"><h3>Keepメモ</h3><p class="bt-keep-sub">自分だけが見られるメモです。URLや画像のリンクも貼り付けられます。</p><textarea id="btKeepText" placeholder="メモを入力"></textarea><div class="bt-keep-actions"><button class="bt-keep-save" id="btKeepSave">保存</button><button class="bt-keep-close" id="btKeepClose">閉じる</button></div><div class="bt-keep-list" id="btKeepList">読み込み中...</div></div>';
    mo.addEventListener('click',function(e){if(e.target===mo)mo.remove()});
    document.body.appendChild(mo);
    q('btKeepClose').addEventListener('click',function(){mo.remove()});
    async function render(){
      var listEl=q('btKeepList');if(!listEl)return;
      var mrows=await loadMemos();
      if(!mrows.length){listEl.innerHTML='<p class="bt-keep-sub">まだメモはありません。</p>';return}
      listEl.innerHTML='';
      for(var i=0;i<mrows.length;i++){
        var m=mrows[i];var d=document.createElement('div');d.className='bt-keep-item';
        var body=document.createElement('div');body.textContent=String(m.text||'');d.appendChild(body);
        var meta=document.createElement('div');meta.className='bt-keep-meta';
        var when=document.createElement('span');when.textContent=new Date(Number(m.created_at)||Date.now()).toLocaleString('ja-JP');
        var b=document.createElement('button');b.className='bt-keep-del';b.textContent='削除';
        meta.appendChild(when);meta.appendChild(b);d.appendChild(meta);listEl.appendChild(d);
        (function(id,node){b.addEventListener('click',async function(){if(!confirm('このメモを削除しますか？'))return;try{await delMemo(id);node.remove();toast2('メモを削除しました')}catch(e){toast2('削除に失敗しました')}})})(m.id,d);
      }
    }
    q('btKeepSave').addEventListener('click',async function(){
      var ta=q('btKeepText');var v=ta?ta.value.trim():'';
      if(!v){toast2('メモを入力してください');return}
      var btn=q('btKeepSave');btn.disabled=true;btn.textContent='保存中...';
      try{await saveMemo(v);if(ta)ta.value='';await render();toast2('メモを保存しました')}
      catch(e){toast2('保存に失敗しました')}
      btn.disabled=false;btn.textContent='保存';
    });
    await render();
  }
  window.__btOpenKeep=openKeep;
  /* ===== Keepメモ: 自分専用トーク（通話以外の全機能） ===== */
  function isKeepConv(c){return !!c&&c.type==='self'}
  function keepConvOf(list){try{return (list||[]).filter(function(c){return c&&c.type==='self'&&Array.isArray(c.member_ids)&&c.member_ids.length===1&&String(c.member_ids[0])===String(ME.id)})[0]||null}catch(e){return null}}
  async function ensureKeepConv(){
    var all=[];try{all=await API.listAll('conversations')}catch(e){}
    var c=keepConvOf(all);if(c)return c;
    return await API.create('conversations',{type:'self',name:'Keepメモ',member_ids:[ME.id],last_message:'',last_message_at:Date.now()});
  }
  function setCall(show){['voiceCallBtn','videoCallBtn'].forEach(function(id){var b=q(id);if(b)b.style.display=show?'':'none'})}
  function keepHeader(){
    var t=q('chatHeaderTitle'),a=q('chatHeaderAvatar');
    if(t)t.textContent='Keepメモ';
    if(a)a.src='https://api.dicebear.com/7.x/thumbs/svg?seed=keepmemo';
    setCall(false);
  }
  function wrapApp(){
    if(typeof window.openConversation==='function'&&!window.__btOpenConvWrap){
      var orig=window.openConversation;
      window.openConversation=async function(convId){
        var r=await orig.apply(this,arguments);
        var c=null;try{c=(conversations||[]).filter(function(x){return x.id===convId})[0]||null}catch(e){}
        if(!c){try{c=await API.get('conversations',convId)}catch(e){}}
        if(isKeepConv(c))keepHeader();else setCall(true);
        return r;
      };
      window.__btOpenConvWrap=1;
    }
    if(typeof window.renderChatList==='function'&&!window.__btRenderListWrap){
      var orl=window.renderChatList;
      window.renderChatList=function(){
        var saved=null;
        try{saved=conversations;conversations=(conversations||[]).filter(function(c){return !isKeepConv(c)})}catch(e){}
        var r=orl.apply(this,arguments);
        try{if(saved)conversations=saved}catch(e){}
        return r;
      };
      window.__btRenderListWrap=1;
    }
  }
  wrapApp();
  document.addEventListener('DOMContentLoaded',function(){wrapApp();setTimeout(wrapApp,600)});
  async function openKeepChat(){
    try{
      if(typeof showView==='function')showView('chats');
      var c=await ensureKeepConv();
      if(typeof openConversation!=='function'){toast2('画面の準備中です。少し待ってからもう一度お試しください');return}
      await openConversation(c.id);
      keepHeader();
      setInterval(function(){try{if(String(activeConversationId)===String(c.id))keepHeader()}catch(e){}},1200);
    }catch(e){toast2('Keepメモを開けませんでした: '+(e&&e.message?e.message:''))}
  }
  function enterKeep(){if(!agreed()){showTerms(function(){openKeepChat()});return}openKeepChat()}
  window.__btOpenKeep=enterKeep;window.__btEnterKeep=enterKeep;try{decorate()}catch(e){}
})();</script>`;
async function enhanceHtml(response) {
  const type = response.headers.get('content-type') || ''; if (!type.includes('text/html')) return response;
  const text = stripStaleInjection(await response.text());
  const withManifest = text.includes('</head>') ? text.replace('</head>', EARLY_THEME + '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="https://api.iconify.design/ic:baseline-chat-bubble.svg?color=%231877f2"></head>') : text;
  return new Response(withManifest.replace('</body>', DARK_CSS + APP_ENHANCEMENTS + KEEP_SHIM + MESSAGE_SHIM + MEDIA_SHIM + CALL_SCRIPT + GROUP_SCRIPT + STICKER_SHIM + BAN_SCRIPT + BUILD_CHIP + '</body>'), { status: response.status, headers: { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store', 'X-BlueTalk-Source': 'genspark-ui-cloudflare-kv' } });
}

export default { async fetch(request, env) {
  try {
    return await handler(request, env);
  } catch (e) {
    try { return json({ error: 'internal error' }, 500, request.headers.get('Origin') || new URL(request.url).origin); } catch (e2) { return new Response('error', { status: 500 }); }
  }
} };

async function handler(request, env) {
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
  const btBig = await handleBtBig(request, env, incoming, origin);
  if (btBig) return btBig;
  const btMedia = await handleBtMedia(request, env, incoming);
  if (btMedia) return btMedia;
  if (incoming.pathname.startsWith('/tables/')) return handleTables(request, env, incoming, origin);
  if (incoming.pathname.startsWith('/api/admin/')) return handleAdmin(request, env, incoming, origin);
  const upstream = new URL(UPSTREAM_ORIGIN); upstream.pathname = incoming.pathname; upstream.search = incoming.search;
  return enhanceHtml(await fetch(new Request(upstream.toString(), request), { redirect: 'manual' }));
}