import { state } from './store.js';

const CACHE_VERSION = 1;
const CACHE_PREFIX = `raffaelito:local:v${CACHE_VERSION}`;
const LOCATIONS_KEY = `${CACHE_PREFIX}:locations`;
const CATALOG_INDEX_KEY = `${CACHE_PREFIX}:catalog-index`;
const MAX_CATALOG_CACHES = 6;
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const pendingCatalogWrites = new Map();

function normalizeRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    return normalized === 'administrador' ? 'admin' : normalized;
}

function getCatalogScope({ role = state.userRole, localId = state.userLocalId } = {}) {
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === 'admin' || normalizedRole === 'master') return 'all';
    return `local-${String(localId || 'legacy').trim() || 'legacy'}`;
}

function getCatalogKey(context = {}) {
    return `${CACHE_PREFIX}:catalog:${getCatalogScope(context)}`;
}

function readEntry(key) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        if (
            !parsed
            || parsed.version !== CACHE_VERSION
            || !Array.isArray(parsed.rows)
            || !Number.isFinite(Number(parsed.savedAt))
        ) {
            return [];
        }
        if (Date.now() - Number(parsed.savedAt) > MAX_CACHE_AGE_MS) {
            localStorage.removeItem(key);
            return [];
        }
        return parsed.rows;
    } catch (_) {
        return [];
    }
}

function writeEntry(key, rows) {
    if (!Array.isArray(rows)) return;
    try {
        localStorage.setItem(key, JSON.stringify({
            version: CACHE_VERSION,
            savedAt: Date.now(),
            rows
        }));
    } catch (error) {
        // localStorage puede llenarse o estar deshabilitado. Firestore IndexedDB
        // continúa siendo la fuente local principal, por lo que esto no bloquea.
        console.warn('No se pudo actualizar la caché rápida local:', error);
    }
}

function scheduleCatalogWrite(key, rows) {
    pendingCatalogWrites.set(key, rows);
    if (pendingCatalogWrites.get(`${key}:scheduled`)) return;
    pendingCatalogWrites.set(`${key}:scheduled`, true);

    const persist = () => {
        const latestRows = pendingCatalogWrites.get(key);
        pendingCatalogWrites.delete(key);
        pendingCatalogWrites.delete(`${key}:scheduled`);
        writeEntry(key, latestRows);
    };

    if (typeof globalThis.requestIdleCallback === 'function') {
        globalThis.requestIdleCallback(persist, { timeout: 1000 });
    } else {
        setTimeout(persist, 50);
    }
}

function rememberCatalogKey(key) {
    try {
        const previous = JSON.parse(localStorage.getItem(CATALOG_INDEX_KEY) || '[]');
        const keys = [key, ...previous.filter(item => item !== key)]
            .slice(0, MAX_CATALOG_CACHES);

        previous
            .filter(item => !keys.includes(item))
            .forEach(item => localStorage.removeItem(item));

        localStorage.setItem(CATALOG_INDEX_KEY, JSON.stringify(keys));
    } catch (_) {}
}

export function hydrateSessionCache(context = {}) {
    const locations = readEntry(LOCATIONS_KEY);
    const products = readEntry(getCatalogKey(context));

    if (locations.length > 0) state.locales = locations;
    if (products.length > 0) state.productos = products;

    return {
        locationsLoaded: locations.length > 0,
        productsLoaded: products.length > 0
    };
}

export function persistLocationsCache(locations) {
    writeEntry(LOCATIONS_KEY, locations);
}

export function persistProductsCache(products, context = {}) {
    const key = getCatalogKey(context);
    scheduleCatalogWrite(key, products);
    rememberCatalogKey(key);
}
