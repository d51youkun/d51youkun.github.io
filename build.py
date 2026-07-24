#!/usr/bin/env python3
"""Build BlueChat HTML outputs from source files."""

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PAGES_HEAD = """<!DOCTYPE html>
<html lang="ja" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#1a6fd4">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>BlueChatX</title>
  <link rel="icon" type="image/png" href="icon.png?v=20260713">
  <link rel="apple-touch-icon" href="icon.png?v=20260713">
  <style>
"""

BUNDLE_HEAD = PAGES_HEAD


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def load_sync_config() -> dict:
    try:
        cfg = json.loads(read("sync-config.json"))
        return cfg if isinstance(cfg, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def get_app_js() -> str:
    app_js = read("app.js")
    cfg = load_sync_config()
    sync_url = str(cfg.get("url", "")).strip()
    alternates = cfg.get("alternates", [])
    if not isinstance(alternates, list):
        alternates = []
    admin_email = str(cfg.get("adminEmail", "d51498go@icloud.com")).strip()
    admin_password = str(cfg.get("adminPassword", "D51498Go"))
    if not sync_url:
        sync_url = "https://bluechat-sync-846f.onbelmo.uk"
    app_js = app_js.replace("__DEFAULT_SYNC_URL__", sync_url, 1)
    app_js = app_js.replace("__SYNC_ALTERNATE_URLS__", json.dumps(alternates), 1)
    app_js = app_js.replace("__ADMIN_EMAIL__", admin_email, 1)
    return app_js.replace("__ADMIN_PASSWORD__", admin_password, 1)


def get_merged_js() -> str:
    """app.js + features.js + v4.js + v6.js + v7.js + v8.js を1つのスクリプトに結合"""
    parts_js = [get_app_js(), read("features.js"), read("v4.js")]
    for extra in ("v6.js", "v7.js", "v8.js", "v9.js", "v10.js", "v11.js", "v12.js", "v13.js", "v14.js", "v15.js", "v16.js", "v17.js", "v18.js", "v19.js", "v20.js", "v21.js", "v22.js", "v23.js", "v24.js", "v25.js", "v26.js", "v27.js", "v28.js", "v29.js", "v31.js", "v32.js", "v33.js", "v34.js"):
        p = ROOT / extra
        if p.exists():
            parts_js.append(read(extra))
    return "\n\n".join(parts_js)


def build_pages_html() -> str:
    """GitHub Pages 用: CSS・JS をすべて index.html に内蔵（外部ファイル不要）"""
    css = read("styles.css")
    body = read("body.html").strip()
    qrcode_js = read("lib/qrcode.min.js")
    html5_qrcode_js = read("lib/html5-qrcode.min.js")
    merged_js = get_merged_js()

    parts = [
        PAGES_HEAD,
        css,
        "\n  </style>\n</head>\n<body>\n",
        body,
        "\n\n  <script>\n",
        qrcode_js,
        "\n  </script>\n  <script>\n",
        html5_qrcode_js,
        "\n  </script>\n  <script>\n",
        merged_js,
        "\n  </script>\n</body>\n</html>\n",
    ]
    return "".join(parts)


def build_bundle_html() -> str:
    """1ファイル版: CSS・JS・ライブラリをすべて内蔵"""
    return build_pages_html()


def export_dist_folder(pages_html: str) -> None:
    """Cloudflare Workers デプロイ用: 公開ファイルだけ dist/ に出力"""
    out_dir = ROOT / "dist"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "index.html").write_text(pages_html, encoding="utf-8")
    (out_dir / "BlueChat.html").write_text(pages_html, encoding="utf-8")

    for name in ("icon.png", "favicon.svg", "sw.js", "_headers", ".nojekyll"):
        src = ROOT / name
        if src.exists():
            shutil.copy2(src, out_dir / name)

    print(f"Wrote {out_dir}/ — Cloudflare deploy 用")


def export_version_folder(pages_html: str, version: str) -> None:
    """Desktop/BlueChatvN に配布用フォルダを出力"""
    out_dir = ROOT.parent / f"BlueChat{version}"
    if out_dir.resolve() == ROOT.resolve():
        return
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "index.html").write_text(pages_html, encoding="utf-8")
    (out_dir / "BlueChat.html").write_text(pages_html, encoding="utf-8")

    for name in ("icon.png", "favicon.svg", "sw.js", "sync-config.json", ".nojekyll", "_headers", "wrangler.toml", "package.json"):
        src = ROOT / name
        if src.exists():
            shutil.copy2(src, out_dir / name)

    lib_src = ROOT / "lib"
    if lib_src.is_dir():
        dest_lib = out_dir / "lib"
        if dest_lib.exists():
            shutil.rmtree(dest_lib)
        shutil.copytree(lib_src, dest_lib)

    server_src = ROOT / "server"
    if server_src.is_dir():
        dest_server = out_dir / "server"
        if dest_server.exists():
            shutil.rmtree(dest_server)
        shutil.copytree(server_src, dest_server)

    for name in ("app.js", "features.js", "v4.js", "v6.js", "v7.js", "v8.js", "v9.js", "v10.js", "v11.js", "body.html", "styles.css", "build.py"):
        src = ROOT / name
        if src.exists():
            shutil.copy2(src, out_dir / name)

    print(f"Wrote {out_dir}/ — BlueChat {version} 配布フォルダ")


def main() -> None:
    pages = build_pages_html()
    bundle = build_pages_html()

    (ROOT / "index.html").write_text(pages, encoding="utf-8")
    (ROOT / "BlueChat.html").write_text(bundle, encoding="utf-8")
    (ROOT / "styles.css").write_text(read("styles.css"), encoding="utf-8")
    (ROOT / ".nojekyll").touch()

    export_version_folder(pages, "X")
    export_dist_folder(pages)

    print(f"Wrote index.html ({len(pages)} bytes) — GitHub Pages 用（CSS+JS 内蔵）")
    print(f"Wrote BlueChat.html ({len(bundle)} bytes) — 1ファイル版")
    print("Wrote styles.css — 開発用")
    print("Wrote .nojekyll")


if __name__ == "__main__":
    main()
