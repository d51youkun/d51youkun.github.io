#!/usr/bin/env python3
"""BlueTalk: R2 なしで KV 経路の容量を最大化するパッチ。

実測した Cloudflare の上限:
  - KV 値サイズ        : 25 MiB （Free/Paid 共通）
  - KV 書き込み/日      : 1,000 （Free）
  - KV 保存量/アカウント : 1 GB （Free）/ 無制限＋$0.50/GB月（Paid）
  - リクエスト本文      : 100 MB （Free/Pro）
  - CPU/リクエスト      : 10 ms （Free）

方針:
  1. チャンクを base64 → 生バイナリ(application/octet-stream)に変更し
     KV.put(key, request.body) でストリーム投入。33%の膨張を解消＝実質容量増。
  2. チャンクを 8 MiB に拡大。書き込み回数が激減（200MB: 134回 → 25回）。
  3. 1ファイル上限を 200MB → 900MB（Free の 1GB 枠内）。
     上限は Worker 変数 BT_MAX_FILE_BYTES で変更可能。
  4. 上限を超える 8K 動画は端末内で 1080p/720p に圧縮して送信する導線を追加。
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


# ══════════════════ サーバー側 ══════════════════
SERVER_CONST_OLD = """const BIG_MAX_BYTES = 6 * 1024 * 1024 * 1024;
const BIG_PART_BYTES = 32 * 1024 * 1024;"""

SERVER_CONST_NEW = """const BIG_MAX_BYTES = 6 * 1024 * 1024 * 1024;
const BIG_PART_BYTES = 32 * 1024 * 1024;
// KV 経路: 値サイズ上限 25MiB に対し余裕をみて 8MiB。
// 生バイナリで格納するため base64 の 33% 膨張がなく、書き込み回数も大幅に減る。
const KV_PART_BYTES = 8 * 1024 * 1024;
const KV_FREE_STORAGE_BYTES = 1024 * 1024 * 1024;

function maxFileBytes(env) {
  const raw = Number((env && env.BT_MAX_FILE_BYTES) || 0);
  if (raw > 0) return raw;
  return bigMediaEnabled(env) ? BIG_MAX_BYTES : 900 * 1024 * 1024;
}"""

CONFIG_OLD = """    return json({ ok: true, enabled: bigMediaEnabled(env), partSize: BIG_PART_BYTES, minPartBytes: 5 * 1024 * 1024, maxBytes: BIG_MAX_BYTES }, 200, origin);"""
CONFIG_NEW = """    return json({ ok: true, enabled: bigMediaEnabled(env), partSize: BIG_PART_BYTES, minPartBytes: 5 * 1024 * 1024, maxBytes: BIG_MAX_BYTES, kvPartBytes: KV_PART_BYTES, kvStorageBytes: KV_FREE_STORAGE_BYTES, maxFileBytes: maxFileBytes(env) }, 200, origin);"""

PUT_OLD = """  if (request.method === 'PUT' && store[2] !== undefined) {
    const body = await request.json().catch(() => ({}));
    const data = String(body.data || '');
    if (!data) return json({ ok: false, error: 'missing chunk' }, 400, undefined);
    await env.BLUETALK_KV.put(`bluetalk:media:${id}:${store[2]}`, data);
    return json({ ok: true }, 200, undefined);
  }"""

PUT_NEW = """  if (request.method === 'PUT' && store[2] !== undefined) {
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
  }"""

COMPLETE_OLD = """    const total = Math.max(1, Number(body.totalChunks || 1));
    const mime = String(body.mimeType || 'application/octet-stream').slice(0, 120);
    await env.BLUETALK_KV.put(`bluetalk:media:${id}:meta`, JSON.stringify({ totalChunks: total, mimeType: mime, sizeBytes: Number(body.sizeBytes || 0), chunkBytes: Number(body.chunkBytes || 0), created_at: Date.now() }));"""

COMPLETE_NEW = """    const total = Math.max(1, Number(body.totalChunks || 1));
    const mime = String(body.mimeType || 'application/octet-stream').slice(0, 120);
    const encoding = body.encoding === 'binary' ? 'binary' : 'base64';
    const sizeBytes = Number(body.sizeBytes || 0);
    if (sizeBytes > maxFileBytes(env)) return json({ ok: false, error: 'too_large', maxFileBytes: maxFileBytes(env) }, 413, origin);
    await env.BLUETALK_KV.put(`bluetalk:media:${id}:meta`, JSON.stringify({ totalChunks: total, mimeType: mime, sizeBytes, chunkBytes: Number(body.chunkBytes || 0) || (encoding === 'binary' ? KV_PART_BYTES : 0), encoding, created_at: Date.now() }));"""

READ_OLD = """    const totalBytes = Number(meta.sizeBytes || 0);
    const chunkBytes = Number(meta.chunkBytes || 0);
    if (!totalBytes || !chunkBytes) {"""

READ_NEW = """    const binary = meta.encoding === 'binary';
    const totalBytes = Number(meta.sizeBytes || 0);
    const chunkBytes = Number(meta.chunkBytes || 0) || (binary ? KV_PART_BYTES : 0);
    if (!totalBytes || !chunkBytes) {"""

GETCHUNK_OLD = """    const getChunk = async (i) => {
      for (let t = 0; t < 3; t++) {
        const c = await env.BLUETALK_KV.get(`bluetalk:media:${id}:${i}`);
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
    };"""

GETCHUNK_NEW = """    const getChunk = async (i) => {
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
    const asBytes = (raw0) => (binary ? new Uint8Array(raw0) : decodeChunk(raw0));"""

BATCH_OLD = """    let chunkStart = i0 * chunkBytes, ci = i0;
    const BATCH = 6;"""
BATCH_NEW = """    let chunkStart = i0 * chunkBytes, ci = i0;
    // 生バイナリはチャンクが大きいので、1回の pull で抱えるメモリを抑える
    const BATCH = binary ? 2 : 6;"""

PULL_OLD = """          let bytes = decodeChunk(raw0);"""
PULL_NEW = """          let bytes = asBytes(raw0);"""


# ══════════════════ クライアント側 ══════════════════
CONST_OLD = """  var MAX_CHUNK=150000,IMAGE_CAP=30*1024*1024,SLICE=1536*1024;
  var KV_MAX=200*1024*1024,MAX_SEND=6*1024*1024*1024;
  var BIG={enabled:false,partSize:32*1024*1024,maxBytes:MAX_SEND,ready:null};
  window.__btBig=BIG;
  BIG.ready=(async function(){try{var r=await raw('/bt-big/config');var j=await r.json();if(j&&j.ok){BIG.enabled=!!j.enabled;BIG.partSize=Number(j.partSize)||BIG.partSize;BIG.maxBytes=Number(j.maxBytes)||BIG.maxBytes}}catch(e){}return BIG})();"""

CONST_NEW = """  var MAX_CHUNK=150000,IMAGE_CAP=30*1024*1024,SLICE=1536*1024;
  var KV_PART=8*1024*1024,MAX_SEND=900*1024*1024;
  var BIG={enabled:false,partSize:32*1024*1024,maxBytes:6*1024*1024*1024,kvPartBytes:KV_PART,maxFileBytes:MAX_SEND,ready:null};
  window.__btBig=BIG;
  BIG.ready=(async function(){
    try{
      var r=await raw('/bt-big/config');var j=await r.json();
      if(j&&j.ok){
        BIG.enabled=!!j.enabled;
        BIG.partSize=Number(j.partSize)||BIG.partSize;
        BIG.maxBytes=Number(j.maxBytes)||BIG.maxBytes;
        if(Number(j.kvPartBytes)){BIG.kvPartBytes=Number(j.kvPartBytes);KV_PART=BIG.kvPartBytes}
        if(Number(j.maxFileBytes)){BIG.maxFileBytes=Number(j.maxFileBytes);MAX_SEND=BIG.maxFileBytes}
      }
    }catch(e){}
    return BIG;
  })();"""

KVFILE_OLD = """  async function uploadKVFile(file,onprog){
    var id=(crypto.randomUUID?crypto.randomUUID():'v'+Date.now()+Math.random().toString(16).slice(2));
    var total=Math.ceil(file.size/SLICE),mime=file.type||'application/octet-stream';
    for(var i=0;i<total;i++){
      var buf=await file.slice(i*SLICE,(i+1)*SLICE).arrayBuffer();
      var r=await raw('/bt-media/'+id+'/'+i,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:(i===0?'data:'+mime+';base64,':'')+b64buf(buf)})});
      if(!r.ok)throw new Error('chunk failed');
      if(onprog&&i%5===0)onprog(Math.round(100*(i+1)/total));
    }
    var c=await raw('/bt-media/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({totalChunks:total,mimeType:mime,sizeBytes:file.size,chunkBytes:SLICE})});
    if(!c.ok)throw new Error('complete failed');
    return '/bt-media/'+id;
  };"""

KVFILE_NEW = """  async function uploadKVFile(file,onprog){
    var id=(crypto.randomUUID?crypto.randomUUID():'v'+Date.now()+Math.random().toString(16).slice(2));
    var PART=KV_PART,mime=file.type||'application/octet-stream';
    var total=Math.max(1,Math.ceil(file.size/PART)),sent=0;
    for(var i=1;i<=total;i++){
      var blob=file.slice((i-1)*PART,Math.min(i*PART,file.size));
      var ok=false,err=null;
      for(var a=0;a<4&&!ok;a++){
        try{
          var r=await raw('/bt-media/'+id+'/'+(i-1),{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:blob});
          if(r.ok){ok=true}
          else{err=new Error('part '+i+' HTTP '+r.status);await new Promise(function(z){setTimeout(z,600*(a+1))})}
        }catch(e){err=e;await new Promise(function(z){setTimeout(z,600*(a+1))})}
      }
      if(!ok){btProgEnd();throw err||new Error('アップロードに失敗しました')}
      sent+=blob.size;
      if(onprog)onprog(Math.min(99,Math.round(100*sent/Math.max(1,file.size))));
    }
    var c=await raw('/bt-media/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({totalChunks:total,mimeType:mime,sizeBytes:file.size,chunkBytes:PART,encoding:'binary'})});
    if(!c.ok){btProgEnd();throw new Error('完了処理に失敗しました (HTTP '+c.status+')')}
    return '/bt-media/'+id;
  };"""

DATAURL_OLD = """  async function uploadKVDataUrl(d){
    var id=(crypto.randomUUID?crypto.randomUUID():'m'+Date.now()+Math.random().toString(16).slice(2));
    var total=Math.ceil(d.length/MAX_CHUNK),mime=(d.slice(5,d.indexOf(';'))||'application/octet-stream');
    for(var i=0;i<total;i++){var r=await raw('/bt-media/'+id+'/'+i,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d.slice(i*MAX_CHUNK,(i+1)*MAX_CHUNK)})});if(!r.ok)throw new Error('chunk failed')}
    var c=await raw('/bt-media/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({totalChunks:total,mimeType:mime})});
    if(!c.ok)throw new Error('complete failed');
    return '/bt-media/'+id;
  };"""

DATAURL_NEW = """  async function uploadKVDataUrl(d){
    await BIG.ready;
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
  };"""

COMPRESS_BLOCK = r"""  // ── 端末内圧縮（上限を超える 8K 動画などを 1080p/720p に落とす）──
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
          ac=new AC();
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
      rec.start(2000);
      try{await v.play()}catch(e){throw new Error('再生を開始できませんでした。もう一度お試しください')}
      await new Promise(function(res){
        if(v.onended===null){}
        v.onended=function(){res()};
        (function tick(){
          try{ctx.drawImage(v,0,0,w,h)}catch(e){}
          if(onprog)onprog(Math.max(1,Math.min(99,Math.round(100*(v.currentTime||0)/Math.max(1,dur)))));
          if(v.ended||(v.duration&&v.currentTime>=v.duration-0.03)){res();return}
          requestAnimationFrame(tick);
        })();
        setTimeout(res,((dur||900)+90)*1000);
      });
      try{rec.stop()}catch(e){}
      await stopped;
      if(!chunks.length)throw new Error('圧縮結果が空でした');
      var out=new Blob(chunks,{type:mime.indexOf('mp4')>=0?'video/mp4':'video/webm'});
      try{out.name=String(file.name||'video').replace(/\.[^.]+$/,'')+(mime.indexOf('mp4')>=0?'.mp4':'.webm')}catch(e){}
      return out;
    }finally{
      try{if(rec&&rec.state!=='inactive')rec.stop()}catch(e){}
      try{if(stream)stream.getTracks().forEach(function(t){t.stop()})}catch(e){}
      if(ac){try{ac.close()}catch(e){}}
      try{URL.revokeObjectURL(objectUrl)}catch(e){}
    }
  }
  async function btCompressPrompt(file,label){
    await BIG.ready;
    if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream){
      toast(label+'が大きすぎます（'+fmtMB(file.size)+'／上限'+fmtMB(MAX_SEND)+'）。この端末では圧縮できません');
      return null;
    }
    var dur=await btVideoDuration(file);
    if(!dur||dur<=0){
      toast(label+'が大きすぎます（'+fmtMB(file.size)+'／上限'+fmtMB(MAX_SEND)+'）');
      return null;
    }
    var target=dur*6000000/8>MAX_SEND*0.9?720:1080;
    var est=dur*(target>=1080?6000000:3000000)/8;
    var mins=Math.ceil(dur/60);
    var ok=window.confirm(label+'が大きすぎます（'+fmtMB(file.size)+'／上限'+fmtMB(MAX_SEND)+'）。\n\n端末内で'+target+'pに圧縮してから送信します。\n・推定サイズ: 約'+fmtMB(est)+'\n・所要時間: 動画と同じ長さ（約'+mins+'分）\n\nこのまま圧縮を開始しますか？\n（「キャンセル」で送信を中止します）');
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
"""

SENDMEDIA_OLD = """      await BIG.ready;
      if(isImageFile(file)){
        if(file.size>IMAGE_CAP){toast('画像が大きすぎます（30MBまで）');return}
        var d=await compressImage(file,2560,0.9);await sendMessage({type:'image',media_data:d});
      }else if(isVideoFile(file)){
        if(file.size>MAX_SEND){toast('動画が大きすぎます（最大'+(MAX_SEND/1073741824)+'GBまで）');return}
        if(!BIG.enabled&&file.size>KV_MAX){toast('この動画は大きすぎます。サーバー側でR2（大容量ストレージ）を有効にすると最大6GBまで送信できます');return}
        btProg('アップロードを準備中',0,'');
        var url=await window.__btUploadFileSlices(file,function(p){toast('動画をアップロード中... '+p+'%')});
        await sendMessage({type:'video',media_data:url});"""

SENDMEDIA_NEW = """      await BIG.ready;
      if(isImageFile(file)){
        if(file.size>IMAGE_CAP){toast('画像が大きすぎます（30MBまで）');return}
        var d=await compressImage(file,2560,0.9);await sendMessage({type:'image',media_data:d});
      }else if(isVideoFile(file)){
        var vsend=file;
        if(file.size>MAX_SEND){
          vsend=await btCompressPrompt(file,'動画');
          if(!vsend)return;
        }
        btProg('アップロードを準備中',0,'');
        var url=await window.__btUploadFileSlices(vsend,function(p){btProg('アップロード中',p,fmtMB(Math.round(vsend.size*p/100))+' / '+fmtMB(vsend.size))});
        await sendMessage({type:'video',media_data:url});"""

SENDGENERIC_OLD = """    await BIG.ready;
    if(file.size>MAX_SEND){toast('ファイルが大きすぎます（最大'+(MAX_SEND/1073741824)+'GBまで）');return}
    if(!BIG.enabled&&file.size>KV_MAX){toast('このファイルは大きすぎます。サーバー側でR2（大容量ストレージ）を有効にすると最大6GBまで送信できます');return}
    try{
      if(isImageFile(file)||isVideoFile(file)){await sendMedia(file);return}
      var media;
      if(file.size>8*1024*1024){btProg('アップロードを準備中',0,'');media=await window.__btUploadFileSlices(file,function(p){btProg('アップロード中',p,'')})}"""

SENDGENERIC_NEW = """    await BIG.ready;
    if(file.size>MAX_SEND){
      if(isVideoFile(file)){
        var fsend=await btCompressPrompt(file,'動画');
        if(!fsend)return;
        file=fsend;
      }else{
        toast('ファイルが大きすぎます（'+fmtMB(file.size)+'／上限'+fmtMB(MAX_SEND)+'）');
        return;
      }
    }
    try{
      if(isImageFile(file)||isVideoFile(file)){await sendMedia(file);return}
      var media;
      if(file.size>8*1024*1024){btProg('アップロードを準備中',0,'');media=await window.__btUploadFileSlices(file,function(p){btProg('アップロード中',p,fmtMB(Math.round(file.size*p/100))+' / '+fmtMB(file.size))})}"""

README_SECTION = r'''
---

## 容量アップ（R2 なし / Workers KV のみ）

R2 を使わず、**Workers KV の許容範囲を最大限使う**構成に変更しました。
上限はすべて Cloudflare 公式ドキュメントの実測値に基づきます。

| Cloudflare の上限（Free プラン） | 値 |
| --- | --- |
| KV の値サイズ | 25 MiB（Free / Paid 共通） |
| KV の書き込み | 1,000 / 日 |
| KV の保存量（アカウント） | 1 GB |
| リクエスト本文 | 100 MB（Free / Pro） |
| CPU / リクエスト | 10 ms（Free） |

### 変更点
1. **base64 をやめて生バイナリ格納**
   チャンクを `application/octet-stream` で送り、`KV.put(key, request.body)`
   にストリームのまま渡します。base64 の **33% の膨張が消え**、同じ 1 GB に
   約 1.5 倍のデータが入ります（メモリ・CPU の消費も削減）。
2. **チャンクを 1.5 MiB → 8 MiB に拡大**（`KV_PART_BYTES`）
   200 MB の動画で **134 回 → 25 回**の書き込み。1 日 1,000 回の
   書き込み制限にかかりにくくなります。
3. **1 ファイル上限を 200 MB → 900 MB**
   Free の KV 保存量 1 GB の範囲内。Worker 変数 `BT_MAX_FILE_BYTES` で
   変更できます（有料プランなら例: `4GB` を設定）。
4. **上限を超える動画は端末内で圧縮**
   8K の 5 分動画（実測 1.5〜6 GB）は KV には物理的に入らないため、
   送信前にブラウザ内で **1080p / 720p に再エンコード**してから送ります
   （推定サイズを提示して確認を取る。所要時間は動画の長さと同程度）。

### 上限の変更方法
`wrangler.toml` / `wrangler-bluetalk.toml` に以下を追加すると上限を上げられます
（KV の保存量を超えると書き込みが失敗するため、プランに合わせて設定）。

```toml
[vars]
BT_MAX_FILE_BYTES = "4294967296"   # 4GB
```

### 既存データとの互換
旧形式（base64 文字列チャンク）は `meta.encoding = "base64"` として読み続けられる
ため、過去に送ったファイルもそのまま再生できます。新規アップロードは
`meta.encoding = "binary"` になります。

### さらに容量が必要な場合
- **Workers Paid（$5/月）**: KV の保存量が「無制限（+$0.50/GB月）」になり、
  書き込みも 100 万回/月に増えます。R2 を有効化せずに GB 単位の保存が可能です。
- **R2（無料枠 10 GB）**: 本リポジトリには R2 マルチパート経路（`/bt-big`）が
  実装済みで、未設定のため無効になっています。バケット作成と
  `BLUETALK_MEDIA` バインディングの追加だけで有効化でき、1 ファイル 6 GB
  まで、書き込み回数制限なしで扱えます。
'''


def patch_worker():
    src = read("worker.js")
    if "kvPartBytes" in src:
        print("worker.js already patched — skip")
        return
    for old, new, label in [
        (SERVER_CONST_OLD, SERVER_CONST_NEW, "server: KV constants"),
        (CONFIG_OLD, CONFIG_NEW, "server: config endpoint"),
        (PUT_OLD, PUT_NEW, "server: binary chunk PUT"),
        (COMPLETE_OLD, COMPLETE_NEW, "server: complete + encoding/size guard"),
        (READ_OLD, READ_NEW, "server: encoding-aware read"),
        (GETCHUNK_OLD, GETCHUNK_NEW, "server: binary getChunk"),
        (BATCH_OLD, BATCH_NEW, "server: batch size"),
        (PULL_OLD, PULL_NEW, "server: pull uses asBytes"),
        (CONST_OLD, CONST_NEW, "client: constants + config"),
        (KVFILE_OLD, KVFILE_NEW, "client: binary KV upload"),
        (DATAURL_OLD, DATAURL_NEW, "client: dataURL -> binary"),
        (SENDMEDIA_OLD, SENDMEDIA_NEW, "client: sendMedia caps"),
        (SENDGENERIC_OLD, SENDGENERIC_NEW, "client: sendGeneric caps"),
    ]:
        src = sub1(src, old, new, label)
    src = sub1(src, "  window.fetch=async function(input,init){", COMPRESS_BLOCK + "  window.fetch=async function(input,init){", "client: compression block")
    src = sub1(src, "'BT 0925-H'", "'BT 0925-I'", "build chip")
    write("worker.js", src)


def patch_readme():
    src = read("README.md")
    if "容量アップ（R2 なし" in src:
        print("README already patched — skip")
        return
    write("README.md", src.rstrip() + "\n" + README_SECTION)


if __name__ == "__main__":
    patch_worker()
    patch_readme()
    print("done")
