const CACHE_NAME = 'raffaelito-v7'; // <-- VERSIÓN ACTUALIZADA (v7) para forzar la actualización

// FIX: Rutas RELATIVAS ('./') en lugar de absolutas ('/').
// Con rutas absolutas, si la app se aloja en una subcarpeta (ej. GitHub Pages),
// cache.addAll() fallaba y el Service Worker NUNCA se instalaba,
// dejando la app sin modo offline y con cargas incompletas.
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/styles.css',
  './assets/img/logo.png',
  './js/app.js',
  './js/core/auth.js',
  './js/core/firebase-setup.js',
  './js/core/store.js',
  './js/utils/helpers.js',
  './js/components/ui-ventas.js',
  './js/components/ui-inventario.js',
  './js/components/ui-caja.js',
  './js/components/ui-usuarios.js',
  './js/components/ui-pedidos.js',
  './js/components/ui-analisis.js',
  './js/components/ui-respaldo.js'
];

// CDNs externos: se cachean "con el mejor esfuerzo".
// FIX: Antes estaban dentro del mismo addAll(); si UNO fallaba (red/CORS),
// TODA la instalación se abortaba. Ahora un fallo de CDN no rompe nada.
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest'
];

// Instalar y almacenar en caché
self.addEventListener('install', (event) => {
  // CLAVE MODO FANTASMA: Fuerza al nuevo SW a instalarse inmediatamente sin esperar que cierren la app
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      const cdnPromises = CDN_ASSETS.map((url) =>
        cache.add(url).catch((err) => console.warn('SW: CDN no cacheado (se usará red):', url, err))
      );
      return Promise.all([cache.addAll(ASSETS_TO_CACHE), ...cdnPromises]).then(() => {
        console.log('SW: Archivos almacenados en caché exitosamente.');
      });
    })
  );
});

// Limpiar cachés antiguos si hay una nueva versión
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('SW: Limpiando caché antigua', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // CLAVE MODO FANTASMA: Obliga al nuevo SW a tomar el control de las pestañas abiertas inmediatamente
  self.clients.claim();
});

// Estrategia: Stale-While-Revalidate (Primero caché, luego red)
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // FIX: Solo interceptar peticiones GET http(s).
  // Antes se intentaba cachear POSTs y esquemas raros (chrome-extension, etc.)
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  // Ignorar peticiones a Firebase/Google (Firebase gestiona su propia persistencia)
  if (
    req.url.includes('firestore.googleapis.com') ||
    req.url.includes('identitytoolkit.googleapis.com') ||
    req.url.includes('securetoken.googleapis.com') ||
    req.url.includes('firebaseinstallations.googleapis.com') ||
    req.url.includes('gstatic.com/firebasejs')
  ) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req).then((networkResponse) => {
        // Actualizar la caché silenciosamente (recursos propios y CDNs conocidos)
        const esCDN = CDN_ASSETS.some((u) => req.url.startsWith(u.replace(/\/$/, '')));
        const cacheable =
          networkResponse &&
          (networkResponse.status === 200 || networkResponse.type === 'opaque') &&
          (networkResponse.type === 'basic' || esCDN);

        if (cacheable) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, responseToCache).catch(() => {});
          });
        }
        return networkResponse;
      }).catch(() => {
        // FIX: Sin red y sin caché para una NAVEGACIÓN -> servir el index cacheado
        // (antes quedaba pantalla en blanco al abrir la app offline)
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });

      // Retorna la caché inmediatamente si existe, si no, espera la red
      return cachedResponse || fetchPromise;
    })
  );
});
