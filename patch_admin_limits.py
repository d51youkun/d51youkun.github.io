#!/usr/bin/env python3
"""BlueTalk: 管理者メニューからアップロード上限（GB単位）を設定できるようにする。

- 設定は KV「bluetalk:settings」に保存。再デプロイ不要で即時反映。
- 管理画面に「アップロード上限設定」カード（1ファイル上限 / 合計上限）と
  メディア使用量の表示を追加。
- メディア使用量は KV list のメタデータを使うため、追加読み取りなしで集計。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def read(p):
    with io.open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with io.open(os.path.join(ROOT, p), "w", encoding="utf-8") as f:
        f.write(s)


def sub1(src, old, new, label):
    n = src.count(old)
    if n != 1:
        print("FAIL[%s]: expected 1 occurrence, found %d" % (label, n))
        sys.exit(1)
    print("OK[%s]" % label)
    return src.replace(old, new, 1)


# ══════════ サーバー: 設定の読み書き ══════════
SETTINGS_OLD = """// アカウントの KV 保存枠に合わせた「分割転送の総量」上限（0 = 無制限）。
// Free は 1GB なので "1073741824" を設定しておくと親切。
function maxTransferBytes(env) {
  const raw = Number((env && env.BT_MAX_TRANSFER_BYTES) || 0);
  return raw > 0 ? raw : 0;
}

function maxFileBytes(env) {
  const raw = Number((env && env.BT_MAX_FILE_BYTES) || 0);
  if (raw > 0) return raw;
  return bigMediaEnabled(env) ? BIG_MAX_BYTES : 900 * 1024 * 1024;
}"""

SETTINGS_NEW = """const SETTINGS_KEY = 'bluetalk:settings';
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
}"""

CONFIG_OLD2 = """maxFileBytes: maxFileBytes(env), maxTransferBytes: maxTransferBytes(env) }, 200, origin);"""
CONFIG_NEW2 = """maxFileBytes: cfg.maxFileBytes, maxTransferBytes: cfg.maxTransferBytes, kvReadOnly: false }, 200, origin);"""

CONFIG_HEAD_OLD = """  if (url.pathname === '/bt-big/config') {
    return json({ ok: true, enabled: bigMediaEnabled(env),"""
CONFIG_HEAD_NEW = """  if (url.pathname === '/bt-big/config') {
    const cfg = await readSettings(env);
    return json({ ok: true, enabled: bigMediaEnabled(env),"""

COMPLETE_GUARD_OLD = """    if (sizeBytes > maxFileBytes(env)) return json({ ok: false, error: 'too_large', maxFileBytes: maxFileBytes(env) }, 413, origin);"""
COMPLETE_GUARD_NEW = """    const limitCfg = await readSettings(env);
    if (sizeBytes > limitCfg.maxFileBytes) return json({ ok: false, error: 'too_large', maxFileBytes: limitCfg.maxFileBytes }, 413, origin);"""

# メタ保存時に metadata を付けて、使用量集計を追加読み取りなしで行えるようにする
META_PUT_OLD = """    await env.BLUETALK_KV.put(`bluetalk:media:${id}:meta`, JSON.stringify({ totalChunks: total, mimeType: mime, sizeBytes, chunkBytes: Number(body.chunkBytes || 0) || (encoding === 'binary' ? KV_PART_BYTES : 0), encoding, created_at: Date.now() }));"""
META_PUT_NEW = """    const chunkBytes = Number(body.chunkBytes || 0) || (encoding === 'binary' ? KV_PART_BYTES : 0);
    const metaObj = { totalChunks: total, mimeType: mime, sizeBytes, chunkBytes, encoding, created_at: Date.now() };
    await env.BLUETALK_KV.put(`bluetalk:media:${id}:meta`, JSON.stringify(metaObj), { metadata: { sizeBytes, mimeType: mime.slice(0, 60), encoding } });"""

# ══════════ サーバー: 管理API ══════════
ADMIN_ANCHOR = """  if (url.pathname === '/api/admin/appeals' && request.method === 'GET') return json({ ok: true, appeals: await readTable(env, 'appeals') }, 200, origin);"""
ADMIN_ADD = ADMIN_ANCHOR + """
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
  }"""
ADMIN_IDENTITY = """function adminTokenIdentity(request) {
  const token = requestAdminToken(request) || '';
  return token ? token.slice(0, 8) : '';
}

"""

# ══════════ 管理画面のUI ══════════
CARD_ANCHOR = """<h2>誤Ban申し立て（利用者から管理者へ）</h2><div id="appeals"></div></section>"""
CARD_ADD = """<h2>誤Ban申し立て（利用者から管理者へ）</h2><div id="appeals"></div></section><section class="card"><h2>アップロード上限設定</h2><div id="limitsCard">読み込み中...</div></section>"""

LOGOUT_ANCHOR = """document.getElementById('logout').onclick=()=>{localStorage.removeItem('bluetalk_admin_token');login()};"""
LOGOUT_ADD = LOGOUT_ANCHOR + """limits();"""

LIMITS_FN = r"""  async function limits(){
    const t=localStorage.getItem('bluetalk_admin_token');const box=document.getElementById('limitsCard');if(!t||!box)return;
    const h={Authorization:'Bearer '+t};
    function fmt(n){const b=Number(n)||0;if(b>=1073741824)return (b/1073741824).toFixed(2)+'GB';if(b>=1048576)return (b/1048576).toFixed(1)+'MB';return b+'B'}
    function gb(n){return ((Number(n)||0)/1073741824).toFixed(2)}
    let s={},st={};
    try{const r=await fetch('/api/admin/settings',{headers:h});if(!r.ok){box.innerHTML='<p class="danger">設定を取得できませんでした（ログインし直してください）</p>';return}const j=await r.json();s=j.settings||{};st=j.storage||{}}catch(e){box.innerHTML='<p class="danger">通信に失敗しました</p>';return}
    const cap=Number(s.kvStorageBytes)||1073741824,the=Number(st.bytes)||0,pct=cap?Math.round(1000*the/cap)/10:0;
    const warn=pct>=80?' style="color:#a52828"':'';
    box.innerHTML='<p><small>ここで設定した上限は、保存するとすぐ全端末に反映されます（利用者が次に送信するときに適用）。</small></p>'+
      '<div class="row"><b>1ファイルの上限</b><input id="maxFileGb" type="number" step="0.1" min="0.1" style="width:110px;padding:10px;border:1px solid #c7d9ee;border-radius:9px" value="'+gb(s.maxFileBytes)+'"> <span>GB</span> <small>現在 '+fmt(s.maxFileBytes)+'　（1回の送信で扱う1ファイルの最大サイズ）</small></div>'+
      '<div class="row"><b>合計の上限</b><input id="maxTfGb" type="number" step="0.1" min="0" style="width:110px;padding:10px;border:1px solid #c7d9ee;border-radius:9px" value="'+gb(s.maxTransferBytes)+'"> <span>GB</span> <small>0 = 無制限　'+(Number(s.maxTransferBytes)?('現在 '+fmt(s.maxTransferBytes)):'現在 無制限')+'（分割して送る場合の総量の目安・超過時に警告）</small></div>'+
      '<div class="row"><small>転送チャンク: '+fmt(s.kvPartBytes)+' 固定（Workers KV の値上限は 25MiB。チャンクを上げると書き込み回数が減り、APIトークン不足を避けられます）</small></div>'+
      '<div class="row"><button id="saveLimits">上限を保存</button><small id="limMsg">'+(s.updated_at?('前回更新: '+new Date(s.updated_at).toLocaleString('ja-JP')):'未設定（既定値を使用中）')+'</small></div>'+
      '<div class="row"><b>メディア使用量</b><small'+warn+'>'+Number(st.files||0)+' 件 ・ '+fmt(the)+' ／ プラン枠 '+fmt(cap)+'（'+pct+'%）'+(st.listing_capped?' ・ 一部のみ集計':'')+'</small></div>'+
      '<p><small>目安: Workers Free の KV 保存枠は 1GB です。1ファイルの上限を大きくしても、合計がこの枠を超えると書き込みに失敗します。Workers Paid なら保存量は無制限（+$0.50/GB月）です。</small></p>';
    document.getElementById('saveLimits').onclick=async()=>{
      const a=Number(document.getElementById('maxFileGb').value||0),b=Number(document.getElementById('maxTfGb').value||0),m=document.getElementById('limMsg');
      if(!(a>0)){m.textContent='1ファイルの上限は0より大きい値を入力してください';return}
      if(b<0){m.textContent='合計の上限は0以上で入力してください';return}
      if(a>100||b>100){m.textContent='100GB以下で入力してください';return}
      if(!confirm('上限を変更します。\n1ファイル: '+a+'GB\n合計: '+(b>0?b+'GB':'無制限')+'\n\n保存しますか？'))return;
      m.textContent='保存中...';
      try{
        const r=await fetch('/api/admin/settings',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({maxFileBytesGb:a,maxTransferBytesGb:b})});
        const j=await r.json().catch(function(){return {}});
        if(!r.ok){m.textContent='保存に失敗しました: '+((j&&j.error)||r.status);return}
        m.textContent='保存しました（1ファイル '+fmt(j.settings.maxFileBytes)+' ／ 合計 '+(Number(j.settings.maxTransferBytes)?fmt(j.settings.maxTransferBytes):'無制限')+'）';
        limits();
      }catch(e){m.textContent='通信に失敗しました'}
    };
  }
"""

OPENCONV_ANCHOR = """  function openConv(cid){"""

# ══════════ クライアント: 設定を送信時に再取得 ══════════
CLIENT_READY_OLD = """  BIG.ready=(async function(){
    try{
      var r=await raw('/bt-big/config');var j=await r.json();
      if(j&&j.ok){
        BIG.enabled=!!j.enabled;
        BIG.partSize=Number(j.partSize)||BIG.partSize;
        BIG.maxBytes=Number(j.maxBytes)||BIG.maxBytes;
        if(Number(j.kvPartBytes)){BIG.kvPartBytes=Number(j.kvPartBytes);KV_PART=BIG.kvPartBytes}
        if(Number(j.maxFileBytes)){BIG.maxFileBytes=Number(j.maxFileBytes);MAX_SEND=BIG.maxFileBytes}
        BIG.maxTransferBytes=Number(j.maxTransferBytes)||0
      }
    }catch(e){}
    return BIG;
  })();"""

CLIENT_READY_NEW = """  BIG.lastAt=0;
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
        BIG.lastAt=Date.now();
      }
    }catch(e){}
    return BIG;
  };
  BIG.ready=(async function(){await BIG.sync();return BIG})();"""

README_SECTION = r'''
---

## アップロード上限の設定（管理画面）

`/admin.html` にログインすると **「アップロード上限設定」** カードから上限を
GB 単位で変更できます。設定は Workers KV（`bluetalk:settings`）に保存され、
**再デプロイ不要で即時反映**されます（利用者が次に送信するときに適用）。

| 設定項目 | 内容 |
| --- | --- |
| 1ファイルの上限 | 1 回の送信で扱う 1 ファイルの最大サイズ（GB）。既定 0.88GB |
| 合計の上限 | 分割送信時の総量の目安（GB）。0 = 無制限。超過時に確認ダイアログを表示 |

同カードに **メディア使用量**（ファイル数・合計・プラン枠に対する割合）も
表示します。使用量は KV の `list` が返すメタデータから集計するため、
追加の読み取りは発生しません（新規アップロード分にメタデータを付与）。

### 上限の目安
| プラン | KV 保存枠 | 1ファイル上限の目安 |
| --- | --- | --- |
| Workers Free | 1 GB | 0.9GB 程度（合計が1GBを超えると書き込み失敗） |
| Workers Paid | 無制限（+$0.50/GB月） | 任意（100GB まで設定可） |

上限は Worker 変数 `BT_MAX_FILE_BYTES` / `BT_MAX_TRANSFER_BYTES` でも指定できます
（管理画面の設定が優先。未設定時に変数 → 既定値の順で採用）。
'''


def patch():
    src = read("worker.js")
    if "readSettings" in src:
        print("worker.js already patched — skip")
        return
    for old, new, label in [
        (SETTINGS_OLD, SETTINGS_NEW, "server: readSettings + mediaUsage"),
        (CONFIG_HEAD_OLD, CONFIG_HEAD_NEW, "server: config reads settings"),
        (CONFIG_OLD2, CONFIG_NEW2, "server: config payload"),
        (COMPLETE_GUARD_OLD, COMPLETE_GUARD_NEW, "server: complete uses settings"),
        (META_PUT_OLD, META_PUT_NEW, "server: meta metadata for usage"),
        (ADMIN_ANCHOR, ADMIN_ADD, "server: admin settings API"),
        ("function requestAdminToken(request) {", ADMIN_IDENTITY + "function requestAdminToken(request) {", "server: admin identity helper"),
        (CARD_ANCHOR, CARD_ADD, "admin UI: card"),
        (LOGOUT_ANCHOR, LOGOUT_ADD, "admin UI: limits() call"),
        (OPENCONV_ANCHOR, LIMITS_FN + OPENCONV_ANCHOR, "admin UI: limits() body"),
        (CLIENT_READY_OLD, CLIENT_READY_NEW, "client: BIG.sync"),
    ]:
        src = sub1(src, old, new, label)
    src = src.replace("await BIG.ready;", "await BIG.sync();")
    print("OK[client: await BIG.sync()]")
    src = sub1(src, "'BT 0925-J'", "'BT 0925-K'", "build chip")
    write("worker.js", src)
    r = read("README.md")
    if "アップロード上限の設定（管理画面）" not in r:
        write("README.md", r.rstrip() + "\n" + README_SECTION)
        print("OK[README]")


if __name__ == "__main__":
    patch()
    print("done")
