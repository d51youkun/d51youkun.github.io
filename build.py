#!/usr/bin/env python3
"""Build BlueChat HTML outputs from source files."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

SPLIT_HEAD = """<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#1a6fd4">
  <title>BlueChat</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
"""

BUNDLE_HEAD = """<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#1a6fd4">
  <title>BlueChat</title>
  <style>
"""


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def get_app_js() -> str:
    app_js = read("app.js")
    sync_url = ""
    try:
        sync_url = json.loads(read("sync-config.json")).get("url", "").strip()
    except (json.JSONDecodeError, OSError):
        pass
    return app_js.replace("__DEFAULT_SYNC_URL__", sync_url, 1)


def build_pages_html() -> str:
    """GitHub Pages 用: index.html + styles.css の2ファイル構成（JSはHTML内蔵）"""
    body = read("body.html").strip()
    qrcode_js = read("lib/qrcode.min.js")
    html5_qrcode_js = read("lib/html5-qrcode.min.js")
    app_js = get_app_js()
    features_js = read("features.js")

    parts = [
        SPLIT_HEAD,
        body,
        "\n\n  <script>\n",
        qrcode_js,
        "\n  </script>\n  <script>\n",
        html5_qrcode_js,
        "\n  </script>\n  <script>\n",
        app_js,
        "\n  </script>\n  <script>\n",
        features_js,
        "\n  </script>\n</body>\n</html>\n",
    ]
    return "".join(parts)


def build_bundle_html() -> str:
    """1ファイル版: CSS・JS・ライブラリをすべて内蔵"""
    css = read("styles.css")
    body = read("body.html").strip()
    qrcode_js = read("lib/qrcode.min.js")
    html5_qrcode_js = read("lib/html5-qrcode.min.js")
    app_js = get_app_js()
    features_js = read("features.js")

    parts = [
        BUNDLE_HEAD,
        css,
        "\n  </style>\n</head>\n<body>\n",
        body,
        "\n\n  <script>\n",
        qrcode_js,
        "\n  </script>\n  <script>\n",
        html5_qrcode_js,
        "\n  </script>\n  <script>\n",
        app_js,
        "\n  </script>\n  <script>\n",
        features_js,
        "\n  </script>\n</body>\n</html>\n",
    ]
    return "".join(parts)


def main() -> None:
    pages = build_pages_html()
    bundle = build_bundle_html()

    (ROOT / "index.html").write_text(pages, encoding="utf-8")
    (ROOT / "BlueChat.html").write_text(bundle, encoding="utf-8")
    (ROOT / ".nojekyll").touch()

    print(f"Wrote index.html ({len(pages)} bytes) — GitHub Pages 用（HTML+内蔵JS）")
    print(f"Wrote styles.css — 外部CSS")
    print(f"Wrote BlueChat.html ({len(bundle)} bytes) — 1ファイル版")
    print("Wrote .nojekyll")


if __name__ == "__main__":
    main()
