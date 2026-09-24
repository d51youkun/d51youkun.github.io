# BlueTalk

大切な人と、いつでもつながる。LINE風のチャットサービス(HTML / CSS / JavaScript + Cloudflare Workers + Workers KV)。

- **本体URL**: https://bluetalk.by-youhei.workers.dev
- **ミラーURL**: https://bluetalk.pages.dev (同一KVを参照する双方向ミラー)
- **UIソース**: https://nfieyeke.gensparkspace.com (Genspark Space で管理、Workerがライブ反映)

---

## 1. システム構成

```
nfieyeke.gensparkspace.com        … UIソース(静的SPA: ログイン + アプリ)
   │ ①ライブプロキシ(worker.jsがUPSTREAM_ORIGINとして即時反映)
   │ ②15分おき変更検知 → snapshot commit → push → Actions自動デプロイ
   ▼
bluetalk Worker(bluetalk.by-youhei.workers.dev)  … 本体
   │  HTML配信 + 機能注入 + API + 管理画面 を1つの Worker で提供
   │  データは Workers KV「bluetalk-kv」に保存
   ▼
bluetalk-kv (namespace: d10e32d4336848b9a7de80f2f40ca34e)
   ▲
   └ bluetalk Pages(bluetalk.pages.dev)… dist/_worker.js 経由で同一KVに接続(ミラー)

周辺サービス(旧BlueChatから継続利用):
  bluechat-sync.by-youhei.workers.dev    … メディア(blob)ストレージ
  bluechat-call-1..3.by-youhei.workers.dev … 音声通話シグナリング
  bluechat-video-1.by-youhei.workers.dev … 映像通話シグナリング
```

## 2. worker.js API 仕様(本体Worker)

1ファイル(`worker.js`)で全機能を実装。デプロイ設定は `wrangler-bluetalk.toml`。

### 2.1 静的配信とプロキシ

| パス | 動作 |
|---|---|
| `/` その他 | `https://nfieyeke.gensparkspace.com` へプロキシし、HTMLに機能注入(2.5)して返す。`Cache-Control: no-store`、応答ヘッダ `X-BlueTalk-Source: genspark-ui-cloudflare-kv` 付き |
| `/manifest.webmanifest` | PWAマニフェストを生成(name: BlueTalk / theme `#1877f2` / start_url `/index.html` / standalone) |
| `/sw.js` | 最小サービスワーカーを生成(notificationclick → ウィンドウフォーカス / `/app.html` オープン) |
| `/admin.html` | 管理画面HTMLを生成(3章) |

### 2.2 汎用テーブルAPI `/tables/*`(KV CRUD)

KVキー: `bluetalk:table:<テーブル名>` にJSON配列を保存。

| メソッド/パス | 動作 |
|---|---|
| `GET /tables/<t>?limit=&page=` | 一覧。`limit` 1〜1000(既定100)、`page` 1〜。返値 `{data, total, page, limit}`。**`users` は `banned: true` を自動除外** |
| `GET /tables/<t>/<id>` | 1行取得(usersはbanned除外) |
| `POST /tables/<t>` | 行追加。`id`(省略時 `crypto.randomUUID()`)と `created_at`(省略時現在時刻)を自動付与 |
| `PATCH/PUT /tables/<t>/<id>` | 部分更新。`updated_at` を自動セット。**`users` の `display_name` / `username` 変更は30日に1回まで**(`profile_changed_at` で管理、違反は429 + `nextChangeAt`。`admin_override: true` で回避=管理用) |
| `DELETE /tables/<t>/<id>` | 行削除。**`users` はカスケード削除**: friendships / 会話(自分を含む)/ 会話内メッセージ / スタンプ / 通話 / 通話シグナルを一括削除 |

テーブル名は `/^[A-Za-z0-9_-]{1,64}$/` に制限。CORS(2.6)は全APIに付与。

### 2.3 管理API `/api/admin/*`

- `POST /api/admin/login` — `{password}` をSHA-256化し、worker内定数のハッシュと照合。成功でセッショントークン(UUID×2連結)を発行、KV `bluetalk:admin-session:<token>` に **TTL 8時間** で保存
- `GET /api/admin/users` — 全ユーザー(banned含む)
- `GET /api/admin/conversations` — 会話 + 全メッセージ + ユーザー(監視用)
- `PATCH /api/admin/users/<id>` — 任意フィールド更新(verified / banned / ban_reason / ban_message / ban_appeal_message / title 等)
- 認証は `Authorization: Bearer <token>` または `X-Admin-Token` ヘッダ

### 2.4 その他のAPI

| エンドポイント | 仕様 |
|---|---|
| `GET /api/account-status/<userId>` | Ban状態照合。`{ok, banned, reason, message, appealMessage, updatedAt}` |
| `GET /api/turn-credentials` | WebRTC用TURN資格情報。Secrets `METERED_TURN_ENDPOINT` + `METERED_TURN_API_KEY` があれば **metered.live の短期資格情報**(https かつ `*.metered.live` のみ許可、最大16サーバーに制限)を、無ければ共有フォールバック(openrelay.metered.ca STUN/TURN)を返す |
| `POST /api/media` | メディアアップロード。`{data: dataURL, mimeType, name}` を **180,000字ずつのチャンク** に分割し bluechat-sync Worker へ転送後 complete。dataURL長 **12MB超は413**(バイナリ換算 約9MB、UI表示上は8MB)。返値 `{uploadId, url: "/media/<id>"}` |
| `GET /media/<id>` | bluechat-sync からblobを取得して実バイトで返す。`Cache-Control: public, max-age=31536000, immutable` |
| `POST /api/call-gateway/signal` | 通話シグナリング中継。`{mode: voice|video, call_id, from, to, signal_type, payload}` を受け、`call_id` のハッシュ(`hash*31+文字` 方式)で担当サーバーへ振り分け: **voice → bluechat-call-1〜3 / video → bluechat-video-1** |
| `GET /api/call-gateway/signals/<userId>?mode=&call_id=` | 自分宛てシグナル取得(同じ振り分け規則) |

### 2.5 HTML注入機能(重複排除済み)

プロキシしたHTMLの `</body>` 直前に注入するのは**旧URL独自の4機能のみ**(2026-09-24に重複分を削除済み):

1. **管理者トリガー** — キー入力 `d51-498go` で `/admin.html` へ / プロフィール名クリックでも管理画面導線
2. **認証バッジ・ゴールド称号表示** — `allUsers` の `verified` / `title` を名前横に ✓ / 称号表示(gensparkspace UIは未実装のため注入で提供)
3. **WebRTC通話シグナリング(CALL_SCRIPT)** — gensparkspace UIは通話UI(callOverlay・着信Toast・リンゴン音)を持つがシグナリング未実装のため、Worker注入で完全実装: `voiceCallBtn`/`videoCallBtn` 発信(calls行作成→offer送信)→ `acceptCallBtn`/`rejectCallBtn` 着信(calls ポーリング3秒→offer取得→answer)→ ICE candidate交換(`candidate`)→ `endCallBtn`/`bye` 終了。ミュート・ビデオ切替、45秒無応答タイムアウト、二重着信ガード付き。シグナルはブラウザから bluechat-call-1..3 / bluechat-video-1 へ**直接送受信**(call_idのハッシュでサーバー選定、旧クライアントと同一規約。Worker経由の `/api/call-gateway/*` / `/api/media` プロキシはWorker→Worker通信がCloudflareセキュリティ1042でブロックされるためクライアント直結が正規経路)
4. **画像フォールバック** — 読み込み失敗imgをdicebearアバターに差し替え
5. `</head>` 直前に PWA用 `<link rel="manifest">` と apple-touch-icon + `/sw.js` 登録

**削除された重複注入**(gensparkspace UIがネイティブ実装済みのため): 規約モーダル(termsModal) / 通知許可・アカウント削除ボタン(requestNotifyBtn・deleteAccountBtn) / 完全一致ID検索(friendSearchInput) / 自分のQR(myQrModal・showMyQrBtn) / スタンプ帳(stickerGrid等) / コンポーザー3ボタントレイ(attachMediaBtn等と競合) / ファイル送信フォールバック / ダーク・レスポンシブCSS(darkModeToggle・@media自前実装と競合) / 通話・メディアのfetchフック(gensparkspace app.jsはcall_signals・/api/media・RTCPeerConnectionを未使用のため死にコード)。

**シグナリング実測検証済み**(2026-09-24): callサーバー直結でCORS許可・offer/answer往復とも200。着信ポーリング(calls 3秒/シグナル1秒)はクライアント側で実施。

### 2.6 CORS

`Origin` が `*.workers.dev` / `*.pages.dev` なら反映、それ以外は `https://bluetalk.by-youhei.workers.dev` 固定。メソッド `GET, POST, PATCH, PUT, DELETE, OPTIONS`、許可ヘッダ `Content-Type, Authorization, X-Admin-Token`、プリフライト24時間キャッシュ。

## 3. データモデル(KV テーブル)

| テーブル | 主なフィールド |
|---|---|
| `users` | `id, username, password, display_name, avatar_url, verified, title, banned, ban_reason, ban_message, ban_appeal_message, profile_changed_at, created_at, updated_at` |
| `friendships` | `id, user_id, friend_id` (相互に2行) |
| `conversations` | `id, member_ids[], (group名等)` |
| `messages` | `id, conversation_id, sender_id, type(text/image/video/file/sticker…), content, attachment_url, file_name, mime_type, created_at` |
| `stickers` | `id, user_id, image_url(dataURL可), name` |
| `calls` | `id, caller_id, callee_id, call_type(voice/video)` |
| `call_signals` | `id, call_id, sender_id/from, signal_type/type, payload/sdp` |

- クライアントの永続化: `localStorage` — `bt_current_user`(ログインuser id)、`bluetalk_admin_token`、`bluetalk_terms_v2`、旧BlueChat互換で `bluechat_data` / `bluechat_sync_url` / `bluechat_sync_configured`
- **既知の注意**: `GET /tables/users` はログイン照合のため `password` を応答に含む(平文)。旧BlueChatから踏襲された仕様で、URLを知れば一覧が取得可能。PBKDF2ハッシュ検証関数(v38)は存在するため、改修時はこれを利用できる

## 4. ビルドシステム(build.py)

`python3 build.py` で実行:

1. **結合JS** — `app.js`(プレースホルダ `__DEFAULT_SYNC_URL__` / `__SYNC_ALTERNATE_URLS__` / `__ADMIN_EMAIL__` を `sync-config.json` で置換)→ `features.js` → `v4.js` → `v6〜v35.js` + `v37-speed.js` + `v38-security.js`(存在分すべて順に連結)
2. **単一HTML化** — `styles.css` + `body.html` + `lib/qrcode.min.js` + `lib/html5-qrcode.min.js` を埋め込み、`index.html` / `BlueChat.html` を出力(**この1ファイルで完結動作**)
3. **dist/ 出力** — `index.html, BlueChat.html, icon.png, favicon.svg, sw.js, _headers, .nojekyll` に加え、**`worker.js` を `_worker.js` としてコピー**(PagesのAdvanced Mode: 静的配信でも同一のAPI/KV/注入が動く)
4. 配布用フォルダ `../BlueChatX/` も生成(ローカル用)

## 5. CI/CD(GitHub Actions)

リポジトリ `d51youkun/d51youkun.github.io` / ブランチ `main`。必要シークレット: `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

| ワークフロー | トリガー | 内容 |
|---|---|---|
| **Deploy BlueTalk**(`deploy-bluetalk.yml`) | push to main / 手動 | ①bluetalk-kv の存在確認(無ければ作成)→ ②`wrangler deploy --config wrangler-bluetalk.toml` → **bluetalk.by-youhei.workers.dev** を更新。concurrency `bluetalk-worker`(キャンセル上書き) |
| **Deploy BlueTalk Pages**(`cloudflare-pages.yml`) | push to main / 手動 | `build.py` → KV確認 → `wrangler pages deploy dist`(プロジェクト `bluetalk`)= **bluetalk.pages.dev** を更新 |
| **Sync gensparkspace UI**(`sync-genspark.yml`) | **15分おきcron** / 手動 | gensparkspaceの6ファイル(index.html, app.html, css/style.css, js/api.js, js/auth.js, js/app.js)を取得しSHA-256照合 → **変更検知時のみ** `snapshot/`(digest.txt, files.txt, index.html)をcommit & push → そのpushが Deploy BlueTalk を自動発火。**これにより「gensparkspaceを更新すれば15分以内に旧URLへ自動デプロイ」が成立** |
| Deploy Render Sync Server(`render-deploy.yml`) | `server/**` / `render.yaml` 変更時 | Secret `RENDER_DEPLOY_HOOK` にPOST(未設定ならskip) |

**手動発火**: GitHubの Actions タブ → 各ワークフロー → Run workflow。APIからは `gh workflow run`。

** gensparkspace更新→反映の流れ(自動)**:
```
Genspark Space でUI更新
 → (即時)Workerがプロキシ経由で新UIを配信開始
 → (≤15分)cronが差分検知 → snapshot commit → push
 → Deploy BlueTalk が走り、Workerの最新版が確実にデプロイされる
```

## 6. 管理画面

- 入口: `https://bluetalk.by-youhei.workers.dev/admin.html`(アプリ内でキー `d51-498go` 入力、またはプロフィール名クリックでも到達可)
- 機能: ユーザー一覧 / **Premium認証トグル(✓)** / **Ban↔解除**(理由・本人への案内文・誤Ban時のお詫び文を保存)/ **ゴールド称号** 付与 / **会話監視**(全会話の閲覧。利用規約に基づく安全調査用途)
- Banされたユーザーはログイン一覧APIから隠れ、`/api/account-status/<id>` で理由を表示
- セッショントークンは8時間で失効(再ログイン)

## 7. レガシー同期サーバー(旧BlueChat互換)

`server/sync-server.js` — Node ≥18、ポート **8766**。単体で `node server/sync-server.js`。

- localStorageベースの旧クライアント向け消息・メディア同期(現在のBlueTalk本体は使用しないが、**メディアblob API(`/api/media/chunk|complete|blob`)は現行でもこの仕組みを利用**)
- データファイル: `DATA_DIR` → `TMPDIR` → `/tmp` → `server/data.json` の順で書き込み可能な先を選択
- 管理者: 環境変数 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `MODERATOR_EMAIL` / `MODERATOR_PASSWORD`(`server/.env.example` 参照)
- デプロイ先: Render(`render.yaml`, health check `/api/health`)+ Cloudflare Worker版(`bluechat-sync`, KV `BLUECHAT_KV`)
- クライアント側の同期URL設定: マイページ →「同期サーバーを保存」(例 `http://192.168.1.5:8766`)。`onrender.com` のURLは保存時に本体URLへ自動移行される

## 8. ローカル開発

```bash
# 本体(UI+Worker)をローカルで動かす
npx wrangler dev --config wrangler-bluetalk.toml   # KVはローカルモック

# 旧ビルド単体(Build(pages/index.html)を静的配信)
python3 build.py && python3 -m http.server 8765 --bind 0.0.0.0

# 同期サーバー
node server/sync-server.js                          # :8766
```

- カメラ(QRスキャン)は **https または localhost のみ** 動作
- `build.py` は `index.html` / `BlueChat.html` をリポジトリ直下に**上書きコミットする運用**(生成物もtracked)

## 9. セキュリティ上の注意

- `/tables/users` の平文パスワード含有(前述)— 次期改修でハッシュ化推奨
- 管理者パスワードはSHA-256定数をworker内に保持(総当たり耐性は通常のSHA-256相当)
- Media/TURN/シグナリングの各下位Workerは旧BlueChatから継続。認証なし(呼び出し元制限はWorker側で Origin 転送のみ)
- Secrets は GitHub Actions と Cloudflare Worker 環境変数でのみ管理(リポジトリに含めない)

## 10. ファイル構成

```
├── worker.js                  # 本体Worker(全API + プロキシ + 注入 + 管理画面)
├── wrangler-bluetalk.toml     # 本体Worker設定(bluetalk / BLUETALK_KV)
├── wrangler.toml              # Pages設定(bluetalk / 同一KVバインド / dist出力)
├── build.py                   # ビルド(結合JS→単一HTML→dist/)
├── app.js / features.js       # クライアント本体(旧BlueChat系、sync URL差し込み対応)
├── v4..v35, v37-speed.js,
│   v38-security.js            # 機能追加パッチ群(build時に結合)
├── body.html / styles.css     # 旧クライアントのHTML骨格・スタイル
├── lib/                       # qrcode / html5-qrcode
├── sw.js / _headers / .nojekyll / icon.png / favicon.svg
├── sync-config.json           # 旧同期サーバーURL設定(build差し込み)
├── render.yaml                # Render設定(レガシー同期サーバー)
├── server/                    # レガシー同期サーバー(Node)
├── snapshot/                  # gensparkspace UIスナップショット(自動生成・変更検知用)
└── .github/workflows/
    ├── deploy-bluetalk.yml    # 本体Worker デプロイ
    ├── cloudflare-pages.yml   # Pages デプロイ(bluetalk.pages.dev)
    ├── sync-genspark.yml      # gensparkspace変更検知(15分毎)→ 自動デプロイ
    └── render-deploy.yml      # Render フック
```

## 11. 運用メモ

- **データの単一ソースは bluetalk-kv**。WorkerとPagesのどちらで書き込んでも即時共通(移行・バックアップはKV exportで対応)
- 旧URL・Pages とも `on: push main` なので、README更新でも両デプロイが走る(軽微なコストのため許容)
- gensparkspace側でUIを更新したら基本何もしなくてよい(自動デプロイ)。緊急反映は Actions の「Sync gensparkspace UI」を手動実行
- アカウント削除はユーザー自身がプロフィール →「アカウントを削除」(カスケード削除)
