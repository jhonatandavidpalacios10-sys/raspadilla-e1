import {
    auth,
    db,
    doc,
    increment,
    runTransaction,
    serverTimestamp
} from './firebase-setup.js';
import { getTrustedNowMs } from '../utils/helpers.js';
import {
    enqueueSyncOperation,
    getPendingSyncOperationById,
    replaceQueuedSyncOperation,
    registerSyncHandler
} from './sync-queue.js';
import {
    resolvePublicAvailability,
    syncPublicAvailability
} from './public-catalog-service.js';

const MAX_DISTINCT_PRODUCTS_PER_OPERATION = 180;
const MONEY_EPSILON = 0.009;
export const SALE_EDIT_LOCK_TTL_MS = 15 * 60 * 1000;

export class SalesIntegrityError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SalesIntegrityError';
        this.code = code;
        this.details = details;
    }
}

export function createUuid(prefix = '') {
    let value = '';

    if (globalThis.crypto?.randomUUID) {
        value = globalThis.crypto.randomUUID();
    } else if (globalThis.crypto?.getRandomValues) {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        value = [...bytes].map((byte, index) => {
            const hex = byte.toString(16).padStart(2, '0');
            return [4, 6, 8, 10].includes(index) ? `-${hex}` : hex;
        }).join('');
    } else {
        value = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    }

    return `${prefix}${value}`;
}

export function getSaleItemCartId(saleId, item = {}, index = 0) {
    return String(
        item.cartId
        || `C-LEGACY-${String(saleId || 'SALE')}-${Number(index) || 0}`
    );
}

export function roundMoney(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new SalesIntegrityError('invalid-money', 'Se recibió un monto no válido.');
    }
    return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toMillis(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    if (value?.seconds !== undefined) {
        const seconds = Number(value.seconds);
        return Number.isFinite(seconds) ? seconds * 1000 : 0;
    }
    return 0;
}

export function getSaleEditLockState(sale = {}, nowMs = getTrustedNowMs()) {
    const token = String(sale.edicionToken || '');
    const declaredExpiresAtMs = toMillis(
        sale.edicionExpiraEnMs ?? sale.edicionExpiraEn
    );
    const lockTtlMs = Math.min(
        60 * 60 * 1000,
        Math.max(
            5 * 60 * 1000,
            Number(sale.edicionTtlMs) || SALE_EDIT_LOCK_TTL_MS
        )
    );
    const serverClockAnchor = toMillis(
        sale.edicionActualizadaEn ?? sale.edicionIniciadaEn
    );
    // Una vez resuelto el serverTimestamp, su reloj prevalece sobre el del
    // dispositivo que abrió la edición. El valor explícito queda como fallback
    // durante el instante en que el servidor todavía confirma la escritura.
    const expiresAtMs = serverClockAnchor > 0
        ? serverClockAnchor + lockTtlMs
        : declaredExpiresAtMs;
    const declaredActive = sale.edicionActiva === true && token !== '';
    const active = declaredActive && expiresAtMs > nowMs;
    const editingState = String(sale.estado || '').toLowerCase() === 'editando';

    return {
        active,
        stale: !active && (declaredActive || editingState),
        token,
        ownerId: String(sale.edicionPropietarioId || ''),
        ownerName: String(sale.edicionPropietarioNombre || 'Otro usuario'),
        expiresAtMs,
        remainingMs: Math.max(0, expiresAtMs - nowMs)
    };
}

function buildClearedEditLockFields(actor = '', reason = '') {
    return {
        edicionActiva: false,
        edicionToken: null,
        edicionPropietarioId: null,
        edicionPropietarioNombre: null,
        edicionIniciadaEn: null,
        edicionActualizadaEn: null,
        edicionExpiraEnMs: null,
        edicionTtlMs: null,
        edicionFinalizadaEn: serverTimestamp(),
        edicionFinalizadaPor: actor || 'Desconocido',
        edicionFinalizadaMotivo: reason || 'liberado'
    };
}

function assertSaleEditUnlocked(sale) {
    const lock = getSaleEditLockState(sale);
    if (!lock.active) return lock;

    throw new SalesIntegrityError(
        'sale-edit-locked',
        `El pedido está siendo editado por ${lock.ownerName}.`,
        {
            ownerId: lock.ownerId,
            ownerName: lock.ownerName,
            expiresAtMs: lock.expiresAtMs
        }
    );
}

function toPositiveInteger(value, fieldName = 'cantidad') {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new SalesIntegrityError(
            'invalid-quantity',
            `La ${fieldName} debe ser un número entero mayor que cero.`
        );
    }
    return parsed;
}

function normalizeName(value) {
    return String(value || '').trim().toLocaleLowerCase('es');
}

function isCupInventoryProduct(product = {}) {
    return (
        normalizeName(product.categoria) === 'insumo'
        && (
            normalizeName(product.tipoInsumo) === 'vaso'
            || product.esVasoInventario === true
        )
    );
}

function productBelongsToLocation(product = {}, localId = '') {
    const productLocalId = String(product.localId || '').trim();
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

function addMovement(target, productId, quantity, source) {
    if (!productId) return;
    const amount = toPositiveInteger(quantity);
    const current = target.get(productId) || {
        productoId: productId,
        cantidad: 0,
        fuentes: []
    };
    current.cantidad += amount;
    if (source && !current.fuentes.includes(source)) current.fuentes.push(source);
    target.set(productId, current);
}

/**
 * Crea un resumen persistible del inventario consumido por una venta.
 * Mantiene compatibilidad con ventas antiguas cuyos sabores eran solo nombres.
 */
export function buildInventoryMovements(items, catalog = [], localId = '') {
    const movements = new Map();
    const flavorsByName = new Map();
    const normalizedItems = Array.isArray(items) ? items : [];
    const needsLegacyFlavorLookup = normalizedItems.some(item => {
        const detailedNames = new Set(
            (Array.isArray(item?.saboresDetalle)
                ? item.saboresDetalle
                : [])
                .map(flavor => normalizeName(flavor?.nombre))
                .filter(Boolean)
        );
        return (Array.isArray(item?.sabores) ? item.sabores : [])
            .some(flavor => {
                const explicitId = typeof flavor === 'object'
                    ? (flavor?.id || flavor?.productoId)
                    : '';
                const flavorName = normalizeName(
                    typeof flavor === 'object' ? flavor?.nombre : flavor
                );
                return !explicitId && !detailedNames.has(flavorName);
            });
    });

    if (needsLegacyFlavorLookup) {
        catalog.forEach(product => {
            if (normalizeName(product.categoria) !== 'sabor') return;
            const key = normalizeName(product.nombre);
            if (!key) return;

            const existing = flavorsByName.get(key);
            const isPreferred =
                product.localId === localId ||
                (product.localId === 'global' && existing?.localId !== localId);

            if (!existing || isPreferred) flavorsByName.set(key, product);
        });
    }

    normalizedItems.forEach(item => {
        const itemQuantity = toPositiveInteger(item.cantidad);

        if (item.productoId && item.productoId !== 'AJUSTE') {
            addMovement(movements, item.productoId, itemQuantity, 'principal');
        }

        // Cada tamaño vendible puede enlazarse con un vaso físico distinto.
        // Se usa únicamente la instantánea guardada en la línea: una venta
        // antigua nunca debe heredar retroactivamente la configuración actual.
        const frozenCup = (
            item.consumoVaso
            && typeof item.consumoVaso === 'object'
        )
            ? item.consumoVaso
            : null;
        const cupProductId = String(
            frozenCup?.insumoId
            || item.vasoInsumoId
            || ''
        );
        if (
            cupProductId
            && cupProductId !== String(item.productoId || '')
        ) {
            const cupsPerItem = toPositiveInteger(
                frozenCup?.unidades
                ?? item.vasosPorUnidad
                ?? 1,
                'cantidad de vasos por producto'
            );
            addMovement(
                movements,
                cupProductId,
                itemQuantity * cupsPerItem,
                'vaso_insumo'
            );
        }

        (Array.isArray(item.toppings) ? item.toppings : []).forEach(topping => {
            const toppingId = topping?.id || topping?.productoId;
            if (toppingId) {
                addMovement(movements, toppingId, itemQuantity, 'topping');
            }
        });

        const flavorDetails = Array.isArray(item.saboresDetalle)
            ? item.saboresDetalle
            : [];
        const flavorIds = new Set();
        const detailedFlavorNames = new Set();

        flavorDetails.forEach(flavor => {
            const flavorId = flavor?.id || flavor?.productoId;
            const flavorName = normalizeName(flavor?.nombre);
            if (flavorName) detailedFlavorNames.add(flavorName);
            if (flavorId) {
                flavorIds.add(flavorId);
                addMovement(movements, flavorId, itemQuantity, 'sabor');
            }
        });

        (Array.isArray(item.sabores) ? item.sabores : []).forEach(flavor => {
            const explicitId =
                typeof flavor === 'object' ? (flavor?.id || flavor?.productoId) : '';
            if (explicitId && !flavorIds.has(explicitId)) {
                flavorIds.add(explicitId);
                addMovement(movements, explicitId, itemQuantity, 'sabor');
                return;
            }

            const flavorName = normalizeName(
                typeof flavor === 'object' ? flavor?.nombre : flavor
            );
            if (detailedFlavorNames.has(flavorName)) return;
            const product = flavorsByName.get(flavorName);

            if (product && !flavorIds.has(product.id)) {
                flavorIds.add(product.id);
                addMovement(movements, product.id, itemQuantity, 'sabor');
            }
        });
    });

    if (movements.size > MAX_DISTINCT_PRODUCTS_PER_OPERATION) {
        throw new SalesIntegrityError(
            'too-many-products',
            'La venta contiene demasiados productos distintos para procesarse de forma segura.'
        );
    }

    return [...movements.values()];
}

function normalizeStoredMovements(movements, defaultStockAffected = false) {
    const normalized = new Map();

    (Array.isArray(movements) ? movements : []).forEach(movement => {
        const productId = movement?.productoId || movement?.id;
        const quantity = Number(movement?.cantidad);
        if (!productId || !Number.isInteger(quantity) || quantity <= 0) return;

        const current = normalized.get(productId) || {
            productoId: productId,
            cantidad: 0,
            fuentes: [],
            stockAfectado: null
        };
        current.cantidad += quantity;
        const stockAffected = typeof movement.stockAfectado === 'boolean'
            ? movement.stockAfectado
            : defaultStockAffected;
        if (stockAffected === true) current.stockAfectado = true;
        else if (stockAffected === false && current.stockAfectado === null) {
            current.stockAfectado = false;
        }
        const sources = Array.isArray(movement.fuentes) ? movement.fuentes : [];
        sources.forEach(source => {
            if (!current.fuentes.includes(source)) current.fuentes.push(source);
        });
        normalized.set(productId, current);
    });

    return [...normalized.values()];
}

export function buildLegacyInventoryMovements(items) {
    const movements = new Map();

    (Array.isArray(items) ? items : []).forEach(item => {
        const quantity = Number(item?.cantidad);
        if (!Number.isInteger(quantity) || quantity <= 0) return;

        if (item.productoId && item.productoId !== 'AJUSTE') {
            addMovement(movements, item.productoId, quantity, 'principal');
        }
        (Array.isArray(item.toppings) ? item.toppings : []).forEach(topping => {
            const productId = topping?.id || topping?.productoId;
            if (productId) addMovement(movements, productId, quantity, 'topping');
        });
    });

    return [...movements.values()].map(movement => ({
        ...movement,
        stockAfectado: false
    }));
}

function buildProductDelta(oldMovements, newMovements) {
    const delta = new Map();

    normalizeStoredMovements(oldMovements, false).forEach(movement => {
        delta.set(movement.productoId, {
            productoId: movement.productoId,
            stockDelta: movement.stockAfectado === true ? movement.cantidad : 0,
            salesDelta: -movement.cantidad,
            cupConsumptionDelta: Array.isArray(movement.fuentes)
                && movement.fuentes.includes('vaso_insumo')
                    ? -movement.cantidad
                    : 0
        });
    });

    normalizeStoredMovements(newMovements, false).forEach(movement => {
        const current = delta.get(movement.productoId) || {
            productoId: movement.productoId,
            stockDelta: 0,
            salesDelta: 0,
            cupConsumptionDelta: 0
        };
        if (movement.stockAfectado === true) {
            current.stockDelta -= movement.cantidad;
        }
        current.salesDelta += movement.cantidad;
        if (
            Array.isArray(movement.fuentes)
            && movement.fuentes.includes('vaso_insumo')
        ) {
            current.cupConsumptionDelta += movement.cantidad;
        }
        delta.set(movement.productoId, current);
    });

    return [...delta.values()].filter(
        item => (
            item.stockDelta !== 0
            || item.salesDelta !== 0
            || item.cupConsumptionDelta !== 0
        )
    );
}

function getAccounting(sale = {}) {
    return {
        total: roundMoney(toFiniteNumber(sale.total)),
        costs: roundMoney(toFiniteNumber(sale.costoTotal ?? sale.costo_total)),
        cash: roundMoney(toFiniteNumber(sale.pagoEfectivo ?? sale.pago_efectivo)),
        digital: roundMoney(toFiniteNumber(sale.pagoYape ?? sale.pago_yape))
    };
}

function getAppliedOperations(documentData = {}) {
    const ledger = documentData?.appliedOperations;
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return {};
    return { ...ledger };
}

function wasOperationApplied(documentData, operationId) {
    if (!operationId) return false;
    return (
        Boolean(getAppliedOperations(documentData)[operationId])
        || documentData?.lastOperationId === operationId
    );
}

function appendAppliedOperation(documentData, operationId, operationType) {
    return {
        ...getAppliedOperations(documentData),
        [operationId]: String(operationType || 'operacion')
    };
}

function getCashDocumentKey(sale = {}) {
    const date = String(sale.fechaStr || '').trim();
    const localId = String(sale.localId || 'general').trim() || 'general';
    if (!date) {
        throw new SalesIntegrityError(
            'missing-sale-date',
            'La venta no tiene una fecha contable válida.'
        );
    }
    return `${date}_${localId}`;
}

function queueCashDelta(transaction, sale, delta, countDelta) {
    const normalizedDelta = {
        total: roundMoney(delta.total),
        costs: roundMoney(delta.costs),
        cash: roundMoney(delta.cash),
        digital: roundMoney(delta.digital)
    };
    const normalizedCountDelta = Number(countDelta) || 0;
    const hasAccountingChange = Object.values(normalizedDelta)
        .some(value => Math.abs(value) > MONEY_EPSILON);

    // Una edición que conserva importes no debe escribir incrementos en cero
    // sobre el documento compartido de caja. Se mantiene el mismo resultado
    // contable y se evita contención innecesaria entre cajas simultáneas.
    if (!hasAccountingChange && normalizedCountDelta === 0) return;

    const cashRef = doc(db, 'caja_diaria', getCashDocumentKey(sale));
    transaction.set(cashRef, {
        localId: sale.localId || 'general',
        localNombre: sale.localNombre || 'Sin Local',
        fechaStr: sale.fechaStr,
        total_ingresos: increment(normalizedDelta.total),
        total_costos: increment(normalizedDelta.costs),
        total_efectivo: increment(normalizedDelta.cash),
        total_yape: increment(normalizedDelta.digital),
        cantidad_ventas: increment(normalizedCountDelta)
    }, { merge: true });
}

function subtractAccounting(left, right) {
    return {
        total: roundMoney(left.total - right.total),
        costs: roundMoney(left.costs - right.costs),
        cash: roundMoney(left.cash - right.cash),
        digital: roundMoney(left.digital - right.digital)
    };
}

function negateAccounting(value) {
    return {
        total: -value.total,
        costs: -value.costs,
        cash: -value.cash,
        digital: -value.digital
    };
}

async function readProducts(transaction, productDeltas) {
    const refs = productDeltas.map(item => doc(db, 'productos', item.productoId));
    const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
    return snapshots.map((snapshot, index) => ({
        delta: productDeltas[index],
        ref: refs[index],
        snapshot
    }));
}

function resolveMovementStockFlags(movements, productReads) {
    const readsById = new Map(
        productReads.map(read => [read.delta.productoId, read])
    );

    return movements.map(movement => {
        const snapshot = readsById.get(movement.productoId)?.snapshot;
        const product = snapshot?.exists() ? snapshot.data() : null;
        const stockAfectado = Boolean(
            product
            && product.stock !== null
            && product.stock !== undefined
            && product.stock !== ''
        );
        return { ...movement, stockAfectado };
    });
}

function getCupControlDocumentId(date, productId) {
    const safeDate = String(date || '').replaceAll('/', '-');
    const safeProductId = String(productId || '').replaceAll('/', '_');
    return `${safeDate}_${safeProductId}`;
}

function queueDailyCupControl(
    transaction,
    product,
    delta,
    nextStock,
    context = {}
) {
    const date = String(context.fechaStr || '').trim();
    const consumption = Number(delta.cupConsumptionDelta || 0);
    if (
        !date
        || !Number.isFinite(consumption)
        || consumption === 0
        || !Number.isFinite(nextStock)
    ) return;

    const productId = String(delta.productoId || '');
    const controlRef = doc(
        db,
        'control_vasos_diario',
        getCupControlDocumentId(date, productId)
    );
    transaction.set(controlRef, {
        fechaStr: date,
        productoId: productId,
        productoNombre: String(product.nombre || 'Vaso'),
        localId: String(product.localId || context.localId || 'global'),
        localNombre: String(context.localNombre || ''),
        consumidos: increment(consumption),
        stockFinal: nextStock,
        actualizadoEn: serverTimestamp()
    }, { merge: true });
}

function queueProductDeltas(
    transaction,
    productReads,
    {
        requireAll = true,
        cupControlContext = null
    } = {}
) {
    const missingProducts = [];
    const availabilityRows = [];

    productReads.forEach(({ delta, ref, snapshot }) => {
        if (!snapshot.exists()) {
            missingProducts.push(delta.productoId);
            return;
        }

        const product = snapshot.data();
        const currentStock =
            product.stock === null || product.stock === undefined || product.stock === ''
                ? null
                : Number(product.stock);
        const currentSales = toFiniteNumber(product.ventasTotales);
        const isCupMovement = Number(delta.cupConsumptionDelta || 0) !== 0;
        if (
            isCupMovement
            && (
                !isCupInventoryProduct(product)
                || currentStock === null
            )
        ) {
            throw new SalesIntegrityError(
                'invalid-cup-inventory',
                `El control de "${product.nombre || 'un vaso'}" no está configurado correctamente.`
            );
        }
        if (
            Number(delta.cupConsumptionDelta || 0) > 0
            && product.activo === false
        ) {
            throw new SalesIntegrityError(
                'inactive-cup-inventory',
                `El vaso "${product.nombre || ''}" está archivado. Asigna otro antes de vender.`
            );
        }
        const nextData = {
            ventasTotales: Math.max(0, currentSales + delta.salesDelta)
        };

        let nextStock = null;
        if (currentStock !== null) {
            if (!Number.isFinite(currentStock)) {
                throw new SalesIntegrityError(
                    'invalid-stock',
                    `El producto ${product.nombre || delta.productoId} tiene stock inválido.`
                );
            }
            nextStock = currentStock + delta.stockDelta;
            if (nextStock < 0) {
                throw new SalesIntegrityError(
                    'insufficient-stock',
                    `Stock insuficiente para ${product.nombre || 'un producto'}.`,
                    {
                        productoId: delta.productoId,
                        productoNombre: product.nombre || '',
                        disponible: currentStock,
                        solicitado: Math.abs(Math.min(0, delta.stockDelta))
                    }
                );
            }
            nextData.stock = nextStock;
        }

        transaction.update(ref, nextData);
        queueDailyCupControl(
            transaction,
            product,
            delta,
            nextStock,
            cupControlContext || {}
        );
        const nextProduct = {
            ...product,
            ...nextData,
            id: delta.productoId
        };
        availabilityRows.push({
            id: delta.productoId,
            localId: String(product.localId || 'global'),
            stock:
                nextProduct.stock === null
                || nextProduct.stock === undefined
                || nextProduct.stock === ''
                    ? null
                    : Number(nextProduct.stock),
            disponible: resolvePublicAvailability(nextProduct)
        });
    });

    if (requireAll && missingProducts.length > 0) {
        throw new SalesIntegrityError(
            'missing-product',
            'Uno o más productos ya no existen en el catálogo.',
            { productIds: missingProducts }
        );
    }

    return { missingProducts, availabilityRows };
}

function syncCommittedPublicAvailability(result) {
    const rows = Array.isArray(result?.publicAvailabilityRows)
        ? result.publicAvailabilityRows
        : [];
    const localId = String(result?.publicAvailabilityLocalId || '');
    if (rows.length > 0) {
        // La venta ya fue confirmada por su transacción. La proyección pública
        // se encola aparte para que nunca retrase la cola ni la interfaz.
        setTimeout(() => {
            void syncPublicAvailability(rows, { localId }).catch(error => {
                console.warn(
                    'No se pudo actualizar la disponibilidad del catálogo público:',
                    error
                );
            });
        }, 0);
    }

    if (!result || typeof result !== 'object') return result;
    const {
        publicAvailabilityRows: _publicAvailabilityRows,
        publicAvailabilityLocalId: _publicAvailabilityLocalId,
        ...publicResult
    } = result;
    return publicResult;
}

function assertSaleAmounts(sale) {
    const accounting = getAccounting(sale);
    const items = Array.isArray(sale.items) ? sale.items : [];
    let itemTotal = 0;
    let itemCosts = 0;
    let positiveSubtotal = 0;
    let discounts = 0;

    if (items.length === 0) {
        throw new SalesIntegrityError(
            'empty-cart',
            'La venta debe incluir al menos un producto.'
        );
    }

    items.forEach(item => {
        const quantity = Number(item?.cantidad);
        const price = Number(item?.precio);
        const cost = Number(item?.costo || 0);
        const isAdjustment =
            item?.productoId === 'AJUSTE'
            || normalizeName(item?.categoria) === 'ajuste';

        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999) {
            throw new SalesIntegrityError(
                'invalid-quantity',
                `La cantidad de "${item?.nombre || 'un producto'}" no es válida.`
            );
        }
        if (!Number.isFinite(price) || !Number.isFinite(cost) || cost < 0) {
            throw new SalesIntegrityError(
                'invalid-money',
                `El precio o costo de "${item?.nombre || 'un producto'}" no es válido.`
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
        itemTotal = roundMoney(itemTotal + lineTotal);
        itemCosts = roundMoney(itemCosts + cost * quantity);
        if (lineTotal < 0) discounts = roundMoney(discounts + Math.abs(lineTotal));
        else positiveSubtotal = roundMoney(positiveSubtotal + lineTotal);
    });

    if (
        positiveSubtotal <= 0
        || discounts >= positiveSubtotal
        || itemTotal <= 0
    ) {
        throw new SalesIntegrityError(
            'discount-too-large',
            'El descuento no puede igualar o superar el subtotal positivo.'
        );
    }
    if (Math.abs(itemTotal - accounting.total) > MONEY_EPSILON) {
        throw new SalesIntegrityError(
            'sale-total-mismatch',
            'El total de la venta no coincide con sus productos.'
        );
    }
    if (Math.abs(itemCosts - accounting.costs) > MONEY_EPSILON) {
        throw new SalesIntegrityError(
            'sale-cost-mismatch',
            'El costo de la venta no coincide con sus productos.'
        );
    }
    if (accounting.total <= 0) {
        throw new SalesIntegrityError(
            'non-positive-total',
            'El total de la venta debe ser mayor que cero.'
        );
    }
    if (accounting.costs < 0 || accounting.cash < 0 || accounting.digital < 0) {
        throw new SalesIntegrityError(
            'negative-amount',
            'Los costos y medios de pago no pueden ser negativos.'
        );
    }
    if (Math.abs(accounting.cash + accounting.digital - accounting.total) > MONEY_EPSILON) {
        throw new SalesIntegrityError(
            'payment-mismatch',
            'Los medios de pago no coinciden con el total de la venta.'
        );
    }
    const paymentMethod = normalizeName(
        sale.metodoFinal || sale.metodo_pago
    );
    const isCash = paymentMethod === 'efectivo';
    const isDigital = ['yape', 'plin', 'transferencia', 'yape / plin']
        .includes(paymentMethod);
    const isMixed = paymentMethod === 'mixto';
    if (!isCash && !isDigital && !isMixed) {
        throw new SalesIntegrityError(
            'invalid-payment-method',
            'Selecciona un método de pago válido.'
        );
    }
    if (
        (isCash && accounting.digital > MONEY_EPSILON)
        || (isDigital && accounting.cash > MONEY_EPSILON)
        || (
            isMixed
            && (
                accounting.cash <= MONEY_EPSILON
                || accounting.digital <= MONEY_EPSILON
            )
        )
    ) {
        throw new SalesIntegrityError(
            'payment-method-mismatch',
            'La distribución del pago no coincide con el método seleccionado.'
        );
    }
    return accounting;
}

function normalizeComparableList(values, mapper) {
    return (Array.isArray(values) ? values : [])
        .map(mapper)
        .filter(Boolean)
        .sort();
}

function getComparableLineKey(item = {}) {
    const flavors = normalizeComparableList(
        item.saboresDetalle?.length ? item.saboresDetalle : item.sabores,
        flavor => {
            if (typeof flavor === 'object') {
                return String(
                    flavor?.id
                    || flavor?.productoId
                    || normalizeName(flavor?.nombre)
                );
            }
            return normalizeName(flavor);
        }
    );
    const toppings = normalizeComparableList(item.toppings, topping => {
        const id = topping?.id || topping?.productoId || normalizeName(topping?.nombre);
        const price = Number(topping?.precio);
        return id
            ? `${id}:${Number.isFinite(price) ? roundMoney(price) : 'invalid'}`
            : '';
    });
    const price = Number(item.precio);

    return JSON.stringify({
        productoId: String(item.productoId || ''),
        categoria: normalizeName(item.categoria),
        tamano: normalizeName(item.tamano),
        precio: Number.isFinite(price) ? roundMoney(price) : 'invalid',
        sabores: flavors,
        toppings,
        consumoVaso: item.consumoVaso?.insumoId
            ? {
                insumoId: String(item.consumoVaso.insumoId),
                unidades: Number(item.consumoVaso.unidades || 1),
                localId: String(item.consumoVaso.localId || '')
            }
            : null
    });
}

function createHistoricalLineMatcher(previousItems = [], saleId = '') {
    const entries = (Array.isArray(previousItems) ? previousItems : []).map(
        (item, index) => ({
            index,
            item,
            cartId: getSaleItemCartId(saleId, item, index),
            hadCartId: Boolean(item?.cartId),
            key: getComparableLineKey(item),
            used: false
        })
    );

    return item => {
        const cartId = String(item?.cartId || '');
        const key = getComparableLineKey(item);
        let match = null;

        if (cartId) {
            match = entries.find(entry => (
                !entry.used
                && entry.cartId === cartId
                && entry.key === key
            ));
        }
        if (!cartId && !match) {
            match = entries.find(entry => (
                !entry.used
                && !entry.hadCartId
                && entry.key === key
            ));
        }
        if (!match) return null;

        match.used = true;
        return match.item;
    };
}

function getCurrentProductPrice(item, productReadsById) {
    const productRead = productReadsById.get(item.productoId);
    const product = productRead?.snapshot?.exists()
        ? productRead.snapshot.data()
        : null;
    if (!product) {
        throw new SalesIntegrityError(
            'missing-product',
            `El producto "${item.nombre || 'seleccionado'}" ya no existe.`
        );
    }

    const sizes = Array.isArray(product.tamanos) ? product.tamanos : [];
    const requestedSize = normalizeName(item.tamano);
    let basePrice;

    if (sizes.length > 0) {
        const selectedSize = sizes.find(
            size => normalizeName(size?.nombre) === requestedSize
        ) || (
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

    if (!Number.isFinite(basePrice) || basePrice < 0) {
        throw new SalesIntegrityError(
            'catalog-changed',
            `El precio de "${item.nombre || 'un producto'}" no está disponible.`
        );
    }

    let expectedPrice = roundMoney(basePrice);
    (Array.isArray(item.toppings) ? item.toppings : []).forEach(topping => {
        const toppingId = topping?.id || topping?.productoId;
        const toppingRead = productReadsById.get(toppingId);
        const toppingProduct = toppingRead?.snapshot?.exists()
            ? toppingRead.snapshot.data()
            : null;
        if (!toppingId || !toppingProduct) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `Un topping de "${item.nombre || 'un producto'}" ya no está disponible.`
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
                `El precio del topping "${toppingProduct.nombre || ''}" no es válido.`
            );
        }
        expectedPrice = roundMoney(expectedPrice + toppingPrice);
    });

    const currentCost = Number(product.costo || 0);
    if (!Number.isFinite(currentCost) || currentCost < 0) {
        throw new SalesIntegrityError(
            'catalog-changed',
            `El costo de "${item.nombre || 'un producto'}" no es válido.`
        );
    }

    return { expectedPrice, currentCost };
}

function assertRequestedCupMovements(items, requestedMovements) {
    const expectedCupIds = new Set(
        (Array.isArray(items) ? items : [])
            .map(item => String(item?.consumoVaso?.insumoId || ''))
            .filter(Boolean)
    );
    const actualCupMovements = normalizeStoredMovements(
        requestedMovements,
        null
    ).filter(movement => (
        Array.isArray(movement.fuentes)
        && movement.fuentes.includes('vaso_insumo')
    ));
    if (expectedCupIds.size === 0 && actualCupMovements.length === 0) return;

    const canonicalById = new Map(
        buildInventoryMovements(items, [])
            .map(movement => [String(movement.productoId), movement])
    );
    const actualById = new Map(
        actualCupMovements.map(movement => [
            String(movement.productoId),
            movement
        ])
    );
    const matches = (
        actualCupMovements.length === expectedCupIds.size
        && [...expectedCupIds].every(productId => {
            const expected = canonicalById.get(productId);
            const actual = actualById.get(productId);
            return (
                expected
                && actual
                && Number(expected.cantidad) === Number(actual.cantidad)
            );
        })
    );
    if (!matches) {
        throw new SalesIntegrityError(
            'cup-inventory-mismatch',
            'El control de vasos del pedido no coincide. Actualiza la aplicación y vuelve a intentarlo.'
        );
    }
}

function assertItemCupMatchesCatalog(item, productReadsById, localId) {
    const productRead = productReadsById.get(item.productoId);
    const product = productRead?.snapshot?.exists()
        ? productRead.snapshot.data()
        : null;
    if (!product || normalizeName(product.categoria) !== 'vaso') return;

    const sizes = Array.isArray(product.tamanos) ? product.tamanos : [];
    const requestedSize = normalizeName(item.tamano);
    const selectedSize = sizes.find(size => (
        normalizeName(size?.nombre) === requestedSize
    )) || (
        ['', 'estándar', 'único / estándar'].includes(requestedSize)
            ? sizes[0]
            : null
    );
    const config = (
        selectedSize?.consumoVaso
        && typeof selectedSize.consumoVaso === 'object'
    )
        ? selectedSize.consumoVaso
        : (
            product.consumoVaso
            && typeof product.consumoVaso === 'object'
                ? product.consumoVaso
                : null
        );
    const assignments = Array.isArray(config?.asignaciones)
        ? config.asignaciones
        : [];
    if (assignments.length === 0) return;

    const targetLocalId = String(localId || '');
    const assignment = assignments.find(candidate => (
        String(candidate?.localId || '') === targetLocalId
    )) || assignments.find(candidate => (
        ['global', 'general', ''].includes(
            String(candidate?.localId || '')
        )
    ));
    if (!assignment?.insumoId) {
        throw new SalesIntegrityError(
            'cup-not-configured-for-location',
            `El tamaño de "${item.nombre || 'un producto'}" no tiene vaso asignado para esta sede.`
        );
    }

    const units = toPositiveInteger(
        assignment.unidades ?? config.unidades ?? 1,
        'cantidad de vasos por producto'
    );
    const frozenCup = item.consumoVaso;
    if (
        !frozenCup
        || String(frozenCup.insumoId || '') !== String(assignment.insumoId)
        || Number(frozenCup.unidades || 0) !== units
    ) {
        throw new SalesIntegrityError(
            'client-update-required',
            `La configuración de vaso de "${item.nombre || 'un producto'}" cambió. Actualiza la aplicación, retíralo y vuelve a agregarlo.`
        );
    }
}

function reconcileSaleItemsWithCatalog({
    items,
    previousItems,
    productReads,
    isEdit,
    saleId,
    localId
}) {
    const productReadsById = new Map(
        productReads.map(read => [read.delta.productoId, read])
    );
    const matchHistoricalLine = createHistoricalLineMatcher(previousItems, saleId);

    return (Array.isArray(items) ? items : []).map(item => {
        const isAdjustment =
            item?.productoId === 'AJUSTE'
            || normalizeName(item?.categoria) === 'ajuste';
        if (isAdjustment) return { ...item, costo: 0 };

        const historicalItem = isEdit ? matchHistoricalLine(item) : null;
        const previousQuantity = Number(historicalItem?.cantidad);
        const currentQuantity = Number(item?.cantidad);
        const canPreserveHistoricalPrice = Boolean(
            historicalItem
            && Number.isInteger(previousQuantity)
            && Number.isInteger(currentQuantity)
            && currentQuantity === previousQuantity
        );
        if (canPreserveHistoricalPrice) {
            const historicalCost = Number(historicalItem.costo || 0);
            if (!Number.isFinite(historicalCost) || historicalCost < 0) {
                throw new SalesIntegrityError(
                    'invalid-money',
                    `El costo histórico de "${item.nombre || 'un producto'}" no es válido.`
                );
            }
            return { ...item, costo: historicalCost };
        }

        const { expectedPrice, currentCost } = getCurrentProductPrice(
            item,
            productReadsById
        );
        assertItemCupMatchesCatalog(
            item,
            productReadsById,
            localId
        );
        if (Math.abs(Number(item.precio) - expectedPrice) > MONEY_EPSILON) {
            throw new SalesIntegrityError(
                'catalog-changed',
                `El precio de "${item.nombre || 'un producto'}" cambió. Retíralo y vuelve a agregarlo.`
            );
        }
        return { ...item, costo: currentCost };
    });
}

async function commitSaleTransaction({
    saleId,
    operationId,
    sale,
    inventoryMovements,
    editContext = null,
    cupControlDate = ''
}) {
    if (!saleId || !operationId) {
        throw new SalesIntegrityError(
            'missing-operation-id',
            'No se pudo generar un identificador seguro para la venta.'
        );
    }

    assertSaleAmounts(sale);
    const requestedMovements = normalizeStoredMovements(inventoryMovements, null);
    assertRequestedCupMovements(sale.items, requestedMovements);
    const saleRef = doc(db, 'ventas', saleId);

    return runTransaction(db, async transaction => {
        const saleSnapshot = await transaction.get(saleRef);
        const isEdit = Boolean(editContext);
        let previousSale = null;
        let previousMovements = [];
        let previousMovementsNeedStockInference = false;

        if (isEdit) {
            if (!saleSnapshot.exists()) {
                throw new SalesIntegrityError(
                    'sale-not-found',
                    'La venta original ya no existe.'
                );
            }

            previousSale = saleSnapshot.data();
            if (wasOperationApplied(previousSale, operationId)) {
                return { saleId, alreadyApplied: true, edited: true };
            }

            const lockToken = String(editContext.lockToken || '');
            if (!lockToken) {
                throw new SalesIntegrityError(
                    'missing-sale-edit-lock',
                    'Vuelve a abrir el pedido antes de guardar los cambios.'
                );
            }

            const currentRevision = Number(previousSale.revision || 1);
            if (currentRevision !== Number(editContext.expectedRevision || 1)) {
                throw new SalesIntegrityError(
                    'edit-conflict',
                    'La venta fue modificada desde otro dispositivo. Vuelve a abrirla.'
                );
            }

            const currentState = String(
                previousSale.estado || 'pendiente'
            ).toLowerCase();
            if (!['pendiente', 'editando'].includes(currentState)) {
                throw new SalesIntegrityError(
                    'invalid-sale-state',
                    'El pedido ya no se encuentra disponible para edición.'
                );
            }

            const editLock = getSaleEditLockState(previousSale);
            if (editLock.active && editLock.token !== lockToken) {
                throw new SalesIntegrityError(
                    'sale-edit-locked',
                    `El pedido está siendo editado por ${editLock.ownerName}.`,
                    {
                        ownerId: editLock.ownerId,
                        ownerName: editLock.ownerName,
                        expiresAtMs: editLock.expiresAtMs
                    }
                );
            }

            const storedPreviousMovements = normalizeStoredMovements(
                previousSale.inventarioMovimientos,
                false
            );
            previousMovements = storedPreviousMovements.length > 0
                ? storedPreviousMovements
                : normalizeStoredMovements(
                    editContext.legacyInventoryMovements || [],
                    false
                );
            previousMovementsNeedStockInference = (
                storedPreviousMovements.length === 0
                && previousMovements.length > 0
            );
        } else if (saleSnapshot.exists()) {
            const existing = saleSnapshot.data();
            if (wasOperationApplied(existing, operationId)) {
                return { saleId, alreadyApplied: true, edited: false };
            }
            throw new SalesIntegrityError(
                'duplicate-sale-id',
                'El identificador de la venta ya existe.'
            );
        }

        const productIds = [...new Set([
            ...previousMovements.map(movement => movement.productoId),
            ...requestedMovements.map(movement => movement.productoId)
        ])];
        if (productIds.length > MAX_DISTINCT_PRODUCTS_PER_OPERATION) {
            throw new SalesIntegrityError(
                'too-many-products',
                'La operación contiene demasiados productos distintos.'
            );
        }

        const allProductReads = await readProducts(
            transaction,
            productIds.map(productoId => ({
                productoId,
                stockDelta: 0,
                salesDelta: 0
            }))
        );
        const newProductIds = new Set(
            requestedMovements.map(movement => movement.productoId)
        );
        const missingNewProducts = allProductReads
            .filter(read => newProductIds.has(read.delta.productoId) && !read.snapshot.exists())
            .map(read => read.delta.productoId);
        if (missingNewProducts.length > 0) {
            throw new SalesIntegrityError(
                'missing-product',
                'Uno o más productos ya no existen en el catálogo.',
                { productIds: missingNewProducts }
            );
        }
        const targetLocalId = String(
            (isEdit ? previousSale?.localId : sale.localId)
            || sale.localId
            || 'general'
        );
        const outOfScopeProducts = allProductReads
            .filter(read => (
                newProductIds.has(read.delta.productoId)
                && read.snapshot.exists()
                && !productBelongsToLocation(
                    read.snapshot.data(),
                    targetLocalId
                )
            ))
            .map(read => read.delta.productoId);
        if (outOfScopeProducts.length > 0) {
            throw new SalesIntegrityError(
                'product-out-of-location',
                'Uno o más productos pertenecen a otra sede.',
                { productIds: outOfScopeProducts, localId: targetLocalId }
            );
        }

        if (previousMovementsNeedStockInference) {
            previousMovements = resolveMovementStockFlags(
                previousMovements,
                allProductReads
            );
        }

        const newMovements = resolveMovementStockFlags(
            requestedMovements,
            allProductReads
        );
        const reconciledItems = reconcileSaleItemsWithCatalog({
            items: sale.items,
            previousItems: previousSale?.items || [],
            productReads: allProductReads,
            isEdit,
            saleId,
            localId: targetLocalId
        });
        const reconciledCosts = reconciledItems.reduce(
            (sum, item) => roundMoney(
                sum + Number(item.costo || 0) * Number(item.cantidad || 0)
            ),
            0
        );
        const saleForCommit = {
            ...sale,
            items: reconciledItems,
            costoTotal: reconciledCosts,
            costo_total: reconciledCosts
        };
        const newAccounting = assertSaleAmounts(saleForCommit);
        const productDeltas = buildProductDelta(previousMovements, newMovements);
        const readsById = new Map(
            allProductReads.map(read => [read.delta.productoId, read])
        );
        const productReads = productDeltas.map(delta => {
            const read = readsById.get(delta.productoId);
            return { delta, ref: read.ref, snapshot: read.snapshot };
        });
        const { availabilityRows } = queueProductDeltas(
            transaction,
            productReads,
            {
                requireAll: true,
                cupControlContext: {
                    fechaStr: cupControlDate || saleForCommit.fechaStr,
                    localId: targetLocalId,
                    localNombre: saleForCommit.localNombre || ''
                }
            }
        );

        let finalSale = {
            ...saleForCommit,
            id: saleId,
            inventarioMovimientos: newMovements,
            lastOperationId: operationId,
            lastOperationType: isEdit ? 'editar_venta' : 'crear_venta',
            appliedOperations: appendAppliedOperation(
                previousSale || {},
                operationId,
                isEdit ? 'editar_venta' : 'crear_venta'
            ),
            revision: isEdit ? Number(previousSale.revision || 1) + 1 : 1
        };

        if (isEdit) {
            finalSale = {
                ...finalSale,
                fecha: previousSale.fecha || previousSale.timestamp || serverTimestamp(),
                timestamp: previousSale.timestamp || previousSale.fecha || serverTimestamp(),
                fechaStr: previousSale.fechaStr || saleForCommit.fechaStr,
                fechaHora: previousSale.fechaHora ?? saleForCommit.fechaHora,
                localId: previousSale.localId || saleForCommit.localId || 'general',
                localNombre: previousSale.localNombre || saleForCommit.localNombre || 'Sin Local',
                cajeroEmail: previousSale.cajeroEmail || saleForCommit.cajeroEmail || '',
                creadoPor: previousSale.creadoPor || saleForCommit.creadoPor || '',
                editado: true,
                editadoPor: saleForCommit.editadoPor || saleForCommit.creadoPor || '',
                fechaEdicion: serverTimestamp(),
                estado: 'pendiente',
                ...buildClearedEditLockFields(
                    saleForCommit.editadoPor || saleForCommit.creadoPor || '',
                    'edicion_guardada'
                )
            };

            const oldAccounting = getAccounting(previousSale);
            const oldCashKey = getCashDocumentKey(previousSale);
            const newCashKey = getCashDocumentKey(finalSale);

            if (oldCashKey === newCashKey) {
                queueCashDelta(
                    transaction,
                    finalSale,
                    subtractAccounting(newAccounting, oldAccounting),
                    0
                );
            } else {
                queueCashDelta(transaction, previousSale, negateAccounting(oldAccounting), -1);
                queueCashDelta(transaction, finalSale, newAccounting, 1);
            }
        } else {
            finalSale = {
                ...finalSale,
                fecha: serverTimestamp(),
                timestamp: serverTimestamp(),
                estado: 'pendiente',
                editado: false,
                edicionActiva: false
            };
            queueCashDelta(transaction, finalSale, newAccounting, 1);
        }

        transaction.set(saleRef, finalSale);
        return {
            saleId,
            alreadyApplied: false,
            edited: isEdit,
            publicAvailabilityRows: availabilityRows,
            publicAvailabilityLocalId: targetLocalId
        };
    });
}

export async function acquireSaleEditLock({
    saleId,
    lockToken,
    ownerId,
    ownerName,
    expectedRevision = null,
    ttlMs = SALE_EDIT_LOCK_TTL_MS
}) {
    if (!saleId || !lockToken || !ownerId) {
        throw new SalesIntegrityError(
            'missing-sale-edit-lock-data',
            'No se pudo identificar esta sesión de edición.'
        );
    }

    const normalizedTtl = Math.min(
        60 * 60 * 1000,
        Math.max(5 * 60 * 1000, Number(ttlMs) || SALE_EDIT_LOCK_TTL_MS)
    );
    const saleRef = doc(db, 'ventas', saleId);

    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(saleRef);
        if (!snapshot.exists()) {
            throw new SalesIntegrityError('sale-not-found', 'La venta ya no existe.');
        }

        const sale = snapshot.data();
        if (
            expectedRevision !== null
            && Number(sale.revision || 1) !== Number(expectedRevision)
        ) {
            throw new SalesIntegrityError(
                'edit-conflict',
                'El pedido cambió desde que comenzaste a editarlo.'
            );
        }
        const currentState = String(sale.estado || 'pendiente').toLowerCase();
        const currentLock = getSaleEditLockState(sale);
        const recoverableEditingState =
            currentState === 'editando' && !currentLock.active;
        const sameActiveLock =
            currentState === 'editando' &&
            currentLock.active &&
            currentLock.token === lockToken;

        if (currentState !== 'pendiente' && !recoverableEditingState && !sameActiveLock) {
            throw new SalesIntegrityError(
                'invalid-sale-state',
                'Solo se pueden editar pedidos pendientes.'
            );
        }

        if (currentLock.active && currentLock.token !== lockToken) {
            throw new SalesIntegrityError(
                'sale-edit-locked',
                `El pedido ya está siendo editado por ${currentLock.ownerName}.`,
                {
                    ownerId: currentLock.ownerId,
                    ownerName: currentLock.ownerName,
                    expiresAtMs: currentLock.expiresAtMs
                }
            );
        }

        const expiresAtMs = getTrustedNowMs() + normalizedTtl;
        const sameLock = currentLock.token === lockToken;
        transaction.update(saleRef, {
            estado: 'editando',
            edicionActiva: true,
            edicionToken: lockToken,
            edicionPropietarioId: ownerId,
            edicionPropietarioNombre: ownerName || 'Usuario',
            edicionIniciadaEn: sameLock
                ? (sale.edicionIniciadaEn || serverTimestamp())
                : serverTimestamp(),
            edicionActualizadaEn: serverTimestamp(),
            edicionExpiraEnMs: expiresAtMs,
            edicionTtlMs: normalizedTtl,
            edicionBloqueoVersion: Number(sale.edicionBloqueoVersion || 0) + 1
        });

        return {
            saleId,
            lockToken,
            alreadyApplied: sameLock,
            expectedRevision: Number(sale.revision || 1),
            expiresAtMs,
            sale: { id: saleId, ...sale, estado: 'editando' }
        };
    });
}

export async function releaseSaleEditLock({
    saleId,
    operationId = '',
    lockToken,
    actor,
    reason = 'edicion_cancelada'
}) {
    if (!saleId || !lockToken) {
        throw new SalesIntegrityError(
            'missing-sale-edit-lock-data',
            'No se pudo identificar la edición que deseas cancelar.'
        );
    }

    const saleRef = doc(db, 'ventas', saleId);
    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(saleRef);
        if (!snapshot.exists()) {
            throw new SalesIntegrityError('sale-not-found', 'La venta ya no existe.');
        }

        const sale = snapshot.data();
        const currentLock = getSaleEditLockState(sale);
        const operationFields = operationId ? {
            lastOperationId: operationId,
            lastOperationType: 'liberar_edicion',
            appliedOperations: appendAppliedOperation(
                sale,
                operationId,
                'liberar_edicion'
            )
        } : {};
        if (!currentLock.token) {
            if (String(sale.estado || '').toLowerCase() === 'editando') {
                transaction.update(saleRef, {
                    estado: 'pendiente',
                    ...buildClearedEditLockFields(actor, 'bloqueo_huerfano'),
                    ...operationFields
                });
                return { saleId, alreadyReleased: false, recoveredOrphan: true };
            }
            if (operationId && !wasOperationApplied(sale, operationId)) {
                transaction.update(saleRef, operationFields);
            }
            return { saleId, alreadyReleased: true };
        }
        if (currentLock.token !== lockToken) {
            throw new SalesIntegrityError(
                'sale-edit-lock-lost',
                currentLock.active
                    ? `El bloqueo pertenece ahora a ${currentLock.ownerName}.`
                    : 'Este bloqueo de edición ya no te pertenece.',
                {
                    ownerId: currentLock.ownerId,
                    ownerName: currentLock.ownerName,
                    expiresAtMs: currentLock.expiresAtMs
                }
            );
        }

        transaction.update(
            saleRef,
            {
                ...(String(sale.estado || '').toLowerCase() === 'editando'
                    ? { estado: 'pendiente' }
                    : {}),
                ...buildClearedEditLockFields(actor, reason),
                ...operationFields
            }
        );
        return { saleId, alreadyReleased: false };
    });
}

async function commitSaleStateTransition({
    saleId,
    operationId,
    nextState,
    allowedStates,
    actor,
    reason = '',
    legacyInventoryMovements = [],
    cupControlDate = ''
}) {
    const saleRef = doc(db, 'ventas', saleId);
    const normalizedNextState = String(nextState || '').toLowerCase();
    const normalizedAllowed = new Set(
        (allowedStates || []).map(state => String(state).toLowerCase())
    );
    if (!saleId || !operationId || !normalizedNextState) {
        throw new SalesIntegrityError(
            'missing-operation-id',
            'No se pudo identificar de forma segura el cambio del pedido.'
        );
    }

    return runTransaction(db, async transaction => {
        const saleSnapshot = await transaction.get(saleRef);
        if (!saleSnapshot.exists()) {
            throw new SalesIntegrityError('sale-not-found', 'La venta ya no existe.');
        }

        const sale = saleSnapshot.data();
        const currentState = String(sale.estado || 'pendiente').toLowerCase();

        if (wasOperationApplied(sale, operationId)) {
            return { saleId, alreadyApplied: true, previousState: currentState };
        }
        if (currentState === normalizedNextState) {
            const operationType = normalizedNextState === 'rechazado'
                ? 'anular_venta'
                : 'cambiar_estado';
            transaction.update(saleRef, {
                lastOperationId: operationId,
                lastOperationType: operationType,
                appliedOperations: appendAppliedOperation(
                    sale,
                    operationId,
                    operationType
                )
            });
            return {
                saleId,
                alreadyApplied: true,
                operationRecorded: true,
                previousState: currentState
            };
        }

        const editLock = assertSaleEditUnlocked(sale);
        const effectiveCurrentState =
            currentState === 'editando' && editLock.stale
                ? 'pendiente'
                : currentState;
        if (!normalizedAllowed.has(effectiveCurrentState)) {
            throw new SalesIntegrityError(
                'invalid-sale-state',
                `La venta ya cambió al estado "${currentState}".`
            );
        }

        const shouldRestoreInventory = normalizedNextState === 'rechazado';
        let missingProducts = [];
        let publicAvailabilityRows = [];

        if (shouldRestoreInventory) {
            const storedMovements = normalizeStoredMovements(
                sale.inventarioMovimientos,
                false
            );
            const suppliedLegacyMovements = normalizeStoredMovements(
                legacyInventoryMovements,
                false
            );
            let movements = storedMovements.length > 0
                ? storedMovements
                : (
                    suppliedLegacyMovements.length > 0
                        ? suppliedLegacyMovements
                        : buildLegacyInventoryMovements(sale.items)
                );
            const legacyMovementsNeedStockInference =
                storedMovements.length === 0 && movements.length > 0;
            const initialProductReads = await readProducts(
                transaction,
                movements.map(movement => ({
                    productoId: movement.productoId,
                    stockDelta: 0,
                    salesDelta: 0
                }))
            );
            if (legacyMovementsNeedStockInference) {
                movements = resolveMovementStockFlags(
                    movements,
                    initialProductReads
                );
            }
            const productDeltas = buildProductDelta(movements, []);
            const readsById = new Map(
                initialProductReads.map(read => [read.delta.productoId, read])
            );
            const productReads = productDeltas.map(delta => {
                const read = readsById.get(delta.productoId);
                return { delta, ref: read.ref, snapshot: read.snapshot };
            });
            const productDeltaResult = queueProductDeltas(
                transaction,
                productReads,
                {
                    requireAll: false,
                    cupControlContext: {
                        fechaStr: cupControlDate || sale.fechaStr,
                        localId: sale.localId || 'general',
                        localNombre: sale.localNombre || ''
                    }
                }
            );
            missingProducts = productDeltaResult.missingProducts;
            publicAvailabilityRows = productDeltaResult.availabilityRows;
            queueCashDelta(
                transaction,
                sale,
                negateAccounting(getAccounting(sale)),
                -1
            );
        }

        transaction.update(saleRef, {
            estado: normalizedNextState,
            modificadoPor: actor || 'Desconocido',
            fechaModificacion: serverTimestamp(),
            motivoCambio: reason || '',
            inventarioRestaurado: shouldRestoreInventory,
            productosNoRestaurados: missingProducts,
            lastOperationId: operationId,
            lastOperationType:
                normalizedNextState === 'rechazado' ? 'anular_venta' : 'cambiar_estado',
            appliedOperations: appendAppliedOperation(
                sale,
                operationId,
                normalizedNextState === 'rechazado' ? 'anular_venta' : 'cambiar_estado'
            ),
            revision: Number(sale.revision || 1) + 1,
            ...(editLock.stale
                ? {
                    ...buildClearedEditLockFields(actor, 'bloqueo_expirado'),
                    estado: normalizedNextState
                }
                : {})
        });

        return {
            saleId,
            alreadyApplied: false,
            previousState: currentState,
            missingProducts,
            publicAvailabilityRows,
            publicAvailabilityLocalId: sale.localId || 'general'
        };
    });
}

function calculateEditedPayments(sale, newTotal) {
    const accounting = getAccounting(sale);
    const method = String(sale.metodoFinal || sale.metodo_pago || 'efectivo').toLowerCase();
    let cash = accounting.cash;
    let digital = accounting.digital;

    if (method === 'efectivo') {
        cash = newTotal;
        digital = 0;
    } else if (method === 'yape' || method === 'transferencia') {
        cash = 0;
        digital = newTotal;
    } else if (method === 'mixto') {
        if (accounting.total <= 0 || cash <= 0 || digital <= 0) {
            throw new SalesIntegrityError(
                'invalid-payment-adjustment',
                'El pago mixto original no tiene una distribución válida.'
            );
        }
        const cashRatio = cash / accounting.total;
        cash = roundMoney(newTotal * cashRatio);
        digital = roundMoney(newTotal - cash);
        if (cash <= 0 || digital <= 0) {
            throw new SalesIntegrityError(
                'invalid-payment-adjustment',
                'El nuevo total no permite conservar ambos medios del pago mixto.'
            );
        }
    } else {
        throw new SalesIntegrityError(
            'invalid-payment-method',
            'El método de pago de la venta no es compatible.'
        );
    }

    if (Math.abs(cash + digital - newTotal) > MONEY_EPSILON) {
        throw new SalesIntegrityError(
            'payment-mismatch',
            'No se pudo cuadrar el nuevo total con sus medios de pago.'
        );
    }

    return { method, cash, digital };
}

async function commitSaleAmountUpdate({
    saleId,
    operationId,
    newTotal,
    actor
}) {
    const normalizedTotal = roundMoney(newTotal);
    if (normalizedTotal <= 0) {
        throw new SalesIntegrityError(
            'non-positive-total',
            'El total corregido debe ser mayor que cero.'
        );
    }

    const saleRef = doc(db, 'ventas', saleId);
    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(saleRef);
        if (!snapshot.exists()) {
            throw new SalesIntegrityError('sale-not-found', 'La venta ya no existe.');
        }

        const sale = snapshot.data();
        if (wasOperationApplied(sale, operationId)) {
            return { saleId, alreadyApplied: true };
        }
        if (String(sale.estado || '').toLowerCase() === 'rechazado') {
            throw new SalesIntegrityError(
                'invalid-sale-state',
                'No se puede editar una venta anulada.'
            );
        }

        const editLock = assertSaleEditUnlocked(sale);
        const currentState = String(sale.estado || '').toLowerCase();
        if (currentState === 'editando' && !editLock.stale) {
            throw new SalesIntegrityError(
                'sale-edit-locked',
                'El pedido continúa en modo edición.'
            );
        }
        const oldAccounting = getAccounting(sale);
        const payments = calculateEditedPayments(sale, normalizedTotal);
        const newAccounting = {
            ...oldAccounting,
            total: normalizedTotal,
            cash: payments.cash,
            digital: payments.digital
        };

        queueCashDelta(
            transaction,
            sale,
            subtractAccounting(newAccounting, oldAccounting),
            0
        );
        transaction.update(saleRef, {
            total: normalizedTotal,
            pago_efectivo: payments.cash,
            pagoEfectivo: payments.cash,
            pago_yape: payments.digital,
            pagoYape: payments.digital,
            metodoFinal: payments.method,
            metodo_pago: payments.method,
            editado: true,
            editadoPor: actor || 'Desconocido',
            fechaEdicion: serverTimestamp(),
            lastOperationId: operationId,
            lastOperationType: 'editar_monto',
            appliedOperations: appendAppliedOperation(
                sale,
                operationId,
                'editar_monto'
            ),
            revision: Number(sale.revision || 1) + 1,
            ...(editLock.stale
                ? {
                    ...buildClearedEditLockFields(actor, 'bloqueo_expirado'),
                    estado: 'pendiente'
                }
                : {})
        });

        return { saleId, alreadyApplied: false };
    });
}

async function commitExpenseAmountUpdate({
    expenseId,
    operationId,
    newAmount,
    actor
}) {
    const normalizedAmount = roundMoney(newAmount);
    if (normalizedAmount <= 0) {
        throw new SalesIntegrityError(
            'non-positive-expense',
            'El gasto debe ser mayor que cero.'
        );
    }

    const expenseRef = doc(db, 'gastos', expenseId);
    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(expenseRef);
        if (!snapshot.exists()) {
            throw new SalesIntegrityError('expense-not-found', 'El gasto ya no existe.');
        }

        const expense = snapshot.data();
        if (wasOperationApplied(expense, operationId)) {
            return { expenseId, alreadyApplied: true };
        }

        const oldAmount = roundMoney(toFiniteNumber(expense.monto));
        const cashRef = doc(
            db,
            'caja_diaria',
            `${expense.fechaStr}_${expense.localId || 'general'}`
        );

        transaction.set(cashRef, {
            total_gastos: increment(roundMoney(normalizedAmount - oldAmount))
        }, { merge: true });
        transaction.update(expenseRef, {
            monto: normalizedAmount,
            editadoPor: actor || 'Desconocido',
            fechaEdicion: serverTimestamp(),
            lastOperationId: operationId,
            lastOperationType: 'editar_gasto',
            appliedOperations: appendAppliedOperation(
                expense,
                operationId,
                'editar_gasto'
            ),
            revision: Number(expense.revision || 1) + 1
        });

        return { expenseId, alreadyApplied: false };
    });
}

async function commitExpenseTransaction({
    expenseId,
    operationId,
    expense
}) {
    if (!expenseId || !operationId) {
        throw new SalesIntegrityError(
            'missing-operation-id',
            'No se pudo generar un identificador seguro para el gasto.'
        );
    }

    const amount = roundMoney(expense?.monto);
    const description = String(expense?.descripcion || '').trim();
    const date = String(expense?.fechaStr || '').trim();
    const localId = String(expense?.localId || 'general').trim() || 'general';
    if (!description || amount <= 0 || !date) {
        throw new SalesIntegrityError(
            'invalid-expense',
            'Completa una descripción, fecha y monto válido para el gasto.'
        );
    }

    const expenseRef = doc(db, 'gastos', expenseId);
    const cashRef = doc(db, 'caja_diaria', `${date}_${localId}`);

    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(expenseRef);
        if (snapshot.exists()) {
            if (wasOperationApplied(snapshot.data(), operationId)) {
                return { expenseId, alreadyApplied: true };
            }
            throw new SalesIntegrityError(
                'duplicate-expense-id',
                'El identificador del gasto ya existe.'
            );
        }

        transaction.set(expenseRef, {
            ...expense,
            monto: amount,
            fechaStr: date,
            localId,
            fechaHora: Number(expense.fechaHora) || getTrustedNowMs(),
            timestamp: serverTimestamp(),
            revision: 1,
            lastOperationId: operationId,
            lastOperationType: 'crear_gasto',
            appliedOperations: appendAppliedOperation({}, operationId, 'crear_gasto')
        });
        transaction.set(cashRef, {
            localId,
            localNombre: expense.localNombre || 'Sin Local',
            fechaStr: date,
            total_gastos: increment(amount)
        }, { merge: true });

        return { expenseId, alreadyApplied: false };
    });
}

async function commitExpenseDeletion({ expenseId, operationId }) {
    const expenseRef = doc(db, 'gastos', expenseId);
    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(expenseRef);
        if (!snapshot.exists()) {
            return { expenseId, alreadyApplied: true };
        }

        const expense = snapshot.data();
        const cashRef = doc(
            db,
            'caja_diaria',
            `${expense.fechaStr}_${expense.localId || 'general'}`
        );
        transaction.set(cashRef, {
            total_gastos: increment(-roundMoney(toFiniteNumber(expense.monto)))
        }, { merge: true });
        transaction.delete(expenseRef);

        return { expenseId, operationId, alreadyApplied: false };
    });
}

function getQueueOwnerId() {
    const ownerId = String(auth.currentUser?.uid || '');
    if (!ownerId) {
        throw new SalesIntegrityError(
            'sync-auth-not-ready',
            'La sesión todavía no está lista para guardar esta operación.'
        );
    }
    return ownerId;
}

function assertOperationOwner(operation) {
    const currentOwnerId = String(auth.currentUser?.uid || '');
    if (!currentOwnerId || currentOwnerId !== operation.ownerId) {
        throw new SalesIntegrityError(
            'sync-auth-not-ready',
            'La sincronización esperará a que vuelva la sesión que creó la operación.'
        );
    }
}

function buildOptimisticInventoryMutations(
    nextMovements = [],
    previousMovements = []
) {
    const deltas = new Map();
    const addDelta = (movement, stockDelta, salesDelta) => {
        const productId = String(movement?.productoId || movement?.id || '');
        const quantity = Number(movement?.cantidad);
        if (!productId || !Number.isInteger(quantity) || quantity <= 0) return;
        const current = deltas.get(productId) || { stock: 0, ventasTotales: 0 };
        current.stock += stockDelta * quantity;
        current.ventasTotales += salesDelta * quantity;
        deltas.set(productId, current);
    };

    (Array.isArray(previousMovements) ? previousMovements : [])
        .forEach(movement => addDelta(
            movement,
            movement?.stockAfectado === false ? 0 : 1,
            -1
        ));
    (Array.isArray(nextMovements) ? nextMovements : [])
        .forEach(movement => addDelta(
            movement,
            movement?.stockAfectado === false ? 0 : -1,
            1
        ));

    return [...deltas.entries()]
        .filter(([, delta]) => delta.stock !== 0 || delta.ventasTotales !== 0)
        .map(([documentId, data]) => ({
            collection: 'productos',
            documentId,
            kind: 'increment',
            data
        }));
}

function buildOptimisticCupControlMutations(
    nextMovements = [],
    previousMovements = [],
    date = ''
) {
    const normalizedDate = String(date || '').trim();
    if (!normalizedDate) return [];

    return buildProductDelta(previousMovements, nextMovements)
        .filter(delta => Number(delta.cupConsumptionDelta || 0) !== 0)
        .flatMap(delta => {
            const documentId = getCupControlDocumentId(
                normalizedDate,
                delta.productoId
            );
            return [
                {
                    collection: 'control_vasos_diario',
                    documentId,
                    kind: 'merge',
                    data: {
                        fechaStr: normalizedDate,
                        productoId: String(delta.productoId)
                    }
                },
                {
                    collection: 'control_vasos_diario',
                    documentId,
                    kind: 'increment',
                    data: {
                        consumidos: Number(delta.cupConsumptionDelta)
                    }
                }
            ];
        });
}

export function saveSaleTransaction({
    saleId,
    operationId,
    sale,
    inventoryMovements,
    editContext = null,
    cupControlDate = '',
    persistAfter = null,
    supersedesQueueIds = []
}) {
    if (!saleId || !operationId) {
        throw new SalesIntegrityError(
            'missing-operation-id',
            'No se pudo generar un identificador seguro para la venta.'
        );
    }
    assertSaleAmounts(sale);

    const ownerId = getQueueOwnerId();
    const isEdit = Boolean(editContext);
    const pendingCreate = (
        editContext?.localPendingCreate === true
        && editContext.pendingCreateQueueId
    )
        ? getPendingSyncOperationById(editContext.pendingCreateQueueId)
        : null;
    const validPendingCreate = (
        pendingCreate?.type === 'sale.save'
        && pendingCreate.payload?.editContext == null
        && pendingCreate.payload?.saleId === saleId
    )
        ? pendingCreate
        : null;
    const canCoalescePendingCreate = Boolean(
        validPendingCreate
        && ['queued', 'retry'].includes(validPendingCreate.status)
        && validPendingCreate.payload?.operationId
            === editContext.pendingCreateOperationId
        && Boolean(editContext.pendingCreateVersion)
        && validPendingCreate.version === editContext.pendingCreateVersion
        && operationId === editContext.pendingCreateOperationId
    );
    const originalCreateSale = validPendingCreate?.payload?.sale || null;
    const queuedSale = canCoalescePendingCreate
        ? {
            ...sale,
            fechaStr: originalCreateSale?.fechaStr || sale.fechaStr,
            fechaHora: originalCreateSale?.fechaHora ?? sale.fechaHora,
            localId: originalCreateSale?.localId || sale.localId,
            localNombre:
                originalCreateSale?.localNombre || sale.localNombre,
            cajeroEmail:
                originalCreateSale?.cajeroEmail || sale.cajeroEmail,
            creadoPor: originalCreateSale?.creadoPor || sale.creadoPor
        }
        : sale;
    const queuedEditContext = canCoalescePendingCreate ? null : editContext;
    let queuedOperationId = operationId;
    if (
        editContext?.localPendingCreate === true
        && !canCoalescePendingCreate
        && operationId === editContext.pendingCreateOperationId
    ) {
        queuedOperationId = createUuid('OP-');
    }
    const optimisticIsEdit = Boolean(queuedEditContext);
    const optimisticSale = {
        ...queuedSale,
        ...(optimisticIsEdit && editContext?.originalFechaHora !== undefined
            ? { fechaHora: editContext.originalFechaHora }
            : {}),
        id: saleId,
        estado: 'pendiente',
        editado: optimisticIsEdit,
        edicionActiva: false,
        edicionToken: null,
        inventarioMovimientos: Array.isArray(inventoryMovements)
            ? inventoryMovements
            : [],
        lastOperationId: queuedOperationId,
        lastOperationType:
            optimisticIsEdit ? 'editar_venta' : 'crear_venta',
        revision: optimisticIsEdit
            ? Number(editContext?.expectedRevision || 1) + 1
            : 1
    };
    const optimisticMutations = [
        {
            collection: 'ventas',
            documentId: saleId,
            kind: 'merge',
            data: optimisticSale
        },
        ...buildOptimisticInventoryMutations(
            inventoryMovements,
            optimisticIsEdit
                ? (
                    editContext?.originalInventoryMovements
                    || editContext?.legacyInventoryMovements
                    || []
                )
                : []
        ),
        ...buildOptimisticCupControlMutations(
            inventoryMovements,
            optimisticIsEdit
                ? (
                    editContext?.originalInventoryMovements
                    || editContext?.legacyInventoryMovements
                    || []
                )
                : [],
            cupControlDate || queuedSale.fechaStr
        )
    ];

    if (canCoalescePendingCreate) {
        const replaced = replaceQueuedSyncOperation({
            operationId: validPendingCreate.id,
            expectedVersion: validPendingCreate.version,
            localId: queuedSale.localId || 'general',
            persistAfter,
            entityKey: `ventas/${saleId}`,
            dependsOn: [],
            payload: {
                saleId,
                operationId: queuedOperationId,
                sale: queuedSale,
                inventoryMovements,
                editContext: null,
                cupControlDate
            },
            optimisticMutations
        });

        return {
            saleId,
            operationId: queuedOperationId,
            edited: true,
            coalesced: true,
            alreadyApplied: false,
            queued: true,
            version: replaced.version,
            persisted: replaced.persisted
        };
    }

    const queued = enqueueSyncOperation({
        id: queuedOperationId,
        type: 'sale.save',
        ownerId,
        localId: queuedSale.localId || 'general',
        entityKey: `ventas/${saleId}`,
        dependsOn: validPendingCreate ? [validPendingCreate.id] : [],
        persistAfter,
        supersedesQueueIds,
        payload: {
            saleId,
            operationId: queuedOperationId,
            sale: queuedSale,
            inventoryMovements,
            editContext: queuedEditContext,
            cupControlDate
        },
        optimisticMutations
    });

    return {
        saleId,
        operationId: queuedOperationId,
        edited: isEdit,
        alreadyApplied: queued.alreadyQueued,
        queued: true,
        version: queued.version,
        persisted: queued.persisted
    };
}

export function transitionSaleTransaction({
    saleId,
    operationId,
    nextState,
    allowedStates,
    actor,
    reason = '',
    legacyInventoryMovements = [],
    cupControlDate = ''
}) {
    const normalizedNextState = String(nextState || '').toLowerCase();
    if (!saleId || !operationId || !normalizedNextState) {
        throw new SalesIntegrityError(
            'missing-operation-id',
            'No se pudo identificar de forma segura el cambio del pedido.'
        );
    }

    const ownerId = getQueueOwnerId();
    const queued = enqueueSyncOperation({
        id: operationId,
        type: 'sale.transition',
        ownerId,
        entityKey: `ventas/${saleId}`,
        payload: {
            saleId,
            operationId,
            nextState: normalizedNextState,
            allowedStates,
            actor,
            reason,
            legacyInventoryMovements,
            cupControlDate
        },
        optimisticMutations: [
            {
                collection: 'ventas',
                documentId: saleId,
                kind: 'merge',
                data: {
                    estado: normalizedNextState,
                    modificadoPor: actor || 'Desconocido',
                    motivoCambio: reason || '',
                    lastOperationId: operationId,
                    lastOperationType:
                        normalizedNextState === 'rechazado'
                            ? 'anular_venta'
                            : 'cambiar_estado'
                }
            },
            ...(normalizedNextState === 'rechazado'
                ? buildOptimisticInventoryMutations(
                    [],
                    legacyInventoryMovements
                )
                : []),
            ...(normalizedNextState === 'rechazado'
                ? buildOptimisticCupControlMutations(
                    [],
                    legacyInventoryMovements,
                    cupControlDate
                )
                : [])
        ]
    });

    return {
        saleId,
        alreadyApplied: queued.alreadyQueued,
        queued: true,
        persisted: queued.persisted,
        missingProducts: []
    };
}

export function releaseSaleEditLockTransaction({
    saleId,
    operationId,
    lockToken,
    actor,
    reason = 'edicion_cancelada'
}) {
    if (!saleId || !operationId || !lockToken) {
        throw new SalesIntegrityError(
            'missing-sale-edit-lock-data',
            'No se pudo identificar la edición que deseas cancelar.'
        );
    }

    const ownerId = getQueueOwnerId();
    const queued = enqueueSyncOperation({
        id: operationId,
        type: 'sale.release-edit',
        ownerId,
        entityKey: `ventas/${saleId}`,
        payload: {
            saleId,
            operationId,
            lockToken,
            actor,
            reason
        },
        optimisticMutations: [{
            collection: 'ventas',
            documentId: saleId,
            kind: 'merge',
            data: {
                estado: 'pendiente',
                edicionActiva: false,
                edicionToken: null,
                edicionPropietarioId: null,
                edicionPropietarioNombre: null,
                edicionIniciadaEn: null,
                edicionActualizadaEn: null,
                edicionExpiraEnMs: null,
                edicionTtlMs: null,
                edicionFinalizadaEnMs: getTrustedNowMs(),
                edicionFinalizadaPor: actor || 'Desconocido',
                edicionFinalizadaMotivo: reason || 'liberado',
                lastOperationId: operationId,
                lastOperationType: 'liberar_edicion'
            }
        }]
    });

    return {
        saleId,
        alreadyApplied: queued.alreadyQueued,
        queued: true,
        persisted: queued.persisted
    };
}

export function updateSaleAmountTransaction({
    saleId,
    operationId,
    newTotal,
    actor,
    currentSale = null
}) {
    const normalizedTotal = roundMoney(newTotal);
    if (!saleId || !operationId || normalizedTotal <= 0) {
        throw new SalesIntegrityError(
            'non-positive-total',
            'El total corregido debe ser mayor que cero.'
        );
    }

    const ownerId = getQueueOwnerId();
    const optimisticPayments = currentSale
        ? calculateEditedPayments(currentSale, normalizedTotal)
        : null;
    const queued = enqueueSyncOperation({
        id: operationId,
        type: 'sale.update-amount',
        ownerId,
        entityKey: `ventas/${saleId}`,
        payload: { saleId, operationId, newTotal: normalizedTotal, actor },
        optimisticMutations: [{
            collection: 'ventas',
            documentId: saleId,
            kind: 'merge',
            data: {
                total: normalizedTotal,
                ...(optimisticPayments
                    ? {
                        pago_efectivo: optimisticPayments.cash,
                        pagoEfectivo: optimisticPayments.cash,
                        pago_yape: optimisticPayments.digital,
                        pagoYape: optimisticPayments.digital,
                        metodoFinal: optimisticPayments.method,
                        metodo_pago: optimisticPayments.method
                    }
                    : {}),
                editado: true,
                editadoPor: actor || 'Desconocido',
                ...(currentSale
                    ? { revision: Number(currentSale.revision || 1) + 1 }
                    : {}),
                lastOperationId: operationId,
                lastOperationType: 'editar_monto'
            }
        }]
    });

    return {
        saleId,
        alreadyApplied: queued.alreadyQueued,
        queued: true,
        persisted: queued.persisted
    };
}

export function updateExpenseAmountTransaction({
    expenseId,
    operationId,
    newAmount,
    actor
}) {
    const normalizedAmount = roundMoney(newAmount);
    if (!expenseId || !operationId || normalizedAmount <= 0) {
        throw new SalesIntegrityError(
            'non-positive-expense',
            'El gasto debe ser mayor que cero.'
        );
    }

    const ownerId = getQueueOwnerId();
    const queued = enqueueSyncOperation({
        id: operationId,
        type: 'expense.update-amount',
        ownerId,
        entityKey: `gastos/${expenseId}`,
        payload: { expenseId, operationId, newAmount: normalizedAmount, actor },
        optimisticMutations: [{
            collection: 'gastos',
            documentId: expenseId,
            kind: 'merge',
            data: {
                monto: normalizedAmount,
                editadoPor: actor || 'Desconocido',
                lastOperationId: operationId,
                lastOperationType: 'editar_gasto'
            }
        }]
    });

    return {
        expenseId,
        alreadyApplied: queued.alreadyQueued,
        queued: true,
        persisted: queued.persisted
    };
}

export function saveExpenseTransaction({
    expenseId,
    operationId,
    expense
}) {
    if (!expenseId || !operationId) {
        throw new SalesIntegrityError(
            'missing-operation-id',
            'No se pudo generar un identificador seguro para el gasto.'
        );
    }

    const amount = roundMoney(expense?.monto);
    const description = String(expense?.descripcion || '').trim();
    const date = String(expense?.fechaStr || '').trim();
    const localId = String(expense?.localId || 'general').trim() || 'general';
    if (!description || amount <= 0 || !date) {
        throw new SalesIntegrityError(
            'invalid-expense',
            'Completa una descripción, fecha y monto válido para el gasto.'
        );
    }

    const ownerId = getQueueOwnerId();
    const optimisticExpense = {
        ...expense,
        id: expenseId,
        monto: amount,
        fechaStr: date,
        localId,
        fechaHora: Number(expense.fechaHora) || getTrustedNowMs(),
        revision: 1,
        lastOperationId: operationId,
        lastOperationType: 'crear_gasto'
    };
    const queued = enqueueSyncOperation({
        id: operationId,
        type: 'expense.save',
        ownerId,
        localId,
        entityKey: `gastos/${expenseId}`,
        payload: {
            expenseId,
            operationId,
            expense: optimisticExpense
        },
        optimisticMutations: [{
            collection: 'gastos',
            documentId: expenseId,
            kind: 'merge',
            data: optimisticExpense
        }]
    });

    return {
        expenseId,
        alreadyApplied: queued.alreadyQueued,
        queued: true,
        persisted: queued.persisted
    };
}

export function deleteExpenseTransaction({ expenseId, operationId }) {
    if (!expenseId || !operationId) {
        throw new SalesIntegrityError(
            'missing-operation-id',
            'No se pudo identificar el gasto que deseas eliminar.'
        );
    }

    const ownerId = getQueueOwnerId();
    const queued = enqueueSyncOperation({
        id: operationId,
        type: 'expense.delete',
        ownerId,
        entityKey: `gastos/${expenseId}`,
        payload: { expenseId, operationId },
        optimisticMutations: [{
            collection: 'gastos',
            documentId: expenseId,
            kind: 'delete'
        }]
    });

    return {
        expenseId,
        alreadyApplied: queued.alreadyQueued,
        queued: true,
        persisted: queued.persisted
    };
}

registerSyncHandler('sale.save', async (payload, operation) => {
    assertOperationOwner(operation);
    return syncCommittedPublicAvailability(
        await commitSaleTransaction(payload)
    );
});
registerSyncHandler('sale.transition', async (payload, operation) => {
    assertOperationOwner(operation);
    return syncCommittedPublicAvailability(
        await commitSaleStateTransition(payload)
    );
});
registerSyncHandler('sale.release-edit', async (payload, operation) => {
    assertOperationOwner(operation);
    return releaseSaleEditLock(payload);
});
registerSyncHandler('sale.update-amount', async (payload, operation) => {
    assertOperationOwner(operation);
    return commitSaleAmountUpdate(payload);
});
registerSyncHandler('expense.update-amount', async (payload, operation) => {
    assertOperationOwner(operation);
    return commitExpenseAmountUpdate(payload);
});
registerSyncHandler('expense.save', async (payload, operation) => {
    assertOperationOwner(operation);
    return commitExpenseTransaction(payload);
});
registerSyncHandler('expense.delete', async (payload, operation) => {
    assertOperationOwner(operation);
    return commitExpenseDeletion(payload);
});
