import {
    db,
    collection,
    getDocs,
    onSnapshot,
    query,
    where
} from './firebase-setup.js';
import { state } from './store.js';
import { escaparHtml, getTodayDateStr } from '../utils/helpers.js';
import { persistLocationsCache } from './local-cache.js';
import { applyPendingDocumentMutations } from './sync-queue.js';

const sharedSubscriptions = new Map();
let syncQueueListenerInstalled = false;
let lastLocationsStateSignature = '';

function isPrivilegedRole() {
    const role = String(state.userRole || '').trim().toLowerCase();
    return role === 'admin' || role === 'administrador' || role === 'master';
}

function getScope(requestedLocalId = 'todas') {
    if (isPrivilegedRole()) {
        if (requestedLocalId && requestedLocalId !== 'todas') {
            return { key: `local:${requestedLocalId}`, localId: requestedLocalId, mode: 'local' };
        }
        if (requestedLocalId === '') return { key: 'legacy', localId: '', mode: 'legacy' };
        return { key: 'all', localId: '', mode: 'all' };
    }
    return {
        key: state.userLocalId ? `local:${state.userLocalId}` : 'legacy',
        localId: state.userLocalId || '',
        mode: state.userLocalId ? 'local' : 'legacy'
    };
}

function makeScopedQuery(collectionName, constraints = [], requestedLocalId = 'todas') {
    const scope = getScope(requestedLocalId);
    const scopedConstraints = [...constraints];

    // Los documentos operativos nuevos siempre incluyen localId. Si una cuenta
    // antigua no tiene sede asignada, conservamos la consulta heredada para no
    // dejar la aplicación vacía.
    if (scope.localId) scopedConstraints.push(where('localId', '==', scope.localId));

    return {
        scope,
        ref: query(collection(db, collectionName), ...scopedConstraints)
    };
}

function projectEntryRows(entry) {
    let rows = entry.rows || [];
    if (entry.collectionName) {
        rows = applyPendingDocumentMutations(entry.collectionName, rows);
    }
    if (entry.rowPredicate) rows = rows.filter(entry.rowPredicate);
    return rows;
}

function getEntryDeliveryMetadata(entry) {
    return {
        ...(entry.snapshotMetadata || {}),
        hasRemoteSnapshot: entry.rows !== null
    };
}

function deliverEntry(entry, { allowWithoutSnapshot = false } = {}) {
    if (
        entry.closed
        || (entry.rows === null && !allowWithoutSnapshot)
    ) return;
    const rows = projectEntryRows(entry);
    if (entry.rows === null && rows.length === 0) return;
    const metadata = getEntryDeliveryMetadata(entry);
    entry.callbacks.forEach(callback => callback(rows, metadata));
}

function installSyncQueueListener() {
    if (syncQueueListenerInstalled || typeof window === 'undefined') return;
    syncQueueListenerInstalled = true;
    window.addEventListener('icepos:sync-queue-changed', event => {
        const affectedCollections = event.detail?.affectedCollections;
        sharedSubscriptions.forEach(entry => {
            if (
                Array.isArray(affectedCollections)
                && !affectedCollections.includes(entry.collectionName)
            ) return;
            deliverEntry(entry, { allowWithoutSnapshot: true });
        });
    });
}

function subscribeShared(
    key,
    queryRef,
    onData,
    onError,
    { collectionName = '', rowPredicate = null } = {}
) {
    installSyncQueueListener();
    let entry = sharedSubscriptions.get(key);

    if (!entry) {
        entry = {
            callbacks: new Set(),
            errorCallbacks: new Set(),
            rowsById: new Map(),
            rows: null,
            snapshotMetadata: null,
            emptyCacheTimer: null,
            unsubscribe: null,
            closed: false,
            collectionName,
            rowPredicate
        };

        entry.unsubscribe = onSnapshot(
            queryRef,
            { includeMetadataChanges: true },
            snapshot => {
                if (entry.closed) return;
                clearTimeout(entry.emptyCacheTimer);
                entry.emptyCacheTimer = null;
                entry.snapshotMetadata = {
                    fromCache: snapshot.metadata.fromCache,
                    hasPendingWrites: snapshot.metadata.hasPendingWrites,
                    emptyCacheSettled: false
                };
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'removed') {
                        entry.rowsById.delete(change.doc.id);
                        return;
                    }
                    entry.rowsById.set(change.doc.id, {
                        ...change.doc.data({ serverTimestamps: 'estimate' }),
                        id: change.doc.id
                    });
                });
                entry.rows = Array.from(entry.rowsById.values());
                deliverEntry(entry);
                if (
                    entry.rows.length === 0
                    && snapshot.metadata.fromCache === true
                    && snapshot.metadata.hasPendingWrites !== true
                ) {
                    entry.emptyCacheTimer = setTimeout(() => {
                        entry.emptyCacheTimer = null;
                        if (
                            entry.closed
                            || entry.rows?.length !== 0
                            || entry.snapshotMetadata?.fromCache !== true
                        ) return;
                        entry.snapshotMetadata = {
                            ...entry.snapshotMetadata,
                            emptyCacheSettled: true
                        };
                        deliverEntry(entry);
                    }, 1_000);
                }
            },
            error => {
                if (entry.closed) return;
                entry.closed = true;
                clearTimeout(entry.emptyCacheTimer);
                entry.emptyCacheTimer = null;
                if (sharedSubscriptions.get(key) === entry) {
                    sharedSubscriptions.delete(key);
                }
                const callbacks = Array.from(entry.errorCallbacks);
                callbacks.forEach(callback => callback(error));
                entry.callbacks.clear();
                entry.errorCallbacks.clear();
                entry.rowsById.clear();
            }
        );

        sharedSubscriptions.set(key, entry);
    }

    let active = true;
    entry.callbacks.add(onData);
    if (onError) entry.errorCallbacks.add(onError);
    queueMicrotask(() => {
        if (!active || entry.closed || !entry.callbacks.has(onData)) return;
        const projectedRows = projectEntryRows(entry);
        if (entry.rows === null && projectedRows.length === 0) return;
        onData(projectedRows, getEntryDeliveryMetadata(entry));
    });
    return () => {
        if (!active) return;
        active = false;
        entry.callbacks.delete(onData);
        if (onError) entry.errorCallbacks.delete(onError);

        if (entry.callbacks.size === 0) {
            entry.closed = true;
            clearTimeout(entry.emptyCacheTimer);
            entry.emptyCacheTimer = null;
            entry.unsubscribe?.();
            entry.rowsById.clear();
            if (sharedSubscriptions.get(key) === entry) {
                sharedSubscriptions.delete(key);
            }
        }
    };
}

function matchesScope(row, scope) {
    if (scope.localId) return row.localId === scope.localId;
    if (scope.mode !== 'legacy') return true;
    return !row.localId || row.localId === '' || row.localId === 'general';
}

export function subscribeDailySales(onData, onError, date = getTodayDateStr(), requestedLocalId = 'todas') {
    const { ref, scope } = makeScopedQuery('ventas', [
        where('fechaStr', '==', date)
    ], requestedLocalId);
    return subscribeShared(
        `ventas:${date}:${scope.key}`,
        ref,
        onData,
        onError,
        {
            collectionName: 'ventas',
            rowPredicate: row => (
                row.fechaStr === date && matchesScope(row, scope)
            )
        }
    );
}

export function subscribeDailyExpenses(onData, onError, date = getTodayDateStr(), requestedLocalId = 'todas') {
    const { ref, scope } = makeScopedQuery('gastos', [
        where('fechaStr', '==', date)
    ], requestedLocalId);
    return subscribeShared(
        `gastos:${date}:${scope.key}`,
        ref,
        onData,
        onError,
        {
            collectionName: 'gastos',
            rowPredicate: row => (
                row.fechaStr === date && matchesScope(row, scope)
            )
        }
    );
}

function subscribeRange(collectionName, startDate, endDate, onData, onError, requestedLocalId) {
    const constraints = [
        where('fechaStr', '>=', startDate),
        where('fechaStr', '<=', endDate)
    ];
    const { ref, scope } = makeScopedQuery(collectionName, constraints, requestedLocalId);
    let fallbackRelease = null;
    let primaryRelease = () => {};
    const rowPredicate = row => (
        row.fechaStr >= startDate
        && row.fechaStr <= endDate
        && matchesScope(row, scope)
    );

    const handlePrimaryError = error => {
        // Una combinación localId + rango puede requerir un índice compuesto
        // todavía no creado. El fallback conserva la aplicación operativa y
        // filtra únicamente ese rango en memoria, sin configuración manual.
        if (error?.code === 'failed-precondition' && scope.localId && !fallbackRelease) {
            primaryRelease();
            const fallbackRef = query(collection(db, collectionName), ...constraints);
            fallbackRelease = subscribeShared(
                `${collectionName}:${startDate}:${endDate}:fallback:${scope.key}`,
                fallbackRef,
                onData,
                onError,
                { collectionName, rowPredicate }
            );
            return;
        }
        onError?.(error);
    };

    primaryRelease = subscribeShared(
        `${collectionName}:${startDate}:${endDate}:${scope.key}`,
        ref,
        onData,
        handlePrimaryError,
        { collectionName, rowPredicate }
    );

    return () => {
        primaryRelease();
        fallbackRelease?.();
    };
}

export function subscribeSalesRange(startDate, endDate, onData, onError, requestedLocalId = 'todas') {
    return subscribeRange('ventas', startDate, endDate, onData, onError, requestedLocalId);
}

export function subscribeExpensesRange(startDate, endDate, onData, onError, requestedLocalId = 'todas') {
    return subscribeRange('gastos', startDate, endDate, onData, onError, requestedLocalId);
}

export async function loadLocations({ shouldApply = () => true } = {}) {
    const snapshot = await getDocs(collection(db, 'locales'));
    const locations = normalizeLocations(
        snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
    );
    persistLocationsCache(locations);
    if (!shouldApply()) return locations;
    state.locales = locations;
    populateLocationFilters();
    return state.locales;
}

function normalizeLocations(rows) {
    return [...rows].sort((a, b) => (
        String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es')
    ));
}

function getLocationsStateSignature(locations) {
    return JSON.stringify(locations.map(location => [
        String(location.id || ''),
        String(location.nombre || '')
    ]));
}

export function subscribeLocations(onData = () => {}, onError) {
    return subscribeShared(
        'locales:all',
        collection(db, 'locales'),
        (rows, metadata) => {
            if (
                rows.length === 0
                && metadata?.fromCache === true
                && metadata?.hasPendingWrites !== true
                && (
                    state.locales.length > 0
                    || metadata?.emptyCacheSettled !== true
                )
                && (typeof navigator === 'undefined' || navigator.onLine !== false)
            ) {
                onData(state.locales, {
                    ...metadata,
                    preservedLocalCache: state.locales.length > 0,
                    deferredEmptyCache: true
                });
                return;
            }
            const locations = normalizeLocations(rows);
            const signature = getLocationsStateSignature(locations);
            if (signature !== lastLocationsStateSignature) {
                lastLocationsStateSignature = signature;
                state.locales = locations;
                persistLocationsCache(locations);
                populateLocationFilters();
            }
            onData(locations, metadata);
        },
        onError
    );
}

export function subscribeUsers(onData = () => {}, onError) {
    return subscribeShared(
        'usuarios:all',
        collection(db, 'usuarios'),
        onData,
        onError
    );
}

export function populateLocationFilters() {
    const options = [
        '<option value="todas">Todas / General</option>',
        ...state.locales.map(local => (
            `<option value="${escaparHtml(local.id || '')}">${escaparHtml(local.nombre || 'Sin nombre')}</option>`
        )),
        '<option value="">Sin Asignar / Antiguas</option>'
    ].join('');

    const filtersToNotify = [];
    ['filtro-local-caja', 'analisisLocalFilter', 'filtro-local-pedidos', 'exportLocalFilter']
        .forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            const hadOptions = select.options.length > 0;
            const previousValue = select.value;
            select.innerHTML = options;
            if (
                hadOptions
                &&
                Array.from(select.options)
                    .some(option => option.value === previousValue)
            ) {
                select.value = previousValue;
            } else {
                select.value = 'todas';
                if (hadOptions && previousValue !== 'todas') {
                    filtersToNotify.push(select);
                }
            }
        });
    filtersToNotify.forEach(select => {
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const expenseSelect = document.getElementById('gasto-local');
    if (expenseSelect) {
        const previousValue = expenseSelect.value;
        if (!isPrivilegedRole() && state.userLocalId) {
            expenseSelect.innerHTML = `<option value="${escaparHtml(state.userLocalId)}">${escaparHtml(state.userLocal || 'Mi sede')}</option>`;
            expenseSelect.disabled = true;
        } else {
            expenseSelect.innerHTML = [
                '<option value="">General / Sin asignar</option>',
                ...state.locales.map(local => (
                    `<option value="${escaparHtml(local.id || '')}">${escaparHtml(local.nombre || 'Sin nombre')}</option>`
                ))
            ].join('');
            expenseSelect.disabled = false;
        }
        if (
            Array.from(expenseSelect.options)
                .some(option => option.value === previousValue)
        ) {
            expenseSelect.value = previousValue;
        }
    }
}

export function resetDataSubscriptions() {
    sharedSubscriptions.forEach(entry => {
        entry.closed = true;
        clearTimeout(entry.emptyCacheTimer);
        entry.emptyCacheTimer = null;
        entry.unsubscribe?.();
        entry.callbacks.clear();
        entry.errorCallbacks.clear();
        entry.rowsById.clear();
    });
    sharedSubscriptions.clear();
    lastLocationsStateSignature = '';
}
