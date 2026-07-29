import {
    state,
    clearCart,
    replaceCart,
    setPendingSaleAttempt
} from '../core/store.js';
import {
    escaparHtml,
    formatMoney,
    getTodayDateStr,
    getTrustedNowMs
} from '../utils/helpers.js';
import {
    createSaleDraftScope,
    deleteSaleDraft,
    deleteSaleDraftIfAttemptMatches,
    deleteSaleRecoveryDraft,
    loadSaleDraft,
    loadSaleRecoveryDrafts,
    promoteSaleRecoveryDraft,
    saveSaleDraft,
    saveSaleRecoveryDraft
} from '../core/sale-draft-store.js';
import {
    SalesIntegrityError,
    acquireSaleEditLock,
    buildInventoryMovements,
    createUuid,
    releaseSaleEditLock,
    releaseSaleEditLockTransaction,
    roundMoney,
    saveSaleTransaction
} from '../core/sales-service.js';
import {
    discardSyncOperation,
    getFailedSyncOperations,
    getPendingSyncOperationById,
    getPendingSyncOperationsForEntity,
    getSyncOperationSnapshot
} from '../core/sync-queue.js';

let vasoActual = null; 
let saboresElegidos = [];
let toppingsElegidos = []; // NUEVO: Estado para toppings
let tamanoElegido = null;  // NUEVO: Estado para tamaño
let ventasInicializado = false;
let ventaEnProceso = false;
let preparacionVentaEnProceso = false;
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
let failedSaleRecoveryInProgress = false;
let failedSaleRecoveryToken = null;
let recoveredFailedSaleOperation = null;
let deferredSaleDraftCleanup = null;
let pendingSalePersistenceCount = 0;
let saleRecoveryPromotionInProgress = false;
let saleRecoveryNoticeShown = false;
let indexedProductsSource = null;
let indexedProductsById = new Map();

const SALE_DRAFT_WRITE_DELAY_MS = 120;
const MAX_RESTORED_CART_ITEMS = 200;
const EDIT_LOCK_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
const EDIT_LOCK_HEARTBEAT_RETRY_MS = 30 * 1000;
const EDIT_LOCK_RENEWAL_MARGIN_MS = 2 * 60 * 1000;
const TEMPORARY_EDIT_LOCK_ERROR_CODES = new Set([
    'aborted',
    'cancelled',
    'deadline-exceeded',
    'failed-precondition',
    'internal',
    'network-request-failed',
    'resource-exhausted',
    'unauthenticated',
    'unavailable'
]);

function isTemporaryEditLockError(error) {
    return TEMPORARY_EDIT_LOCK_ERROR_CODES.has(
        String(error?.code || '').replace(/^firestore\//, '')
    );
}

function recoveryStillBelongsToSession(operation, generation) {
    return (
        generation === ventasSessionGeneration
        && String(operation?.ownerId || '') !== ''
        && String(operation.ownerId) === String(state.currentUser?.uid || '')
    );
}

function finishFailedSaleRecovery(token) {
    if (failedSaleRecoveryToken !== token) return;
    failedSaleRecoveryToken = null;
    failedSaleRecoveryInProgress = false;
}

function clonePlainValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function getIndexedProductsById() {
    if (indexedProductsSource !== state.productos) {
        indexedProductsSource = state.productos;
        indexedProductsById = new Map(
            (Array.isArray(state.productos) ? state.productos : [])
                .map(product => [product.id, product])
        );
    }
    return indexedProductsById;
}

function getProductById(id) {
    return getIndexedProductsById().get(id);
}

function createDeferredBoolean() {
    let resolvePromise;
    let settled = false;
    const promise = new Promise(resolve => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value) {
            if (settled) return;
            settled = true;
            resolvePromise(value !== false);
        }
    };
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
            && (!item.consumoVaso || (
                typeof item.consumoVaso === 'object'
                && isSafeIdentifier(item.consumoVaso.insumoId)
                && typeof item.consumoVaso.nombre === 'string'
                && item.consumoVaso.nombre.length <= 300
                && Number.isInteger(Number(item.consumoVaso.unidades))
                && Number(item.consumoVaso.unidades) > 0
                && Number(item.consumoVaso.unidades) <= 20
                && (
                    !item.consumoVaso.localId
                    || isSafeIdentifier(item.consumoVaso.localId)
                )
            ))
        );
    });

    return valid ? restored : null;
}

function sanitizeRestoredAttempt(attempt) {
    if (!attempt) return null;
    const status = String(attempt.status || 'prepared').toLowerCase();
    const queueVersion = String(attempt.queueVersion || '').trim();
    if (
        !isSafeIdentifier(attempt.fingerprint, 500_000)
        || !isSafeIdentifier(attempt.saleId)
        || !isSafeIdentifier(attempt.operationId)
        || (queueVersion && !isSafeIdentifier(queueVersion))
        || !['prepared', 'submitting', 'queued', 'failed'].includes(status)
    ) {
        return null;
    }

    return {
        fingerprint: String(attempt.fingerprint),
        saleId: String(attempt.saleId),
        operationId: String(attempt.operationId),
        queueVersion,
        status,
        updatedAt: Number(attempt.updatedAt) || Date.now(),
        lastErrorCode: String(attempt.lastErrorCode || '').slice(0, 120)
    };
}

function sanitizeRestoredEditContext(editContext, scope) {
    if (!editContext) return null;

    const lockExpiresAtMs = Number(editContext.lockExpiresAtMs || 0);
    const expectedRevision = Number(editContext.expectedRevision || 0);
    const lockPending = editContext.lockPending === true;
    const localPendingCreate = editContext.localPendingCreate === true;
    const originalFechaHora = Number(editContext.originalFechaHora || 0);
    if (
        !isSafeIdentifier(editContext.saleId)
        || !isSafeIdentifier(editContext.lockToken)
        || !isSafeIdentifier(editContext.lockOwnerId)
        || String(editContext.lockOwnerId) !== scope.uid
        || !Number.isInteger(expectedRevision)
        || expectedRevision <= 0
        || !Number.isFinite(lockExpiresAtMs)
        || (!lockPending && lockExpiresAtMs <= 0)
    ) {
        return null;
    }

    return {
        saleId: String(editContext.saleId),
        expectedRevision,
        legacyInventoryMovements: Array.isArray(editContext.legacyInventoryMovements)
            ? clonePlainValue(editContext.legacyInventoryMovements)
            : [],
        originalInventoryMovements: Array.isArray(editContext.originalInventoryMovements)
            ? clonePlainValue(editContext.originalInventoryMovements)
            : (
                Array.isArray(editContext.legacyInventoryMovements)
                    ? clonePlainValue(editContext.legacyInventoryMovements)
                    : []
            ),
        localId: String(editContext.localId || scope.localId || 'general'),
        localNombre: String(editContext.localNombre || 'Sin Local'),
        originalFechaHora: Number.isFinite(originalFechaHora) && originalFechaHora > 0
            ? originalFechaHora
            : 0,
        lockToken: String(editContext.lockToken),
        lockOwnerId: String(editContext.lockOwnerId),
        lockOwnerName: String(editContext.lockOwnerName || 'Usuario'),
        lockExpiresAtMs,
        lockPending,
        localPendingCreate,
        pendingCreateQueueId: String(editContext.pendingCreateQueueId || ''),
        pendingCreateOperationId: String(
            editContext.pendingCreateOperationId || ''
        ),
        pendingCreateVersion: String(editContext.pendingCreateVersion || ''),
        pendingCreateStatus: String(editContext.pendingCreateStatus || '')
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

async function persistCurrentSaleDraft({
    immediate = false,
    draftSnapshot = null
} = {}) {
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
        const draft = draftSnapshot || buildCurrentSaleDraft();
        if (
            draft.cart.length === 0
            && !draft.editContext?.saleId
        ) {
            if (
                deferredSaleDraftCleanup?.scopeKey
                === activeSaleDraftScope.key
            ) {
                return true;
            }
            await deleteSaleDraft(activeSaleDraftScope);
        } else {
            if (draft.cart.length > 0 && deferredSaleDraftCleanup) {
                deferredSaleDraftCleanup = null;
            }
            await saveSaleDraft(activeSaleDraftScope, draft);
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
    if (state.carrito.length > 0 && deferredSaleDraftCleanup) {
        deferredSaleDraftCleanup = null;
    }
    void persistCurrentSaleDraft();
}

async function discardSaleDraft(
    scope = activeSaleDraftScope,
    { expectedAttempt = null } = {}
) {
    if (!scope) return;
    if (
        !expectedAttempt
        && scope.key === activeSaleDraftScope?.key
        && saleDraftWriteTimer
    ) {
        clearTimeout(saleDraftWriteTimer);
        saleDraftWriteTimer = null;
    }
    try {
        if (expectedAttempt) {
            await deleteSaleDraftIfAttemptMatches(scope, expectedAttempt);
        } else {
            await deleteSaleDraft(scope);
        }
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
    const hydrationStillBelongsToSession = () => (
        hydrationGeneration === saleDraftHydrationGeneration
        && state.currentUser?.uid === scope?.uid
        && String(state.userLocalId || 'general') === scope?.localId
    );

    activeSaleDraftScope = scope;
    saleDraftPersistenceSuspended = true;
    setPendingSaleAttempt(null);

    if (!scope) {
        saleDraftPersistenceSuspended = false;
        return false;
    }

    try {
        const record = await loadSaleDraft(scope);
        if (!hydrationStillBelongsToSession()) return false;
        if (!record) return false;
        const loadedDraftExpectation = {
            operationId: String(record.attempt?.operationId || ''),
            queueVersion: String(record.attempt?.queueVersion || ''),
            updatedAt: Number(record.updatedAt || 0),
            writeToken: String(record.writeToken || '')
        };
        if (record.attempt?.status === 'committed') {
            await discardSaleDraft(scope, {
                expectedAttempt: loadedDraftExpectation
            });
            return false;
        }
        let restoredAttempt = sanitizeRestoredAttempt(record.attempt);
        let restoredFailedQueueId = '';
        let restoredFailedQueueIds = [];
        let restoredFailedOperationId = '';
        if (restoredAttempt) {
            const operationSnapshot = await getSyncOperationSnapshot({
                ownerId: scope.uid,
                type: 'sale.save',
                id: restoredAttempt.operationId
            });
            if (!hydrationStillBelongsToSession()) return false;
            const operationStatus = operationSnapshot?.status || '';
            const operationVersionMatches = (
                Boolean(restoredAttempt.queueVersion)
                && operationSnapshot?.version === restoredAttempt.queueVersion
            );
            const durableOperationMatches = (
                operationSnapshot?.durable === true
                && operationVersionMatches
            );

            let failedOperations = [];
            try {
                failedOperations = await getFailedSyncOperations();
            } catch (error) {
                console.warn(
                    'No se pudo revisar todavía la cola local fallida:',
                    error
                );
            }
            if (!hydrationStillBelongsToSession()) return false;
            const relatedFailures = failedOperations.filter(operation => (
                operation.type === 'sale.save'
                && operation.payload?.saleId === restoredAttempt.saleId
            ));
            if (
                operationStatus
                && operationStatus !== 'failed'
                && durableOperationMatches
                && relatedFailures.length === 0
            ) {
                await discardSaleDraft(scope, {
                    expectedAttempt: loadedDraftExpectation
                });
                return false;
            }
            if (operationStatus === 'failed' || relatedFailures.length > 0) {
                restoredAttempt = {
                    ...restoredAttempt,
                    status: 'failed'
                };
                const matchingFailure = relatedFailures.find(operation => (
                    operation.payload?.operationId
                        === restoredAttempt.operationId
                )) || (
                    operationStatus === 'failed'
                        ? operationSnapshot
                        : relatedFailures[0]
                );
                restoredFailedQueueId = matchingFailure?.id || '';
                restoredFailedQueueIds = relatedFailures.length
                    ? relatedFailures.map(operation => operation.id)
                    : [matchingFailure?.id].filter(Boolean);
                restoredFailedOperationId = String(
                    matchingFailure?.payload?.operationId || ''
                );
            }
        }
        if (record.cart.length === 0 && !record.editContext) {
            await discardSaleDraft(scope, {
                expectedAttempt: loadedDraftExpectation
            });
            return false;
        }

        const cart = sanitizeRestoredCart(record.cart);
        const hadStoredEdit = Boolean(record.editContext);
        let editContext = sanitizeRestoredEditContext(record.editContext, scope);
        if (!cart || (hadStoredEdit && !editContext)) {
            await discardSaleDraft(scope, {
                expectedAttempt: loadedDraftExpectation
            });
            if (hadStoredEdit) {
                window.mostrarToast?.(
                    'Edición vencida',
                    'El pedido ya no estaba reservado y el borrador de edición fue descartado.',
                    'amber'
                );
            }
            return false;
        }

        if (editContext && !editContext.localPendingCreate) {
            const storedExpectedRevision = editContext.expectedRevision;
            try {
                const lockResult = await acquireSaleEditLock({
                    saleId: editContext.saleId,
                    lockToken: editContext.lockToken,
                    ownerId: scope.uid,
                    ownerName: editContext.lockOwnerName,
                    expectedRevision: storedExpectedRevision
                });
                if (
                    Number(lockResult.expectedRevision || 1)
                    !== Number(storedExpectedRevision || 1)
                ) {
                    throw new SalesIntegrityError(
                        'edit-conflict',
                        'El pedido cambió desde que se guardó este borrador.'
                    );
                }
                editContext = {
                    ...editContext,
                    lockExpiresAtMs: lockResult.expiresAtMs,
                    lockPending: false
                };
            } catch (error) {
                if (isTemporaryEditLockError(error)) {
                    editContext = {
                        ...editContext,
                        lockPending: true,
                        lockExpiresAtMs: 0
                    };
                    window.mostrarToast?.(
                        'Edición recuperada sin conexión',
                        'Tus cambios están locales. La reserva se validará al guardar.',
                        'amber'
                    );
                } else {
                    await discardSaleDraft(scope, {
                        expectedAttempt: loadedDraftExpectation
                    });
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
        }

        if (
            hydrationGeneration !== saleDraftHydrationGeneration
            || state.currentUser?.uid !== scope.uid
            || String(state.userLocalId || 'general') !== scope.localId
        ) {
            if (editContext && !editContext.localPendingCreate) {
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
        setPendingSaleAttempt(restoredAttempt);
        recoveredFailedSaleOperation = restoredFailedQueueId
            ? {
                queueId: restoredFailedQueueId,
                queueIds: restoredFailedQueueIds.length
                    ? restoredFailedQueueIds
                    : [restoredFailedQueueId],
                operationId:
                    restoredFailedOperationId
                    || restoredAttempt.operationId
            }
            : null;
        window.ticketEditadoOriginal = Boolean(editContext);
        window.ticketEditadoContext = editContext;
        restorePaymentDraft(record.payment);
        if (
            record.attempt?.operationId
            && record.attempt?.queueVersion
        ) {
            void deleteSaleRecoveryDraft(
                scope,
                record.attempt
            ).catch(error => {
                reportDraftStorageFailure(error);
            });
        }

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
            setTimeout(() => {
                void recoverNextFailedSaleOperation()
                    .catch(() => false)
                    .then(() => recoverNextSaleRecoveryDraft());
            }, 0);
        }
    }
}

async function recoverNextSaleRecoveryDraft({
    scope = activeSaleDraftScope,
    sessionGeneration = ventasSessionGeneration,
    ownerId = state.currentUser?.uid,
    allowDuringPersistenceFailure = false,
    notifyWhenBusy = true
} = {}) {
    const recoveryStillApplies = () => (
        sessionGeneration === ventasSessionGeneration
        && String(state.currentUser?.uid || '') === String(ownerId || '')
        && scope?.key === activeSaleDraftScope?.key
    );
    if (
        saleRecoveryPromotionInProgress
        || !scope
        || !recoveryStillApplies()
    ) {
        return false;
    }

    let recoveryRecords;
    try {
        recoveryRecords = await loadSaleRecoveryDrafts(scope);
    } catch (error) {
        reportDraftStorageFailure(error);
        return false;
    }
    if (!recoveryStillApplies()) return false;
    if (recoveryRecords.length === 0) {
        saleRecoveryNoticeShown = false;
        return false;
    }

    const interfaceIsBusy = (
        state.carrito.length > 0
        || Boolean(window.ticketEditadoContext?.saleId)
        || (
            !allowDuringPersistenceFailure
            && hasPendingSaleLocalPersistence()
        )
    );
    if (interfaceIsBusy) {
        if (notifyWhenBusy && !saleRecoveryNoticeShown) {
            saleRecoveryNoticeShown = true;
            window.mostrarToast?.(
                'Venta protegida pendiente',
                'Hay otra venta guardada localmente. Se abrirá para revisión al terminar el carrito actual.',
                'amber'
            );
        }
        return false;
    }

    const recoveryRecord = recoveryRecords[0];
    saleRecoveryPromotionInProgress = true;
    saleRecoveryNoticeShown = false;
    preparacionVentaEnProceso = true;
    try {
        const promotion = await promoteSaleRecoveryDraft(
            scope,
            recoveryRecord
        );
        if (!recoveryStillApplies()) return false;
        if (!promotion?.promoted) {
            if (promotion?.busy && notifyWhenBusy && !saleRecoveryNoticeShown) {
                saleRecoveryNoticeShown = true;
                window.mostrarToast?.(
                    'Venta protegida pendiente',
                    'Otro carrito local está activo. La recuperación se conservará para después.',
                    'amber'
                );
            }
            return false;
        }
        return await restoreVentasDraft({
            uid: scope.uid,
            localId: scope.localId
        });
    } catch (error) {
        reportDraftStorageFailure(error);
        return false;
    } finally {
        saleRecoveryPromotionInProgress = false;
        if (recoveryStillApplies()) {
            preparacionVentaEnProceso = false;
            actualizarCarritoUI();
        }
    }
}

async function recoverDraftAfterQueuePersistenceFailure({
    scope,
    sessionGeneration,
    ownerId
}) {
    const recoveryStillApplies = () => (
        sessionGeneration === ventasSessionGeneration
        && String(state.currentUser?.uid || '') === String(ownerId || '')
        && scope?.key === activeSaleDraftScope?.key
    );
    if (
        !scope
        || !recoveryStillApplies()
    ) {
        return false;
    }

    return recoverNextSaleRecoveryDraft({
        scope,
        sessionGeneration,
        ownerId,
        allowDuringPersistenceFailure: true,
        notifyWhenBusy: true
    });
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
    return ventaEnProceso || preparacionVentaEnProceso || liberacionEdicionEnProceso;
}

export function hasPendingSaleLocalPersistence() {
    return pendingSalePersistenceCount > 0;
}

function beginSalePersistenceGuard() {
    pendingSalePersistenceCount++;
    window.dispatchEvent(new Event('icepos:update-safety-changed'));
    let finished = false;
    return () => {
        if (finished) return;
        finished = true;
        pendingSalePersistenceCount = Math.max(
            0,
            pendingSalePersistenceCount - 1
        );
        window.dispatchEvent(new Event('icepos:update-safety-changed'));
    };
}

function isSaleInteractionLocked() {
    // Renovar el bloqueo remoto nunca debe congelar acciones que son locales
    // (sabores, toppings, cantidades o datos de pago).
    return isSaleOperationInProgress();
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
        || editContext.localPendingCreate === true
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
        || window.ticketEditadoContext?.localPendingCreate === true
    ) return;
    scheduleEditLockHeartbeat();
}

async function refreshEditLockHeartbeat() {
    if (editLockHeartbeatPromise) return editLockHeartbeatPromise;

    const editContext = window.ticketEditadoContext;
    if (!editContext?.saleId || !editContext?.lockToken) return false;
    if (editContext.localPendingCreate === true) return true;

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
                ownerName: editContext.lockOwnerName,
                expectedRevision: editContext.expectedRevision
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
            if (
                Number(lockResult.expectedRevision || 1)
                !== Number(currentContext.expectedRevision || 1)
            ) {
                void releaseSaleEditLock({
                    saleId,
                    lockToken,
                    actor: editContext.lockOwnerName,
                    reason: 'renovacion_edicion_en_conflicto'
                }).catch(() => {});
                throw new SalesIntegrityError(
                    'edit-conflict',
                    'El pedido cambió desde que comenzaste a editarlo.'
                );
            }

            window.ticketEditadoContext = {
                ...currentContext,
                lockExpiresAtMs: lockResult.expiresAtMs,
                lockPending: false
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
                'missing-sale-edit-lock-data',
                'edit-conflict'
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

function limpiarCarritoYEdicion(
    force = false,
    {
        discardDraft = true,
        discardRecoveredOperation = true
    } = {}
) {
    if (ventaEnProceso && !force) {
        window.mostrarToast?.(
            'Guardando venta',
            'Espera un instante mientras se registra en este dispositivo.',
            'amber'
        );
        return false;
    }
    const recoveredOperation = recoveredFailedSaleOperation;
    recoveredFailedSaleOperation = null;
    clearCart();
    setPendingSaleAttempt(null);
    window.ticketEditadoOriginal = false;
    window.ticketEditadoContext = null;
    window.ticketEditLockPromise = null;
    clearEditLockHeartbeat();
    if (discardDraft && !saleDraftPersistenceSuspended) {
        void discardSaleDraft();
    }
    if (discardRecoveredOperation && recoveredOperation?.queueId) {
        const recoveredQueueIds = recoveredOperation.queueIds?.length
            ? recoveredOperation.queueIds
            : [recoveredOperation.queueId];
        recoveredQueueIds.forEach(queueId => {
            void discardSyncOperation(queueId).catch(error => {
                console.warn(
                    'No se pudo descartar la venta local recuperada:',
                    error
                );
            });
        });
    }
    renderEditBanner();
    if (discardDraft) {
        setTimeout(() => {
            void recoverNextFailedSaleOperation()
                .catch(() => false)
                .then(() => recoverNextSaleRecoveryDraft());
        }, 0);
    }
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
    preparacionVentaEnProceso = false;
    liberacionEdicionEnProceso = false;
    failedSaleRecoveryInProgress = false;
    failedSaleRecoveryToken = null;
    recoveredFailedSaleOperation = null;
    deferredSaleDraftCleanup = null;
    pendingSalePersistenceCount = 0;
    saleRecoveryPromotionInProgress = false;
    saleRecoveryNoticeShown = false;
    ventasRenderPending = true;
    setPendingSaleAttempt(null);
    vasoActual = null;
    saboresElegidos = [];
    toppingsElegidos = [];
    tamanoElegido = null;
    window.ticketEditadoOriginal = false;
    window.ticketEditadoContext = null;
    window.ticketEditLockPromise = null;
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
    window.addEventListener('icepos:sync-operation-failed', handleSaleSyncFailure);
    setTimeout(() => {
        void recoverNextFailedSaleOperation();
    }, 0);

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
            
            const prod = getProductById(card.dataset.id);
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
    const hasEdit = Boolean(editContext?.saleId && editContext?.lockToken);

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
        detail.textContent = editContext.localPendingCreate
            ? `#${shortId} · edición local, sincronización pendiente`
            : (
                editLockHeartbeatPromise
                    ? `#${shortId} · renovando reserva…`
                    : (
                        expired
                            ? `#${shortId} · revalidando reserva…`
                            : `#${shortId} · reservado para este dispositivo`
                    )
            );
    }
    if (cancelButton) {
        cancelButton.disabled = (
            ventaEnProceso
            || liberacionEdicionEnProceso
        );
        cancelButton.textContent = liberacionEdicionEnProceso
            ? 'Liberando...'
            : 'Cancelar';
    }

    if (!expired && expiresAtMs > getTrustedNowMs()) {
        editBannerExpiryTimer = setTimeout(() => {
            editBannerExpiryTimer = null;
            renderEditBanner();
        }, Math.max(100, expiresAtMs - getTrustedNowMs() + 50));
    }
    ensureEditLockHeartbeat();
}

function solicitarVaciarCarrito() {
    if (window.ticketEditadoContext?.lockToken) {
        solicitarCancelarEdicion();
        return false;
    }
    const cleared = limpiarCarritoYEdicion();
    if (cleared) {
        setTimeout(() => {
            void recoverNextFailedSaleOperation();
        }, 0);
    }
    return cleared;
}

function solicitarCancelarEdicion() {
    if (
        ventaEnProceso
        || liberacionEdicionEnProceso
    ) {
        window.mostrarToast?.(
            'Venta en proceso',
            'Espera a que termine la operación actual.',
            'amber'
        );
        return;
    }
    const editContext = window.ticketEditadoContext;
    if (!editContext?.lockToken) {
        limpiarCarritoYEdicion();
        actualizarCarritoUI();
        return;
    }
    if (editContext.localPendingCreate === true) {
        limpiarCarritoYEdicion(true);
        resetPaymentInputs();
        renderAcceptedSaleImmediately();
        window.mostrarToast?.(
            'Edición cancelada',
            'El pedido local original se conservó sin cambios.',
            'amber'
        );
        setTimeout(() => {
            actualizarCarritoUI();
            window.switchView?.('pedidos');
        }, 0);
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

function cancelarEdicionActual() {
    const editContext = window.ticketEditadoContext;
    if (
        liberacionEdicionEnProceso ||
        !editContext?.saleId ||
        !editContext?.lockToken
    ) return;

    liberacionEdicionEnProceso = true;
    try {
        releaseSaleEditLockTransaction({
            saleId: editContext.saleId,
            operationId: createUuid('OP-'),
            lockToken: editContext.lockToken,
            actor: state.currentUser?.username
                || state.currentUser?.email
                || 'Desconocido',
            reason: 'edicion_cancelada_desde_ventas'
        });
    } catch (error) {
        // Si el almacenamiento local no está disponible, al menos intentamos
        // liberar directamente. La interfaz no queda bloqueada por ese viaje.
        void releaseSaleEditLock({
            saleId: editContext.saleId,
            lockToken: editContext.lockToken,
            actor: state.currentUser?.username
                || state.currentUser?.email
                || 'Desconocido',
            reason: 'edicion_cancelada_sin_cola'
        }).catch(releaseError => {
            console.warn(
                'El bloqueo se liberará al expirar si no vuelve la conexión:',
                releaseError
            );
        });
    }

    if (window.ticketEditadoContext?.lockToken === editContext.lockToken) {
        limpiarCarritoYEdicion(true);
        resetPaymentInputs();
        renderAcceptedSaleImmediately();
        window.mostrarToast?.(
            'Edición cancelada',
            'Los cambios locales se descartaron; la liberación se sincroniza en segundo plano.',
            'amber'
        );
        setTimeout(() => {
            void recoverNextFailedSaleOperation();
            actualizarCarritoUI();
        }, 0);
    }
    liberacionEdicionEnProceso = false;
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
        
    m.classList.remove('hidden', 'pointer-events-none'); 
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
    m.classList.add('opacity-0', 'pointer-events-none'); 
    setTimeout(() => m.classList.add('hidden'), 300);
    actualizarCarritoUI();
}

// ========================================================
// RENDERIZADO DEL CATÁLOGO EN POS (ORDENADO POR POPULARIDAD)
// ========================================================
function getCupConsumptionConfig(product, size) {
    if (size?.consumoVaso && typeof size.consumoVaso === 'object') {
        return size.consumoVaso;
    }
    if (product?.consumoVaso && typeof product.consumoVaso === 'object') {
        return product.consumoVaso;
    }
    return null;
}

function getEffectiveSaleLocalId() {
    return String(
        window.ticketEditadoContext?.localId
        || state.userLocalId
        || 'general'
    );
}

function resolveCupConsumption(
    product,
    size,
    localId,
    catalogById = getIndexedProductsById()
) {
    const config = getCupConsumptionConfig(product, size);
    const assignments = Array.isArray(config?.asignaciones)
        ? config.asignaciones
        : [];
    if (assignments.length === 0) {
        return {
            controlled: false,
            available: true,
            consumption: null,
            reason: ''
        };
    }

    const normalizedLocalId = String(localId || '');
    const assignment = assignments.find(item => (
        String(item?.localId || '') === normalizedLocalId
    )) || assignments.find(item => (
        ['global', 'general', ''].includes(String(item?.localId || ''))
    ));
    if (!assignment?.insumoId) {
        return {
            controlled: true,
            available: false,
            consumption: null,
            reason: 'Este tamaño no tiene vaso asignado para tu sede.'
        };
    }

    const cup = catalogById.get(String(assignment.insumoId));
    const cupLocalId = String(cup?.localId || '');
    const validCup = Boolean(
        cup
        && String(cup.categoria || '').toLowerCase() === 'insumo'
        && (
            String(cup.tipoInsumo || '').toLowerCase() === 'vaso'
            || cup.esVasoInventario === true
        )
        && cup.activo !== false
        && isProductAvailableForLocal(cup, localId)
        && (
            ['global', 'general', ''].includes(cupLocalId)
            || cupLocalId === normalizedLocalId
        )
    );
    const units = Math.max(
        1,
        Math.trunc(Number(assignment.unidades ?? config?.unidades) || 1)
    );
    const stock = Number(cup?.stock);
    if (!validCup || !Number.isInteger(stock) || stock < units) {
        return {
            controlled: true,
            available: false,
            consumption: null,
            reason: !validCup
                ? 'El vaso asignado ya no está disponible.'
                : `No hay suficientes unidades de ${cup.nombre || 'ese vaso'}.`
        };
    }

    return {
        controlled: true,
        available: true,
        reason: '',
        consumption: {
            insumoId: String(cup.id),
            nombre: String(cup.nombre || 'Vaso'),
            unidades: units,
            localId: cupLocalId || 'global'
        }
    };
}

function isSizeAvailableForSale(product, size) {
    if (
        product.stock !== null
        && product.stock !== undefined
        && Number(product.stock) <= 0
    ) return false;
    return resolveCupConsumption(
        product,
        size,
        getEffectiveSaleLocalId()
    ).available;
}

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
        const isRightLocal = isProductAvailableForLocal(
            p,
            getEffectiveSaleLocalId()
        );
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
    const sizes = Array.isArray(p.tamanos) && p.tamanos.length > 0
        ? p.tamanos
        : [{ nombre: 'Estándar', precio: p.precio || 0 }];
    const isAgt = !sizes.some(size => isSizeAvailableForSale(p, size));
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
    vasoActual = getProductById(id);
    if(!vasoActual) return; 

    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));

    saboresElegidos = [];
    toppingsElegidos = [];
    
    // Normalizar tamaños del producto
    if (!vasoActual.tamanos || vasoActual.tamanos.length === 0) {
         vasoActual.tamanos = [{ nombre: 'Estándar', precio: vasoActual.precio }];
    }
    tamanoElegido = vasoActual.tamanos.find(size => (
        isSizeAvailableForSale(vasoActual, size)
    )) || null;
    if (!tamanoElegido) {
        window.mostrarToast?.(
            'Sin vasos disponibles',
            'No hay stock del vaso físico asignado a este producto.',
            'amber'
        );
        return;
    }

    document.getElementById('modal-vaso-title').textContent = vasoActual.nombre; 
    document.getElementById('limite-sabores-txt').textContent = limite === 999 ? 'Ilimitados' : `Max: ${limite}`;
    
    // 1. RENDERIZAR TAMAÑOS
    renderTamanosUI();

    // 2. RENDERIZAR SABORES
    const c = document.getElementById('builder-sabores'); 
    let htmlSabores = '';
    const effectiveLocalId = getEffectiveSaleLocalId();
    const saboresDisp = state.productos.filter(p => (
        String(p.categoria || '').toLowerCase() === 'sabor'
        && isProductAvailableForLocal(p, effectiveLocalId)
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
        && isProductAvailableForLocal(p, effectiveLocalId)
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
    m.classList.remove('hidden', 'pointer-events-none'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);

    // Expandir automáticamente la primera sección necesaria
    if (vasoActual.tamanos.length > 1) window.toggleAcordeon('tamanos');
    else if (limite > 0) window.toggleAcordeon('sabores');
    else window.toggleAcordeon('toppings');
}

function renderTamanosUI() {
    let tamHtml = '';
    vasoActual.tamanos.forEach((t, idx) => {
        const isAvailable = isSizeAvailableForSale(vasoActual, t);
        const cupState = resolveCupConsumption(
            vasoActual,
            t,
            getEffectiveSaleLocalId()
        );
        const isSel = tamanoElegido?.nombre === t.nombre;
        const cls = !isAvailable
            ? 'bg-slate-100 border-slate-200 opacity-50 cursor-not-allowed'
            : (
                isSel
                    ? 'bg-sky-500 border-sky-500 shadow-lg shadow-sky-500/20'
                    : 'bg-slate-900 border-slate-700 hover:border-sky-500/50'
            );
        const txtCls = isSel ? 'text-white' : 'text-slate-300';
        const priceCls = isSel ? 'text-sky-100' : 'text-sky-400';
        
        const unavailableReason = escaparHtml(
            isAvailable ? '' : (cupState.reason || 'Sin stock')
        );
        const cupName = escaparHtml(cupState.consumption?.nombre || '');
        tamHtml += `
        <button type="button" ${isAvailable ? `onclick="window.toggleTamano(${idx})"` : 'disabled'} class="p-3 border rounded-xl flex flex-col items-start transition-all ${cls}" title="${unavailableReason}">
            <span class="font-bold text-xs md:text-sm ${txtCls}">${escaparHtml(t.nombre)}</span>
            <span class="text-xs font-black ${priceCls} mt-1">${formatMoney(t.precio)}</span>
            ${cupState.controlled ? `<span class="mt-1 text-[9px] ${isAvailable ? 'text-amber-600' : 'text-red-500'}">${isAvailable ? cupName : 'Vaso no disponible'}</span>` : ''}
        </button>`;
    });
    document.getElementById('builder-tamanos').innerHTML = tamHtml;
}

function toggleTamano(idx) {
    if(!vasoActual || !vasoActual.tamanos[idx]) return;
    if (!isSizeAvailableForSale(vasoActual, vasoActual.tamanos[idx])) {
        window.mostrarToast?.(
            'Tamaño no disponible',
            resolveCupConsumption(
                vasoActual,
                vasoActual.tamanos[idx],
                getEffectiveSaleLocalId()
            ).reason || 'No hay stock suficiente.',
            'amber'
        );
        return;
    }
    tamanoElegido = vasoActual.tamanos[idx];
    renderTamanosUI();
    actualizarPrecioModal();
    
    // Auto-avanzar al siguiente paso
    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));
    if (limite > 0) window.toggleAcordeon('sabores');
    else window.toggleAcordeon('toppings');
}

function toggleTopping(id) {
    const toppingData = getProductById(id);
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

    const button = Array.from(document.querySelectorAll('.topping-btn'))
        .find(item => item.dataset.id === id);
    const check = button?.querySelector('.check-icon');
    const selected = toppingsElegidos.some(topping => topping.id === id);
    if (button && check) {
        button.classList.toggle('border-amber-500', selected);
        button.classList.toggle('bg-slate-800', selected);
        button.classList.toggle('border-slate-700', !selected);
        button.classList.toggle('bg-slate-900', !selected);
        check.classList.toggle('border-slate-500', !selected);
        check.classList.toggle('border-transparent', selected);
        check.classList.toggle('bg-amber-500', selected);
        check.innerHTML = selected
            ? '<i data-lucide="check" class="w-3 h-3 text-white"></i>'
            : '';
        window.lucide?.createIcons({ root: button });
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
    
    const button = Array.from(document.querySelectorAll('.sabor-btn'))
        .find(item => item.dataset.nombre === n);
    const check = button?.querySelector('.check-icon');
    const label = button?.querySelector('span');
    const selected = saboresElegidos.includes(n);
    if (button && check) {
        button.classList.toggle('bg-sky-500', selected);
        button.classList.toggle('border-sky-500', selected);
        button.classList.toggle('bg-slate-900', !selected);
        button.classList.toggle('border-slate-700', !selected);
        label?.classList.toggle('text-white', selected);
        label?.classList.toggle('text-slate-300', !selected);
        check.classList.toggle('bg-white/30', selected);
        check.classList.toggle('border', !selected);
        check.classList.toggle('border-slate-500', !selected);
        check.classList.toggle('border-transparent', selected);
        check.innerHTML = selected
            ? '<i data-lucide="check" class="w-3 h-3 text-white"></i>'
            : '';
        window.lucide?.createIcons({ root: button });
    }
    
    const countEl = document.getElementById('builder-count');
    if (countEl) countEl.textContent = saboresElegidos.length;
    // Auto-avanzar si llega al límite
    if (saboresElegidos.length === limite && limite !== 999) {
        window.toggleAcordeon('toppings');
    }
}

function cerrarModalArmar() { 
    const m = document.getElementById('modal-armar-vaso'); 
    if(m) {
        m.classList.add('opacity-0', 'pointer-events-none'); 
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
    const cupState = resolveCupConsumption(
        vasoActual,
        tamanoElegido,
        getEffectiveSaleLocalId()
    );
    if (cupState.controlled && !cupState.available) {
        window.mostrarToast?.(
            'Vaso no disponible',
            cupState.reason || 'Revisa el inventario de vasos.',
            'amber'
        );
        renderTamanosUI();
        return;
    }
    const saboresDetalle = saboresElegidos.map(nombre => {
        const producto = state.productos.find(product => (
            String(product.categoria || '').toLowerCase() === 'sabor' &&
            product.nombre === nombre &&
            isProductAvailableForLocal(product, getEffectiveSaleLocalId())
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
        isYape: false,
        ...(cupState.consumption
            ? { consumoVaso: { ...cupState.consumption } }
            : {})
    });
    
    cerrarModalArmar(); 
    actualizarCarritoUI();
}

// ========================================================
// GESTIÓN DEL CARRITO
// ========================================================
function agregarExtra(id) {
    if (isSaleInteractionLocked()) return;
    const p = getProductById(id);
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
            const isBlocked = isSaleInteractionLocked();
            btn.classList.toggle('opacity-50', isBlocked);
            btn.classList.toggle('cursor-not-allowed', isBlocked);
            btn.disabled = isBlocked;
            if (!ventaEnProceso && cobroButtonDefaultHtml) {
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

function getCurrentCatalogUnitPrice(item, localId, catalogById) {
    const product = catalogById.get(item.productoId);
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
    let selectedSize = null;
    if (sizes.length > 0) {
        const requestedSize = String(item.tamano || '').trim().toLowerCase();
        selectedSize = sizes.find(size => (
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

    const cupState = resolveCupConsumption(
        product,
        selectedSize,
        localId,
        catalogById
    );
    if (cupState.controlled && !cupState.available) {
        throw new SalesIntegrityError(
            'insufficient-stock',
            cupState.reason || `No hay vasos disponibles para "${item.nombre || 'un producto'}".`
        );
    }
    const frozenCup = item.consumoVaso;
    if (cupState.controlled) {
        if (
            !frozenCup
            || String(frozenCup.insumoId || '') !== cupState.consumption.insumoId
            || Number(frozenCup.unidades || 0) !== cupState.consumption.unidades
        ) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `El vaso asignado a "${item.nombre || 'un producto'}" cambió. Retíralo y vuelve a agregarlo.`
            );
        }
    } else if (frozenCup?.insumoId) {
        throw new SalesIntegrityError(
            'catalog-changed',
            `El control de vaso de "${item.nombre || 'un producto'}" cambió. Retíralo y vuelve a agregarlo.`
        );
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
        const toppingProduct = catalogById.get(toppingId);
        if (!toppingId || !toppingProduct) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `Un topping de "${item.nombre || 'un producto'}" ya no está disponible.`
            );
        }
        if (!isProductAvailableForLocal(toppingProduct, localId)) {
            throw new SalesIntegrityError(
                'product-out-of-location',
                `Un topping de "${item.nombre || 'un producto'}" pertenece a otra sede.`
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
        currentCost: Number(product.costo || 0),
        cupConsumption: cupState.consumption
    };
}

function validateFreshCatalogPricing(
    items,
    localId,
    catalogById = getIndexedProductsById()
) {
    if (!Array.isArray(state.productos) || state.productos.length === 0) {
        throw new SalesIntegrityError(
            'catalog-not-available',
            'El catálogo local todavía no está disponible.'
        );
    }

    items.forEach(item => {
        const isAdjustment = item.productoId === 'AJUSTE' || item.categoria === 'ajuste';
        if (isAdjustment) return;

        const { expectedPrice, currentCost } = getCurrentCatalogUnitPrice(
            item,
            localId,
            catalogById
        );
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

function getLocallyRequiredStock(nextMovements, previousMovements = []) {
    const quantities = new Map();
    const add = (movement, multiplier) => {
        if (movement?.stockAfectado === false) return;
        const productId = String(movement?.productoId || '');
        const quantity = Number(movement?.cantidad);
        if (!productId || !Number.isInteger(quantity) || quantity <= 0) return;
        quantities.set(
            productId,
            (quantities.get(productId) || 0) + (multiplier * quantity)
        );
    };
    (Array.isArray(nextMovements) ? nextMovements : [])
        .forEach(movement => add(movement, 1));
    (Array.isArray(previousMovements) ? previousMovements : [])
        .forEach(movement => add(movement, -1));
    return quantities;
}

function validateLocalInventoryAvailability(
    movements,
    previousMovements = [],
    productsById = getIndexedProductsById()
) {
    getLocallyRequiredStock(movements, previousMovements)
        .forEach((requested, productId) => {
        if (requested <= 0) return;
        const product = productsById.get(productId);
        if (!product || product.stock === null || product.stock === undefined || product.stock === '') {
            return;
        }
        const available = Number(product.stock);
        if (
            !Number.isFinite(available)
            || !Number.isInteger(requested)
            || requested <= 0
            || available < requested
        ) {
            throw new SalesIntegrityError(
                'insufficient-stock',
                `Stock insuficiente para ${product.nombre || 'un producto'}.`,
                {
                    productoId: product.id,
                    productoNombre: product.nombre || '',
                    disponible: Number.isFinite(available) ? available : 0,
                    solicitado: requested
                }
            );
        }
    });
}

function buildSaleAttemptFingerprint({
    editContext,
    cart,
    totals,
    payment,
    localId,
    clientName
}) {
    return JSON.stringify({
        saleId: editContext?.saleId || '',
        lockToken: editContext?.lockToken || '',
        expectedRevision: Number(editContext?.expectedRevision || 0),
        cart,
        totals,
        payment,
        localId,
        clientName
    });
}

function getCoalesciblePendingCreate(editContext) {
    if (
        editContext?.localPendingCreate !== true
        || !editContext.pendingCreateQueueId
        || !editContext.pendingCreateOperationId
    ) return null;

    const operation = getPendingSyncOperationById(
        editContext.pendingCreateQueueId
    );
    return (
        operation
        && operation.type === 'sale.save'
        && ['queued', 'retry'].includes(operation.status)
        && operation.payload?.editContext == null
        && operation.payload?.saleId === editContext.saleId
        && operation.payload?.operationId === editContext.pendingCreateOperationId
        && Boolean(editContext.pendingCreateVersion)
        && operation.version === editContext.pendingCreateVersion
    )
        ? operation
        : null;
}

function resolveSaleAttempt({ editContext, cart, totals, payment, localId, clientName }) {
    const fingerprint = buildSaleAttemptFingerprint({
        editContext,
        cart,
        totals,
        payment,
        localId,
        clientName
    });

    const currentAttempt = state.pendingSaleAttempt;
    const sameFingerprint = currentAttempt?.fingerprint === fingerprint;
    const coalescibleCreate = getCoalesciblePendingCreate(editContext);
    const staleCoalesceAttempt = Boolean(
        editContext?.localPendingCreate
        && currentAttempt?.operationId === editContext.pendingCreateOperationId
        && !coalescibleCreate
    );
    if (
        !sameFingerprint
        || currentAttempt?.status === 'failed'
        || staleCoalesceAttempt
    ) {
        setPendingSaleAttempt({
            fingerprint,
            saleId: sameFingerprint
                ? currentAttempt.saleId
                : (editContext?.saleId || createUuid('T-')),
            operationId:
                coalescibleCreate?.payload?.operationId
                || createUuid('OP-'),
            queueVersion: String(coalescibleCreate?.version || ''),
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

function renderAcceptedSaleImmediately() {
    const list = document.getElementById('carrito-items');
    const emptyState = document.getElementById('carrito-vacio');
    const total = document.getElementById('carrito-total');
    const processButton = document.getElementById('btn-procesar-cobro');
    const clearButton = document.getElementById('btn-vaciar-carrito');

    if (list) {
        list.innerHTML = '';
        list.classList.add('hidden');
    }
    emptyState?.classList.remove('hidden');
    if (total) total.textContent = formatMoney(0);
    if (processButton) {
        processButton.disabled = true;
        processButton.classList.add('opacity-50', 'cursor-not-allowed');
        if (cobroButtonDefaultHtml) {
            processButton.innerHTML = cobroButtonDefaultHtml;
        }
    }
    if (clearButton) {
        clearButton.disabled = false;
        clearButton.classList.remove('opacity-50', 'cursor-not-allowed');
    }
    window.dispatchEvent(new Event('icepos:update-safety-changed'));
}

function scheduleFullSaleUiRefreshAfterPaint() {
    const refresh = () => {
        setTimeout(() => actualizarCarritoUI(), 0);
    };
    if (
        typeof requestAnimationFrame === 'function'
        && document.visibilityState !== 'hidden'
    ) {
        requestAnimationFrame(refresh);
        return;
    }
    refresh();
}

function showSaleError(error) {
    console.error('No se pudo confirmar la venta:', error);
    let message = error?.message || 'No se pudo confirmar la venta.';

    if (error?.code === 'unavailable' || error?.code === 'failed-precondition') {
        message = 'Necesitas conexión estable para confirmar la venta. El carrito se conservó.';
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

function restorePaymentFromSale(sale = {}) {
    const method = String(sale.metodoFinal || sale.metodo_pago || 'efectivo').toLowerCase();
    const paymentRadio = document.querySelector(
        `input[name="metodo_pago"][value="${method}"]`
    );
    if (paymentRadio) {
        paymentRadio.checked = true;
        window.toggleMetodoPago?.(method);
    }
    if (method === 'mixto') {
        const cashInput = document.getElementById('input-mixto-efectivo');
        const digitalInput = document.getElementById('input-mixto-yape');
        if (cashInput) {
            cashInput.value = Number(
                sale.pagoEfectivo ?? sale.pago_efectivo ?? 0
            ).toFixed(2);
        }
        if (digitalInput) {
            digitalInput.value = Number(
                sale.pagoYape ?? sale.pago_yape ?? 0
            ).toFixed(2);
        }
    }
    const clientInput = document.getElementById('input-cliente-nombre');
    if (clientInput) clientInput.value = String(sale.clienteNombre || '');
}

function setRecoveredSaleAttempt(
    operation,
    sale,
    editContext,
    cart,
    relatedQueueIds = [operation?.id]
) {
    const payment = {
        method: String(sale.metodoFinal || sale.metodo_pago || 'efectivo').toLowerCase(),
        cash: Number(sale.pagoEfectivo ?? sale.pago_efectivo ?? 0),
        digital: Number(sale.pagoYape ?? sale.pago_yape ?? 0)
    };
    const totals = {
        total: Number(sale.total || 0),
        cost: Number(sale.costoTotal ?? sale.costo_total ?? 0)
    };
    const localId = String(
        editContext?.localId
        || sale.localId
        || state.userLocalId
        || 'general'
    );
    const clientName = String(sale.clienteNombre || '');
    setPendingSaleAttempt({
        fingerprint: buildSaleAttemptFingerprint({
            editContext,
            cart,
            totals,
            payment,
            localId,
            clientName
        }),
        saleId: String(operation.payload?.saleId || sale.id || ''),
        operationId: String(operation.payload?.operationId || ''),
        queueVersion: String(operation.version || ''),
        status: 'failed',
        updatedAt: Date.now(),
        lastErrorCode: String(operation.lastErrorCode || 'unknown')
    });
    recoveredFailedSaleOperation = {
        queueId: operation.id,
        queueIds: [...new Set(
            relatedQueueIds
                .map(value => String(value || ''))
                .filter(Boolean)
        )],
        operationId: String(operation.payload?.operationId || '')
    };
}

async function discardRecoverySlotForOperation(operation) {
    if (
        !activeSaleDraftScope
        || !operation?.payload?.operationId
        || !operation?.version
    ) return;
    try {
        await deleteSaleRecoveryDraft(activeSaleDraftScope, {
            operationId: operation.payload.operationId,
            queueVersion: operation.version
        });
    } catch (error) {
        reportDraftStorageFailure(error);
    }
}

async function recoverFailedSaleOperation(
    operation,
    relatedQueueIds = [operation?.id]
) {
    const recoveryGeneration = ventasSessionGeneration;
    if (
        failedSaleRecoveryInProgress
        || operation?.type !== 'sale.save'
        || !recoveryStillBelongsToSession(operation, recoveryGeneration)
        || state.carrito.length > 0
        || window.ticketEditadoContext?.saleId
    ) return false;

    const restoredCart = sanitizeRestoredCart(operation.payload?.sale?.items);
    if (!restoredCart?.length) return false;
    const recoveryToken = {};
    failedSaleRecoveryInProgress = true;
    failedSaleRecoveryToken = recoveryToken;

    const sale = operation.payload.sale;
    const editContext = operation.payload?.editContext || null;
    replaceCart(restoredCart);
    setRecoveredSaleAttempt(
        operation,
        sale,
        editContext,
        restoredCart,
        relatedQueueIds
    );
    restorePaymentFromSale(sale);

    if (!editContext) {
        actualizarCarritoUI();
        await persistCurrentSaleDraft({ immediate: true });
        await discardRecoverySlotForOperation(operation);
        if (!recoveryStillBelongsToSession(operation, recoveryGeneration)) {
            finishFailedSaleRecovery(recoveryToken);
            return false;
        }
        window.switchView?.('ventas');
        window.mostrarToast?.(
            'Carrito recuperado',
            'Corrige el problema indicado y vuelve a procesar la venta.',
            'amber'
        );
        finishFailedSaleRecovery(recoveryToken);
        return true;
    }

    const expectedRevision = Number(editContext.expectedRevision || 1);
    const recoveryContext = {
        ...clonePlainValue(editContext),
        lockPending: true,
        lockExpiresAtMs: editContext.localPendingCreate
            ? 0
            : getTrustedNowMs() + EDIT_LOCK_HEARTBEAT_INTERVAL_MS
    };
    window.ticketEditadoOriginal = true;
    window.ticketEditadoContext = recoveryContext;
    actualizarCarritoUI();
    window.switchView?.('ventas');

    if (recoveryContext.localPendingCreate === true) {
        await persistCurrentSaleDraft({ immediate: true });
        await discardRecoverySlotForOperation(operation);
        if (
            !recoveryStillBelongsToSession(operation, recoveryGeneration)
            || window.ticketEditadoContext?.saleId !== recoveryContext.saleId
            || window.ticketEditadoContext?.lockToken !== recoveryContext.lockToken
        ) {
            finishFailedSaleRecovery(recoveryToken);
            return false;
        }
        window.mostrarToast?.(
            'Edición local recuperada',
            'Tus cambios volvieron al carrito y se guardarán en orden.',
            'amber'
        );
        finishFailedSaleRecovery(recoveryToken);
        return true;
    }

    const acquisition = acquireSaleEditLock({
        saleId: recoveryContext.saleId,
        lockToken: recoveryContext.lockToken,
        ownerId: recoveryContext.lockOwnerId || state.currentUser?.uid,
        ownerName: recoveryContext.lockOwnerName
            || state.currentUser?.username
            || state.currentUser?.email
            || 'Usuario',
        expectedRevision
    }).then(async lockResult => {
        const recoveryBecameObsolete = (
            !recoveryStillBelongsToSession(operation, recoveryGeneration)
            || window.ticketEditadoContext?.saleId !== recoveryContext.saleId
            || window.ticketEditadoContext?.lockToken !== recoveryContext.lockToken
        );
        if (recoveryBecameObsolete) {
            void releaseSaleEditLock({
                saleId: recoveryContext.saleId,
                lockToken: recoveryContext.lockToken,
                actor: recoveryContext.lockOwnerName || 'Usuario',
                reason: 'recuperacion_edicion_obsoleta'
            }).catch(() => {});
            return false;
        }
        if (Number(lockResult.expectedRevision || 1) !== expectedRevision) {
            await releaseSaleEditLock({
                saleId: recoveryContext.saleId,
                lockToken: recoveryContext.lockToken,
                actor: recoveryContext.lockOwnerName || 'Usuario',
                reason: 'recuperacion_edicion_en_conflicto'
            }).catch(() => {});
            throw Object.assign(
                new Error('El pedido cambió. Ábrelo nuevamente desde Pedidos.'),
                { code: 'edit-conflict' }
            );
        }
        window.ticketEditadoContext = {
            ...recoveryContext,
            expectedRevision: lockResult.expectedRevision,
            lockExpiresAtMs: lockResult.expiresAtMs,
            lockPending: false
        };
        setRecoveredSaleAttempt(
            operation,
            sale,
            window.ticketEditadoContext,
            restoredCart,
            relatedQueueIds
        );
        await persistCurrentSaleDraft({ immediate: true });
        await discardRecoverySlotForOperation(operation);
        if (
            !recoveryStillBelongsToSession(operation, recoveryGeneration)
            || window.ticketEditadoContext?.saleId !== recoveryContext.saleId
            || window.ticketEditadoContext?.lockToken !== recoveryContext.lockToken
        ) return false;
        scheduleEditLockHeartbeat();
        actualizarCarritoUI();
        window.mostrarToast?.(
            'Edición recuperada',
            'Tus cambios volvieron al carrito. Corrige el problema y guárdalos otra vez.',
            'amber'
        );
        return true;
    }).catch(async error => {
        if (!recoveryStillBelongsToSession(operation, recoveryGeneration)) {
            return false;
        }
        console.warn('No se pudo recuperar la edición fallida:', error);
        if (isTemporaryEditLockError(error)) {
            if (
                window.ticketEditadoContext?.saleId !== recoveryContext.saleId
                || window.ticketEditadoContext?.lockToken !== recoveryContext.lockToken
            ) return false;
            window.ticketEditadoContext = {
                ...recoveryContext,
                lockPending: true,
                lockExpiresAtMs: 0
            };
            setRecoveredSaleAttempt(
                operation,
                sale,
                window.ticketEditadoContext,
                restoredCart,
                relatedQueueIds
            );
            await persistCurrentSaleDraft({ immediate: true });
            await discardRecoverySlotForOperation(operation);
            if (
                !recoveryStillBelongsToSession(operation, recoveryGeneration)
                || window.ticketEditadoContext?.saleId !== recoveryContext.saleId
                || window.ticketEditadoContext?.lockToken !== recoveryContext.lockToken
            ) return false;
            actualizarCarritoUI();
            window.mostrarToast?.(
                'Edición recuperada sin conexión',
                'Tus cambios siguen locales y se validarán al volver la conexión.',
                'amber'
            );
            return true;
        }
        clearCart();
        setPendingSaleAttempt(null);
        recoveredFailedSaleOperation = null;
        window.ticketEditadoOriginal = false;
        window.ticketEditadoContext = null;
        resetPaymentInputs();
        actualizarCarritoUI();
        void persistCurrentSaleDraft({ immediate: true });
        window.mostrarAlerta?.(
            'Edición pendiente de revisión',
            error?.message || 'El pedido cambió. Ábrelo nuevamente desde Pedidos.',
            'amber'
        );
        return false;
    }).finally(() => {
        if (window.ticketEditLockPromise === acquisition) {
            window.ticketEditLockPromise = null;
        }
        finishFailedSaleRecovery(recoveryToken);
    });
    window.ticketEditLockPromise = acquisition;
    return acquisition;
}

async function recoverNextFailedSaleOperation() {
    const recoveryGeneration = ventasSessionGeneration;
    const recoveryOwnerId = String(state.currentUser?.uid || '');
    if (
        failedSaleRecoveryInProgress
        || state.carrito.length > 0
        || window.ticketEditadoContext?.saleId
    ) return false;
    try {
        const failedOperations = await getFailedSyncOperations();
        if (
            recoveryGeneration !== ventasSessionGeneration
            || recoveryOwnerId !== String(state.currentUser?.uid || '')
        ) return false;
        const latestBySale = new Map();
        failedOperations.filter(operation => (
            operation.type === 'sale.save'
            && operation.payload?.sale?.items
        )).forEach(operation => {
            const saleId = String(operation.payload?.saleId || '');
            const previous = latestBySale.get(saleId);
            if (
                !previous
                || Number(operation.createdAt || 0) > Number(previous.createdAt || 0)
            ) {
                latestBySale.set(saleId, operation);
            }
        });
        const saleOperation = [...latestBySale.values()]
            .sort((left, right) => (
                Number(left.createdAt || 0) - Number(right.createdAt || 0)
            ))[0];
        const relatedQueueIds = saleOperation
            ? failedOperations.filter(candidate => (
                candidate.type === 'sale.save'
                && candidate.payload?.saleId
                    === saleOperation.payload?.saleId
            )).map(candidate => candidate.id)
            : [];
        return saleOperation
            ? recoverFailedSaleOperation(saleOperation, relatedQueueIds)
            : false;
    } catch (error) {
        console.warn('No se pudo revisar las ventas locales pendientes:', error);
        return false;
    }
}

function handleSaleSyncFailure(event) {
    const operation = event.detail?.operation;
    if (operation?.type !== 'sale.save') return;
    const failureGeneration = ventasSessionGeneration;
    if (!recoveryStillBelongsToSession(operation, failureGeneration)) return;
    if (state.carrito.length > 0 || window.ticketEditadoContext?.saleId) {
        window.mostrarToast?.(
            'Venta no sincronizada',
            'Termina la venta actual; después se recuperará la operación pendiente.',
            'amber'
        );
        return;
    }
    setTimeout(() => {
        void (async () => {
            if (!recoveryStillBelongsToSession(operation, failureGeneration)) return;
            const hasNewerSaleIntent = getPendingSyncOperationsForEntity(
                `ventas/${operation.payload?.saleId || ''}`
            ).some(candidate => (
                candidate.type === 'sale.save'
                && candidate.payload?.saleId === operation.payload?.saleId
                && Number(candidate.createdAt || 0) > Number(operation.createdAt || 0)
            ));
            if (hasNewerSaleIntent) return;

            let relatedFailures = [operation];
            try {
                const failedOperations = await getFailedSyncOperations();
                relatedFailures = failedOperations.filter(candidate => (
                    candidate.type === 'sale.save'
                    && candidate.payload?.saleId === operation.payload?.saleId
                ));
            } catch (_) {}
            if (
                !recoveryStillBelongsToSession(operation, failureGeneration)
                || relatedFailures.length === 0
            ) return;
            const latestFailure = relatedFailures.sort((left, right) => (
                Number(right.createdAt || 0) - Number(left.createdAt || 0)
            ))[0];
            void recoverFailedSaleOperation(
                latestFailure,
                relatedFailures.map(candidate => candidate.id)
            );
        })();
    }, 0);
}

function procesarCobroFinal() {
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
    let saleWasAccepted = false;
    let finishPersistenceGuard = null;
    let persistenceBarrier = null;
    let persistenceBarrierHasProducer = false;
    preparacionVentaEnProceso = true;

    try {
        const cart = cloneCart(state.carrito);
        const editContext = window.ticketEditadoContext
            ? clonePlainValue(window.ticketEditadoContext)
            : null;
        if (window.ticketEditadoOriginal && !editContext?.saleId) {
            throw new SalesIntegrityError(
                'missing-sale-edit-context',
                'Vuelve a abrir el pedido desde Pedidos antes de guardar los cambios.'
            );
        }
        const localId = editContext?.localId || state.userLocalId || 'general';
        if (!editContext) validateFreshCatalogPricing(cart, localId);
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
        finishPersistenceGuard = beginSalePersistenceGuard();
        const { saleId, operationId } = activeAttempt;
        const supersededRecovery = recoveredFailedSaleOperation;
        const actor = state.currentUser?.username || state.currentUser?.email || 'Desconocido';
        const inventoryMovements = buildInventoryMovements(
            cart,
            state.productos,
            localId
        );
        validateLocalInventoryAvailability(
            inventoryMovements,
            editContext?.originalInventoryMovements
                || editContext?.legacyInventoryMovements
                || []
        );

        const sale = {
            fechaStr: getTodayDateStr(),
            fechaHora: (
                editContext
                && Number.isFinite(Number(editContext.originalFechaHora))
                && Number(editContext.originalFechaHora) > 0
            )
                ? Number(editContext.originalFechaHora)
                : getTrustedNowMs(),
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

        persistenceBarrier = createDeferredBoolean();
        const queueReceipt = saveSaleTransaction({
            saleId,
            operationId,
            sale,
            inventoryMovements,
            editContext,
            cupControlDate: getTodayDateStr(),
            persistAfter: persistenceBarrier.promise,
            supersedesQueueIds: (
                supersededRecovery?.queueId
                && supersededRecovery.operationId !== operationId
            )
                ? (
                    supersededRecovery.queueIds?.length
                        ? supersededRecovery.queueIds
                        : [supersededRecovery.queueId]
                )
                : []
        });
        saleWasAccepted = true;
        const acceptedOperationId =
            queueReceipt.operationId || operationId;
        activeAttempt = {
            ...activeAttempt,
            operationId: acceptedOperationId,
            queueVersion: String(queueReceipt.version || ''),
            status: 'queued',
            updatedAt: Date.now(),
            lastErrorCode: ''
        };
        setPendingSaleAttempt(activeAttempt);
        const acceptedSaleDraft = {
            ...buildCurrentSaleDraft(),
            intentToken: createUuid('DRAFT-')
        };
        const currentDraftPromise = persistCurrentSaleDraft({
            immediate: true,
            draftSnapshot: acceptedSaleDraft
        });
        const recoveryDraftPromise = saveSaleRecoveryDraft(
            saleDraftScope,
            acceptedSaleDraft
        ).then(record => Boolean(record)).catch(error => {
            reportDraftStorageFailure(error);
            return false;
        });
        const draftSafetyPromise = Promise.all([
            currentDraftPromise,
            recoveryDraftPromise
        ]);
        persistenceBarrierHasProducer = true;
        void draftSafetyPromise.then(() => {
            // Aunque el borrador falle, la outbox todavía puede quedar durable.
            // Esperamos el intento y luego dejamos que ambas capas se respalden.
            persistenceBarrier.resolve(true);
        }).catch(() => {
            persistenceBarrier.resolve(true);
        });
        const cleanupToken = {
            scopeKey: saleDraftScope?.key || '',
            operationId: acceptedOperationId,
            queueVersion: activeAttempt.queueVersion
        };
        deferredSaleDraftCleanup = cleanupToken;
        recoveredFailedSaleOperation = null;
        limpiarCarritoYEdicion(true, {
            discardDraft: false,
            discardRecoveredOperation: false
        });
        resetPaymentInputs();
        preparacionVentaEnProceso = false;
        renderAcceptedSaleImmediately();

        if(window.mostrarToast) {
            const shortId = saleId.replace(/^T-/, '').slice(0, 8).toUpperCase();
            window.mostrarToast(
                editContext ? 'Cambios guardados' : 'Venta guardada',
                `Ticket #${shortId} registrado en este dispositivo y sincronizándose.`,
                'emerald'
            );
        }

        void draftSafetyPromise;
        const releasePersistenceGuard = finishPersistenceGuard;
        finishPersistenceGuard = null;
        void queueReceipt.persisted.then(async () => {
            const cleanupStillBelongsToThisSale = (
                deferredSaleDraftCleanup === cleanupToken
            );
            const scopeIsNoLongerActive = (
                saleDraftScope?.key
                && activeSaleDraftScope?.key !== saleDraftScope.key
            );
            if (cleanupStillBelongsToThisSale) {
                deferredSaleDraftCleanup = null;
            }
            const cleanupPromises = [];
            if (cleanupStillBelongsToThisSale || scopeIsNoLongerActive) {
                cleanupPromises.push(discardSaleDraft(saleDraftScope, {
                    expectedAttempt: cleanupToken
                }));
            }
            cleanupPromises.push(deleteSaleRecoveryDraft(
                saleDraftScope,
                cleanupToken
            ).catch(error => {
                reportDraftStorageFailure(error);
            }));
            await Promise.all(cleanupPromises);
            setTimeout(() => {
                void recoverNextFailedSaleOperation()
                    .catch(() => false)
                    .then(() => recoverNextSaleRecoveryDraft());
            }, 0);
        }).catch(error => {
            if (deferredSaleDraftCleanup === cleanupToken) {
                deferredSaleDraftCleanup = null;
            }
            console.warn(
                'La venta quedó pendiente de recuperar en este dispositivo:',
                error
            );
            void recoverDraftAfterQueuePersistenceFailure({
                scope: saleDraftScope,
                sessionGeneration,
                ownerId: saleDraftScope?.uid
            });
        }).finally(() => {
            releasePersistenceGuard?.();
        });
    } catch (err) {
        if (persistenceBarrier && !persistenceBarrierHasProducer) {
            const emergencyDraft = {
                ...buildCurrentSaleDraft(),
                intentToken: createUuid('DRAFT-')
            };
            const emergencyDraftPromise = Promise.all([
                persistCurrentSaleDraft({
                    immediate: true,
                    draftSnapshot: emergencyDraft
                }),
                saveSaleRecoveryDraft(
                    saleDraftScope,
                    emergencyDraft
                ).catch(error => {
                    reportDraftStorageFailure(error);
                    return null;
                })
            ]);
            persistenceBarrierHasProducer = true;
            void emergencyDraftPromise.then(() => {
                persistenceBarrier.resolve(true);
            }).catch(() => {
                persistenceBarrier.resolve(true);
            });
        }
        if (
            !saleWasAccepted
            &&
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
            void persistCurrentSaleDraft({ immediate: true });
        }
        if (
            !saleWasAccepted
            && sessionGeneration === ventasSessionGeneration
        ) {
            showSaleError(err);
        } else if (saleWasAccepted) {
            console.error(
                'La venta quedó aceptada, pero falló una actualización visual:',
                err
            );
        }
    } finally {
        finishPersistenceGuard?.();
        if (sessionGeneration === ventasSessionGeneration) {
            preparacionVentaEnProceso = false;
            if (saleWasAccepted) {
                scheduleFullSaleUiRefreshAfterPaint();
            } else {
                setSaleControlsLocked(false, originalButtonHtml);
                actualizarCarritoUI();
            }
        }
    }
}
