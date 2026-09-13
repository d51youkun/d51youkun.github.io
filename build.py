#!/usr/bin/env python3
"""BlueChat build script - combines source files into single index.html"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
BUILD_VERSION = '2026-09-13-v2-ipad'

def read(f):
    with open(os.path.join(BASE, f), encoding='utf-8') as fp:
        return fp.read()

def build():
    html = read('src/app.html')
    css  = read('src/styles.css')
    js   = read('src/app.js')

    # Embed lib files
    qrcode_js     = read('lib/qrcode.min.js')
    html5qr_js    = read('lib/html5-qrcode.min.js')
    libs = f'{qrcode_js}\n{html5qr_js}'

    # Inject CSS and JS into HTML
    html = html.replace('/* __CSS__ */', css)
    # Inject libs before app JS
    html = html.replace('/* __JS__ */', libs + '\n' + js)

    out = os.path.join(BASE, 'dist')
    os.makedirs(out, exist_ok=True)

    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)
    with open(os.path.join(BASE, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)

    # The production app is a Worker (not Pages). Keep the Worker entrypoint
    # generated from the same source so direct workers.dev deploys cannot
    # silently serve an older UI bundle.
    worker = '''export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }
    const html = %s;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "X-Version": "%s"
      }
    });
  }
};
''' % (json.dumps(html, ensure_ascii=False), BUILD_VERSION)
    with open(os.path.join(BASE, 'worker.js'), 'w', encoding='utf-8') as f:
        f.write(worker)

    size = len(html.encode())
    print(f'Built index.html ({size:,} bytes)')
    print(f'Output: {out}/index.html and worker.js')

if __name__ == '__main__':
    build()
