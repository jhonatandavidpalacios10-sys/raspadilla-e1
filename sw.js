const CACHE_NAME = 'raffaelito-v13'; // Reparación y publicación completa del catálogo

const LOCAL_ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/assets/css/styles.css',
  '/assets/img/logo.png',
  '/js/app.js',
  '/js/core/auth.js',
  '/js/core/firebase-setup.js',
  '/js/core/store.js',
  '/js/core/data-service.js',
  '/js/core/local-cache.js',
  '/js/core/sale-draft-store.js',
  '/js/core/sales-service.js',
  '/js/core/sync-queue.js',
  '/js/core/inventory-service.js',
  '/js/core/public-catalog-service.js',
  '/js/core/dialogs.js',
  '/js/core/icons.js',
  '/js/components/ui-ventas.js',
  '/js/components/ui-inventario.js',
  '/js/components/ui-caja.js',
  '/js/components/ui-usuarios.js',
  '/js/components/ui-pedidos.js',
  '/js/components/ui-analisis.js',
  '/js/components/ui-respaldo.js',
  '/js/utils/helpers.js'
];

const OPTIONAL_EXTERNAL_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Los recursos propios son obligatorios. Los CDN son opcionales para que
    // una caída externa no impida instalar la versión offline de la app.
    await cache.addAll(LOCAL_ASSETS_TO_CACHE);
    await Promise.allSettled(
      OPTIONAL_EXTERNAL_ASSETS.map(url => cache.add(url))
    );
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter(cacheName => cacheName !== CACHE_NAME)
        .map(cacheName => caches.delete(cacheName))
    );
    await self.clients.claim();
  })());
});

function isFirebaseRequest(url) {
  return url.includes('firestore.googleapis.com')
    || url.includes('identitytoolkit.googleapis.com')
    || url.includes('securetoken.googleapis.com');
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || isFirebaseRequest(request.url)) return;

  event.respondWith((async () => {
    const cachedResponse = await caches.match(request);
    const networkPromise = fetch(request)
      .then(async networkResponse => {
        if (
          networkResponse
          && networkResponse.status === 200
          && ['basic', 'cors', 'opaque'].includes(networkResponse.type)
        ) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      })
      .catch(() => null);

    if (cachedResponse) {
      event.waitUntil(networkPromise);
      return cachedResponse;
    }

    const networkResponse = await networkPromise;
    if (networkResponse) return networkResponse;

    if (request.mode === 'navigate') {
      const appShell = await caches.match('/index.html');
      if (appShell) return appShell;
    }

    return new Response('Sin conexión', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  })());
});
