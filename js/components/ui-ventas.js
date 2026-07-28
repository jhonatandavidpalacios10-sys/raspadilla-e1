import {
    state,
    clearCart,
    replaceCart,
    setPendingSaleAttempt
} from '../core/store.js';
import { formatMoney, getTodayDateStr, getTrustedNowMs } from '../utils/helpers.js';
import {
    createSaleDraftScope,
    deleteSaleDraft,
    loadSaleDraft,
    saveSaleDraft
} from '../core/sale-draft-store.js';
import {
    SalesIntegrityError,
    acquireSaleEditLock,
    buildInventoryMovements,
    createUuid,
    releaseSaleEditLock,
    roundMoney,
    saveSaleTransaction
} from '../core/sales-service.js';

let vasoActual = null; 
let saboresElegidos = [];
let toppingsElegidos = []; // NUEVO: Estado para toppings
let tamanoElegido = null;  // NUEVO: Estado para tamaño
let ventasInicializado = false;
let ventaEnProceso = false;
let ventasSessionGeneration = 0;
let cobroButtonDefaultHtml = '';
let liberacionEdicionEnProceso = false;
let editBannerExpiryTimer = null;
let editLockHeartbeatTimer = null;
let editLockHeartbeatPromise = null;
let editLockHeartbeatWarningShown = false;
let activeSaleDraftScope = null;
let saleDraftWriteTimer = null;
let saleDraftHydrationGeneration = 0;
let saleDraftPersistenceSuspended = true;
let saleDraftStorageWarningShown = false;

const SALE_DRAFT_WRITE_DELAY_MS = 120;
const MAX_RESTORED_CART_ITEMS = 200;
const EDIT_LOCK_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
const EDIT_LOCK_HEARTBEAT_RETRY_MS = 30 * 1000;
const EDIT_LOCK_RENEWAL_MARGIN_MS = 2 * 60 * 1000;

function clonePlainValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function isSafeIdentifier(value, maxLength = 256) {
    const normalized = String(value || '').trim();
    return normalized.length > 0 && normalized.length <= maxLength;
}

function sanitizeRestoredCart(items) {
    if (!Array.isArray(items) || items.length > MAX_RESTORED_CART_ITEMS) return null;

    const restored = clonePlainValue(items);
    const valid = restored.every(item => {
        const quantity = Number(item?.cantidad);
        const price = Number(item?.precio);
        const cost = Number(item?.costo || 0);
        return (
            item
            && typeof item === 'object'
            && isSafeIdentifier(item.cartId)
            && isSafeIdentifier(item.productoId)
            && typeof item.nombre === 'string'
            && item.nombre.length <= 300
            && Number.isInteger(quantity)
            && quantity > 0
            && quantity <= 999
            && Number.isFinite(price)
            && Math.abs(price) <= 1_000_000
            && Number.isFinite(cost)
            && cost >= 0
            && cost <= 1_000_000
            && (!item.sabores || (Array.isArray(item.sabores) && item.sabores.length <= 100))
            && (!item.saboresDetalle || (
                Array.isArray(item.saboresDetalle)
                && item.saboresDetalle.length <= 100
            ))
            && (!item.toppings || (Array.isArray(item.toppings) && item.toppings.length <= 100))
        );
    });

    return valid ? restored : null;
}

function sanitizeRestoredAttempt(attempt) {
    if (!attempt) return null;
    const status = String(attempt.status || 'prepared').toLowerCase();
    if (
        !isSafeIdentifier(attempt.fingerprint, 500_000)
        || !isSafeIdentifier(attempt.saleId)
        || !isSafeIdentifier(attempt.operationId)
        || !['prepared', 'submitting', 'failed'].includes(status)
    ) {
        return null;
    }

    return {
        fingerprint: String(attempt.fingerprint),
        saleId: String(attempt.saleId),
        operationId: String(attempt.operationId),
        status,
        updatedAt: Number(attempt.updatedAt) || Date.now(),
        lastErrorCode: String(attempt.lastErrorCode || '').slice(0, 120)
    };
}

function sanitizeRestoredEditContext(editContext, scope) {
    if (!editContext) return null;

    const expectedRevision = Number(editContext.expectedRevision || 0);
    const localPendingEdit = editContext.localPendingEdit === true;
    if (
        !isSafeIdentifier(editContext.saleId)
        || !Number.isInteger(expectedRevision)
        || expectedRevision <= 0
    ) {
        return null;
    }

    const common = {
        saleId: String(editContext.saleId),
        expectedRevision,
        legacyInventoryMovements: Array.isArray(editContext.legacyInventoryMovements)
            ? clonePlainValue(editContext.legacyInventoryMovements)
            : [],
        previousInventoryMovements: Array.isArray(editContext.previousInventoryMovements)
            ? clonePlainValue(editContext.previousInventoryMovements)
            : [],
        localId: String(editContext.localId || scope.localId || 'general'),
        localNombre: String(editContext.localNombre || 'Sin Local')
    };

    if (localPendingEdit) {
        if (!isSafeIdentifier(editContext.sourceOperationId)) return null;
        return {
            ...common,
            localPendingEdit: true,
            sourceOperationId: String(editContext.sourceOperationId),
            lockToken: '',
            lockOwnerId: scope.uid,
            lockOwnerName: String(editContext.lockOwnerName || 'Usuario'),
            lockExpiresAtMs: 0
        };
    }

    const lockExpiresAtMs = Number(editContext.lockExpiresAtMs || 0);
    if (
        !isSafeIdentifier(editContext.lockToken)
        || !isSafeIdentifier(editContext.lockOwnerId)
        || String(editContext.lockOwnerId) !== scope.uid
        || !Number.isFinite(lockExpiresAtMs)
        || lockExpiresAtMs <= 0
    ) {
        return null;
    }

    return {
        ...common,
        localPendingEdit: false,
        sourceOperationId: '',
        lockToken: String(editContext.lockToken),
        lockOwnerId: String(editContext.lockOwnerId),
        lockOwnerName: String(editContext.lockOwnerName || 'Usuario'),
        lockExpiresAtMs
    };
}

function getPaymentDraft() {
    return {
        method: String(
            document.querySelector('input[name="metodo_pago"]:checked')?.value
            || 'efectivo'
        ),
        cashReceived: document.getElementById('input-paga-con')?.value || '',
        mixedCash: document.getElementById('input-mixto-efectivo')?.value || '',
        mixedDigital: document.getElementById('input-mixto-yape')?.value || '',
        clientName: document.getElementById('input-cliente-nombre')?.value || ''
    };
}

function restorePaymentDraft(payment) {
    if (!payment || typeof payment !== 'object') return;
    const method = ['efectivo', 'yape', 'mixto'].includes(payment.method)
        ? payment.method
        : 'efectivo';
    const radio = document.querySelector(
        `input[name="metodo_pago"][value="${method}"]`
    );
    if (radio) radio.checked = true;

    const values = {
        'input-paga-con': payment.cashReceived,
        'input-mixto-efectivo': payment.mixedCash,
        'input-mixto-yape': payment.mixedDigital,
        'input-cliente-nombre': payment.clientName
    };
    Object.entries(values).forEach(([id, value]) => {
        const input = document.getElementById(id);
        if (input) input.value = String(value || '').slice(0, 300);
    });
    window.toggleMetodoPago?.(method);
}

function buildCurrentSaleDraft() {
    return {
        cart: clonePlainValue(state.carrito),
        payment: getPaymentDraft(),
        attempt: clonePlainValue(state.pendingSaleAttempt),
        editContext: clonePlainValue(window.ticketEditadoContext || null)
    };
}

function reportDraftStorageFailure(error) {
    console.warn('No se pudo actualizar el borrador local de la venta:', error);
    if (saleDraftStorageWarningShown) return;
    saleDraftStorageWarningShown = true;
    window.mostrarToast?.(
        'Guardado local no disponible',
        'La venta continúa funcionando, pero este carrito podría no recuperarse al recargar.',
        'amber'
    );
}

async function persistCurrentSaleDraft({ immediate = false } = {}) {
    if (saleDraftPersistenceSuspended || !activeSaleDraftScope) return false;
    if (saleDraftWriteTimer) {
        clearTimeout(saleDraftWriteTimer);
        saleDraftWriteTimer = null;
    }

    if (!immediate) {
        saleDraftWriteTimer = setTimeout(() => {
            saleDraftWriteTimer = null;
            void persistCurrentSaleDraft({ immediate: true });
        }, SALE_DRAFT_WRITE_DELAY_MS);
        return true;
    }

    try {
        if (
            state.carrito.length === 0
            && !window.ticketEditadoContext?.saleId
        ) {
            await deleteSaleDraft(activeSaleDraftScope);
        } else {
            await saveSaleDraft(activeSaleDraftScope, buildCurrentSaleDraft());
        }
        return true;
    } catch (error) {
        reportDraftStorageFailure(error);
        return false;
    }
}

export async function flushVentasDraftForReload() {
    if (saleDraftPersistenceSuspended || !activeSaleDraftScope) return true;
    return persistCurrentSaleDraft({ immediate: true });
}

function scheduleSaleDraftPersist() {
    void persistCurrentSaleDraft();
}

async function discardSaleDraft(scope = activeSaleDraftScope) {
    if (!scope) return;
    if (scope.key === activeSaleDraftScope?.key && saleDraftWriteTimer) {
        clearTimeout(saleDraftWriteTimer);
        saleDraftWriteTimer = null;
    }
    try {
        await deleteSaleDraft(scope);
    } catch (error) {
        reportDraftStorageFailure(error);
    }
}

export async function restoreVentasDraft(context) {
    const scope = createSaleDraftScope({
        uid: context?.uid,
        localId: context?.localId || 'general'
    });
    const hydrationGeneration = ++saleDraftHydrationGeneration;

    activeSaleDraftScope = scope;
    saleDraftPersistenceSuspended = true;
    setPendingSaleAttempt(null);

    if (!scope) {
        saleDraftPersistenceSuspended = false;
        return false;
    }

    try {
        const record = await loadSaleDraft(scope);
        if (
            hydrationGeneration !== saleDraftHydrationGeneration
            || state.currentUser?.uid !== scope.uid
            || String(state.userLocalId || 'general') !== scope.localId
        ) {
            return false;
        }
        if (!record) return false;
        if (record.attempt?.status === 'committed') {
            await discardSaleDraft(scope);
            return false;
        }
        if (record.cart.length === 0 && !record.editContext) {
            await discardSaleDraft(scope);
            return false;
        }

        const cart = sanitizeRestoredCart(record.cart);
        const hadStoredEdit = Boolean(record.editContext);
        let editContext = sanitizeRestoredEditContext(record.editContext, scope);
        if (!cart || (hadStoredEdit && !editContext)) {
            await discardSaleDraft(scope);
            if (hadStoredEdit) {
                window.mostrarToast?.(
                    'Edición vencida',
                    'El pedido ya no estaba reservado y el borrador de edición fue descartado.',
                    'amber'
                );
            }
            return false;
        }

        if (editContext && !editContext.localPendingEdit) {
            try {
                const lockResult = await acquireSaleEditLock({
                    saleId: editContext.saleId,
                    lockToken: editContext.lockToken,
                    ownerId: scope.uid,
                    ownerName: editContext.lockOwnerName
                });
                editContext = {
                    ...editContext,
                    expectedRevision: lockResult.expectedRevision,
                    lockExpiresAtMs: lockResult.expiresAtMs
                };
            } catch (error) {
                await discardSaleDraft(scope);
                void releaseSaleEditLock({
                    saleId: editContext.saleId,
                    lockToken: editContext.lockToken,
                    actor: editContext.lockOwnerName,
                    reason: 'restauracion_edicion_fallida'
                }).catch(() => {});
                window.mostrarToast?.(
                    'Edición no recuperada',
                    'El pedido cambió o no pudo validarse. El borrador de edición fue descartado.',
                    'amber'
                );
                return false;
            }
        }

        if (
            hydrationGeneration !== saleDraftHydrationGeneration
            || state.currentUser?.uid !== scope.uid
            || String(state.userLocalId || 'general') !== scope.localId
        ) {
            if (editContext && !editContext.localPendingEdit) {
                void releaseSaleEditLock({
                    saleId: editContext.saleId,
                    lockToken: editContext.lockToken,
                    actor: editContext.lockOwnerName,
                    reason: 'restauracion_edicion_obsoleta'
                }).catch(() => {});
            }
            return false;
        }

        replaceCart(cart);
        setPendingSaleAttempt(sanitizeRestoredAttempt(record.attempt));
        window.ticketEditadoOriginal = Boolean(editContext);
        window.ticketEditadoContext = editContext;
        restorePaymentDraft(record.payment);

        window.mostrarToast?.(
            state.pendingSaleAttempt
                ? 'Venta pendiente de verificar'
                : (editContext ? 'Edición recuperada' : 'Carrito recuperado'),
            state.pendingSaleAttempt
                ? 'No se reenviará sola. Revisa el carrito y pulsa Procesar venta para confirmar.'
                : 'Se restauró el trabajo guardado en este dispositivo.',
            state.pendingSaleAttempt || editContext ? 'amber' : 'emerald'
        );
        return true;
    } catch (error) {
        reportDraftStorageFailure(error);
        return false;
    } finally {
        if (hydrationGeneration === saleDraftHydrationGeneration) {
            saleDraftPersistenceSuspended = false;
            actualizarCarritoUI();
        }
    }
}

let ventasRenderPending = true;
let ventasViewObserver = null;

function isVentasViewVisible() {
    const view = document.getElementById('view-ventas');
    return Boolean(view && !view.classList.contains('hidden'));
}

function installVentasVisibilityObserver() {
    if (ventasViewObserver) return;
    const view = document.getElementById('view-ventas');
    if (!view) return;

    ventasViewObserver = new MutationObserver(() => {
        if (isVentasViewVisible() && ventasRenderPending) {
            renderProductosVenta();
        }
    });
    ventasViewObserver.observe(view, {
        attributes: true,
        attributeFilter: ['class']
    });
}

export function getVentasSessionGeneration() {
    return ventasSessionGeneration;
}

export function isSaleOperationInProgress() {
    return ventaEnProceso || liberacionEdicionEnProceso;
}

function isSaleInteractionLocked() {
    return isSaleOperationInProgress() || Boolean(editLockHeartbeatPromise);
}

function clearEditLockHeartbeat({ resetWarning = true } = {}) {
    if (editLockHeartbeatTimer) {
        clearTimeout(editLockHeartbeatTimer);
        editLockHeartbeatTimer = null;
    }
    if (resetWarning) editLockHeartbeatWarningShown = false;
}

function scheduleEditLockHeartbeat(delayMs = null) {
    clearEditLockHeartbeat({ resetWarning: false });
    const editContext = window.ticketEditadoContext;
    if (
        !editContext?.saleId
        || !editContext?.lockToken
        || editLockHeartbeatPromise
    ) return;

    const remainingMs = Number(editContext.lockExpiresAtMs || 0) - getTrustedNowMs();
    const calculatedDelay = Math.min(
        EDIT_LOCK_HEARTBEAT_INTERVAL_MS,
        Math.max(1_000, remainingMs - EDIT_LOCK_RENEWAL_MARGIN_MS)
    );
    const safeDelay = Number.isFinite(delayMs)
        ? Math.max(1_000, Number(delayMs))
        : calculatedDelay;

    editLockHeartbeatTimer = setTimeout(() => {
        editLockHeartbeatTimer = null;
        void refreshEditLockHeartbeat();
    }, safeDelay);
}

function ensureEditLockHeartbeat() {
    if (
        editLockHeartbeatTimer
        || editLockHeartbeatPromise
        || !window.ticketEditadoContext?.saleId
    ) return;
    scheduleEditLockHeartbeat();
}

async function refreshEditLockHeartbeat() {
    if (editLockHeartbeatPromise) return editLockHeartbeatPromise;

    const editContext = window.ticketEditadoContext;
    if (!editContext?.saleId || !editContext?.lockToken) return false;

    if (ventaEnProceso || liberacionEdicionEnProceso) {
        scheduleEditLockHeartbeat(EDIT_LOCK_HEARTBEAT_RETRY_MS);
        return false;
    }

    clearEditLockHeartbeat({ resetWarning: false });
    const sessionGeneration = ventasSessionGeneration;
    const saleId = editContext.saleId;
    const lockToken = editContext.lockToken;
    let nextDelay = EDIT_LOCK_HEARTBEAT_INTERVAL_MS;
    let lockIsDefinitivelyLost = false;

    const renewal = (async () => {
        try {
            const lockResult = await acquireSaleEditLock({
                saleId,
                lockToken,
                ownerId: editContext.lockOwnerId,
                ownerName: editContext.lockOwnerName
            });

            const currentContext = window.ticketEditadoContext;
            const requestBecameObsolete = (
                sessionGeneration !== ventasSessionGeneration
                || currentContext?.saleId !== saleId
                || currentContext?.lockToken !== lockToken
            );
            if (requestBecameObsolete) {
                void releaseSaleEditLock({
                    saleId,
                    lockToken,
                    actor: editContext.lockOwnerName,
                    reason: 'renovacion_edicion_obsoleta'
                }).catch(() => {});
                return false;
            }

            window.ticketEditadoContext = {
                ...currentContext,
                expectedRevision: lockResult.expectedRevision,
                lockExpiresAtMs: lockResult.expiresAtMs
            };
            editLockHeartbeatWarningShown = false;
            await persistCurrentSaleDraft({ immediate: true });
            renderEditBanner();
            return true;
        } catch (error) {
            const currentContext = window.ticketEditadoContext;
            if (
                sessionGeneration !== ventasSessionGeneration
                || currentContext?.saleId !== saleId
                || currentContext?.lockToken !== lockToken
            ) return false;

            lockIsDefinitivelyLost = [
                'sale-not-found',
                'invalid-sale-state',
                'sale-edit-locked',
                'sale-edit-lock-lost',
                'missing-sale-edit-lock-data'
            ].includes(error?.code);

            if (lockIsDefinitivelyLost) {
                limpiarCarritoYEdicion(true);
                resetPaymentInputs();
                actualizarCarritoUI();
                window.mostrarAlerta?.(
                    'Edición finalizada',
                    'El pedido cambió o ya no está reservado para este dispositivo. Se descartaron los cambios locales.',
                    'amber'
                );
                return false;
            }

            nextDelay = EDIT_LOCK_HEARTBEAT_RETRY_MS;
            if (!editLockHeartbeatWarningShown) {
                editLockHeartbeatWarningShown = true;
                window.mostrarToast?.(
                    'Conexión inestable',
                    'No se pudo renovar la reserva del pedido. Se reintentará sin perder tus cambios.',
                    'amber'
                );
            }
            return false;
        }
    })();

    editLockHeartbeatPromise = renewal;
    renderEditBanner();
    actualizarCarritoUI();

    try {
        return await renewal;
    } finally {
        if (editLockHeartbeatPromise === renewal) {
            editLockHeartbeatPromise = null;
        }
        const currentContext = window.ticketEditadoContext;
        if (
            !lockIsDefinitivelyLost
            && sessionGeneration === ventasSessionGeneration
            && currentContext?.saleId === saleId
            && currentContext?.lockToken === lockToken
        ) {
            scheduleEditLockHeartbeat(nextDelay);
        }
        renderEditBanner();
        actualizarCarritoUI();
    }
}

function limpiarCarritoYEdicion(force = false) {
    if (ventaEnProceso && !force) {
        window.mostrarToast?.(
            'Venta en proceso',
            'Espera un instante mientras se guarda en este dispositivo.',
            'amber'
        );
        return false;
    }
    clearCart();
    setPendingSaleAttempt(null);
    window.ticketEditadoOriginal = false;
    window.ticketEditadoContext = null;
    clearEditLockHeartbeat();
    if (!saleDraftPersistenceSuspended) void discardSaleDraft();
    renderEditBanner();
    return true;
}

export function resetVentasSession() {
    const abandonedEdit = window.ticketEditadoContext;
    const abandonedDraftScope = activeSaleDraftScope;
    const saleSubmissionWasInProgress = ventaEnProceso;
    const saleWasCommitted =
        state.pendingSaleAttempt?.status === 'committed';
    if (saleWasCommitted && abandonedDraftScope) {
        void discardSaleDraft(abandonedDraftScope);
    } else if (abandonedEdit?.saleId && abandonedDraftScope) {
        if (saleSubmissionWasInProgress) {
            void persistCurrentSaleDraft({ immediate: true });
        } else {
            void discardSaleDraft(abandonedDraftScope);
        }
    } else if (state.carrito.length > 0 && activeSaleDraftScope) {
        void persistCurrentSaleDraft({ immediate: true });
    }
    if (abandonedEdit?.saleId) clearCart();

    clearEditLockHeartbeat();
    saleDraftHydrationGeneration++;
    saleDraftPersistenceSuspended = true;
    activeSaleDraftScope = null;
    if (saleDraftWriteTimer) {
        clearTimeout(saleDraftWriteTimer);
        saleDraftWriteTimer = null;
    }

    if (
        !saleSubmissionWasInProgress
        && abandonedEdit?.saleId
        && abandonedEdit?.lockToken
    ) {
        releaseSaleEditLock({
            saleId: abandonedEdit.saleId,
            lockToken: abandonedEdit.lockToken,
            actor: state.currentUser?.email || 'Cambio de sesión',
            reason: 'sesion_finalizada'
        }).catch(error => {
            console.warn(
                'El bloqueo se liberará por expiración si la sesión ya terminó:',
                error
            );
        });
    }

    ventasSessionGeneration++;
    ventaEnProceso = false;
    liberacionEdicionEnProceso = false;
    ventasRenderPending = true;
    setPendingSaleAttempt(null);
    vasoActual = null;
    saboresElegidos = [];
    toppingsElegidos = [];
    tamanoElegido = null;
    window.ticketEditadoOriginal = false;
    window.ticketEditadoContext = null;
    resetPaymentInputs();
    const cashRadio = document.querySelector('input[name="metodo_pago"][value="efectivo"]');
    if (cashRadio) {
        cashRadio.checked = true;
        window.toggleMetodoPago?.('efectivo');
    }
    setSaleControlsLocked(false, cobroButtonDefaultHtml);
    renderEditBanner();
}

export function initVentas() {
    if (ventasInicializado) return; 
    ventasInicializado = true;
    installVentasVisibilityObserver();

    // --- Exponer funciones globalmente para el index.html ---
    window.renderProductosVenta = renderProductosVenta; 
    window.applyProductosVentaChanges = applyProductosVentaChanges;
    window.abrirModalAjuste = abrirModalAjuste; 
    window.confirmarAjuste = confirmarAjuste;
    window.clearCart = solicitarVaciarCarrito;
    window.actualizarCarritoUI = actualizarCarritoUI;
    window.cerrarModalArmar = cerrarModalArmar;
    window.toggleSabor = toggleSabor;
    window.toggleTamano = toggleTamano;   // NUEVO
    window.toggleTopping = toggleTopping; // NUEVO

    window.toggleMetodoPago = function(val) {
        const areaVuelto = document.getElementById('area-vuelto');
        const areaMixto = document.getElementById('area-mixto');
        
        if (areaVuelto) areaVuelto.classList.toggle('hidden', val !== 'efectivo');
        if (areaMixto) areaMixto.classList.toggle('hidden', val !== 'mixto');
        
        document.querySelectorAll('input[name="metodo_pago"]').forEach(radio => {
            const label = radio.closest('label');
            if (!label) return;
            if (radio.value === val) { 
                label.classList.add('border-sky-500', 'bg-slate-800'); 
                label.classList.remove('border-slate-700', 'bg-slate-900'); 
            } else { 
                label.classList.remove('border-sky-500', 'bg-slate-800'); 
                label.classList.add('border-slate-700', 'bg-slate-900'); 
            }
        });
        
        if (val === 'mixto') {
            const hasYapeItem = state.carrito.some(i => i.isYape);
            if (hasYapeItem) {
                let sumYape = 0; let sumEfe = 0;
                state.carrito.forEach(i => { 
                    if (i.isYape) sumYape += i.precio * i.cantidad; 
                    else sumEfe += i.precio * i.cantidad; 
                });
                const inputMixYape = document.getElementById('input-mixto-yape');
                const inputMixEfe = document.getElementById('input-mixto-efectivo');
                if (inputMixYape) inputMixYape.value = sumYape > 0 ? sumYape.toFixed(2) : '';
                if (inputMixEfe) inputMixEfe.value = sumEfe > 0 ? sumEfe.toFixed(2) : '';
            }
        }
        calcularVuelto();
        scheduleSaleDraftPersist();
    };

    window.toggleYapeItem = function(id) {
        const it = state.carrito.find(c => c.cartId === id);
        if (it) { it.isYape = !it.isYape; actualizarCarritoUI(); }
    };

    // --- Delegación de eventos para Grillas y Carrito ---
    const grid = document.getElementById('productos-venta-grid');
    if (grid) {
        grid.addEventListener('click', e => {
            if (isSaleInteractionLocked()) return;
            const card = e.target.closest('.producto-card');
            if (!card || card.classList.contains('opacity-50')) return;
            
            const prod = state.productos.find(p => p.id === card.dataset.id);
            if (!prod) return;

            // NUEVA LÓGICA: Si es un vaso, o si tiene múltiples tamaños, abrir constructor
            if (prod.categoria === 'vaso' || (prod.tamanos && prod.tamanos.length > 1)) {
                iniciarArmadoVaso(prod.id);
            } else {
                agregarExtra(prod.id); // Directo al carrito
            }
        });
    }

    const listCarrito = document.getElementById('carrito-items');
    if (listCarrito) {
        listCarrito.addEventListener('click', e => {
            if (isSaleInteractionLocked()) return;
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const id = btn.dataset.id;
            if (btn.dataset.action === 'sumar') modificarCantidad(id, 1);
            if (btn.dataset.action === 'restar') modificarCantidad(id, -1);
            if (btn.dataset.action === 'eliminar') eliminarItemCarrito(id);
            if (btn.dataset.action === 'toggle-yape') window.toggleYapeItem(id);
        });

        listCarrito.addEventListener('input', e => {
            if (isSaleInteractionLocked()) return;
            if(e.target.tagName === 'INPUT') setCantidad(e.target.dataset.id, e.target.value);
        });
    }

    // --- Botones directos ---
    document.getElementById('btn-builder-add')?.addEventListener('click', confirmarVasoAlCarrito);
    const cobroButton = document.getElementById('btn-procesar-cobro');
    if (cobroButton) {
        cobroButtonDefaultHtml = cobroButton.innerHTML;
        cobroButton.addEventListener('click', procesarCobroFinal);
    }
    document.getElementById('form-ajuste')?.addEventListener('submit', confirmarAjuste);
    ensureEditBanner();
    
    // --- Escuchadores de inputs de montos ---
    [
        'input-paga-con',
        'input-mixto-yape',
        'input-mixto-efectivo',
        'input-cliente-nombre'
    ].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => {
            calcularVuelto();
            scheduleSaleDraftPersist();
        });
    });
    
    // --- Filtros de Búsqueda ---
    document.getElementById('searchInput')?.addEventListener('input', renderProductosVenta);
    document.getElementById('posCategoryFilter')?.addEventListener('change', renderProductosVenta);
    window.addEventListener('icepos:inventory-freshness', () => {
        actualizarCarritoUI();
    });
    window.addEventListener('pagehide', () => {
        void persistCurrentSaleDraft({ immediate: true });
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            void persistCurrentSaleDraft({ immediate: true });
            return;
        }

        const editContext = window.ticketEditadoContext;
        if (!editContext?.saleId || !editContext?.lockToken) return;
        const remainingMs = Number(editContext.lockExpiresAtMs || 0) - getTrustedNowMs();
        if (
            remainingMs <= (
                EDIT_LOCK_HEARTBEAT_INTERVAL_MS
                + EDIT_LOCK_RENEWAL_MARGIN_MS
            )
        ) {
            void refreshEditLockHeartbeat();
        } else {
            scheduleEditLockHeartbeat();
        }
    });

    renderProductosVenta();
}

function ensureEditBanner() {
    if (document.getElementById('venta-editando-banner')) {
        renderEditBanner();
        return;
    }

    const cartScrollArea = document.getElementById('carrito-scroll-area');
    const parent = cartScrollArea?.parentElement;
    if (!cartScrollArea || !parent) return;

    const banner = document.createElement('div');
    banner.id = 'venta-editando-banner';
    banner.className = 'hidden mx-2 mt-2 rounded-xl border border-orange-400/60 bg-orange-500/15 px-3 py-2.5 text-orange-200 shadow-lg';
    banner.innerHTML = `
        <div class="flex items-center justify-between gap-3">
            <div class="min-w-0 flex items-center gap-2">
                <div class="w-8 h-8 rounded-full bg-orange-400/20 flex items-center justify-center shrink-0">
                    <i data-lucide="lock-keyhole" class="w-4 h-4 text-orange-300"></i>
                </div>
                <div class="min-w-0">
                    <p class="text-[11px] font-black uppercase tracking-wider">Editando pedido</p>
                    <p id="venta-editando-detalle" class="text-[10px] text-orange-200/80 truncate"></p>
                </div>
            </div>
            <button id="btn-cancelar-edicion-pedido" type="button" class="shrink-0 rounded-lg border border-orange-300/40 bg-orange-400/15 px-2.5 py-1.5 text-[10px] font-bold text-orange-100 hover:bg-orange-400/25 disabled:opacity-50 disabled:cursor-not-allowed">
                Cancelar
            </button>
        </div>`;
    parent.insertBefore(banner, cartScrollArea);
    banner.querySelector('#btn-cancelar-edicion-pedido')
        ?.addEventListener('click', solicitarCancelarEdicion);

    if (window.lucide) window.lucide.createIcons({ root: banner });
    renderEditBanner();
}

function renderEditBanner() {
    const banner = document.getElementById('venta-editando-banner');
    if (!banner) return;

    if (editBannerExpiryTimer) {
        clearTimeout(editBannerExpiryTimer);
        editBannerExpiryTimer = null;
    }

    const editContext = window.ticketEditadoContext;
    const detail = document.getElementById('venta-editando-detalle');
    const cancelButton = document.getElementById('btn-cancelar-edicion-pedido');
    const isLocalPendingEdit = editContext?.localPendingEdit === true;
    const hasEdit = Boolean(
        editContext?.saleId
        && (editContext?.lockToken || isLocalPendingEdit)
    );

    banner.classList.toggle('hidden', !hasEdit);
    if (!hasEdit) {
        clearEditLockHeartbeat();
        return;
    }

    const shortId = String(editContext.saleId)
        .replace(/^T-/, '')
        .slice(0, 8)
        .toUpperCase();
    const expiresAtMs = Number(editContext.lockExpiresAtMs || 0);
    const expired = expiresAtMs > 0 && expiresAtMs <= getTrustedNowMs();
    if (detail) {
        detail.textContent = isLocalPendingEdit
            ? `#${shortId} · edición inmediata, sincronización en segundo plano`
            : (editLockHeartbeatPromise
                ? `#${shortId} · renovando reserva…`
                : (
                    expired
                        ? `#${shortId} · revalidando reserva…`
                        : `#${shortId} · reservado para este dispositivo`
                ));
    }
    if (cancelButton) {
        cancelButton.disabled = (
            ventaEnProceso
            || liberacionEdicionEnProceso
            || Boolean(editLockHeartbeatPromise)
        );
        cancelButton.textContent = liberacionEdicionEnProceso
            ? 'Liberando...'
            : 'Cancelar';
    }

    if (!isLocalPendingEdit && !expired && expiresAtMs > getTrustedNowMs()) {
        editBannerExpiryTimer = setTimeout(() => {
            editBannerExpiryTimer = null;
            renderEditBanner();
        }, Math.max(100, expiresAtMs - getTrustedNowMs() + 50));
    }
    ensureEditLockHeartbeat();
}

function solicitarVaciarCarrito() {
    if (window.ticketEditadoContext?.saleId) {
        solicitarCancelarEdicion();
        return false;
    }
    return limpiarCarritoYEdicion();
}

function solicitarCancelarEdicion() {
    if (
        ventaEnProceso
        || liberacionEdicionEnProceso
        || editLockHeartbeatPromise
    ) {
        window.mostrarToast?.(
            'Validando pedido',
            'Espera un momento mientras termina de renovarse la reserva.',
            'amber'
        );
        return;
    }
    const editContext = window.ticketEditadoContext;
    if (editContext?.localPendingEdit) {
        const clearLocalEdit = () => {
            limpiarCarritoYEdicion(true);
            resetPaymentInputs();
            actualizarCarritoUI();
        };
        if (window.mostrarConfirmacion) {
            window.mostrarConfirmacion(
                '¿Cancelar la edición? El ticket conservará su versión anterior.',
                clearLocalEdit
            );
        } else {
            clearLocalEdit();
        }
        return;
    }
    if (!editContext?.lockToken) {
        limpiarCarritoYEdicion();
        actualizarCarritoUI();
        return;
    }

    const proceed = () => cancelarEdicionActual();
    if (window.mostrarConfirmacion) {
        window.mostrarConfirmacion(
            '¿Cancelar la edición? El pedido original volverá a estar disponible sin guardar estos cambios.',
            proceed
        );
    } else {
        window.mostrarAlerta?.(
            'Acción no disponible',
            'Recarga la aplicación para cancelar la edición de forma segura.',
            'amber'
        );
    }
}

async function cancelarEdicionActual() {
    let editContext = window.ticketEditadoContext;
    if (
        liberacionEdicionEnProceso ||
        !editContext?.saleId ||
        !editContext?.lockToken
    ) return;

    liberacionEdicionEnProceso = true;
    renderEditBanner();
    actualizarCarritoUI();

    try {
        if (editLockHeartbeatPromise) {
            await editLockHeartbeatPromise;
            const renewedContext = window.ticketEditadoContext;
            if (
                renewedContext?.saleId !== editContext.saleId
                || renewedContext?.lockToken !== editContext.lockToken
            ) return;
            editContext = renewedContext;
        }

        const releaseResult = await releaseSaleEditLock({
            saleId: editContext.saleId,
            lockToken: editContext.lockToken,
            actor: state.currentUser?.username
                || state.currentUser?.email
                || 'Desconocido',
            reason: 'edicion_cancelada_desde_ventas'
        });

        if (window.ticketEditadoContext?.lockToken !== editContext.lockToken) return;
        limpiarCarritoYEdicion(true);
        resetPaymentInputs();
        actualizarCarritoUI();
        window.mostrarToast?.(
            'Edición cancelada',
            releaseResult?.alreadyReleased
                ? 'La edición local terminó; el pedido ya había cambiado.'
                : 'El pedido volvió a estar disponible.',
            'amber'
        );
    } catch (error) {
        console.error('No se pudo liberar el pedido:', error);
        if (['sale-edit-lock-lost', 'sale-not-found'].includes(error?.code)) {
            if (window.ticketEditadoContext?.lockToken === editContext.lockToken) {
                limpiarCarritoYEdicion(true);
                resetPaymentInputs();
                actualizarCarritoUI();
            }
            window.mostrarAlerta?.(
                'Edición finalizada',
                'Este dispositivo ya no tenía el bloqueo. Se descartaron los cambios locales.',
                'amber'
            );
        } else {
            window.mostrarAlerta?.(
                'No se pudo cancelar',
                'No se liberó el pedido. Revisa la conexión e inténtalo nuevamente.',
                'red'
            );
        }
    } finally {
        liberacionEdicionEnProceso = false;
        renderEditBanner();
        actualizarCarritoUI();
    }
}

// ========================================================
// AJUSTES Y DESCUENTOS
// ========================================================
function abrirModalAjuste(tipo) {
    const elTipo = document.getElementById('ajuste-tipo'); 
    const m = document.getElementById('modal-ajuste');
    if(!m || !elTipo) return;
    
    elTipo.value = tipo; 
    document.getElementById('ajuste-monto').value = ''; 
    document.getElementById('ajuste-desc').value = '';
    
    document.getElementById('modal-ajuste-titulo').innerHTML = tipo === 'Descuento' 
        ? '<i data-lucide="minus-circle" class="w-5 h-5 text-red-400"></i> Descuento' 
        : '<i data-lucide="plus-circle" class="w-5 h-5 text-emerald-400"></i> Cargo Extra';
        
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
    if(window.lucide) window.lucide.createIcons({ root: m });
}

function confirmarAjuste(e) {
    e.preventDefault();
    if (isSaleInteractionLocked()) return;
    const tipo = document.getElementById('ajuste-tipo').value; 
    let monto = parseFloat(document.getElementById('ajuste-monto').value);
    const desc = document.getElementById('ajuste-desc').value || tipo;
    
    if(isNaN(monto) || monto <= 0) { 
        if(window.mostrarToast) window.mostrarToast('Error', 'Monto inválido', 'amber'); 
        return; 
    }
    
    if(tipo === 'Descuento') monto = -monto;
    
    state.carrito.push({ 
        cartId: createUuid('C-'), 
        productoId: 'AJUSTE', 
        nombre: `${tipo}: ${desc}`, 
        precio: monto, 
        costo: 0, 
        sabores: [], 
        toppings: [], // NUEVO
        cantidad: 1, 
        categoria: 'ajuste', 
        isYape: false 
    });
    
    const m = document.getElementById('modal-ajuste'); 
    m.classList.add('opacity-0'); 
    setTimeout(() => m.classList.add('hidden'), 300);
    actualizarCarritoUI();
}

// ========================================================
// RENDERIZADO DEL CATÁLOGO EN POS (ORDENADO POR POPULARIDAD)
// ========================================================
function getProductosVentaFiltrados() {
    const term = document.getElementById('searchInput')?.value.toLowerCase() || ''; 
    const catFiltro = document.getElementById('posCategoryFilter')?.value.toLowerCase() || '';
    const rolUsuario = String(state.userRole || '').toLowerCase();
    const isAdmin = ['admin', 'administrador', 'master'].includes(rolUsuario);

    let filtrados = state.productos.filter(p => {
        const prodCat = String(p.categoria || '').toLowerCase();
        const isRightCat = prodCat === 'vaso' || prodCat === 'extra';
        // El POS siempre vende contra la sede asignada a la sesión. Los
        // productos globales se comparten; un producto de otra sede no puede
        // terminar descontando stock dentro de esta venta.
        const isRightLocal = isProductAvailableForLocal(p, state.userLocalId);
        return isRightCat && isRightLocal;
    });

    if(catFiltro !== '' && catFiltro !== 'todo' && catFiltro !== 'todas') {
        filtrados = filtrados.filter(p => String(p.categoria || '').toLowerCase() === catFiltro);
    }

    if(term !== '') {
        filtrados = filtrados.filter(p => String(p.nombre || '').toLowerCase().includes(term));
    }

    filtrados.sort((a, b) => {
        const ventasA = a.ventasTotales || 0;
        const ventasB = b.ventasTotales || 0;
        return ventasB - ventasA;
    });
    return { filtrados, isAdmin };
}

function getProductoVentaCardHtml(p, isAdmin) {
    const catLower = String(p.categoria || '').toLowerCase();
    const isAgt = p.stock !== null && p.stock <= 0;
    const blockCls = isAgt
        ? 'opacity-50 grayscale cursor-not-allowed'
        : 'cursor-pointer hover:border-sky-500 hover:shadow-sky-500/20 active:scale-95';
    const limite = Number(
        p.limite_sabores !== undefined
            ? p.limite_sabores
            : (p.limiteSabores || p.limite || 0)
    );
    const badgeLocal = p.localId && p.localId !== 'global' && isAdmin
        ? `<span class="absolute top-1 left-1 bg-slate-900 text-[8px] text-slate-400 px-1 py-0.5 rounded border border-slate-700 truncate max-w-[60px]">${state.locales.find(l => l.id === p.localId)?.nombre || 'Sede'}</span>`
        : '';
    const badgeHtml = isAgt
        ? '<div class="absolute top-0 right-0 bg-red-500 text-white text-[8px] md:text-[9px] font-bold px-1.5 md:px-2 py-0.5 rounded-bl-lg">Agotado</div>'
        : (catLower === 'vaso'
            ? `<div class="absolute top-0 right-0 bg-sky-500 text-white text-[8px] md:text-[9px] font-bold px-1.5 md:px-2 py-0.5 rounded-bl-lg">${limite === 999 ? 'Ilimitados' : limite}</div>`
            : '');
    const cCls = catLower === 'vaso'
        ? 'from-sky-400 to-red-400'
        : 'from-emerald-400 to-teal-500';

    let priceDisplay = formatMoney(p.precio || 0);
    if (p.tamanos && p.tamanos.length > 1) {
        const min = Math.min(...p.tamanos.map(t => t.precio));
        const max = Math.max(...p.tamanos.map(t => t.precio));
        const formatShort = val => Number.isInteger(val)
            ? val.toString()
            : val.toFixed(2);
        priceDisplay = min === max
            ? formatMoney(min)
            : `S/ ${formatShort(min)} - ${formatShort(max)}`;
    }

    return `
        <div data-id="${p.id}" data-categoria="${catLower}" class="producto-card bg-slate-800 border border-slate-700 rounded-xl md:rounded-2xl p-2 md:p-3 flex flex-col items-center text-center transition-all relative overflow-hidden ${blockCls}">
            ${badgeLocal}
            ${badgeHtml}
            <div class="w-10 h-10 md:w-14 md:h-14 bg-gradient-to-br ${cCls} rounded-full flex items-center justify-center mt-3 mb-2 shadow-md">
                <i data-lucide="${catLower === 'vaso' ? 'cup-soda' : 'package'}" class="w-5 h-5 md:w-7 md:h-7 text-white"></i>
            </div>
            <h3 class="text-[10px] md:text-sm font-bold text-slate-800 dark:text-white mb-1 leading-tight line-clamp-2">${p.nombre}</h3>
            <p class="text-${catLower ==='vaso'?'sky':'emerald'}-500 font-black text-xs md:text-sm mt-auto">${priceDisplay}</p>
        </div>`;
}

function createProductoVentaCard(product, isAdmin) {
    const template = document.createElement('template');
    template.innerHTML = getProductoVentaCardHtml(product, isAdmin).trim();
    return template.content.firstElementChild;
}

export function applyProductosVentaChanges(changedIds) {
    const ids = Array.from(changedIds || []);
    if (ids.length === 0) return;
    if (!isVentasViewVisible()) {
        ventasRenderPending = true;
        return;
    }

    const grid = document.getElementById('productos-venta-grid');
    if (!grid) return;

    const { filtrados, isAdmin } = getProductosVentaFiltrados();
    if (filtrados.length === 0) {
        grid.innerHTML = '<div data-empty-state="true" class="col-span-full flex justify-center py-10 text-slate-500 text-sm">No hay productos disponibles.</div>';
        ventasRenderPending = false;
        return;
    }

    grid.querySelector('[data-empty-state]')?.remove();
    const visibleById = new Map(
        filtrados.map(product => [product.id, product])
    );
    const existingById = new Map(
        Array.from(grid.querySelectorAll('.producto-card[data-id]'))
            .map(card => [card.dataset.id, card])
    );
    const iconRoots = [];

    ids.forEach(id => {
        const currentCard = existingById.get(id);
        const product = visibleById.get(id);
        if (!product) {
            currentCard?.remove();
            existingById.delete(id);
            return;
        }

        const nextCard = createProductoVentaCard(product, isAdmin);
        if (currentCard) currentCard.replaceWith(nextCard);
        else grid.appendChild(nextCard);
        existingById.set(id, nextCard);
        iconRoots.push(nextCard);
    });

    // Conserva los nodos que no cambiaron y mueve únicamente los que quedaron
    // fuera de posición cuando cambia la popularidad de un producto.
    let cursor = grid.firstElementChild;
    filtrados.forEach(product => {
        const card = existingById.get(product.id);
        if (!card) return;
        if (card !== cursor) grid.insertBefore(card, cursor);
        cursor = card.nextElementSibling;
    });

    iconRoots.forEach(root => window.lucide?.createIcons({ root }));
    ventasRenderPending = false;
}

export function renderProductosVenta() {
    if (!isVentasViewVisible()) {
        ventasRenderPending = true;
        return;
    }

    const grid = document.getElementById('productos-venta-grid'); 
    if (!grid) return;
    const { filtrados, isAdmin } = getProductosVentaFiltrados();

    if (filtrados.length === 0) {
        grid.innerHTML = '<div data-empty-state="true" class="col-span-full flex justify-center py-10 text-slate-500 text-sm">No hay productos disponibles.</div>';
        ventasRenderPending = false;
        return;
    }

    grid.innerHTML = filtrados
        .map(product => getProductoVentaCardHtml(product, isAdmin))
        .join('');
    window.lucide?.createIcons({ root: grid });
    ventasRenderPending = false;
}

// ========================================================
// ACORDEÓN DE ARMADO (TAMAÑOS, SABORES, TOPPINGS)
// ========================================================
function actualizarPrecioModal() {
    let t = (tamanoElegido ? parseFloat(tamanoElegido.precio) : 0);
    toppingsElegidos.forEach(top => t += parseFloat(top.precio));
    document.getElementById('modal-vaso-subtitle').textContent = `Total: ${formatMoney(t)}`;
}

function iniciarArmadoVaso(id) {
    vasoActual = state.productos.find(p => p.id === id); 
    if(!vasoActual) return; 

    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));

    saboresElegidos = [];
    toppingsElegidos = [];
    
    // Normalizar tamaños del producto
    if (!vasoActual.tamanos || vasoActual.tamanos.length === 0) {
         vasoActual.tamanos = [{ nombre: 'Estándar', precio: vasoActual.precio }];
    }
    tamanoElegido = vasoActual.tamanos[0]; // Seleccionar el primero por defecto

    document.getElementById('modal-vaso-title').textContent = vasoActual.nombre; 
    document.getElementById('limite-sabores-txt').textContent = limite === 999 ? 'Ilimitados' : `Max: ${limite}`;
    
    // 1. RENDERIZAR TAMAÑOS
    renderTamanosUI();

    // 2. RENDERIZAR SABORES
    const c = document.getElementById('builder-sabores'); 
    let htmlSabores = '';
    const saboresDisp = state.productos.filter(p => (
        String(p.categoria || '').toLowerCase() === 'sabor'
        && isProductAvailableForLocal(p, state.userLocalId)
    ));
    
    if (vasoActual.categoria !== 'vaso' || limite === 0) {
        htmlSabores = '<p class="text-xs text-slate-500 col-span-2 italic text-center">Este producto no lleva sabores.</p>';
    } else {
        saboresDisp.forEach(j => {
            const dis = (j.stock !== null && j.stock <= 0) ? 'opacity-50 pointer-events-none line-through' : 'cursor-pointer hover:border-sky-500 hover:shadow-md';
            const clickAction = (j.stock !== null && j.stock <= 0) ? '' : `onclick="window.toggleSabor('${j.nombre}')"`;
            
            htmlSabores += `
            <div ${clickAction} data-nombre="${j.nombre}" class="sabor-btn bg-slate-900 border border-slate-700 p-3 rounded-xl flex items-center gap-2 transition-all select-none ${dis}">
                <div class="check-icon w-4 h-4 rounded-full border border-slate-500 flex items-center justify-center transition-colors"></div>
                <span class="text-sm font-medium text-slate-300 w-full">${j.nombre}</span>
            </div>`;
        });
    }
    c.innerHTML = htmlSabores || '<p class="text-xs text-slate-500 col-span-2 text-center">No hay sabores disponibles.</p>'; 
    document.getElementById('builder-count').textContent = '0';

    // 3. RENDERIZAR TOPPINGS
    const ct = document.getElementById('builder-toppings');
    let htmlToppings = '';
    const toppingsDisp = state.productos.filter(p => (
        String(p.categoria || '').toLowerCase() === 'topping'
        && isProductAvailableForLocal(p, state.userLocalId)
    ));
    
    toppingsDisp.forEach(top => {
        const isAgt = top.stock !== null && top.stock <= 0;
        const cls = isAgt ? 'opacity-50 pointer-events-none' : 'cursor-pointer hover:border-amber-500 hover:bg-slate-800';
        const tPrecio = top.tamanos && top.tamanos.length > 0 ? top.tamanos[0].precio : (top.precio || 0);

        htmlToppings += `
        <div onclick="${isAgt ? '' : `window.toggleTopping('${top.id}')`}" data-id="${top.id}" class="topping-btn bg-slate-900 border border-slate-700 p-2.5 rounded-xl flex items-center gap-2 transition-all select-none ${cls}">
            <div class="check-icon w-4 h-4 rounded-sm border border-slate-500 flex items-center justify-center transition-colors shrink-0"></div>
            <div class="flex flex-col w-full">
                <span class="text-xs font-medium text-slate-300 leading-tight">${top.nombre}</span>
                <span class="text-[10px] text-amber-400 font-bold leading-tight">+${formatMoney(tPrecio)}</span>
            </div>
        </div>`;
    });
    ct.innerHTML = htmlToppings || '<p class="text-xs text-slate-500 col-span-2 text-center italic">No hay toppings disponibles.</p>';

    actualizarPrecioModal();
    
    const m = document.getElementById('modal-armar-vaso'); 
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);

    // Expandir automáticamente la primera sección necesaria
    if (vasoActual.tamanos.length > 1) window.toggleAcordeon('tamanos');
    else if (limite > 0) window.toggleAcordeon('sabores');
    else window.toggleAcordeon('toppings');
}

function renderTamanosUI() {
    let tamHtml = '';
    vasoActual.tamanos.forEach((t, idx) => {
        const isSel = tamanoElegido.nombre === t.nombre;
        const cls = isSel ? 'bg-sky-500 border-sky-500 shadow-lg shadow-sky-500/20' : 'bg-slate-900 border-slate-700 hover:border-sky-500/50';
        const txtCls = isSel ? 'text-white' : 'text-slate-300';
        const priceCls = isSel ? 'text-sky-100' : 'text-sky-400';
        
        tamHtml += `
        <button onclick="window.toggleTamano(${idx})" class="p-3 border rounded-xl flex flex-col items-start transition-all ${cls}">
            <span class="font-bold text-xs md:text-sm ${txtCls}">${t.nombre}</span>
            <span class="text-xs font-black ${priceCls} mt-1">${formatMoney(t.precio)}</span>
        </button>`;
    });
    document.getElementById('builder-tamanos').innerHTML = tamHtml;
}

function toggleTamano(idx) {
    if(!vasoActual || !vasoActual.tamanos[idx]) return;
    tamanoElegido = vasoActual.tamanos[idx];
    renderTamanosUI();
    actualizarPrecioModal();
    
    // Auto-avanzar al siguiente paso
    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));
    if (limite > 0) window.toggleAcordeon('sabores');
    else window.toggleAcordeon('toppings');
}

function toggleTopping(id) {
    const toppingData = state.productos.find(p => p.id === id);
    if (!toppingData) return;

    const existeIdx = toppingsElegidos.findIndex(t => t.id === id);
    
    if (existeIdx >= 0) {
        toppingsElegidos.splice(existeIdx, 1);
    } else {
        const tPrecio = toppingData.tamanos && toppingData.tamanos.length > 0 ? toppingData.tamanos[0].precio : (toppingData.precio || 0);
        toppingsElegidos.push({
            id: toppingData.id,
            nombre: toppingData.nombre,
            precio: parseFloat(tPrecio)
        });
    }

    // Actualizar UI Visual de los botones de Toppings
    document.querySelectorAll('.topping-btn').forEach(btn => {
        const tid = btn.dataset.id; 
        const chk = btn.querySelector('.check-icon');
        if (!chk) return;

        if(toppingsElegidos.some(t => t.id === tid)) { 
            btn.classList.add('border-amber-500', 'bg-slate-800'); 
            btn.classList.remove('border-slate-700', 'bg-slate-900'); 
            chk.classList.replace('border-slate-500', 'border-transparent'); 
            chk.classList.add('bg-amber-500');
            chk.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-white"></i>'; 
        } else { 
            btn.classList.remove('border-amber-500', 'bg-slate-800'); 
            btn.classList.add('border-slate-700', 'bg-slate-900'); 
            chk.classList.replace('border-transparent', 'border-slate-500'); 
            chk.classList.remove('bg-amber-500');
            chk.innerHTML = ''; 
        }
    });

    const modalArmar = document.getElementById('modal-armar-vaso');
    if(window.lucide && modalArmar) {
        window.lucide.createIcons({ root: modalArmar });
    }
    actualizarPrecioModal();
}

function toggleSabor(n) {
    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));

    if(saboresElegidos.includes(n)) {
        saboresElegidos = saboresElegidos.filter(s => s !== n);
    } else { 
        if(limite === 999 || saboresElegidos.length < limite) {
            saboresElegidos.push(n); 
        } else {
            if(window.mostrarToast) window.mostrarToast('Límite alcanzado', `Solo puedes elegir hasta ${limite} sabores.`, 'amber');
            return; 
        }
    }
    
    document.querySelectorAll('.sabor-btn').forEach(btn => {
        const nm = btn.dataset.nombre; 
        const chk = btn.querySelector('.check-icon');
        if (!chk) return;

        if(saboresElegidos.includes(nm)) { 
            btn.classList.add('bg-sky-500', 'border-sky-500'); 
            btn.classList.remove('bg-slate-900', 'border-slate-700'); 
            btn.querySelector('span').classList.replace('text-slate-300', 'text-white');
            chk.classList.replace('border', 'bg-white/30'); 
            chk.classList.replace('border-slate-500', 'border-transparent'); 
            chk.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-white"></i>'; 
        } else { 
            btn.classList.remove('bg-sky-500', 'border-sky-500'); 
            btn.classList.add('bg-slate-900', 'border-slate-700'); 
            btn.querySelector('span').classList.replace('text-white', 'text-slate-300');
            chk.classList.replace('bg-white/30', 'border'); 
            chk.classList.replace('border-transparent', 'border-slate-500'); 
            chk.innerHTML = ''; 
        }
    });
    
    const countEl = document.getElementById('builder-count');
    if (countEl) countEl.textContent = saboresElegidos.length;
    const modalArmar = document.getElementById('modal-armar-vaso');
    if(window.lucide && modalArmar) {
        window.lucide.createIcons({ root: modalArmar });
    }
    
    // Auto-avanzar si llega al límite
    if (saboresElegidos.length === limite && limite !== 999) {
        setTimeout(() => window.toggleAcordeon('toppings'), 300);
    }
}

function cerrarModalArmar() { 
    const m = document.getElementById('modal-armar-vaso'); 
    if(m) {
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
    }
}

function confirmarVasoAlCarrito() {
    if (isSaleInteractionLocked() || !vasoActual || !tamanoElegido) return;
    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));

    if(saboresElegidos.length === 0 && limite !== 0 && window.mostrarToast) { 
        window.mostrarToast('Atención', 'Elige 1 sabor mínimo.', 'amber'); 
        // Abrir la pestaña de sabores para que el usuario lo vea
        window.toggleAcordeon('sabores');
        return; 
    }

    let precioTotal = parseFloat(tamanoElegido.precio) || 0;
    toppingsElegidos.forEach(t => precioTotal += t.precio);
    const saboresDetalle = saboresElegidos.map(nombre => {
        const producto = state.productos.find(product => (
            String(product.categoria || '').toLowerCase() === 'sabor' &&
            product.nombre === nombre &&
            isProductAvailableForLocal(product, state.userLocalId)
        ));
        return producto ? { id: producto.id, nombre: producto.nombre } : { nombre };
    });

    state.carrito.push({ 
        cartId: createUuid('C-'), 
        productoId: vasoActual.id, 
        nombre: vasoActual.nombre, 
        tamano: tamanoElegido.nombre, // NUEVO
        precio: precioTotal, 
        costo: vasoActual.costo || 0, 
        sabores: [...saboresElegidos], 
        saboresDetalle,
        toppings: [...toppingsElegidos], // NUEVO
        cantidad: 1, 
        categoria: 'vaso', 
        isYape: false 
    });
    
    cerrarModalArmar(); 
    actualizarCarritoUI();
}

// ========================================================
// GESTIÓN DEL CARRITO
// ========================================================
function agregarExtra(id) {
    if (isSaleInteractionLocked()) return;
    const p = state.productos.find(x => x.id === id); 
    if(!p) return;
    
    const tPrecio = p.tamanos && p.tamanos.length > 0 ? p.tamanos[0].precio : (p.precio || 0);
    const tNombre = p.tamanos && p.tamanos.length > 0 ? p.tamanos[0].nombre : 'Estándar';

    const it = state.carrito.find(i => i.productoId === id && i.categoria === 'extra');
    if (it) {
        it.cantidad++; 
    } else {
        state.carrito.push({ 
            cartId: createUuid('C-'), 
            productoId: p.id, 
            nombre: p.nombre, 
            tamano: tNombre,
            precio: parseFloat(tPrecio), 
            costo: p.costo || 0, 
            sabores: [], 
            toppings: [],
            cantidad: 1, 
            categoria: 'extra', 
            isYape: false 
        });
    }
    actualizarCarritoUI();
}

function modificarCantidad(id, delta) { 
    if (isSaleInteractionLocked()) return;
    const it = state.carrito.find(c => c.cartId === id); 
    if(it) { 
        it.cantidad += delta; 
        if(it.cantidad <= 0) eliminarItemCarrito(id); 
        else actualizarCarritoUI(); 
    } 
}

function setCantidad(id, cantStr) {
    if (isSaleInteractionLocked()) return;
    if (cantStr === '') return; 
    const cant = parseInt(cantStr); 
    if(isNaN(cant) || cant <= 0) { eliminarItemCarrito(id); return; }
    const it = state.carrito.find(c => c.cartId === id); 
    if(it) { it.cantidad = cant; actualizarCarritoUI(); }
}

function eliminarItemCarrito(id) { 
    if (isSaleInteractionLocked()) return;
    state.carrito = state.carrito.filter(c => c.cartId !== id); 
    actualizarCarritoUI(); 
}

export function actualizarCarritoUI() {
    const list = document.getElementById('carrito-items'); 
    const emp = document.getElementById('carrito-vacio'); 
    const btn = document.getElementById('btn-procesar-cobro');
    const clearButton = document.getElementById('btn-vaciar-carrito');
    const totalEl = document.getElementById('carrito-total');
    
    if(!list) return;
    renderEditBanner();
    if (clearButton) {
        const isBlocked = isSaleInteractionLocked();
        clearButton.disabled = isBlocked;
        clearButton.classList.toggle('opacity-50', isBlocked);
        clearButton.classList.toggle('cursor-not-allowed', isBlocked);
    }
    
    const activeElementId = document.activeElement?.dataset?.id;

    let t = 0; let html = '';
    state.carrito.forEach(i => {
        t += i.precio * i.cantidad;
        const color = i.precio < 0 ? 'text-red-500' : 'text-emerald-500';
        const btnYapeClass = i.isYape ? 'bg-purple-100 text-purple-600 border-purple-300 dark:bg-purple-500/20 dark:text-purple-400' : 'bg-slate-200 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-400';

        // Construir detalles visuales (Tamaño, Sabores, Toppings)
        let detallesHtml = '';
        if (i.tamano && i.tamano !== 'Estándar' && i.tamano !== 'Único / Estándar' && i.productoId !== 'AJUSTE') {
            detallesHtml += `<p class="text-[9px] text-emerald-400 font-medium mt-0.5"><span class="text-slate-400">Tam:</span> ${i.tamano}</p>`;
        }
        if (i.sabores && i.sabores.length > 0) {
            detallesHtml += `<p class="text-[9px] text-sky-400 font-medium mt-0.5"><span class="text-slate-400">Sab:</span> ${i.sabores.join(', ')}</p>`;
        }
        if (i.toppings && i.toppings.length > 0) {
            detallesHtml += `<p class="text-[9px] text-amber-400 font-medium mt-0.5"><span class="text-slate-400">Top:</span> ${i.toppings.map(x=>x.nombre).join(', ')}</p>`;
        }

        html += `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-2.5 shadow-sm relative group mb-2">
            <div class="flex justify-between items-start">
                <div class="flex-1 pr-2">
                    <h4 class="text-xs font-bold text-slate-800 dark:text-white leading-tight">${i.nombre}</h4>
                    ${detallesHtml}
                    ${i.productoId !== 'AJUSTE' ? `<div class="flex items-center bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5 border border-slate-300 dark:border-slate-600 w-fit mt-1.5"><button data-action="restar" data-id="${i.cartId}" class="w-6 h-5 flex items-center justify-center text-slate-500 hover:text-slate-800 dark:hover:text-white"><i data-lucide="minus" class="w-3 h-3"></i></button><input type="number" data-id="${i.cartId}" value="${i.cantidad}" class="w-7 text-center bg-transparent text-xs font-bold text-slate-800 dark:text-white focus:outline-none hide-arrows"><button data-action="sumar" data-id="${i.cartId}" class="w-6 h-5 flex items-center justify-center text-slate-500 hover:text-slate-800 dark:hover:text-white"><i data-lucide="plus" class="w-3 h-3"></i></button></div>` : ''}
                </div>
                <div class="text-right flex flex-col items-end justify-between">
                    <p class="font-bold ${color} text-sm">${formatMoney(i.precio * i.cantidad)}</p>
                    <div class="flex items-center gap-1.5 mt-2">
                        <button data-action="toggle-yape" data-id="${i.cartId}" class="px-2 py-0.5 rounded text-[9px] font-bold border transition-colors flex items-center gap-1 ${btnYapeClass}" title="Pagar con Yape">Yape</button>
                        <button data-action="eliminar" data-id="${i.cartId}" class="text-slate-400 hover:text-red-500 p-0.5"><i data-lucide="trash" class="w-3.5 h-3.5"></i></button>
                    </div>
                </div>
            </div>
        </div>`;
    });

    if(state.carrito.length > 0) { 
        if(emp) emp.classList.add('hidden'); 
        list.classList.remove('hidden'); 
        list.innerHTML = html; 
        if(btn) {
            const catalogUnavailable = state.productos.length === 0;
            const isBlocked = isSaleInteractionLocked() || catalogUnavailable;
            btn.classList.toggle('opacity-50', isBlocked);
            btn.classList.toggle('cursor-not-allowed', isBlocked);
            btn.disabled = isBlocked;
            if (!ventaEnProceso && catalogUnavailable) {
                btn.innerHTML = '<i data-lucide="refresh-cw" class="w-5 h-5 animate-spin"></i> Cargando catálogo...';
            } else if (!ventaEnProceso && cobroButtonDefaultHtml) {
                btn.innerHTML = cobroButtonDefaultHtml;
            }
        }
    } else { 
        if(emp) emp.classList.remove('hidden'); 
        list.classList.add('hidden'); 
        list.innerHTML = ''; 
        if(btn) {
            btn.classList.add('opacity-50', 'cursor-not-allowed'); 
            btn.disabled = true; 
        }
    }
    
    if (totalEl) totalEl.textContent = formatMoney(t); 

    const hasYape = state.carrito.some(c => c.isYape); 
    const hasEfe = state.carrito.some(c => !c.isYape);
    
    const rMixto = document.getElementById('radio-mixto');
    const rYape = document.getElementById('radio-yape');

    if (hasYape) {
        if (hasEfe && rMixto && !rMixto.checked) { 
            rMixto.checked = true; window.toggleMetodoPago('mixto'); 
        } else if (!hasEfe && rYape && !rYape.checked) { 
            rYape.checked = true; window.toggleMetodoPago('yape'); 
        } else if (rMixto && rMixto.checked) { 
            window.toggleMetodoPago('mixto'); 
        }
    }

    if(window.lucide) window.lucide.createIcons({ root: list }); 
    calcularVuelto();

    if (activeElementId) {
        const inputToRefocus = document.querySelector(`input[data-id="${activeElementId}"]`);
        if (inputToRefocus) { 
            inputToRefocus.focus(); 
            const val = inputToRefocus.value; 
            inputToRefocus.value = ''; 
            inputToRefocus.value = val; 
        }
    }
    scheduleSaleDraftPersist();
    window.dispatchEvent(new Event('icepos:update-safety-changed'));
}

function calcularVuelto() {
    const t = state.carrito.reduce((s, i) => s + (i.precio * i.cantidad), 0);
    const radioSelect = document.querySelector('input[name="metodo_pago"]:checked');
    const inputCon = document.getElementById('input-paga-con');
    const txtVuel = document.getElementById('txt-vuelto');

    if(radioSelect && radioSelect.value === 'efectivo' && inputCon && txtVuel) {
        const pc = parseFloat(inputCon.value) || 0; 
        const v = pc - t;
        txtVuel.textContent = v >= 0 ? formatMoney(v) : 'S/ 0.00'; 
        txtVuel.classList.toggle('text-red-500', v < 0);
    }
}

// ========================================================
// PROCESAR COBRO Y DESCUENTO DE INVENTARIOS
// ========================================================
function cloneCart(items) {
    if (typeof structuredClone === 'function') return structuredClone(items);
    return JSON.parse(JSON.stringify(items));
}

function isProductAvailableForLocal(product, localId) {
    const productLocalId = String(product?.localId || '').trim();
    return (
        !productLocalId
        || productLocalId === 'global'
        || productLocalId === 'general'
        || (
            Boolean(localId)
            && productLocalId === localId
        )
    );
}

function getCurrentCatalogUnitPrice(item, localId) {
    const product = state.productos.find(entry => entry.id === item.productoId);
    if (!product) {
        throw new SalesIntegrityError(
            'catalog-changed',
            `El producto "${item.nombre || 'seleccionado'}" ya no está disponible.`
        );
    }
    if (!isProductAvailableForLocal(product, localId)) {
        throw new SalesIntegrityError(
            'product-out-of-location',
            `El producto "${item.nombre || 'seleccionado'}" pertenece a otra sede.`
        );
    }

    const sizes = Array.isArray(product.tamanos) ? product.tamanos : [];
    let basePrice;
    if (sizes.length > 0) {
        const requestedSize = String(item.tamano || '').trim().toLowerCase();
        const selectedSize = sizes.find(size => (
            String(size.nombre || '').trim().toLowerCase() === requestedSize
        )) || (
            ['', 'estándar', 'único / estándar'].includes(requestedSize)
                ? sizes[0]
                : null
        );
        if (!selectedSize) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `El tamaño de "${item.nombre || 'un producto'}" cambió. Vuelve a agregarlo.`
            );
        }
        basePrice = Number(selectedSize.precio);
    } else {
        basePrice = Number(product.precio || 0);
    }

    if (!Number.isFinite(basePrice) || basePrice < 0) {
        throw new SalesIntegrityError(
            'catalog-changed',
            `El precio de "${item.nombre || 'un producto'}" no está disponible.`
        );
    }

    let expectedPrice = basePrice;
    (Array.isArray(item.toppings) ? item.toppings : []).forEach(topping => {
        const toppingId = topping?.id || topping?.productoId;
        const toppingProduct = state.productos.find(entry => (
            entry.id === toppingId
            && isProductAvailableForLocal(entry, localId)
        ));
        if (!toppingId || !toppingProduct) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `Un topping de "${item.nombre || 'un producto'}" ya no está disponible.`
            );
        }
        const toppingSizes = Array.isArray(toppingProduct.tamanos)
            ? toppingProduct.tamanos
            : [];
        const toppingPrice = Number(
            toppingSizes[0]?.precio ?? toppingProduct.precio ?? 0
        );
        if (!Number.isFinite(toppingPrice) || toppingPrice < 0) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `El precio del topping "${toppingProduct.nombre || ''}" cambió.`
            );
        }
        expectedPrice = roundMoney(expectedPrice + toppingPrice);
    });

    return {
        expectedPrice: roundMoney(expectedPrice),
        currentCost: Number(product.costo || 0)
    };
}

function validateFreshCatalogPricing(items, localId) {
    if (!Array.isArray(state.productos) || state.productos.length === 0) {
        throw new SalesIntegrityError(
            'catalog-not-available',
            'El catálogo local todavía no está disponible.'
        );
    }

    items.forEach(item => {
        const isAdjustment = item.productoId === 'AJUSTE' || item.categoria === 'ajuste';
        if (isAdjustment) return;

        const { expectedPrice, currentCost } = getCurrentCatalogUnitPrice(item, localId);
        if (Math.abs(Number(item.precio) - expectedPrice) > 0.009) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `El precio de "${item.nombre || 'un producto'}" cambió. Retíralo y vuelve a agregarlo.`
            );
        }
        if (!Number.isFinite(currentCost) || currentCost < 0) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `El costo de "${item.nombre || 'un producto'}" no es válido.`
            );
        }
        item.costo = currentCost;
    });
}

function resolveSaleAttempt({ editContext, cart, totals, payment, localId, clientName }) {
    const fingerprint = JSON.stringify({
        saleId: editContext?.saleId || '',
        lockToken: editContext?.lockToken || '',
        localPendingEdit: editContext?.localPendingEdit === true,
        sourceOperationId: editContext?.sourceOperationId || '',
        expectedRevision: Number(editContext?.expectedRevision || 0),
        cart,
        totals,
        payment,
        localId,
        clientName
    });

    if (
        !state.pendingSaleAttempt
        || state.pendingSaleAttempt.fingerprint !== fingerprint
    ) {
        setPendingSaleAttempt({
            fingerprint,
            saleId: editContext?.saleId || createUuid('T-'),
            operationId: createUuid('OP-'),
            status: 'prepared',
            updatedAt: Date.now(),
            lastErrorCode: ''
        });
    }

    return state.pendingSaleAttempt;
}

function validateCartAndTotals(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new SalesIntegrityError('empty-cart', 'El carrito está vacío.');
    }

    let total = 0;
    let cost = 0;
    let positiveSubtotal = 0;
    let discounts = 0;

    items.forEach(item => {
        const quantity = Number(item.cantidad);
        const price = Number(item.precio);
        const itemCost = Number(item.costo || 0);
        const isAdjustment = item.productoId === 'AJUSTE' || item.categoria === 'ajuste';

        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999) {
            throw new SalesIntegrityError(
                'invalid-quantity',
                `La cantidad de "${item.nombre || 'un producto'}" no es válida.`
            );
        }
        if (!Number.isFinite(price) || !Number.isFinite(itemCost) || itemCost < 0) {
            throw new SalesIntegrityError(
                'invalid-money',
                `El precio o costo de "${item.nombre || 'un producto'}" no es válido.`
            );
        }
        if (!isAdjustment && price < 0) {
            throw new SalesIntegrityError(
                'invalid-product-price',
                'Solo los descuentos pueden tener importes negativos.'
            );
        }
        if (isAdjustment && quantity !== 1) {
            throw new SalesIntegrityError(
                'invalid-adjustment',
                'Los cargos y descuentos deben aplicarse una sola vez.'
            );
        }

        const lineTotal = roundMoney(price * quantity);
        total = roundMoney(total + lineTotal);
        cost = roundMoney(cost + itemCost * quantity);

        if (lineTotal < 0) discounts = roundMoney(discounts + Math.abs(lineTotal));
        else positiveSubtotal = roundMoney(positiveSubtotal + lineTotal);
    });

    if (positiveSubtotal <= 0) {
        throw new SalesIntegrityError(
            'missing-positive-items',
            'La venta debe incluir al menos un producto o cargo positivo.'
        );
    }
    if (discounts >= positiveSubtotal || total <= 0) {
        throw new SalesIntegrityError(
            'discount-too-large',
            'El descuento no puede igualar o superar el subtotal positivo.'
        );
    }

    return { total, cost };
}

function getValidatedPayment(total) {
    const methodEl = document.querySelector('input[name="metodo_pago"]:checked');
    const method = String(methodEl?.value || 'efectivo').toLowerCase();
    const allowedMethods = new Set(['efectivo', 'yape', 'mixto']);
    if (!allowedMethods.has(method)) {
        throw new SalesIntegrityError(
            'invalid-payment-method',
            'Selecciona un método de pago válido.'
        );
    }

    if (method === 'efectivo') {
        const rawPaid = document.getElementById('input-paga-con')?.value.trim() || '';
        if (rawPaid !== '') {
            const paid = Number(rawPaid);
            if (!Number.isFinite(paid) || paid < total) {
                throw new SalesIntegrityError(
                    'insufficient-cash',
                    'El efectivo recibido es menor que el total.'
                );
            }
        }
        return { method, cash: total, digital: 0 };
    }

    if (method === 'yape') {
        return { method, cash: 0, digital: total };
    }

    const cash = roundMoney(
        Number(document.getElementById('input-mixto-efectivo')?.value)
    );
    const digital = roundMoney(
        Number(document.getElementById('input-mixto-yape')?.value)
    );

    if (cash <= 0 || digital <= 0) {
        throw new SalesIntegrityError(
            'invalid-mixed-payment',
            'En un pago mixto, efectivo y Yape deben ser mayores que cero.'
        );
    }
    if (Math.abs(cash + digital - total) > 0.009) {
        throw new SalesIntegrityError(
            'payment-mismatch',
            'La suma de efectivo y Yape no coincide con el total.'
        );
    }

    return { method, cash, digital };
}

function setSaleControlsLocked(locked, originalButtonHtml = '') {
    ventaEnProceso = locked;
    const button = document.getElementById('btn-procesar-cobro');
    const clearButton = document.getElementById('btn-vaciar-carrito');

    [
        'input-paga-con',
        'input-mixto-yape',
        'input-mixto-efectivo',
        'input-cliente-nombre'
    ].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = locked;
    });
    document.querySelectorAll('input[name="metodo_pago"]').forEach(input => {
        input.disabled = locked;
    });
    if (clearButton) {
        clearButton.disabled = locked;
        clearButton.classList.toggle('opacity-50', locked);
        clearButton.classList.toggle('cursor-not-allowed', locked);
    }

    if (!button) return;
    if (locked) {
        button.disabled = true;
        button.classList.add('opacity-50', 'cursor-not-allowed');
        button.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> Procesar venta';
    } else {
        button.disabled = false;
        button.classList.remove('opacity-50', 'cursor-not-allowed');
        if (originalButtonHtml) button.innerHTML = originalButtonHtml;
    }
    if (window.lucide) window.lucide.createIcons({ root: button });
    renderEditBanner();
    window.dispatchEvent(new Event('icepos:update-safety-changed'));
}

function resetPaymentInputs() {
    const inputIds = [
        'input-paga-con',
        'input-mixto-efectivo',
        'input-mixto-yape',
        'input-cliente-nombre'
    ];
    inputIds.forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = '';
    });
    const change = document.getElementById('txt-vuelto');
    if (change) change.textContent = 'S/ 0.00';
}

function showSaleError(error) {
    console.error('No se pudo confirmar la venta:', error);
    let message = error?.message || 'No se pudo confirmar la venta.';

    if (error?.code === 'unavailable' || error?.code === 'failed-precondition') {
        message = 'No se pudo guardar la venta en este dispositivo. El carrito se conservó.';
    } else if (error?.code === 'insufficient-stock') {
        const available = error.details?.disponible;
        message = `${error.message}${Number.isFinite(available) ? ` Disponible: ${available}.` : ''}`;
    }

    if (window.mostrarAlerta) {
        window.mostrarAlerta('Venta no registrada', message, 'red');
    } else if (window.mostrarToast) {
        window.mostrarToast('Venta no registrada', message, 'red');
    }
}

async function procesarCobroFinal() {
    const btn = document.getElementById('btn-procesar-cobro');
    if(
        !btn
        || state.carrito.length === 0
        || btn.disabled
        || isSaleInteractionLocked()
    ) return;

    const originalButtonHtml = btn.innerHTML;
    const sessionGeneration = ventasSessionGeneration;
    const saleDraftScope = activeSaleDraftScope;
    let activeAttempt = null;

    try {
        const cart = cloneCart(state.carrito);
        const editContext = window.ticketEditadoContext || null;
        // El guardado local no espera una renovación remota del bloqueo. La
        // transacción en segundo plano valida el token y la revisión antes de
        // aplicar la edición, evitando congelar Caja cuando Firebase está lento.
        const localId = editContext?.localId || state.userLocalId || 'general';
        if (!editContext) validateFreshCatalogPricing(cart, localId);
        else if (!Array.isArray(state.productos) || state.productos.length === 0) {
            throw new SalesIntegrityError(
                'catalog-not-available',
                'El catálogo local todavía no está disponible.'
            );
        }
        const totals = validateCartAndTotals(cart);
        const payment = getValidatedPayment(totals.total);
        const clientName = document.getElementById('input-cliente-nombre')?.value.trim() || '';
        const resolvedAttempt = resolveSaleAttempt({
            editContext,
            cart,
            totals,
            payment,
            localId,
            clientName
        });
        activeAttempt = {
            ...resolvedAttempt,
            status: 'submitting',
            updatedAt: Date.now(),
            lastErrorCode: ''
        };
        setPendingSaleAttempt(activeAttempt);
        const { saleId, operationId } = activeAttempt;
        const actor = state.currentUser?.username || state.currentUser?.email || 'Desconocido';
        const inventoryMovements = buildInventoryMovements(
            cart,
            state.productos,
            localId
        );

        const sale = {
            fechaStr: getTodayDateStr(),
            fechaHora: getTrustedNowMs(),
            items: cart,
            total: totals.total,
            costoTotal: totals.cost,
            costo_total: totals.cost,
            pagoEfectivo: payment.cash,
            pago_efectivo: payment.cash,
            pagoYape: payment.digital,
            pago_yape: payment.digital,
            metodoFinal: payment.method,
            metodo_pago: payment.method,
            localId,
            localNombre: editContext?.localNombre || state.userLocal || 'Sin Local',
            cajeroEmail: state.currentUser?.email || '',
            creadoPor: actor,
            editadoPor: editContext ? actor : '',
            clienteNombre: clientName,
            estado: 'pendiente'
        };

        setSaleControlsLocked(true, originalButtonHtml);
        await persistCurrentSaleDraft({ immediate: true });
        await saveSaleTransaction({
            saleId,
            operationId,
            sale,
            inventoryMovements,
            editContext,
            catalog: state.productos
        });

        if (sessionGeneration !== ventasSessionGeneration) {
            await discardSaleDraft(saleDraftScope);
            return;
        }
        activeAttempt = {
            ...activeAttempt,
            status: 'committed',
            updatedAt: Date.now(),
            lastErrorCode: ''
        };
        setPendingSaleAttempt(activeAttempt);
        await discardSaleDraft(saleDraftScope);
        if (sessionGeneration !== ventasSessionGeneration) return;

        limpiarCarritoYEdicion(true);
        resetPaymentInputs();
        if(window.mostrarToast) {
            const shortId = saleId.replace(/^T-/, '').slice(0, 8).toUpperCase();
            window.mostrarToast(
                editContext ? 'Venta actualizada' : 'Venta registrada',
                `Ticket #${shortId} guardado. La nube se sincroniza en segundo plano.`,
                'emerald'
            );
        }
    } catch (err) {
        if (
            sessionGeneration === ventasSessionGeneration
            && activeAttempt
            && state.pendingSaleAttempt?.operationId === activeAttempt.operationId
        ) {
            setPendingSaleAttempt({
                ...activeAttempt,
                status: 'failed',
                updatedAt: Date.now(),
                lastErrorCode: String(err?.code || 'unknown').slice(0, 120)
            });
            await persistCurrentSaleDraft({ immediate: true });
        }
        if (sessionGeneration === ventasSessionGeneration) showSaleError(err);
    } finally {
        if (sessionGeneration === ventasSessionGeneration) {
            setSaleControlsLocked(false, originalButtonHtml);
            actualizarCarritoUI();
        }
    }
}
