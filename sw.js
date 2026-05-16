const CACHE_NAME = 'raffaelito-v5'; // <-- VERSIÓN ACTUALIZADA (v5)
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/assets/css/styles.css',
  '/assets/img/logo.jpg', // <-- ¡CORREGIDO! Sin el ?v=3 para que coincida exactamente con el manifest
  '/js/app.js',
  '/js/core/auth.js',
  '/js/core/firebase-setup.js',
  '/js/core/store.js',
  '/js/components/ui-ventas.js',
  '/js/components/ui-inventario.js',
  '/js/components/ui-caja.js',
  '/js/components/ui-usuarios.js',
  '/js/components/ui-pedidos.js',
  '/js/components/ui-analisis.js',
  '/js/components/ui-respaldo.js',
  '/js/utils/helpers.js',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest'
];

// Instalar y almacenar en caché
self.addEventListener('install', (event) => {
  // CLAVE MODO FANTASMA: Fuerza al nuevo SW a instalarse inmediatamente sin esperar que cierren la app
  self.skipWaiting(); 
  
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('SW: Archivos almacenados en caché exitosamente.');
      return cache.addAll(ASSETS_TO_CACHE);
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
  // Ignorar peticiones a Firestore (Firebase se encarga de ellas con su propia persistencia)
  if (event.request.url.includes('firestore.googleapis.com')) {
    return; 
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Actualizar la caché silenciosamente
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Si no hay red, no hacer nada especial, solo usar caché
      });

      // Retorna la caché inmediatamente si existe, si no, espera la red
      return cachedResponse || fetchPromise;
    })
  );
});
