import {
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

function roundMoney(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error('Monto no válido.');
    return Math.round((parsed + Number.EPSILON) * 100) / 100;
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
    const expenseRefs = (payload.expenses || []).map(expense => ({
        expense,
        ref: doc(db, 'gastos', expense.id),
        cashRef: doc(db, 'caja_diaria', `${expense.fechaStr}_${expense.localId || 'general'}`)
    }));

    return runTransaction(db, async transaction => {
        const [productSnapshot, ...expenseSnapshots] = await Promise.all([
            transaction.get(productRef),
            ...expenseRefs.map(item => transaction.get(item.ref))
        ]);
        if (!productSnapshot.exists()) throw new Error('El producto ya no existe.');

        const product = productSnapshot.data();
        const appliedIds = Array.isArray(product.stockOperationIds)
            ? product.stockOperationIds.map(String)
            : [];
        if (appliedIds.includes(payload.operationId)) {
            return { alreadyApplied: true };
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

        return { alreadyApplied: false };
    });
}

registerSyncHandler('catalog.upsert', commitProductUpsert);
registerSyncHandler('catalog.delete', commitProductDelete);
registerSyncHandler('stock.receive', commitStockEntry);

export function queueProductUpsert({ operationId, productId, data, mode = 'update', dependsOnOperationId = '' }) {
    return enqueueSyncOperation({
        id: operationId,
        type: 'catalog.upsert',
        payload: { operationId, productId, data, mode },
        optimisticChanges: [{
            collection: 'productos',
            id: productId,
            action: 'upsert',
            data: {
                ...data,
                id: productId,
                lastOperationId: operationId
            },
            confirmField: 'lastOperationId'
        }],
        metadata: { label: mode === 'create' ? 'Crear producto' : 'Editar producto' },
        dependsOnOperationIds: [dependsOnOperationId]
    });
}

export function queueProductDelete({ operationId, productId, dependsOnOperationId = '' }) {
    return enqueueSyncOperation({
        id: operationId,
        type: 'catalog.delete',
        payload: { operationId, productId },
        optimisticChanges: [{
            collection: 'productos',
            id: productId,
            action: 'delete',
            confirmField: ''
        }],
        metadata: { label: 'Eliminar producto' },
        dependsOnOperationIds: [dependsOnOperationId]
    });
}

export function queueStockEntry({
    operationId,
    productId,
    quantity,
    expenses = [],
    dependsOnOperationId = ''
}) {
    const optimisticChanges = [{
        collection: 'productos',
        id: productId,
        action: 'patch',
        increments: { stock: Number(quantity || 0) },
        confirmField: 'lastInventoryOperationId'
    }];

    expenses.forEach(expense => {
        optimisticChanges.push({
            collection: 'gastos',
            id: expense.id,
            action: 'upsert',
            data: {
                ...expense,
                id: expense.id,
                lastOperationId: operationId
            },
            confirmField: 'lastOperationId'
        });
    });

    return enqueueSyncOperation({
        id: operationId,
        type: 'stock.receive',
        payload: { operationId, productId, quantity, expenses },
        optimisticChanges,
        metadata: { label: 'Ingreso de mercadería' },
        dependsOnOperationIds: [dependsOnOperationId]
    });
}
