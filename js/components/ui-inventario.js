import { db, collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, increment, onSnapshot, query, where, writeBatch } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; 
import { formatMoney, getTodayDateStr, getTrustedNowMs } from '../utils/helpers.js';
import {
    applyProductosVentaChanges,
    renderProductosVenta
} from './ui-ventas.js';
import { persistProductsCache } from '../core/local-cache.js';

let listaInventarioEl; 
let categoriaActual = 'vaso';
let unsubscribeInventario = [];
let inventarioInicializado = false;
let inventoryLoadToken = 0;
let cancelInventoryLoad = null;
let inventoryRenderFrame = null;
let pendingCatalogFullRender = false;
let pendingCatalogChangeIds = new Set();
let inventoryRenderPending = true;
let inventoryViewObserver = null;

// Estado temporal para construir los tamaños en el modal
let tamanosActuales = [];

function isViewVisible(viewName) {
    const view = document.getElementById(`view-${viewName}`);
    return Boolean(view && !view.classList.contains('hidden'));
}

function catalogsHaveSameData(previousRows, nextRows) {
    if (previousRows.length !== nextRows.length) return false;
    const previousById = new Map(
        previousRows.map(product => [product.id, product])
    );
    return nextRows.every(product => {
        const previous = previousById.get(product.id);
        return previous && JSON.stringify(previous) === JSON.stringify(product);
    });
}

function installInventoryVisibilityObserver() {
    if (inventoryViewObserver) return;
    const view = document.getElementById('view-inventario');
    if (!view) return;

    inventoryViewObserver = new MutationObserver(() => {
        if (isViewVisible('inventario') && inventoryRenderPending) {
            renderInventarioUI(categoriaActual);
        }
    });
    inventoryViewObserver.observe(view, {
        attributes: true,
        attributeFilter: ['class']
    });
}

function queueCatalogUiUpdate({ full = false, changedIds = [] } = {}) {
    if (full) pendingCatalogFullRender = true;
    changedIds.forEach(id => pendingCatalogChangeIds.add(id));
    if (inventoryRenderFrame !== null) return;

    inventoryRenderFrame = requestAnimationFrame(() => {
        inventoryRenderFrame = null;
        const renderFull = pendingCatalogFullRender;
        const ids = Array.from(pendingCatalogChangeIds);
        pendingCatalogFullRender = false;
        pendingCatalogChangeIds.clear();

        if (renderFull) {
            renderInventarioUI(categoriaActual);
            renderProductosVenta();
            return;
        }

        applyInventoryChanges(ids);
        applyProductosVentaChanges(ids);
    });
}

export async function initInventario() {
    // Prevenir duplicación de eventos al rotar turnos
    if (inventarioInicializado) {
        await window.cargarInventarioDesdeFirebase?.();
        return;
    }
    inventarioInicializado = true;

    listaInventarioEl = document.getElementById('inventario-list');
    installInventoryVisibilityObserver();
    
    // Eventos Inventario Normal
    document.getElementById('form-insumo')?.addEventListener('submit', guardarProducto);
    document.getElementById('btn-nuevo-producto')?.addEventListener('click', abrirModalProducto);
    document.getElementById('btn-cerrar-modal-producto')?.addEventListener('click', () => {
        const m = document.getElementById('modal-producto'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300);
    });
    
    // Eventos Nuevos: Gestión dinámica de tamaños
    document.getElementById('btn-add-tamano')?.addEventListener('click', () => {
        tamanosActuales.push({ nombre: 'Tamaño ' + (tamanosActuales.length + 1), precio: 0 });
        renderTamanosBuilder();
    });
    
    // Tabs de Categorías (Adaptado para 5 categorías: Vasos, Sabores, Extras, Toppings, Insumos)
    const tabs = document.querySelectorAll('#tabs-insumos > div > button');
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => {
                t.classList.remove('text-sky-400', 'text-amber-500', 'border-sky-400', 'border-amber-500', 'border-b-2');
                if(!t.classList.contains('text-slate-500')) t.classList.add('text-slate-500');
            });
            
            const cats = ['vaso', 'sabor', 'extra', 'topping', 'insumo'];
            categoriaActual = cats[index] || 'vaso';
            
            // Estilo visual: Insumos resalta en ámbar, el resto en sky
            const colorClass = categoriaActual === 'insumo' ? 'amber' : 'sky';
            tab.classList.remove('text-slate-500');
            tab.classList.add(`text-${colorClass}-400`, `border-${colorClass}-400`, 'border-b-2');
            
            renderInventarioUI(categoriaActual);
        });
    });

    // --- Eventos Ingreso de Mercadería (Stock) ---
    document.getElementById('btn-ingreso-stock')?.addEventListener('click', abrirModalIngresoStock);
    document.getElementById('btn-cerrar-modal-ingreso')?.addEventListener('click', () => {
        const m = document.getElementById('modal-ingreso-stock'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300);
    });
    document.getElementById('form-ingreso-stock')?.addEventListener('submit', procesarIngresoStock);

    // Funciones globales expuestas
    window.cargarInventarioDesdeFirebase = () => {
        return new Promise((resolve, reject) => {
            cancelInventoryLoad?.();
            const loadToken = ++inventoryLoadToken;
            state.inventoryFresh = false;
            unsubscribeInventario.forEach(unsubscribe => unsubscribe());
            unsubscribeInventario = [];
            let finished = false;
            const finish = (error = null) => {
                if (finished) return;
                finished = true;
                if (cancelInventoryLoad === cancel) cancelInventoryLoad = null;
                if (error) reject(error);
                else resolve();
            };
            const cancel = () => finish();
            cancelInventoryLoad = cancel;

            try {
                const role = String(state.userRole || '').toLowerCase();
                const isAdmin = ['admin', 'administrador', 'master'].includes(role);
                const localId = state.userLocalId || '';
                const scopedLocalIds = Array.from(new Set(['global', localId]))
                    .filter(Boolean);
                const refs = (isAdmin || !localId)
                    ? [collection(db, 'productos')]
                    : [
                        query(
                            collection(db, 'productos'),
                            scopedLocalIds.length === 1
                                ? where('localId', '==', scopedLocalIds[0])
                                : where('localId', 'in', scopedLocalIds)
                        )
                    ];
                const includeLegacyProducts = !isAdmin && Boolean(localId);
                // Cada consulta conserva su propio mapa. Firestore entrega la carga
                // inicial como cambios "added" y, desde allí, solo aplicamos los
                // documentos que realmente cambiaron. El listener legacy se
                // mantiene intacto para no exigir una migración de datos.
                const buckets = new Map();
                const initialSources = new Set();
                const freshSources = new Set();
                const expectedInitialSources = refs.length + (includeLegacyProducts ? 1 : 0);
                const mergedProducts = new Map(
                    state.productos.map(product => [product.id, product])
                );
                let settled = false;
                let initialCatalogPublished = false;

                const publishFullCatalog = () => {
                    if (loadToken !== inventoryLoadToken) return;
                    const previousProducts = state.productos;
                    mergedProducts.clear();
                    buckets.forEach(products => {
                        products.forEach((product, id) => {
                            mergedProducts.set(id, product);
                        });
                    });
                    const nextProducts = Array.from(mergedProducts.values());
                    const catalogChanged = !catalogsHaveSameData(
                        previousProducts,
                        nextProducts
                    );
                    state.productos = nextProducts;
                    persistProductsCache(state.productos);
                    if (catalogChanged) queueCatalogUiUpdate({ full: true });
                };

                const publishCatalogChanges = changedIds => {
                    if (
                        loadToken !== inventoryLoadToken
                        || !initialCatalogPublished
                        || changedIds.size === 0
                    ) return;

                    changedIds.forEach(id => {
                        let product = null;
                        buckets.forEach(products => {
                            if (products.has(id)) product = products.get(id);
                        });
                        if (product) mergedProducts.set(id, product);
                        else mergedProducts.delete(id);
                    });

                    state.productos = Array.from(mergedProducts.values());
                    persistProductsCache(state.productos);
                    queueCatalogUiUpdate({ changedIds });
                };

                const updateFreshState = () => {
                    if (loadToken !== inventoryLoadToken) return;
                    const isFresh = freshSources.size === expectedInitialSources;
                    if (state.inventoryFresh === isFresh) return;
                    state.inventoryFresh = isFresh;
                    window.dispatchEvent(new CustomEvent('icepos:inventory-freshness', {
                        detail: { fresh: isFresh }
                    }));
                };

                const markInitialSource = (source, isFresh) => {
                    if (loadToken !== inventoryLoadToken) return false;
                    initialSources.add(source);
                    if (isFresh) freshSources.add(source);
                    else freshSources.delete(source);
                    updateFreshState();
                    if (!settled && initialSources.size === expectedInitialSources) {
                        settled = true;
                        finish();
                    }
                    const allInitialSourcesReady =
                        initialSources.size === expectedInitialSources;
                    if (allInitialSourcesReady && !initialCatalogPublished) {
                        initialCatalogPublished = true;
                        publishFullCatalog();
                    }
                    return allInitialSourcesReady;
                };

                refs.forEach((ref, index) => {
                    const sourceKey = `listener:${index}`;
                    buckets.set(sourceKey, new Map());
                    const unsubscribe = onSnapshot(ref, {
                        includeMetadataChanges: true
                    }, snapshot => {
                        if (loadToken !== inventoryLoadToken) return;
                        const sourceProducts = buckets.get(sourceKey);
                        const changedIds = new Set();
                        snapshot.docChanges().forEach(change => {
                            const id = change.doc.id;
                            changedIds.add(id);
                            if (change.type === 'removed') {
                                sourceProducts.delete(id);
                            } else {
                                sourceProducts.set(id, {
                                    id,
                                    ...change.doc.data()
                                });
                            }
                        });
                        const catalogWasPublished = initialCatalogPublished;
                        markInitialSource(
                            sourceKey,
                            snapshot.metadata.fromCache === false
                            && snapshot.metadata.hasPendingWrites === false
                        );
                        if (catalogWasPublished) {
                            publishCatalogChanges(changedIds);
                        }
                    }, error => {
                        if (loadToken !== inventoryLoadToken) return;
                        console.error("Error escuchando inventario:", error);
                        freshSources.delete(sourceKey);
                        updateFreshState();
                        if (!settled) {
                            settled = true;
                            finish(error);
                        }
                    });
                    unsubscribeInventario.push(unsubscribe);
                });

                if (includeLegacyProducts) {
                    const sourceKey = 'legacy';
                    buckets.set(sourceKey, new Map());
                    const unsubscribeLegacy = onSnapshot(collection(db, 'productos'), {
                        includeMetadataChanges: true
                    }, snapshot => {
                        if (loadToken !== inventoryLoadToken) return;
                        const sourceProducts = buckets.get(sourceKey);
                        const changedIds = new Set();
                        snapshot.docChanges().forEach(change => {
                            const id = change.doc.id;
                            const wasLegacyProduct = sourceProducts.has(id);
                            const product = {
                                id,
                                ...change.doc.data()
                            };
                            const belongsToLegacySource =
                                change.type !== 'removed' && !product.localId;

                            if (belongsToLegacySource) {
                                sourceProducts.set(id, product);
                                changedIds.add(id);
                            } else if (wasLegacyProduct) {
                                sourceProducts.delete(id);
                                changedIds.add(id);
                            }
                        });
                        const catalogWasPublished = initialCatalogPublished;
                        markInitialSource(
                            sourceKey,
                            snapshot.metadata.fromCache === false
                            && snapshot.metadata.hasPendingWrites === false
                        );
                        if (catalogWasPublished) {
                            publishCatalogChanges(changedIds);
                        }
                    }, error => {
                        if (loadToken !== inventoryLoadToken) return;
                        console.warn('No se pudieron recuperar productos antiguos sin sede:', error);
                        markInitialSource(sourceKey, false);
                    });
                    unsubscribeInventario.push(unsubscribeLegacy);
                }
            } catch(e) { 
                console.error("Error configurando inventario:", e); 
                finish(e);
            }
        });
    };
    
    window.editarProducto = editarProductoFn;
    window.eliminarProducto = eliminarProductoFn;
    window.updateTamano = (idx, field, val) => {
        if (field === 'precio') tamanosActuales[idx][field] = parseFloat(val) || 0;
        else tamanosActuales[idx][field] = val;
    };
    window.removeTamano = (idx) => {
        tamanosActuales.splice(idx, 1);
        renderTamanosBuilder();
    };

    await window.cargarInventarioDesdeFirebase();
}

export function destroyInventario() {
    inventoryLoadToken++;
    state.inventoryFresh = false;
    inventoryRenderPending = true;
    pendingCatalogFullRender = false;
    pendingCatalogChangeIds.clear();
    if (inventoryRenderFrame !== null) {
        cancelAnimationFrame(inventoryRenderFrame);
        inventoryRenderFrame = null;
    }
    cancelInventoryLoad?.();
    cancelInventoryLoad = null;
    unsubscribeInventario.forEach(unsubscribe => unsubscribe());
    unsubscribeInventario = [];
}

// ========================================================
// RENDERIZADOR DINÁMICO DE TAMAÑOS (UI)
// ========================================================
function renderTamanosBuilder() {
    const container = document.getElementById('lista-tamanos');
    if (!container) return;
    
    if (tamanosActuales.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-500 italic text-center p-2">Sin precios. Agrega un tamaño.</p>`;
        return;
    }
    
    container.innerHTML = tamanosActuales.map((t, idx) => `
        <div class="flex items-center gap-2 w-full animate-fade-in">
            <input type="text" value="${t.nombre}" onchange="window.updateTamano(${idx}, 'nombre', this.value)" class="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-white focus:border-sky-500 outline-none" placeholder="Ej. Mediano (12oz)" required>
            <div class="relative w-24">
                <span class="absolute left-2 top-1/2 transform -translate-y-1/2 text-slate-500 text-xs">S/</span>
                <input type="number" step="0.1" min="0" value="${t.precio}" onchange="window.updateTamano(${idx}, 'precio', this.value)" class="w-full bg-slate-900 border border-slate-700 rounded pl-6 pr-2 py-1.5 text-xs text-white text-right focus:border-sky-500 outline-none" placeholder="0.00" required>
            </div>
            <button type="button" onclick="window.removeTamano(${idx})" class="text-red-400 hover:text-white hover:bg-red-500/20 p-1.5 bg-slate-900 border border-slate-700 rounded transition-colors" title="Eliminar Tamaño"><i data-lucide="trash" class="w-4 h-4"></i></button>
        </div>
    `).join('');
    if(window.lucide) window.lucide.createIcons({ root: container });
}


// ========================================================
// LÓGICA DE INGRESO DE STOCK (COMPRAS)
// ========================================================

function abrirModalIngresoStock() {
    const m = document.getElementById('modal-ingreso-stock');
    if (!m) return;
    
    document.getElementById('form-ingreso-stock').reset();
    
    const selProd = document.getElementById('ingreso-producto');
    const selLocal = document.getElementById('ingreso-local');
    
    let prodOpts = '<option value="" disabled selected>Selecciona un producto...</option>';
    const productosValidos = state.productos.filter(p => {
        if (p.stock === null || p.stock === undefined) return false;
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
    });
    
    productosValidos.forEach(p => {
        const sede = p.localId && p.localId !== 'global' ? `(${state.locales.find(l=>l.id===p.localId)?.nombre || 'Local'})` : '(Global)';
        prodOpts += `<option value="${p.id}">${p.nombre} - Stock actual: ${p.stock} ${sede}</option>`;
    });
    selProd.innerHTML = prodOpts || '<option value="" disabled>No hay productos que administren stock</option>';
    
    if (selLocal) {
        if (state.userRole === 'admin' || state.userRole === 'master') {
            let locOpts = '<option value="ambas">Dividir Gasto en Todas las Sedes</option>';
            state.locales.forEach(l => locOpts += `<option value="${l.id}">Caja: ${l.nombre}</option>`);
            selLocal.innerHTML = locOpts;
            selLocal.parentElement.classList.remove('hidden');
        } else {
            selLocal.innerHTML = `<option value="${state.userLocalId || ''}">${state.userLocal || 'Mi Local'}</option>`;
            selLocal.parentElement.classList.add('hidden'); 
        }
    }

    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
}

async function procesarIngresoStock(e) {
    e.preventDefault();
    const btn = document.querySelector('#form-ingreso-stock button[type="submit"]');
    const oT = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline mr-2"></i> Procesando...';
    btn.disabled = true;
    if(window.lucide) window.lucide.createIcons({ root: btn });

    const prodId = document.getElementById('ingreso-producto').value;
    const cant = parseInt(document.getElementById('ingreso-cantidad').value);
    const costo = parseFloat(document.getElementById('ingreso-costo').value);

    if (!prodId || isNaN(cant) || cant <= 0 || isNaN(costo) || costo < 0) {
        if(window.mostrarToast) window.mostrarToast('Error', 'Verifica los datos ingresados.', 'amber');
        btn.innerHTML = oT; btn.disabled = false;
        return;
    }

    try {
        const prod = state.productos.find(p => p.id === prodId);
        if (!prod) {
            throw new Error('El producto ya no está disponible.');
        }

        const batch = writeBatch(db);
        batch.update(doc(db, 'productos', prodId), { stock: increment(cant) });
        
        if (costo > 0) {
            let selectedLocal = document.getElementById('ingreso-local')?.value || '';
            let allocations = [];

            if (state.userRole !== 'master' && state.userRole !== 'admin') {
                allocations = [{
                    id: state.userLocalId || 'general',
                    nombre: state.userLocal || 'Mi Local'
                }];
            } else if (selectedLocal === 'ambas') {
                allocations = state.locales.length > 0
                    ? state.locales.map(local => ({ id: local.id, nombre: local.nombre }))
                    : [{ id: 'general', nombre: 'General' }];
            } else {
                const local = state.locales.find(item => item.id === selectedLocal);
                allocations = [{
                    id: selectedLocal || 'general',
                    nombre: local?.nombre || 'General'
                }];
            }

            const totalCents = Math.round(costo * 100);
            const baseCents = Math.floor(totalCents / allocations.length);
            const remainder = totalCents % allocations.length;
            const date = getTodayDateStr();

            allocations.forEach((allocation, index) => {
                const amount = (baseCents + (index < remainder ? 1 : 0)) / 100;
                const expenseRef = doc(collection(db, 'gastos'));
                batch.set(expenseRef, {
                    monto: amount,
                    descripcion: `Stock: Ingreso de ${cant}x ${prod.nombre}`,
                    fechaStr: date,
                    fechaHora: getTrustedNowMs(),
                    timestamp: serverTimestamp(),
                    localId: allocation.id,
                    localNombre: allocation.nombre,
                    registradoPor: state.currentUser?.email || '',
                    tipo: 'compra_stock'
                });
                batch.set(doc(db, 'caja_diaria', `${date}_${allocation.id}`), {
                    localId: allocation.id,
                    localNombre: allocation.nombre,
                    fechaStr: date,
                    total_gastos: increment(amount)
                }, { merge: true });
            });
        }

        await batch.commit();

        prod.stock += cant;
        queueCatalogUiUpdate({ changedIds: [prod.id] });

        const m = document.getElementById('modal-ingreso-stock'); 
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300);
        window.mostrarToast?.('Ingreso Exitoso', `+${cant} a ${prod.nombre}.`, 'emerald');
        
    } catch(err) {
        console.error("Error al procesar ingreso:", err);
        window.mostrarAlerta?.(
            'Ingreso no registrado',
            err?.message || 'No se pudo confirmar el stock y el gasto.',
            'red'
        );
    } finally {
        btn.innerHTML = oT; 
        btn.disabled = false;
    }
}

// ========================================================
// LÓGICA DEL INVENTARIO NORMAL
// ========================================================

function abrirModalProducto() {
    document.getElementById('form-insumo').reset(); 
    document.getElementById('prod-id').value = '';
    
    // Configuración base de Tamaños (1 por defecto)
    tamanosActuales = [{ nombre: 'Único / Estándar', precio: 0 }];
    renderTamanosBuilder();
    
    const selLocal = document.getElementById('prod-local');
    if (selLocal && state.locales) {
        let opts = '<option value="global">Disponible en Todas (Global)</option>';
        state.locales.forEach(l => opts += `<option value="${l.id}">${l.nombre}</option>`);
        selLocal.innerHTML = opts;
        
        if (state.userRole === 'vendedor') {
            selLocal.value = state.userLocalId || 'global';
            selLocal.disabled = true;
            selLocal.parentElement.classList.add('hidden'); 
        } else {
            selLocal.disabled = false;
            selLocal.parentElement.classList.remove('hidden');
        }
    }

    const cC = document.getElementById('div-campos-costos'); 
    const cL = document.getElementById('div-limite-sabores');
    
    // Mostramos costos para todos
    if (cC) cC.classList.remove('hidden');
    
    // Limite de sabores solo para Vasos
    if (categoriaActual === 'vaso') { 
        if (cL) cL.classList.remove('hidden'); 
    } else { 
        if (cL) cL.classList.add('hidden'); 
        document.getElementById('prod-limite').value = 0; 
    }
    
    const m = document.getElementById('modal-producto'); 
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
}

function editarProductoFn(id) {
    const p = state.productos.find(x => x.id === id); if(!p) return;
    abrirModalProducto();
    
    document.getElementById('prod-id').value = p.id;
    document.getElementById('prod-nombre').value = p.nombre;
    document.getElementById('prod-costo').value = p.costo || 0;
    document.getElementById('prod-stock').value = p.stock !== null && p.stock !== undefined ? p.stock : '';
    document.getElementById('prod-local').value = p.localId || 'global';
    if (p.categoria === 'vaso') document.getElementById('prod-limite').value = p.limite_sabores || 0;
    
    // Cargar tamaños múltiples (o adaptar compatibilidad antigua)
    if (p.tamanos && p.tamanos.length > 0) {
        tamanosActuales = JSON.parse(JSON.stringify(p.tamanos));
    } else {
        tamanosActuales = [{ nombre: 'Único / Estándar', precio: p.precio || 0 }];
    }
    renderTamanosBuilder();
}

function getInventoryItems(cat) {
    return state.productos.filter(p => {
        if (p.categoria !== cat) return false;
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
    });
}

function getInventoryEmptyRowHtml() {
    return '<tr data-empty-state="true"><td colspan="5" class="p-8 text-center text-slate-500 text-sm">No hay ítems registrados en esta categoría.</td></tr>';
}

function createInventoryRow(p) {
    const stkStr = p.stock !== null && p.stock !== '' && p.stock !== undefined
        ? `<span class="font-mono text-emerald-500 font-bold">${p.stock}</span>`
        : '<i data-lucide="infinity" class="w-4 h-4 mx-auto text-slate-500"></i>';

    let badgeLocal = '';
    if (p.localId && p.localId !== 'global') {
        const nLoc = state.locales.find(l => l.id === p.localId)?.nombre || 'Sede';
        badgeLocal = `<span class="ml-2 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 text-[9px] px-1.5 py-0.5 rounded uppercase border border-slate-200 dark:border-slate-600">${nLoc}</span>`;
    } else if (state.userRole === 'master' || state.userRole === 'admin') {
        badgeLocal = '<span class="ml-2 bg-sky-50 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 border border-sky-200 dark:border-sky-500/30 text-[9px] px-1.5 py-0.5 rounded uppercase">Global</span>';
    }

    let priceStr = '-';
    if (p.categoria !== 'sabor') {
        if (p.tamanos && p.tamanos.length > 1) {
            const precios = p.tamanos.map(t => t.precio);
            const min = Math.min(...precios);
            const max = Math.max(...precios);
            priceStr = min === max
                ? formatMoney(min)
                : `<span class="text-xs text-slate-400">Desde</span> ${formatMoney(min)}`;
        } else if (p.tamanos && p.tamanos.length === 1) {
            priceStr = formatMoney(p.tamanos[0].precio);
        } else {
            priceStr = formatMoney(p.precio || 0);
        }
    }

    const vHist = p.ventasTotales || 0;
    const ventasHtml = vHist > 0
        ? `<div class="flex items-center justify-center text-emerald-500 font-bold text-xs"><i data-lucide="trending-up" class="w-3 h-3 mr-1"></i> ${vHist}</div>`
        : '<div class="text-slate-500 text-xs text-center">-</div>';

    const tr = document.createElement('tr');
    tr.dataset.productId = p.id;
    tr.className = 'hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group border-b border-slate-200 dark:border-slate-700/50 last:border-0';
    tr.innerHTML = `
        <td data-label="Producto" class="p-3 text-sm text-slate-800 dark:text-white font-bold">${p.nombre} ${badgeLocal}</td>
        <td data-label="Ventas" class="p-3 text-center">${ventasHtml}</td>
        <td data-label="Precio" class="p-3 text-sm text-sky-600 dark:text-sky-500 font-bold text-right">${priceStr}</td>
        <td data-label="Stock" class="p-3 text-center">${stkStr}</td>
        <td data-label="Acciones" class="p-3 text-center">
            <div class="flex justify-center gap-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                <button onclick="window.editarProducto('${p.id}')" class="min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-sky-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-sky-300 dark:hover:border-sky-500/50 p-1.5 rounded-lg transition-colors" aria-label="Editar producto"><i data-lucide="edit-2" class="w-4 h-4"></i></button>
                <button onclick="window.eliminarProducto('${p.id}')" class="min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-red-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-500/50 p-1.5 rounded-lg transition-colors" aria-label="Eliminar producto"><i data-lucide="trash" class="w-4 h-4"></i></button>
            </div>
        </td>`;
    return tr;
}

function applyInventoryChanges(changedIds) {
    if (!listaInventarioEl || changedIds.length === 0) return;
    if (!isViewVisible('inventario')) {
        inventoryRenderPending = true;
        return;
    }

    const visibleProducts = new Map(
        getInventoryItems(categoriaActual).map(product => [product.id, product])
    );
    const existingRows = new Map(
        Array.from(listaInventarioEl.querySelectorAll('tr[data-product-id]'))
            .map(row => [row.dataset.productId, row])
    );
    const iconRoots = [];

    changedIds.forEach(id => {
        const currentRow = existingRows.get(id);
        const product = visibleProducts.get(id);
        if (!product) {
            currentRow?.remove();
            return;
        }

        const nextRow = createInventoryRow(product);
        if (currentRow) currentRow.replaceWith(nextRow);
        else listaInventarioEl.appendChild(nextRow);
        iconRoots.push(nextRow);
    });

    const productRows = listaInventarioEl.querySelectorAll('tr[data-product-id]');
    const emptyRow = listaInventarioEl.querySelector('tr[data-empty-state]');
    if (productRows.length === 0) {
        listaInventarioEl.innerHTML = getInventoryEmptyRowHtml();
    } else {
        emptyRow?.remove();
    }

    iconRoots.forEach(root => window.lucide?.createIcons({ root }));
    inventoryRenderPending = false;
}

export function renderInventarioUI(cat) {
    if (!listaInventarioEl) return;
    if (!isViewVisible('inventario')) {
        inventoryRenderPending = true;
        return;
    }

    const items = getInventoryItems(cat);
    if (items.length === 0) {
        listaInventarioEl.innerHTML = getInventoryEmptyRowHtml();
        inventoryRenderPending = false;
        return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(product => fragment.appendChild(createInventoryRow(product)));
    listaInventarioEl.replaceChildren(fragment);
    window.lucide?.createIcons({ root: listaInventarioEl });
    inventoryRenderPending = false;
}

async function guardarProducto(e) {
    e.preventDefault(); 
    
    // Validar tamaños
    if (tamanosActuales.length === 0) {
        if(window.mostrarToast) window.mostrarToast('Error', 'Debes añadir al menos un tamaño y precio.', 'amber');
        return;
    }

    const id = document.getElementById('prod-id').value;
    let selectedLocal = document.getElementById('prod-local').value;
    if (state.userRole === 'vendedor') selectedLocal = state.userLocalId || 'global';

    // Recuperar ventasTotales actuales para no borrarlas al guardar
    let ventasTotalesGuardadas = 0;
    if (id) {
        const prodExistente = state.productos.find(x => x.id === id);
        if (prodExistente) ventasTotalesGuardadas = prodExistente.ventasTotales || 0;
    }

    const prodData = {
        nombre: document.getElementById('prod-nombre').value.trim(),
        categoria: categoriaActual,
        tamanos: tamanosActuales,
        precio: tamanosActuales[0].precio || 0, // Fallback por compatibilidad
        costo: parseFloat(document.getElementById('prod-costo').value) || 0,
        limite_sabores: parseInt(document.getElementById('prod-limite').value) || 0,
        stock: document.getElementById('prod-stock').value !== '' ? parseInt(document.getElementById('prod-stock').value) : null,
        localId: selectedLocal,
        ventasTotales: ventasTotalesGuardadas // Mantiene el récord intacto
    };

    const btn = document.getElementById('btn-guardar-prod'); 
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline mr-1"></i> Guardando...'; 
    btn.disabled = true;
    if(window.lucide) window.lucide.createIcons({ root: btn });

    try {
        if(id) { 
            await updateDoc(doc(db, "productos", id), prodData);
        } else { 
            await addDoc(collection(db, "productos"), prodData);
        }
        
        document.getElementById('modal-producto').classList.add('hidden');
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Catálogo actualizado.', 'emerald');
    } catch(e) {
        console.error(e);
        await window.cargarInventarioDesdeFirebase?.().catch(() => {});
        if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo guardar el producto en la nube.", "red");
    } finally {
        btn.innerHTML = originalText; 
        btn.disabled = false;
    }
}

function eliminarProductoFn(id) {
    if(window.mostrarConfirmacion) {
        window.mostrarConfirmacion("¿Eliminar definitivamente este ítem del catálogo?", () => {
            // LÓGICA OPTIMISTA
            try {
                state.productos = state.productos.filter(p => p.id !== id);
                queueCatalogUiUpdate({ changedIds: [id] });
                
                deleteDoc(doc(db, "productos", id)).catch(e => {
                    console.error("Error al borrar en background:", e);
                    window.cargarInventarioDesdeFirebase(); 
                    if(window.mostrarToast) window.mostrarToast('Error', 'No se pudo eliminar en la nube.', 'red');
                });

                if(window.mostrarToast) window.mostrarToast('Eliminado', 'Producto borrado de la lista.', 'sky');
            } catch(e) {
                console.error(e);
            }
        });
    }
}
