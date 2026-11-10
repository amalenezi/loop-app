// Loop viewer service worker: serves frame files from private Supabase Storage on this origin,
// so frames are same-origin with the canvas (comments can point at exact elements).
const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain' };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  const prefix = new URL('f/', self.registration.scope).pathname;
  if (!u.pathname.startsWith(prefix)) return;
  e.respondWith(serve(decodeURIComponent(u.pathname.slice(prefix.length))));
});

async function serve(key) {
  if (!key || key.endsWith('/')) key += 'index.html';
  const hit = await (await caches.open('loop-auth')).match('auth');
  if (!hit) return new Response('Sign in to view this frame.', { status: 401 });
  const { token, url, apikey } = await hit.json();
  const r = await fetch(`${url}/storage/v1/object/authenticated/frames/${key.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${token}`, apikey }, cache: 'no-store' });
  if (!r.ok) return new Response('Not found', { status: 404 });
  const ext = (key.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  return new Response(r.body, { headers: { 'content-type': MIME[ext] || r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' } });
}
