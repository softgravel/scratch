// Trial (Nov 21): can a service worker feed the iPhone's video player from a stored start, then the network?
// Scope: /scratch/try/ only (it never sees the app). Video URLs: ./v?u=<TikTok address>. Starts kept in memory.
// v2: TikTok's video server lets pages read the bytes but not Content-Range, so the total size comes from a request
// WITHOUT a range (Content-Length is always readable), read only until the stored start is full; the worker writes
// Content-Range itself (from the range asked, the bytes returned and that total).
const heads = new Map();   // address -> { buf: Uint8Array, total }
const sizes = new Map();   // address -> total size
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
async function fetchHead(u, n) {
  const r = await fetch(u, { mode: 'cors', credentials: 'omit' });
  const total = +(r.headers.get('content-length') || 0); if (total) sizes.set(u, total);
  const reader = r.body.getReader(), parts = []; let got = 0;
  while (got < n) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.byteLength; }
  try { reader.cancel(); } catch (e) {}
  const buf = new Uint8Array(Math.min(got, n)); let o = 0; for (const p of parts) { const take = Math.min(p.byteLength, buf.byteLength - o); if (take <= 0) break; buf.set(p.subarray(0, take), o); o += take; }
  heads.set(u, { buf, total: total || buf.byteLength }); return { bytes: buf.byteLength, total };
}
async function sizeOf(u) {
  if (sizes.has(u)) return sizes.get(u);
  const ac = new AbortController(); const r = await fetch(u, { mode: 'cors', credentials: 'omit', signal: ac.signal });
  const total = +(r.headers.get('content-length') || 0); ac.abort(); if (total) sizes.set(u, total); return total;
}
self.addEventListener('message', (e) => {
  const { op, u, n } = e.data || {}; const port = e.ports[0];
  if (op === 'head') { const t0 = Date.now(); fetchHead(u, n).then(x => port.postMessage(Object.assign({ ok: 1, ms: Date.now() - t0 }, x)), err => port.postMessage({ ok: 0, err: String(err) })); }
  if (op === 'log') port.postMessage(log.slice(-60));
});
const log = [];
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (!url.pathname.endsWith('/try/v')) return;
  const u = url.searchParams.get('u'), h = heads.get(u), rg = e.request.headers.get('range') || '';
  const m = /bytes=(\d+)-(\d*)/.exec(rg);
  e.respondWith((async () => {
    const total = h ? h.total : await sizeOf(u);
    const a = m ? +m[1] : 0, b = m && m[2] ? Math.min(+m[2], total - 1) : total - 1;
    if (h && a < h.buf.byteLength) {                                   // from the stored start (at most up to its end)
      const end = Math.min(b, h.buf.byteLength - 1); log.push(['mem', a, end]);
      return new Response(h.buf.slice(a, end + 1), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${end}/${total}`, 'Content-Length': String(end - a + 1), 'Accept-Ranges': 'bytes' } });
    }
    log.push(['net', a, b, total]);                                    // beyond it (or nothing stored): from TikTok
    const r = await fetch(u, { mode: 'cors', credentials: 'omit', headers: { Range: `bytes=${a}-${b}` } });
    const len = +(r.headers.get('content-length') || (b - a + 1));
    return new Response(r.body, { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${a + len - 1}/${total}`, 'Content-Length': String(len), 'Accept-Ranges': 'bytes' } });
  })());
});
