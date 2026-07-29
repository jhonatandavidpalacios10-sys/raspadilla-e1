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

// ---- SERVICE WORKER: ACTUALIZACIÓN VOLUNTARIA Y SEGURA ----
let serviceWorkerRegistration = null;
let pendingServiceWorker = null;
let reloadWhenSafeAfterControllerChange = false;
let safeWorkerReloadInProgress = false;
let lastWorkerCheck = 0;
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

async function applyPendingUpdate() {
    if (!await canApplyPendingUpdate()) return;

    if (!pendingServiceWorker) {
        window.location.reload();
        return;
    }

    const activate = async () => {
        if (!await canApplyPendingUpdate()) return;
        pendingServiceWorker?.postMessage({ type: 'SKIP_WAITING' });
    };

    if (window.mostrarConfirmacion) {
        window.mostrarConfirmacion(
            'Hay una versión nueva lista. ¿Actualizar ahora?',
            () => void activate()
        );
    } else {
        void activate();
    }
}

function registerPendingWorker(worker) {
    if (!worker) return;
    pendingServiceWorker = worker;

    if (state.carrito.length === 0) {
        window.mostrarToast?.(
            'Actualización disponible',
            'Pulsa “Reparar / Actualizar App” cuando quieras aplicarla.',
            'emerald'
        );
    }
}

window.forzarActualizacionApp = async () => {
    if (!('serviceWorker' in navigator)) {
        window.location.reload();
        return;
    }

    try {
        serviceWorkerRegistration ||= await navigator.serviceWorker.getRegistration();
        if (!serviceWorkerRegistration) {
            serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js');
        }
        await serviceWorkerRegistration.update();
        registerPendingWorker(serviceWorkerRegistration.waiting);
        void applyPendingUpdate();
    } catch (error) {
        console.error('No se pudo comprobar la actualización:', error);
        window.mostrarToast?.('Sin conexión', 'No se pudo comprobar una versión nueva.', 'red');
    }
};

if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js');
            registerPendingWorker(serviceWorkerRegistration.waiting);

            serviceWorkerRegistration.addEventListener('updatefound', () => {
                const installingWorker = serviceWorkerRegistration.installing;
                installingWorker?.addEventListener('statechange', () => {
                    if (
                        installingWorker.state === 'installed'
                        && navigator.serviceWorker.controller
                    ) {
                        registerPendingWorker(serviceWorkerRegistration.waiting || installingWorker);
                    }
                });
            });
        } catch (error) {
            console.warn('El modo sin conexión no pudo iniciarse:', error);
        }
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
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

    document.addEventListener('visibilitychange', () => {
        if (
            document.visibilityState === 'visible'
            && reloadWhenSafeAfterControllerChange
        ) {
            void reloadAfterControllerChangeWhenSafe();
            return;
        }
        if (document.visibilityState !== 'visible' || !serviceWorkerRegistration) return;
        const now = Date.now();
        if (now - lastWorkerCheck < 60 * 60 * 1000) return;
        lastWorkerCheck = now;
        serviceWorkerRegistration.update().catch(() => {});
    });
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
