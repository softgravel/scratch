// Trial (Nov 21): can a service worker feed the iPhone's video player from a stored start, then the network?
// Scope: /scratch/try/ only (it never sees the app). Video URLs: ./v?u=<TikTok address>. Starts kept in memory.
const heads = new Map();   // address -> { buf: ArrayBuffer, total }
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  const { op, u, n } = e.data || {}; const port = e.ports[0];
  if (op !== 'head') return;
  const t0 = Date.now();
  fetch(u, { mode: 'cors', credentials: 'omit', headers: { Range: 'bytes=0-' + (n - 1) } })
    .then(async (r) => { const cr = r.headers.get('content-range') || ''; const buf = await r.arrayBuffer(); const total = +(cr.split('/')[1] || buf.byteLength);
      heads.set(u, { buf, total }); port.postMessage({ ok: 1, ms: Date.now() - t0, bytes: buf.byteLength, total }); })
    .catch((err) => port.postMessage({ ok: 0, err: String(err) }));
});
const log = [];
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (!url.pathname.endsWith('/try/v')) return;
  const u = url.searchParams.get('u'), h = heads.get(u), rg = e.request.headers.get('range') || '';
  const m = /bytes=(\d+)-(\d*)/.exec(rg);
  e.respondWith((async () => {
    const total = h ? h.total : 0;
    if (h && m) {
      const a = +m[1], b = m[2] ? Math.min(+m[2], total - 1) : total - 1;
      if (a < h.buf.byteLength) {                                    // served from the stored start (at most up to its end)
        const end = Math.min(b, h.buf.byteLength - 1); log.push(['mem', a, end]);
        return new Response(h.buf.slice(a, end + 1), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${end}/${total}`, 'Content-Length': String(end - a + 1), 'Accept-Ranges': 'bytes' } });
      }
    }
    log.push(['net', rg]);                                            // beyond the stored start: from TikTok
    const r = await fetch(u, { mode: 'cors', credentials: 'omit', headers: rg ? { Range: rg } : {} });
    const hd = new Headers({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    ['content-range', 'content-length'].forEach(k => { const v = r.headers.get(k); if (v) hd.set(k, v); });
    return new Response(r.body, { status: r.status, headers: hd });
  })());
});
self.addEventListener('message', (e) => { if ((e.data || {}).op === 'log') e.ports[0].postMessage(log.slice(-60)); });
