const DATABASE_NAME = 'raffaelito-pos-sync';
const DATABASE_VERSION = 2;
const STORE_NAME = 'operations';
const LEASE_STORE_NAME = 'leases';
const WORKER_LOCK_NAME = 'raffaelito-pos-sync-worker';
const CHANNEL_NAME = 'raffaelito-pos-sync-events';
const FALLBACK_LEASE_KEY = 'raffaelito-pos-sync-worker-lease';
const FALLBACK_LEASE_TTL_MS = 120_000;
const FALLBACK_LEASE_RENEW_MS = 30_000;
const COMMITTED_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60_000;

const handlers = new Map();
const operations = new Map();
const pendingPersistenceRecords = new Map();
const persistenceRetryTimers = new Map();
let databasePromise = null;
let initializationPromise = null;
let workerPromise = null;
let retryTimer = null;
let activeOwnerId = '';
let queueEnabled = false;
let workerGeneration = 0;
let lifecycleInstalled = false;
let channel = null;
let optimisticQueueChangedTimer = null;

const TRANSIENT_ERROR_CODES = new Set([
    'aborted',
    'cancelled',
    'deadline-exceeded',
    'internal',
    'network-request-failed',
    'resource-exhausted',
    'sync-auth-not-ready',
    'unauthenticated',
    'unavailable'
]);

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function openDatabase() {
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB no está disponible en este navegador.'));
            return;
        }

        let settled = false;
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            databasePromise = null;
            reject(new Error('El almacenamiento local tardó demasiado en responder.'));
        }, 5_000);

        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('ownerId', 'ownerId');
                store.createIndex('status', 'status');
                store.createIndex('createdAt', 'createdAt');
            }
            if (!database.objectStoreNames.contains(LEASE_STORE_NAME)) {
                database.createObjectStore(LEASE_STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => {
            if (settled) {
                request.result.close();
                return;
            }
            settled = true;
            clearTimeout(timeout);
            const database = request.result;
            database.onversionchange = () => {
                database.close();
                databasePromise = null;
                initializationPromise = null;
            };
            resolve(database);
        };
        request.onerror = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            databasePromise = null;
            reject(request.error || new Error('No se pudo abrir la cola local.'));
        };
        request.onblocked = () => {
            console.warn('La cola local espera que otra pestaña termine de actualizarse.');
        };
    });

    return databasePromise;
}

async function runStoreRequest(mode, operation) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        let request;

        try {
            request = operation(store);
        } catch (error) {
            reject(error);
            return;
        }

        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(
            transaction.error || request?.error || new Error('Falló la cola local.')
        );
        transaction.onabort = () => reject(
            transaction.error || new Error('Se canceló una operación de la cola local.')
        );
    });
}

function getAllRecords() {
    return runStoreRequest('readonly', store => store.getAll());
}

function putRecord(record) {
    return runStoreRequest('readwrite', store => store.put(record));
}

function deleteRecord(id) {
    return runStoreRequest('readwrite', store => store.delete(id));
}

async function runLeaseTransaction(operation) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(LEASE_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(LEASE_STORE_NAME);
        let result = null;

        try {
            operation(store, value => {
                result = value;
            });
        } catch (error) {
            reject(error);
            return;
        }

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(
            transaction.error || new Error('Falló el bloqueo local de sincronización.')
        );
        transaction.onabort = () => reject(
            transaction.error || new Error('Se canceló el bloqueo local de sincronización.')
        );
    });
}

function normalizeLoadedRecord(record) {
    if (!record?.id || !record?.type || !record?.ownerId) return null;
    const status = record.status === 'syncing' ? 'retry' : record.status;
    return {
        ...record,
        status: ['queued', 'retry', 'syncing', 'failed', 'committed'].includes(status)
            ? status
            : 'queued',
        attempts: Math.max(0, Number(record.attempts) || 0),
        nextAttemptAt: Math.max(0, Number(record.nextAttemptAt) || 0),
        createdAt: Number(record.createdAt) || Date.now(),
        updatedAt: Number(record.updatedAt) || Date.now(),
        optimisticMutations: Array.isArray(record.optimisticMutations)
            ? record.optimisticMutations
            : [],
        dependsOnOperationIds: [...new Set(
            (Array.isArray(record.dependsOnOperationIds)
                ? record.dependsOnOperationIds
                : [])
                .map(value => String(value || '').trim())
                .filter(value => value && value !== String(record.id))
        )]
    };
}

function isVisiblePending(record) {
    return (
        record
        && record.ownerId === activeOwnerId
        && ['queued', 'retry', 'syncing'].includes(record.status)
    );
}

function emitWindowEvent(name, detail) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
}

function getPublicOperation(record) {
    return {
        id: record.id,
        type: record.type,
        ownerId: record.ownerId,
        localId: record.localId || '',
        status: record.status,
        attempts: record.attempts,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        payload: cloneValue(record.payload),
        dependsOnOperationIds: [...(record.dependsOnOperationIds || [])],
        lastErrorCode: record.lastErrorCode || '',
        lastErrorMessage: record.lastErrorMessage || ''
    };
}

function notifyPeers(message = { type: 'refresh' }) {
    try {
        channel?.postMessage(message);
    } catch (_) {}
}

function emitQueueChanged({ broadcast = true } = {}) {
    emitWindowEvent('icepos:sync-queue-changed', getSyncQueueSummary());
    if (broadcast) notifyPeers();
}

function scheduleOptimisticQueueChanged() {
    if (optimisticQueueChangedTimer) return;
    optimisticQueueChangedTimer = setTimeout(() => {
        optimisticQueueChangedTimer = null;
        emitQueueChanged();
    }, 0);
}

async function reloadOperationsFromStorage() {
    const rows = await getAllRecords();
    const volatileRows = [...pendingPersistenceRecords.values()];
    operations.clear();
    const normalizedRows = rows.map(normalizeLoadedRecord).filter(Boolean);
    normalizedRows.forEach(record => {
        operations.set(record.id, record);
    });
    // Una operación recién creada debe aparecer inmediatamente aunque IndexedDB
    // todavía esté escribiendo. La conservamos al recargar la cola para que una
    // sincronización de otra pestaña no la borre de memoria.
    volatileRows.forEach(record => {
        const stored = operations.get(record.id);
        if (!stored || Number(record.updatedAt) >= Number(stored.updatedAt || 0)) {
            operations.set(record.id, record);
        }
    });
    for (const record of normalizedRows) {
        if (
            record.status !== 'committed'
            || Number(record.committedAt || record.updatedAt)
                >= Date.now() - COMMITTED_TOMBSTONE_TTL_MS
        ) continue;
        try {
            await deleteRecord(record.id);
            operations.delete(record.id);
        } catch (error) {
            console.warn('Quedó pendiente limpiar una operación ya confirmada:', error);
        }
    }
    emitQueueChanged({ broadcast: false });
}

async function ensureInitialized() {
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
        await reloadOperationsFromStorage();
        installLifecycleListeners();
    })().catch(error => {
        initializationPromise = null;
        throw error;
    });
    return initializationPromise;
}

function installLifecycleListeners() {
    if (lifecycleInstalled || typeof window === 'undefined') return;
    lifecycleInstalled = true;

    window.addEventListener('online', () => scheduleDrain(0));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void reloadOperationsFromStorage()
                .then(() => scheduleDrain(0))
                .catch(error => console.warn('No se pudo refrescar la cola local:', error));
        }
    });

    if (typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.addEventListener('message', event => {
            if (
                event.data?.type === 'operation-failed'
                && event.data.detail?.operation?.ownerId === activeOwnerId
            ) {
                emitWindowEvent('icepos:sync-operation-failed', event.data.detail);
            }
            void reloadOperationsFromStorage()
                .then(() => scheduleDrain(0))
                .catch(error => console.warn('No se pudo coordinar la cola entre pestañas:', error));
        });
    }
}

function scheduleRecordPersistence(recordId, delayMs = 0) {
    const normalizedId = String(recordId || '');
    if (!normalizedId || persistenceRetryTimers.has(normalizedId)) return;

    const timer = setTimeout(async () => {
        persistenceRetryTimers.delete(normalizedId);
        const record = pendingPersistenceRecords.get(normalizedId);
        if (!record) return;

        try {
            await ensureInitialized();
            const latest = operations.get(normalizedId) || record;
            await putRecord(latest);
            pendingPersistenceRecords.delete(normalizedId);
            scheduleDrain(0);
        } catch (error) {
            console.warn('La operación sigue en memoria y se reintentará guardar localmente:', error);
            const latest = operations.get(normalizedId) || record;
            pendingPersistenceRecords.set(normalizedId, latest);
            scheduleRecordPersistence(normalizedId, 1_000);
        }
    }, Math.max(0, Number(delayMs) || 0));

    persistenceRetryTimers.set(normalizedId, timer);
}

function hasUnresolvedDependency(record) {
    return (Array.isArray(record?.dependsOnOperationIds)
        ? record.dependsOnOperationIds
        : [])
        .some(dependencyId => {
            const dependency = operations.get(String(dependencyId || ''));
            return Boolean(
                dependency
                && dependency.ownerId === record.ownerId
                && dependency.status !== 'committed'
            );
        });
}

function getRetryDelay(attempts) {
    const exponential = 1_000 * (2 ** Math.min(6, Math.max(0, attempts - 1)));
    const jitter = Math.floor(Math.random() * 350);
    return Math.min(MAX_RETRY_DELAY_MS, exponential + jitter);
}

function isTransientError(error) {
    const code = String(error?.code || '').replace(/^firestore\//, '');
    return TRANSIENT_ERROR_CODES.has(code);
}

function scheduleDrain(delayMs = 0) {
    if (!queueEnabled || !activeOwnerId) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void drainQueue();
    }, Math.max(0, Number(delayMs) || 0));
}

function getFirstQueuedOperation() {
    return [...operations.values()]
        .filter(record => (
            record.ownerId === activeOwnerId
            && ['queued', 'retry'].includes(record.status)
            && handlers.has(record.type)
            && !pendingPersistenceRecords.has(record.id)
            && !hasUnresolvedDependency(record)
        ))
        .sort((left, right) => (
            left.createdAt - right.createdAt
            || left.id.localeCompare(right.id)
        ))[0] || null;
}

function getNextOperation() {
    const now = Date.now();
    const first = getFirstQueuedOperation();
    return first && first.nextAttemptAt <= now ? first : null;
}

function isCurrentWorker(ownerId, generation) {
    return (
        queueEnabled
        && activeOwnerId === ownerId
        && workerGeneration === generation
    );
}

async function failDependentOperations(failedRecord) {
    const queue = [failedRecord.id];
    const visited = new Set();
    let changed = false;

    while (queue.length > 0) {
        const failedId = queue.shift();
        if (!failedId || visited.has(failedId)) continue;
        visited.add(failedId);

        const dependents = [...operations.values()].filter(record => (
            record.ownerId === failedRecord.ownerId
            && ['queued', 'retry', 'syncing'].includes(record.status)
            && (record.dependsOnOperationIds || []).includes(failedId)
        ));

        for (const dependent of dependents) {
            dependent.status = 'failed';
            dependent.nextAttemptAt = 0;
            dependent.updatedAt = Date.now();
            dependent.lastErrorCode = 'dependency-failed';
            dependent.lastErrorMessage =
                'Una operación anterior necesaria no pudo sincronizarse.';
            operations.set(dependent.id, dependent);
            try {
                await putRecord(dependent);
            } catch (error) {
                console.warn('No se pudo persistir el error de una operación dependiente:', error);
            }
            const detail = {
                operation: getPublicOperation(dependent),
                error: {
                    code: dependent.lastErrorCode,
                    message: dependent.lastErrorMessage
                }
            };
            emitWindowEvent('icepos:sync-operation-failed', detail);
            notifyPeers({ type: 'operation-failed', detail });
            queue.push(dependent.id);
            changed = true;
        }
    }

    if (changed) emitQueueChanged();
}

async function markOperationForSessionRetry(record) {
    record.status = 'retry';
    record.nextAttemptAt = 0;
    record.updatedAt = Date.now();
    try {
        await putRecord(record);
    } catch (error) {
        console.warn('No se pudo pausar limpiamente la operación local:', error);
    }
    operations.set(record.id, record);
    emitQueueChanged();
}

async function processOperations(
    ownerId,
    generation,
    hasWorkerLease = () => true
) {
    while (isCurrentWorker(ownerId, generation) && hasWorkerLease()) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

        const record = getNextOperation();
        if (!record) {
            const nextRetry = Number(
                getFirstQueuedOperation()?.nextAttemptAt || 0
            );
            if (nextRetry > Date.now()) scheduleDrain(nextRetry - Date.now());
            return;
        }

        const handler = handlers.get(record.type);
        record.status = 'syncing';
        record.updatedAt = Date.now();
        await putRecord(record);
        operations.set(record.id, record);
        emitQueueChanged();

        try {
            const result = await handler(cloneValue(record.payload), getPublicOperation(record));
            record.status = 'committed';
            record.updatedAt = Date.now();
            record.committedAt = record.updatedAt;
            record.payload = {};
            record.optimisticMutations = [];
            try {
                await putRecord(record);
            } catch (error) {
                console.warn('No se pudo marcar localmente una operación confirmada:', error);
            }
            operations.set(record.id, record);
            emitQueueChanged();
            if (record.ownerId === activeOwnerId) {
                emitWindowEvent('icepos:sync-operation-complete', {
                    operation: getPublicOperation(record),
                    result: cloneValue(result)
                });
            }
            emitQueueChanged();
        } catch (error) {
            if (!isCurrentWorker(ownerId, generation)) {
                await markOperationForSessionRetry(record);
                return;
            }
            const code = String(error?.code || 'unknown').replace(/^firestore\//, '');
            const message = String(
                error?.message || 'No se pudo sincronizar la operación.'
            ).slice(0, 500);
            record.attempts += 1;
            record.updatedAt = Date.now();
            record.lastErrorCode = code;
            record.lastErrorMessage = message;

            if (isTransientError(error)) {
                const delay = getRetryDelay(record.attempts);
                record.status = 'retry';
                record.nextAttemptAt = Date.now() + delay;
                await putRecord(record);
                operations.set(record.id, record);
                emitQueueChanged();
                scheduleDrain(delay);
                return;
            }

            record.status = 'failed';
            record.nextAttemptAt = 0;
            await putRecord(record);
            operations.set(record.id, record);
            const detail = {
                operation: getPublicOperation(record),
                error: { code, message }
            };
            emitWindowEvent('icepos:sync-operation-failed', detail);
            notifyPeers({ type: 'operation-failed', detail });
            await failDependentOperations(record);
            emitQueueChanged();
        }
    }
}

async function acquireFallbackLease() {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    return runLeaseTransaction((store, setResult) => {
        const request = store.get(FALLBACK_LEASE_KEY);
        request.onsuccess = () => {
            const current = request.result;
            if (current?.token && Number(current.expiresAt) > now) {
                setResult(null);
                return;
            }
            store.put({
                id: FALLBACK_LEASE_KEY,
                token,
                expiresAt: now + FALLBACK_LEASE_TTL_MS
            });
            setResult(token);
        };
    });
}

async function renewFallbackLease(token) {
    if (!token) return false;
    return runLeaseTransaction((store, setResult) => {
        const request = store.get(FALLBACK_LEASE_KEY);
        request.onsuccess = () => {
            const current = request.result;
            if (current?.token !== token) {
                setResult(false);
                return;
            }
            store.put({
                id: FALLBACK_LEASE_KEY,
                token,
                expiresAt: Date.now() + FALLBACK_LEASE_TTL_MS
            });
            setResult(true);
        };
    });
}

async function releaseFallbackLease(token) {
    if (!token) return;
    await runLeaseTransaction((store, setResult) => {
        const request = store.get(FALLBACK_LEASE_KEY);
        request.onsuccess = () => {
            if (request.result?.token === token) store.delete(FALLBACK_LEASE_KEY);
            setResult(true);
        };
    });
}

async function runWithFallbackLease(ownerId, generation) {
    const token = await acquireFallbackLease();
    if (token === null) {
        scheduleDrain(1_000);
        return;
    }
    let leaseIsValid = true;
    const renewalTimer = setInterval(() => {
        void renewFallbackLease(token)
            .then(renewed => {
                if (!renewed) leaseIsValid = false;
            })
            .catch(error => {
                leaseIsValid = false;
                console.warn('No se pudo renovar el bloqueo local de sincronización:', error);
            });
    }, FALLBACK_LEASE_RENEW_MS);
    try {
        await reloadOperationsFromStorage();
        await processOperations(ownerId, generation, () => leaseIsValid);
    } finally {
        clearInterval(renewalTimer);
        await releaseFallbackLease(token).catch(error => {
            console.warn('El bloqueo local expirará automáticamente:', error);
        });
    }
}

async function runWithCrossTabLock(ownerId, generation) {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        let lockAcquired = false;
        try {
            await navigator.locks.request(
                WORKER_LOCK_NAME,
                { ifAvailable: true },
                async lock => {
                    if (!lock) return;
                    lockAcquired = true;
                    await reloadOperationsFromStorage();
                    await processOperations(ownerId, generation);
                }
            );
        } catch (error) {
            console.warn('Web Locks no está disponible; se usará el bloqueo local.', error);
            await runWithFallbackLease(ownerId, generation);
            return;
        }
        if (!lockAcquired) scheduleDrain(1_000);
        return;
    }
    await runWithFallbackLease(ownerId, generation);
}

async function drainQueue() {
    if (workerPromise || !queueEnabled || !activeOwnerId) return workerPromise;

    const ownerId = activeOwnerId;
    const generation = workerGeneration;
    workerPromise = ensureInitialized()
        .then(() => runWithCrossTabLock(ownerId, generation))
        .catch(error => {
            console.warn('La sincronización en segundo plano se pausó:', error);
            scheduleDrain(5_000);
        })
        .finally(() => {
            workerPromise = null;
            if (
                queueEnabled
                && activeOwnerId
                && (
                    activeOwnerId !== ownerId
                    || workerGeneration !== generation
                )
            ) scheduleDrain(0);
        });
    return workerPromise;
}

export function registerSyncHandler(type, handler) {
    if (!type || typeof handler !== 'function') return;
    handlers.set(type, handler);
    scheduleDrain(0);
}

export function enqueueSyncOperation({
    id,
    type,
    ownerId,
    localId = '',
    payload,
    optimisticMutations = [],
    dependsOnOperationIds = []
}) {
    if (!id || !type || !ownerId) {
        throw new Error('La operación local no tiene una identidad válida.');
    }

    const normalizedOwnerId = String(ownerId);
    if (!activeOwnerId) {
        activeOwnerId = normalizedOwnerId;
        queueEnabled = true;
        workerGeneration += 1;
    }
    const recordId = `${normalizedOwnerId}:${type}:${id}`;
    const existing = operations.get(recordId);
    if (existing && existing.status !== 'failed') {
        scheduleDrain(0);
        return {
            queued: true,
            alreadyQueued: true,
            operationId: recordId
        };
    }

    const now = Date.now();
    const record = {
        id: recordId,
        type,
        ownerId: normalizedOwnerId,
        localId: String(localId || ''),
        payload: payload || {},
        optimisticMutations: Array.isArray(optimisticMutations)
            ? optimisticMutations
            : [],
        dependsOnOperationIds: [...new Set(
            (Array.isArray(dependsOnOperationIds)
                ? dependsOnOperationIds
                : [dependsOnOperationIds])
                .map(value => String(value || '').trim())
                .filter(value => value && value !== recordId)
        )],
        status: 'queued',
        attempts: 0,
        nextAttemptAt: 0,
        lastErrorCode: '',
        lastErrorMessage: '',
        createdAt: existing?.createdAt || now,
        updatedAt: now
    };

    // Primero se publica en memoria: Caja, Pedidos e Inventario reaccionan en
    // el mismo clic. IndexedDB y Firebase trabajan después, fuera del camino
    // visible de la interfaz.
    operations.set(record.id, record);
    pendingPersistenceRecords.set(record.id, record);
    scheduleOptimisticQueueChanged();
    scheduleRecordPersistence(record.id, 0);

    return {
        queued: true,
        alreadyQueued: false,
        operationId: record.id
    };
}

export function getPendingSyncOperations() {
    return [...operations.values()]
        .filter(isVisiblePending)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(getPublicOperation);
}

export async function getSyncOperationStatus({ ownerId, type, id } = {}) {
    if (!ownerId || !type || !id) return '';
    await ensureInitialized();
    return operations.get(`${String(ownerId)}:${type}:${id}`)?.status || '';
}

export async function getFailedSyncOperations() {
    await ensureInitialized();
    return [...operations.values()]
        .filter(record => (
            record.ownerId === activeOwnerId
            && record.status === 'failed'
        ))
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(getPublicOperation);
}

export function applyPendingDocumentMutations(collectionName, rows = []) {
    const documents = new Map(
        (Array.isArray(rows) ? rows : []).map(row => [String(row.id), row])
    );

    [...operations.values()]
        .filter(isVisiblePending)
        .sort((left, right) => left.createdAt - right.createdAt)
        .forEach(record => {
            record.optimisticMutations.forEach(mutation => {
                if (
                    mutation?.collection !== collectionName
                    || !mutation.documentId
                ) return;

                const id = String(mutation.documentId);
                if (mutation.kind === 'delete') {
                    documents.delete(id);
                    return;
                }
                if (mutation.kind === 'increment') {
                    const current = documents.get(id);
                    if (!current) return;
                    const next = { ...current };
                    Object.entries(mutation.data || {}).forEach(([field, delta]) => {
                        const amount = Number(delta);
                        const rawCurrent = next[field];
                        const canDefaultToZero = field === 'ventasTotales';
                        const currentValue = (
                            rawCurrent === null
                            || rawCurrent === undefined
                            || rawCurrent === ''
                        )
                            ? (canDefaultToZero ? 0 : null)
                            : Number(rawCurrent);
                        if (
                            currentValue === null
                            || !Number.isFinite(currentValue)
                            || !Number.isFinite(amount)
                        ) return;
                        next[field] = currentValue + amount;
                    });
                    documents.set(id, {
                        ...next,
                        id,
                        sincronizacionPendiente: true,
                        sincronizacionOperacionId: record.id
                    });
                    return;
                }
                if (mutation.kind !== 'merge') return;

                documents.set(id, {
                    ...(documents.get(id) || {}),
                    ...(mutation.data || {}),
                    id,
                    sincronizacionPendiente: true,
                    sincronizacionOperacionId: record.id
                });
            });
        });

    return [...documents.values()];
}

export function getSyncQueueSummary() {
    const ownerRecords = [...operations.values()]
        .filter(record => record.ownerId === activeOwnerId);
    return {
        ownerId: activeOwnerId,
        pending: ownerRecords.filter(record => (
            ['queued', 'retry', 'syncing'].includes(record.status)
        )).length,
        failed: ownerRecords.filter(record => record.status === 'failed').length,
        syncing: ownerRecords.filter(record => record.status === 'syncing').length
    };
}

export async function discardSyncOperation(operationId) {
    await ensureInitialized();
    const record = operations.get(String(operationId || ''));
    if (!record || record.ownerId !== activeOwnerId) return false;
    const persistenceTimer = persistenceRetryTimers.get(record.id);
    if (persistenceTimer) clearTimeout(persistenceTimer);
    persistenceRetryTimers.delete(record.id);
    pendingPersistenceRecords.delete(record.id);
    await deleteRecord(record.id);
    operations.delete(record.id);
    emitQueueChanged();
    return true;
}

export async function resumeSyncQueue({ ownerId } = {}) {
    workerGeneration += 1;
    activeOwnerId = String(ownerId || '');
    queueEnabled = Boolean(activeOwnerId);
    await ensureInitialized();
    emitQueueChanged({ broadcast: false });
    scheduleDrain(0);
    return getSyncQueueSummary();
}

export function pauseSyncQueue() {
    workerGeneration += 1;
    queueEnabled = false;
    activeOwnerId = '';
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    emitQueueChanged({ broadcast: false });
}
