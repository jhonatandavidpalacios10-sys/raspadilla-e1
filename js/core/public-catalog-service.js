import {
    db,
    Bytes,
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    serverTimestamp,
    setDoc,
    updateDoc,
    writeBatch
} from './firebase-setup.js';
import { state } from './store.js';

export const GENERAL_CATALOG_ID = 'general';

const ACTIVE_SITES_CACHE_KEY = 'raffaelito_catalog_sites_v1';
const AUTO_PUBLISH_CACHE_KEY = 'raffaelito_catalog_auto_publish_v3';
const AUTO_PUBLISH_SCHEMA_VERSION = 3;
const IMAGE_MAX_SIDE = 720;
const IMAGE_TARGET_BYTES = 90 * 1024;
const IMAGE_HARD_LIMIT_BYTES = 128 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp'
]);

let activeCatalogSiteIds = readActiveSitesCache();
const knownCatalogSiteIds = new Set([GENERAL_CATALOG_ID]);
let catalogSiteSettingsLoadPromise = null;
let catalogSiteSettingsLoaded = false;
let automaticPublishPromise = null;
let automaticPublishPromiseFingerprint = '';
let automaticPublishedFingerprint = '';
let hasActiveSitesCache = (() => {
    try {
        return localStorage.getItem(ACTIVE_SITES_CACHE_KEY) !== null;
    } catch (_) {
        return false;
    }
})();

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeName(value) {
    return normalizeText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function normalizeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function hashProjectionPayload(payload) {
    const text = JSON.stringify(payload);
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
        second ^= second >>> 13;
    }
    return [
        `v${AUTO_PUBLISH_SCHEMA_VERSION}`,
        (first >>> 0).toString(16).padStart(8, '0'),
        (second >>> 0).toString(16).padStart(8, '0'),
        text.length.toString(36)
    ].join('-');
}

function createPublicProjectionFingerprint(
    products = [],
    locales = [],
    activeIds = []
) {
    const normalizedActiveIds = Array.from(new Set([
        GENERAL_CATALOG_ID,
        ...Array.from(activeIds || []).map(String).filter(Boolean)
    ])).sort();
    const activeSites = normalizedActiveIds.map(siteId => [
        siteId,
        getCatalogSiteName(siteId, locales)
    ]);
    const normalizedProducts = products
        .filter(product => product?.id)
        .map(product => {
            const settings = getCatalogSettings(product);
            const sizes = sanitizeSizes(product, settings.mostrarPrecio);
            const fallbackPrice = normalizeNumber(
                product.precio ?? sizes[0]?.precio,
                0
            );
            return [
                String(product.id),
                normalizeText(product.localId) || 'global',
                settings.nombrePublico || normalizeText(product.nombre) || 'Producto',
                normalizeName(product.categoria) || 'otro',
                Math.max(0, normalizeNumber(product.limite_sabores, 0)),
                settings.visible,
                resolvePublicAvailability(product),
                settings.mostrarPrecio,
                settings.mostrarPrecio ? Math.max(0, fallbackPrice) : null,
                settings.mostrarPrecio
                    ? sizes.map(size => [size.nombre, size.precio])
                    : [],
                settings.descripcion,
                settings.disponibilidad,
                settings.destacado,
                settings.orden,
                settings.imagenId,
                settings.imagenVersion
            ];
        })
        .sort((left, right) => left[0].localeCompare(right[0]));

    return hashProjectionPayload({
        schema: AUTO_PUBLISH_SCHEMA_VERSION,
        activeSites,
        products: normalizedProducts
    });
}

function readAutomaticPublishCache() {
    try {
        const cached = JSON.parse(
            localStorage.getItem(AUTO_PUBLISH_CACHE_KEY) || 'null'
        );
        if (
            !cached
            || cached.schema !== AUTO_PUBLISH_SCHEMA_VERSION
            || typeof cached.fingerprint !== 'string'
        ) return null;
        return cached;
    } catch (_) {
        return null;
    }
}

function persistAutomaticPublishCache(fingerprint, productCount) {
    automaticPublishedFingerprint = fingerprint;
    try {
        localStorage.setItem(AUTO_PUBLISH_CACHE_KEY, JSON.stringify({
            schema: AUTO_PUBLISH_SCHEMA_VERSION,
            fingerprint,
            productCount,
            updatedAt: Date.now()
        }));
    } catch (_) {}
}

function cloneProductsForPublicSync(products = []) {
    return products
        .filter(product => product?.id)
        .map(product => ({
            ...product,
            tamanos: Array.isArray(product.tamanos)
                ? product.tamanos.map(size => ({ ...size }))
                : [],
            catalogo:
                product.catalogo && typeof product.catalogo === 'object'
                    ? { ...product.catalogo }
                    : product.catalogo
        }));
}

function upsertProductSnapshot(products = [], product = null) {
    const rows = cloneProductsForPublicSync(products);
    if (!product?.id) return rows;
    const id = String(product.id);
    const index = rows.findIndex(row => String(row.id) === id);
    const nextProduct = cloneProductsForPublicSync([product])[0];
    if (!nextProduct) return rows;
    if (index >= 0) rows[index] = nextProduct;
    else rows.push(nextProduct);
    return rows;
}

function withoutProductSnapshot(products = [], productId = '') {
    const id = String(productId || '');
    return cloneProductsForPublicSync(products)
        .filter(product => String(product.id) !== id);
}

function queueAutomaticPublicationMarker(
    batch,
    products,
    locales,
    activeIds
) {
    const fingerprint = createPublicProjectionFingerprint(
        products,
        locales,
        activeIds
    );
    batch.set(doc(db, 'catalogos_publicos', GENERAL_CATALOG_ID), {
        autoPublicacionVersion: AUTO_PUBLISH_SCHEMA_VERSION,
        autoPublicacionFirma: fingerprint,
        autoPublicacionProductos: products.length,
        autoPublicacionEn: serverTimestamp()
    }, { merge: true });
    return fingerprint;
}

async function resolveLocalesForAutomaticPublication(locales = []) {
    let current = Array.isArray(locales)
        ? locales.filter(local => local?.id)
        : [];
    if (current.length > 0) return current.map(local => ({ ...local }));

    // La sesión inicia Inventario y Sedes en paralelo. Esperar brevemente aquí
    // evita publicar nombres genéricos o asumir que solo existe General.
    for (let attempt = 0; attempt < 15; attempt++) {
        const loaded = Array.isArray(state.locales)
            ? state.locales.filter(local => local?.id)
            : [];
        if (loaded.length > 0) {
            return loaded.map(local => ({ ...local }));
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return [];
}

function readActiveSitesCache() {
    try {
        const stored = JSON.parse(localStorage.getItem(ACTIVE_SITES_CACHE_KEY) || '[]');
        if (!Array.isArray(stored)) return new Set([GENERAL_CATALOG_ID]);
        return new Set([GENERAL_CATALOG_ID, ...stored.map(String).filter(Boolean)]);
    } catch (_) {
        return new Set([GENERAL_CATALOG_ID]);
    }
}

function persistActiveSitesCache(ids) {
    activeCatalogSiteIds = new Set([
        GENERAL_CATALOG_ID,
        ...(Array.isArray(ids) ? ids : Array.from(ids || []))
            .map(String)
            .filter(Boolean)
    ]);
    try {
        localStorage.setItem(
            ACTIVE_SITES_CACHE_KEY,
            JSON.stringify(Array.from(activeCatalogSiteIds))
        );
        hasActiveSitesCache = true;
    } catch (_) {}
}

function getDefaultActiveSiteIds(locales = []) {
    const preferred = locales.find(local => normalizeName(local?.nombre) === 'local 1')
        || locales[0];
    return new Set([
        GENERAL_CATALOG_ID,
        ...(preferred?.id ? [String(preferred.id)] : [])
    ]);
}

export function canManagePublicCatalog() {
    const role = normalizeName(state.userRole);
    return ['admin', 'administrador', 'master'].includes(role);
}

export function getCatalogSettings(product = {}) {
    const stored = product.catalogo && typeof product.catalogo === 'object'
        ? product.catalogo
        : {};
    const normalizedCategory = normalizeName(product.categoria);
    const defaultShowsPrice = normalizedCategory !== 'sabor';
    const defaultVisible = normalizedCategory !== 'insumo';
    const availability = ['auto', 'disponible', 'agotado'].includes(stored.disponibilidad)
        ? stored.disponibilidad
        : 'auto';

    return {
        visible: stored.visible === undefined
            ? defaultVisible
            : stored.visible !== false,
        nombrePublico: normalizeText(stored.nombrePublico),
        descripcion: normalizeText(stored.descripcion),
        mostrarPrecio:
            stored.mostrarPrecio === undefined
                ? defaultShowsPrice
                : stored.mostrarPrecio === true,
        disponibilidad: availability,
        destacado: stored.destacado === true,
        orden: Number.isFinite(Number(stored.orden))
            ? Math.max(0, Math.trunc(Number(stored.orden)))
            : 1000,
        imagenId: normalizeText(stored.imagenId),
        imagenVersion: Number(stored.imagenVersion || 0)
    };
}

export function resolvePublicAvailability(product = {}) {
    const settings = getCatalogSettings(product);
    if (settings.disponibilidad === 'disponible') return true;
    if (settings.disponibilidad === 'agotado') return false;
    if (
        product.stock === null
        || product.stock === undefined
        || product.stock === ''
    ) return true;
    const stock = Number(product.stock);
    return Number.isFinite(stock) && stock > 0;
}

function sanitizeSizes(product, showPrice) {
    if (!showPrice) return [];
    const sizes = Array.isArray(product.tamanos) ? product.tamanos : [];
    return sizes
        .map(size => ({
            nombre: normalizeText(size?.nombre) || 'Único',
            precio: Number(size?.precio || 0)
        }))
        .filter(size => Number.isFinite(size.precio) && size.precio >= 0)
        .slice(0, 12);
}

export function buildPublicProduct(product = {}) {
    const settings = getCatalogSettings(product);
    const sizes = sanitizeSizes(product, settings.mostrarPrecio);
    const fallbackPrice = Number(product.precio || sizes[0]?.precio || 0);
    const base = {
        sourceProductId: String(product.id || ''),
        nombre: settings.nombrePublico || normalizeText(product.nombre) || 'Producto',
        descripcion: settings.descripcion,
        categoria: normalizeName(product.categoria) || 'otro',
        limiteSabores: Math.max(0, Number(product.limite_sabores || 0)),
        visible: settings.visible,
        disponible: resolvePublicAvailability(product),
        mostrarPrecio: settings.mostrarPrecio,
        imagenId: settings.imagenId,
        imagenVersion: settings.imagenVersion,
        destacado: settings.destacado,
        orden: settings.orden,
        actualizadoEn: serverTimestamp()
    };

    if (!settings.mostrarPrecio) return base;
    return {
        ...base,
        tamanos: sizes,
        precio: Number.isFinite(fallbackPrice) && fallbackPrice >= 0
            ? fallbackPrice
            : 0
    };
}

function getCatalogSiteName(siteId, locales = []) {
    if (siteId === GENERAL_CATALOG_ID) return 'General';
    return normalizeText(locales.find(local => String(local.id) === siteId)?.nombre)
        || 'Sede';
}

function getActiveIdsForLocales(locales = []) {
    if (hasActiveSitesCache) return new Set(activeCatalogSiteIds);
    const defaults = getDefaultActiveSiteIds(locales);
    if (locales.length > 0) persistActiveSitesCache(defaults);
    return defaults;
}

export function getActiveCatalogSiteIds(locales = state.locales || []) {
    return Array.from(getActiveIdsForLocales(locales));
}

export function loadCatalogSiteSettings(
    locales = state.locales || [],
    { force = false } = {}
) {
    if (!force && catalogSiteSettingsLoaded) {
        return Promise.resolve(Array.from(activeCatalogSiteIds));
    }
    if (catalogSiteSettingsLoadPromise) return catalogSiteSettingsLoadPromise;

    const request = (async () => {
        const defaults = getDefaultActiveSiteIds(locales);
        try {
            const snapshot = await getDocs(collection(db, 'catalogos_publicos'));
            catalogSiteSettingsLoaded = true;
            if (snapshot.empty) {
                if (locales.length > 0) persistActiveSitesCache(defaults);
                return Array.from(defaults);
            }
            const activeIds = new Set([GENERAL_CATALOG_ID]);
            snapshot.forEach(siteDoc => {
                knownCatalogSiteIds.add(siteDoc.id);
                if (
                    siteDoc.id === GENERAL_CATALOG_ID
                    || siteDoc.data()?.activo === true
                ) {
                    activeIds.add(siteDoc.id);
                }
            });
            persistActiveSitesCache(activeIds);
            return Array.from(activeIds);
        } catch (error) {
            console.warn('No se pudo actualizar la lista de sedes públicas:', error);
            const cached = getActiveIdsForLocales(locales);
            return Array.from(cached.size > 1 ? cached : defaults);
        }
    })();

    catalogSiteSettingsLoadPromise = request;
    void request.finally(() => {
        if (catalogSiteSettingsLoadPromise === request) {
            catalogSiteSettingsLoadPromise = null;
        }
    });
    return request;
}

/**
 * Publica por primera vez (o repara) la proyección completa del catálogo.
 *
 * Esta función está pensada para ejecutarse en segundo plano después de que el
 * inventario confirmado por el servidor ya está visible. Antes de escribir,
 * compara una firma de todos los datos públicos con la última publicación
 * completa. Por eso abrir Inventario repetidamente no vuelve a escribir cada
 * producto si nada cambió.
 */
export async function ensurePublicCatalogPublished({
    products = state.productos || [],
    locales = state.locales || []
} = {}) {
    if (!canManagePublicCatalog()) {
        return { published: false, reason: 'not-manager' };
    }

    const productSnapshot = cloneProductsForPublicSync(products);
    const localeSnapshot = await resolveLocalesForAutomaticPublication(locales);
    let activeIds = getActiveIdsForLocales(localeSnapshot);
    let fingerprint = createPublicProjectionFingerprint(
        productSnapshot,
        localeSnapshot,
        activeIds
    );

    if (automaticPublishedFingerprint === fingerprint) {
        return { published: false, reason: 'already-verified', fingerprint };
    }

    // La lista pública de sedes se precarga al iniciar Inventario. Reutilizarla
    // aquí evita leer toda la configuración ante cada snapshot de productos.
    await loadCatalogSiteSettings(localeSnapshot);
    activeIds = getActiveIdsForLocales(localeSnapshot);
    fingerprint = createPublicProjectionFingerprint(
        productSnapshot,
        localeSnapshot,
        activeIds
    );
    if (automaticPublishedFingerprint === fingerprint) {
        return { published: false, reason: 'already-verified', fingerprint };
    }
    if (
        automaticPublishPromise
        && automaticPublishPromiseFingerprint === fingerprint
    ) {
        return automaticPublishPromise;
    }
    if (automaticPublishPromise) {
        const runningRequest = automaticPublishPromise;
        await runningRequest.catch(() => {});
        if (automaticPublishPromise === runningRequest) {
            automaticPublishPromise = null;
            automaticPublishPromiseFingerprint = '';
        }
        return ensurePublicCatalogPublished({
            products: productSnapshot,
            locales: localeSnapshot
        });
    }

    const request = (async () => {
        const cached = readAutomaticPublishCache();
        let generalSnapshot;
        try {
            generalSnapshot = await getDoc(
                doc(db, 'catalogos_publicos', GENERAL_CATALOG_ID)
            );
        } catch (error) {
            if (cached?.fingerprint === fingerprint) {
                return {
                    published: false,
                    reason: 'cached-current',
                    fingerprint
                };
            }
            throw error;
        }
        const generalData = generalSnapshot.exists()
            ? generalSnapshot.data()
            : {};
        if (
            generalData.autoPublicacionVersion === AUTO_PUBLISH_SCHEMA_VERSION
            && generalData.autoPublicacionFirma === fingerprint
        ) {
            persistAutomaticPublishCache(fingerprint, productSnapshot.length);
            return { published: false, reason: 'remote-current', fingerprint };
        }

        // Si Firestore solo puede responder con la caché local, una publicación
        // completa previamente confirmada sigue siendo una base segura para no
        // generar cientos de escrituras repetidas mientras el equipo está sin red.
        if (
            generalSnapshot.metadata.fromCache === true
            && cached?.fingerprint === fingerprint
        ) {
            return { published: false, reason: 'offline-current', fingerprint };
        }

        await saveCatalogSiteSettings({
            locales: localeSnapshot,
            activeIds: Array.from(activeIds),
            products: productSnapshot
        });
        return { published: true, reason: 'reconciled', fingerprint };
    })();

    automaticPublishPromise = request;
    automaticPublishPromiseFingerprint = fingerprint;
    try {
        return await request;
    } finally {
        if (automaticPublishPromise === request) {
            automaticPublishPromise = null;
            automaticPublishPromiseFingerprint = '';
        }
    }
}

function getProductTargetIds(product, activeIds) {
    const productLocalId = normalizeText(product.localId) || 'global';
    const targetIds = new Set([GENERAL_CATALOG_ID]);
    if (!['global', GENERAL_CATALOG_ID].includes(productLocalId)) {
        if (activeIds.has(productLocalId)) targetIds.add(productLocalId);
        return targetIds;
    }
    activeIds.forEach(siteId => targetIds.add(siteId));
    return targetIds;
}

function queueSiteConfig(batch, siteId, locales, active) {
    batch.set(doc(db, 'catalogos_publicos', siteId), {
        nombre: getCatalogSiteName(siteId, locales),
        slug: siteId,
        activo: siteId === GENERAL_CATALOG_ID ? true : active === true,
        orden: siteId === GENERAL_CATALOG_ID ? 0 : 100,
        actualizadoEn: serverTimestamp()
    }, { merge: true });
}

function queuePublicProductProjection(
    batch,
    product,
    locales,
    normalizedActiveIds
) {
    const targetIds = getProductTargetIds(product, normalizedActiveIds);
    const settings = getCatalogSettings(product);
    const publicProduct = buildPublicProduct(product);

    normalizedActiveIds.forEach(siteId => {
        queueSiteConfig(
            batch,
            siteId,
            locales,
            normalizedActiveIds.has(siteId)
        );
        const publicRef = doc(
            db,
            'catalogos_publicos',
            siteId,
            'productos',
            String(product.id)
        );
        if (settings.visible && targetIds.has(siteId)) {
            batch.set(publicRef, publicProduct, { merge: false });
        } else {
            batch.delete(publicRef);
        }
    });
}

function buildCatalogImageDocument(prepared, version) {
    if (!prepared?.bytes) throw new Error('La imagen no está preparada.');
    if (prepared.bytes.byteLength > IMAGE_HARD_LIMIT_BYTES) {
        throw new Error('La imagen supera el tamaño permitido.');
    }
    return {
        bytes: Bytes.fromUint8Array(prepared.bytes),
        contentType: prepared.contentType,
        width: Number(prepared.width || 0),
        height: Number(prepared.height || 0),
        size: Number(prepared.size || prepared.bytes.byteLength),
        version,
        actualizadoEn: serverTimestamp()
    };
}

export async function syncPublicCatalogProduct(
    product,
    {
        locales = state.locales || [],
        activeIds = getActiveIdsForLocales(locales)
    } = {}
) {
    if (!canManagePublicCatalog() || !product?.id) return false;
    const normalizedActiveIds = new Set([
        GENERAL_CATALOG_ID,
        ...Array.from(activeIds || []).map(String)
    ]);
    const batch = writeBatch(db);
    queuePublicProductProjection(
        batch,
        product,
        locales,
        normalizedActiveIds
    );
    await batch.commit();
    return true;
}

export async function saveProductAndPublicCatalog({
    productId,
    privateData,
    optimisticProduct,
    isNew = false,
    image = null,
    removeImage = false,
    relatedPrivateUpdates = [],
    locales = state.locales || []
} = {}) {
    if (!productId || !privateData || !optimisticProduct) {
        throw new Error('Faltan datos para guardar el producto.');
    }
    const manager = canManagePublicCatalog();
    if (manager) await loadCatalogSiteSettings(locales);
    const batch = writeBatch(db);
    let publicationFingerprint = '';
    const productRef = doc(db, 'productos', String(productId));
    if (isNew) batch.set(productRef, privateData);
    else batch.update(productRef, privateData);
    relatedPrivateUpdates.forEach(update => {
        if (
            !update?.productId
            || !update?.privateData
            || String(update.productId) === String(productId)
        ) return;
        batch.update(
            doc(db, 'productos', String(update.productId)),
            update.privateData
        );
    });

    if (manager) {
        const activeIds = getActiveIdsForLocales(locales);
        queuePublicProductProjection(
            batch,
            optimisticProduct,
            locales,
            activeIds
        );
        const imageRef = doc(db, 'catalogo_imagenes', String(productId));
        if (image) {
            batch.set(
                imageRef,
                buildCatalogImageDocument(
                    image,
                    getCatalogSettings(optimisticProduct).imagenVersion || Date.now()
                ),
                { merge: false }
            );
        } else if (removeImage) {
            batch.delete(imageRef);
        }

        // Un guardado incremental solo puede declarar la proyección completa
        // cuando esta sesión ya verificó o publicó el catálogo entero. Si es
        // la primera apertura, el reconciliador de fondo debe crear antes todos
        // los documentos, no solo el producto que acaba de editarse.
        if (automaticPublishedFingerprint) {
            const nextProducts = upsertProductSnapshot(
                state.productos || [],
                optimisticProduct
            );
            publicationFingerprint = queueAutomaticPublicationMarker(
                batch,
                nextProducts,
                locales,
                activeIds
            );
        }
    }

    await batch.commit();
    if (publicationFingerprint) {
        persistAutomaticPublishCache(
            publicationFingerprint,
            state.productos?.length || 0
        );
    }
    return true;
}

export async function deleteProductAndPublicCatalog(
    productId,
    locales = state.locales || []
) {
    if (!productId) return false;
    const manager = canManagePublicCatalog();
    if (manager) await loadCatalogSiteSettings(locales);
    const batch = writeBatch(db);
    let publicationFingerprint = '';
    batch.delete(doc(db, 'productos', String(productId)));
    if (manager) {
        const activeIds = getActiveIdsForLocales(locales);
        activeIds.forEach(siteId => {
            batch.delete(doc(
                db,
                'catalogos_publicos',
                siteId,
                'productos',
                String(productId)
            ));
        });
        batch.delete(doc(db, 'catalogo_imagenes', String(productId)));
        if (automaticPublishedFingerprint) {
            const nextProducts = withoutProductSnapshot(
                state.productos || [],
                productId
            );
            publicationFingerprint = queueAutomaticPublicationMarker(
                batch,
                nextProducts,
                locales,
                activeIds
            );
        }
    }
    await batch.commit();
    if (publicationFingerprint) {
        persistAutomaticPublishCache(
            publicationFingerprint,
            withoutProductSnapshot(state.productos || [], productId).length
        );
    }
    return true;
}

export async function deletePublicCatalogProduct(
    productId,
    locales = state.locales || []
) {
    if (!canManagePublicCatalog() || !productId) return false;
    const activeIds = getActiveIdsForLocales(locales);
    const batch = writeBatch(db);
    activeIds.forEach(siteId => {
        batch.delete(doc(
            db,
            'catalogos_publicos',
            siteId,
            'productos',
            String(productId)
        ));
    });
    batch.delete(doc(db, 'catalogo_imagenes', String(productId)));
    const nextProducts = withoutProductSnapshot(
        state.productos || [],
        productId
    );
    const publicationFingerprint = automaticPublishedFingerprint
        ? queueAutomaticPublicationMarker(
            batch,
            nextProducts,
            locales,
            activeIds
        )
        : '';
    await batch.commit();
    if (publicationFingerprint) {
        persistAutomaticPublishCache(publicationFingerprint, nextProducts.length);
    }
    return true;
}

export async function cleanupPublicCatalogOrphans({
    products = state.productos || [],
    locales = state.locales || []
} = {}) {
    if (!canManagePublicCatalog()) return 0;
    await loadCatalogSiteSettings(locales);
    const privateIds = new Set(
        products.map(product => String(product?.id || '')).filter(Boolean)
    );
    const siteIds = new Set([
        GENERAL_CATALOG_ID,
        ...knownCatalogSiteIds,
        ...getActiveIdsForLocales(locales)
    ]);
    const snapshots = await Promise.all(
        Array.from(siteIds).map(async siteId => ({
            siteId,
            snapshot: await getDocs(collection(
                db,
                'catalogos_publicos',
                siteId,
                'productos'
            ))
        }))
    );

    const orphanIds = new Set();
    let deletedCount = 0;
    let batch = writeBatch(db);
    let operationCount = 0;
    const commitIfNeeded = async force => {
        if (!force && operationCount < 400) return;
        if (operationCount === 0) return;
        await batch.commit();
        batch = writeBatch(db);
        operationCount = 0;
    };

    for (const { siteId, snapshot } of snapshots) {
        for (const publicDoc of snapshot.docs) {
            if (privateIds.has(publicDoc.id)) continue;
            orphanIds.add(publicDoc.id);
            batch.delete(doc(
                db,
                'catalogos_publicos',
                siteId,
                'productos',
                publicDoc.id
            ));
            operationCount++;
            deletedCount++;
            await commitIfNeeded(false);
        }
    }
    for (const productId of orphanIds) {
        batch.delete(doc(db, 'catalogo_imagenes', productId));
        operationCount++;
        await commitIfNeeded(false);
    }
    await commitIfNeeded(true);
    return deletedCount;
}

export async function syncPublicAvailability(
    productRows,
    {
        localId = '',
        locales = state.locales || []
    } = {}
) {
    const rows = Array.isArray(productRows) ? productRows : [];
    if (rows.length === 0) return;
    const activeIds = getActiveIdsForLocales(locales);

    const writes = [];
    rows.forEach(row => {
        if (!row?.id) return;
        const targetSites = new Set([GENERAL_CATALOG_ID]);
        const rowLocalId = normalizeText(row.localId);
        if (!rowLocalId || ['global', GENERAL_CATALOG_ID].includes(rowLocalId)) {
            activeIds.forEach(siteId => targetSites.add(siteId));
            // El stock de un producto global es compartido. Intentamos también
            // todas las sedes conocidas para no depender de que este vendedor
            // tenga actualizada la caché administrativa; los catálogos que no
            // existan simplemente producirán un not-found ya tolerado abajo.
            locales.forEach(site => {
                if (site?.id) targetSites.add(String(site.id));
            });
        } else if (activeIds.has(rowLocalId)) {
            targetSites.add(rowLocalId);
        }
        // La sede de la venta se intenta siempre. Un dispositivo vendedor no
        // necesariamente ha abierto la configuración administrativa y puede
        // no tener todavía esa sede en su caché de catálogos activos.
        if (localId) {
            targetSites.add(String(localId));
        }
        targetSites.forEach(siteId => {
            const publicRef = doc(
                db,
                'catalogos_publicos',
                siteId,
                'productos',
                String(row.id)
            );
            writes.push(
                updateDoc(publicRef, {
                    disponible:
                        row.disponible === undefined
                            ? (
                                row.stock === null || row.stock === undefined
                                    ? true
                                    : Number(row.stock) > 0
                            )
                            : row.disponible === true,
                    actualizadoEn: serverTimestamp()
                }).catch(error => {
                    if (error?.code !== 'not-found') {
                        console.warn('No se sincronizó una disponibilidad pública:', error);
                    }
                })
            );
        });
    });
    await Promise.allSettled(writes);
}

export async function saveCatalogSiteSettings({
    locales = state.locales || [],
    activeIds = [],
    products = state.productos || []
} = {}) {
    if (!canManagePublicCatalog()) {
        throw new Error('Solo admin o master puede configurar el catálogo público.');
    }
    const nextActive = new Set([
        GENERAL_CATALOG_ID,
        ...activeIds.map(String).filter(Boolean)
    ]);
    const previousActive = new Set(activeCatalogSiteIds);
    persistActiveSitesCache(nextActive);

    try {
        let batch = writeBatch(db);
        let operationCount = 0;
        const commitIfNeeded = async force => {
            if (!force && operationCount < 400) return;
            if (operationCount === 0) return;
            await batch.commit();
            batch = writeBatch(db);
            operationCount = 0;
        };

        const allSiteIds = new Set([
            GENERAL_CATALOG_ID,
            ...knownCatalogSiteIds,
            ...locales.map(local => String(local.id))
        ]);
        allSiteIds.forEach(siteId => knownCatalogSiteIds.add(siteId));
        const privateProductIds = new Set(
            products.map(product => String(product?.id || '')).filter(Boolean)
        );
        const publicSnapshots = await Promise.all(
            Array.from(allSiteIds).map(async siteId => ({
                siteId,
                snapshot: await getDocs(collection(
                    db,
                    'catalogos_publicos',
                    siteId,
                    'productos'
                ))
            }))
        );
        for (const siteId of allSiteIds) {
            queueSiteConfig(batch, siteId, locales, nextActive.has(siteId));
            operationCount++;
            await commitIfNeeded(false);
        }

        for (const product of products) {
            if (!product?.id) continue;
            const targetIds = getProductTargetIds(product, nextActive);
            const settings = getCatalogSettings(product);
            const publicProduct = buildPublicProduct(product);
            for (const siteId of allSiteIds) {
                const publicRef = doc(
                    db,
                    'catalogos_publicos',
                    siteId,
                    'productos',
                    String(product.id)
                );
                if (
                    nextActive.has(siteId)
                    && settings.visible
                    && targetIds.has(siteId)
                ) {
                    batch.set(publicRef, publicProduct, { merge: false });
                } else {
                    batch.delete(publicRef);
                }
                operationCount++;
                await commitIfNeeded(false);
            }
        }
        // Barre proyecciones huérfanas. Esto repara, por ejemplo, un producto
        // operativo eliminado por un vendedor, que no tiene permiso para
        // borrar directamente el catálogo público.
        for (const { siteId, snapshot } of publicSnapshots) {
            for (const publicDoc of snapshot.docs) {
                if (privateProductIds.has(publicDoc.id)) continue;
                batch.delete(doc(
                    db,
                    'catalogos_publicos',
                    siteId,
                    'productos',
                    publicDoc.id
                ));
                operationCount++;
                await commitIfNeeded(false);
            }
        }
        await commitIfNeeded(true);
        const fingerprint = createPublicProjectionFingerprint(
            products,
            locales,
            nextActive
        );
        // La firma se escribe al final. Si una tanda anterior falla, nunca queda
        // marcado como completo un catálogo publicado solo parcialmente.
        await setDoc(doc(db, 'catalogos_publicos', GENERAL_CATALOG_ID), {
            autoPublicacionVersion: AUTO_PUBLISH_SCHEMA_VERSION,
            autoPublicacionFirma: fingerprint,
            autoPublicacionProductos: privateProductIds.size,
            autoPublicacionEn: serverTimestamp()
        }, { merge: true });
        persistAutomaticPublishCache(fingerprint, privateProductIds.size);
        return Array.from(nextActive);
    } catch (error) {
        persistActiveSitesCache(previousActive);
        throw error;
    }
}

function loadImageElement(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('No se pudo leer la imagen seleccionada.'));
        };
        image.src = url;
    });
}

function canvasToBlob(canvas, type, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

export async function prepareCatalogImage(file) {
    if (!(file instanceof File)) throw new Error('Selecciona una imagen válida.');
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        throw new Error('Usa una imagen JPG, PNG o WebP.');
    }

    const image = await loadImageElement(file);
    const scale = Math.min(
        1,
        IMAGE_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight)
    );
    let width = Math.max(1, Math.round(image.naturalWidth * scale));
    let height = Math.max(1, Math.round(image.naturalHeight * scale));
    let quality = 0.84;
    let blob = null;
    let outputWidth = width;
    let outputHeight = height;

    for (let attempt = 0; attempt < 12; attempt++) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
            throw new Error('El navegador no pudo preparar la imagen.');
        }
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, width, height);

        blob = await canvasToBlob(canvas, 'image/webp', quality);
        if (!blob) blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        if (!blob) throw new Error('El navegador no pudo preparar la imagen.');
        outputWidth = width;
        outputHeight = height;
        if (blob.size <= IMAGE_TARGET_BYTES) break;

        if (quality > 0.58) quality -= 0.04;
        else {
            // Un solo factor conserva la proporción original y nunca agranda
            // imágenes pequeñas o panorámicas.
            width = Math.max(1, Math.round(width * 0.88));
            height = Math.max(1, Math.round(height * 0.88));
        }
    }

    if (!blob || blob.size > IMAGE_HARD_LIMIT_BYTES) {
        throw new Error('La imagen sigue siendo demasiado pesada después de optimizarla.');
    }

    return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        contentType: blob.type || 'image/webp',
        width: outputWidth,
        height: outputHeight,
        size: blob.size,
        previewUrl: URL.createObjectURL(blob)
    };
}

export async function saveCatalogImage(productId, prepared, version = Date.now()) {
    if (!canManagePublicCatalog()) {
        throw new Error('Solo admin o master puede subir imágenes al catálogo.');
    }
    if (!productId) throw new Error('Falta el producto de la imagen.');
    await setDoc(
        doc(db, 'catalogo_imagenes', String(productId)),
        buildCatalogImageDocument(prepared, version)
    );
    return version;
}

export async function deleteCatalogImage(productId) {
    if (!canManagePublicCatalog() || !productId) return false;
    await deleteDoc(doc(db, 'catalogo_imagenes', String(productId)));
    return true;
}

export async function getCatalogImagePreviewUrl(imageId) {
    if (!imageId) return '';
    const snapshot = await getDoc(doc(db, 'catalogo_imagenes', String(imageId)));
    if (!snapshot.exists()) return '';
    const image = snapshot.data();
    const bytes = image.bytes?.toUint8Array?.();
    if (!bytes) return '';
    return URL.createObjectURL(new Blob(
        [bytes],
        { type: image.contentType || 'image/webp' }
    ));
}
