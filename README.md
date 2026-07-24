# BlueChat

LINE風のチャットアプリ（HTML / CSS / JavaScript）

## 他の端末と同期（メッセージ・写真を共有）

1. PCで同期サーバーを起動:
   ```bash
   node server/sync-server.js
   ```
2. 各端末の **マイページ** → **同期サーバーを保存** に同じURLを入力  
   例: `http://192.168.1.5:8766`（PCのIPアドレス）
3. 両方の端末で同じURLを設定すれば、メッセージと写真が届きます

※ 友だち追加はQRコードのまま。同期URLだけ同じにしてください。

## 公開・起動方法

### ローカルで公開（今すぐ使う）

ターミナルでプロジェクトフォルダに移動し、次を実行します。

```bash
python3 -m http.server 8765 --bind 0.0.0.0
```

ブラウザで開く:

- このPC: http://localhost:8765
- 同じWi-Fiのスマホ: http://（PCのIPアドレス）:8765

### インターネットに公開（無料）

**Netlify Drop（最も簡単）**

1. https://app.netlify.com/drop を開く
2. `BlueChat` フォルダ（または `BlueChat.zip`）をドラッグ＆ドロップ
3. 表示されたURLが公開アドレスになります

**Cloudflare Pages（推奨）**

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. リポジトリ `d51youkun.github.io` を選択
3. ビルド設定:

   | 項目 | 値 |
   |------|-----|
   | Production branch | `main` |
   | Build command | `python3 build.py` |
   | Build output directory | `/`（空欄でも可） |
   | **Deploy command** | `npx wrangler pages deploy . --project-name=bluechat` |

   ※ プロジェクト名を変えた場合は `--project-name=` も同じ名前にしてください。  
   `npx wrangler deploy`（Workers用）だと失敗します。必ず **`pages deploy`** です。

4. **Save and Deploy** で公開。初回URLは `https://bluechat.pages.dev` のような `*.pages.dev` になります
5. **Custom domains** から独自ドメインを追加できます（Cloudflare で DNS 管理している場合）

**GitHub Actions で自動デプロイする場合**（上記 Git 連携の代わり）:

1. Cloudflare で Pages プロジェクト名 `bluechat` を作成
2. GitHub リポジトリの Secrets に追加:
   - `CLOUDFLARE_API_TOKEN` — API トークン（Account / Cloudflare Pages: Edit）
   - `CLOUDFLARE_ACCOUNT_ID` — アカウント ID
3. `main` へ push すると `.github/workflows/cloudflare-pages.yml` がデプロイします

**GitHub Pages（従来）**

1. GitHubで新しいリポジトリを作成
2. このフォルダを push
3. Settings → Pages → Source を `main` ブランチに設定
4. `https://（ユーザー名）.github.io/（リポジトリ名）/` で公開

## 使い方

1. ローカルサーバー（`python3 -m http.server 8765`）で開くか、Netlify等に公開したURLで開く
2. 名前を入力して「はじめる」
3. 友だち追加 →「カメラを起動する」→ QRコードをスキャン / 自分のQRコードを表示
4. トーク・グループ作成でメッセージのやり取り
5. マイページでプロフィール画像をアップロード

## 管理者

画面下部の「管理者の方はこちら」からログインできます。

管理者のメールアドレスとパスワードは **同期サーバーの環境変数** で設定します（リポジトリには含めません）。

| 環境変数 | 説明 |
|----------|------|
| `ADMIN_EMAIL` | スーパー管理者のメール |
| `ADMIN_PASSWORD` | スーパー管理者のパスワード |
| `MODERATOR_EMAIL` | モデレーターのメール |
| `MODERATOR_PASSWORD` | モデレーターのパスワード |

**Render での設定:** Dashboard → サービス → Environment → 上記4つを追加 → 再デプロイ

**ローカル開発:** `server/.env.example` を `server/.env` にコピーして値を入力し、環境変数を読み込んでから起動してください。

管理者メニューでは、登録ユーザーの管理や全会話の閲覧ができます。

## 注意

- データはブラウザの localStorage に保存されます（このデバイスのみ）
- 他のデバイスへの引き継ぎはできません
- 友だち追加のQRコードは、別のデバイスでも読み取れます（QRにユーザー情報が含まれます）
- カメラは **https://** または **localhost** でのみ使えます（ファイルを直接開く `file://` では許可ダイアログが出ません）
- QRスキャン時は「カメラを起動する」ボタンを押すと、カメラの使用許可が求められます

## ファイル構成

**`BlueChat.html`**（または `index.html`）— **これ1つだけで動きます**（CSS・JS・ライブラリすべて内蔵）

開発用に分割されたファイルも同梱:
- `styles.css` / `app.js` / `lib/` — 編集用（再ビルド時に `BlueChat.html` を更新）
