#!/usr/bin/env python3
"""BlueTalk: 大容量メディア（8K/数分の動画=数GB）対応パッチ。

- worker.js に R2 マルチパート中継（/bt-big/*）を追加
- クライアント側シム(MEDIA_SHIM)に大容量アップロード経路＋進捗UIを追加
- ワークフローに「R2バケット確保（任意）」ステップを追加（失敗してもデプロイ継続）
"""
import io
import os
import re
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


# ───────────────────────── worker.js : サーバー側 ─────────────────────────
SERVER_BLOCK = r'''
// ===== 大容量メディア（Cloudflare R2 マルチパート） =====
// 8K・数分の動画は数GBになり、KV（値25MiB上限 / 無料枠1GB）には格納できない。
// R2 バインディング BLUETALK_MEDIA があればマルチパートへ中継し、無ければ 503 を返す
// （クライアントは従来の KV 経路へ自動フォールバックする）。
const BIG_MAX_BYTES = 6 * 1024 * 1024 * 1024;
const BIG_PART_BYTES = 32 * 1024 * 1024;

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
    return json({ ok: true, enabled: bigMediaEnabled(env), partSize: BIG_PART_BYTES, minPartBytes: 5 * 1024 * 1024, maxBytes: BIG_MAX_BYTES }, 200, origin);
  }
  const m = /^\/bt-big\/([A-Za-z0-9-]{6,64})(?:\/(init|part|complete|abort)\/(\d+)?)?$/.exec(url.pathname);
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

'''

# ───────────────────────── worker.js : クライアント側シム ─────────────────────────
CLIENT_CONST_OLD = "  var MAX_CHUNK=150000,VIDEO_CAP=200*1024*1024,IMAGE_CAP=30*1024*1024,GENERIC_CAP=200*1024*1024,SLICE=1536*1024;"
CLIENT_CONST_NEW = r'''  var MAX_CHUNK=150000,IMAGE_CAP=30*1024*1024,SLICE=1536*1024;
  var KV_MAX=200*1024*1024,MAX_SEND=6*1024*1024*1024;
  var BIG={enabled:false,partSize:32*1024*1024,maxBytes:MAX_SEND,ready:null};
  window.__btBig=BIG;
  BIG.ready=(async function(){try{var r=await raw('/bt-big/config');var j=await r.json();if(j&&j.ok){BIG.enabled=!!j.enabled;BIG.partSize=Number(j.partSize)||BIG.partSize;BIG.maxBytes=Number(j.maxBytes)||BIG.maxBytes}}catch(e){}return BIG})();
  function isVideoFile(f){return Boolean(f)&&((f.type&&f.type.indexOf('video/')===0)||/\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts|m2ts)$/i.test(f.name||''))}
  function isImageFile(f){return Boolean(f)&&((f.type&&f.type.indexOf('image/')===0)||/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(f.name||''))}'''

CLIENT_BIG_BLOCK = r'''  // ── 大容量（8K動画など）アップロード: R2 マルチパート ──
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
    await BIG.ready;
    if(BIG.enabled&&file.size>24*1024*1024)return await btUploadBig(file,onprog);
    return await uploadKVFile(file,onprog);
  };
  window.__btUploadDataUrl=async function(d){
    await BIG.ready;
    if(BIG.enabled&&d.length>24*1024*1024){
      var blob=await (await raw(d)).blob();
      if(!blob||!blob.size)throw new Error('メディアを読み込めませんでした');
      return await btUploadBig(blob,null);
    }
    return await uploadKVDataUrl(d);
  };
'''


def patch_worker():
    src = read("worker.js")
    if "handleBtBig" in src:
        print("worker.js already patched — skip")
        return
    src = sub1(src, "async function cascadeDeleteUserData(env, id) {",
               SERVER_BLOCK.lstrip("\n") + "async function cascadeDeleteUserData(env, id) {",
               "server: insert handleBtBig")
    src = sub1(src,
               "  const btMedia = await handleBtMedia(request, env, incoming);\n  if (btMedia) return btMedia;",
               "  const btBig = await handleBtBig(request, env, incoming, origin);\n  if (btBig) return btBig;\n  const btMedia = await handleBtMedia(request, env, incoming);\n  if (btMedia) return btMedia;",
               "server: route /bt-big")
    # クライアント側シム: 定数
    src = sub1(src, CLIENT_CONST_OLD, CLIENT_CONST_NEW, "client: constants + BIG config")
    # 既存 KV 経路を関数へ改名し、新しい窓口を後ろに足す
    src = sub1(src, "  window.__btUploadDataUrl=async function(d){", "  async function uploadKVDataUrl(d){", "client: rename uploadDataUrl")
    src = sub1(src, "  window.__btUploadFileSlices=async function(file,onprog){", "  async function uploadKVFile(file,onprog){", "client: rename uploadFileSlices")
    src = sub1(src, "  window.fetch=async function(input,init){", CLIENT_BIG_BLOCK + "  window.fetch=async function(input,init){", "client: big upload block")
    # 送信ハンドラ: 上限と分岐
    src = sub1(src,
               "      if(file.type.startsWith('image/')){\n        if(file.size>IMAGE_CAP){toast('画像が大きすぎます（30MBまで）');return}",
               "      await BIG.ready;\n      if(isImageFile(file)){\n        if(file.size>IMAGE_CAP){toast('画像が大きすぎます（30MBまで）');return}",
               "client: sendMedia image branch")
    src = sub1(src,
               "      }else if(file.type.startsWith('video/')){\n        if(file.size>VIDEO_CAP){toast('動画が大きすぎます（200MBまで）');return}\n        toast('動画をアップロード中... 0%');\n        var url=await window.__btUploadFileSlices(file,function(p){toast('動画をアップロード中... '+p+'%')});",
               "      }else if(isVideoFile(file)){\n        if(file.size>MAX_SEND){toast('動画が大きすぎます（最大'+(MAX_SEND/1073741824)+'GBまで）');return}\n        if(!BIG.enabled&&file.size>KV_MAX){toast('この動画は大きすぎます。サーバー側でR2（大容量ストレージ）を有効にすると最大6GBまで送信できます');return}\n        btProg('アップロードを準備中',0,'');\n        var url=await window.__btUploadFileSlices(file,function(p){toast('動画をアップロード中... '+p+'%')});",
               "client: sendMedia video branch")
    src = sub1(src,
               "    if(file.size>GENERIC_CAP){toast('ファイルが大きすぎます（200MBまで）');return}\n    try{\n      if(file.type.startsWith('image/')||file.type.startsWith('video/')){await sendMedia(file);return}\n      var media;\n      if(file.size>8*1024*1024){toast('ファイルをアップロード中...');media=await window.__btUploadFileSlices(file)}",
               "    await BIG.ready;\n    if(file.size>MAX_SEND){toast('ファイルが大きすぎます（最大'+(MAX_SEND/1073741824)+'GBまで）');return}\n    if(!BIG.enabled&&file.size>KV_MAX){toast('このファイルは大きすぎます。サーバー側でR2（大容量ストレージ）を有効にすると最大6GBまで送信できます');return}\n    try{\n      if(isImageFile(file)||isVideoFile(file)){await sendMedia(file);return}\n      var media;\n      if(file.size>8*1024*1024){btProg('アップロードを準備中',0,'');media=await window.__btUploadFileSlices(file,function(p){btProg('アップロード中',p,'')})}",
               "client: sendGeneric branch")
    write("worker.js", src)


# ───────────────────────── ワークフロー ─────────────────────────
R2_STEP = r'''      - name: Ensure R2 bucket bluetalk-media (optional)
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CFG: __CFG__
        run: |
          set -uo pipefail
          acct="${CLOUDFLARE_ACCOUNT_ID:-7ece58c3241a1b80e660bff102f3352a}"
          api="https://api.cloudflare.com/client/v4/accounts/${acct}/r2/buckets"
          code="$(curl -s -o /tmp/r2list.json -w '%{http_code}' -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$api" || echo 000)"
          if [ "$code" != "200" ]; then
            echo "::notice::R2 is not reachable with this API token (HTTP ${code}). Deploying without the R2 binding — large-file upload stays disabled."
            exit 0
          fi
          if ! grep -q 'bluetalk-media' /tmp/r2list.json; then
            code2="$(curl -s -o /tmp/r2create.json -w '%{http_code}' -X POST -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" --data '{"name":"bluetalk-media"}' "$api" || echo 000)"
            echo "create bucket bluetalk-media: HTTP ${code2}"
            if [ "$code2" != "200" ] && [ "$code2" != "201" ]; then head -c 400 /tmp/r2create.json; echo; exit 0; fi
          fi
          grep -q 'BLUETALK_MEDIA' "$CFG" && { echo "R2 binding already present"; exit 0; }
          printf '\n[[r2_buckets]]\nbinding = "BLUETALK_MEDIA"\nbucket_name = "bluetalk-media"\n' >> "$CFG"
          echo "R2 binding BLUETALK_MEDIA -> bluetalk-media appended to ${CFG}"

'''


def patch_workflow(path, anchor, cfg):
    src = read(path)
    if "BLUETALK_MEDIA" in src:
        print("%s already patched — skip" % path)
        return
    step = R2_STEP.replace("__CFG__", cfg)
    src = sub1(src, anchor, step + anchor, "workflow %s" % path)
    write(path, src)


# ───────────────────────── README ─────────────────────────
README_SECTION = r'''
---

## 大容量メディア（8K・数分の動画 = 数GB）

### なぜ必要か
Cloudflare KV は 1 値あたり **25 MiB** 上限・無料枠は**合計 1 GB**、Worker の
リクエストボディ上限は **100 MB**（Free/Pro）です。8K の 5 分動画（実測で
1.5〜6 GB 程度）は KV には物理的に収まりません。そこで **Cloudflare R2**
（オブジェクトストレージ、無料枠 10 GB）へ中継する経路を追加しました。

### 仕組み
| 経路 | 用途 | 上限 |
| --- | --- | --- |
| `/bt-media/<id>/<n>`（KV・従来） | 小さい画像・スタンプ・短い動画 | 200 MB |
| `/bt-big/<id>/*`（R2・新規） | 8K などの大容量動画/ファイル | 6 GB（1ファイル） |

クライアントは起動時に `GET /bt-big/config` を取得し、R2 が有効なら
`> 24 MB` のファイルを自動的に R2 マルチパート経路へ振り分けます。
R2 が無効（バインディング未設定）の場合は従来の KV 経路にフォールバックし、
上限を超えるファイルには「R2を有効化してください」と案内します。

- `POST /bt-big/<id>/init` … `createMultipartUpload`（メタは KV に保存）
- `PUT  /bt-big/<id>/part/<n>?u=<uploadId>` … 32 MiB 単位で R2 へ中継
- `POST /bt-big/<id>/complete` … `complete`（R2 がオブジェクトを確定）
- `POST /bt-big/<id>/abort` … 中断時に多重パートを破棄
- `GET  /bt-big/<id>` … `Range` 対応のストリーミング再生（206 Partial Content）
- `DELETE /bt-big/<id>` … 管理者トークン必須

クライアント側は進捗バー（％・MB/s・残り時間）を表示し、パート単位で
最大4回リトライしてから中断します。

### 有効化（初回のみ・人間の操作が必要）
1. Cloudflare ダッシュボードで **R2 を有効化**（無料枠あり）。
2. 既存のデプロイ用 API トークンを編集し、権限 **Workers R2 Storage: Edit**
   を追加（トークン値は変わらないので GitHub Secrets の更新は不要）。
3. `main` へ push（または Actions を再実行）すると、ワークフローが
   バケット `bluetalk-media` を作成し、`wrangler.toml` /
   `wrangler-bluetalk.toml` に `[[r2_buckets]] BLUETALK_MEDIA` を追記して
   デプロイします。R2 が未設定の間もこのステップはスキップされ、
   デプロイ自体は成功し続けます。
'''


def patch_readme():
    src = read("README.md")
    if "bt-big" in src:
        print("README already patched — skip")
        return
    write("README.md", src.rstrip() + "\n" + README_SECTION)


if __name__ == "__main__":
    patch_worker()
    patch_workflow(".github/workflows/deploy-bluetalk.yml", "      - name: Deploy BlueTalk Worker", "wrangler-bluetalk.toml")
    patch_workflow(".github/workflows/cloudflare-pages.yml", "      - name: Ensure Cloudflare Pages project exists", "wrangler.toml")
    patch_readme()
    print("--- BUILD_CHIP ---")
    for line in read("worker.js").splitlines():
        if "BUILD_CHIP" in line and "=" in line:
            print(line[:200])
            break
    print("done")
