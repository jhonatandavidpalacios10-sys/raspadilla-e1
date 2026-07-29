import {
    db,
    collection,
    getDocs,
    onSnapshot,
    query,
    where
} from './firebase-setup.js';
import { state } from './store.js';
import { getTodayDateStr } from '../utils/helpers.js';
import { persistLocationsCache } from './local-cache.js';
import { applyPendingDocumentMutations } from './sync-queue.js';

const sharedSubscriptions = new Map();
let syncQueueListenerInstalled = false;

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

function deliverEntry(entry) {
    if (!entry.rows || entry.closed) return;
    const rows = projectEntryRows(entry);
    entry.callbacks.forEach(callback => callback(rows));
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
            deliverEntry(entry);
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
            unsubscribe: null,
            closed: false,
            collectionName,
            rowPredicate
        };

        entry.unsubscribe = onSnapshot(
            queryRef,
            snapshot => {
                if (entry.closed) return;
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'removed') {
                        entry.rowsById.delete(change.doc.id);
                        return;
                    }
                    entry.rowsById.set(change.doc.id, {
                        id: change.doc.id,
                        ...change.doc.data({ serverTimestamps: 'estimate' })
                    });
                });
                entry.rows = Array.from(entry.rowsById.values());
                deliverEntry(entry);
            },
            error => {
                if (entry.closed) return;
                entry.closed = true;
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
    if (entry.rows) {
        queueMicrotask(() => {
            if (active && !entry.closed && entry.callbacks.has(onData)) {
                onData(projectEntryRows(entry));
            }
        });
    }
    return () => {
        if (!active) return;
        active = false;
        entry.callbacks.delete(onData);
        if (onError) entry.errorCallbacks.delete(onError);

        if (entry.callbacks.size === 0) {
            entry.closed = true;
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
        snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
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

export function subscribeLocations(onData = () => {}, onError) {
    return subscribeShared(
        'locales:all',
        collection(db, 'locales'),
        rows => {
            const locations = normalizeLocations(rows);
            state.locales = locations;
            persistLocationsCache(locations);
            populateLocationFilters();
            onData(locations);
        },
        onError
    );
}

export function populateLocationFilters() {
    const options = [
        '<option value="todas">Todas / General</option>',
        ...state.locales.map(local => `<option value="${local.id}">${local.nombre}</option>`),
        '<option value="">Sin Asignar / Antiguas</option>'
    ].join('');

    ['filtro-local-caja', 'analisisLocalFilter', 'filtro-local-pedidos', 'exportLocalFilter']
        .forEach(id => {
            const select = document.getElementById(id);
            if (select) select.innerHTML = options;
        });

    const expenseSelect = document.getElementById('gasto-local');
    if (expenseSelect) {
        if (!isPrivilegedRole() && state.userLocalId) {
            expenseSelect.innerHTML = `<option value="${state.userLocalId}">${state.userLocal || 'Mi sede'}</option>`;
            expenseSelect.disabled = true;
        } else {
            expenseSelect.innerHTML = [
                '<option value="">General / Sin asignar</option>',
                ...state.locales.map(local => `<option value="${local.id}">${local.nombre}</option>`)
            ].join('');
            expenseSelect.disabled = false;
        }
    }
}

export function resetDataSubscriptions() {
    sharedSubscriptions.forEach(entry => {
        entry.closed = true;
        entry.unsubscribe?.();
        entry.callbacks.clear();
        entry.errorCallbacks.clear();
        entry.rowsById.clear();
    });
    sharedSubscriptions.clear();
}
