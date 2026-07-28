const DATABASE_NAME = 'raffaelito-pos-drafts';
const DATABASE_VERSION = 1;
const STORE_NAME = 'saleDrafts';
const DRAFT_VERSION = 1;
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let databasePromise = null;
const writeQueues = new Map();

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

export async function saveSaleDraft(scope, draft) {
    if (!scope?.key || !scope?.uid || !scope?.localId) return;

    const record = {
        version: DRAFT_VERSION,
        scopeKey: scope.key,
        uid: scope.uid,
        localId: scope.localId,
        updatedAt: Date.now(),
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

    const database = await openDatabase();
    const record = await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(scope.key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(
            request.error || new Error('No se pudo leer el borrador local.')
        );
    });

    const isValid = (
        record
        && record.version === DRAFT_VERSION
        && record.scopeKey === scope.key
        && record.uid === scope.uid
        && record.localId === scope.localId
        && Number.isFinite(Number(record.updatedAt))
        && Date.now() - Number(record.updatedAt) <= MAX_DRAFT_AGE_MS
        && Array.isArray(record.cart)
    );

    if (isValid) return record;
    if (record) await deleteSaleDraft(scope);
    return null;
}

export async function deleteSaleDraft(scope) {
    if (!scope?.key) return;
    return enqueueScopeWrite(scope.key, () => deleteRecord(scope.key));
}
