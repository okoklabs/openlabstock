const CACHE_PREFIX = 'openlabstock-pwa-assets-';
const CACHE_NAME = `${CACHE_PREFIX}2026.8.11-r16`;
const INSTALL_ASSETS = [
  '/icons/labstock-180-v1.png',
  '/icons/labstock-192-v1.png',
  '/icons/labstock-512-v1.png',
  '/icons/labstock-maskable-512-v1.png',
];
const INSTALL_PATHS = new Set(INSTALL_ASSETS);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(INSTALL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' || url.pathname.startsWith('/api/')) return;
  if (!INSTALL_PATHS.has(url.pathname)) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => cached ?? fetch(request)),
  );
});
