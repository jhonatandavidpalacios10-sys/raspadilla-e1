const CACHE_NAME = 'icepos-v4-pro-final';
const urlsToCache = [
    './', './index.html', './styles.css', './manifest.json', 
    './js/app.js', './js/core/firebase-setup.js', './js/core/store.js', 
    './js/core/auth.js', './js/utils/helpers.js',
    './js/components/ui-ventas.js', './js/components/ui-inventario.js', 
    './js/components/ui-caja.js', './js/components/ui-usuarios.js', 
    './js/components/ui-pedidos.js', './js/components/ui-analisis.js', 
    './js/components/ui-respaldo.js'
];

self.addEventListener('install', e => { 
    self.skipWaiting(); 
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urlsToCache))); 
});

self.addEventListener('activate', e => { 
    e.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(k => { if(k !== CACHE_NAME) return caches.delete(k); })
        ))
    ); 
});

// Estrategia: Stale-While-Revalidate (Rápido y siempre actualizado)
self.addEventListener('fetch', e => {
    // Ignorar Firebase y APIs
    if (e.request.url.includes('firestore') || e.request.url.includes('identitytoolkit') || e.request.url.includes('googleapis')) return;
    
    e.respondWith(
        caches.match(e.request).then(cachedResponse => {
            const fetchPromise = fetch(e.request).then(networkResponse => {
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(e.request, networkResponse.clone());
                });
                return networkResponse;
            }).catch(() => console.warn('Modo Offline: Usando caché estática'));
            
            return cachedResponse || fetchPromise;
        })
    );
});
