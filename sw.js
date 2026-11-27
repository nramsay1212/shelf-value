// Shelf Value service worker: lets the app open offline and caches card images.
const VERSION = 'v20';
const SHELL = `shelf-shell-${VERSION}`;
const IMAGES = 'shelf-images';
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'skylanders.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('shelf-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The app itself: network first so updates show up, cached copy when offline.
  if (url.origin === location.origin) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }

  // Card images rarely change: cache first.
  if (url.hostname === 'assets.tcgdex.net' || url.hostname === 'images.pokemontcg.io') {
    e.respondWith(caches.open(IMAGES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
  }
  // Price lookups (TCGdex API, eBay worker) always go to the network.
});

// ---- Wishlist price alerts ----
// The worker sends an empty "ping"; we fetch the details with this phone's sync code
// (saved by the app in the 'shelf-meta' cache) and show them.
const money = n => '$' + Number(n).toFixed(2);

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let title = 'Shelf Value price alert';
    let body = 'A card on your wishlist hit your target price.';
    try {
      const meta = await (await caches.open('shelf-meta')).match('/__sync');
      if (meta) {
        const { code, url } = await meta.json();
        const a = await (await fetch(url + '/sync/alerts', { headers: { 'X-Sync-Code': code } })).json();
        if (a.test) { title = 'Shelf Value test notification'; body = 'Price alerts are working on this device. 🎉'; }
        else if (a.list && a.list.length) {
          title = a.list.length === 1 ? `${a.list[0].name} hit your target price` : `${a.list.length} wishlist cards hit your target price`;
          body = a.list.map(x => `${x.name}${x.set ? ' (' + x.set + ')' : ''}: ${money(x.price)} — target ${money(x.target)}`).join('\n');
        }
      }
    } catch { /* show the general message */ }
    await self.registration.showNotification(title, {
      body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'price-alert', data: { url: './?view=wishlist' },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const target = new URL(e.notification.data?.url || './', self.registration.scope).href;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.registration.scope));
    if (win) { await win.focus(); return win.navigate ? win.navigate(target) : null; }
    return self.clients.openWindow(target);
  })());
});
