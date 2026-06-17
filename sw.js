/* Service worker de LTH IA Web.
   Cachea solo el shell estatico para instalacion/offline. NUNCA toca las
   llamadas a Supabase (auth, edge function, REST): esas van siempre a la red. */
const CACHE = 'lth-ia-web-v7';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './icon.png',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Solo gestionamos recursos del propio origen/scope. Supabase y demas: red directa.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate para el shell.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
