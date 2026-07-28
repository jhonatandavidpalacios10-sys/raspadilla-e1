const DATABASE_NAME = 'raffaelito-pos-sync';
const DATABASE_VERSION = 1;
const STORE_NAME = 'operations';
const FALLBACK_STORAGE_KEY = 'raffaelito:sync-queue:v1';
const SYNC_CHANNEL_NAME = 'raffaelito:sync-queue:v1';
const SYNC_LOCK_NAME = 'raffaelito:sync-queue-lock:v1';
const SYNCED_GRACE_MS = 20_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_OPERATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const handlers = new Map();
const operations = new Map();
let databasePromise = null;
let initializedPromise = null;
let activeOwnerId = '';
let processingPromise = null;
let retryTimer = null;
let listenersInstalled = false;
let broadcastChannel = null;
let fallbackStorage = false;
let reloadPromise = null;
let lastOperationCreatedAt = 0;

function clonePlain(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function normalizeId(value) {
    return String(value || '').trim();
}

function normalizeDependencyIds(values, operationId = '') {
    const currentId = normalizeId(operationId);
    return [...new Set(
        (Array.isArray(values) ? values : [values])
            .map(normalizeId)
            .filter(id => id && id !== currentId)
    )];
}

function sortOperationsByDependencies(rows = []) {
    const base = [...rows].sort((left, right) => (
        Number(left.createdAt || 0) - Number(right.createdAt || 0)
        || String(left.id || '').localeCompare(String(right.id || ''))
    ));
    const rowsById = new Map(base.map(row => [String(row.id || ''), row]));
    const visiting = new Set();
    const visited = new Set();
    const result = [];

    const visit = row => {
        const rowId = String(row?.id || '');
        if (!rowId || visited.has(rowId)) return;
        if (visiting.has(rowId)) return;
        visiting.add(rowId);
        normalizeDependencyIds(row.dependsOnOperationIds, rowId).forEach(dependencyId => {
            const dependency = rowsById.get(dependencyId);
            if (dependency) visit(dependency);
        });
        visiting.delete(rowId);
        visited.add(rowId);
        result.push(row);
    };

    base.forEach(visit);
    return result;
}

function getOperationCollections(operation) {
    return [...new Set(
        (Array.isArray(operation?.optimisticChanges)
            ? operation.optimisticChanges
            : [])
            .map(change => normalizeId(change?.collection))
            .filter(Boolean)
    )];
}

function activateFallbackStorage(error = null) {
    if (!fallbackStorage && error) {
        console.warn('La cola local usará localStorage como respaldo:', error);
    }
    fallbackStorage = true;
    const previousDatabasePromise = databasePromise;
    databasePromise = null;
    void previousDatabasePromise?.then(database => {
        try { database?.close?.(); } catch (_) {}
    }).catch(() => {});
}

function openDatabase() {
    if (fallbackStorage) return Promise.resolve(null);
    if (databasePromise) return databasePromise;

    databasePromise = new Promise(resolve => {
        if (typeof indexedDB === 'undefined') {
            activateFallbackStorage();
            resolve(null);
            return;
        }

        let request;
        let settled = false;
        const finish = database => {
            if (settled) {
                try { database?.close?.(); } catch (_) {}
                return;
            }
            settled = true;
            clearTimeout(blockedFallbackTimer);
            resolve(database);
        };
        const blockedFallbackTimer = setTimeout(() => {
            const error = new Error('IndexedDB tardó demasiado en responder.');
            activateFallbackStorage(error);
            finish(null);
        }, 1500);

        try {
            request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        } catch (error) {
            activateFallbackStorage(error);
            finish(null);
            return;
        }

        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('ownerId', 'ownerId', { unique: false });
                store.createIndex('status', 'status', { unique: false });
                store.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };
        request.onsuccess = () => {
            if (fallbackStorage) {
                try { request.result?.close?.(); } catch (_) {}
                finish(null);
                return;
            }
            finish(request.result);
        };
        request.onerror = () => {
            console.warn(
                'IndexedDB de sincronización no está disponible; se usará localStorage.',
                request.error
            );
            activateFallbackStorage(request.error);
            finish(null);
        };
        request.onblocked = () => {
            const error = new Error(
                'IndexedDB está bloqueado por otra pestaña; se usará respaldo local.'
            );
            console.warn(error.message);
            activateFallbackStorage(error);
            finish(null);
        };
    });

    return databasePromise;
}

function readFallbackRows() {
    try {
        const rows = JSON.parse(localStorage.getItem(FALLBACK_STORAGE_KEY) || '[]');
        return Array.isArray(rows) ? rows : [];
    } catch (_) {
        return [];
    }
}

function writeFallbackRows(rows) {
    try {
        localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(rows));
    } catch (error) {
        console.warn('No se pudo persistir la cola local de sincronización:', error);
        throw error;
    }
}

async function readAllOperations() {
    const database = await openDatabase();
    if (!database || fallbackStorage) return readFallbackRows();

    try {
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readonly');
            const request = transaction.objectStore(STORE_NAME).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
            transaction.onabort = () => reject(transaction.error);
        });
    } catch (error) {
        activateFallbackStorage(error);
        return readFallbackRows();
    }
}

async function putOperation(operation) {
    const writeFallback = () => {
        const rows = readFallbackRows();
        const nextRows = rows.filter(row => row.id !== operation.id);
        nextRows.push(operation);
        writeFallbackRows(nextRows);
    };
    const database = await openDatabase();
    if (!database || fallbackStorage) {
        writeFallback();
        return;
    }

    try {
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).put(operation);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    } catch (error) {
        activateFallbackStorage(error);
        writeFallback();
    }
}

async function deleteOperationRecord(operationId) {
    const deleteFallback = () => {
        writeFallbackRows(readFallbackRows().filter(row => row.id !== operationId));
    };
    const database = await openDatabase();
    if (!database || fallbackStorage) {
        deleteFallback();
        return;
    }

    try {
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).delete(operationId);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    } catch (error) {
        activateFallbackStorage(error);
        deleteFallback();
    }
}

function isOperationVisible(operation) {
    if (!operation || operation.ownerId !== activeOwnerId) return false;
    if (operation.status === 'synced') {
        return Date.now() - Number(operation.syncedAt || 0) <= SYNCED_GRACE_MS;
    }
    return ['queued', 'syncing', 'retry', 'failed'].includes(operation.status);
}

function getVisibleOperations() {
    return sortOperationsByDependencies(
        [...operations.values()].filter(isOperationVisible)
    );
}

export function getSyncQueueSummary() {
    const visible = getVisibleOperations();
    const pending = visible.filter(item => ['queued', 'syncing', 'retry', 'synced'].includes(item.status)).length;
    const failed = visible.filter(item => item.status === 'failed').length;
    return {
        ownerId: activeOwnerId,
        pending,
        failed,
        total: pending + failed,
        online: typeof navigator === 'undefined' ? true : navigator.onLine !== false
    };
}

function dispatchQueueChanged(collections = [], { broadcast = true } = {}) {
    const detail = {
        ...getSyncQueueSummary(),
        collections: [...new Set(collections.filter(Boolean))]
    };
    globalThis.dispatchEvent?.(new CustomEvent('icepos:sync-queue-changed', { detail }));
    try {
        if (broadcast) {
            broadcastChannel?.postMessage({ type: 'queue-changed', ownerId: activeOwnerId });
        }
    } catch (_) {}
}

function dispatchOperationFailure(operation, error) {
    globalThis.dispatchEvent?.(new CustomEvent('icepos:sync-operation-failed', {
        detail: {
            operationId: operation.id,
            type: operation.type,
            message: error?.message || 'La operación no pudo sincronizarse.',
            code: String(error?.code || 'unknown'),
            collections: getOperationCollections(operation)
        }
    }));
}

function cleanupExpiredOperations() {
    const now = Date.now();
    const changedCollections = new Set();
    [...operations.values()].forEach(operation => {
        const age = now - Number(operation.updatedAt || operation.createdAt || now);
        const syncedExpired = operation.status === 'synced'
            && now - Number(operation.syncedAt || 0) > SYNCED_GRACE_MS;
        const staleExpired = age > MAX_OPERATION_AGE_MS;
        if (!syncedExpired && !staleExpired) return;

        getOperationCollections(operation).forEach(collection => changedCollections.add(collection));
        operations.delete(operation.id);
        void deleteOperationRecord(operation.id).catch(error => {
            console.warn('No se pudo limpiar una operación sincronizada:', error);
        });
    });
    return [...changedCollections];
}

async function reloadOperations() {
    if (reloadPromise) return reloadPromise;
    reloadPromise = (async () => {
        const rows = await readAllOperations();
        operations.clear();
        rows.forEach(row => {
            if (row?.id) operations.set(row.id, row);
        });
        lastOperationCreatedAt = Math.max(
            lastOperationCreatedAt,
            ...rows.map(row => Number(row?.createdAt || 0))
        );
        cleanupExpiredOperations();
    })().finally(() => {
        reloadPromise = null;
    });
    return reloadPromise;
}

function installListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;

    globalThis.addEventListener?.('online', () => {
        dispatchQueueChanged();
        void processSyncQueue();
    });
    globalThis.addEventListener?.('offline', () => dispatchQueueChanged());
    globalThis.addEventListener?.('focus', () => void processSyncQueue());
    globalThis.document?.addEventListener?.('visibilitychange', () => {
        if (document.visibilityState === 'visible') void processSyncQueue();
    });

    if (typeof BroadcastChannel === 'function') {
        broadcastChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
        broadcastChannel.addEventListener('message', event => {
            if (event.data?.type !== 'queue-changed') return;
            void reloadOperations().then(() => {
                dispatchQueueChanged([], { broadcast: false });
                void processSyncQueue();
            });
        });
    }

    setInterval(() => {
        const changedCollections = cleanupExpiredOperations();
        if (changedCollections.length > 0) dispatchQueueChanged(changedCollections);
        void processSyncQueue();
    }, 15_000);
}

export async function initSyncQueue() {
    if (!initializedPromise) {
        initializedPromise = (async () => {
            installListeners();
            await reloadOperations();
            dispatchQueueChanged();
            return getSyncQueueSummary();
        })();
    }
    return initializedPromise;
}

export async function setSyncQueueContext({ ownerId } = {}) {
    activeOwnerId = normalizeId(ownerId);
    await initSyncQueue();
    dispatchQueueChanged();
    void processSyncQueue();
    return getSyncQueueSummary();
}

export function clearSyncQueueContext() {
    activeOwnerId = '';
    dispatchQueueChanged();
}

export function registerSyncHandler(type, handler) {
    const normalizedType = normalizeId(type);
    if (!normalizedType || typeof handler !== 'function') {
        throw new Error('El manejador de sincronización no es válido.');
    }
    handlers.set(normalizedType, handler);
    void processSyncQueue();
}

function normalizeOptimisticChange(change) {
    const collection = normalizeId(change?.collection);
    const id = normalizeId(change?.id);
    const action = normalizeId(change?.action || 'patch').toLowerCase();
    if (!collection || !id || !['upsert', 'patch', 'delete'].includes(action)) return null;

    return {
        collection,
        id,
        action,
        data: clonePlain(change?.data || {}),
        increments: clonePlain(change?.increments || {}),
        createIfMissing: change?.createIfMissing === true,
        confirmField: normalizeId(change?.confirmField || 'lastOperationId')
    };
}

export async function enqueueSyncOperation({
    id,
    type,
    payload,
    optimisticChanges = [],
    metadata = {},
    dependsOnOperationIds = []
}) {
    await initSyncQueue();
    const operationId = normalizeId(id);
    const operationType = normalizeId(type);
    if (!operationId || !operationType) {
        throw new Error('No se pudo identificar la operación local.');
    }
    if (!activeOwnerId) {
        throw new Error('No existe una sesión activa para guardar la operación local.');
    }

    const existing = operations.get(operationId);
    if (existing) return clonePlain(existing);

    const now = Math.max(Date.now(), lastOperationCreatedAt + 1);
    lastOperationCreatedAt = now;
    const operation = {
        id: operationId,
        type: operationType,
        ownerId: activeOwnerId,
        payload: clonePlain(payload || {}),
        optimisticChanges: optimisticChanges
            .map(normalizeOptimisticChange)
            .filter(Boolean),
        metadata: clonePlain(metadata || {}),
        dependsOnOperationIds: normalizeDependencyIds(
            dependsOnOperationIds,
            operationId
        ),
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
        lastErrorCode: '',
        lastErrorMessage: ''
    };

    operations.set(operation.id, operation);
    try {
        await putOperation(operation);
    } catch (error) {
        operations.delete(operation.id);
        throw error;
    }

    dispatchQueueChanged(getOperationCollections(operation));
    void processSyncQueue();
    return clonePlain(operation);
}

function isTransientSyncError(error) {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if ([
        'unavailable',
        'deadline-exceeded',
        'aborted',
        'resource-exhausted',
        'internal',
        'network-request-failed',
        'unknown',
        'cancelled'
    ].includes(code)) return true;
    if (code === 'failed-precondition') {
        return message.includes('offline')
            || message.includes('network')
            || message.includes('conex');
    }
    return message.includes('network')
        || message.includes('offline')
        || message.includes('failed to fetch');
}

function scheduleRetry(delayMs) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void processSyncQueue();
    }, Math.max(500, delayMs));
}

async function processOperation(operation) {
    const handler = handlers.get(operation.type);
    if (!handler) return { blocked: true };

    const syncing = {
        ...operation,
        status: 'syncing',
        attempts: Number(operation.attempts || 0) + 1,
        updatedAt: Date.now()
    };
    operations.set(syncing.id, syncing);
    await putOperation(syncing);
    dispatchQueueChanged(getOperationCollections(syncing));

    try {
        await handler(clonePlain(syncing.payload), clonePlain(syncing));
        const synced = {
            ...syncing,
            status: 'synced',
            syncedAt: Date.now(),
            updatedAt: Date.now(),
            lastErrorCode: '',
            lastErrorMessage: ''
        };
        operations.set(synced.id, synced);
        await putOperation(synced);
        dispatchQueueChanged(getOperationCollections(synced));
        scheduleRetry(SYNCED_GRACE_MS + 100);
        return { success: true };
    } catch (error) {
        const transient = isTransientSyncError(error);
        const attempts = Number(syncing.attempts || 1);
        const delay = Math.min(MAX_RETRY_DELAY_MS, 1500 * (2 ** Math.min(6, attempts - 1)));
        const failed = {
            ...syncing,
            status: transient ? 'retry' : 'failed',
            nextAttemptAt: transient ? Date.now() + delay : 0,
            updatedAt: Date.now(),
            lastErrorCode: String(error?.code || 'unknown').slice(0, 120),
            lastErrorMessage: String(error?.message || 'Error de sincronización').slice(0, 500)
        };
        operations.set(failed.id, failed);
        await putOperation(failed);
        dispatchQueueChanged(getOperationCollections(failed));

        if (transient) {
            scheduleRetry(delay);
            return { retry: true, delay };
        }

        dispatchOperationFailure(failed, error);
        return { failed: true };
    }
}

async function processQueueUnlocked() {
    await initSyncQueue();
    if (!activeOwnerId) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    const changedCollections = cleanupExpiredOperations();
    if (changedCollections.length > 0) dispatchQueueChanged(changedCollections);

    while (true) {
        const now = Date.now();
        const candidates = sortOperationsByDependencies(
            [...operations.values()].filter(operation => (
                operation.ownerId === activeOwnerId
                && ['queued', 'retry', 'syncing'].includes(operation.status)
                && Number(operation.nextAttemptAt || 0) <= now
            ))
        );

        if (candidates.length === 0) break;
        let processedAny = false;

        for (const operation of candidates) {
            const unresolvedDependency = normalizeDependencyIds(
                operation.dependsOnOperationIds,
                operation.id
            ).some(dependencyId => {
                const dependency = operations.get(dependencyId);
                return Boolean(
                    dependency
                    && dependency.ownerId === activeOwnerId
                    && dependency.status !== 'synced'
                );
            });
            if (unresolvedDependency) continue;

            const result = await processOperation(operation);
            if (result?.retry || result?.blocked) return;
            processedAny = true;
        }

        // Todas las operaciones restantes dependen de otra todavía pendiente
        // o fallida. Se reanudarán al sincronizar/reintentar su dependencia.
        if (!processedAny) break;
    }
}

export async function processSyncQueue() {
    if (processingPromise) return processingPromise;

    processingPromise = (async () => {
        if (globalThis.navigator?.locks?.request) {
            await globalThis.navigator.locks.request(
                SYNC_LOCK_NAME,
                { ifAvailable: true },
                async lock => {
                    if (lock) await processQueueUnlocked();
                }
            );
        } else {
            await processQueueUnlocked();
        }
    })().finally(() => {
        processingPromise = null;
    });

    return processingPromise;
}

export async function retryFailedSyncOperations() {
    await initSyncQueue();
    const failed = [...operations.values()].filter(operation => (
        operation.ownerId === activeOwnerId && operation.status === 'failed'
    ));
    const collections = new Set();

    for (const operation of failed) {
        const queued = {
            ...operation,
            status: 'queued',
            attempts: 0,
            nextAttemptAt: Date.now(),
            updatedAt: Date.now(),
            lastErrorCode: '',
            lastErrorMessage: ''
        };
        operations.set(queued.id, queued);
        await putOperation(queued);
        getOperationCollections(queued).forEach(collection => collections.add(collection));
    }

    dispatchQueueChanged([...collections]);
    void processSyncQueue();
    return failed.length;
}

function operationDependsOn(candidate, ancestorId, visited = new Set()) {
    const candidateId = String(candidate?.id || '');
    const normalizedAncestorId = String(ancestorId || '');
    if (!candidateId || !normalizedAncestorId || visited.has(candidateId)) return false;
    visited.add(candidateId);

    const dependencies = normalizeDependencyIds(
        candidate.dependsOnOperationIds,
        candidateId
    );
    if (dependencies.includes(normalizedAncestorId)) return true;
    return dependencies.some(dependencyId => {
        const dependency = operations.get(dependencyId);
        return dependency
            ? operationDependsOn(dependency, normalizedAncestorId, visited)
            : false;
    });
}

function isOptimisticChangeConfirmed(operation, change, current) {
    if (change.action === 'delete' && !current) return true;
    const confirmField = String(change.confirmField || '');
    if (!current || !confirmField) return false;

    const remoteMarker = String(current[confirmField] || '');
    if (!remoteMarker) return false;
    if (remoteMarker === operation.id) return true;

    const markerOperation = operations.get(remoteMarker);
    if (!markerOperation || !operationDependsOn(markerOperation, operation.id)) {
        return false;
    }

    return (markerOperation.optimisticChanges || []).some(markerChange => (
        markerChange.collection === change.collection
        && markerChange.id === change.id
        && String(markerChange.confirmField || '') === confirmField
    ));
}

function applyIncrements(row, increments) {
    const next = { ...row };
    Object.entries(increments || {}).forEach(([field, delta]) => {
        const numericDelta = Number(delta);
        if (!Number.isFinite(numericDelta)) return;
        const current = Number(next[field]);
        next[field] = (Number.isFinite(current) ? current : 0) + numericDelta;
    });
    return next;
}

export function mergePendingCollectionRows(collectionName, rows = []) {
    const normalizedCollection = normalizeId(collectionName);
    const baseRows = Array.isArray(rows) ? rows : [];
    const rowsById = new Map(
        baseRows
            .filter(row => row?.id)
            .map(row => [String(row.id), { ...row }])
    );

    getVisibleOperations().forEach(operation => {
        const syncState = operation.status === 'failed' ? 'error' : 'pending';
        (operation.optimisticChanges || [])
            .filter(change => change.collection === normalizedCollection)
            .forEach(change => {
                const current = rowsById.get(change.id);
                const confirmed = isOptimisticChangeConfirmed(
                    operation,
                    change,
                    current
                );
                if (confirmed) return;

                if (change.action === 'delete') {
                    rowsById.delete(change.id);
                    return;
                }

                if (!current && change.action === 'patch' && !change.createIfMissing) return;
                let next = {
                    ...(current || { id: change.id }),
                    ...(change.data || {}),
                    id: change.id
                };
                next = applyIncrements(next, change.increments);
                next._syncState = syncState;
                next._syncOperationId = operation.id;
                if (operation.lastErrorMessage) {
                    next._syncError = operation.lastErrorMessage;
                }
                rowsById.set(change.id, next);
            });
    });

    return [...rowsById.values()];
}
