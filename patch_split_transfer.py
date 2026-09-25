#!/usr/bin/env python3
"""BlueTalk: 上限を超えるファイルの「分割送信 → 受信側で自動結合」方式（ギガファイル便方式）。

- 送信: 上限(MAX_SEND)を超えるファイルを 0.98×MAX_SEND 単位のパートに分割。
        パートは既存の 8MiB チャンク経路でアップロード。圧縮可能な形式なら
        gzip して「実際に縮んだときだけ」採用（e:'gzip'）。
        1つのメッセージに bt_transfer マニフェスト（パート一覧）を添えて送る。
- 受信: 受信側クライアントがマニフェストを検出し、保存ボタンを表示。
        パートを順に取得 → gzip なら自動解凍 → 順に連結。
        File System Access API があればメモリに載せずディスクへストリーム書き込み。
        無ければ Blob に連結してダウンロード。最後に元のサイズと照合。
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


# ───────── サーバー: 転送サイズ上限を設定可能にする ─────────
S_CONST_OLD = """function maxFileBytes(env) {"""
S_CONST_NEW = """// アカウントの KV 保存枠に合わせた「分割転送の総量」上限（0 = 無制限）。
// Free は 1GB なので "1073741824" を設定しておくと親切。
function maxTransferBytes(env) {
  const raw = Number((env && env.BT_MAX_TRANSFER_BYTES) || 0);
  return raw > 0 ? raw : 0;
}

function maxFileBytes(env) {"""

S_CFG_OLD = """maxFileBytes: maxFileBytes(env) }, 200, origin);"""
S_CFG_NEW = """maxFileBytes: maxFileBytes(env), maxTransferBytes: maxTransferBytes(env) }, 200, origin);"""

# ───────── クライアント: config に maxTransferBytes を載せる ─────────
C_CFG_OLD = """  var BIG={enabled:false,partSize:32*1024*1024,maxBytes:6*1024*1024*1024,kvPartBytes:KV_PART,maxFileBytes:MAX_SEND,ready:null};"""
C_CFG_NEW = """  var BIG={enabled:false,partSize:32*1024*1024,maxBytes:6*1024*1024*1024,kvPartBytes:KV_PART,maxFileBytes:MAX_SEND,maxTransferBytes:0,ready:null};"""

C_CFG2_OLD = """        if(Number(j.maxFileBytes)){BIG.maxFileBytes=Number(j.maxFileBytes);MAX_SEND=BIG.maxFileBytes}"""
C_CFG2_NEW = """        if(Number(j.maxFileBytes)){BIG.maxFileBytes=Number(j.maxFileBytes);MAX_SEND=BIG.maxFileBytes}
        BIG.maxTransferBytes=Number(j.maxTransferBytes)||0"""

# ───────── クライアント: fetch ラッパーの末尾でマニフェストを索引 ─────────
C_FETCH_OLD = """    }catch(e){console.warn('[bt] media upload failed',e)}
    return raw(input,init);
  };"""
C_FETCH_NEW = """    }catch(e){console.warn('[bt] media upload failed',e)}
    var res=await raw(input,init);
    try{
      var su=typeof input==='string'?input:'';
      if(su.indexOf('/tables/messages')===0){var cl=res.clone();cl.json().then(xferIndex).catch(function(){})}
    }catch(e){}
    return res;
  };"""

BLOCK = r'''  // ══════════ 分割転送（上限超過ファイル）: 送信＝分割 / 受信＝自動結合 ══════════
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
      t.parts.forEach(function(p){if(p&&p.u){var m=/^\/bt-media\/([A-Za-z0-9-]+)$/.exec(p.u);if(m)XFER.byPart[m[1]]=t}});
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
    await BIG.ready;
    if(BIG.enabled&&blob.size>24*1024*1024)return await btUploadBig(blob,onprog);
    return await uploadKVFile(blob,onprog);
  }
  async function btSendTransfer(file,onp){
    await BIG.ready;
    var PART_MAX=Math.max(8*1024*1024,Math.floor(MAX_SEND*0.98));
    var nparts=Math.max(1,Math.ceil(file.size/PART_MAX));
    if(BIG.maxTransferBytes>0&&file.size>BIG.maxTransferBytes){
      var go=window.confirm('合計 '+fmtMB(file.size)+' は、このアカウントの保存枠（'+fmtMB(BIG.maxTransferBytes)+'）を超えます。\n保存枠を超えるとアップロードが途中で失敗します。続けますか？');
      if(!go)return null;
    }
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
      var m=/^\/bt-media\/([A-Za-z0-9-]+)$/.exec(a.getAttribute('href')||'');
      if(!m)return;
      var t=XFER.byPart[m[1]];
      if(!t)return;
      e.preventDefault();e.stopImmediatePropagation();
      t.__done=0;xferNotify(t);
      var bar=document.getElementById('__btXF'+t.tid);
      if(bar){var b=bar.querySelector('[data-xsave]');if(b)b.click()}
    }catch(err){}
  },true);
'''

SENDMEDIA_OLD = """        var vsend=file;
        if(file.size>MAX_SEND){
          vsend=await btCompressPrompt(file,'動画');
          if(!vsend)return;
        }
        btProg('アップロードを準備中',0,'');
        var url=await window.__btUploadFileSlices(vsend,function(p){btProg('アップロード中',p,fmtMB(Math.round(vsend.size*p/100))+' / '+fmtMB(vsend.size))});
        await sendMessage({type:'video',media_data:url});"""

SENDMEDIA_NEW = """        var vsend=file;
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
        await sendMessage({type:'video',media_data:url});"""

SENDGENERIC_OLD = """    if(file.size>MAX_SEND){
      if(isVideoFile(file)){
        var fsend=await btCompressPrompt(file,'動画');
        if(!fsend)return;
        file=fsend;
      }else{
        toast('ファイルが大きすぎます（'+fmtMB(file.size)+'／上限'+fmtMB(MAX_SEND)+'）');
        return;
      }
    }"""

SENDGENERIC_NEW = """    if(file.size>MAX_SEND){
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
    }"""

README_SECTION = r'''
---

## 分割転送（上限を超えるファイル） — 受信側で自動結合

上限（既定 900MB）を超えるファイルは、**分割して送信し、受信側で自動的に
結合（＋圧縮されていれば解凍）して 1 つのファイルとして保存**できるように
なりました。ギガファイル便の分割ダウンロード＋結合を、受信者の操作なしで
行うイメージです。

### 送信側
- 上限を超えると選択モーダルが出ます。
  - **動画**: 「圧縮して送る（1080p）」か「分割してそのまま送る（無劣化）」を選択。
  - **その他のファイル**: 分割して送信（テキストや JSON などは自動で gzip 圧縮）。
- ファイルは `0.98 × 上限` 単位のパートに分割され、各パートは既存の
  8MiB バイナリチャンク経路でアップロードされます。
- 最後に 1 つのメッセージへ `bt_transfer` マニフェスト
  （パート一覧・各パートの元サイズ/格納サイズ・gzip の有無・元のファイル名）を
  添えて送信します。アプリが追加フィールドを落とした場合は、保存を確認したうえで
  直接 POST により補完します。

### 受信側
- メッセージ一覧からマニフェストを検出すると、画面下部に
  「📦 ファイル名 ／ 分割 N パート ／ 合計サイズ」と **保存** ボタンが出ます。
- 保存を押すと、パートを順に取得 → gzip なら自動解凍 → 順に連結します。
  - **File System Access API 対応端末（Chrome/Android 等）**: ディスクへ
    ストリーム書き込み。数 GB でもメモリに全載せしません。
  - **非対応端末**: Blob に連結してダウンロード。
- 完了時に**元のサイズと照合**し、一致しなければエラーとして通知します
  （壊れたファイルを保存させない）。
- 進行状況（受信済み MB / 合計・パート番号）をバーで表示します。

### 圧縮についての注意（重要）
gzip は **すでに圧縮済みのデータにはほとんど効きません**。動画（mp4/mov など）は
内部が既に圧縮されているため、gzip 後もサイズはほぼ変わりません。そのため
本実装は「圧縮して縮んだ時だけ採用する」方式にしており、動画は自動的に
無圧縮（無劣化）で分割されます。テキスト・ログ・CSV・JSON・BMP・WAV などは
実際に数分の一〜十数分の一になります。

### 保存容量についての注意（重要）
パート分割は **「1 メッセージあたりの上限」を超えられるようにする**仕組みで、
アカウントの保存容量そのものは増えません。Workers KV の保存枠は
Free 1GB / Paid 無制限（+$0.50/GB月）です。Free のまま合計 1GB を超える
ファイルを送ると、途中のパートで書き込みが失敗します。
事前に警告を出すため、次の Worker 変数を設定してください。

```toml
[vars]
BT_MAX_TRANSFER_BYTES = "1073741824"   # 合計 1GB（Free の保存枠に合わせる）
BT_MAX_FILE_BYTES     = "943718400"    # 1 パートの上限（既定 900MB）
```

`BT_MAX_TRANSFER_BYTES` を設定すると、超えるサイズの送信時に確認ダイアログが
出ます（0 または未設定 = 無制限＝警告なし）。
'''


def patch():
    src = read("worker.js")
    if "btSendTransfer" in src:
        print("worker.js already patched — skip")
        return
    for old, new, label in [
        (S_CONST_OLD, S_CONST_NEW, "server: maxTransferBytes"),
        (S_CFG_OLD, S_CFG_NEW, "server: config"),
        (C_CFG_OLD, C_CFG_NEW, "client: BIG.maxTransferBytes"),
        (C_CFG2_OLD, C_CFG2_NEW, "client: read maxTransferBytes"),
        (C_FETCH_OLD, C_FETCH_NEW, "client: fetch wrapper indexes transfers"),
        (SENDMEDIA_OLD, SENDMEDIA_NEW, "client: sendMedia oversized video chooser"),
        (SENDGENERIC_OLD, SENDGENERIC_NEW, "client: sendGeneric split"),
    ]:
        src = sub1(src, old, new, label)
    src = sub1(src, "  window.fetch=async function(input,init){", BLOCK + "  window.fetch=async function(input,init){", "client: transfer block")
    src = sub1(src, "'BT 0925-I'", "'BT 0925-J'", "build chip")
    write("worker.js", src)
    r = read("README.md")
    if "分割転送（上限を超えるファイル）" not in r:
        write("README.md", r.rstrip() + "\n" + README_SECTION)
        print("OK[README]")


if __name__ == "__main__":
    patch()
    print("done")
