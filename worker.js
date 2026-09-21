const UPSTREAM_ORIGIN = 'https://nfieyeke.gensparkspace.com';

function isApiPath(pathname) {
  return pathname.startsWith('/tables/') || pathname === '/tables';
}

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const upstream = new URL(UPSTREAM_ORIGIN);
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;

    // Forward the original method, headers, and request body unchanged.
    // This is important for POST/PATCH/DELETE table writes and audio/call data.
    const forwarded = new Request(upstream.toString(), request);
    const response = await fetch(forwarded, { redirect: 'manual' });
    const headers = new Headers(response.headers);

    // Keep redirects on the BlueChat domain so app.html and assets remain same-origin.
    const location = headers.get('Location');
    if (location) {
      try {
        const redirectUrl = new URL(location, UPSTREAM_ORIGIN);
        if (redirectUrl.hostname === new URL(UPSTREAM_ORIGIN).hostname) {
          redirectUrl.hostname = incoming.hostname;
          redirectUrl.protocol = incoming.protocol;
          headers.set('Location', redirectUrl.toString());
        }
      } catch { /* preserve an invalid/non-URL Location header */ }
    }

    headers.set('X-BlueChat-Source', 'genspark-proxy');
    if (isApiPath(incoming.pathname) || request.method !== 'GET') {
      headers.set('Cache-Control', 'no-store');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
