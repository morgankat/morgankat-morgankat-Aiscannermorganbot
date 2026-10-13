/* =============================================================================
   TRADE PORT EA — combined Service Worker
   1) Offline caching of the dashboard (from the old sw.js)
   2) Megan push notifications with FIRE / Ignore (from the new sw.js)

   Host at the ROOT of the site, next to index.html. Only ONE sw.js.
   Cloud URL + API key are read from IndexedDB ('cloud-engine' > 'kv'),
   written by index.html.
   ========================================================================= */

const CACHE = 'tpea-v5'; // bumped from v4 so old caches get cleaned up
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

/* ---------- Install / activate (caching + takeover) ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // allSettled: one missing icon won't break the whole install
      Promise.allSettled(ASSETS.map((a) => c.add(a)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- Fetch: network first, cache fallback (same-origin only) ----------
   Cross-origin requests (Railway server and any other outside site) are NOT
   touched, so live data is never served stale from the cache. */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

/* ---------- IndexedDB reader ---------- */
function idbGet(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cloud-engine', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/* ---------- Push: empty push -> ask server what the pending setup is ---------- */
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    try {
      const base = await idbGet('cloud_url');
      const key = await idbGet('cloud_key');
      if (!base || !key) return;
      const res = await fetch(base + '/notification/pending', { headers: { 'X-API-Key': key } });
      const setup = await res.json();
      if (!setup || !setup.side) return;
      await self.registration.showNotification('Megan: ' + setup.side + ' ' + setup.label, {
        body: 'Entry ' + setup.entry + ' · TP ' + setup.tp + ' · SL ' + setup.sl + ' · ' + setup.confidence + '% confidence\n' + (setup.reason || ''),
        tag: 'megan-setup',
        requireInteraction: true,
        actions: [
          { action: 'fire', title: '🔥 FIRE' },
          { action: 'ignore', title: 'Ignore' }
        ]
      });
    } catch (e) {
      // Fail silently; the setup expires server-side on its own.
    }
  })());
});

/* ---------- Notification buttons ---------- */
async function notifyResult(title, body) {
  try {
    await self.registration.showNotification(title, { body, tag: 'megan-result' });
  } catch (e) {}
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action; // 'fire', 'ignore', or '' (tapped body)
  event.waitUntil((async () => {
    if (action !== 'fire' && action !== 'ignore') {
      // Tapped the body: open/focus the app
      const list = await self.clients.matchAll({ type: 'window' });
      if (list.length) return list[0].focus();
      return self.clients.openWindow(self.registration.scope);
    }
    const base = await idbGet('cloud_url');
    const key = await idbGet('cloud_key');
    if (!base || !key) {
      return notifyResult('Megan', 'Cloud URL / API key missing. Open the app and reconnect.');
    }
    try {
      const res = await fetch(base + '/notification/' + action, {
        method: 'POST',
        headers: { 'X-API-Key': key }
      });
      if (action === 'fire') {
        if (res.ok) await notifyResult('Megan: FIRE sent', 'Server accepted the request. Check the dashboard to confirm the trade.');
        else await notifyResult('Megan: FIRE failed', 'Server replied ' + res.status + '. No trade confirmed.');
      }
    } catch (e) {
      if (action === 'fire') await notifyResult('Megan: FIRE failed', 'Could not reach the server. No trade confirmed.');
    }
  })());
});
