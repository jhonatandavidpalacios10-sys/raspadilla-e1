const DATABASE_NAME = 'raffaelito-pos-drafts';
const DATABASE_VERSION = 1;
const STORE_NAME = 'saleDrafts';
const DRAFT_VERSION = 1;
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_RECORD_KIND = 'accepted-sale-recovery';

let databasePromise = null;
const writeQueues = new Map();

function createWriteToken() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeScopePart(value, fallback = '') {
    const normalized = String(value || '').trim();
    return normalized || fallback;
}

export function createSaleDraftScope({ uid, localId } = {}) {
    const normalizedUid = normalizeScopePart(uid);
    if (!normalizedUid) return null;

    return {
        key: `${normalizedUid}::${normalizeScopePart(localId, 'general')}`,
        uid: normalizedUid,
        localId: normalizeScopePart(localId, 'general')
    };
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
        const openTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            databasePromise = null;
            reject(new Error('IndexedDB tardó demasiado en responder.'));
        }, 3000);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, {
                    keyPath: 'scopeKey'
                });
                store.createIndex('updatedAt', 'updatedAt');
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            if (settled) {
                database.close();
                return;
            }
            settled = true;
            clearTimeout(openTimeout);
            database.onversionchange = () => {
                database.close();
                databasePromise = null;
            };
            resolve(database);
        };
        request.onerror = () => {
            if (settled) return;
            settled = true;
            clearTimeout(openTimeout);
            databasePromise = null;
            reject(request.error || new Error('No se pudo abrir IndexedDB.'));
        };
        request.onblocked = () => {
            console.warn('IndexedDB está esperando que otra pestaña cierre una versión anterior.');
        };
    });

    return databasePromise;
}

function enqueueScopeWrite(scopeKey, operation) {
    const previous = writeQueues.get(scopeKey) || Promise.resolve();
    const current = previous
        .catch(() => {})
        .then(operation);

    writeQueues.set(scopeKey, current);
    void current
        .finally(() => {
            if (writeQueues.get(scopeKey) === current) writeQueues.delete(scopeKey);
        })
        .catch(() => {});
    return current;
}

async function waitForScopeWrites(scopeKey) {
    const pending = writeQueues.get(scopeKey);
    if (pending) await pending.catch(() => {});
}

function putRecord(record) {
    return openDatabase().then(database => new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(record);
        transaction.oncomplete = () => resolve(record);
        transaction.onerror = () => reject(
            transaction.error || new Error('No se pudo guardar el borrador local.')
        );
        transaction.onabort = () => reject(
            transaction.error || new Error('Se canceló el guardado del borrador local.')
        );
    }));
}

function deleteRecord(scopeKey) {
    return openDatabase().then(database => new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(scopeKey);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(
            transaction.error || new Error('No se pudo eliminar el borrador local.')
        );
        transaction.onabort = () => reject(
            transaction.error || new Error('Se canceló la limpieza del borrador local.')
        );
    }));
}

function getRecord(scopeKey) {
    return openDatabase().then(database => new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(scopeKey);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(
            request.error || new Error('No se pudo leer el borrador local.')
        );
    }));
}

function getAllRecords() {
    return openDatabase().then(database => new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(
            Array.isArray(request.result) ? request.result : []
        );
        request.onerror = () => reject(
            request.error || new Error('No se pudieron leer las recuperaciones locales.')
        );
    }));
}

function getRecoveryKey(scope, attempt) {
    const operationId = String(attempt?.operationId || '').trim();
    const queueVersion = String(attempt?.queueVersion || '').trim();
    if (!scope?.key || !operationId || !queueVersion) return '';
    return `${scope.key}::recovery::${operationId}::${queueVersion}`;
}

function isValidRecord(record, scope, { recovery = false } = {}) {
    return Boolean(
        record
        && record.version === DRAFT_VERSION
        && record.uid === scope.uid
        && record.localId === scope.localId
        && Number.isFinite(Number(record.updatedAt))
        && Date.now() - Number(record.updatedAt) <= MAX_DRAFT_AGE_MS
        && Array.isArray(record.cart)
        && (
            recovery
                ? (
                    record.recordKind === RECOVERY_RECORD_KIND
                    && record.baseScopeKey === scope.key
                )
                : (
                    record.scopeKey === scope.key
                    && !record.recordKind
                )
        )
    );
}

function deleteRecordIfAttemptMatches(scopeKey, expectedAttempt) {
    return openDatabase().then(database => new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(scopeKey);
        let deleted = false;

        request.onsuccess = () => {
            const storedAttempt = request.result?.attempt;
            const expectedOperationId = String(
                expectedAttempt.operationId || ''
            );
            const expectedQueueVersion = String(
                expectedAttempt.queueVersion || ''
            );
            const expectedUpdatedAt = Number(expectedAttempt.updatedAt || 0);
            const expectedWriteToken = String(
                expectedAttempt.writeToken || ''
            );
            const attemptMatches = (
                !expectedOperationId
                && !expectedQueueVersion
            ) || (
                String(storedAttempt?.operationId || '')
                    === expectedOperationId
                && String(storedAttempt?.queueVersion || '')
                    === expectedQueueVersion
            );
            const timestampMatches = (
                expectedUpdatedAt <= 0
                || Number(request.result?.updatedAt || 0) === expectedUpdatedAt
            );
            const writeTokenMatches = (
                !expectedWriteToken
                || String(request.result?.writeToken || '')
                    === expectedWriteToken
            );
            const matches = (
                Boolean(request.result)
                && attemptMatches
                && timestampMatches
                && writeTokenMatches
            );
            if (!matches) return;
            deleted = true;
            store.delete(scopeKey);
        };
        request.onerror = () => {
            transaction.abort();
        };
        transaction.oncomplete = () => resolve({ deleted });
        transaction.onerror = () => reject(
            transaction.error || new Error('No se pudo limpiar el borrador local.')
        );
        transaction.onabort = () => reject(
            transaction.error || request.error
            || new Error('Se canceló la limpieza del borrador local.')
        );
    }));
}

export async function saveSaleDraft(scope, draft) {
    if (!scope?.key || !scope?.uid || !scope?.localId) return;

    const record = {
        version: DRAFT_VERSION,
        scopeKey: scope.key,
        uid: scope.uid,
        localId: scope.localId,
        updatedAt: Date.now(),
        writeToken: createWriteToken(),
        intentToken: String(draft?.intentToken || createWriteToken()),
        cart: Array.isArray(draft?.cart) ? draft.cart : [],
        payment: draft?.payment || null,
        attempt: draft?.attempt || null,
        editContext: draft?.editContext || null
    };

    return enqueueScopeWrite(scope.key, () => putRecord(record));
}

export async function saveSaleRecoveryDraft(scope, draft) {
    const recoveryKey = getRecoveryKey(scope, draft?.attempt);
    if (!recoveryKey || !scope?.uid || !scope?.localId) return null;

    const record = {
        version: DRAFT_VERSION,
        scopeKey: recoveryKey,
        baseScopeKey: scope.key,
        recordKind: RECOVERY_RECORD_KIND,
        uid: scope.uid,
        localId: scope.localId,
        updatedAt: Date.now(),
        writeToken: createWriteToken(),
        intentToken: String(draft?.intentToken || createWriteToken()),
        cart: Array.isArray(draft?.cart) ? draft.cart : [],
        payment: draft?.payment || null,
        attempt: draft?.attempt || null,
        editContext: draft?.editContext || null
    };

    return enqueueScopeWrite(scope.key, () => putRecord(record));
}

export async function loadSaleDraft(scope) {
    if (!scope?.key || !scope?.uid || !scope?.localId) return null;
    await waitForScopeWrites(scope.key);

    const record = await getRecord(scope.key);
    if (isValidRecord(record, scope)) return record;
    if (record) {
        await deleteSaleDraftIfAttemptMatches(scope, {
            operationId: String(record.attempt?.operationId || ''),
            queueVersion: String(record.attempt?.queueVersion || ''),
            updatedAt: Number(record.updatedAt || 0),
            writeToken: String(record.writeToken || '')
        });
    }
    return null;
}

export async function loadSaleRecoveryDrafts(scope) {
    if (!scope?.key || !scope?.uid || !scope?.localId) return [];
    await waitForScopeWrites(scope.key);
    const records = await getAllRecords();
    return records
        .filter(record => isValidRecord(record, scope, { recovery: true }))
        .sort((left, right) => (
            Number(left.updatedAt || 0) - Number(right.updatedAt || 0)
        ));
}

export async function deleteSaleDraft(scope) {
    if (!scope?.key) return;
    return enqueueScopeWrite(scope.key, () => deleteRecord(scope.key));
}

export async function deleteSaleDraftIfAttemptMatches(scope, expectedAttempt) {
    if (
        !scope?.key
        || (
            !expectedAttempt?.writeToken
            &&
            !expectedAttempt?.updatedAt
            && (
                !expectedAttempt?.operationId
                || !expectedAttempt?.queueVersion
            )
        )
    ) {
        return { deleted: false };
    }
    return enqueueScopeWrite(
        scope.key,
        () => deleteRecordIfAttemptMatches(scope.key, expectedAttempt)
    );
}

export async function deleteSaleRecoveryDraft(scope, expectedAttempt) {
    const recoveryKey = getRecoveryKey(scope, expectedAttempt);
    if (!recoveryKey) return;
    return enqueueScopeWrite(scope.key, () => deleteRecord(recoveryKey));
}

export async function promoteSaleRecoveryDraft(scope, recoveryRecord) {
    const recoveryKey = getRecoveryKey(scope, recoveryRecord?.attempt);
    const expectedWriteToken = String(recoveryRecord?.writeToken || '');
    if (!recoveryKey || !expectedWriteToken) {
        return { promoted: false, invalid: true };
    }

    return enqueueScopeWrite(scope.key, async () => {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            let outcome = { promoted: false };
            let operationError = null;
            const recoveryRequest = store.get(recoveryKey);

            recoveryRequest.onsuccess = () => {
                const storedRecovery = recoveryRequest.result;
                if (!storedRecovery) {
                    outcome = { promoted: false, missing: true };
                    return;
                }
                if (
                    String(storedRecovery.writeToken || '')
                    !== expectedWriteToken
                ) {
                    outcome = { promoted: false, changed: true };
                    return;
                }

                const baseRequest = store.get(scope.key);
                baseRequest.onsuccess = () => {
                    const existingBase = baseRequest.result;
                    const sameAttempt = (
                        String(existingBase?.attempt?.operationId || '')
                            === String(storedRecovery.attempt?.operationId || '')
                        && String(existingBase?.attempt?.queueVersion || '')
                            === String(storedRecovery.attempt?.queueVersion || '')
                    );
                    const sameIntent = Boolean(
                        sameAttempt
                        && existingBase?.intentToken
                        && storedRecovery.intentToken
                        && existingBase.intentToken
                            === storedRecovery.intentToken
                    );
                    const baseIsBusy = Boolean(
                        existingBase
                        && !sameIntent
                        && (
                            (Array.isArray(existingBase.cart)
                                && existingBase.cart.length > 0)
                            || existingBase.editContext
                        )
                    );
                    if (baseIsBusy) {
                        outcome = { promoted: false, busy: true };
                        return;
                    }

                    const promotedRecord = {
                        ...storedRecovery,
                        scopeKey: scope.key,
                        updatedAt: Date.now(),
                        writeToken: createWriteToken()
                    };
                    delete promotedRecord.baseScopeKey;
                    delete promotedRecord.recordKind;
                    store.put(promotedRecord);
                    store.delete(recoveryKey);
                    outcome = {
                        promoted: true,
                        record: promotedRecord
                    };
                };
                baseRequest.onerror = () => {
                    operationError = baseRequest.error;
                    transaction.abort();
                };
            };
            recoveryRequest.onerror = () => {
                operationError = recoveryRequest.error;
                transaction.abort();
            };
            transaction.oncomplete = () => resolve(outcome);
            transaction.onerror = () => reject(
                operationError
                || transaction.error
                || new Error('No se pudo promover la recuperación local.')
            );
            transaction.onabort = () => reject(
                operationError
                || transaction.error
                || new Error('Se canceló la recuperación local.')
            );
        });
    });
}
