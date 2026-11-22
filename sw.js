// Favorites app, v47: stored starts (Ian, Nov 21: 'a via media between permanent storage and asking TikTok for each video
// every time'). iPhone, Nov 21: a video whose first 1 MB is already on the phone shows its first picture in ~83 ms; from
// TikTok it took 0.8-2.6 s. This worker keeps the first 1 MB of the videos the app expects next and answers the player's
// requests for addresses of the form  v?id=<video>&u=<TikTok redirect link>  from it; the rest of the video it fetches
// from TikTok itself. EVERY OTHER REQUEST IS LEFT ALONE (no respondWith): the app, its files, the library, version.json.
// TikTok's video server lets pages read the bytes (Access-Control-Allow-Origin: *) but hides Content-Range, so the total
// size comes from Content-Length of a request without a range, and Content-Range is written here.
// Older releases never ask for v?… addresses, so going back to one is harmless while this worker stays installed.
const VERSION = 'sw-47';
const CACHE = 'starts-v1', HEAD = 1048576, KEEP = 60;          // at most 60 starts (~60 MB), oldest out first
const meta = new Map();                                           // id -> { total, final } (also kept in the cached response's headers)
const mem = new Map();                                            // id -> Uint8Array, the most recent few, for speed
let queue = [], busy = 0;
const LANES = 2;
const keyOf = (id) => new Request(self.registration.scope + '__start/' + encodeURIComponent(id));
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function stored(id) {
  if (mem.has(id) && meta.has(id)) return { buf: mem.get(id), ...meta.get(id) };
  const c = await caches.open(CACHE), r = await c.match(keyOf(id)); if (!r) return null;
  const buf = new Uint8Array(await r.arrayBuffer()), m = { total: +r.headers.get('x-total') || buf.byteLength, final: r.headers.get('x-final') || '' };
  meta.set(id, m); remember(id, buf); return { buf, ...m };
}
function remember(id, buf) { mem.delete(id); mem.set(id, buf); while (mem.size > 8) mem.delete(mem.keys().next().value); }
async function storedIds() { const c = await caches.open(CACHE); return (await c.keys()).map(r => decodeURIComponent(r.url.split('/__start/')[1] || '')).filter(Boolean); }

async function fetchStart(id, u) {
  const t0 = Date.now();
  const r = await fetch(u, { mode: 'cors', credentials: 'omit' });
  if (!r.ok || !r.body) throw new Error('status ' + r.status);
  const total = +(r.headers.get('content-length') || 0), reader = r.body.getReader(), parts = []; let got = 0;
  while (got < HEAD) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.byteLength; }
  try { reader.cancel(); } catch (e) {}
  const buf = new Uint8Array(Math.min(got, HEAD)); let o = 0;
  for (const p of parts) { const take = Math.min(p.byteLength, buf.byteLength - o); if (take <= 0) break; buf.set(p.subarray(0, take), o); o += take; }
  const m = { total: total || buf.byteLength, final: r.url && r.url !== u ? r.url : '' };
  const c = await caches.open(CACHE);
  await c.put(keyOf(id), new Response(buf, { headers: { 'content-type': 'video/mp4', 'x-total': String(m.total), 'x-final': m.final, 'x-at': String(Date.now()) } }));
  meta.set(id, m); remember(id, buf);
  const keys = await c.keys(); for (let i = 0; i < keys.length - KEEP; i++) { await c.delete(keys[i]); const k = decodeURIComponent(keys[i].url.split('/__start/')[1] || ''); meta.delete(k); mem.delete(k); }
  return { ms: Date.now() - t0, bytes: buf.byteLength, total: m.total };
}
async function tell(msg) { for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg); }
function pump() {
  while (busy < LANES && queue.length) {
    const { id, u } = queue.shift(); busy++;
    (async () => {
      try { if (!(await stored(id))) { const x = await fetchStart(id, u); tell({ op: 'stored', id, ms: x.ms, total: x.total }); } else tell({ op: 'stored', id, ms: 0 }); }
      catch (e) { tell({ op: 'failed', id, err: String(e).slice(0, 80) }); }
      finally { busy--; pump(); }
    })();
  }
}
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.op === 'prepare') { queue = (d.items || []).filter(x => x && x.id && x.u); pump(); }       // a new list replaces the old one: videos passed by are dropped
  else if (d.op === 'list') storedIds().then(ids => e.source && e.source.postMessage({ op: 'list', ids, version: VERSION }));
  else if (d.op === 'clear') caches.delete(CACHE).then(() => { mem.clear(); meta.clear(); e.source && e.source.postMessage({ op: 'list', ids: [], version: VERSION }); });
});

const hdr = (a, end, total) => ({ 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${end}/${total}`, 'Content-Length': String(end - a + 1), 'Accept-Ranges': 'bytes' });
async function fromNet(u, final, a, b, total) {
  let r = null;
  if (final) { try { r = await fetch(final, { mode: 'cors', credentials: 'omit', headers: { Range: `bytes=${a}-${b}` } }); if (r.status !== 206) r = null; } catch (e) { r = null; } }
  if (!r) r = await fetch(u, { mode: 'cors', credentials: 'omit', headers: { Range: `bytes=${a}-${b}` } });
  if (r.status !== 206) return Response.error();                   // a whole file from byte 0 cannot stand in for a later range
  const len = +(r.headers.get('content-length') || (b - a + 1));
  return new Response(r.body, { status: 206, headers: hdr(a, a + len - 1, total) });
}
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname !== new URL('v', self.registration.scope).pathname) return;   // not ours: untouched
  const id = url.searchParams.get('id') || '', u = url.searchParams.get('u') || '';
  const m = /bytes=(\d+)-(\d*)/.exec(e.request.headers.get('range') || '');
  e.respondWith((async () => {
    const s = await stored(id);
    if (!s) return Response.redirect(u, 302);                         // nothing stored (should not happen: the app asks only for stored ones)
    const a = m ? +m[1] : 0, b = m && m[2] ? Math.min(+m[2], s.total - 1) : s.total - 1;
    if (a < s.buf.byteLength) { const end = Math.min(b, s.buf.byteLength - 1); return new Response(s.buf.slice(a, end + 1), { status: 206, headers: hdr(a, end, s.total) }); }
    return fromNet(u, s.final, a, b, s.total);
  })());
});
