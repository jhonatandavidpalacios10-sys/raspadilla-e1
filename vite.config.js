import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  build: {
    target: 'es2020',
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@firebase/') || id.includes('/node_modules/firebase/')) {
            return 'firebase';
          }
          if (id.includes('/node_modules/lucide/')) {
            return 'icons';
          }
        },
      },
    },
  },
  plugins: [
    VitePWA({
      injectRegister: false,
      registerType: 'prompt',
      manifest: false,
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false,
        navigateFallback: '/index.html',
        // Todos los recursos propios quedan disponibles desde el primer
        // service worker instalado. Las revisiones nuevas se descargan en
        // segundo plano, pero esperan la confirmación del usuario para activar.
        globPatterns: ['**/*.{html,js,css,json,png,jpg,jpeg,webp,ico}'],
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => (
              url.origin === self.location.origin
              && ['script', 'style', 'image', 'font'].includes(request.destination)
            ),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'raffaelito-runtime-assets',
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 80,
                maxAgeSeconds: 7 * 24 * 60 * 60,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
