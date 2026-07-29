import { db, collection, doc, onSnapshot, query, where } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; 
import { formatMoney, getTodayDateStr, getTrustedNowMs } from '../utils/helpers.js';
import { createUuid } from '../core/sales-service.js';
import { queueStockEntry } from '../core/inventory-service.js';
import {
    applyProductosVentaChanges,
    renderProductosVenta
} from './ui-ventas.js';
import { persistProductsCache } from '../core/local-cache.js';
import { applyPendingDocumentMutations } from '../core/sync-queue.js';
import {
    canManagePublicCatalog,
    deletePublicCatalogProduct,
    deleteProductAndPublicCatalog,
    ensurePublicCatalogPublished,
    getActiveCatalogSiteIds,
    getCatalogImagePreviewUrl,
    getCatalogSettings,
    loadCatalogSiteSettings,
    prepareCatalogImage,
    resolvePublicAvailability,
    saveCatalogSiteSettings,
    saveProductAndPublicCatalog,
    syncPublicAvailability,
} from '../core/public-catalog-service.js';

let listaInventarioEl; 
let categoriaActual = 'vaso';
let unsubscribeInventario = [];
let unsubscribeCupControl = null;
let cupControlSubscribedDate = '';
let cupControlDateCheckTimer = null;
let confirmedCupControlRows = [];
let inventarioInicializado = false;
let inventoryLoadToken = 0;
let cancelInventoryLoad = null;
let inventoryRenderFrame = null;
let pendingCatalogFullRender = false;
let pendingCatalogChangeIds = new Set();
let inventoryRenderPending = true;
let inventoryViewObserver = null;
let confirmedCatalogRows = [];
let inventorySyncQueueListenerInstalled = false;
let preparedCatalogImage = null;
let catalogImagePreparation = null;
let catalogImagePreviewUrl = '';
let catalogImageRemoved = false;
let catalogEditorToken = 0;
let catalogSitesLoadToken = 0;
let virtualCatalogOpenToken = 0;
let catalogQrRenderToken = 0;
let catalogQrCurrentUrl = 'https://raffaelito-catalogo.vercel.app/';
let catalogQrReadyUrl = '';
let catalogQrModulePromise = null;
let catalogQuickQrRenderToken = 0;
let catalogQuickQrCurrentUrl = '';
let catalogQuickQrReadyUrl = '';
let catalogQuickQrCurrentSiteId = 'general';
let catalogQuickQrReturnFocus = null;
let catalogQuickQrCloseTimer = null;
let catalogQuickQrPreparedBlob = null;
let catalogQuickQrPreparedFile = null;
let catalogQrLogoPromise = null;
const virtualCatalogImageStates = new Map();
const virtualCatalogSaveTokens = new Map();

const PUBLIC_CATALOG_BASE_URL = 'https://raffaelito-catalogo.vercel.app/';
const CATALOG_SITE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const CATALOG_QUICK_QR_SIZE = 2048;
const CATALOG_QR_LOGO_URL = '/assets/img/logo.png';
const CATALOG_QR_OPTIONS = Object.freeze({
    errorCorrectionLevel: 'H',
    margin: 4,
    color: {
        dark: '#0f172a',
        light: '#ffffff'
    }
});

function loadCatalogQrModule() {
    if (!catalogQrModulePromise) {
        catalogQrModulePromise = import('qrcode')
            .then(module => module.default || module)
            .catch(error => {
                catalogQrModulePromise = null;
                throw error;
            });
    }
    return catalogQrModulePromise;
}

function loadCatalogQrLogo() {
    if (!catalogQrLogoPromise) {
        catalogQrLogoPromise = new Promise(resolve => {
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = CATALOG_QR_LOGO_URL;
        });
    }
    return catalogQrLogoPromise;
}

// Estado temporal para construir los tamaños en el modal
let tamanosActuales = [];

function closeModal(modalId, delay = 200) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('opacity-0', 'pointer-events-none');
    setTimeout(() => modal.classList.add('hidden'), delay);
}

function releaseCatalogImagePreview() {
    if (catalogImagePreviewUrl) {
        URL.revokeObjectURL(catalogImagePreviewUrl);
        catalogImagePreviewUrl = '';
    }
}

function renderCatalogImagePreview(url = '') {
    const preview = document.getElementById('catalog-image-preview');
    const placeholder = document.getElementById('catalog-image-placeholder');
    const removeButton = document.getElementById('btn-catalog-image-remove');
    if (!preview || !placeholder || !removeButton) return;

    if (url) {
        preview.src = url;
        preview.classList.remove('hidden');
        placeholder.classList.add('hidden');
        removeButton.classList.remove('hidden');
    } else {
        preview.removeAttribute('src');
        preview.classList.add('hidden');
        placeholder.classList.remove('hidden');
        removeButton.classList.add('hidden');
    }
}

function setCatalogImageStatus(message, tone = 'slate') {
    const status = document.getElementById('catalog-image-status');
    if (!status) return;
    status.textContent = message;
    status.className = `mt-1 text-[10px] leading-tight text-${tone}-500`;
}

function updateCatalogDescriptionCount() {
    const input = document.getElementById('catalog-description');
    const counter = document.getElementById('catalog-description-count');
    if (input && counter) counter.textContent = String(input.value.length);
}

function resetCatalogEditor(product = null) {
    const section = document.getElementById('div-catalogo-publico');
    const manager = canManagePublicCatalog();
    section?.classList.toggle('hidden', !manager);
    catalogEditorToken++;
    const token = catalogEditorToken;
    catalogImagePreparation = null;
    preparedCatalogImage = null;
    catalogImageRemoved = false;
    releaseCatalogImagePreview();
    renderCatalogImagePreview('');

    if (!manager) return;
    const settings = getCatalogSettings(product || { categoria: categoriaActual });
    document.getElementById('catalog-visible').checked = settings.visible;
    document.getElementById('catalog-name').value = settings.nombrePublico;
    document.getElementById('catalog-description').value = settings.descripcion;
    document.getElementById('catalog-availability').value = settings.disponibilidad;
    document.getElementById('catalog-order').value = String(settings.orden);
    document.getElementById('catalog-show-price').checked = settings.mostrarPrecio;
    document.getElementById('catalog-featured').checked = settings.destacado;
    const fileInput = document.getElementById('catalog-image-file');
    if (fileInput) fileInput.value = '';
    updateCatalogDescriptionCount();

    if (!settings.imagenId) {
        setCatalogImageStatus('Se optimiza automáticamente para cargar rápido.');
        return;
    }

    setCatalogImageStatus('Cargando imagen guardada…');
    void getCatalogImagePreviewUrl(settings.imagenId)
        .then(url => {
            if (token !== catalogEditorToken) {
                if (url) URL.revokeObjectURL(url);
                return;
            }
            if (!url) {
                setCatalogImageStatus('La imagen no está disponible todavía.', 'amber');
                return;
            }
            releaseCatalogImagePreview();
            catalogImagePreviewUrl = url;
            renderCatalogImagePreview(url);
            setCatalogImageStatus('Imagen guardada en el catálogo.', 'emerald');
        })
        .catch(error => {
            console.warn('No se pudo cargar la imagen del catálogo:', error);
            if (token === catalogEditorToken) {
                setCatalogImageStatus('No se pudo cargar la imagen guardada.', 'amber');
            }
        });
}

function readCatalogEditorSettings(productId, baseProduct = null) {
    const existing = getCatalogSettings(baseProduct || {});
    if (!canManagePublicCatalog()) return baseProduct?.catalogo || undefined;

    const version = preparedCatalogImage || catalogImageRemoved
        ? Date.now()
        : existing.imagenVersion;
    return {
        visible: document.getElementById('catalog-visible').checked,
        nombrePublico: document.getElementById('catalog-name').value.trim(),
        descripcion: document.getElementById('catalog-description').value.trim(),
        mostrarPrecio: document.getElementById('catalog-show-price').checked,
        disponibilidad: document.getElementById('catalog-availability').value,
        destacado: document.getElementById('catalog-featured').checked,
        orden: Math.max(
            0,
            Math.min(9999, Number(document.getElementById('catalog-order').value) || 0)
        ),
        imagenId: preparedCatalogImage
            ? String(productId)
            : (catalogImageRemoved ? '' : existing.imagenId),
        imagenVersion: version
    };
}

function handleCatalogImageSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const token = ++catalogEditorToken;
    catalogImageRemoved = false;
    preparedCatalogImage = null;
    setCatalogImageStatus('Optimizando imagen…', 'emerald');

    const preparation = prepareCatalogImage(file)
        .then(prepared => {
            if (token !== catalogEditorToken) {
                URL.revokeObjectURL(prepared.previewUrl);
                return null;
            }
            releaseCatalogImagePreview();
            preparedCatalogImage = prepared;
            catalogImagePreviewUrl = prepared.previewUrl;
            renderCatalogImagePreview(prepared.previewUrl);
            setCatalogImageStatus(
                `Lista para guardar · ${Math.max(1, Math.round(prepared.size / 1024))} KB`,
                'emerald'
            );
            return prepared;
        })
        .catch(error => {
            console.error('No se pudo preparar la imagen:', error);
            if (token === catalogEditorToken) {
                preparedCatalogImage = null;
                renderCatalogImagePreview('');
                setCatalogImageStatus(error?.message || 'Imagen no válida.', 'red');
            }
            return null;
        })
        .finally(() => {
            if (catalogImagePreparation === preparation) {
                catalogImagePreparation = null;
            }
        });
    catalogImagePreparation = preparation;
}

function removeCatalogEditorImage() {
    catalogEditorToken++;
    catalogImagePreparation = null;
    preparedCatalogImage = null;
    catalogImageRemoved = true;
    releaseCatalogImagePreview();
    renderCatalogImagePreview('');
    const fileInput = document.getElementById('catalog-image-file');
    if (fileInput) fileInput.value = '';
    setCatalogImageStatus('La imagen se quitará al guardar.', 'amber');
}

function escapeCatalogHtml(value = '') {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function isCupInventoryProduct(product = {}) {
    return (
        String(product.categoria || '').trim().toLowerCase() === 'insumo'
        && (
            String(product.tipoInsumo || '').trim().toLowerCase() === 'vaso'
            || product.esVasoInventario === true
        )
    );
}

function productBelongsToLocal(product = {}, localId = '') {
    const productLocalId = String(product.localId || '').trim();
    return (
        !productLocalId
        || ['global', 'general'].includes(productLocalId)
        || (Boolean(localId) && productLocalId === String(localId))
    );
}

function getCupControlByProductId() {
    const projectedRows = applyPendingDocumentMutations(
        'control_vasos_diario',
        confirmedCupControlRows
    );
    return new Map(
        projectedRows
            .filter(row => row?.productoId)
            .map(row => [String(row.productoId), row])
    );
}

function getVisibleCupInventoryItems({ includeArchived = true } = {}) {
    return state.productos.filter(product => (
        isCupInventoryProduct(product)
        && (includeArchived || product.activo !== false)
        && (
            state.userRole === 'admin'
            || state.userRole === 'master'
            || productBelongsToLocal(product, state.userLocalId)
        )
    ));
}

function getCupDayNumbers(product, controlRows = getCupControlByProductId()) {
    const control = controlRows.get(String(product.id)) || {};
    const current = Number(product.stock);
    const safeCurrent = Number.isFinite(current) ? current : 0;
    const entries = Number(control.entradas || 0);
    const used = Number(control.consumidos || 0);
    const safeEntries = Number.isFinite(entries) ? entries : 0;
    const safeUsed = Number.isFinite(used) ? used : 0;
    return {
        current: safeCurrent,
        entries: safeEntries,
        used: safeUsed,
        start: safeCurrent + safeUsed - safeEntries
    };
}

function renderCupControlSummary() {
    const panel = document.getElementById('cup-control-panel');
    const isCupMode = categoriaActual === 'insumo';
    panel?.classList.toggle('hidden', !isCupMode);
    if (!isCupMode) return;

    const totals = getVisibleCupInventoryItems({ includeArchived: false })
        .reduce((summary, product) => {
            const row = getCupDayNumbers(product);
            summary.start += row.start;
            summary.used += row.used;
            summary.current += row.current;
            return summary;
        }, { start: 0, used: 0, current: 0 });

    const start = document.getElementById('cup-total-start');
    const used = document.getElementById('cup-total-used');
    const current = document.getElementById('cup-total-current');
    if (start) start.textContent = String(totals.start);
    if (used) used.textContent = String(totals.used);
    if (current) current.textContent = String(totals.current);
}

function updateInventoryModeUi() {
    const isCupMode = categoriaActual === 'insumo';
    const addButton = document.getElementById('btn-nuevo-producto');
    const addText = document.getElementById('btn-nuevo-producto-texto');
    const historyHeading = document.getElementById('inventory-heading-history');
    const priceHeading = document.getElementById('inventory-heading-price');
    const stockHeading = document.getElementById('inventory-heading-stock');

    if (addText) addText.textContent = isCupMode ? 'Nuevo vaso' : 'Añadir ítem';
    if (addButton) {
        addButton.setAttribute(
            'aria-label',
            isCupMode ? 'Añadir vaso de inventario' : 'Añadir producto'
        );
    }
    if (historyHeading) {
        historyHeading.textContent = isCupMode ? 'Inicio / Mov. hoy' : 'Ventas Hist.';
    }
    if (priceHeading) priceHeading.textContent = isCupMode ? 'Tipo' : 'Precio(s)';
    if (stockHeading) stockHeading.textContent = isCupMode ? 'Stock actual' : 'Stock';
    renderCupControlSummary();
}

function normalizeVirtualCatalogValue(value = '') {
    return String(value).trim().toLocaleLowerCase('es');
}

function getCatalogQrUrl(siteId = 'general') {
    const normalizedSiteId = String(siteId || 'general').trim();
    if (!normalizedSiteId || normalizedSiteId === 'general') {
        return PUBLIC_CATALOG_BASE_URL;
    }
    const url = new URL(PUBLIC_CATALOG_BASE_URL);
    url.searchParams.set('sede', normalizedSiteId);
    return url.toString();
}

function getCatalogQuickQrSiteId() {
    const candidate = String(state.userLocalId || '').trim();
    if (
        !candidate
        || ['general', 'global'].includes(candidate.toLowerCase())
        || !CATALOG_SITE_ID_PATTERN.test(candidate)
    ) {
        return 'general';
    }
    const knownSiteIds = new Set(
        (state.locales || []).map(local => String(local?.id || '')).filter(Boolean)
    );
    const activeSiteIds = new Set(
        getActiveCatalogSiteIds().map(siteId => String(siteId))
    );
    return (
        (knownSiteIds.size === 0 || knownSiteIds.has(candidate))
        && activeSiteIds.has(candidate)
    )
        ? candidate
        : 'general';
}

function setCatalogQuickQrStatus(message) {
    const status = document.getElementById('catalog-qr-rapido-status');
    if (status) status.textContent = message;
}

function setCatalogQuickQrReady(ready) {
    [
        'btn-descargar-catalog-qr-rapido',
        'btn-compartir-catalog-qr-rapido'
    ].forEach(id => {
        const button = document.getElementById(id);
        if (!button) return;
        button.disabled = !ready;
        if (ready) button.removeAttribute('aria-busy');
        else button.setAttribute('aria-busy', 'true');
    });
    document.getElementById('catalog-qr-rapido-loading')
        ?.classList.toggle('hidden', ready);
}

function paintCatalogQrLogo(canvas, image) {
    if (!image) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const plateSize = Math.round(canvas.width * 0.18);
    const logoSize = Math.round(canvas.width * 0.16);
    const plateX = Math.round((canvas.width - plateSize) / 2);
    const plateY = Math.round((canvas.height - plateSize) / 2);
    const radius = Math.round(plateSize * 0.18);

    context.save();
    context.fillStyle = '#ffffff';
    context.beginPath();
    if (typeof context.roundRect === 'function') {
        context.roundRect(plateX, plateY, plateSize, plateSize, radius);
    } else {
        context.rect(plateX, plateY, plateSize, plateSize);
    }
    context.fill();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
        image,
        Math.round((canvas.width - logoSize) / 2),
        Math.round((canvas.height - logoSize) / 2),
        logoSize,
        logoSize
    );
    context.restore();
}

function catalogCanvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('No se pudo preparar la imagen del QR.'));
        }, 'image/png');
    });
}

function getCatalogQuickQrFileName() {
    const siteId = String(catalogQuickQrCurrentSiteId || 'general')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'general';
    return `qr-catalogo-raffaelito-${siteId}.png`;
}

async function renderCatalogQuickQr() {
    const canvas = document.getElementById('catalog-qr-rapido-canvas');
    if (!canvas) return false;
    const siteId = getCatalogQuickQrSiteId();
    const url = getCatalogQrUrl(siteId);
    if (
        catalogQuickQrReadyUrl === url
        && catalogQuickQrPreparedBlob
        && canvas.width === CATALOG_QUICK_QR_SIZE
    ) {
        catalogQuickQrCurrentUrl = url;
        catalogQuickQrCurrentSiteId = siteId;
        setCatalogQuickQrReady(true);
        setCatalogQuickQrStatus('Código QR listo.');
        return true;
    }

    const token = ++catalogQuickQrRenderToken;
    catalogQuickQrCurrentUrl = url;
    catalogQuickQrCurrentSiteId = siteId;
    catalogQuickQrReadyUrl = '';
    catalogQuickQrPreparedBlob = null;
    catalogQuickQrPreparedFile = null;
    setCatalogQuickQrReady(false);
    setCatalogQuickQrStatus('Generando código QR.');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);

    try {
        const [QRCode, logo] = await Promise.all([
            loadCatalogQrModule(),
            loadCatalogQrLogo()
        ]);
        if (token !== catalogQuickQrRenderToken) return false;

        const buffer = document.createElement('canvas');
        await QRCode.toCanvas(buffer, url, {
            ...CATALOG_QR_OPTIONS,
            width: CATALOG_QUICK_QR_SIZE
        });
        if (token !== catalogQuickQrRenderToken) return false;
        paintCatalogQrLogo(buffer, logo);

        canvas.width = buffer.width;
        canvas.height = buffer.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('El navegador no pudo dibujar el QR.');
        context.imageSmoothingEnabled = false;
        context.drawImage(buffer, 0, 0);

        const blob = await catalogCanvasToBlob(canvas);
        if (token !== catalogQuickQrRenderToken) return false;
        catalogQuickQrPreparedBlob = blob;
        catalogQuickQrPreparedFile = typeof File === 'function'
            ? new File([blob], getCatalogQuickQrFileName(), {
                type: 'image/png'
            })
            : null;
        catalogQuickQrReadyUrl = url;
        setCatalogQuickQrReady(true);
        setCatalogQuickQrStatus('Código QR listo.');
        return true;
    } catch (error) {
        console.error('No se pudo preparar el QR rápido:', error);
        if (token === catalogQuickQrRenderToken) {
            catalogQuickQrReadyUrl = '';
            catalogQuickQrPreparedBlob = null;
            catalogQuickQrPreparedFile = null;
            setCatalogQuickQrReady(false);
            document.getElementById('catalog-qr-rapido-loading')
                ?.classList.add('hidden');
            setCatalogQuickQrStatus('No se pudo generar el código QR.');
            window.mostrarToast?.(
                'No se pudo generar el QR',
                'Inténtalo nuevamente.',
                'red'
            );
        }
        return false;
    }
}

function openCatalogQuickQrModal() {
    const modal = document.getElementById('modal-catalog-qr-rapido');
    if (!modal) return;
    if (catalogQuickQrCloseTimer) {
        clearTimeout(catalogQuickQrCloseTimer);
        catalogQuickQrCloseTimer = null;
    }
    catalogQuickQrReturnFocus = document.activeElement;
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.remove('opacity-0'));
    void renderCatalogQuickQr();
    document.getElementById('btn-cerrar-catalog-qr-rapido')?.focus();
}

function closeCatalogQuickQrModal() {
    const modal = document.getElementById('modal-catalog-qr-rapido');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('opacity-0');
    catalogQuickQrCloseTimer = setTimeout(() => {
        modal.classList.add('hidden');
        catalogQuickQrCloseTimer = null;
    }, 120);
    if (
        catalogQuickQrReturnFocus instanceof HTMLElement
        && catalogQuickQrReturnFocus.isConnected
    ) {
        catalogQuickQrReturnFocus.focus();
    }
    catalogQuickQrReturnFocus = null;
}

async function downloadCatalogQuickQr() {
    if (
        catalogQuickQrReadyUrl !== catalogQuickQrCurrentUrl
        || !catalogQuickQrPreparedBlob
    ) {
        setCatalogQuickQrStatus('El código QR todavía no está listo.');
        return false;
    }
    try {
        const objectUrl = URL.createObjectURL(catalogQuickQrPreparedBlob);
        const link = document.createElement('a');
        link.download = getCatalogQuickQrFileName();
        link.href = objectUrl;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        setCatalogQuickQrStatus('Código QR descargado.');
        return true;
    } catch (error) {
        console.error('No se pudo descargar el QR rápido:', error);
        window.mostrarToast?.(
            'No se pudo descargar',
            'Usa Compartir para guardar la imagen.',
            'amber'
        );
        return false;
    }
}

async function shareCatalogQuickQr() {
    if (
        catalogQuickQrReadyUrl !== catalogQuickQrCurrentUrl
        || !catalogQuickQrPreparedBlob
    ) {
        setCatalogQuickQrStatus('El código QR todavía no está listo.');
        return;
    }

    let canShareFile = false;
    try {
        canShareFile = Boolean(
            catalogQuickQrPreparedFile
            && typeof navigator.share === 'function'
            && typeof navigator.canShare === 'function'
            && navigator.canShare({ files: [catalogQuickQrPreparedFile] })
        );
    } catch (_) {
        canShareFile = false;
    }
    if (canShareFile) {
        try {
            await navigator.share({ files: [catalogQuickQrPreparedFile] });
            setCatalogQuickQrStatus('Código QR compartido.');
            return;
        } catch (error) {
            if (error?.name === 'AbortError') {
                setCatalogQuickQrStatus('No se compartió el código QR.');
                return;
            }
            console.warn('No se pudo abrir el menú para compartir el QR:', error);
        }
    }

    const downloaded = await downloadCatalogQuickQr();
    if (downloaded) {
        window.mostrarToast?.(
            'QR descargado',
            'Tu navegador no comparte archivos directamente. Adjunta la imagen descargada.',
            'amber'
        );
    }
}

function setCatalogQrStatus(message, tone = 'slate') {
    const status = document.getElementById('catalog-qr-status');
    if (!status) return;
    status.textContent = message;
    const tones = {
        slate: 'text-slate-400',
        emerald: 'text-emerald-600',
        amber: 'text-amber-600',
        red: 'text-red-500'
    };
    status.className = `mt-2 min-h-4 text-[10px] ${tones[tone] || tones.slate}`;
}

function setCatalogQrActionsReady(ready) {
    [
        'btn-catalog-qr-ampliar',
        'btn-catalog-qr-preview',
        'btn-catalog-qr-descargar',
        'btn-catalog-qr-descargar-zoom'
    ].forEach(id => {
        const button = document.getElementById(id);
        if (!button) return;
        button.disabled = !ready;
        if (ready) button.removeAttribute('aria-busy');
        else button.setAttribute('aria-busy', 'true');
        button.classList.toggle('opacity-50', !ready);
        button.classList.toggle('cursor-wait', !ready);
    });
}

function getCatalogQrSiteName(siteId = 'general') {
    if (String(siteId) === 'general') return 'General';
    return String(
        state.locales?.find(local => String(local.id) === String(siteId))?.nombre
        || 'Sede'
    );
}

function renderCatalogQrSiteOptions(activeIds = getActiveCatalogSiteIds()) {
    const select = document.getElementById('catalog-qr-site-select');
    if (!select) return;
    const previousValue = String(select.value || 'general');
    const knownSiteIds = new Set(
        (state.locales || []).map(local => String(local?.id || '')).filter(Boolean)
    );
    const normalizedIds = Array.from(new Set([
        'general',
        ...Array.from(activeIds || [])
            .map(siteId => String(siteId || '').trim())
            .filter(siteId => (
                siteId !== 'general'
                && CATALOG_SITE_ID_PATTERN.test(siteId)
                && (knownSiteIds.size === 0 || knownSiteIds.has(siteId))
            ))
    ]));
    const fragment = document.createDocumentFragment();
    normalizedIds.forEach(siteId => {
        const option = document.createElement('option');
        option.value = siteId;
        option.textContent = siteId === 'general'
            ? 'General · todos los productos'
            : getCatalogQrSiteName(siteId);
        fragment.appendChild(option);
    });
    select.replaceChildren(fragment);
    select.value = normalizedIds.includes(previousValue)
        ? previousValue
        : 'general';
    void renderSelectedCatalogQr();
}

async function renderSelectedCatalogQr() {
    const select = document.getElementById('catalog-qr-site-select');
    const canvas = document.getElementById('catalog-qr-canvas');
    const zoomCanvas = document.getElementById('catalog-qr-zoom-canvas');
    const urlLabel = document.getElementById('catalog-qr-url');
    const zoomSiteLabel = document.getElementById('catalog-qr-zoom-site');
    if (!canvas || !zoomCanvas) return;

    const selectedSiteId = String(select?.value || 'general');
    const selectedSiteName = select?.selectedOptions?.[0]?.textContent
        || getCatalogQrSiteName(selectedSiteId);
    const url = getCatalogQrUrl(selectedSiteId);
    if (
        catalogQrReadyUrl === url
        && canvas.width > 0
        && zoomCanvas.width > 0
    ) {
        catalogQrCurrentUrl = url;
        if (urlLabel) {
            urlLabel.textContent = url;
            urlLabel.title = url;
        }
        if (zoomSiteLabel) zoomSiteLabel.textContent = selectedSiteName;
        setCatalogQrActionsReady(true);
        setCatalogQrStatus('QR listo para compartir, copiar o descargar.', 'emerald');
        return;
    }
    const token = ++catalogQrRenderToken;
    catalogQrCurrentUrl = url;
    catalogQrReadyUrl = '';
    setCatalogQrActionsReady(false);
    [canvas, zoomCanvas].forEach(target => {
        target.getContext('2d')?.clearRect(0, 0, target.width, target.height);
    });
    if (urlLabel) {
        urlLabel.textContent = url;
        urlLabel.title = url;
    }
    if (zoomSiteLabel) zoomSiteLabel.textContent = selectedSiteName;
    setCatalogQrStatus('Generando QR en este dispositivo…');

    try {
        const QRCode = await loadCatalogQrModule();
        if (token !== catalogQrRenderToken) return;
        const previewBuffer = document.createElement('canvas');
        const zoomBuffer = document.createElement('canvas');
        await Promise.all([
            QRCode.toCanvas(previewBuffer, url, {
                ...CATALOG_QR_OPTIONS,
                width: 384
            }),
            QRCode.toCanvas(zoomBuffer, url, {
                ...CATALOG_QR_OPTIONS,
                width: 1024
            })
        ]);
        if (token !== catalogQrRenderToken) return;
        [
            [canvas, previewBuffer],
            [zoomCanvas, zoomBuffer]
        ].forEach(([target, source]) => {
            target.width = source.width;
            target.height = source.height;
            const context = target.getContext('2d');
            context?.clearRect(0, 0, target.width, target.height);
            context?.drawImage(source, 0, 0);
        });
        catalogQrReadyUrl = url;
        setCatalogQrActionsReady(true);
        canvas.setAttribute(
            'aria-label',
            `Código QR del catálogo ${selectedSiteName}`
        );
        zoomCanvas.setAttribute(
            'aria-label',
            `Código QR ampliado del catálogo ${selectedSiteName}`
        );
        setCatalogQrStatus('QR listo para compartir, copiar o descargar.', 'emerald');
    } catch (error) {
        console.error('No se pudo generar el QR del catálogo:', error);
        if (token === catalogQrRenderToken) {
            catalogQrReadyUrl = '';
            setCatalogQrActionsReady(false);
            setCatalogQrStatus('No se pudo generar el QR. Inténtalo nuevamente.', 'red');
        }
    }
}

function openCatalogQrZoom() {
    if (catalogQrReadyUrl !== catalogQrCurrentUrl) {
        setCatalogQrStatus('Espera a que termine de generarse el QR.', 'amber');
        return;
    }
    const zoom = document.getElementById('catalog-qr-zoom');
    if (!zoom) return;
    zoom.classList.remove('hidden');
    document.getElementById('btn-catalog-qr-cerrar-zoom')?.focus();
}

function closeCatalogQrZoom() {
    const zoom = document.getElementById('catalog-qr-zoom');
    if (!zoom || zoom.classList.contains('hidden')) return;
    zoom.classList.add('hidden');
    document.getElementById('btn-catalog-qr-ampliar')?.focus();
}

function openSelectedCatalogLink() {
    const opened = window.open(
        catalogQrCurrentUrl,
        '_blank',
        'noopener,noreferrer'
    );
    if (opened) {
        opened.opener = null;
        return;
    }
    setCatalogQrStatus('El navegador bloqueó la nueva pestaña. Usa Copiar.', 'amber');
}

async function copySelectedCatalogLink() {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(catalogQrCurrentUrl);
        } else {
            const input = document.createElement('textarea');
            input.value = catalogQrCurrentUrl;
            input.setAttribute('readonly', '');
            input.style.position = 'fixed';
            input.style.opacity = '0';
            document.body.appendChild(input);
            input.select();
            const copied = document.execCommand('copy');
            input.remove();
            if (!copied) throw new Error('El navegador no permitió copiar.');
        }
        setCatalogQrStatus('Enlace copiado.', 'emerald');
        window.mostrarToast?.(
            'Enlace copiado',
            'Ya puedes compartir el catálogo.',
            'emerald'
        );
    } catch (error) {
        console.warn('No se pudo copiar el enlace del catálogo:', error);
        setCatalogQrStatus('Mantén presionado el enlace para copiarlo.', 'amber');
        window.mostrarToast?.(
            'No se pudo copiar',
            'Mantén presionado el enlace mostrado y cópialo manualmente.',
            'amber'
        );
    }
}

async function downloadSelectedCatalogQr() {
    const canvas = document.getElementById('catalog-qr-zoom-canvas');
    const select = document.getElementById('catalog-qr-site-select');
    if (
        catalogQrReadyUrl !== catalogQrCurrentUrl
        || !canvas
        || !canvas.width
        || !canvas.height
    ) {
        setCatalogQrStatus('Espera a que termine de generarse el QR.', 'amber');
        return;
    }
    try {
        const siteId = String(select?.value || 'general')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            || 'general';
        const fileName = `catalogo-raffaelito-${siteId}.png`;
        const isAppleTouchDevice = (
            /iPad|iPhone|iPod/i.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        );
        if (
            isAppleTouchDevice
            && typeof File === 'function'
            && typeof navigator.share === 'function'
            && typeof navigator.canShare === 'function'
        ) {
            const blob = await new Promise(resolve => {
                canvas.toBlob(resolve, 'image/png');
            });
            const file = blob
                ? new File([blob], fileName, { type: 'image/png' })
                : null;
            if (file && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: 'QR del catálogo Raffaelito'
                    });
                    setCatalogQrStatus('QR listo para guardar o compartir.', 'emerald');
                    return;
                } catch (shareError) {
                    if (shareError?.name === 'AbortError') {
                        setCatalogQrStatus('No se compartió el QR.', 'slate');
                        return;
                    }
                    console.warn('No se pudo abrir el menú para compartir:', shareError);
                }
            }
        }
        const link = document.createElement('a');
        link.download = fileName;
        link.href = canvas.toDataURL('image/png');
        link.rel = 'noopener';
        link.target = '_blank';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setCatalogQrStatus(
            isAppleTouchDevice
                ? 'Si se abrió la imagen, mantenla presionada para guardarla.'
                : 'QR descargado en formato PNG.',
            'emerald'
        );
    } catch (error) {
        console.error('No se pudo descargar el QR:', error);
        setCatalogQrStatus('El navegador no permitió descargar el QR.', 'red');
    }
}

function releaseVirtualCatalogImageStates() {
    virtualCatalogImageStates.forEach(imageState => {
        imageState.token++;
        if (imageState.previewUrl) URL.revokeObjectURL(imageState.previewUrl);
    });
    virtualCatalogImageStates.clear();
    virtualCatalogSaveTokens.clear();
}

function getVirtualCatalogOptionCount(category, product) {
    const expectedCategory = normalizeVirtualCatalogValue(category);
    const productLocalId = normalizeVirtualCatalogValue(product.localId);
    const productIsGlobal = (
        !productLocalId
        || productLocalId === 'global'
        || productLocalId === 'general'
    );
    return state.productos.filter(option => {
        if (normalizeVirtualCatalogValue(option.categoria) !== expectedCategory) {
            return false;
        }
        const optionLocalId = normalizeVirtualCatalogValue(option.localId);
        const optionIsGlobal = (
            !optionLocalId
            || optionLocalId === 'global'
            || optionLocalId === 'general'
        );
        // General reúne las opciones de todas las sedes. Una carta de sede
        // combina sus propias opciones con las globales.
        if (!productIsGlobal && !optionIsGlobal && optionLocalId !== productLocalId) {
            return false;
        }
        return resolvePublicAvailability(option);
    }).length;
}

function getVirtualCatalogSizes(product) {
    const sizes = Array.isArray(product.tamanos) && product.tamanos.length > 0
        ? product.tamanos
        : [{ nombre: 'Único / Estándar', precio: Number(product.precio || 0) }];
    return sizes
        .map(size => ({
            nombre: String(size?.nombre || 'Único'),
            precio: Math.max(0, Number(size?.precio || 0))
        }))
        .slice(0, 12);
}

function getVirtualCatalogLocalLabel(product) {
    const productLocalId = normalizeVirtualCatalogValue(product.localId);
    if (
        !productLocalId
        || productLocalId === 'global'
        || productLocalId === 'general'
    ) return 'Todas las sedes';
    return state.locales?.find(
        local => normalizeVirtualCatalogValue(local.id) === productLocalId
    )
        ?.nombre || 'Sede';
}

function setVirtualCatalogImage(card, url = '', message = '', allowRemove = Boolean(url)) {
    if (!card) return;
    const image = card.querySelector('[data-virtual-image]');
    const placeholder = card.querySelector('[data-virtual-image-placeholder]');
    const removeButton = card.querySelector('[data-virtual-action="remove-image"]');
    const status = card.querySelector('[data-virtual-image-status]');
    if (image && placeholder) {
        if (url) {
            image.src = url;
            image.classList.remove('hidden');
            placeholder.classList.add('hidden');
        } else {
            image.removeAttribute('src');
            image.classList.add('hidden');
            placeholder.classList.remove('hidden');
        }
    }
    removeButton?.classList.toggle('hidden', !allowRemove);
    if (status && message) status.textContent = message;
}

function updateVirtualCatalogCardBadge(card, product, settings) {
    const badge = card?.querySelector('[data-virtual-public-state]');
    if (!badge) return;
    const available = resolvePublicAvailability({
        ...product,
        catalogo: settings
    });
    let text = 'Publicado';
    let classes = 'bg-emerald-100 text-emerald-700';
    if (!settings.visible) {
        text = 'Oculto';
        classes = 'bg-slate-200 text-slate-600';
    } else if (!available) {
        text = 'Agotado';
        classes = 'bg-amber-100 text-amber-700';
    }
    badge.textContent = text;
    badge.className = `inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${classes}`;
}

function createVirtualCatalogProductCard(product) {
    const settings = getCatalogSettings(product);
    const sizes = getVirtualCatalogSizes(product);
    const flavorLimit = Math.max(0, Math.trunc(Number(product.limite_sabores || 0)));
    const flavorLimitLabel = flavorLimit === 0
        ? 'Sin sabores'
        : (flavorLimit >= 999 ? 'Sabores ilimitados' : `Máx. ${flavorLimit} sabores`);
    const flavorCount = getVirtualCatalogOptionCount('sabor', product);
    const toppingCount = getVirtualCatalogOptionCount('topping', product);
    const card = document.createElement('article');
    card.dataset.catalogVirtualProductId = String(product.id);
    card.className = 'rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden';
    card.innerHTML = `
        <div class="p-3 sm:p-4 border-b border-slate-100">
            <div class="flex items-start gap-3">
                <div class="h-24 w-24 sm:h-28 sm:w-28 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center">
                    <img data-virtual-image alt="" class="hidden h-full w-full object-cover">
                    <span data-virtual-image-placeholder class="flex flex-col items-center gap-1 text-slate-300">
                        <i data-lucide="image" class="w-7 h-7"></i>
                        <span class="text-[9px] font-bold uppercase">Sin foto</span>
                    </span>
                </div>
                <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                            <h4 class="truncate text-base sm:text-lg font-bold text-slate-900">${escapeCatalogHtml(product.nombre || 'Vaso')}</h4>
                            <p class="mt-0.5 truncate text-[11px] text-slate-500">${escapeCatalogHtml(getVirtualCatalogLocalLabel(product))}</p>
                        </div>
                        <span data-virtual-public-state></span>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-1.5">
                        ${sizes.map(size => `
                            <span class="rounded-lg bg-sky-50 px-2 py-1 text-[10px] font-bold text-sky-700">
                                ${escapeCatalogHtml(size.nombre)} · ${escapeCatalogHtml(formatMoney(size.precio))}
                            </span>
                        `).join('')}
                    </div>
                    <p class="mt-2 text-[11px] leading-relaxed text-slate-500">
                        <strong class="text-slate-700">${escapeCatalogHtml(flavorLimitLabel)}</strong>
                        · ${flavorCount} sabores disponibles · ${toppingCount} toppings disponibles
                    </p>
                </div>
            </div>
        </div>

        <div class="p-3 sm:p-4 space-y-3">
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <label class="min-h-12 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex items-center gap-2 text-xs font-bold text-slate-700">
                    <input data-virtual-field="visible" type="checkbox" class="h-5 w-5 accent-emerald-600" ${settings.visible ? 'checked' : ''}>
                    Publicar
                </label>
                <label class="min-h-12 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex items-center gap-2 text-xs font-bold text-slate-700">
                    <input data-virtual-field="show-price" type="checkbox" class="h-5 w-5 accent-emerald-600" ${settings.mostrarPrecio ? 'checked' : ''}>
                    Mostrar precio
                </label>
                <label class="min-h-12 col-span-2 sm:col-span-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex items-center gap-2 text-xs font-bold text-slate-700">
                    <input data-virtual-field="featured" type="checkbox" class="h-5 w-5 accent-amber-500" ${settings.destacado ? 'checked' : ''}>
                    Destacado
                </label>
            </div>

            <div class="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
                <label class="min-w-0">
                    <span class="block mb-1 text-[10px] font-bold uppercase text-slate-500">Disponibilidad</span>
                    <select data-virtual-field="availability" class="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-emerald-500">
                        <option value="auto" ${settings.disponibilidad === 'auto' ? 'selected' : ''}>Automática por stock</option>
                        <option value="disponible" ${settings.disponibilidad === 'disponible' ? 'selected' : ''}>Disponible</option>
                        <option value="agotado" ${settings.disponibilidad === 'agotado' ? 'selected' : ''}>Agotado</option>
                    </select>
                </label>
                <label>
                    <span class="block mb-1 text-[10px] font-bold uppercase text-slate-500">Orden</span>
                    <input data-virtual-field="order" type="number" min="0" max="9999" value="${settings.orden}" class="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-emerald-500">
                </label>
            </div>

            <label class="block">
                <span class="block mb-1 text-[10px] font-bold uppercase text-slate-500">Nombre para clientes</span>
                <input data-virtual-field="name" type="text" maxlength="80" value="${escapeCatalogHtml(settings.nombrePublico)}" placeholder="${escapeCatalogHtml(product.nombre || 'Nombre del vaso')}" class="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-emerald-500">
            </label>

            <label class="block">
                <span class="flex items-center justify-between gap-2 mb-1 text-[10px] font-bold uppercase text-slate-500">
                    Descripción
                    <span data-virtual-description-count>${settings.descripcion.length}/420</span>
                </span>
                <textarea data-virtual-field="description" maxlength="420" rows="2" placeholder="Ejemplo: incluye hasta 3 sabores y toppings a elección." class="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-emerald-500">${escapeCatalogHtml(settings.descripcion)}</textarea>
            </label>

            <div class="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-2.5">
                <input data-virtual-image-file type="file" accept="image/jpeg,image/png,image/webp" class="hidden">
                <div class="flex items-center gap-2">
                    <button data-virtual-action="choose-image" type="button" class="min-h-10 flex-1 rounded-lg bg-slate-800 hover:bg-slate-700 px-3 text-xs font-bold text-white transition-colors">
                        Elegir foto
                    </button>
                    <button data-virtual-action="remove-image" type="button" class="hidden min-h-10 rounded-lg border border-red-200 bg-white px-3 text-xs font-bold text-red-500">
                        Quitar
                    </button>
                </div>
                <p data-virtual-image-status class="mt-1.5 text-[10px] text-slate-500">La foto se optimiza automáticamente.</p>
            </div>
        </div>

        <div class="px-3 pb-3 sm:px-4 sm:pb-4 flex items-center gap-3">
            <p data-virtual-save-status class="min-w-0 flex-1 truncate text-[11px] text-slate-500">Los cambios solo afectan la carta virtual.</p>
            <button data-virtual-action="save" type="button" class="min-h-11 shrink-0 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-4 text-sm font-bold text-white flex items-center justify-center gap-2 transition-colors">
                <i data-lucide="save" class="w-4 h-4"></i>
                Guardar
            </button>
        </div>
    `;
    updateVirtualCatalogCardBadge(card, product, settings);
    return card;
}

function loadVirtualCatalogCardImage(card, product, openToken) {
    const settings = getCatalogSettings(product);
    const productId = String(product.id);
    const imageState = {
        token: 0,
        previewUrl: '',
        prepared: null,
        removeImage: false,
        existingImageId: settings.imagenId,
        preparing: null
    };
    virtualCatalogImageStates.set(productId, imageState);
    if (!settings.imagenId) return;
    const imageLoadToken = imageState.token;

    setVirtualCatalogImage(card, '', 'Cargando foto guardada…', true);
    void getCatalogImagePreviewUrl(settings.imagenId)
        .then(url => {
            if (
                openToken !== virtualCatalogOpenToken
                || imageState.token !== imageLoadToken
                || virtualCatalogImageStates.get(productId) !== imageState
                || !card.isConnected
            ) {
                if (url) URL.revokeObjectURL(url);
                return;
            }
            if (!url) {
                setVirtualCatalogImage(
                    card,
                    '',
                    'La foto no está disponible, pero puedes reemplazarla o quitarla.',
                    true
                );
                return;
            }
            imageState.previewUrl = url;
            setVirtualCatalogImage(card, url, 'Foto actual del catálogo.');
        })
        .catch(error => {
            console.warn('No se pudo cargar una foto del catálogo:', error);
            if (
                openToken === virtualCatalogOpenToken
                && imageState.token === imageLoadToken
                && card.isConnected
            ) {
                setVirtualCatalogImage(
                    card,
                    '',
                    'No se pudo cargar la foto; puedes reemplazarla o quitarla.',
                    true
                );
            }
        });
}

function renderVirtualCatalogProducts() {
    const container = document.getElementById('catalog-virtual-products-list');
    if (!container) return;
    releaseVirtualCatalogImageStates();
    const openToken = ++virtualCatalogOpenToken;
    const products = state.productos
        .filter(product => normalizeVirtualCatalogValue(product.categoria) === 'vaso')
        .sort((left, right) => {
            const leftSettings = getCatalogSettings(left);
            const rightSettings = getCatalogSettings(right);
            if (leftSettings.orden !== rightSettings.orden) {
                return leftSettings.orden - rightSettings.orden;
            }
            return String(left.nombre || '').localeCompare(
                String(right.nombre || ''),
                'es',
                { sensitivity: 'base' }
            );
        });

    if (products.length === 0) {
        container.innerHTML = `
            <div class="lg:col-span-2 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
                <i data-lucide="cup-soda" class="w-9 h-9 mx-auto text-slate-300"></i>
                <h4 class="mt-3 text-sm font-bold text-slate-800">Todavía no hay vasos</h4>
                <p class="mt-1 text-xs text-slate-500">Primero crea un producto en la categoría Vasos.</p>
            </div>
        `;
        window.lucide?.createIcons({ root: container });
        return;
    }

    const fragment = document.createDocumentFragment();
    products.forEach(product => {
        const card = createVirtualCatalogProductCard(product);
        fragment.appendChild(card);
        loadVirtualCatalogCardImage(card, product, openToken);
    });
    container.replaceChildren(fragment);
    window.lucide?.createIcons({ root: container });
}

function readVirtualCatalogSettings(card, product, imageState) {
    const existing = getCatalogSettings(product);
    const availability = card.querySelector('[data-virtual-field="availability"]')?.value;
    const order = Number(card.querySelector('[data-virtual-field="order"]')?.value);
    return {
        visible: card.querySelector('[data-virtual-field="visible"]')?.checked === true,
        nombrePublico: card.querySelector('[data-virtual-field="name"]')?.value.trim() || '',
        descripcion: card.querySelector('[data-virtual-field="description"]')?.value.trim() || '',
        mostrarPrecio: card.querySelector('[data-virtual-field="show-price"]')?.checked === true,
        disponibilidad: ['auto', 'disponible', 'agotado'].includes(availability)
            ? availability
            : 'auto',
        destacado: card.querySelector('[data-virtual-field="featured"]')?.checked === true,
        orden: Math.max(0, Math.min(9999, Number.isFinite(order) ? Math.trunc(order) : 1000)),
        imagenId: imageState?.prepared
            ? String(product.id)
            : (imageState?.removeImage ? '' : existing.imagenId),
        imagenVersion: imageState?.prepared || imageState?.removeImage
            ? Date.now()
            : existing.imagenVersion
    };
}

function saveVirtualCatalogProduct(card) {
    if (!canManagePublicCatalog() || !card) return;
    const productId = String(card.dataset.catalogVirtualProductId || '');
    const currentProduct = state.productos.find(
        product => String(product.id) === productId
    );
    if (!currentProduct) return;
    const imageState = virtualCatalogImageStates.get(productId);
    if (imageState?.preparing) {
        window.mostrarToast?.(
            'Foto en preparación',
            'Espera un instante antes de guardar.',
            'amber'
        );
        return;
    }

    const settings = readVirtualCatalogSettings(card, currentProduct, imageState);
    const optimisticProduct = {
        ...currentProduct,
        catalogo: settings
    };
    const baseCatalog = confirmedCatalogRows.length > 0
        ? confirmedCatalogRows
        : state.productos;
    confirmedCatalogRows = baseCatalog.map(product => (
        String(product.id) === productId ? optimisticProduct : product
    ));
    state.productos = applyPendingDocumentMutations(
        'productos',
        confirmedCatalogRows
    );
    persistProductsCache(confirmedCatalogRows);
    queueCatalogUiUpdate({ changedIds: [productId] });
    updateVirtualCatalogCardBadge(card, optimisticProduct, settings);

    const saveButton = card.querySelector('[data-virtual-action="save"]');
    const saveStatus = card.querySelector('[data-virtual-save-status]');
    const saveToken = (virtualCatalogSaveTokens.get(productId) || 0) + 1;
    virtualCatalogSaveTokens.set(productId, saveToken);
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.classList.add('opacity-60', 'cursor-wait');
    }
    if (saveStatus) {
        saveStatus.textContent = 'Guardado en este dispositivo · sincronizando…';
        saveStatus.className = 'min-w-0 flex-1 truncate text-[11px] text-emerald-600';
    }
    window.mostrarToast?.(
        'Catálogo actualizado',
        `${currentProduct.nombre} quedó actualizado localmente.`,
        'emerald'
    );

    const imageToSave = imageState?.prepared || null;
    const removeImage = imageState?.removeImage === true;
    runAfterImmediateUiPaint(() => {
        void saveProductAndPublicCatalog({
            productId,
            privateData: { catalogo: settings },
            optimisticProduct,
            isNew: false,
            image: imageToSave,
            removeImage
        })
            .then(() => {
                if (virtualCatalogSaveTokens.get(productId) !== saveToken) return;
                if (imageState) {
                    imageState.prepared = null;
                    imageState.removeImage = false;
                    imageState.existingImageId = settings.imagenId;
                }
                if (saveStatus?.isConnected) {
                    saveStatus.textContent = 'Sincronizado con el catálogo virtual.';
                    saveStatus.className = 'min-w-0 flex-1 truncate text-[11px] text-emerald-600';
                }
            })
            .catch(error => {
                console.error('No se pudo sincronizar el catálogo virtual:', error);
                if (virtualCatalogSaveTokens.get(productId) !== saveToken) return;
                if (saveStatus?.isConnected) {
                    saveStatus.textContent = 'Pendiente de sincronización. Puedes volver a guardar.';
                    saveStatus.className = 'min-w-0 flex-1 truncate text-[11px] text-amber-600';
                }
                window.mostrarAlerta?.(
                    'Sincronización pendiente',
                    'El cambio se guardó localmente, pero Firebase todavía no pudo recibirlo.',
                    'amber'
                );
            })
            .finally(() => {
                if (
                    virtualCatalogSaveTokens.get(productId) === saveToken
                    && saveButton?.isConnected
                ) {
                    saveButton.disabled = false;
                    saveButton.classList.remove('opacity-60', 'cursor-wait');
                }
            });
    });
}

function handleVirtualCatalogImageSelection(input) {
    const card = input.closest('[data-catalog-virtual-product-id]');
    const file = input.files?.[0];
    if (!card || !file) return;
    const productId = String(card.dataset.catalogVirtualProductId || '');
    const imageState = virtualCatalogImageStates.get(productId);
    if (!imageState) return;
    const token = ++imageState.token;
    setVirtualCatalogImage(card, imageState.previewUrl, 'Optimizando la nueva foto…');

    const preparation = prepareCatalogImage(file)
        .then(prepared => {
            if (
                imageState.token !== token
                || virtualCatalogImageStates.get(productId) !== imageState
                || !card.isConnected
            ) {
                URL.revokeObjectURL(prepared.previewUrl);
                return null;
            }
            if (imageState.previewUrl) URL.revokeObjectURL(imageState.previewUrl);
            imageState.previewUrl = prepared.previewUrl;
            imageState.prepared = prepared;
            imageState.removeImage = false;
            setVirtualCatalogImage(
                card,
                prepared.previewUrl,
                `Lista para guardar · ${Math.max(1, Math.round(prepared.size / 1024))} KB`
            );
            return prepared;
        })
        .catch(error => {
            console.error('No se pudo preparar la foto del catálogo virtual:', error);
            if (imageState.token === token && card.isConnected) {
                setVirtualCatalogImage(
                    card,
                    imageState.previewUrl,
                    error?.message || 'La foto no es válida.'
                );
            }
            return null;
        })
        .finally(() => {
            if (imageState.preparing === preparation) imageState.preparing = null;
        });
    imageState.preparing = preparation;
}

function removeVirtualCatalogImage(card) {
    const productId = String(card?.dataset.catalogVirtualProductId || '');
    const imageState = virtualCatalogImageStates.get(productId);
    if (!card || !imageState) return;
    imageState.token++;
    imageState.preparing = null;
    imageState.prepared = null;
    imageState.removeImage = true;
    if (imageState.previewUrl) URL.revokeObjectURL(imageState.previewUrl);
    imageState.previewUrl = '';
    const fileInput = card.querySelector('[data-virtual-image-file]');
    if (fileInput) fileInput.value = '';
    setVirtualCatalogImage(card, '', 'La foto se quitará al guardar.');
}

function switchVirtualCatalogPanel(panelName = 'productos') {
    const showProducts = panelName !== 'sedes';
    document.getElementById('catalog-virtual-panel-productos')
        ?.classList.toggle('hidden', !showProducts);
    document.getElementById('catalog-virtual-panel-sedes')
        ?.classList.toggle('hidden', showProducts);
    const productButton = document.getElementById('btn-catalog-virtual-productos');
    const siteButton = document.getElementById('btn-catalog-virtual-sedes');
    [
        [productButton, showProducts],
        [siteButton, !showProducts]
    ].forEach(([button, active]) => {
        if (!button) return;
        button.classList.toggle('border-emerald-600', active);
        button.classList.toggle('text-emerald-700', active);
        button.classList.toggle('border-transparent', !active);
        button.classList.toggle('text-slate-500', !active);
    });
}

function renderCatalogSites(activeIds = [], { loading = false } = {}) {
    const container = document.getElementById('catalog-sites-list');
    if (!container) return;
    container.replaceChildren();
    const active = new Set(activeIds.map(String));
    const sites = [
        { id: 'general', nombre: 'General', fixed: true },
        ...(state.locales || []).map(local => ({
            id: String(local.id),
            nombre: String(local.nombre || 'Sede'),
            fixed: false
        }))
    ];

    sites.forEach(site => {
        const label = document.createElement('label');
        label.className = 'flex min-h-14 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2';
        const text = document.createElement('span');
        text.className = 'min-w-0';
        const title = document.createElement('span');
        title.className = 'block truncate text-sm font-bold text-slate-700';
        title.textContent = site.nombre;
        const caption = document.createElement('span');
        caption.className = 'block text-[10px] text-slate-400';
        caption.textContent = site.fixed
            ? 'Siempre disponible; muestra todos los productos públicos.'
            : 'Genera una cartilla propia para esta sede.';
        text.append(title, caption);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.catalogSiteId = site.id;
        checkbox.checked = site.fixed || active.has(site.id);
        checkbox.disabled = site.fixed || loading;
        checkbox.className = 'h-5 w-5 shrink-0 accent-emerald-600';
        label.append(text, checkbox);
        container.appendChild(label);
    });
}

function closeVirtualCatalogModal() {
    catalogSitesLoadToken++;
    virtualCatalogOpenToken++;
    catalogQrRenderToken++;
    catalogQrReadyUrl = '';
    setCatalogQrActionsReady(false);
    closeCatalogQrZoom();
    releaseVirtualCatalogImageStates();
    closeModal('modal-config-catalogo-publico', 150);
}

function openVirtualCatalogModal() {
    if (!canManagePublicCatalog()) return;
    const modal = document.getElementById('modal-config-catalogo-publico');
    if (!modal) return;
    const loadToken = ++catalogSitesLoadToken;
    const saveButton = document.getElementById('btn-guardar-config-catalogo');
    switchVirtualCatalogPanel('productos');
    renderVirtualCatalogProducts();
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.setAttribute('aria-busy', 'true');
        saveButton.classList.add('opacity-60', 'cursor-wait');
    }
    const cachedActiveSiteIds = getActiveCatalogSiteIds();
    const qrSiteSelect = document.getElementById('catalog-qr-site-select');
    if (qrSiteSelect) qrSiteSelect.value = 'general';
    renderCatalogSites(cachedActiveSiteIds, { loading: true });
    renderCatalogQrSiteOptions(cachedActiveSiteIds);
    modal.classList.remove('hidden', 'pointer-events-none');
    requestAnimationFrame(() => modal.classList.remove('opacity-0'));
    void loadCatalogSiteSettings(state.locales || [], { force: true })
        .then(activeIds => {
            if (loadToken !== catalogSitesLoadToken) return;
            renderCatalogSites(activeIds);
            renderCatalogQrSiteOptions(activeIds);
        })
        .catch(error => {
            console.warn('No se pudieron actualizar las sedes:', error);
            if (loadToken === catalogSitesLoadToken) {
                const fallbackIds = getActiveCatalogSiteIds();
                renderCatalogSites(fallbackIds);
                renderCatalogQrSiteOptions(fallbackIds);
            }
        })
        .finally(() => {
            if (loadToken !== catalogSitesLoadToken || !saveButton) return;
            saveButton.disabled = false;
            saveButton.removeAttribute('aria-busy');
            saveButton.classList.remove('opacity-60', 'cursor-wait');
        });
    runAfterImmediateUiPaint(() => {
        void ensurePublicCatalogPublished({
            products: state.productos,
            locales: state.locales || []
        }).catch(error => {
            console.warn('La publicación automática del catálogo sigue pendiente:', error);
        });
    });
}

function saveCatalogSitesFromModal() {
    if (!canManagePublicCatalog()) return;
    const saveButton = document.getElementById('btn-guardar-config-catalogo');
    if (saveButton?.disabled) return;
    catalogSitesLoadToken++;
    const activeIds = Array.from(
        document.querySelectorAll('[data-catalog-site-id]:checked')
    ).map(input => input.dataset.catalogSiteId);
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.classList.add('opacity-60', 'cursor-wait');
    }
    window.mostrarToast?.(
        'Sedes actualizadas',
        'La configuración quedó aplicada y se sincroniza en segundo plano.',
        'emerald'
    );
    runAfterImmediateUiPaint(() => {
        void saveCatalogSiteSettings({
            activeIds,
            products: state.productos
        })
            .then(savedIds => {
                renderCatalogSites(savedIds);
                renderCatalogQrSiteOptions(savedIds);
            })
            .catch(error => {
                console.error('No se pudieron sincronizar las sedes públicas:', error);
                const confirmedIds = getActiveCatalogSiteIds();
                renderCatalogSites(confirmedIds);
                renderCatalogQrSiteOptions(confirmedIds);
                window.mostrarAlerta?.(
                    'Sincronización pendiente',
                    'No se pudo publicar toda la configuración. Vuelve a intentarlo cuando tengas conexión.',
                    'amber'
                );
            })
            .finally(() => {
                if (!saveButton?.isConnected) return;
                saveButton.disabled = false;
                saveButton.classList.remove('opacity-60', 'cursor-wait');
            });
    });
}

function isViewVisible(viewName) {
    const view = document.getElementById(`view-${viewName}`);
    return Boolean(view && !view.classList.contains('hidden'));
}

function catalogsHaveSameData(previousRows, nextRows) {
    if (previousRows.length !== nextRows.length) return false;
    const previousById = new Map(
        previousRows.map(product => [product.id, product])
    );
    return nextRows.every(product => {
        const previous = previousById.get(product.id);
        return previous && JSON.stringify(previous) === JSON.stringify(product);
    });
}

function applyPendingCatalogProjection({ full = true, changedIds = [] } = {}) {
    const previousProducts = state.productos;
    const nextProducts = applyPendingDocumentMutations(
        'productos',
        confirmedCatalogRows
    );
    if (catalogsHaveSameData(previousProducts, nextProducts)) return;
    state.productos = nextProducts;
    if (full) queueCatalogUiUpdate({ full: true });
    else queueCatalogUiUpdate({ changedIds });
}

function installInventorySyncQueueListener() {
    if (inventorySyncQueueListenerInstalled) return;
    inventorySyncQueueListenerInstalled = true;
    window.addEventListener('icepos:sync-queue-changed', event => {
        if (!inventarioInicializado) return;
        const affectedCollections = event.detail?.affectedCollections;
        if (
            Array.isArray(affectedCollections)
            && !affectedCollections.includes('productos')
            && !affectedCollections.includes('control_vasos_diario')
        ) return;
        if (
            !Array.isArray(affectedCollections)
            || affectedCollections.includes('productos')
        ) {
            if (confirmedCatalogRows.length === 0 && state.productos.length > 0) {
                confirmedCatalogRows = state.productos.map(product => ({ ...product }));
            }
            applyPendingCatalogProjection({ full: true });
        } else if (categoriaActual === 'insumo') {
            renderCupControlSummary();
            renderInventarioUI(categoriaActual);
        }
    });
}

function installInventoryVisibilityObserver() {
    if (inventoryViewObserver) return;
    const view = document.getElementById('view-inventario');
    if (!view) return;

    inventoryViewObserver = new MutationObserver(() => {
        if (isViewVisible('inventario') && inventoryRenderPending) {
            renderInventarioUI(categoriaActual);
        }
    });
    inventoryViewObserver.observe(view, {
        attributes: true,
        attributeFilter: ['class']
    });
}

function getCupDependentProductIds(changedIds = []) {
    const cupIds = new Set(
        changedIds.filter(id => {
            const product = state.productos.find(item => item.id === id);
            return isCupInventoryProduct(product);
        })
    );
    if (cupIds.size === 0) return [];

    return state.productos
        .filter(product => (
            String(product.categoria || '').toLowerCase() === 'vaso'
            && (Array.isArray(product.tamanos) ? product.tamanos : [])
                .some(size => (
                    Array.isArray(size?.consumoVaso?.asignaciones)
                    && size.consumoVaso.asignaciones.some(assignment => (
                        cupIds.has(String(assignment?.insumoId || ''))
                    ))
                ))
        ))
        .map(product => product.id);
}

function queueCatalogUiUpdate({ full = false, changedIds = [] } = {}) {
    if (full) pendingCatalogFullRender = true;
    changedIds.forEach(id => pendingCatalogChangeIds.add(id));
    if (inventoryRenderFrame !== null) return;

    inventoryRenderFrame = requestAnimationFrame(() => {
        inventoryRenderFrame = null;
        const renderFull = pendingCatalogFullRender;
        const ids = Array.from(pendingCatalogChangeIds);
        pendingCatalogFullRender = false;
        pendingCatalogChangeIds.clear();

        if (renderFull) {
            renderInventarioUI(categoriaActual);
            renderProductosVenta();
            return;
        }

        applyInventoryChanges(ids);
        applyProductosVentaChanges([
            ...new Set([
                ...ids,
                ...getCupDependentProductIds(ids)
            ])
        ]);
    });
}

function runAfterImmediateUiPaint(callback) {
    let started = false;
    const run = () => {
        if (started) return;
        started = true;
        callback();
    };
    if (
        typeof requestAnimationFrame === 'function'
        && document.visibilityState !== 'hidden'
    ) {
        const fallback = setTimeout(run, 50);
        requestAnimationFrame(() => {
            if (started) return;
            clearTimeout(fallback);
            setTimeout(run, 0);
        });
        return;
    }
    setTimeout(run, 0);
}

function scheduleCupControlDateCheck() {
    if (cupControlDateCheckTimer !== null) {
        clearTimeout(cupControlDateCheckTimer);
    }
    cupControlDateCheckTimer = setTimeout(() => {
        cupControlDateCheckTimer = null;
        if (!inventarioInicializado) return;
        if (getTodayDateStr() !== cupControlSubscribedDate) {
            subscribeDailyCupControl();
        }
        scheduleCupControlDateCheck();
    }, 60_000);
}

function handleCupControlVisibilityChange() {
    if (
        document.visibilityState === 'visible'
        && getTodayDateStr() !== cupControlSubscribedDate
    ) {
        subscribeDailyCupControl();
    }
}

function subscribeDailyCupControl() {
    unsubscribeCupControl?.();
    unsubscribeCupControl = null;
    confirmedCupControlRows = [];
    cupControlSubscribedDate = getTodayDateStr();

    const dailyQuery = query(
        collection(db, 'control_vasos_diario'),
        where('fechaStr', '==', cupControlSubscribedDate)
    );
    unsubscribeCupControl = onSnapshot(
        dailyQuery,
        snapshot => {
            confirmedCupControlRows = snapshot.docs.map(row => ({
                id: row.id,
                ...row.data()
            }));
            if (categoriaActual === 'insumo') {
                renderCupControlSummary();
                renderInventarioUI(categoriaActual);
            }
        },
        error => {
            console.warn('No se pudo cargar el control diario de vasos:', error);
            confirmedCupControlRows = [];
            renderCupControlSummary();
        }
    );
}

export async function initInventario() {
    installInventorySyncQueueListener();
    if (canManagePublicCatalog()) {
        // Actualiza la caché de sedes sin retrasar la apertura del inventario.
        // Así el primer producto editado en un dispositivo nuevo se publica
        // en todas las sedes que ya estaban activas.
        void loadCatalogSiteSettings().catch(error => {
            console.warn('No se pudo precargar la configuración pública:', error);
        });
    }
    if (confirmedCatalogRows.length === 0 && state.productos.length > 0) {
        confirmedCatalogRows = state.productos.map(product => ({ ...product }));
    }
    // Prevenir duplicación de eventos al rotar turnos
    if (inventarioInicializado) {
        applyPendingCatalogProjection({ full: true });
        subscribeDailyCupControl();
        updateInventoryModeUi();
        await window.cargarInventarioDesdeFirebase?.();
        return;
    }
    inventarioInicializado = true;

    listaInventarioEl = document.getElementById('inventario-list');
    installInventoryVisibilityObserver();
    applyPendingCatalogProjection({ full: true });
    subscribeDailyCupControl();
    scheduleCupControlDateCheck();
    document.addEventListener(
        'visibilitychange',
        handleCupControlVisibilityChange
    );
    window.addEventListener('pageshow', handleCupControlVisibilityChange);
    updateInventoryModeUi();
    
    // Eventos Inventario Normal
    document.getElementById('form-insumo')?.addEventListener('submit', guardarProducto);
    document.getElementById('btn-nuevo-producto')?.addEventListener('click', abrirModalProducto);
    document.getElementById('btn-cerrar-modal-producto')?.addEventListener('click', () => {
        catalogEditorToken++;
        releaseCatalogImagePreview();
        closeModal('modal-producto', 300);
    });
    document.getElementById('btn-config-catalogo-publico')
        ?.addEventListener('click', openVirtualCatalogModal);
    document.getElementById('btn-catalog-qr-rapido')
        ?.addEventListener('click', openCatalogQuickQrModal);
    document.getElementById('btn-cerrar-catalog-qr-rapido')
        ?.addEventListener('click', closeCatalogQuickQrModal);
    document.getElementById('btn-descargar-catalog-qr-rapido')
        ?.addEventListener('click', () => void downloadCatalogQuickQr());
    document.getElementById('btn-compartir-catalog-qr-rapido')
        ?.addEventListener('click', () => void shareCatalogQuickQr());
    document.getElementById('modal-catalog-qr-rapido')
        ?.addEventListener('click', event => {
            if (event.target === event.currentTarget) closeCatalogQuickQrModal();
        });
    document.getElementById('btn-cerrar-config-catalogo')
        ?.addEventListener('click', closeVirtualCatalogModal);
    document.getElementById('btn-catalog-virtual-productos')
        ?.addEventListener('click', () => switchVirtualCatalogPanel('productos'));
    document.getElementById('btn-catalog-virtual-sedes')
        ?.addEventListener('click', () => switchVirtualCatalogPanel('sedes'));
    document.getElementById('btn-guardar-config-catalogo')
        ?.addEventListener('click', saveCatalogSitesFromModal);
    document.getElementById('catalog-qr-site-select')
        ?.addEventListener('change', () => void renderSelectedCatalogQr());
    document.getElementById('btn-catalog-qr-ampliar')
        ?.addEventListener('click', openCatalogQrZoom);
    document.getElementById('btn-catalog-qr-preview')
        ?.addEventListener('click', openCatalogQrZoom);
    document.getElementById('btn-catalog-qr-abrir')
        ?.addEventListener('click', openSelectedCatalogLink);
    document.getElementById('btn-catalog-qr-copiar')
        ?.addEventListener('click', () => void copySelectedCatalogLink());
    document.getElementById('btn-catalog-qr-descargar')
        ?.addEventListener('click', downloadSelectedCatalogQr);
    document.getElementById('btn-catalog-qr-descargar-zoom')
        ?.addEventListener('click', downloadSelectedCatalogQr);
    document.getElementById('btn-catalog-qr-cerrar-zoom')
        ?.addEventListener('click', closeCatalogQrZoom);
    document.getElementById('catalog-qr-zoom')
        ?.addEventListener('click', event => {
            if (event.target === event.currentTarget) closeCatalogQrZoom();
        });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        closeCatalogQuickQrModal();
        closeCatalogQrZoom();
    });
    const virtualProductsList = document.getElementById('catalog-virtual-products-list');
    virtualProductsList?.addEventListener('click', event => {
        const actionButton = event.target.closest('[data-virtual-action]');
        const card = actionButton?.closest('[data-catalog-virtual-product-id]');
        if (!actionButton || !card) return;
        const action = actionButton.dataset.virtualAction;
        if (action === 'save') saveVirtualCatalogProduct(card);
        if (action === 'choose-image') {
            card.querySelector('[data-virtual-image-file]')?.click();
        }
        if (action === 'remove-image') removeVirtualCatalogImage(card);
    });
    virtualProductsList?.addEventListener('change', event => {
        if (event.target.matches('[data-virtual-image-file]')) {
            handleVirtualCatalogImageSelection(event.target);
        }
    });
    virtualProductsList?.addEventListener('input', event => {
        if (!event.target.matches('[data-virtual-field="description"]')) return;
        const card = event.target.closest('[data-catalog-virtual-product-id]');
        const counter = card?.querySelector('[data-virtual-description-count]');
        if (counter) counter.textContent = `${event.target.value.length}/420`;
    });

    const prewarmCatalogQuickQr = () => {
        void renderCatalogQuickQr();
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
        globalThis.requestIdleCallback(prewarmCatalogQuickQr, { timeout: 1500 });
    } else {
        setTimeout(prewarmCatalogQuickQr, 400);
    }
    document.getElementById('catalog-description')
        ?.addEventListener('input', updateCatalogDescriptionCount);
    document.getElementById('btn-catalog-image-select')
        ?.addEventListener('click', () => document.getElementById('catalog-image-file')?.click());
    document.getElementById('catalog-image-file')
        ?.addEventListener('change', handleCatalogImageSelection);
    document.getElementById('btn-catalog-image-remove')
        ?.addEventListener('click', removeCatalogEditorImage);
    
    // Eventos Nuevos: Gestión dinámica de tamaños
    document.getElementById('btn-add-tamano')?.addEventListener('click', () => {
        tamanosActuales.push({
            nombre: 'Tamaño ' + (tamanosActuales.length + 1),
            precio: 0,
            ...(categoriaActual === 'vaso'
                ? {
                    consumoVaso: {
                        unidades: 1,
                        asignaciones: []
                    }
                }
                : {})
        });
        renderTamanosBuilder();
    });
    document.getElementById('prod-local')?.addEventListener('change', () => {
        if (categoriaActual === 'vaso') renderTamanosBuilder();
    });
    
    // Tabs de Categorías (Adaptado para 5 categorías: Vasos, Sabores, Extras, Toppings, Insumos)
    const tabs = document.querySelectorAll('#tabs-insumos > div > button');
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => {
                t.classList.remove(
                    'text-sky-400',
                    'text-amber-400',
                    'text-amber-500',
                    'border-sky-400',
                    'border-amber-400',
                    'border-amber-500',
                    'border-b-2'
                );
                if(!t.classList.contains('text-slate-500')) t.classList.add('text-slate-500');
            });
            
            const cats = ['vaso', 'sabor', 'extra', 'topping', 'insumo'];
            categoriaActual = cats[index] || 'vaso';
            
            // Estilo visual: Insumos resalta en ámbar, el resto en sky
            tab.classList.remove('text-slate-500');
            tab.classList.add(
                ...(categoriaActual === 'insumo'
                    ? ['text-amber-500', 'border-amber-400']
                    : ['text-sky-400', 'border-sky-400']),
                'border-b-2'
            );
            
            updateInventoryModeUi();
            renderInventarioUI(categoriaActual);
        });
    });

    // --- Eventos Ingreso de Mercadería (Stock) ---
    document.getElementById('btn-ingreso-stock')?.addEventListener('click', () => abrirModalIngresoStock());
    document.getElementById('btn-cerrar-modal-ingreso')?.addEventListener('click', () => {
        const m = document.getElementById('modal-ingreso-stock'); m.classList.add('opacity-0', 'pointer-events-none'); setTimeout(() => m.classList.add('hidden'), 300);
    });
    document.getElementById('form-ingreso-stock')?.addEventListener('submit', procesarIngresoStock);

    // Funciones globales expuestas
    window.cargarInventarioDesdeFirebase = () => {
        return new Promise((resolve, reject) => {
            cancelInventoryLoad?.();
            const loadToken = ++inventoryLoadToken;
            state.inventoryFresh = false;
            unsubscribeInventario.forEach(unsubscribe => unsubscribe());
            unsubscribeInventario = [];
            let finished = false;
            const finish = (error = null) => {
                if (finished) return;
                finished = true;
                if (cancelInventoryLoad === cancel) cancelInventoryLoad = null;
                if (error) reject(error);
                else resolve();
            };
            const cancel = () => finish();
            cancelInventoryLoad = cancel;

            try {
                const role = String(state.userRole || '').toLowerCase();
                const isAdmin = ['admin', 'administrador', 'master'].includes(role);
                const localId = state.userLocalId || '';
                const scopedLocalIds = Array.from(new Set(['global', localId]))
                    .filter(Boolean);
                const refs = (isAdmin || !localId)
                    ? [collection(db, 'productos')]
                    : [
                        query(
                            collection(db, 'productos'),
                            scopedLocalIds.length === 1
                                ? where('localId', '==', scopedLocalIds[0])
                                : where('localId', 'in', scopedLocalIds)
                        )
                    ];
                const includeLegacyProducts = !isAdmin && Boolean(localId);
                // Cada consulta conserva su propio mapa. Firestore entrega la carga
                // inicial como cambios "added" y, desde allí, solo aplicamos los
                // documentos que realmente cambiaron. El listener legacy se
                // mantiene intacto para no exigir una migración de datos.
                const buckets = new Map();
                const initialSources = new Set();
                const freshSources = new Set();
                const expectedInitialSources = refs.length + (includeLegacyProducts ? 1 : 0);
                const mergedProducts = new Map(
                    confirmedCatalogRows.map(product => [product.id, product])
                );
                let settled = false;
                let initialCatalogPublished = false;

                const scheduleAutomaticPublicCatalog = () => {
                    if (
                        !canManagePublicCatalog()
                        || !initialCatalogPublished
                        || freshSources.size !== expectedInitialSources
                    ) return;
                    const products = Array.from(mergedProducts.values());
                    runAfterImmediateUiPaint(() => {
                        void ensurePublicCatalogPublished({
                            products,
                            locales: state.locales || []
                        }).catch(error => {
                            console.warn(
                                'La publicación automática del catálogo quedó pendiente:',
                                error
                            );
                        });
                    });
                };

                const publishFullCatalog = () => {
                    if (loadToken !== inventoryLoadToken) return;
                    const previousProducts = state.productos;
                    mergedProducts.clear();
                    buckets.forEach(products => {
                        products.forEach((product, id) => {
                            mergedProducts.set(id, product);
                        });
                    });
                    const baseProducts = Array.from(mergedProducts.values());
                    confirmedCatalogRows = baseProducts;
                    const nextProducts = applyPendingDocumentMutations(
                        'productos',
                        baseProducts
                    );
                    const catalogChanged = !catalogsHaveSameData(
                        previousProducts,
                        nextProducts
                    );
                    state.productos = nextProducts;
                    persistProductsCache(baseProducts);
                    if (catalogChanged) queueCatalogUiUpdate({ full: true });
                };

                const publishCatalogChanges = changedIds => {
                    if (
                        loadToken !== inventoryLoadToken
                        || !initialCatalogPublished
                        || changedIds.size === 0
                    ) return;

                    changedIds.forEach(id => {
                        let product = null;
                        buckets.forEach(products => {
                            if (products.has(id)) product = products.get(id);
                        });
                        if (product) mergedProducts.set(id, product);
                        else mergedProducts.delete(id);
                    });

                    const baseProducts = Array.from(mergedProducts.values());
                    confirmedCatalogRows = baseProducts;
                    state.productos = applyPendingDocumentMutations(
                        'productos',
                        baseProducts
                    );
                    persistProductsCache(baseProducts);
                    queueCatalogUiUpdate({ changedIds });
                };

                const updateFreshState = () => {
                    if (loadToken !== inventoryLoadToken) return;
                    const isFresh = freshSources.size === expectedInitialSources;
                    if (state.inventoryFresh === isFresh) return;
                    state.inventoryFresh = isFresh;
                    window.dispatchEvent(new CustomEvent('icepos:inventory-freshness', {
                        detail: { fresh: isFresh }
                    }));
                };

                const markInitialSource = (source, isFresh) => {
                    if (loadToken !== inventoryLoadToken) return false;
                    initialSources.add(source);
                    if (isFresh) freshSources.add(source);
                    else freshSources.delete(source);
                    updateFreshState();
                    if (!settled && initialSources.size === expectedInitialSources) {
                        settled = true;
                        finish();
                    }
                    const allInitialSourcesReady =
                        initialSources.size === expectedInitialSources;
                    if (allInitialSourcesReady && !initialCatalogPublished) {
                        initialCatalogPublished = true;
                        publishFullCatalog();
                    }
                    return allInitialSourcesReady;
                };

                refs.forEach((ref, index) => {
                    const sourceKey = `listener:${index}`;
                    buckets.set(sourceKey, new Map());
                    const unsubscribe = onSnapshot(ref, {
                        includeMetadataChanges: true
                    }, snapshot => {
                        if (loadToken !== inventoryLoadToken) return;
                        const sourceProducts = buckets.get(sourceKey);
                        const changedIds = new Set();
                        const removedIds = [];
                        snapshot.docChanges().forEach(change => {
                            const id = change.doc.id;
                            changedIds.add(id);
                            if (change.type === 'removed') {
                                sourceProducts.delete(id);
                                removedIds.push(id);
                            } else {
                                sourceProducts.set(id, {
                                    id,
                                    ...change.doc.data()
                                });
                            }
                        });
                        const catalogWasPublished = initialCatalogPublished;
                        markInitialSource(
                            sourceKey,
                            snapshot.metadata.fromCache === false
                            && snapshot.metadata.hasPendingWrites === false
                        );
                        if (catalogWasPublished) {
                            publishCatalogChanges(changedIds);
                            if (canManagePublicCatalog()) {
                                removedIds.forEach(productId => {
                                    void deletePublicCatalogProduct(productId)
                                        .catch(error => {
                                            console.warn(
                                                'No se retiró una proyección pública eliminada:',
                                                error
                                            );
                                    });
                                });
                            }
                        }
                        scheduleAutomaticPublicCatalog();
                    }, error => {
                        if (loadToken !== inventoryLoadToken) return;
                        console.error("Error escuchando inventario:", error);
                        freshSources.delete(sourceKey);
                        updateFreshState();
                        if (!settled) {
                            settled = true;
                            finish(error);
                        }
                    });
                    unsubscribeInventario.push(unsubscribe);
                });

                if (includeLegacyProducts) {
                    const sourceKey = 'legacy';
                    buckets.set(sourceKey, new Map());
                    const unsubscribeLegacy = onSnapshot(collection(db, 'productos'), {
                        includeMetadataChanges: true
                    }, snapshot => {
                        if (loadToken !== inventoryLoadToken) return;
                        const sourceProducts = buckets.get(sourceKey);
                        const changedIds = new Set();
                        snapshot.docChanges().forEach(change => {
                            const id = change.doc.id;
                            const wasLegacyProduct = sourceProducts.has(id);
                            const product = {
                                id,
                                ...change.doc.data()
                            };
                            const belongsToLegacySource =
                                change.type !== 'removed' && !product.localId;

                            if (belongsToLegacySource) {
                                sourceProducts.set(id, product);
                                changedIds.add(id);
                            } else if (wasLegacyProduct) {
                                sourceProducts.delete(id);
                                changedIds.add(id);
                            }
                        });
                        const catalogWasPublished = initialCatalogPublished;
                        markInitialSource(
                            sourceKey,
                            snapshot.metadata.fromCache === false
                            && snapshot.metadata.hasPendingWrites === false
                        );
                        if (catalogWasPublished) {
                            publishCatalogChanges(changedIds);
                        }
                    }, error => {
                        if (loadToken !== inventoryLoadToken) return;
                        console.warn('No se pudieron recuperar productos antiguos sin sede:', error);
                        markInitialSource(sourceKey, false);
                    });
                    unsubscribeInventario.push(unsubscribeLegacy);
                }
            } catch(e) { 
                console.error("Error configurando inventario:", e); 
                finish(e);
            }
        });
    };
    
    window.editarProducto = editarProductoFn;
    window.eliminarProducto = eliminarProductoFn;
    window.abrirIngresoStockVaso = id => abrirModalIngresoStock(id);
    window.reactivarVaso = id => setCupActiveState(id, true);
    window.updateTamano = (idx, field, val) => {
        if (field === 'precio') tamanosActuales[idx][field] = parseFloat(val) || 0;
        else tamanosActuales[idx][field] = val;
    };
    window.updateCupUnits = (idx, value) => {
        const size = tamanosActuales[idx];
        if (!size) return;
        const units = Math.max(1, Math.trunc(Number(value) || 1));
        size.consumoVaso = {
            ...(size.consumoVaso || {}),
            unidades: units,
            asignaciones: Array.isArray(size.consumoVaso?.asignaciones)
                ? size.consumoVaso.asignaciones
                : []
        };
    };
    window.updateCupAssignment = (idx, localId, insumoId) => {
        const size = tamanosActuales[idx];
        if (!size) return;
        const assignments = Array.isArray(size.consumoVaso?.asignaciones)
            ? size.consumoVaso.asignaciones.filter(item => (
                String(item?.localId || '') !== String(localId || '')
            ))
            : [];
        if (insumoId) {
            assignments.push({
                localId: String(localId || 'global'),
                insumoId: String(insumoId)
            });
        }
        size.consumoVaso = {
            ...(size.consumoVaso || {}),
            unidades: Math.max(
                1,
                Math.trunc(Number(size.consumoVaso?.unidades) || 1)
            ),
            asignaciones: assignments
        };
    };
    window.removeTamano = (idx) => {
        tamanosActuales.splice(idx, 1);
        renderTamanosBuilder();
    };

    await window.cargarInventarioDesdeFirebase();
}

export function destroyInventario() {
    inventoryLoadToken++;
    state.inventoryFresh = false;
    inventoryRenderPending = true;
    pendingCatalogFullRender = false;
    pendingCatalogChangeIds.clear();
    if (inventoryRenderFrame !== null) {
        cancelAnimationFrame(inventoryRenderFrame);
        inventoryRenderFrame = null;
    }
    cancelInventoryLoad?.();
    cancelInventoryLoad = null;
    unsubscribeInventario.forEach(unsubscribe => unsubscribe());
    unsubscribeInventario = [];
    unsubscribeCupControl?.();
    unsubscribeCupControl = null;
    cupControlSubscribedDate = '';
    if (cupControlDateCheckTimer !== null) {
        clearTimeout(cupControlDateCheckTimer);
        cupControlDateCheckTimer = null;
    }
    document.removeEventListener(
        'visibilitychange',
        handleCupControlVisibilityChange
    );
    window.removeEventListener('pageshow', handleCupControlVisibilityChange);
    confirmedCupControlRows = [];
    confirmedCatalogRows = [];
}

// ========================================================
// RENDERIZADOR DINÁMICO DE TAMAÑOS (UI)
// ========================================================
function getCupAssignmentTargets() {
    const role = String(state.userRole || '').trim().toLowerCase();
    const canManageAllSites = [
        'admin',
        'administrador',
        'master'
    ].includes(role);
    if (!canManageAllSites && state.userLocalId) {
        return [{
            id: String(state.userLocalId),
            nombre: String(state.userLocal || 'Mi sede')
        }];
    }

    const selectedLocal = String(
        document.getElementById('prod-local')?.value || 'global'
    );
    if (!['global', 'general', ''].includes(selectedLocal)) {
        return [{
            id: selectedLocal,
            nombre: state.locales.find(local => local.id === selectedLocal)?.nombre
                || 'Sede asignada'
        }];
    }
    if (state.locales.length === 0) {
        return [{ id: 'global', nombre: 'Todas las sedes' }];
    }
    return state.locales.map(local => ({
        id: String(local.id),
        nombre: String(local.nombre || 'Sede')
    }));
}

function getCupOptionsForTarget(targetLocalId, selectedCupId = '') {
    const options = getVisibleCupInventoryItems({ includeArchived: false })
        .filter(cup => {
            const cupLocalId = String(cup.localId || 'global');
            if (targetLocalId === 'global') {
                return ['global', 'general', ''].includes(cupLocalId);
            }
            return (
                ['global', 'general', ''].includes(cupLocalId)
                || cupLocalId === String(targetLocalId)
            );
        });
    const selectedProduct = state.productos.find(product => (
        String(product.id) === String(selectedCupId)
    ));
    if (
        selectedProduct
        && isCupInventoryProduct(selectedProduct)
        && !options.some(product => product.id === selectedProduct.id)
    ) {
        options.push(selectedProduct);
    }
    return options;
}

function getSizeCupAssignment(size, targetLocalId) {
    const assignments = Array.isArray(size?.consumoVaso?.asignaciones)
        ? size.consumoVaso.asignaciones
        : [];
    return assignments.find(item => (
        String(item?.localId || '') === String(targetLocalId || '')
    )) || (
        targetLocalId !== 'global'
            ? assignments.find(item => (
                ['global', 'general', ''].includes(String(item?.localId || ''))
            ))
            : null
    );
}

function renderCupAssignmentsForSize(size, sizeIndex) {
    if (categoriaActual !== 'vaso') return '';
    const targets = getCupAssignmentTargets();
    const units = Math.max(
        1,
        Math.trunc(Number(size?.consumoVaso?.unidades) || 1)
    );
    const rows = targets.map(target => {
        const selected = getSizeCupAssignment(size, target.id);
        const cupOptions = getCupOptionsForTarget(
            target.id,
            selected?.insumoId || ''
        );
        const optionHtml = cupOptions.map(cup => {
            const cupLocal = String(cup.localId || 'global');
            const scope = ['global', 'general', ''].includes(cupLocal)
                ? 'Global'
                : (
                    state.locales.find(local => local.id === cupLocal)?.nombre
                    || 'Sede'
                );
            const archived = cup.activo === false ? ' · archivado' : '';
            return `<option value="${escapeCatalogHtml(cup.id)}" ${String(selected?.insumoId || '') === String(cup.id) ? 'selected' : ''}>${escapeCatalogHtml(cup.nombre)} · stock ${Number(cup.stock || 0)} · ${escapeCatalogHtml(scope)}${archived}</option>`;
        }).join('');
        return `
            <label class="cup-assignment-row">
                <span>${escapeCatalogHtml(target.nombre)}</span>
                <select data-cup-assignment data-size-index="${sizeIndex}" data-local-id="${escapeCatalogHtml(target.id)}" class="w-full min-w-0 bg-white border border-amber-200 rounded-lg px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-amber-500">
                    <option value="">Selecciona un vaso</option>
                    ${optionHtml}
                </select>
            </label>`;
    }).join('');

    return `
        <div class="cup-size-config mt-2 rounded-lg border border-amber-200 bg-amber-50/80 p-2.5">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <div>
                    <p class="text-[10px] font-black uppercase text-amber-700">Vaso físico utilizado</p>
                    <p class="text-[10px] text-slate-500">Se descuenta al confirmar y se devuelve al anular.</p>
                </div>
                <label class="flex items-center gap-2 text-[10px] font-bold text-slate-600 shrink-0">
                    Vasos por venta
                    <input type="number" min="1" max="20" value="${units}" onchange="window.updateCupUnits(${sizeIndex}, this.value)" class="w-16 bg-white border border-amber-200 rounded-lg px-2 py-1.5 text-center text-xs text-slate-800 outline-none">
                </label>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${rows}</div>
        </div>`;
}

function renderTamanosBuilder() {
    const container = document.getElementById('lista-tamanos');
    if (!container) return;
    
    if (tamanosActuales.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-500 italic text-center p-2">Sin precios. Agrega un tamaño.</p>`;
        return;
    }
    
    container.innerHTML = tamanosActuales.map((t, idx) => `
        <div class="w-full animate-fade-in rounded-lg border border-slate-700 bg-white/50 p-2">
            <div class="flex items-center gap-2 w-full">
                <input type="text" value="${escapeCatalogHtml(t.nombre)}" onchange="window.updateTamano(${idx}, 'nombre', this.value)" class="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-white focus:border-sky-500 outline-none" placeholder="Ej. Mediano (12oz)" required>
                <div class="relative w-24 shrink-0">
                    <span class="absolute left-2 top-1/2 transform -translate-y-1/2 text-slate-500 text-xs">S/</span>
                    <input type="number" step="0.1" min="0" value="${Number(t.precio || 0)}" onchange="window.updateTamano(${idx}, 'precio', this.value)" class="w-full bg-slate-900 border border-slate-700 rounded pl-6 pr-2 py-1.5 text-xs text-white text-right focus:border-sky-500 outline-none" placeholder="0.00" required>
                </div>
                <button type="button" onclick="window.removeTamano(${idx})" class="text-red-400 hover:text-white hover:bg-red-500/20 p-1.5 bg-slate-900 border border-slate-700 rounded transition-colors shrink-0" title="Eliminar Tamaño"><i data-lucide="trash" class="w-4 h-4"></i></button>
            </div>
            ${renderCupAssignmentsForSize(t, idx)}
        </div>
    `).join('');
    container.querySelectorAll('[data-cup-assignment]').forEach(select => {
        select.addEventListener('change', event => {
            const input = event.currentTarget;
            window.updateCupAssignment(
                Number(input.dataset.sizeIndex),
                input.dataset.localId || 'global',
                input.value
            );
        });
    });
    if(window.lucide) window.lucide.createIcons({ root: container });
}


// ========================================================
// LÓGICA DE INGRESO DE STOCK (COMPRAS)
// ========================================================

function abrirModalIngresoStock(preselectedProductId = '') {
    const m = document.getElementById('modal-ingreso-stock');
    if (!m) return;
    
    document.getElementById('form-ingreso-stock').reset();
    
    const selProd = document.getElementById('ingreso-producto');
    const selLocal = document.getElementById('ingreso-local');
    
    let prodOpts = '<option value="" disabled selected>Selecciona un producto...</option>';
    const productosValidos = state.productos.filter(p => {
        if (p.stock === null || p.stock === undefined) return false;
        if (p.activo === false) return false;
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return productBelongsToLocal(p, state.userLocalId);
    }).sort((left, right) => (
        Number(isCupInventoryProduct(right))
        - Number(isCupInventoryProduct(left))
        || String(left.nombre || '').localeCompare(String(right.nombre || ''), 'es')
    ));
    
    productosValidos.forEach(p => {
        const sede = p.localId && p.localId !== 'global' ? `(${state.locales.find(l=>l.id===p.localId)?.nombre || 'Local'})` : '(Global)';
        const cupLabel = isCupInventoryProduct(p) ? 'Vaso · ' : '';
        prodOpts += `<option value="${escapeCatalogHtml(p.id)}">${cupLabel}${escapeCatalogHtml(p.nombre)} - Stock actual: ${Number(p.stock)} ${escapeCatalogHtml(sede)}</option>`;
    });
    selProd.innerHTML = prodOpts || '<option value="" disabled>No hay productos que administren stock</option>';
    if (preselectedProductId && productosValidos.some(product => (
        String(product.id) === String(preselectedProductId)
    ))) {
        selProd.value = String(preselectedProductId);
    }
    
    if (selLocal) {
        if (state.userRole === 'admin' || state.userRole === 'master') {
            let locOpts = '<option value="ambas">Dividir Gasto en Todas las Sedes</option>';
            state.locales.forEach(l => locOpts += `<option value="${l.id}">Caja: ${l.nombre}</option>`);
            selLocal.innerHTML = locOpts;
            selLocal.parentElement.classList.remove('hidden');
        } else {
            selLocal.innerHTML = `<option value="${state.userLocalId || ''}">${state.userLocal || 'Mi Local'}</option>`;
            selLocal.parentElement.classList.add('hidden'); 
        }
    }

    const preselectedProduct = state.productos.find(product => (
        String(product.id) === String(preselectedProductId)
    ));
    if (
        selLocal
        && preselectedProduct?.localId
        && preselectedProduct.localId !== 'global'
        && Array.from(selLocal.options).some(option => (
            option.value === preselectedProduct.localId
        ))
    ) {
        selLocal.value = preselectedProduct.localId;
    }

    m.classList.remove('hidden', 'pointer-events-none'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
}

function procesarIngresoStock(e) {
    e.preventDefault();

    const prodId = document.getElementById('ingreso-producto').value;
    const cant = parseInt(document.getElementById('ingreso-cantidad').value);
    const costo = parseFloat(document.getElementById('ingreso-costo').value);

    if (!prodId || isNaN(cant) || cant <= 0 || isNaN(costo) || costo < 0) {
        if(window.mostrarToast) window.mostrarToast('Error', 'Verifica los datos ingresados.', 'amber');
        return;
    }

    try {
        const prod = state.productos.find(p => p.id === prodId);
        if (!prod) {
            throw new Error('El producto ya no está disponible.');
        }

        const date = getTodayDateStr();
        let allocations = [];
        if (costo > 0) {
            const selectedLocal = document.getElementById('ingreso-local')?.value || '';

            if (state.userRole !== 'master' && state.userRole !== 'admin') {
                allocations = [{
                    id: state.userLocalId || 'general',
                    nombre: state.userLocal || 'Mi Local'
                }];
            } else if (selectedLocal === 'ambas') {
                allocations = state.locales.length > 0
                    ? state.locales.map(local => ({ id: local.id, nombre: local.nombre }))
                    : [{ id: 'general', nombre: 'General' }];
            } else {
                const local = state.locales.find(item => item.id === selectedLocal);
                allocations = [{
                    id: selectedLocal || 'general',
                    nombre: local?.nombre || 'General'
                }];
            }

            const totalCents = Math.round(costo * 100);
            const baseCents = Math.floor(totalCents / allocations.length);
            const remainder = totalCents % allocations.length;
            allocations = allocations.map((allocation, index) => {
                const amount = (baseCents + (index < remainder ? 1 : 0)) / 100;
                return {
                    id: createUuid('G-'),
                    monto: amount,
                    descripcion: `Stock: Ingreso de ${cant}x ${prod.nombre}`,
                    fechaStr: date,
                    fechaHora: getTrustedNowMs(),
                    localId: allocation.id,
                    localNombre: allocation.nombre,
                    registradoPor: state.currentUser?.email || '',
                    tipo: 'compra_stock'
                };
            });
        }

        const queued = queueStockEntry({
            operationId: createUuid('OP-'),
            productId: prod.id,
            quantity: cant,
            expenses: allocations,
            cupControlDate: isCupInventoryProduct(prod) ? date : '',
            localNombre: state.locales.find(local => local.id === prod.localId)?.nombre
                || state.userLocal
                || ''
        });

        const m = document.getElementById('modal-ingreso-stock'); 
        m.classList.add('opacity-0', 'pointer-events-none'); 
        setTimeout(() => m.classList.add('hidden'), 300);
        window.mostrarToast?.(
            'Ingreso guardado',
            `+${cant} a ${prod.nombre}; sincronizando en segundo plano.`,
            'emerald'
        );
        void queued.persisted.catch(err => {
            console.error('No se pudo conservar el ingreso de stock:', err);
            window.mostrarAlerta?.(
                'Ingreso no guardado',
                'El dispositivo no pudo conservar esta operación. Inténtalo nuevamente.',
                'red'
            );
        });
        
    } catch(err) {
        console.error("Error al procesar ingreso:", err);
        window.mostrarAlerta?.(
            'Ingreso no registrado',
            err?.message || 'No se pudo confirmar el stock y el gasto.',
            'red'
        );
    }
}

// ========================================================
// LÓGICA DEL INVENTARIO NORMAL
// ========================================================

function configureProductModalForCategory() {
    const isCupInventory = categoriaActual === 'insumo';
    const isSellableCup = categoriaActual === 'vaso';
    const isEditingCup = Boolean(
        isCupInventory
        && document.getElementById('prod-id')?.value
    );
    const title = document.getElementById('modal-producto-titulo');
    const sizes = document.getElementById('div-tamanos-producto');
    const costs = document.getElementById('div-campos-costos');
    const flavorLimit = document.getElementById('div-limite-sabores');
    const publicCatalog = document.getElementById('div-catalogo-publico');
    const cupInfo = document.getElementById('div-insumo-vaso-info');
    const stock = document.getElementById('prod-stock');
    const stockLabel = document.getElementById('prod-stock-label');

    if (title) {
        title.innerHTML = isCupInventory
            ? '<i data-lucide="cup-soda" class="w-5 h-5 text-amber-500"></i> Vaso de inventario'
            : '<i data-lucide="package" class="w-5 h-5 text-emerald-400"></i> Ítem del Catálogo';
    }
    sizes?.classList.toggle('hidden', isCupInventory);
    costs?.classList.remove('hidden');
    flavorLimit?.classList.toggle('hidden', !isSellableCup);
    cupInfo?.classList.toggle('hidden', !isCupInventory);
    if (isCupInventory) publicCatalog?.classList.add('hidden');
    if (stock) {
        stock.required = isCupInventory;
        stock.placeholder = isCupInventory ? 'Ej. 250' : 'Infinito';
        stock.min = '0';
        stock.step = '1';
        stock.readOnly = isEditingCup;
        stock.title = isEditingCup
            ? 'Para cambiar esta cantidad usa el botón + Stock.'
            : '';
    }
    if (stockLabel) {
        stockLabel.textContent = isEditingCup
            ? 'Stock actual (usa + Stock)'
            : (isCupInventory
                ? 'Cantidad actual de vasos'
                : 'Stock inicial');
    }
    window.lucide?.createIcons({ root: title?.parentElement || undefined });
}

function abrirModalProducto() {
    document.getElementById('form-insumo').reset(); 
    document.getElementById('prod-id').value = '';
    resetCatalogEditor();
    
    // Configuración base de Tamaños (1 por defecto)
    tamanosActuales = [{
        nombre: categoriaActual === 'insumo' ? 'Unidad' : 'Único / Estándar',
        precio: 0,
        ...(categoriaActual === 'vaso'
            ? { consumoVaso: { unidades: 1, asignaciones: [] } }
            : {})
    }];
    
    const selLocal = document.getElementById('prod-local');
    if (selLocal && state.locales) {
        let opts = '<option value="global">Disponible en Todas (Global)</option>';
        state.locales.forEach(l => opts += `<option value="${l.id}">${l.nombre}</option>`);
        selLocal.innerHTML = opts;
        
        if (state.userRole === 'vendedor') {
            selLocal.value = state.userLocalId || 'global';
            selLocal.disabled = true;
            selLocal.parentElement.classList.add('hidden'); 
        } else {
            selLocal.disabled = false;
            selLocal.parentElement.classList.remove('hidden');
            if (
                categoriaActual === 'insumo'
                && state.userLocalId
                && state.locales.some(local => local.id === state.userLocalId)
            ) {
                selLocal.value = state.userLocalId;
            }
        }
    }

    if (categoriaActual !== 'vaso') {
        document.getElementById('prod-limite').value = 0; 
    }
    configureProductModalForCategory();
    renderTamanosBuilder();
    
    const m = document.getElementById('modal-producto'); 
    m.classList.remove('hidden', 'pointer-events-none'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
}

function editarProductoFn(id) {
    const p = state.productos.find(x => x.id === id); if(!p) return;
    categoriaActual = p.categoria || categoriaActual;
    abrirModalProducto();
    document.getElementById('prod-id').value = p.id;
    resetCatalogEditor(p);
    configureProductModalForCategory();
    
    document.getElementById('prod-nombre').value = p.nombre;
    document.getElementById('prod-costo').value = p.costo || 0;
    document.getElementById('prod-stock').value = p.stock !== null && p.stock !== undefined ? p.stock : '';
    document.getElementById('prod-local').value = p.localId || 'global';
    if (p.categoria === 'vaso') document.getElementById('prod-limite').value = p.limite_sabores || 0;
    
    // Cargar tamaños múltiples (o adaptar compatibilidad antigua)
    if (p.tamanos && p.tamanos.length > 0) {
        tamanosActuales = JSON.parse(JSON.stringify(p.tamanos));
    } else {
        tamanosActuales = [{
            nombre: isCupInventoryProduct(p) ? 'Unidad' : 'Único / Estándar',
            precio: isCupInventoryProduct(p) ? 0 : (p.precio || 0)
        }];
    }
    renderTamanosBuilder();
}

function getInventoryItems(cat) {
    return state.productos.filter(p => {
        if (p.categoria !== cat) return false;
        if (cat === 'insumo' && !isCupInventoryProduct(p)) return false;
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
    });
}

function getInventoryEmptyRowHtml() {
    const message = categoriaActual === 'insumo'
        ? 'Todavía no hay vasos físicos. Pulsa “Nuevo vaso” para iniciar el control.'
        : 'No hay ítems registrados en esta categoría.';
    return `<tr data-empty-state="true"><td colspan="5" class="p-8 text-center text-slate-500 text-sm">${message}</td></tr>`;
}

function createInventoryRow(p) {
    const isCupInventory = isCupInventoryProduct(p);
    const isArchivedCup = isCupInventory && p.activo === false;
    const cupDay = isCupInventory ? getCupDayNumbers(p) : null;
    const stkStr = p.stock !== null && p.stock !== '' && p.stock !== undefined
        ? `<span class="font-mono ${Number(p.stock) <= 0 ? 'text-red-500' : 'text-emerald-500'} font-bold">${Number(p.stock)}</span>`
        : '<i data-lucide="infinity" class="w-4 h-4 mx-auto text-slate-500"></i>';

    let badgeLocal = '';
    if (p.localId && p.localId !== 'global') {
        const nLoc = state.locales.find(l => l.id === p.localId)?.nombre || 'Sede';
        badgeLocal = `<span class="ml-2 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 text-[9px] px-1.5 py-0.5 rounded uppercase border border-slate-200 dark:border-slate-600">${nLoc}</span>`;
    } else if (state.userRole === 'master' || state.userRole === 'admin') {
        badgeLocal = '<span class="ml-2 bg-sky-50 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 border border-sky-200 dark:border-sky-500/30 text-[9px] px-1.5 py-0.5 rounded uppercase">Global</span>';
    }

    let priceStr = isCupInventory
        ? '<span class="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700">Vaso físico</span>'
        : '-';
    if (!isCupInventory && p.categoria !== 'sabor') {
        if (p.tamanos && p.tamanos.length > 1) {
            const precios = p.tamanos.map(t => t.precio);
            const min = Math.min(...precios);
            const max = Math.max(...precios);
            priceStr = min === max
                ? formatMoney(min)
                : `<span class="text-xs text-slate-400">Desde</span> ${formatMoney(min)}`;
        } else if (p.tamanos && p.tamanos.length === 1) {
            priceStr = formatMoney(p.tamanos[0].precio);
        } else {
            priceStr = formatMoney(p.precio || 0);
        }
    }

    const vHist = p.ventasTotales || 0;
    const ventasHtml = isCupInventory
        ? `
            <div class="text-[10px] leading-tight text-slate-500">
                <b class="block text-slate-800 text-xs">Inicio ${cupDay.start}</b>
                <span class="text-emerald-600">+${cupDay.entries}</span>
                <span class="mx-1">/</span>
                <span class="text-amber-600">-${cupDay.used}</span>
            </div>`
        : (
            vHist > 0
                ? `<div class="flex items-center justify-center text-emerald-500 font-bold text-xs"><i data-lucide="trending-up" class="w-3 h-3 mr-1"></i> ${vHist}</div>`
                : '<div class="text-slate-500 text-xs text-center">-</div>'
        );
    const archivedBadge = isArchivedCup
        ? '<span class="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[9px] uppercase text-slate-600">Archivado</span>'
        : '';
    const stockAction = isCupInventory && !isArchivedCup
        ? `<button onclick="window.abrirIngresoStockVaso('${p.id}')" class="min-h-11 min-w-11 px-2 flex items-center justify-center gap-1 text-emerald-500 bg-white dark:bg-slate-900 border border-emerald-200 hover:border-emerald-500 p-1.5 rounded-lg transition-colors" aria-label="Añadir stock a ${escapeCatalogHtml(p.nombre)}" title="Añadir stock"><i data-lucide="package-plus" class="w-4 h-4"></i><span class="sm:hidden text-[9px] font-bold">+ Stock</span></button>`
        : '';
    const archiveAction = isArchivedCup
        ? `<button onclick="window.reactivarVaso('${p.id}')" class="min-h-11 min-w-11 flex items-center justify-center text-emerald-500 bg-white dark:bg-slate-900 border border-emerald-200 hover:border-emerald-500 p-1.5 rounded-lg transition-colors" aria-label="Reactivar vaso"><i data-lucide="archive-restore" class="w-4 h-4"></i></button>`
        : `<button onclick="window.eliminarProducto('${p.id}')" class="min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-red-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-500/50 p-1.5 rounded-lg transition-colors" aria-label="${isCupInventory ? 'Archivar vaso' : 'Eliminar producto'}"><i data-lucide="${isCupInventory ? 'archive' : 'trash'}" class="w-4 h-4"></i></button>`;

    const tr = document.createElement('tr');
    tr.dataset.productId = p.id;
    tr.className = `hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group border-b border-slate-200 dark:border-slate-700/50 last:border-0 ${isArchivedCup ? 'opacity-60' : ''}`;
    tr.innerHTML = `
        <td data-label="Producto" class="p-3 text-sm text-slate-800 dark:text-white font-bold">${escapeCatalogHtml(p.nombre)} ${badgeLocal}${archivedBadge}</td>
        <td data-label="${isCupInventory ? 'Hoy' : 'Ventas'}" class="p-3 text-center">${ventasHtml}</td>
        <td data-label="${isCupInventory ? 'Tipo' : 'Precio'}" class="p-3 text-sm text-sky-600 dark:text-sky-500 font-bold text-right">${priceStr}</td>
        <td data-label="${isCupInventory ? 'Actual' : 'Stock'}" class="p-3 text-center">${stkStr}</td>
        <td data-label="Acciones" class="p-3 text-center">
            <div class="flex justify-center gap-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                ${stockAction}
                <button onclick="window.editarProducto('${p.id}')" class="min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-sky-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-sky-300 dark:hover:border-sky-500/50 p-1.5 rounded-lg transition-colors" aria-label="Editar producto"><i data-lucide="edit-2" class="w-4 h-4"></i></button>
                ${archiveAction}
            </div>
        </td>`;
    return tr;
}

function applyInventoryChanges(changedIds) {
    if (!listaInventarioEl || changedIds.length === 0) return;
    if (!isViewVisible('inventario')) {
        inventoryRenderPending = true;
        return;
    }

    const visibleProducts = new Map(
        getInventoryItems(categoriaActual).map(product => [product.id, product])
    );
    const existingRows = new Map(
        Array.from(listaInventarioEl.querySelectorAll('tr[data-product-id]'))
            .map(row => [row.dataset.productId, row])
    );
    const iconRoots = [];

    changedIds.forEach(id => {
        const currentRow = existingRows.get(id);
        const product = visibleProducts.get(id);
        if (!product) {
            currentRow?.remove();
            return;
        }

        const nextRow = createInventoryRow(product);
        if (currentRow) currentRow.replaceWith(nextRow);
        else listaInventarioEl.appendChild(nextRow);
        iconRoots.push(nextRow);
    });

    const productRows = listaInventarioEl.querySelectorAll('tr[data-product-id]');
    const emptyRow = listaInventarioEl.querySelector('tr[data-empty-state]');
    if (productRows.length === 0) {
        listaInventarioEl.innerHTML = getInventoryEmptyRowHtml();
    } else {
        emptyRow?.remove();
    }

    iconRoots.forEach(root => window.lucide?.createIcons({ root }));
    renderCupControlSummary();
    inventoryRenderPending = false;
}

export function renderInventarioUI(cat) {
    if (!listaInventarioEl) return;
    if (!isViewVisible('inventario')) {
        inventoryRenderPending = true;
        return;
    }

    const items = getInventoryItems(cat);
    if (items.length === 0) {
        listaInventarioEl.innerHTML = getInventoryEmptyRowHtml();
        renderCupControlSummary();
        inventoryRenderPending = false;
        return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(product => fragment.appendChild(createInventoryRow(product)));
    listaInventarioEl.replaceChildren(fragment);
    window.lucide?.createIcons({ root: listaInventarioEl });
    renderCupControlSummary();
    inventoryRenderPending = false;
}

function normalizeSizesForSave(selectedLocal, baseProduct = null) {
    if (categoriaActual === 'insumo') {
        return [{ nombre: 'Unidad', precio: 0 }];
    }

    const role = String(state.userRole || '').trim().toLowerCase();
    const canManageAllSites = [
        'admin',
        'administrador',
        'master'
    ].includes(role);
    const cupInventoryExists = getVisibleCupInventoryItems({
        includeArchived: false
    }).length > 0;

    return tamanosActuales.map((size, sizeIndex) => {
        const normalized = {
            ...size,
            nombre: String(size.nombre || '').trim(),
            precio: Math.max(0, Number(size.precio || 0))
        };
        if (categoriaActual !== 'vaso') {
            delete normalized.consumoVaso;
            delete normalized.vasoInsumoId;
            delete normalized.vasosPorUnidad;
            return normalized;
        }

        const units = Math.max(
            1,
            Math.trunc(Number(size.consumoVaso?.unidades) || 1)
        );
        const allowedTargets = new Set(
            getCupAssignmentTargets().map(target => String(target.id))
        );
        // Una asignación global es un fallback válido para sedes actuales y
        // futuras. Se conserva aunque luego se creen nuevas sedes.
        allowedTargets.add('global');
        const deduplicated = new Map();
        const currentAssignments = Array.isArray(size.consumoVaso?.asignaciones)
            ? size.consumoVaso.asignaciones
            : [];
        const baseAssignments = Array.isArray(
            baseProduct?.tamanos?.[sizeIndex]?.consumoVaso?.asignaciones
        )
            ? baseProduct.tamanos[sizeIndex].consumoVaso.asignaciones
            : [];

        // Un vendedor solo modifica la asociación de su sede. Las asociaciones
        // de las demás sedes se copian desde el documento que abrió.
        if (!canManageAllSites) {
            baseAssignments.forEach(assignment => {
                const localId = String(assignment?.localId || 'global');
                const cupId = String(assignment?.insumoId || '');
                if (!cupId || allowedTargets.has(localId)) return;
                deduplicated.set(localId, { localId, insumoId: cupId });
            });
        }

        currentAssignments.forEach(assignment => {
                const localId = String(assignment?.localId || 'global');
                const cupId = String(assignment?.insumoId || '');
                if (!cupId || !allowedTargets.has(localId)) return;
                deduplicated.set(localId, { localId, insumoId: cupId });
            });

        const assignments = [...deduplicated.values()];
        const globalFallback = assignments.find(assignment => (
            ['global', 'general', ''].includes(assignment.localId)
        ));
        const missingTargets = getCupAssignmentTargets().filter(target => (
            !globalFallback
            && !assignments.some(assignment => (
                assignment.localId === String(target.id)
            ))
        ));
        if (cupInventoryExists && missingTargets.length > 0) {
            throw new Error(
                `Asigna un vaso a "${normalized.nombre || 'un tamaño'}" para: ${
                    missingTargets.map(target => target.nombre).join(', ')
                }.`
            );
        }
        assignments.forEach(assignment => {
            if (
                !canManageAllSites
                && !allowedTargets.has(assignment.localId)
            ) {
                return;
            }
            const cup = state.productos.find(product => (
                String(product.id) === assignment.insumoId
            ));
            const cupLocalId = String(cup?.localId || 'global');
            const locationIsCompatible = (
                ['global', 'general', ''].includes(cupLocalId)
                || cupLocalId === assignment.localId
            );
            if (
                !cup
                || !isCupInventoryProduct(cup)
                || cup.activo === false
                || !Number.isInteger(Number(cup.stock))
                || Number(cup.stock) < 0
                || !locationIsCompatible
            ) {
                throw new Error(
                    `El vaso asignado a "${normalized.nombre || 'un tamaño'}" no está disponible para esa sede.`
                );
            }
        });

        normalized.consumoVaso = {
            unidades: units,
            asignaciones: assignments
        };
        delete normalized.vasoInsumoId;
        delete normalized.vasosPorUnidad;
        return normalized;
    });
}

function guardarProducto(e) {
    e.preventDefault(); 
    
    // Validar tamaños
    if (categoriaActual !== 'insumo' && tamanosActuales.length === 0) {
        if(window.mostrarToast) window.mostrarToast('Error', 'Debes añadir al menos un tamaño y precio.', 'amber');
        return;
    }
    if (catalogImagePreparation && !preparedCatalogImage) {
        window.mostrarToast?.(
            'Imagen en preparación',
            'Espera un instante a que termine de optimizarse.',
            'amber'
        );
        return;
    }

    const id = document.getElementById('prod-id').value;
    let selectedLocal = document.getElementById('prod-local').value;
    if (state.userRole === 'vendedor') selectedLocal = state.userLocalId || 'global';

    // Recuperar ventasTotales actuales para no borrarlas al guardar
    let ventasTotalesGuardadas = 0;
    let prodExistente = null;
    let productoBase = null;
    if (id) {
        prodExistente = state.productos.find(x => x.id === id);
        productoBase = confirmedCatalogRows.find(x => x.id === id) || prodExistente;
        if (productoBase) ventasTotalesGuardadas = productoBase.ventasTotales || 0;
    }

    const stockInput = document.getElementById('prod-stock').value;
    let editedStock = stockInput !== '' ? parseInt(stockInput) : null;
    if (
        categoriaActual === 'insumo'
        && (
            !Number.isInteger(editedStock)
            || editedStock < 0
        )
    ) {
        window.mostrarToast?.(
            'Cantidad inválida',
            'Indica cuántos vasos hay actualmente con un número entero mayor o igual a cero.',
            'amber'
        );
        return;
    }
    if (
        prodExistente?.sincronizacionPendiente
        && productoBase
        && Number(editedStock) === Number(prodExistente.stock)
    ) {
        editedStock = productoBase.stock;
    }

    let sizesToSave;
    try {
        sizesToSave = normalizeSizesForSave(
            selectedLocal,
            productoBase || prodExistente
        );
    } catch (error) {
        window.mostrarToast?.(
            'Revisa el vaso asignado',
            error?.message || 'Hay una asignación de vaso inválida.',
            'amber'
        );
        return;
    }

    const isCupInventory = categoriaActual === 'insumo';
    const prodData = {
        nombre: document.getElementById('prod-nombre').value.trim(),
        categoria: categoriaActual,
        tamanos: sizesToSave,
        precio: isCupInventory ? 0 : (sizesToSave[0]?.precio || 0),
        costo: parseFloat(document.getElementById('prod-costo').value) || 0,
        limite_sabores: isCupInventory
            ? 0
            : (parseInt(document.getElementById('prod-limite').value) || 0),
        stock: editedStock,
        localId: selectedLocal,
        ventasTotales: ventasTotalesGuardadas,
        ...(isCupInventory
            ? {
                tipoInsumo: 'vaso',
                esVasoInventario: true,
                unidad: 'unidad',
                activo: productoBase?.activo !== false
            }
            : {})
    };
    if (id) {
        // Estos campos cambian con transacciones de venta/reposición. Una
        // edición de nombre o configuración no debe sobrescribirlos con el
        // valor que el modal leyó unos segundos antes.
        delete prodData.ventasTotales;
        if (isCupInventory) delete prodData.stock;
    }

    try {
        const productRef = id
            ? doc(db, 'productos', id)
            : doc(collection(db, 'productos'));
        const productId = productRef.id;
        const imageToSave = preparedCatalogImage;
        const shouldRemoveImage = catalogImageRemoved;
        const catalogo = isCupInventory
            ? {
                ...getCatalogSettings(productoBase || prodExistente || {}),
                visible: false,
                mostrarPrecio: false,
                destacado: false
            }
            : readCatalogEditorSettings(
                productId,
                productoBase || prodExistente
            );
        if (catalogo !== undefined) prodData.catalogo = catalogo;
        const optimisticProduct = {
            ...(productoBase || prodExistente || {}),
            id: productId,
            ...prodData
        };

        const baseCatalog = confirmedCatalogRows.length > 0
            ? confirmedCatalogRows
            : state.productos;
        if (id) {
            confirmedCatalogRows = baseCatalog.map(product => (
                product.id === id ? optimisticProduct : product
            ));
        } else {
            confirmedCatalogRows = [...baseCatalog, optimisticProduct];
        }
        state.productos = applyPendingDocumentMutations(
            'productos',
            confirmedCatalogRows
        );
        persistProductsCache(confirmedCatalogRows);
        queueCatalogUiUpdate({ changedIds: [productId] });
        catalogEditorToken++;
        releaseCatalogImagePreview();
        closeModal('modal-producto', 0);
        window.mostrarToast?.(
            'Catálogo actualizado',
            'El cambio quedó guardado localmente y está sincronizándose.',
            'emerald'
        );

        runAfterImmediateUiPaint(() => {
            const cloudWrite = saveProductAndPublicCatalog({
                productId,
                privateData: prodData,
                optimisticProduct,
                isNew: !id,
                image: imageToSave,
                removeImage: shouldRemoveImage
            });
            void cloudWrite
                .then(() => {
                    if (canManagePublicCatalog()) return;
                    return syncPublicAvailability([{
                        id: optimisticProduct.id,
                        localId: optimisticProduct.localId,
                        stock: optimisticProduct.stock,
                        disponible: resolvePublicAvailability(optimisticProduct)
                    }], {
                        localId: optimisticProduct.localId || state.userLocalId || ''
                    });
                })
                .catch(error => {
                    console.error('No se pudo sincronizar el producto:', error);
                    window.mostrarAlerta?.(
                        'Cambio no sincronizado',
                        'Firebase rechazó el producto. La lista volverá al último valor confirmado.',
                        'red'
                    );
                });
        });
    } catch(e) {
        console.error(e);
        window.mostrarAlerta?.(
            'Error',
            'No se pudo guardar el producto en este dispositivo.',
            'red'
        );
    }
}

function eliminarProductoFn(id) {
    const product = state.productos.find(item => item.id === id);
    if (isCupInventoryProduct(product)) {
        window.mostrarConfirmacion?.(
            '¿Archivar este vaso? Seguirá existiendo para devolver inventario de ventas antiguas, pero ya no podrá asignarse a nuevas ventas.',
            () => setCupActiveState(id, false)
        );
        return;
    }
    if(window.mostrarConfirmacion) {
        window.mostrarConfirmacion("¿Eliminar definitivamente este ítem del catálogo?", () => {
            // LÓGICA OPTIMISTA
            try {
                const deletedProduct = state.productos.find(p => p.id === id);
                const baseCatalog = confirmedCatalogRows.length > 0
                    ? confirmedCatalogRows
                    : state.productos;
                confirmedCatalogRows = baseCatalog.filter(p => p.id !== id);
                state.productos = applyPendingDocumentMutations(
                    'productos',
                    confirmedCatalogRows
                );
                persistProductsCache(confirmedCatalogRows);
                queueCatalogUiUpdate({ changedIds: [id] });
                window.mostrarToast?.(
                    'Eliminado',
                    'Producto borrado de la lista.',
                    'sky'
                );

                runAfterImmediateUiPaint(() => {
                    const manager = canManagePublicCatalog();
                    void deleteProductAndPublicCatalog(id)
                        .then(() => {
                            if (manager || !deletedProduct) return;
                            // El vendedor conserva su libertad operativa, pero no
                            // deja el ítem apareciendo como disponible al público.
                            return syncPublicAvailability([{
                                id,
                                localId: deletedProduct.localId,
                                stock: 0,
                                disponible: false
                            }], {
                                localId: deletedProduct.localId || state.userLocalId || ''
                            });
                        })
                        .catch(e => {
                            console.error("Error al borrar en background:", e);
                            window.cargarInventarioDesdeFirebase();
                            if(window.mostrarToast) window.mostrarToast('Error', 'No se pudo eliminar en la nube.', 'red');
                        });
                });
            } catch(e) {
                console.error(e);
            }
        });
    }
}

function setCupActiveState(id, active) {
    const current = state.productos.find(product => product.id === id);
    if (!isCupInventoryProduct(current)) return;
    const catalogo = {
        ...getCatalogSettings(current),
        visible: false,
        mostrarPrecio: false,
        destacado: false
    };
    const optimisticProduct = {
        ...current,
        activo: active,
        catalogo
    };
    const baseCatalog = confirmedCatalogRows.length > 0
        ? confirmedCatalogRows
        : state.productos;
    confirmedCatalogRows = baseCatalog.map(product => (
        product.id === id ? optimisticProduct : product
    ));
    state.productos = applyPendingDocumentMutations(
        'productos',
        confirmedCatalogRows
    );
    persistProductsCache(confirmedCatalogRows);
    queueCatalogUiUpdate({ changedIds: [id] });
    window.mostrarToast?.(
        active ? 'Vaso reactivado' : 'Vaso archivado',
        active
            ? 'Ya puede volver a asignarse a los tamaños.'
            : 'Se conserva para mantener correctas las devoluciones.',
        active ? 'emerald' : 'amber'
    );

    runAfterImmediateUiPaint(() => {
        void saveProductAndPublicCatalog({
            productId: id,
            privateData: {
                activo: active,
                catalogo
            },
            optimisticProduct,
            isNew: false
        }).catch(error => {
            console.error('No se pudo cambiar el estado del vaso:', error);
            window.cargarInventarioDesdeFirebase?.();
            window.mostrarToast?.(
                'Cambio no sincronizado',
                'Se recuperará el último estado confirmado.',
                'red'
            );
        });
    });
}
