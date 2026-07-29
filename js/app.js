import { initAuth, login, logout } from './core/auth.js';
import {
    flushVentasDraftForReload,
    hasPendingSaleLocalPersistence,
    initVentas,
    isSaleOperationInProgress,
    resetVentasSession,
    restoreVentasDraft
} from './components/ui-ventas.js';
import { initInventario, destroyInventario } from './components/ui-inventario.js';
import { auth, onAuthStateChanged, db, doc, getDoc } from './core/firebase-setup.js';
import { state, clearCart } from './core/store.js';
import {
    populateLocationFilters,
    resetDataSubscriptions,
    subscribeLocations
} from './core/data-service.js';
import { hydrateSessionCache } from './core/local-cache.js';
import {
    pauseSyncQueue,
    resumeSyncQueue
} from './core/sync-queue.js';
import { syncTrustedClock } from './utils/helpers.js';
import './core/dialogs.js';

// Se inicia en paralelo y no bloquea el arranque offline. En Vercel/Vite usa
// la hora del mismo sitio para corregir dispositivos con el reloj desfasado.
void syncTrustedClock();

// ---- ALTURA REAL DEL VIEWPORT (iPhone / iPad / PWA) ----
// 100vh puede conservar una altura obsoleta después de recargar la app en iOS.
// Esta variable sigue el área realmente visible y evita que el panel de cobro
// termine debajo de la barra del navegador o del menú inferior.
let viewportFrameId = null;
let lastViewportHeight = 0;

function actualizarAlturaViewportApp() {
    const alturaVisible = window.visualViewport?.height || window.innerHeight;
    if (!Number.isFinite(alturaVisible) || alturaVisible <= 0) return;
    const roundedHeight = Math.round(alturaVisible);
    if (roundedHeight === lastViewportHeight) return;
    lastViewportHeight = roundedHeight;

    document.documentElement.style.setProperty(
        '--app-viewport-height',
        `${roundedHeight}px`
    );
}

function programarAjusteViewport() {
    if (viewportFrameId !== null) cancelAnimationFrame(viewportFrameId);
    viewportFrameId = requestAnimationFrame(() => {
        viewportFrameId = null;
        actualizarAlturaViewportApp();
    });
}

actualizarAlturaViewportApp();
window.addEventListener('resize', programarAjusteViewport, { passive: true });
window.addEventListener('pageshow', programarAjusteViewport, { passive: true });
window.addEventListener('orientationchange', () => {
    programarAjusteViewport();
    setTimeout(programarAjusteViewport, 250);
}, { passive: true });

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', programarAjusteViewport, { passive: true });
    window.visualViewport.addEventListener('scroll', programarAjusteViewport, { passive: true });
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        programarAjusteViewport();
        void syncTrustedClock({ force: true });
        setTimeout(programarAjusteViewport, 100);
    }
});

document.addEventListener('focusout', () => {
    // iOS tarda unos milisegundos en devolver la altura tras cerrar el teclado.
    setTimeout(programarAjusteViewport, 100);
    setTimeout(programarAjusteViewport, 350);
});
// -----------------------------------------------------------------

// ---- ESTADO DE CONECTIVIDAD: RED REAL + EVIDENCIA DE FIREBASE ----
const CONNECTIVITY_PROBE_INTERVAL_MS = 30_000;
const CONNECTIVITY_PROBE_TIMEOUT_MS = 6_000;
const CONNECTIVITY_SLOW_THRESHOLD_MS = 2_000;
const FIREBASE_FAILURE_HOLD_MS = 15_000;
const CONNECTIVITY_STATES = new Set([
    'online',
    'unstable',
    'offline'
]);
const SYNC_NETWORK_ERROR_CODES = new Set([
    'network-request-failed',
    'unavailable',
    'deadline-exceeded'
]);

let connectivityState = 'unknown';
let connectivityVisualState = (
    navigator.onLine === false ? 'offline' : 'unstable'
);
let connectivityFailures = 0;
let connectivityProbePromise = null;
let connectivityProbeController = null;
let connectivityProbeSequence = 0;
let connectivityRecoveredTimer = null;
let lastFirebaseConnectivityFailureAt = 0;

document.documentElement.dataset.connectivityState = connectivityVisualState;

function setConnectivityVisualState(nextState) {
    if (connectivityVisualState === nextState) return;
    connectivityVisualState = nextState;
    document.documentElement.dataset.connectivityState = nextState;
}

function showConnectivityToast(nextState) {
    if (nextState === 'offline') {
        window.mostrarToast?.(
            'Sin conexión',
            'La aplicación seguirá trabajando en modo local.',
            'red'
        );
        return;
    }
    if (nextState === 'unstable') {
        window.mostrarToast?.(
            'Conexión inestable',
            'La sincronización puede tardar un poco más.',
            'amber'
        );
        return;
    }
    if (nextState === 'recovered') {
        window.mostrarToast?.(
            'Conexión recuperada',
            'Los cambios pendientes volverán a sincronizarse.',
            'emerald'
        );
    }
}

function setConnectivityState(nextState, { silent = false } = {}) {
    if (!CONNECTIVITY_STATES.has(nextState)) return;
    const previousState = connectivityState;
    if (previousState === nextState) {
        if (
            connectivityVisualState === 'recovered'
            && nextState !== 'online'
        ) {
            clearTimeout(connectivityRecoveredTimer);
            connectivityRecoveredTimer = null;
            setConnectivityVisualState(nextState);
        }
        return;
    }

    clearTimeout(connectivityRecoveredTimer);
    connectivityRecoveredTimer = null;
    connectivityState = nextState;

    const recovered = (
        nextState === 'online'
        && ['offline', 'unstable'].includes(previousState)
    );
    if (recovered) {
        setConnectivityVisualState('recovered');
        if (!silent) showConnectivityToast('recovered');
        connectivityRecoveredTimer = setTimeout(() => {
            connectivityRecoveredTimer = null;
            if (connectivityState === 'online') {
                setConnectivityVisualState('online');
            }
        }, 2_500);
        return;
    }

    setConnectivityVisualState(nextState);
    if (
        !silent
        && nextState !== 'online'
    ) {
        showConnectivityToast(nextState);
    }
}

function hasSlowNetworkInformation() {
    const connection = (
        navigator.connection
        || navigator.mozConnection
        || navigator.webkitConnection
    );
    if (!connection) return false;

    const effectiveType = String(connection.effectiveType || '').toLowerCase();
    const rtt = Number(connection.rtt);
    const downlink = Number(connection.downlink);
    return (
        effectiveType === 'slow-2g'
        || effectiveType === '2g'
        || (Number.isFinite(rtt) && rtt > 1_200)
        || (Number.isFinite(downlink) && downlink > 0 && downlink < 0.8)
    );
}

function recordConnectivityFailure() {
    connectivityFailures += 1;
    if (navigator.onLine === false || connectivityFailures >= 2) {
        setConnectivityState('offline');
        return 'offline';
    }
    setConnectivityState('unstable');
    return 'unstable';
}

function recordConnectivitySuccess({ elapsedMs = 0 } = {}) {
    if (navigator.onLine === false) {
        connectivityFailures = Math.max(connectivityFailures, 2);
        setConnectivityState('offline');
        return 'offline';
    }
    const firebaseFailureIsRecent = (
        lastFirebaseConnectivityFailureAt > 0
        && Date.now() - lastFirebaseConnectivityFailureAt
            < FIREBASE_FAILURE_HOLD_MS
    );
    if (
        firebaseFailureIsRecent
        || elapsedMs >= CONNECTIVITY_SLOW_THRESHOLD_MS
        || hasSlowNetworkInformation()
    ) {
        connectivityFailures = 0;
        setConnectivityState('unstable');
        return 'unstable';
    }

    connectivityFailures = 0;
    setConnectivityState('online');
    return 'online';
}

async function probeConnectivity({ force = false } = {}) {
    if (navigator.onLine === false) {
        connectivityProbeController?.abort();
        connectivityFailures = Math.max(connectivityFailures, 2);
        setConnectivityState('offline');
        return 'offline';
    }
    if (connectivityProbePromise && !force) return connectivityProbePromise;

    if (force) connectivityProbeController?.abort();
    const sequence = ++connectivityProbeSequence;
    const controller = new AbortController();
    connectivityProbeController = controller;

    const probe = (async () => {
        const startedAt = performance.now();
        const timeout = setTimeout(
            () => controller.abort(),
            CONNECTIVITY_PROBE_TIMEOUT_MS
        );
        try {
            const response = await fetch(
                `/manifest.json?connectivity_probe=${Date.now()}`,
                {
                    method: 'HEAD',
                    cache: 'no-store',
                    credentials: 'same-origin',
                    signal: controller.signal
                }
            );
            if (!response.ok) {
                throw new Error(`connectivity-probe-${response.status}`);
            }
            if (sequence !== connectivityProbeSequence) {
                return connectivityState;
            }
            return recordConnectivitySuccess({
                elapsedMs: performance.now() - startedAt
            });
        } catch (_) {
            if (sequence !== connectivityProbeSequence) {
                return connectivityState;
            }
            return recordConnectivityFailure();
        } finally {
            clearTimeout(timeout);
            if (connectivityProbeController === controller) {
                connectivityProbeController = null;
            }
        }
    })();

    const trackedProbe = probe.finally(() => {
        if (connectivityProbePromise === trackedProbe) {
            connectivityProbePromise = null;
        }
    });
    connectivityProbePromise = trackedProbe;
    return connectivityProbePromise;
}

function handleSyncConnectivityEvidence(event) {
    const detail = event.detail || {};
    if (detail.ok === true) {
        lastFirebaseConnectivityFailureAt = 0;
        connectivityFailures = 0;
        recordConnectivitySuccess();
        return;
    }

    const code = String(detail.code || '')
        .replace(/^firestore\//, '');
    if (!SYNC_NETWORK_ERROR_CODES.has(code)) return;
    lastFirebaseConnectivityFailureAt = Date.now();
    recordConnectivityFailure();
}

function installConnectivityMonitoring() {
    if (window.__raffaelitoConnectivityInstalled) return;
    window.__raffaelitoConnectivityInstalled = true;

    window.addEventListener('icepos:connectivity-evidence', handleSyncConnectivityEvidence);
    window.addEventListener('offline', () => {
        connectivityProbeController?.abort();
        connectivityFailures = Math.max(connectivityFailures, 2);
        setConnectivityState('offline');
    });
    window.addEventListener('online', () => {
        setConnectivityState('unstable', { silent: true });
        void probeConnectivity({ force: true });
    });
    window.addEventListener('pageshow', () => {
        if (document.visibilityState === 'visible') {
            void probeConnectivity({ force: true });
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void probeConnectivity({ force: true });
        }
    });

    const connection = (
        navigator.connection
        || navigator.mozConnection
        || navigator.webkitConnection
    );
    connection?.addEventListener?.('change', () => {
        void probeConnectivity({ force: true });
    });

    setInterval(() => {
        if (document.visibilityState === 'visible') {
            void probeConnectivity();
        }
    }, CONNECTIVITY_PROBE_INTERVAL_MS);

    if (navigator.onLine === false) {
        connectivityFailures = 2;
        setConnectivityState('offline');
    } else {
        void probeConnectivity({ force: true });
    }
}
// -----------------------------------------------------------------

// ---- SERVICE WORKER: ACTUALIZACIÓN VOLUNTARIA Y SEGURA ----
const WORKER_UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1_000;
const APP_SYNC_RELOAD_KEY = 'raffaelito:app-sync-complete';
const LEGACY_APP_CACHE_PATTERN = /^raffaelito-v\d+$/;

let serviceWorkerRegistration = null;
let pendingServiceWorker = null;
let reloadWhenSafeAfterControllerChange = false;
let safeWorkerReloadInProgress = false;
let lastWorkerCheck = 0;
let workerUpdateCheckPromise = null;
let appSyncPromise = null;
let clearSafeCachesBeforeReload = false;
let manualWorkerActivationWaiter = null;
let pageHadServiceWorkerController = Boolean(
    navigator.serviceWorker?.controller
);
const updateSafetyChannel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('raffaelito:update-safety:v1')
    : null;
const updateSafetyChecks = new Map();

function isCurrentTabBusy() {
    return (
        state.carrito.length > 0
        || isSaleOperationInProgress()
        || hasPendingSaleLocalPersistence()
        || Boolean(window.ticketEditadoContext?.saleId)
    );
}

function setAppSyncControlsBusy(isBusy) {
    document
        .querySelectorAll('[data-app-sync-trigger]')
        .forEach(button => {
            button.disabled = isBusy;
            button.toggleAttribute('aria-busy', isBusy);
            button.classList.toggle('opacity-60', isBusy);
            button.classList.toggle('cursor-wait', isBusy);
        });
}

async function clearSafeApplicationCaches() {
    if (!('caches' in globalThis)) return;
    const cacheNames = await caches.keys();
    const safeNames = cacheNames.filter(cacheName => (
        cacheName === 'raffaelito-runtime-assets'
        || LEGACY_APP_CACHE_PATTERN.test(cacheName)
    ));
    await Promise.allSettled(
        safeNames.map(cacheName => caches.delete(cacheName))
    );
}

function markAppSyncReload() {
    try {
        sessionStorage.setItem(APP_SYNC_RELOAD_KEY, '1');
    } catch (_) {}
}

function showCompletedAppSyncAfterReload() {
    let shouldNotify = false;
    try {
        shouldNotify = sessionStorage.getItem(APP_SYNC_RELOAD_KEY) === '1';
        if (shouldNotify) sessionStorage.removeItem(APP_SYNC_RELOAD_KEY);
    } catch (_) {}
    if (!shouldNotify) return;

    setTimeout(() => {
        window.mostrarToast?.(
            'Aplicación sincronizada',
            'La versión y los datos se están actualizando.',
            'emerald'
        );
    }, 250);
}

async function reloadAfterControllerChangeWhenSafe() {
    if (
        !reloadWhenSafeAfterControllerChange
        || isCurrentTabBusy()
        || safeWorkerReloadInProgress
    ) return false;

    safeWorkerReloadInProgress = true;
    try {
        const draftFlushed = await flushVentasDraftForReload();
        if (!draftFlushed) return false;
        if (
            !reloadWhenSafeAfterControllerChange
            || isCurrentTabBusy()
        ) return false;

        const shouldClearSafeCaches = clearSafeCachesBeforeReload;
        if (shouldClearSafeCaches) {
            await clearSafeApplicationCaches();
            markAppSyncReload();
        }
        clearSafeCachesBeforeReload = false;
        reloadWhenSafeAfterControllerChange = false;
        window.location.reload();
        return true;
    } finally {
        safeWorkerReloadInProgress = false;
    }
}

window.addEventListener(
    'icepos:update-safety-changed',
    reloadAfterControllerChangeWhenSafe
);

updateSafetyChannel?.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'CHECK_UPDATE_SAFETY' && message.requestId) {
        updateSafetyChannel.postMessage({
            type: 'UPDATE_SAFETY_STATUS',
            requestId: message.requestId,
            busy: isCurrentTabBusy()
        });
        return;
    }
    if (
        message.type === 'UPDATE_SAFETY_STATUS'
        && message.requestId
        && message.busy === true
    ) {
        const check = updateSafetyChecks.get(message.requestId);
        if (check) check.busy = true;
    }
});

async function isAnotherTabBusy() {
    if (!updateSafetyChannel) return false;
    const requestId = (
        globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const check = { busy: false };
    updateSafetyChecks.set(requestId, check);
    updateSafetyChannel.postMessage({
        type: 'CHECK_UPDATE_SAFETY',
        requestId
    });
    await new Promise(resolve => setTimeout(resolve, 350));
    updateSafetyChecks.delete(requestId);
    return check.busy;
}

async function canApplyPendingUpdate() {
    if (isCurrentTabBusy()) {
        window.mostrarToast?.(
            'Actualización pendiente',
            'Termina la operación o vacía el carrito antes de actualizar.',
            'amber'
        );
        return false;
    }
    if (await isAnotherTabBusy()) {
        window.mostrarToast?.(
            'Otra pestaña está ocupada',
            'Termina la venta abierta en la otra pestaña antes de actualizar.',
            'amber'
        );
        return false;
    }
    return true;
}

function settleManualWorkerActivation(error = null) {
    if (!manualWorkerActivationWaiter) return;
    const waiter = manualWorkerActivationWaiter;
    manualWorkerActivationWaiter = null;
    clearTimeout(waiter.timeout);
    if (error) waiter.reject(error);
    else waiter.resolve();
}

function activatePendingWorkerForManualSync(worker) {
    if (!worker) return Promise.resolve(false);
    if (manualWorkerActivationWaiter) {
        return manualWorkerActivationWaiter.promise;
    }

    const previousController = navigator.serviceWorker.controller;
    let resolveActivation;
    let rejectActivation;
    const activationPromise = new Promise((resolve, reject) => {
        resolveActivation = resolve;
        rejectActivation = reject;
    });
    const timeout = setTimeout(() => {
        if (
            navigator.serviceWorker.controller
            && navigator.serviceWorker.controller !== previousController
        ) {
            settleManualWorkerActivation();
            return;
        }
        clearSafeCachesBeforeReload = false;
        settleManualWorkerActivation(
            new Error('La nueva versión no pudo activarse a tiempo.')
        );
    }, 20_000);
    manualWorkerActivationWaiter = {
        promise: activationPromise,
        resolve: resolveActivation,
        reject: rejectActivation,
        timeout
    };
    clearSafeCachesBeforeReload = true;

    try {
        worker.postMessage({ type: 'SKIP_WAITING' });
    } catch (error) {
        clearSafeCachesBeforeReload = false;
        settleManualWorkerActivation(error);
    }
    return activationPromise;
}

function registerPendingWorker(worker) {
    if (!worker || worker.state === 'redundant') return false;
    if (pendingServiceWorker === worker) return false;
    pendingServiceWorker = worker;

    window.mostrarToast?.(
        'Actualización disponible',
        isCurrentTabBusy()
            ? 'Podrás aplicarla cuando termines la operación abierta.'
            : 'Pulsa “Sincronizar App” para aplicarla.',
        'amber'
    );
    return true;
}

async function waitForInstalledWorker(registration) {
    if (registration.waiting) return registration.waiting;
    const worker = registration.installing;
    if (!worker) return null;
    if (worker.state === 'installed') {
        return registration.waiting || worker;
    }

    await new Promise(resolve => {
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            worker.removeEventListener('statechange', handleState);
            resolve();
        };
        const handleState = () => {
            if (['installed', 'activated', 'redundant'].includes(worker.state)) {
                finish();
            }
        };
        const timeout = setTimeout(finish, 15000);
        worker.addEventListener('statechange', handleState);
    });
    return registration.waiting
        || (worker.state === 'installed' ? worker : null);
}

const monitoredWorkerRegistrations = new WeakSet();

function monitorWorkerRegistration(registration) {
    if (!registration || monitoredWorkerRegistrations.has(registration)) return;
    monitoredWorkerRegistrations.add(registration);
    registration.addEventListener('updatefound', () => {
        const installingWorker = registration.installing;
        installingWorker?.addEventListener('statechange', () => {
            if (
                installingWorker.state === 'installed'
                && navigator.serviceWorker.controller
            ) {
                registerPendingWorker(registration.waiting || installingWorker);
            }
        });
    });
}

async function ensureServiceWorkerRegistration() {
    serviceWorkerRegistration ||= await navigator.serviceWorker.getRegistration();
    if (!serviceWorkerRegistration) {
        serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js');
    }
    if (!serviceWorkerRegistration) {
        throw new Error('El navegador no devolvió un registro de actualización.');
    }
    monitorWorkerRegistration(serviceWorkerRegistration);
    return serviceWorkerRegistration;
}

async function checkForWorkerUpdate({ force = false } = {}) {
    if (
        !('serviceWorker' in navigator)
        || navigator.onLine === false
        || document.visibilityState !== 'visible'
    ) return null;
    if (workerUpdateCheckPromise) return workerUpdateCheckPromise;

    const now = Date.now();
    if (
        !force
        && now - lastWorkerCheck < WORKER_UPDATE_CHECK_INTERVAL_MS
    ) {
        return serviceWorkerRegistration?.waiting || null;
    }
    lastWorkerCheck = now;

    const check = (async () => {
        const registration = await ensureServiceWorkerRegistration();
        registerPendingWorker(registration.waiting);
        await registration.update();
        const installedWorker = await waitForInstalledWorker(registration);
        if (installedWorker && navigator.serviceWorker.controller) {
            registerPendingWorker(installedWorker);
        }
        return installedWorker;
    })();
    const trackedCheck = check.finally(() => {
        if (workerUpdateCheckPromise === trackedCheck) {
            workerUpdateCheckPromise = null;
        }
    });
    workerUpdateCheckPromise = trackedCheck;
    return workerUpdateCheckPromise;
}

async function reloadCurrentAppSafely() {
    await clearSafeApplicationCaches();
    markAppSyncReload();
    window.location.reload();
}

async function runManualAppSync() {
    if (!await canApplyPendingUpdate()) return false;

    const networkState = await probeConnectivity({ force: true });
    if (networkState === 'offline') return false;

    const draftFlushed = await flushVentasDraftForReload();
    if (!draftFlushed) {
        window.mostrarToast?.(
            'No se pudo sincronizar',
            'No se pudo guardar de forma segura la operación abierta.',
            'red'
        );
        return false;
    }
    if (isCurrentTabBusy()) return false;

    if (!('serviceWorker' in navigator)) {
        await reloadCurrentAppSafely();
        return true;
    }

    const registration = await ensureServiceWorkerRegistration();
    await registration.update();
    const installedWorker = await waitForInstalledWorker(registration);
    if (installedWorker && navigator.serviceWorker.controller) {
        registerPendingWorker(installedWorker);
        if (!await canApplyPendingUpdate()) return false;
        await activatePendingWorkerForManualSync(installedWorker);
        return true;
    }

    if (!await canApplyPendingUpdate()) return false;
    await reloadCurrentAppSafely();
    return true;
}

window.forzarActualizacionApp = () => {
    if (appSyncPromise) return appSyncPromise;
    setAppSyncControlsBusy(true);

    const syncRequest = runManualAppSync()
        .catch(error => {
            console.error('No se pudo sincronizar la aplicación:', error);
            if (
                navigator.onLine === false
                || error?.name === 'TypeError'
                || error?.name === 'AbortError'
            ) {
                recordConnectivityFailure();
            }
            window.mostrarToast?.(
                'No se pudo sincronizar',
                'La actualización se reintentará cuando mejore la conexión.',
                'amber'
            );
            return false;
        });
    const trackedSyncRequest = syncRequest.finally(() => {
        if (appSyncPromise === trackedSyncRequest) {
            appSyncPromise = null;
        }
        setAppSyncControlsBusy(false);
    });
    appSyncPromise = trackedSyncRequest;
    return appSyncPromise;
};

if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            serviceWorkerRegistration = await ensureServiceWorkerRegistration();
            registerPendingWorker(serviceWorkerRegistration.waiting);
            await checkForWorkerUpdate({ force: true });
        } catch (error) {
            console.warn('El modo sin conexión no pudo iniciarse:', error);
        }
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        const replacedExistingController = pageHadServiceWorkerController;
        const wasManualAppSync = clearSafeCachesBeforeReload;
        pageHadServiceWorkerController = true;
        pendingServiceWorker = null;
        settleManualWorkerActivation();
        // En una instalación nueva, clientsClaim entrega por primera vez el
        // control al worker. No es una actualización y no debe cortar Auth ni
        // recargar mientras Firebase está preparando la sesión.
        if (!replacedExistingController && !wasManualAppSync) {
            reloadWhenSafeAfterControllerChange = false;
            return;
        }

        const tabWasBusy = isCurrentTabBusy();
        reloadWhenSafeAfterControllerChange = true;
        if (!tabWasBusy) {
            void reloadAfterControllerChangeWhenSafe();
            return;
        }
        window.mostrarToast?.(
            'Actualización lista',
            'Esta pestaña se actualizará después de terminar la venta o edición abierta.',
            'amber'
        );
    });

    window.addEventListener('online', () => {
        void checkForWorkerUpdate({ force: true }).catch(() => {});
    });
    window.addEventListener('pageshow', () => {
        void checkForWorkerUpdate({ force: true }).catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
        if (
            document.visibilityState === 'visible'
            && reloadWhenSafeAfterControllerChange
        ) {
            void reloadAfterControllerChangeWhenSafe();
            return;
        }
        if (document.visibilityState !== 'visible') return;
        void checkForWorkerUpdate().catch(() => {});
    });
    setInterval(() => {
        if (document.visibilityState === 'visible') {
            void checkForWorkerUpdate().catch(() => {});
        }
    }, WORKER_UPDATE_CHECK_INTERVAL_MS);
}
// -----------------------------------------------------------------

// ---- LÓGICA DE PERFILES LOCALES (INICIO RÁPIDO) ----
function getSavedAccounts() {
    try { return JSON.parse(localStorage.getItem('icepos_accounts')) || []; } catch(e) { return []; }
}

function saveAccount(email, username, pass) {
    let accs = getSavedAccounts();
    const encodedPass = btoa(pass); 
    const existingIdx = accs.findIndex(a => a.email === email);
    
    if (existingIdx >= 0) {
        accs[existingIdx].pass = encodedPass;
        accs[existingIdx].username = username;
    } else {
        accs.push({ email, username, pass: encodedPass });
    }
    localStorage.setItem('icepos_accounts', JSON.stringify(accs));
}

function removeAccount(email) {
    let accs = getSavedAccounts();
    accs = accs.filter(a => a.email !== email);
    localStorage.setItem('icepos_accounts', JSON.stringify(accs));
    renderProfiles();
}

function renderProfiles() {
    const accs = getSavedAccounts();
    const profilesSec = document.getElementById('login-profiles-section');
    const manualSec = document.getElementById('login-manual-section');
    const list = document.getElementById('saved-profiles-list');
    const btnVolver = document.getElementById('btn-show-profiles');
    const subtitle = document.getElementById('login-subtitle');

    if (accs.length > 0) {
        if(subtitle) subtitle.textContent = "Selecciona tu cuenta";
        if(profilesSec) {
            profilesSec.classList.remove('hidden');
            profilesSec.classList.add('flex');
        }
        if(manualSec) manualSec.classList.add('hidden');
        if(btnVolver) btnVolver.classList.remove('hidden');

        if(list) {
            list.innerHTML = accs.map(a => `
                <div class="relative group">
                    <button data-action="quick-login" data-email="${a.email}" data-username="${a.username}" data-pass="${a.pass}" class="flex flex-col items-center gap-2 p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-sky-500 rounded-xl transition-all w-20 sm:w-24 active:scale-95 shadow-sm">
                        <div class="w-10 h-10 bg-sky-500 text-white rounded-full flex items-center justify-center shrink-0 shadow-md shadow-sky-500/30">
                            <i data-lucide="user" class="w-5 h-5"></i>
                        </div>
                        <span class="text-[10px] sm:text-xs font-bold text-slate-800 dark:text-white truncate w-full text-center capitalize">${a.username}</span>
                    </button>
                    <button data-action="remove-profile" data-email="${a.email}" class="absolute -top-1.5 -right-1.5 bg-red-500 hover:bg-red-600 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
                        <i data-lucide="x" class="w-3 h-3"></i>
                    </button>
                </div>
            `).join('');
        }
        if(window.lucide) window.lucide.createIcons({ root: list });
    } else {
        if(subtitle) subtitle.textContent = "Punto de Venta Profesional";
        if(profilesSec) {
            profilesSec.classList.add('hidden');
            profilesSec.classList.remove('flex');
        }
        if(manualSec) manualSec.classList.remove('hidden');
        if(btnVolver) btnVolver.classList.add('hidden');
    }
}
// ---------------------------------------------------

const lazyViews = {
    pedidos: {
        load: () => import('./components/ui-pedidos.js'),
        init: module => module.initPedidos(),
        destroy: module => module.destroyPedidos?.()
    },
    caja: {
        load: () => import('./components/ui-caja.js'),
        init: module => module.initCaja(),
        destroy: module => module.destroyCaja?.()
    },
    analisis: {
        load: () => import('./components/ui-analisis.js'),
        init: module => module.initAnalisis(),
        destroy: module => module.destroyAnalisis?.()
    },
    usuarios: {
        load: () => import('./components/ui-usuarios.js'),
        init: module => module.initUsuarios(),
        destroy: module => module.destroyUsuarios?.()
    },
    respaldo: {
        load: () => import('./components/ui-respaldo.js'),
        init: module => module.initRespaldo(),
        destroy: module => module.destroyRespaldo?.()
    }
};

const loadedViewModules = new Map();
const activeViewModules = new Set();
const viewActivationPromises = new Map();
const viewImportPromises = new Map();
const viewLifecycleGenerations = new Map();
let currentLiveView = 'ventas';
let activeSessionKey = '';
let lastSessionUid = '';
let sessionToken = 0;
let locationsRetryTimer = null;
let unsubscribeLocations = null;
let sessionRetryTimer = null;
let sessionRetryContextKey = '';
let sessionRetryAttempts = 0;
let viewPrefetchIdleHandle = null;
let viewPrefetchTimer = null;
let viewPrefetchGeneration = 0;

function importViewModuleCode(viewName) {
    const config = lazyViews[viewName];
    if (!config) return Promise.resolve(null);
    if (loadedViewModules.has(viewName)) {
        return Promise.resolve(loadedViewModules.get(viewName));
    }
    if (viewImportPromises.has(viewName)) {
        return viewImportPromises.get(viewName);
    }

    const request = config.load()
        .then(module => {
            loadedViewModules.set(viewName, module);
            return module;
        })
        .finally(() => {
            if (viewImportPromises.get(viewName) === request) {
                viewImportPromises.delete(viewName);
            }
        });
    viewImportPromises.set(viewName, request);
    return request;
}

function cancelRoleViewPrefetch() {
    viewPrefetchGeneration++;
    if (
        viewPrefetchIdleHandle !== null
        && typeof globalThis.cancelIdleCallback === 'function'
    ) {
        globalThis.cancelIdleCallback(viewPrefetchIdleHandle);
    }
    if (viewPrefetchTimer !== null) clearTimeout(viewPrefetchTimer);
    viewPrefetchIdleHandle = null;
    viewPrefetchTimer = null;
}

function scheduleRoleViewPrefetch(role) {
    cancelRoleViewPrefetch();
    const generation = viewPrefetchGeneration;

    const normalizedRole = String(role || '').trim().toLowerCase();
    const preferredViews = [
        'pedidos',
        'caja',
        'analisis',
        'usuarios',
        ...(normalizedRole === 'master' ? ['respaldo'] : [])
    ];
    const allowedViews = preferredViews.filter(viewName => {
        const nav = document.getElementById(`nav-${viewName}`);
        return nav && !nav.classList.contains('hidden');
    });
    if (allowedViews.length === 0) return;

    const prefetch = () => {
        if (generation !== viewPrefetchGeneration) return;
        viewPrefetchIdleHandle = null;
        viewPrefetchTimer = null;
        void Promise.allSettled(
            allowedViews.map(async viewName => {
                try {
                    await loadViewModule(viewName);
                    if (
                        generation === viewPrefetchGeneration
                        && !activeViewModules.has(viewName)
                    ) {
                        await loadViewModule(viewName);
                    }
                } catch (error) {
                    console.debug(`No se pudo precargar ${viewName}:`, error);
                }
            })
        );
    };

    if (
        typeof requestAnimationFrame === 'function'
        && document.visibilityState !== 'hidden'
    ) {
        requestAnimationFrame(() => {
            if (generation !== viewPrefetchGeneration) return;
            viewPrefetchTimer = setTimeout(prefetch, 0);
        });
    } else {
        viewPrefetchTimer = setTimeout(prefetch, 0);
    }
}

async function loadViewModule(viewName) {
    const config = lazyViews[viewName];
    if (!config) return null;
    if (activeViewModules.has(viewName)) return loadedViewModules.get(viewName) || null;
    if (viewActivationPromises.has(viewName)) return viewActivationPromises.get(viewName);
    const lifecycleGeneration = viewLifecycleGenerations.get(viewName) || 0;

    const activation = (async () => {
        const module = await importViewModuleCode(viewName);
        if ((viewLifecycleGenerations.get(viewName) || 0) !== lifecycleGeneration) {
            return module;
        }
        await config.init(module);
        if ((viewLifecycleGenerations.get(viewName) || 0) !== lifecycleGeneration) {
            config.destroy(module);
            return module;
        }
        activeViewModules.add(viewName);
        return module;
    })();

    viewActivationPromises.set(viewName, activation);
    try {
        return await activation;
    } finally {
        if (viewActivationPromises.get(viewName) === activation) {
            viewActivationPromises.delete(viewName);
        }
    }
}

function stopViewModule(viewName) {
    viewLifecycleGenerations.set(
        viewName,
        (viewLifecycleGenerations.get(viewName) || 0) + 1
    );
    const config = lazyViews[viewName];
    const module = loadedViewModules.get(viewName);
    if (config && module) config.destroy(module);
    activeViewModules.delete(viewName);
}

function stopAllViewModules() {
    const viewNames = new Set([
        ...loadedViewModules.keys(),
        ...viewActivationPromises.keys()
    ]);
    viewNames.forEach(stopViewModule);
    activeViewModules.clear();
    currentLiveView = 'ventas';
}

function reconcileAllowedViewModules() {
    let activeViewWasRevoked = false;
    Object.keys(lazyViews).forEach(viewName => {
        const nav = document.getElementById(`nav-${viewName}`);
        const isAllowed = Boolean(nav && !nav.classList.contains('hidden'));
        if (isAllowed) return;
        if (
            activeViewModules.has(viewName)
            || viewActivationPromises.has(viewName)
        ) {
            stopViewModule(viewName);
        }
        if (currentLiveView === viewName) activeViewWasRevoked = true;
    });
    if (activeViewWasRevoked) window.switchView?.('ventas');
}

function installLazyNavigation() {
    if (window.__iceposLazyNavigationInstalled || typeof window.switchView !== 'function') return;
    window.__iceposLazyNavigationInstalled = true;
    const switchViewBase = window.switchView;

    window.switchView = async viewName => {
        if (currentLiveView === viewName && activeViewModules.has(viewName)) {
            switchViewBase(viewName);
            return;
        }

        switchViewBase(viewName);
        currentLiveView = viewName;
        const navigationSessionToken = sessionToken;
        const navigationLifecycleGeneration = (
            viewLifecycleGenerations.get(viewName) || 0
        );

        try {
            await loadViewModule(viewName);
            if (lazyViews[viewName] && !activeViewModules.has(viewName)) {
                const nav = document.getElementById(`nav-${viewName}`);
                if (
                    navigationSessionToken !== sessionToken
                    || (
                        viewLifecycleGenerations.get(viewName) || 0
                    ) !== navigationLifecycleGeneration
                    || !nav
                    || nav.classList.contains('hidden')
                ) return;
                await loadViewModule(viewName);
            }
        } catch (error) {
            console.error(`No se pudo abrir la vista ${viewName}:`, error);
            if (
                navigationSessionToken !== sessionToken
                || (
                    viewLifecycleGenerations.get(viewName) || 0
                ) !== navigationLifecycleGeneration
                || currentLiveView !== viewName
            ) return;
            window.mostrarToast?.(
                'No se pudo cargar',
                'Verifica tu conexión e inténtalo nuevamente.',
                'red'
            );
        }
    };
}

async function initializeUserSession(context) {
    const key = `${context.uid}:${context.role}:${context.localId || ''}`;
    if (key === activeSessionKey) {
        reconcileAllowedViewModules();
        scheduleRoleViewPrefetch(context.role);
        return;
    }
    cancelRoleViewPrefetch();
    const token = ++sessionToken;
    const contextChanged = Boolean(activeSessionKey && activeSessionKey !== key);
    if (sessionRetryContextKey !== key) {
        sessionRetryContextKey = key;
        sessionRetryAttempts = 0;
    }
    if (sessionRetryTimer) {
        clearTimeout(sessionRetryTimer);
        sessionRetryTimer = null;
    }
    if (locationsRetryTimer) {
        clearTimeout(locationsRetryTimer);
        locationsRetryTimer = null;
    }
    unsubscribeLocations?.();
    unsubscribeLocations = null;

    const shouldClearMemoryCart = Boolean(
        contextChanged || (lastSessionUid && lastSessionUid !== context.uid)
    );
    lastSessionUid = context.uid;

    stopAllViewModules();
    destroyInventario();
    resetDataSubscriptions();
    resetVentasSession();
    if (shouldClearMemoryCart) clearCart();
    state.productos = [];
    state.locales = [];
    const cachedSession = hydrateSessionCache({
        role: context.role,
        localId: context.localId || ''
    });
    populateLocationFilters();
    window.renderProductosVenta?.();
    window.actualizarCarritoUI?.();
    activeSessionKey = key;
    window.switchView?.('ventas');

    try {
        initVentas();
        // Las secciones permitidas cargan código y datos en segundo plano
        // apenas inicia la sesión. Cambiar de vista nunca espera Firebase.
        scheduleRoleViewPrefetch(context.role);
        void resumeSyncQueue({ ownerId: context.uid })
            .then(syncSummary => {
                if (token !== sessionToken || syncSummary.failed <= 0) return;
                window.mostrarToast?.(
                    'Sincronización pendiente',
                    `${syncSummary.failed} operación${syncSummary.failed === 1 ? '' : 'es'} requiere${syncSummary.failed === 1 ? '' : 'n'} revisión.`,
                    'amber'
                );
            })
            .catch(error => {
                console.warn('La cola local se iniciará cuando el navegador responda:', error);
                if (token !== sessionToken) return;
                window.mostrarToast?.(
                    'Modo local activo',
                    'La sincronización se reintentará sin bloquear la venta.',
                    'amber'
                );
            });
        await restoreVentasDraft(context);
        if (token !== sessionToken) return;
        const startLocationsSync = () => {
            if (token !== sessionToken) return;
            unsubscribeLocations?.();
            unsubscribeLocations = subscribeLocations(() => {}, error => {
                if (token !== sessionToken) return;
                console.warn('No se pudieron actualizar las sedes:', error);
                unsubscribeLocations = null;
                clearTimeout(locationsRetryTimer);
                locationsRetryTimer = setTimeout(startLocationsSync, 5000);
            });
        };
        startLocationsSync();

        try {
            await initInventario();
        } catch (inventoryError) {
            if (!cachedSession.productsLoaded) throw inventoryError;
            console.warn('Se está usando el catálogo local mientras reconecta:', inventoryError);
        }
        if (token !== sessionToken) return;

        if (!unsubscribeLocations && !locationsRetryTimer) {
            locationsRetryTimer = setTimeout(() => {
                startLocationsSync();
            }, 5000);
        }

        window.renderProductosVenta?.();
        window.actualizarCarritoUI?.();
        sessionRetryAttempts = 0;
    } catch (error) {
        console.error('Error inicializando la sesión:', error);
        if (token !== sessionToken) return;
        activeSessionKey = '';
        window.mostrarToast?.(
            'Sincronización incompleta',
            'La sesión inició, pero algunos datos no pudieron cargarse.',
            'amber'
        );
        if (sessionRetryAttempts < 3) {
            sessionRetryAttempts++;
            sessionRetryTimer = setTimeout(() => {
                if (token === sessionToken && auth.currentUser?.uid === context.uid) {
                    initializeUserSession(context);
                }
            }, 3000 * sessionRetryAttempts);
        }
    }
}

function cleanupUserSession() {
    pauseSyncQueue();
    sessionToken++;
    activeSessionKey = '';
    cancelRoleViewPrefetch();
    if (locationsRetryTimer) {
        clearTimeout(locationsRetryTimer);
        locationsRetryTimer = null;
    }
    unsubscribeLocations?.();
    unsubscribeLocations = null;
    if (sessionRetryTimer) {
        clearTimeout(sessionRetryTimer);
        sessionRetryTimer = null;
    }
    sessionRetryContextKey = '';
    sessionRetryAttempts = 0;
    stopAllViewModules();
    destroyInventario();
    resetDataSubscriptions();
    resetVentasSession();
    window.switchView?.('ventas');
    clearCart();
    state.productos = [];
    state.locales = [];
    window.renderProductosVenta?.();
    window.actualizarCarritoUI?.();
}

document.addEventListener("DOMContentLoaded", () => {
    installConnectivityMonitoring();
    showCompletedAppSyncAfterReload();
    window.addEventListener('icepos:sync-operation-complete', event => {
        const operation = event.detail?.operation;
        const currentUid = String(state.currentUser?.uid || '');
        if (!currentUid || String(operation?.ownerId || '') !== currentUid) return;
        const type = operation.type;
        if (type === 'sale.save') {
            window.mostrarToast?.(
                'Venta sincronizada',
                'Firebase confirmó la venta guardada en este dispositivo.',
                'emerald'
            );
        }
    });
    window.addEventListener('icepos:sync-operation-failed', event => {
        const operation = event.detail?.operation;
        const currentUid = String(state.currentUser?.uid || '');
        if (!currentUid || String(operation?.ownerId || '') !== currentUid) return;
        const message = event.detail?.error?.message
            || 'La operación local necesita revisión.';
        const title = operation?.type === 'sale.save'
            ? 'Venta pendiente de revisión'
            : 'Cambio pendiente de revisión';
        window.mostrarAlerta?.(title, message, 'red');
    });
    installLazyNavigation();
    window.addEventListener('icepos:user-context-ready', event => {
        initializeUserSession(event.detail);
    });
    window.addEventListener('icepos:user-signed-out', cleanupUserSession);
    initAuth(); 
    
    renderProfiles();

    document.getElementById('btn-show-manual-login')?.addEventListener('click', () => {
        document.getElementById('login-profiles-section').classList.add('hidden');
        document.getElementById('login-profiles-section').classList.remove('flex');
        document.getElementById('login-manual-section').classList.remove('hidden');
        if(document.getElementById('login-subtitle')) document.getElementById('login-subtitle').textContent = "Ingresa tus credenciales";
    });

    document.getElementById('btn-show-profiles')?.addEventListener('click', () => {
        renderProfiles(); 
    });

    // --- NUEVA LÓGICA: Alternar Visibilidad de Contraseña (Ojito) ---
    document.getElementById('btn-toggle-password')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const passInput = document.getElementById('login-password');
        
        if (passInput) {
            if (passInput.type === 'password') {
                passInput.type = 'text';
                btn.innerHTML = '<i data-lucide="eye-off" class="w-5 h-5 text-sky-400"></i>';
            } else {
                passInput.type = 'password';
                btn.innerHTML = '<i data-lucide="eye" class="w-5 h-5 text-slate-400"></i>';
            }
            if(window.lucide) window.lucide.createIcons({ root: btn });
        }
    });

    document.getElementById('saved-profiles-list')?.addEventListener('click', async (e) => {
        const btnLogin = e.target.closest('button[data-action="quick-login"]');
        const btnRemove = e.target.closest('button[data-action="remove-profile"]');

        if (btnRemove) {
            removeAccount(btnRemove.dataset.email);
            return;
        }

        if (btnLogin) {
            const email = btnLogin.dataset.email;
            const pass = atob(btnLogin.dataset.pass);
            
            const originalHtml = btnLogin.innerHTML;
            btnLogin.innerHTML = '<div class="w-10 h-10 flex items-center justify-center shrink-0"><i data-lucide="loader-2" class="w-6 h-6 animate-spin text-sky-500"></i></div><span class="text-xs font-bold text-sky-500 mt-2">Cargando...</span>';
            if(window.lucide) window.lucide.createIcons({ root: btnLogin });
            
            try {
                await login(email, pass);
            } catch (err) {
                btnLogin.innerHTML = originalHtml;
                if(window.lucide) window.lucide.createIcons({ root: btnLogin });
                
                if (err.message === "CUENTA_ELIMINADA" || err.message === "CUENTA_DESACTIVADA") {
                    removeAccount(email);
                    if(window.mostrarAlerta) window.mostrarAlerta('Acceso Denegado', 'Esta cuenta ha sido deshabilitada o eliminada permanentemente.', 'red');
                    setTimeout(() => location.reload(), 2000);
                } else {
                    if(window.mostrarAlerta) window.mostrarAlerta('Credenciales Caducadas', 'La contraseña fue cambiada. Inicia sesión manualmente.', 'amber');
                    removeAccount(email);
                }
            }
        }
    });

    // Mantiene actualizada únicamente la pantalla de perfiles. La carga de
    // módulos se inicia cuando Auth confirma rol y sede mediante el evento de
    // contexto, evitando consultas con una sede todavía vacía.
    onAuthStateChanged(auth, user => {
        if (!user) renderProfiles();
    });

    const lf = document.getElementById('login-form'); 
    const bs = document.getElementById('btn-submit-login');
    
    if (lf) {
        lf.addEventListener('submit', async (e) => {
            e.preventDefault(); 
            document.getElementById('login-error').classList.add('hidden');
            const ot = bs.innerHTML; 
            bs.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline"></i> Conectando...'; 
            bs.disabled = true;
            if(window.lucide) window.lucide.createIcons({ root: bs }); 
            
            try { 
                const inputUser = document.getElementById('login-username');
                const rawUser = inputUser.value.trim().toLowerCase();
                const pass = document.getElementById('login-password').value;
                
                let finalEmail = '';
                let displayUsername = rawUser;

                if (rawUser.includes('@')) {
                    finalEmail = rawUser;
                    displayUsername = rawUser.split('@')[0];
                } else {
                    const dirRef = doc(db, "directorio_login", rawUser);
                    const dirSnap = await getDoc(dirRef);

                    if (dirSnap.exists()) {
                        finalEmail = dirSnap.data().email;
                        displayUsername = dirSnap.data().username;
                    } else {
                        finalEmail = rawUser + '@raspadillas.com';
                    }
                }
                
                await login(finalEmail, pass); 
                saveAccount(finalEmail, displayUsername, pass);

                setTimeout(() => { bs.innerHTML = ot; bs.disabled = false; }, 1000); 
            } catch (err) { 
                console.error("Error de autenticación:", err);
                
                if (err.message === "CUENTA_ELIMINADA" || err.message === "CUENTA_DESACTIVADA") {
                    document.getElementById('login-error').classList.add('hidden');
                    if(window.mostrarAlerta) window.mostrarAlerta('Acceso Denegado', 'Esta cuenta ha sido deshabilitada o eliminada permanentemente.', 'red');
                } else {
                    document.getElementById('login-error').classList.remove('hidden'); 
                }
                
                bs.innerHTML = ot; 
                bs.disabled = false; 
                if(window.lucide) window.lucide.createIcons({ root: bs }); 
            }
        });
    }
    
    const hL = async () => { 
        if (
            isSaleOperationInProgress()
            || Boolean(window.ticketEditadoContext?.saleId)
        ) {
            window.mostrarToast?.(
                'Operación en curso',
                'Termina o cancela la edición antes de cerrar sesión.',
                'amber'
            );
            window.switchView?.('ventas');
            return;
        }
        if (await isAnotherTabBusy()) {
            window.mostrarToast?.(
                'Otra pestaña está ocupada',
                'Termina la venta o edición abierta en la otra pestaña antes de cerrar sesión.',
                'amber'
            );
            return;
        }
        try { 
            await logout(); 
            if(lf) lf.reset(); 
            if(bs) { bs.innerHTML = 'Ingresar al Sistema'; bs.disabled = false; } 
            if(window.switchView) window.switchView('ventas'); 
        } catch (e) { 
            console.error("Error cerrando sesión:", e); 
        } 
    };
    
    document.getElementById('btn-logout-desktop')?.addEventListener('click', hL); 
    document.getElementById('btn-logout-mobile')?.addEventListener('click', hL);
});
