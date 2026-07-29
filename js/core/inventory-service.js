import {
    auth,
    db,
    doc,
    runTransaction,
    serverTimestamp,
    setDoc,
    deleteDoc,
    increment
} from './firebase-setup.js';
import {
    enqueueSyncOperation,
    registerSyncHandler
} from './sync-queue.js';
import {
    resolvePublicAvailability,
    syncPublicAvailability
} from './public-catalog-service.js';

function roundMoney(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error('Monto no válido.');
    return Math.round((parsed + Number.EPSILON) * 100) / 100;
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

function getCupControlDocumentId(date, productId) {
    return `${String(date || '').replaceAll('/', '-')}_${
        String(productId || '').replaceAll('/', '_')
    }`;
}

async function commitProductUpsert(payload) {
    const productRef = doc(db, 'productos', payload.productId);
    await setDoc(productRef, {
        ...payload.data,
        lastOperationId: payload.operationId,
        fechaModificacion: serverTimestamp()
    }, { merge: payload.mode === 'update' });
}

async function commitProductDelete(payload) {
    await deleteDoc(doc(db, 'productos', payload.productId));
}

async function commitStockEntry(payload) {
    const productRef = doc(db, 'productos', payload.productId);
    const operationRef = doc(
        db,
        'operaciones_inventario',
        String(payload.operationId).replaceAll('/', '_')
    );
    const expenseRefs = (payload.expenses || []).map(expense => ({
        expense,
        ref: doc(db, 'gastos', expense.id),
        cashRef: doc(db, 'caja_diaria', `${expense.fechaStr}_${expense.localId || 'general'}`)
    }));

    return runTransaction(db, async transaction => {
        const [
            productSnapshot,
            operationSnapshot,
            ...expenseSnapshots
        ] = await Promise.all([
            transaction.get(productRef),
            transaction.get(operationRef),
            ...expenseRefs.map(item => transaction.get(item.ref))
        ]);
        if (!productSnapshot.exists()) throw new Error('El producto ya no existe.');

        const product = productSnapshot.data();
        if (operationSnapshot.exists()) {
            return {
                alreadyApplied: true,
                product: {
                    id: payload.productId,
                    ...product
                }
            };
        }

        const appliedIds = Array.isArray(product.stockOperationIds)
            ? product.stockOperationIds.map(String)
            : [];
        if (appliedIds.includes(payload.operationId)) {
            transaction.set(operationRef, {
                operationId: String(payload.operationId),
                productoId: String(payload.productId),
                recuperadoDesdeHistorial: true,
                aplicadoEn: serverTimestamp()
            });
            return {
                alreadyApplied: true,
                product: {
                    id: payload.productId,
                    ...product
                }
            };
        }

        const currentStock = Number(product.stock);
        const safeCurrentStock = Number.isFinite(currentStock) ? currentStock : 0;
        const nextStock = safeCurrentStock + Number(payload.quantity || 0);
        if (!Number.isFinite(nextStock) || nextStock < 0) {
            throw new Error('El stock resultante no es válido.');
        }

        transaction.update(productRef, {
            stock: nextStock,
            stockOperationIds: [...appliedIds, payload.operationId].slice(-100),
            lastInventoryOperationId: payload.operationId,
            fechaModificacion: serverTimestamp()
        });
        transaction.set(operationRef, {
            operationId: String(payload.operationId),
            productoId: String(payload.productId),
            cantidad: Number(payload.quantity || 0),
            aplicadoEn: serverTimestamp()
        });

        const isCupInventory = isCupInventoryProduct(product);
        if (isCupInventory && payload.cupControlDate) {
            const controlId = getCupControlDocumentId(
                payload.cupControlDate,
                payload.productId
            );
            transaction.set(doc(db, 'control_vasos_diario', controlId), {
                fechaStr: String(payload.cupControlDate),
                productoId: String(payload.productId),
                productoNombre: String(product.nombre || 'Vaso'),
                localId: String(product.localId || 'global'),
                localNombre: String(payload.localNombre || ''),
                entradas: increment(Number(payload.quantity || 0)),
                stockFinal: nextStock,
                actualizadoEn: serverTimestamp()
            }, { merge: true });
        }

        expenseRefs.forEach((item, index) => {
            if (expenseSnapshots[index]?.exists()) return;
            const amount = roundMoney(item.expense.monto);
            transaction.set(item.ref, {
                ...item.expense,
                monto: amount,
                timestamp: serverTimestamp(),
                revision: 1,
                lastOperationId: payload.operationId,
                lastOperationType: 'ingreso_stock'
            });
            transaction.set(item.cashRef, {
                localId: item.expense.localId || 'general',
                localNombre: item.expense.localNombre || 'General',
                fechaStr: item.expense.fechaStr,
                total_gastos: increment(amount)
            }, { merge: true });
        });

        return {
            alreadyApplied: false,
            product: {
                id: payload.productId,
                ...product,
                stock: nextStock
            }
        };
    });
}

function getQueueOwnerId() {
    const ownerId = String(auth.currentUser?.uid || '');
    if (!ownerId) throw new Error('La sesión todavía no está lista.');
    return ownerId;
}

function assertOperationOwner(operation) {
    if (
        !auth.currentUser?.uid
        || String(auth.currentUser.uid) !== String(operation?.ownerId || '')
    ) {
        throw new Error('La sincronización esperará a la sesión que creó la operación.');
    }
}

registerSyncHandler('catalog.upsert', async (payload, operation) => {
    assertOperationOwner(operation);
    return commitProductUpsert(payload);
});
registerSyncHandler('catalog.delete', async (payload, operation) => {
    assertOperationOwner(operation);
    return commitProductDelete(payload);
});
registerSyncHandler('stock.receive', async (payload, operation) => {
    assertOperationOwner(operation);
    const result = await commitStockEntry(payload);
    const product = result?.product;
    if (product && !isCupInventoryProduct(product)) {
        setTimeout(() => {
            void syncPublicAvailability([{
                id: product.id,
                localId: product.localId,
                stock: product.stock,
                disponible: resolvePublicAvailability(product)
            }], {
                localId: product.localId || operation.localId || ''
            }).catch(error => {
                console.warn('No se actualizó la disponibilidad pública:', error);
            });
        }, 0);
    }
    return {
        alreadyApplied: result?.alreadyApplied === true
    };
});

export function queueProductUpsert({ operationId, productId, data, mode = 'update', dependsOnOperationId = '' }) {
    return enqueueSyncOperation({
        id: operationId,
        type: 'catalog.upsert',
        ownerId: getQueueOwnerId(),
        localId: data?.localId || '',
        payload: { operationId, productId, data, mode },
        entityKey: `productos/${productId}`,
        optimisticMutations: [{
            collection: 'productos',
            documentId: productId,
            kind: 'merge',
            data: {
                ...data,
                id: productId,
                lastOperationId: operationId
            }
        }],
        dependsOn: dependsOnOperationId ? [dependsOnOperationId] : []
    });
}

export function queueProductDelete({ operationId, productId, dependsOnOperationId = '' }) {
    return enqueueSyncOperation({
        id: operationId,
        type: 'catalog.delete',
        ownerId: getQueueOwnerId(),
        payload: { operationId, productId },
        entityKey: `productos/${productId}`,
        optimisticMutations: [{
            collection: 'productos',
            documentId: productId,
            kind: 'delete'
        }],
        dependsOn: dependsOnOperationId ? [dependsOnOperationId] : []
    });
}

export function queueStockEntry({
    operationId,
    productId,
    quantity,
    expenses = [],
    cupControlDate = '',
    localNombre = '',
    dependsOnOperationId = ''
}) {
    const optimisticMutations = [{
        collection: 'productos',
        documentId: productId,
        kind: 'increment',
        data: { stock: Number(quantity || 0) }
    }];

    expenses.forEach(expense => {
        optimisticMutations.push({
            collection: 'gastos',
            documentId: expense.id,
            kind: 'merge',
            data: {
                ...expense,
                id: expense.id,
                lastOperationId: operationId
            }
        });
    });
    if (cupControlDate) {
        const documentId = getCupControlDocumentId(
            cupControlDate,
            productId
        );
        optimisticMutations.push(
            {
                collection: 'control_vasos_diario',
                documentId,
                kind: 'merge',
                data: {
                    fechaStr: String(cupControlDate),
                    productoId: String(productId),
                    localNombre: String(localNombre || '')
                }
            },
            {
                collection: 'control_vasos_diario',
                documentId,
                kind: 'increment',
                data: {
                    entradas: Number(quantity || 0)
                }
            }
        );
    }

    return enqueueSyncOperation({
        id: operationId,
        type: 'stock.receive',
        ownerId: getQueueOwnerId(),
        localId: expenses[0]?.localId || '',
        entityKey: `productos/${productId}`,
        payload: {
            operationId,
            productId,
            quantity,
            expenses,
            cupControlDate,
            localNombre
        },
        optimisticMutations,
        dependsOn: dependsOnOperationId ? [dependsOnOperationId] : []
    });
}
