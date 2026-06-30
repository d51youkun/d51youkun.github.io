#!/usr/bin/env python3
"""Build BlueChat HTML outputs from source files."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PAGES_HEAD = """<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#1a6fd4">
  <title>BlueChat</title>
  <style>
"""

BUNDLE_HEAD = PAGES_HEAD


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def get_app_js() -> str:
    app_js = read("app.js")
    sync_url = ""
    try:
        sync_url = json.loads(read("sync-config.json")).get("url", "").strip()
    except (json.JSONDecodeError, OSError):
        pass
    if not sync_url:
        sync_url = "https://bluechat-sync.onrender.com"
    return app_js.replace("__DEFAULT_SYNC_URL__", sync_url, 1)


def get_merged_js() -> str:
    """app.js + features.js + v4.js を1つのスクリプトに結合"""
    return get_app_js() + "\n\n" + read("features.js") + "\n\n" + read("v4.js")


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


def main() -> None:
    pages = build_pages_html()
    bundle = build_pages_html()

    (ROOT / "index.html").write_text(pages, encoding="utf-8")
    (ROOT / "BlueChat.html").write_text(bundle, encoding="utf-8")
    (ROOT / "styles.css").write_text(read("styles.css"), encoding="utf-8")
    (ROOT / ".nojekyll").touch()

    print(f"Wrote index.html ({len(pages)} bytes) — GitHub Pages 用（CSS+JS 内蔵）")
    print(f"Wrote BlueChat.html ({len(bundle)} bytes) — 1ファイル版")
    print("Wrote styles.css — 開発用")
    print("Wrote .nojekyll")


if __name__ == "__main__":
    main()
