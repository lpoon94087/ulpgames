// ULP Games service worker: keeps a copy of the whole site so every game works offline on one device.
// Rooms (viewers, scoreboards) still need internet; shared/rooms.js says so when there is none.
//
// Pages and files are served from the copy at once, then fetched again in the background, so a
// change shows up on the next visit. Requests made with cache 'reload' or 'no-cache' (the start
// page's Reload, the word lists' index) go to the network first and fall back to the copy.
// VERSION and FILES are written by tools/stamp-sw.py (run on every commit by the pre-commit hook);
// a new VERSION makes phones download a fresh copy of every file.
const VERSION = 'e69e328daabd';
const FILES = [
  'codenames/cn.js',
  'codenames/images.json',
  'codenames/',
  'codenames/lists.json',
  'codenames/lists/after-dark.txt',
  'codenames/lists/explicit.txt',
  'codenames/lists/extended.txt',
  'codenames/lists/fun.txt',
  'codenames/lists/original.txt',
  '',
  'madgab/flashcards.txt',
  'madgab/',
  'madgab/madgab.js',
  'password/',
  'password/password.js',
  'password/words.txt',
  'shared/common.js',
  'shared/rooms.js',
  'shared/style.css',
  'watch-ya-mouth/',
  'watch-ya-mouth/phrases.txt',
  'watch-ya-mouth/wym.js',
  'word-generator/',
  'word-generator/lists.json',
  'word-generator/lists/actions.txt',
  'word-generator/lists/animals.txt',
  'word-generator/lists/charades-easy.txt',
  'word-generator/lists/charades-hard.txt',
  'word-generator/lists/charades-medium.txt',
  'word-generator/lists/charades-phrases.txt',
  'word-generator/lists/food.txt',
  'word-generator/lists/holidays.txt',
  'word-generator/lists/home.txt',
  'word-generator/lists/jobs.txt',
  'word-generator/lists/movies.txt',
  'word-generator/lists/pictionary-easy.txt',
  'word-generator/lists/pictionary-hard.txt',
  'word-generator/lists/pictionary-medium.txt',
  'word-generator/lists/pictionary-phrases.txt',
  'word-generator/lists/places.txt',
  'word-generator/lists/sports.txt',
  'word-generator/wg.js'
];
const EXTERNAL = [
  'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
];
const CACHE = 'ulp-' + VERSION;
const BASE = new URL('./', self.location).href;
// One copy per file: the query (?join=ABCD) doesn't change what a page is.
const key = url => { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; };

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled([
      ...FILES.map(async f => { const r = await fetch(BASE + f, { cache: 'reload' }); if (r.ok) await c.put(BASE + f, r); }),
      ...EXTERNAL.map(async u => { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await c.put(u, r); }),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ulp-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // The libraries' URLs carry their version, so the copy never goes stale.
  if (EXTERNAL.includes(req.url)) {
    e.respondWith(caches.match(req.url).then(hit => hit || fetch(req).then(async r => {
      if (r.ok) (await caches.open(CACHE)).put(req.url, r.clone());
      return r;
    })));
    return;
  }
  if (url.origin !== location.origin || !req.url.startsWith(BASE)) return;   // Firebase, etc.
  const k = key(req.url);
  const fresh = async () => {
    const r = await fetch(k, { cache: 'no-cache' });
    if (r.ok) await (await caches.open(CACHE)).put(k, r.clone());
    return r;
  };
  if (['reload', 'no-cache', 'no-store'].includes(req.cache)) {
    e.respondWith(fresh().catch(async () => (await caches.match(k)) || Response.error()));
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(k);
    const update = fresh();
    if (hit) { e.waitUntil(update.catch(() => {})); return hit; }
    return update.catch(() => Response.error());
  })());
});
