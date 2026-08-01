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
const LOCAL_STORAGE_TRANSACTION_TIMEOUT_MS = 10_000;
const SYNC_OPERATION_TIMEOUT_MS = 45_000;

const handlers = new Map();
const operations = new Map();
const persistencePromises = new Map();
const storageChains = new Map();
let databasePromise = null;
let initializationPromise = null;
let reloadPromise = null;
let reloadRequested = false;
let workerPromise = null;
let retryTimer = null;
let retryTimerDueAt = 0;
let activeOwnerId = '';
let queueEnabled = false;
let workerGeneration = 0;
let lifecycleInstalled = false;
let channel = null;
let queueChangedTimer = null;
let queueChangedShouldBroadcast = false;
let queueChangedAffectsAllCollections = false;
const queueChangedCollections = new Set();
let lastCreatedAt = 0;
let lastVersionSequence = 0;

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
const CONNECTIVITY_ERROR_CODES = new Set([
    'network-request-failed',
    'unavailable',
    'deadline-exceeded'
]);

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function stableSerialize(value) {
    if (value === undefined) return '"__undefined__"';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(',')}]`;
    }
    return `{${Object.keys(value)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
        .join(',')}}`;
}

function getPayloadFingerprint(record) {
    if (record?.payloadFingerprint) return String(record.payloadFingerprint);
    const serialized = stableSerialize({
        type: record?.type || '',
        payload: record?.payload || {},
        optimisticMutations: record?.optimisticMutations || []
    });
    let hash = 2166136261;
    for (let index = 0; index < serialized.length; index += 1) {
        hash ^= serialized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function createVersionToken() {
    lastVersionSequence += 1;
    return [
        Date.now().toString(36),
        lastVersionSequence.toString(36),
        Math.random().toString(36).slice(2, 10)
    ].join('-');
}

function getRecordVersion(record) {
    const explicitVersion = String(record?.version || '').trim();
    if (explicitVersion) return explicitVersion;
    return [
        'legacy',
        Math.max(0, Number(record?.updatedAt) || 0),
        getPayloadFingerprint(record)
    ].join('-');
}

function normalizeDependsOn(dependsOn) {
    return [...new Set(
        (Array.isArray(dependsOn) ? dependsOn : [])
            .map(value => String(value || '').trim())
            .filter(Boolean)
    )];
}

function toDurableRecord(record) {
    const durableRecord = {
        ...record,
        version: getRecordVersion(record),
        entityKey: String(record?.entityKey || ''),
        dependsOn: normalizeDependsOn(record?.dependsOn),
        payloadFingerprint: getPayloadFingerprint(record)
    };
    delete durableRecord.persistencePending;
    delete durableRecord.stagingToken;
    delete durableRecord.volatile;
    delete durableRecord.cancelled;
    return durableRecord;
}

function serializeStorageTask(recordId, task) {
    const normalizedId = String(recordId || '');
    const previous = storageChains.get(normalizedId) || Promise.resolve();
    const current = previous
        .catch(() => {})
        .then(task);
    storageChains.set(normalizedId, current);
    void current.finally(() => {
        if (storageChains.get(normalizedId) === current) {
            storageChains.delete(normalizedId);
        }
    }).catch(() => {});
    return current;
}

function createQueueError(code, message) {
    return Object.assign(new Error(message), { code });
}

function invalidateDatabaseConnection(database) {
    try {
        database?.close();
    } catch (_) {}
    databasePromise = null;
}

function armStorageTransactionTimeout({
    database,
    transaction,
    reject,
    message
}) {
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        const error = createQueueError(
            'local-storage-timeout',
            message || 'El almacenamiento local tardó demasiado en responder.'
        );
        // Rechazamos primero para conservar el motivo real. abort() puede
        // disparar onabort inmediatamente en algunos WebView antiguos.
        reject(error);
        try {
            transaction.abort();
        } catch (_) {}
        invalidateDatabaseConnection(database);
    }, LOCAL_STORAGE_TRANSACTION_TIMEOUT_MS);

    return {
        clear() {
            clearTimeout(timeout);
        },
        didTimeout() {
            return timedOut;
        }
    };
}

function runSyncHandlerWithDeadline(handler, payload, operation) {
    let timeout = null;
    const remoteWork = Promise.resolve().then(() => (
        handler(cloneValue(payload), operation)
    ));
    const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            reject(createQueueError(
                'deadline-exceeded',
                'Firebase no respondió a tiempo. La operación se reintentará automáticamente.'
            ));
        }, SYNC_OPERATION_TIMEOUT_MS);
    });

    // Firestore no permite cancelar runTransaction. La operación remota puede
    // terminar después del deadline; todos los handlers usan operationId
    // estable, por lo que el siguiente intento confirma o reutiliza el mismo
    // resultado sin duplicar la venta.
    return Promise.race([remoteWork, deadline]).finally(() => {
        if (timeout !== null) clearTimeout(timeout);
    });
}

async function awaitPersistAfter(persistAfter) {
    if (persistAfter === undefined || persistAfter === null) return;
    const result = await (
        typeof persistAfter === 'function'
            ? persistAfter()
            : persistAfter
    );
    if (result === false) {
        throw createQueueError(
            'local-draft-storage-failed',
            'No se pudo asegurar el borrador local antes de guardar la operación.'
        );
    }
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
        const timeoutGuard = armStorageTransactionTimeout({
            database,
            transaction,
            reject,
            message: 'La cola local tardó demasiado en responder.'
        });

        try {
            request = operation(store);
        } catch (error) {
            timeoutGuard.clear();
            try {
                transaction.abort();
            } catch (_) {}
            reject(error);
            return;
        }

        transaction.oncomplete = () => {
            timeoutGuard.clear();
            resolve(request?.result);
        };
        transaction.onerror = () => {
            timeoutGuard.clear();
            reject(transaction.error || request?.error || new Error('Falló la cola local.'));
        };
        transaction.onabort = () => {
            timeoutGuard.clear();
            if (timeoutGuard.didTimeout()) return;
            reject(transaction.error || new Error('Se canceló una operación de la cola local.'));
        };
    });
}

function getAllRecords() {
    return runStoreRequest('readonly', store => store.getAll());
}

function getStoredRecord(id) {
    return runStoreRequest('readonly', store => store.get(id));
}

function putRecord(record) {
    return runStoreRequest('readwrite', store => store.put(toDurableRecord(record)));
}

async function putRecordAtomically(record, {
    supersedesQueueIds = []
} = {}) {
    const database = await openDatabase();
    const candidate = toDurableRecord(record);
    const supersededIds = [...new Set(
        (Array.isArray(supersedesQueueIds) ? supersedesQueueIds : [])
            .map(value => String(value || '').trim())
            .filter(value => value && value !== candidate.id)
    )];

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        let outcome = null;
        let operationError = null;
        const supersededRecords = [];
        const request = store.get(candidate.id);
        const timeoutGuard = armStorageTransactionTimeout({
            database,
            transaction,
            reject,
            message: 'El guardado de la operación local tardó demasiado.'
        });

        request.onsuccess = () => {
            const existing = request.result;
            if (existing && existing.status !== 'failed') {
                const fingerprintsConflict = (
                    existing.status !== 'committed'
                    && getPayloadFingerprint(existing) !== candidate.payloadFingerprint
                );
                if (fingerprintsConflict) {
                    operationError = Object.assign(
                        new Error(
                            'El identificador local ya pertenece a una operación diferente.'
                        ),
                        { code: 'operation-id-conflict' }
                    );
                    transaction.abort();
                    return;
                }
                outcome = {
                    record: existing,
                    alreadyStored: true,
                    inserted: false
                };
                return;
            }

            if (
                existing
                && getPayloadFingerprint(existing) !== candidate.payloadFingerprint
            ) {
                operationError = Object.assign(
                    new Error(
                        'La operación pendiente cambió de contenido y necesita revisión.'
                    ),
                    { code: 'operation-id-conflict' }
                );
                transaction.abort();
                return;
            }

            const writeRequest = existing
                ? store.put({
                    ...candidate,
                    createdAt: Number(existing.createdAt) || candidate.createdAt
                })
                : store.add(candidate);
            writeRequest.onsuccess = () => {
                outcome = {
                    record: {
                        ...candidate,
                        createdAt: Number(existing?.createdAt) || candidate.createdAt
                    },
                    alreadyStored: false,
                    inserted: !existing,
                    supersededRecords
                };
                supersededIds.forEach(supersededId => {
                    const supersededRequest = store.get(supersededId);
                    supersededRequest.onsuccess = () => {
                        const superseded = supersededRequest.result;
                        if (
                            superseded?.ownerId === candidate.ownerId
                            && superseded.status === 'failed'
                        ) {
                            supersededRecords.push(superseded);
                            store.delete(supersededId);
                        }
                    };
                });
            };
        };

        transaction.oncomplete = () => {
            timeoutGuard.clear();
            resolve(outcome);
        };
        transaction.onerror = () => {
            timeoutGuard.clear();
            reject(
                operationError
                || transaction.error
                || request.error
                || new Error('No se pudo guardar la operación local.')
            );
        };
        transaction.onabort = () => {
            timeoutGuard.clear();
            if (timeoutGuard.didTimeout()) return;
            reject(
                operationError
                || transaction.error
                || new Error('Se canceló el guardado de la operación local.')
            );
        };
    });
}

async function replaceRecordAtomically(record, {
    expectedVersion,
    allowInsertIfMissing = false
} = {}) {
    const database = await openDatabase();
    const candidate = toDurableRecord(record);
    const normalizedExpectedVersion = String(expectedVersion || '');

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        let outcome = null;
        let operationError = null;
        const request = store.get(candidate.id);
        const timeoutGuard = armStorageTransactionTimeout({
            database,
            transaction,
            reject,
            message: 'La actualización de la operación local tardó demasiado.'
        });

        request.onsuccess = () => {
            const existing = request.result;
            if (!existing) {
                if (!allowInsertIfMissing) {
                    operationError = createQueueError(
                        'operation-version-conflict',
                        'La operación cambió antes de poder reemplazarla.'
                    );
                    transaction.abort();
                    return;
                }
                const addRequest = store.add(candidate);
                addRequest.onsuccess = () => {
                    outcome = {
                        record: candidate,
                        inserted: true,
                        replaced: false
                    };
                };
                return;
            }

            if (existing.ownerId !== candidate.ownerId) {
                operationError = createQueueError(
                    'operation-owner-conflict',
                    'La operación pertenece a otra sesión.'
                );
                transaction.abort();
                return;
            }
            if (existing.status === 'syncing') {
                operationError = createQueueError(
                    'operation-in-flight',
                    'La operación ya se está sincronizando.'
                );
                transaction.abort();
                return;
            }
            if (!['queued', 'retry'].includes(existing.status)) {
                operationError = createQueueError(
                    'operation-not-replaceable',
                    'Solo se pueden reemplazar operaciones pendientes.'
                );
                transaction.abort();
                return;
            }
            if (getRecordVersion(existing) !== normalizedExpectedVersion) {
                operationError = createQueueError(
                    'operation-version-conflict',
                    'La operación cambió antes de poder reemplazarla.'
                );
                transaction.abort();
                return;
            }

            const putRequest = store.put({
                ...candidate,
                createdAt: Number(existing.createdAt) || candidate.createdAt
            });
            putRequest.onsuccess = () => {
                outcome = {
                    record: {
                        ...candidate,
                        createdAt: Number(existing.createdAt) || candidate.createdAt
                    },
                    inserted: false,
                    replaced: true
                };
            };
        };

        transaction.oncomplete = () => {
            timeoutGuard.clear();
            resolve(outcome);
        };
        transaction.onerror = () => {
            timeoutGuard.clear();
            reject(
                operationError
                || transaction.error
                || request.error
                || new Error('No se pudo reemplazar la operación local.')
            );
        };
        transaction.onabort = () => {
            timeoutGuard.clear();
            if (timeoutGuard.didTimeout()) return;
            reject(
                operationError
                || transaction.error
                || new Error('Se canceló el reemplazo de la operación local.')
            );
        };
    });
}

async function deleteRecordConditionally(id, {
    ownerId,
    expectedVersion = '',
    allowAnyFailedVersion = false
} = {}) {
    const database = await openDatabase();
    const normalizedId = String(id || '');
    const normalizedOwnerId = String(ownerId || '');
    const normalizedExpectedVersion = String(expectedVersion || '');

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        let outcome = null;
        let operationError = null;
        const request = store.get(normalizedId);
        const timeoutGuard = armStorageTransactionTimeout({
            database,
            transaction,
            reject,
            message: 'La revisión de la operación local tardó demasiado.'
        });

        request.onsuccess = () => {
            const existing = request.result;
            if (!existing) {
                outcome = { deleted: false, missing: true, record: null };
                return;
            }
            if (existing.ownerId !== normalizedOwnerId) {
                outcome = { deleted: false, ownerConflict: true, record: existing };
                return;
            }
            if (existing.status === 'syncing') {
                operationError = createQueueError(
                    'operation-in-flight',
                    'La operación ya se está sincronizando.'
                );
                transaction.abort();
                return;
            }
            if (existing.status === 'committed') {
                operationError = createQueueError(
                    'operation-not-discardable',
                    'Una operación confirmada no se puede descartar.'
                );
                transaction.abort();
                return;
            }
            const versionMatches = (
                getRecordVersion(existing) === normalizedExpectedVersion
            );
            if (
                !versionMatches
                && !(allowAnyFailedVersion && existing.status === 'failed')
            ) {
                outcome = {
                    deleted: false,
                    versionConflict: true,
                    record: existing
                };
                return;
            }
            const deleteRequest = store.delete(normalizedId);
            deleteRequest.onsuccess = () => {
                outcome = { deleted: true, missing: false, record: existing };
            };
        };

        transaction.oncomplete = () => {
            timeoutGuard.clear();
            resolve(outcome);
        };
        transaction.onerror = () => {
            timeoutGuard.clear();
            reject(
                operationError
                || transaction.error
                || request.error
                || new Error('No se pudo eliminar la operación local.')
            );
        };
        transaction.onabort = () => {
            timeoutGuard.clear();
            if (timeoutGuard.didTimeout()) return;
            reject(
                operationError
                || transaction.error
                || new Error('Se canceló la eliminación de la operación local.')
            );
        };
    });
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
        const timeoutGuard = armStorageTransactionTimeout({
            database,
            transaction,
            reject,
            message: 'El bloqueo local de sincronización tardó demasiado.'
        });

        try {
            operation(store, value => {
                result = value;
            });
        } catch (error) {
            timeoutGuard.clear();
            try {
                transaction.abort();
            } catch (_) {}
            reject(error);
            return;
        }

        transaction.oncomplete = () => {
            timeoutGuard.clear();
            resolve(result);
        };
        transaction.onerror = () => {
            timeoutGuard.clear();
            reject(transaction.error || new Error('Falló el bloqueo local de sincronización.'));
        };
        transaction.onabort = () => {
            timeoutGuard.clear();
            if (timeoutGuard.didTimeout()) return;
            reject(transaction.error || new Error('Se canceló el bloqueo local de sincronización.'));
        };
    });
}

async function settleSyncAttemptAtomically(record, nextRecord) {
    const database = await openDatabase();
    const candidate = toDurableRecord(nextRecord);
    const expectedVersion = getRecordVersion(record);
    const expectedAttemptId = String(record?.syncAttemptId || '');

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        let outcome = null;
        const request = store.get(record.id);
        const timeoutGuard = armStorageTransactionTimeout({
            database,
            transaction,
            reject,
            message: 'La confirmación local del intento tardó demasiado.'
        });

        request.onsuccess = () => {
            const existing = request.result;
            const canSettle = Boolean(
                existing
                && existing.ownerId === record.ownerId
                && existing.status === 'syncing'
                && getRecordVersion(existing) === expectedVersion
                && String(existing.syncAttemptId || '') === expectedAttemptId
            );
            if (!canSettle) {
                outcome = {
                    applied: false,
                    record: existing || null
                };
                return;
            }

            const settledRecord = {
                ...candidate,
                createdAt: Number(existing.createdAt) || candidate.createdAt,
                syncAttemptId: '',
                syncAttemptStartedAt: 0
            };
            const writeRequest = store.put(settledRecord);
            writeRequest.onsuccess = () => {
                outcome = {
                    applied: true,
                    record: settledRecord
                };
            };
        };

        transaction.oncomplete = () => {
            timeoutGuard.clear();
            resolve(outcome);
        };
        transaction.onerror = () => {
            timeoutGuard.clear();
            reject(
                transaction.error
                || request.error
                || new Error('No se pudo confirmar el intento en la cola local.')
            );
        };
        transaction.onabort = () => {
            timeoutGuard.clear();
            if (timeoutGuard.didTimeout()) return;
            reject(
                transaction.error
                || new Error('Se canceló la confirmación del intento local.')
            );
        };
    });
}

function normalizeLoadedRecord(record) {
    if (!record?.id || !record?.type || !record?.ownerId) return null;
    // IndexedDB es la autoridad. Una fila syncing se recupera y persiste bajo
    // el lock del worker; cambiarla solo en memoria creaba un ciclo infinito.
    const status = record.status;
    return {
        ...record,
        version: getRecordVersion(record),
        entityKey: String(record.entityKey || ''),
        dependsOn: normalizeDependsOn(record.dependsOn),
        status: ['queued', 'retry', 'syncing', 'failed', 'committed'].includes(status)
            ? status
            : 'queued',
        attempts: Math.max(0, Number(record.attempts) || 0),
        nextAttemptAt: Math.max(0, Number(record.nextAttemptAt) || 0),
        createdAt: Number(record.createdAt) || Date.now(),
        updatedAt: Number(record.updatedAt) || Date.now(),
        syncAttemptId: status === 'syncing'
            ? String(record.syncAttemptId || '')
            : '',
        syncAttemptStartedAt: status === 'syncing'
            ? Math.max(
                0,
                Number(record.syncAttemptStartedAt)
                || Number(record.updatedAt)
                || 0
            )
            : 0,
        persistencePending: false,
        optimisticMutations: Array.isArray(record.optimisticMutations)
            ? record.optimisticMutations
            : []
    };
}

function isPendingForActiveOwner(record) {
    return (
        record
        && record.ownerId === activeOwnerId
        && ['queued', 'retry', 'syncing'].includes(record.status)
    );
}

function isVisiblePending(record) {
    if (!isPendingForActiveOwner(record)) return false;
    return getBlockingDependency(record)?.status !== 'failed';
}

function getCommittedProjectionOperationId(record) {
    return String(
        record?.projectionOperationId
        || record?.payload?.operationId
        || ''
    );
}

function getCommittedBridgeMutations(record) {
    const operationId = String(record?.payload?.operationId || '');
    if (!operationId) return [];

    return (Array.isArray(record?.optimisticMutations)
        ? record.optimisticMutations
        : [])
        .filter(mutation => (
            ['ventas', 'gastos'].includes(String(mutation?.collection || ''))
            && ['merge', 'delete'].includes(String(mutation?.kind || ''))
            && Boolean(mutation?.documentId)
            && (
                mutation.kind === 'delete'
                || String(mutation?.data?.lastOperationId || '') === operationId
            )
        ))
        .map(mutation => cloneValue(mutation));
}

function isVisibleCommittedProjection(record) {
    return (
        record
        && record.ownerId === activeOwnerId
        && record.status === 'committed'
        && getCommittedProjectionOperationId(record)
        && Array.isArray(record.optimisticMutations)
        && record.optimisticMutations.length > 0
    );
}

function baseDocumentAcknowledgesCommittedMutation(
    mutation,
    documents,
    operationId
) {
    const documentId = String(mutation?.documentId || '');
    if (!documentId) return true;
    if (mutation.kind === 'delete') return !documents.has(documentId);

    const row = documents.get(documentId);
    if (!row) return false;
    return (
        String(row.lastOperationId || '') === operationId
        || Boolean(
            row.appliedOperations
            && typeof row.appliedOperations === 'object'
            && row.appliedOperations[operationId]
        )
    );
}

function emitWindowEvent(name, detail) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
}

function emitConnectivityEvidence({ ok, code = '' }) {
    emitWindowEvent('icepos:connectivity-evidence', {
        ok: ok === true,
        code: String(code || '').replace(/^firestore\//, ''),
        source: 'sync-queue',
        at: Date.now()
    });
}

function getPublicOperation(record) {
    return {
        id: record.id,
        type: record.type,
        ownerId: record.ownerId,
        localId: record.localId || '',
        version: getRecordVersion(record),
        entityKey: String(record.entityKey || ''),
        dependsOn: normalizeDependsOn(record.dependsOn),
        status: record.status,
        attempts: record.attempts,
        nextAttemptAt: Math.max(0, Number(record.nextAttemptAt) || 0),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        durable: (
            record.persistencePending !== true
            && record.volatile !== true
        ),
        payload: cloneValue(record.payload),
        lastErrorCode: record.lastErrorCode || '',
        lastErrorMessage: record.lastErrorMessage || ''
    };
}

function notifyPeers(message = { type: 'refresh' }) {
    try {
        channel?.postMessage(message);
    } catch (_) {}
}

function getAffectedCollections(record) {
    return [...new Set(
        (Array.isArray(record?.optimisticMutations)
            ? record.optimisticMutations
            : [])
            .map(mutation => String(mutation?.collection || ''))
            .filter(Boolean)
    )];
}

function emitQueueChanged({
    broadcast = true,
    affectedCollections = null
} = {}) {
    queueChangedShouldBroadcast ||= broadcast;
    if (affectedCollections === null) {
        queueChangedAffectsAllCollections = true;
    } else {
        affectedCollections.forEach(collectionName => {
            if (collectionName) queueChangedCollections.add(collectionName);
        });
    }
    if (queueChangedTimer !== null) return;

    const flushQueueChanged = () => {
        if (queueChangedTimer !== null) clearTimeout(queueChangedTimer);
        queueChangedTimer = null;
        const shouldBroadcast = queueChangedShouldBroadcast;
        const affectsAllCollections = queueChangedAffectsAllCollections;
        const collections = Array.from(queueChangedCollections);
        queueChangedShouldBroadcast = false;
        queueChangedAffectsAllCollections = false;
        queueChangedCollections.clear();

        emitWindowEvent('icepos:sync-queue-changed', {
            ...getSyncQueueSummary(),
            affectedCollections: affectsAllCollections ? null : collections
        });
        if (shouldBroadcast) notifyPeers();
    };

    if (
        typeof requestAnimationFrame === 'function'
        && typeof document !== 'undefined'
        && document.visibilityState !== 'hidden'
    ) {
        // El rAF + tarea siguiente deja que el navegador pinte primero el
        // toast y la limpieza mínima del carrito. El fallback evita detener
        // broadcasts si la pestaña pasa a segundo plano antes de ese frame.
        queueChangedTimer = setTimeout(flushQueueChanged, 50);
        requestAnimationFrame(() => {
            if (queueChangedTimer === null) return;
            clearTimeout(queueChangedTimer);
            queueChangedTimer = setTimeout(flushQueueChanged, 0);
        });
        return;
    }

    queueChangedTimer = setTimeout(flushQueueChanged, 0);
}

function chooseNewestRecord(storedRecord, currentRecord) {
    if (!storedRecord) return currentRecord;
    if (!currentRecord) return storedRecord;
    if (storedRecord.status === 'committed') return storedRecord;
    if (
        currentRecord.persistencePending === true
        || currentRecord.volatile === true
    ) {
        return currentRecord;
    }

    const storedUpdatedAt = Number(storedRecord.updatedAt) || 0;
    const currentUpdatedAt = Number(currentRecord.updatedAt) || 0;
    if (currentUpdatedAt !== storedUpdatedAt) {
        return currentUpdatedAt > storedUpdatedAt
            ? currentRecord
            : storedRecord;
    }

    const statusRank = {
        queued: 0,
        retry: 1,
        syncing: 2,
        failed: 3,
        committed: 4
    };
    return (statusRank[currentRecord.status] || 0)
        > (statusRank[storedRecord.status] || 0)
        ? currentRecord
        : storedRecord;
}

function getReloadSignature(record) {
    if (!record) return '';
    return [
        getRecordVersion(record),
        String(record.status || ''),
        Number(record.updatedAt) || 0,
        String(record.syncAttemptId || ''),
        record.persistencePending === true ? 'pending' : 'durable',
        record.volatile === true ? 'volatile' : 'stored',
        String(record.stagingToken || '')
    ].join('|');
}

async function performStorageReload() {
    const recordsAtStart = new Map(
        [...operations.entries()]
            .map(([id, record]) => [id, getReloadSignature(record)])
    );
    const rows = await getAllRecords();
    const normalizedRows = rows.map(normalizeLoadedRecord).filter(Boolean);
    normalizedRows.forEach(record => {
        lastCreatedAt = Math.max(lastCreatedAt, Number(record.createdAt) || 0);
    });
    const mergedOperations = new Map(
        normalizedRows.map(record => [record.id, record])
    );

    // Una versión creada o modificada durante getAll() se conserva. Una fila
    // durable que ya existía al iniciar la lectura y ahora no está en IndexedDB
    // se elimina, sin depender de relojes ni timestamps artificialmente futuros.
    [...operations.values()].forEach(currentRecord => {
        const storedRecord = mergedOperations.get(currentRecord.id);
        if (
            !storedRecord
            && currentRecord.persistencePending !== true
            && currentRecord.volatile !== true
            && recordsAtStart.get(currentRecord.id)
                === getReloadSignature(currentRecord)
        ) {
            return;
        }
        mergedOperations.set(
            currentRecord.id,
            chooseNewestRecord(storedRecord, currentRecord)
        );
    });

    operations.clear();
    mergedOperations.forEach(record => operations.set(record.id, record));

    const expiredCommittedIds = normalizedRows
        .filter(record => (
            record.status === 'committed'
            && Number(record.committedAt || record.updatedAt)
                < Date.now() - COMMITTED_TOMBSTONE_TTL_MS
        ))
        .map(record => record.id);
    if (expiredCommittedIds.length > 0) {
        void Promise.all(expiredCommittedIds.map(async id => {
            try {
                await deleteRecord(id);
                if (operations.get(id)?.status === 'committed') {
                    operations.delete(id);
                }
            } catch (error) {
                console.warn(
                    'Quedó pendiente limpiar una operación ya confirmada:',
                    error
                );
            }
        })).then(() => {
            emitQueueChanged({
                broadcast: false,
                affectedCollections: []
            });
        });
    }

    emitQueueChanged({ broadcast: false });
}

function reloadOperationsFromStorage() {
    reloadRequested = true;
    if (reloadPromise) return reloadPromise;

    reloadPromise = (async () => {
        while (reloadRequested) {
            reloadRequested = false;
            await performStorageReload();
        }
    })().finally(() => {
        reloadPromise = null;
    });
    return reloadPromise;
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
    const normalizedDelay = Math.max(0, Number(delayMs) || 0);
    const dueAt = Date.now() + normalizedDelay;
    // navigator.onLine no confirma acceso a Firebase y algunos WebView lo
    // mantienen en false aun cuando la red volvió. Dejamos que el handler real
    // pruebe la conexión, protegido por deadline y backoff.
    if (retryTimer !== null && retryTimerDueAt <= dueAt) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimerDueAt = dueAt;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        retryTimerDueAt = 0;
        void drainQueue();
    }, normalizedDelay);
}

function compareOperationOrder(left, right) {
    return (
        left.createdAt - right.createdAt
        || left.id.localeCompare(right.id)
    );
}

function getBlockingDependency(record) {
    const explicitDependencies = new Set(
        normalizeDependsOn(record?.dependsOn)
    );
    const entityKey = String(record?.entityKey || '');

    return [...operations.values()].find(candidate => {
        if (
            !candidate
            || candidate.id === record.id
            || candidate.ownerId !== record.ownerId
            || candidate.status === 'committed'
        ) return false;
        if (explicitDependencies.has(candidate.id)) return true;
        return (
            Boolean(entityKey)
            && candidate.entityKey === entityKey
            && compareOperationOrder(candidate, record) < 0
        );
    }) || null;
}

function getNextOperation() {
    const now = Date.now();
    return [...operations.values()]
        .filter(record => (
            record.ownerId === activeOwnerId
            && ['queued', 'retry'].includes(record.status)
            && handlers.has(record.type)
            && record.persistencePending !== true
            && Number(record.nextAttemptAt || 0) <= now
        ))
        .sort(compareOperationOrder)
        .find(record => !getBlockingDependency(record)) || null;
}

function getNextQueuedWakeAt() {
    const now = Date.now();
    const nextRecord = [...operations.values()]
        .filter(record => (
            record.ownerId === activeOwnerId
            && ['queued', 'retry'].includes(record.status)
            && handlers.has(record.type)
            && record.persistencePending !== true
            && Number(record.nextAttemptAt || 0) > now
            && !getBlockingDependency(record)
        ))
        .sort((left, right) => (
            Number(left.nextAttemptAt || 0) - Number(right.nextAttemptAt || 0)
            || compareOperationOrder(left, right)
        ))[0];
    return Math.max(0, Number(nextRecord?.nextAttemptAt) || 0);
}

function isCurrentWorker(ownerId, generation) {
    return (
        queueEnabled
        && activeOwnerId === ownerId
        && workerGeneration === generation
    );
}

async function markOperationForSessionRetry(record) {
    const retryRecord = {
        ...record,
        status: 'retry',
        syncAttemptId: '',
        syncAttemptStartedAt: 0,
        nextAttemptAt: 0,
        updatedAt: Math.max(Date.now(), Number(record.updatedAt || 0) + 1)
    };
    try {
        const outcome = await settleSyncAttemptAtomically(record, retryRecord);
        if (outcome?.applied) {
            operations.set(retryRecord.id, normalizeLoadedRecord(outcome.record));
        } else {
            await reloadOperationsFromStorage();
        }
    } catch (error) {
        console.warn('No se pudo pausar limpiamente la operación local:', error);
        await reloadOperationsFromStorage().catch(() => {});
        scheduleDrain(5_000);
    }
    emitQueueChanged({ affectedCollections: getAffectedCollections(record) });
}

async function recoverOwnedSyncingRecords(ownerId) {
    const syncingRecords = [...operations.values()]
        .filter(record => (
            record.ownerId === ownerId
            && record.status === 'syncing'
        ))
        .sort(compareOperationOrder);
    if (syncingRecords.length === 0) return;

    for (const record of syncingRecords) {
        const retryRecord = {
            ...record,
            status: 'retry',
            syncAttemptId: '',
            syncAttemptStartedAt: 0,
            nextAttemptAt: 0,
            updatedAt: Math.max(Date.now(), Number(record.updatedAt || 0) + 1)
        };
        const outcome = await settleSyncAttemptAtomically(record, retryRecord);
        if (outcome?.applied) {
            operations.set(
                retryRecord.id,
                normalizeLoadedRecord(outcome.record)
            );
        } else if (outcome?.record) {
            operations.set(
                retryRecord.id,
                normalizeLoadedRecord(outcome.record)
            );
        }
    }
    emitQueueChanged({
        affectedCollections: [...new Set(
            syncingRecords.flatMap(getAffectedCollections)
        )]
    });
}

async function persistWorkerState(record, nextRecord, warning) {
    try {
        const outcome = await settleSyncAttemptAtomically(record, nextRecord);
        if (!outcome?.applied) {
            await reloadOperationsFromStorage();
            return null;
        }
        return normalizeLoadedRecord(outcome.record);
    } catch (error) {
        console.warn(warning, error);
        await reloadOperationsFromStorage().catch(() => {});
        scheduleDrain(5_000);
        return null;
    }
}

async function processOperations(
    ownerId,
    generation,
    hasWorkerLease = () => true
) {
    while (isCurrentWorker(ownerId, generation) && hasWorkerLease()) {
        let record = getNextOperation();
        if (!record) {
            const nextRetry = getNextQueuedWakeAt();
            if (nextRetry > Date.now()) scheduleDrain(nextRetry - Date.now());
            return;
        }

        const handler = handlers.get(record.type);
        const syncingRecord = {
            ...record,
            status: 'syncing',
            syncAttemptId: createVersionToken(),
            syncAttemptStartedAt: Date.now(),
            updatedAt: Date.now()
        };
        try {
            const syncingResult = await replaceRecordAtomically(syncingRecord, {
                expectedVersion: getRecordVersion(record)
            });
            record = normalizeLoadedRecord(
                syncingResult.record || syncingRecord
            );
        } catch (error) {
            if ([
                'operation-version-conflict',
                'operation-not-replaceable',
                'operation-in-flight'
            ].includes(String(error?.code || ''))) {
                await reloadOperationsFromStorage();
                return;
            }
            throw error;
        }
        operations.set(record.id, record);
        emitQueueChanged({ affectedCollections: getAffectedCollections(record) });

        try {
            const affectedCollections = getAffectedCollections(record);
            const result = await runSyncHandlerWithDeadline(
                handler,
                record.payload,
                getPublicOperation(record)
            );
            if (!isCurrentWorker(ownerId, generation) || !hasWorkerLease()) {
                await markOperationForSessionRetry(record);
                return;
            }
            emitConnectivityEvidence({ ok: true });
            const committedAt = Math.max(
                Date.now(),
                Number(record.updatedAt || 0) + 1
            );
            const committedBridgeMutations = getCommittedBridgeMutations(record);
            const committedRecord = await persistWorkerState(record, {
                ...record,
                status: 'committed',
                syncAttemptId: '',
                syncAttemptStartedAt: 0,
                updatedAt: committedAt,
                committedAt,
                projectionOperationId: String(record.payload?.operationId || ''),
                payload: {},
                // La proyección primaria permanece hasta que onSnapshot
                // confirme el mismo operationId. Así no reaparece una versión
                // antigua entre la confirmación de Firebase y su snapshot.
                optimisticMutations: committedBridgeMutations
            }, 'No se pudo marcar localmente una operación confirmada:');
            if (!committedRecord) return;
            operations.set(committedRecord.id, committedRecord);
            emitQueueChanged({ affectedCollections });
            if (committedRecord.ownerId === activeOwnerId) {
                emitWindowEvent('icepos:sync-operation-complete', {
                    operation: getPublicOperation(committedRecord),
                    result: cloneValue(result)
                });
            }
        } catch (error) {
            if (!isCurrentWorker(ownerId, generation) || !hasWorkerLease()) {
                await markOperationForSessionRetry(record);
                return;
            }
            const code = String(error?.code || 'unknown').replace(/^firestore\//, '');
            const message = String(
                error?.message || 'No se pudo sincronizar la operación.'
            ).slice(0, 500);
            const attempts = record.attempts + 1;
            const updatedAt = Math.max(
                Date.now(),
                Number(record.updatedAt || 0) + 1
            );

            if (isTransientError(error)) {
                if (CONNECTIVITY_ERROR_CODES.has(code)) {
                    emitConnectivityEvidence({ ok: false, code });
                }
                const delay = getRetryDelay(attempts);
                const retryRecord = await persistWorkerState(record, {
                    ...record,
                    status: 'retry',
                    syncAttemptId: '',
                    syncAttemptStartedAt: 0,
                    attempts,
                    updatedAt,
                    lastErrorCode: code,
                    lastErrorMessage: message,
                    nextAttemptAt: Date.now() + delay
                }, 'No se pudo guardar el reintento local:');
                if (!retryRecord) return;
                operations.set(retryRecord.id, retryRecord);
                emitQueueChanged({ affectedCollections: getAffectedCollections(record) });
                scheduleDrain(delay);
                continue;
            }

            const affectedCollections = getAffectedCollections(record);
            const failedRecord = await persistWorkerState(record, {
                ...record,
                status: 'failed',
                syncAttemptId: '',
                syncAttemptStartedAt: 0,
                attempts,
                updatedAt,
                lastErrorCode: code,
                lastErrorMessage: message,
                nextAttemptAt: 0
            }, 'No se pudo guardar el fallo definitivo en la cola local:');
            if (!failedRecord) return;
            operations.set(failedRecord.id, failedRecord);
            const detail = {
                operation: getPublicOperation(failedRecord),
                error: { code, message }
            };
            emitWindowEvent('icepos:sync-operation-failed', detail);
            notifyPeers({ type: 'operation-failed', detail });
            emitQueueChanged({ affectedCollections });
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
        return false;
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
        await recoverOwnedSyncingRecords(ownerId);
        await processOperations(ownerId, generation, () => leaseIsValid);
        return true;
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
        let workerError = null;
        try {
            await navigator.locks.request(
                WORKER_LOCK_NAME,
                { ifAvailable: true },
                async lock => {
                    if (!lock) return;
                    lockAcquired = true;
                    try {
                        await reloadOperationsFromStorage();
                        await recoverOwnedSyncingRecords(ownerId);
                        await processOperations(ownerId, generation);
                    } catch (error) {
                        workerError = error;
                    }
                }
            );
        } catch (error) {
            console.warn('Web Locks no está disponible; se usará el bloqueo local.', error);
            return runWithFallbackLease(ownerId, generation);
        }
        if (workerError) throw workerError;
        if (!lockAcquired) {
            scheduleDrain(1_000);
            return false;
        }
        return true;
    }
    return runWithFallbackLease(ownerId, generation);
}

async function drainQueue() {
    if (workerPromise || !queueEnabled || !activeOwnerId) return workerPromise;

    const ownerId = activeOwnerId;
    const generation = workerGeneration;
    let drainFailed = false;
    let workerWasDeferred = false;
    workerPromise = ensureInitialized()
        .then(async () => {
            const acquired = await runWithCrossTabLock(ownerId, generation);
            workerWasDeferred = acquired === false;
        })
        .catch(error => {
            drainFailed = true;
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
            ) {
                scheduleDrain(0);
            } else if (
                !drainFailed
                && !workerWasDeferred
                && getNextOperation()
            ) {
                scheduleDrain(0);
            }
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
    persistAfter = null,
    entityKey = '',
    dependsOn = [],
    supersedesQueueIds = []
}) {
    if (!id || !type || !ownerId) {
        throw new Error('La operación local no tiene una identidad válida.');
    }

    const normalizedOwnerId = String(ownerId);
    const recordId = `${normalizedOwnerId}:${type}:${id}`;
    const existing = operations.get(recordId);
    if (existing && existing.status !== 'failed') {
        scheduleDrain(0);
        const existingVersion = getRecordVersion(existing);
        return {
            queued: true,
            alreadyQueued: true,
            operationId: recordId,
            version: existingVersion,
            persisted: persistencePromises.get(recordId) || Promise.resolve({
                queued: true,
                alreadyQueued: true,
                operationId: recordId,
                version: existingVersion
            })
        };
    }

    const now = Math.max(Date.now(), lastCreatedAt + 1);
    lastCreatedAt = now;
    const record = {
        id: recordId,
        type,
        ownerId: normalizedOwnerId,
        localId: String(localId || ''),
        payload: cloneValue(payload),
        optimisticMutations: cloneValue(optimisticMutations),
        status: 'queued',
        attempts: 0,
        nextAttemptAt: 0,
        lastErrorCode: '',
        lastErrorMessage: '',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        version: createVersionToken(),
        entityKey: String(entityKey || ''),
        dependsOn: normalizeDependsOn(dependsOn),
        persistencePending: true,
        stagingToken: `${now}-${Math.random().toString(36).slice(2)}`
    };

    operations.set(record.id, record);
    const affectedCollections = getAffectedCollections(record);
    emitQueueChanged({
        broadcast: false,
        affectedCollections
    });

    const immediateResult = {
        queued: true,
        alreadyQueued: false,
        operationId: record.id,
        version: record.version
    };
    const storageWork = serializeStorageTask(record.id, async () => {
        if (record.cancelled === true) {
            return {
                cancelled: true
            };
        }

        await awaitPersistAfter(persistAfter);
        if (record.cancelled === true) {
            return {
                cancelled: true
            };
        }

        const persistedRecord = {
            ...record,
            persistencePending: false
        };
        delete persistedRecord.cancelled;
        delete persistedRecord.stagingToken;
        const persistenceResult = await putRecordAtomically(persistedRecord, {
            supersedesQueueIds
        });
        if (record.cancelled === true) {
            return {
                cancelled: true,
                persistenceResult
            };
        }
        return {
            cancelled: false,
            persistenceResult
        };
    });

    const persistence = storageWork.then(outcome => {
        if (outcome.cancelled === true) {
            return {
                ...immediateResult,
                cancelled: true
            };
        }
        const { persistenceResult } = outcome;
        const normalizedRecord = normalizeLoadedRecord(
            persistenceResult.record || toDurableRecord(record)
        );
        const currentAfterPersist = operations.get(record.id);
        if (currentAfterPersist) {
            operations.set(record.id, (
                currentAfterPersist?.stagingToken === record.stagingToken
                    ? normalizedRecord
                    : chooseNewestRecord(normalizedRecord, currentAfterPersist)
            ));
        }

        const changedCollections = new Set(affectedCollections);
        (persistenceResult.supersededRecords || []).forEach(superseded => {
            const currentSuperseded = operations.get(superseded.id);
            if (
                currentSuperseded?.ownerId === record.ownerId
                && currentSuperseded.status === 'failed'
            ) {
                getAffectedCollections(currentSuperseded)
                    .forEach(collectionName => changedCollections.add(collectionName));
                operations.delete(superseded.id);
            }
        });
        emitQueueChanged({
            affectedCollections: Array.from(changedCollections)
        });
        scheduleDrain(0);
        return {
            ...immediateResult,
            alreadyQueued: persistenceResult.alreadyStored
        };
    }).catch(error => {
        const current = operations.get(record.id);
        if (record.cancelled === true) {
            return {
                ...immediateResult,
                cancelled: true
            };
        }
        if (
            current
            && getRecordVersion(current) !== getRecordVersion(record)
        ) {
            return {
                ...immediateResult,
                superseded: true
            };
        }
        const failedRecord = {
            ...record,
            status: 'failed',
            persistencePending: false,
            volatile: true,
            lastErrorCode: String(
                error?.code || 'local-storage-failed'
            ).slice(0, 120),
            lastErrorMessage: String(
                error?.message || 'No se pudo guardar la operación en este dispositivo.'
            ).slice(0, 500),
            updatedAt: Date.now()
        };
        delete failedRecord.cancelled;
        delete failedRecord.stagingToken;
        if (
            !current
            || (
                current?.stagingToken === record.stagingToken
                && current.persistencePending === true
            )
        ) {
            operations.set(record.id, failedRecord);
        }
        const detail = {
            operation: getPublicOperation(failedRecord),
            error: {
                code: failedRecord.lastErrorCode,
                message: failedRecord.lastErrorMessage
            }
        };
        emitWindowEvent('icepos:sync-operation-failed', detail);
        emitQueueChanged({
            broadcast: false,
            affectedCollections
        });
        scheduleDrain(0);
        throw error;
    }).finally(() => {
        if (persistencePromises.get(record.id) === persistence) {
            persistencePromises.delete(record.id);
        }
    });
    persistencePromises.set(record.id, persistence);
    void persistence.catch(() => {});
    void ensureInitialized().catch(error => {
        console.warn('La cola local se inicializará en el siguiente intento:', error);
    });

    return {
        ...immediateResult,
        persisted: persistence
    };
}

export function replaceQueuedSyncOperation({
    operationId,
    expectedVersion,
    payload,
    optimisticMutations,
    localId,
    persistAfter = null,
    entityKey,
    dependsOn
} = {}) {
    const normalizedId = String(operationId || '').trim();
    const normalizedExpectedVersion = String(expectedVersion || '').trim();
    if (!normalizedId || !normalizedExpectedVersion) {
        throw createQueueError(
            'invalid-replacement-cas',
            'El reemplazo necesita el identificador y la versión esperada.'
        );
    }

    const previousRecord = operations.get(normalizedId);
    if (!previousRecord || previousRecord.ownerId !== activeOwnerId) {
        throw createQueueError(
            'operation-not-found',
            'La operación pendiente ya no está disponible.'
        );
    }
    if (previousRecord.status === 'syncing') {
        throw createQueueError(
            'operation-in-flight',
            'La operación ya se está sincronizando.'
        );
    }
    if (!['queued', 'retry'].includes(previousRecord.status)) {
        throw createQueueError(
            'operation-not-replaceable',
            'Solo se pueden reemplazar operaciones pendientes.'
        );
    }
    if (getRecordVersion(previousRecord) !== normalizedExpectedVersion) {
        throw createQueueError(
            'operation-version-conflict',
            'La operación cambió antes de poder reemplazarla.'
        );
    }

    const now = Math.max(Date.now(), lastCreatedAt + 1);
    lastCreatedAt = now;
    const replacement = {
        ...previousRecord,
        localId: localId === undefined
            ? previousRecord.localId
            : String(localId || ''),
        payload: payload === undefined
            ? cloneValue(previousRecord.payload)
            : cloneValue(payload),
        optimisticMutations: optimisticMutations === undefined
            ? cloneValue(previousRecord.optimisticMutations)
            : cloneValue(optimisticMutations),
        status: 'queued',
        attempts: 0,
        nextAttemptAt: 0,
        lastErrorCode: '',
        lastErrorMessage: '',
        createdAt: previousRecord.createdAt,
        updatedAt: now,
        version: createVersionToken(),
        entityKey: entityKey === undefined
            ? String(previousRecord.entityKey || '')
            : String(entityKey || ''),
        dependsOn: dependsOn === undefined
            ? normalizeDependsOn(previousRecord.dependsOn)
            : normalizeDependsOn(dependsOn),
        persistencePending: true,
        volatile: false,
        stagingToken: `${now}-${Math.random().toString(36).slice(2)}`
    };
    delete replacement.cancelled;
    delete replacement.payloadFingerprint;

    const affectedCollections = new Set([
        ...getAffectedCollections(previousRecord),
        ...getAffectedCollections(replacement)
    ]);
    operations.set(normalizedId, replacement);
    emitQueueChanged({
        broadcast: false,
        affectedCollections: Array.from(affectedCollections)
    });

    const storageWork = serializeStorageTask(normalizedId, async () => {
        await awaitPersistAfter(persistAfter);
        return replaceRecordAtomically(replacement, {
            expectedVersion: normalizedExpectedVersion,
            allowInsertIfMissing: (
                previousRecord.persistencePending === true
                || previousRecord.volatile === true
            )
        });
    });

    const persistence = storageWork.then(result => {
        const normalizedRecord = normalizeLoadedRecord(
            result.record || toDurableRecord(replacement)
        );
        const current = operations.get(normalizedId);
        if (getRecordVersion(current) === replacement.version) {
            operations.set(normalizedId, normalizedRecord);
        }
        emitQueueChanged({
            affectedCollections: Array.from(affectedCollections)
        });
        scheduleDrain(0);
        return {
            replaced: true,
            operationId: normalizedId,
            previousVersion: normalizedExpectedVersion,
            version: normalizedRecord.version,
            persisted: true
        };
    }).catch(async error => {
        const current = operations.get(normalizedId);
        if (
            current
            && current.persistencePending === true
            && getRecordVersion(current) !== replacement.version
        ) {
            return {
                replaced: false,
                superseded: true,
                operationId: normalizedId,
                previousVersion: normalizedExpectedVersion,
                version: getRecordVersion(current)
            };
        }
        if (getRecordVersion(current) === replacement.version) {
            let storedRecord = null;
            try {
                storedRecord = normalizeLoadedRecord(
                    await getStoredRecord(normalizedId)
                );
            } catch (_) {}

            if (storedRecord) {
                operations.set(normalizedId, storedRecord);
            } else if (
                previousRecord.persistencePending !== true
                && previousRecord.volatile !== true
            ) {
                operations.set(normalizedId, previousRecord);
            } else {
                const failedReplacement = {
                    ...replacement,
                    status: 'failed',
                    persistencePending: false,
                    volatile: true,
                    lastErrorCode: String(
                        error?.code || 'local-storage-failed'
                    ).slice(0, 120),
                    lastErrorMessage: String(
                        error?.message
                        || 'No se pudo reemplazar la operación en este dispositivo.'
                    ).slice(0, 500),
                    updatedAt: Date.now()
                };
                delete failedReplacement.stagingToken;
                operations.set(normalizedId, failedReplacement);
            }
        }

        const detail = {
            operation: getPublicOperation(replacement),
            error: {
                code: String(error?.code || 'local-storage-failed'),
                message: String(
                    error?.message
                    || 'No se pudo reemplazar la operación local.'
                ).slice(0, 500)
            }
        };
        emitWindowEvent('icepos:sync-operation-failed', detail);
        emitQueueChanged({
            broadcast: false,
            affectedCollections: Array.from(affectedCollections)
        });
        throw error;
    }).finally(() => {
        if (persistencePromises.get(normalizedId) === persistence) {
            persistencePromises.delete(normalizedId);
        }
    });
    persistencePromises.set(normalizedId, persistence);
    void persistence.catch(() => {});

    return {
        replaced: true,
        operationId: normalizedId,
        previousVersion: normalizedExpectedVersion,
        version: replacement.version,
        persisted: persistence
    };
}

export function getPendingSyncOperations() {
    return [...operations.values()]
        .filter(isPendingForActiveOwner)
        .sort(compareOperationOrder)
        .map(getPublicOperation);
}

export function getPendingSyncOperationById(operationId) {
    const record = operations.get(String(operationId || ''));
    return isPendingForActiveOwner(record)
        ? getPublicOperation(record)
        : null;
}

export function getPendingSyncOperationsForEntity(entityKey) {
    const normalizedEntityKey = String(entityKey || '');
    if (!normalizedEntityKey) return [];
    return [...operations.values()]
        .filter(record => (
            isPendingForActiveOwner(record)
            && record.entityKey === normalizedEntityKey
        ))
        .sort(compareOperationOrder)
        .map(getPublicOperation);
}

export async function getSyncOperationSnapshot({ ownerId, type, id } = {}) {
    if (!ownerId || !type || !id) return null;
    await ensureInitialized();
    const recordId = `${String(ownerId)}:${type}:${id}`;
    const record = operations.get(recordId);
    return record ? getPublicOperation(record) : null;
}

export async function getSyncOperationStatus({ ownerId, type, id } = {}) {
    if (!ownerId || !type || !id) return '';
    const recordId = `${String(ownerId)}:${type}:${id}`;
    const inMemoryStatus = operations.get(recordId)?.status || '';
    if (inMemoryStatus) return inMemoryStatus;
    await ensureInitialized();
    return operations.get(recordId)?.status || '';
}

export async function getFailedSyncOperations() {
    try {
        await ensureInitialized();
    } catch (error) {
        const hasVolatileFailures = [...operations.values()].some(record => (
            record.ownerId === activeOwnerId
            && record.status === 'failed'
            && record.volatile === true
        ));
        if (!hasVolatileFailures) throw error;
    }
    return [...operations.values()]
        .filter(record => (
            record.ownerId === activeOwnerId
            && record.status === 'failed'
        ))
        .sort(compareOperationOrder)
        .map(getPublicOperation);
}

export function applyPendingDocumentMutations(collectionName, rows = []) {
    const baseDocuments = new Map(
        (Array.isArray(rows) ? rows : []).map(row => [String(row.id), row])
    );
    const documents = new Map(baseDocuments);
    const visibleRecords = [...operations.values()]
        .filter(record => (
            isVisiblePending(record)
            || isVisibleCommittedProjection(record)
        ))
        .sort(compareOperationOrder);
    const acknowledgedThroughIndex = new Map();

    visibleRecords.forEach((record, recordIndex) => {
        if (record.status !== 'committed') return;
        const operationId = getCommittedProjectionOperationId(record);
        record.optimisticMutations.forEach(mutation => {
            if (
                mutation?.collection !== collectionName
                || !mutation.documentId
                || !baseDocumentAcknowledgesCommittedMutation(
                    mutation,
                    baseDocuments,
                    operationId
                )
            ) return;
            const documentKey = `${collectionName}/${String(mutation.documentId)}`;
            acknowledgedThroughIndex.set(
                documentKey,
                Math.max(
                    acknowledgedThroughIndex.get(documentKey) ?? -1,
                    recordIndex
                )
            );
        });
    });

    visibleRecords.forEach((record, recordIndex) => {
            const isCommittedProjection = record.status === 'committed';

            record.optimisticMutations.forEach(mutation => {
                if (
                    mutation?.collection !== collectionName
                    || !mutation.documentId
                ) return;
                if (
                    isCommittedProjection
                    && (acknowledgedThroughIndex.get(
                        `${collectionName}/${String(mutation.documentId)}`
                    ) ?? -1) >= recordIndex
                ) {
                    return;
                }

                const id = String(mutation.documentId);
                if (mutation.kind === 'delete') {
                    documents.delete(id);
                    return;
                }
                if (mutation.kind === 'increment') {
                    const canCreateProjection =
                        collectionName === 'control_vasos_diario';
                    const current = documents.get(id)
                        || (canCreateProjection ? { id } : null);
                    if (!current) return;
                    const next = { ...current };
                    Object.entries(mutation.data || {}).forEach(([field, delta]) => {
                        const amount = Number(delta);
                        const rawCurrent = next[field];
                        const canDefaultToZero = (
                            field === 'ventasTotales'
                            || (
                                collectionName === 'control_vasos_diario'
                                && ['consumidos', 'entradas'].includes(field)
                            )
                        );
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
                        ...(isCommittedProjection
                            ? {
                                sincronizacionPendiente: false,
                                sincronizacionOperacionId: '',
                                sincronizacionEstado: '',
                                sincronizacionIntentos: 0,
                                sincronizacionErrorCodigo: '',
                                sincronizacionErrorMensaje: ''
                            }
                            : {
                                sincronizacionPendiente: true,
                                sincronizacionOperacionId: record.id,
                                sincronizacionEstado: String(record.status || 'queued'),
                                sincronizacionIntentos: Math.max(
                                    0,
                                    Number(record.attempts) || 0
                                ),
                                sincronizacionErrorCodigo: String(
                                    record.lastErrorCode || ''
                                ),
                                sincronizacionErrorMensaje: String(
                                    record.lastErrorMessage || ''
                                )
                            })
                    });
                    return;
                }
                if (mutation.kind !== 'merge') return;

                documents.set(id, {
                    ...(documents.get(id) || {}),
                    ...(mutation.data || {}),
                    id,
                    ...(isCommittedProjection
                        ? {
                            sincronizacionPendiente: false,
                            sincronizacionOperacionId: '',
                            sincronizacionEstado: '',
                            sincronizacionIntentos: 0,
                            sincronizacionErrorCodigo: '',
                            sincronizacionErrorMensaje: ''
                        }
                        : {
                            sincronizacionPendiente: true,
                            sincronizacionOperacionId: record.id,
                            sincronizacionEstado: String(record.status || 'queued'),
                            sincronizacionIntentos: Math.max(
                                0,
                                Number(record.attempts) || 0
                            ),
                            sincronizacionErrorCodigo: String(
                                record.lastErrorCode || ''
                            ),
                            sincronizacionErrorMensaje: String(
                                record.lastErrorMessage || ''
                            )
                        })
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
    const normalizedId = String(operationId || '');
    let memoryRecord = operations.get(normalizedId);
    if (!memoryRecord) {
        await ensureInitialized();
        memoryRecord = operations.get(normalizedId);
    }
    if (!memoryRecord || memoryRecord.ownerId !== activeOwnerId) return false;
    if (memoryRecord.status === 'syncing') {
        throw createQueueError(
            'operation-in-flight',
            'No se puede descartar una operación que ya se está sincronizando.'
        );
    }
    if (memoryRecord.status === 'committed') {
        throw createQueueError(
            'operation-not-discardable',
            'Una operación confirmada no se puede descartar.'
        );
    }

    const affectedCollections = getAffectedCollections(memoryRecord);
    const expectedVersion = getRecordVersion(memoryRecord);
    const discardOwnerId = memoryRecord.ownerId;
    if (memoryRecord.persistencePending === true) {
        memoryRecord.cancelled = true;
    }
    operations.delete(normalizedId);
    emitQueueChanged({
        broadcast: false,
        affectedCollections
    });

    const deletion = serializeStorageTask(normalizedId, () => (
        deleteRecordConditionally(normalizedId, {
            ownerId: discardOwnerId,
            expectedVersion,
            allowAnyFailedVersion: memoryRecord.volatile === true
        })
    ));

    try {
        const outcome = await deletion;
        if (outcome?.ownerConflict) {
            throw createQueueError(
                'operation-owner-conflict',
                'La operación pertenece a otra sesión.'
            );
        }
        if (outcome?.versionConflict) {
            throw createQueueError(
                'operation-version-conflict',
                'La operación cambió antes de poder descartarla.'
            );
        }
        const current = operations.get(normalizedId);
        if (getRecordVersion(current) === expectedVersion) {
            operations.delete(normalizedId);
        }
        emitQueueChanged({
            affectedCollections
        });
        scheduleDrain(0);
    } catch (error) {
        const current = operations.get(normalizedId);
        if (!current) {
            let storedRecord = null;
            try {
                storedRecord = normalizeLoadedRecord(
                    await getStoredRecord(normalizedId)
                );
            } catch (_) {}
            if (storedRecord) {
                operations.set(normalizedId, storedRecord);
            } else if (memoryRecord.persistencePending !== true) {
                operations.set(normalizedId, memoryRecord);
            }
        }
        emitQueueChanged({
            broadcast: false,
            affectedCollections
        });
        throw error;
    }
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
    if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
        retryTimerDueAt = 0;
    }
    emitQueueChanged({ broadcast: false });
}
