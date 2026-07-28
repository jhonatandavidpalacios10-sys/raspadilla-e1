import { state } from '../core/store.js'; 
import {
    escaparHtml,
    getTodayDateStr,
    getTrustedNowMs,
    obtenerNombreCliente
} from '../utils/helpers.js';
import { subscribeDailySales } from '../core/data-service.js';
import {
    acquireSaleEditLock,
    buildLegacyInventoryMovements,
    createUuid,
    getSaleItemCartId,
    getSaleEditLockState,
    releaseSaleEditLock,
    transitionSaleTransaction
} from '../core/sales-service.js';
import {
    getVentasSessionGeneration,
    isSaleOperationInProgress
} from './ui-ventas.js';

let unsubscribePedidos = null;
let pedidosInicializado = false;
let pedidosGlobales = []; 
let filtroLocalPedidos = 'todas'; 
const operacionesPedidoEnCurso = new Set();
let lockRefreshTimer = null;
let editLockAcquisitionInProgress = false;
let pedidosLifecycleGeneration = 0;

function isAdminUser() {
    return ['admin', 'administrador', 'master'].includes(
        String(state.userRole || '').trim().toLowerCase()
    );
}

function handleFiltroPedidosChange(event) {
    filtroLocalPedidos = event.target.value;
    iniciarEscuchaPedidos();
}

function handlePedidosClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const id = button.dataset.id;
    const sale = pedidosGlobales.find(item => item.id === id);
    const editLock = getSaleEditLockState(sale);
    if (editLock.active) {
        if (window.mostrarToast) {
            window.mostrarToast(
                'Pedido en edición',
                `${editLock.ownerName} está modificando este pedido.`,
                'amber'
            );
        }
        return;
    }

    if (button.dataset.action === 'editar-pedido') editarPedido(id);
    else if (button.dataset.action === 'despachar-pedido') {
        actualizarEstadoPedido(id, 'listo');
    } else if (button.dataset.action === 'rechazar-pedido') {
        actualizarEstadoPedido(id, 'rechazado');
    }
}

export function initPedidos() { 
    if (pedidosInicializado) return;
    pedidosInicializado = true;
    pedidosLifecycleGeneration++;

    // Conectar el filtro desplegable
    const selectFiltro = document.getElementById('filtro-local-pedidos');
    if (selectFiltro) {
        selectFiltro.addEventListener('change', handleFiltroPedidosChange);
    }

    // Delegación de eventos para los botones de las tarjetas
    const listaPendientes = document.getElementById('pedidos-pendientes-list');
    if (listaPendientes) {
        listaPendientes.addEventListener('click', handlePedidosClick);
    }
    
    iniciarEscuchaPedidos(); 
}

function iniciarEscuchaPedidos() {
    if(unsubscribePedidos) unsubscribePedidos();
    const hoy = getTodayDateStr(); 

    unsubscribePedidos = subscribeDailySales(rows => {
        pedidosGlobales = rows;
        renderPedidosUI();
    }, (error) => {
        console.error('Error escuchando pedidos:', error);
    }, hoy, filtroLocalPedidos);
}

export function destroyPedidos() {
    pedidosLifecycleGeneration++;
    if (unsubscribePedidos) {
        unsubscribePedidos();
        unsubscribePedidos = null;
    }
    document.getElementById('filtro-local-pedidos')
        ?.removeEventListener('change', handleFiltroPedidosChange);
    document.getElementById('pedidos-pendientes-list')
        ?.removeEventListener('click', handlePedidosClick);

    pedidosGlobales = [];
    filtroLocalPedidos = 'todas';
    operacionesPedidoEnCurso.clear();
    if (lockRefreshTimer) {
        clearTimeout(lockRefreshTimer);
        lockRefreshTimer = null;
    }
    pedidosInicializado = false;
}

function scheduleLockRefresh() {
    if (lockRefreshTimer) clearTimeout(lockRefreshTimer);
    lockRefreshTimer = null;

    const now = getTrustedNowMs();
    const expirations = pedidosGlobales
        .map(sale => getSaleEditLockState(sale, now))
        .filter(lock => lock.active)
        .map(lock => lock.expiresAtMs);

    if (expirations.length === 0) return;
    const nextExpiration = Math.min(...expirations);
    lockRefreshTimer = setTimeout(() => {
        lockRefreshTimer = null;
        renderPedidosUI();
    }, Math.max(100, nextExpiration - now + 50));
}

function renderPedidosUI() {
    let pendientes = [], listos = [];
    
    pedidosGlobales.forEach(v => {
        const isAdmin = isAdminUser();
        const miSedeId = state.userLocalId || ''; 
        
        let mostrar = false;
        if (isAdmin) {
            if (filtroLocalPedidos === 'todas') {
                mostrar = true;
            } else if (filtroLocalPedidos === '') {
                mostrar = !v.localId || v.localId === '' || v.localId === 'general';
            } else {
                mostrar = v.localId === filtroLocalPedidos;
            }
        } else {
            mostrar = miSedeId
                ? v.localId === miSedeId
                : (!v.localId || v.localId === '' || v.localId === 'general');
        }

        if (mostrar) {
            if (v.estado === 'pendiente' || v.estado === 'editando') pendientes.push(v);
            else if (v.estado === 'listo') listos.push(v);
        }
    });

    // Ordenar: Los más antiguos primero
    const getTime = (v) => (
        v.fechaHora
        || (v.timestamp?.seconds ? v.timestamp.seconds * 1000 : getTrustedNowMs())
    );
    
    pendientes.sort((a,b) => getTime(a) - getTime(b));
    listos.sort((a,b) => getTime(b) - getTime(a));

    const contPendientes = document.getElementById('contador-pendientes');
    const contListos = document.getElementById('contador-listos');
    if (contPendientes) contPendientes.textContent = pendientes.length;
    if (contListos) contListos.textContent = listos.length;
    
    const lp = document.getElementById('pedidos-pendientes-list'); 
    if(lp) {
        lp.innerHTML = pendientes.map(v => generarHTMLPedido(v)).join('') || '<p class="text-xs text-slate-500 text-center py-4">No hay pedidos pendientes.</p>';
    }
    
    const ll = document.getElementById('pedidos-listos-list'); 
    if(ll) {
        ll.innerHTML = listos.map(v => generarHTMLPedido(v, true)).join('') || '<p class="text-xs text-slate-500 text-center py-4">No hay pedidos despachados.</p>';
    }
    
    const pedidosView = document.getElementById('view-pedidos');
    if (window.lucide && pedidosView) {
        window.lucide.createIcons({ root: pedidosView });
    }
    scheduleLockRefresh();
}

function generarHTMLPedido(v, esListo = false) {
    const editLock = getSaleEditLockState(v);
    const isLocked = editLock.active;
    const isRecoverable = editLock.stale;
    let iHtml = '';
    (Array.isArray(v.items) ? v.items : []).forEach(i => { 
        // 1. Mostrar Tamaño
        let tamanoHtml = '';
        if (i.tamano && i.tamano !== 'Estándar' && i.tamano !== 'Único / Estándar' && i.productoId !== 'AJUSTE') {
            tamanoHtml = `<div class="text-[10px] text-emerald-400 font-bold ml-4 leading-tight mt-0.5"><span class="text-slate-500">Tam:</span> ${i.tamano}</div>`;
        }

        // 2. Mostrar Sabores
        let saboresHtml = '';
        if (i.sabores && i.sabores.length > 0) {
            const listaSabores = Array.isArray(i.sabores) ? i.sabores.join(', ') : i.sabores;
            saboresHtml = `<div class="text-[10px] text-sky-400 font-bold ml-4 leading-tight mt-0.5"><span class="text-slate-500">Sab:</span> ${listaSabores}</div>`;
        }

        // 3. Mostrar Toppings
        let toppingsHtml = '';
        if (i.toppings && i.toppings.length > 0) {
            const listaToppings = i.toppings.map(t => t.nombre).join(', ');
            toppingsHtml = `<div class="text-[10px] text-amber-400 font-bold ml-4 leading-tight mt-0.5"><span class="text-slate-500">Top:</span> ${listaToppings}</div>`;
        }

        iHtml += `
            <div class="mb-2 border-b border-slate-700/40 pb-2 last:border-0 last:pb-0">
                <div class="flex justify-between items-start text-xs">
                    <p class="text-white leading-tight pr-2 font-medium"><span class="text-emerald-400 font-bold text-sm mr-1">${i.cantidad}x</span> ${i.nombre}</p>
                </div>
                ${tamanoHtml}
                ${saboresHtml}
                ${toppingsHtml}
            </div>`; 
    });
    
    // La hora visible siempre se presenta en Lima. El timestamp del servidor
    // prevalece; fechaHora mantiene compatibilidad con tickets antiguos.
    const timestampMs = typeof v.timestamp?.toMillis === 'function'
        ? v.timestamp.toMillis()
        : Number.isFinite(Number(v.timestamp?.seconds))
            ? Number(v.timestamp.seconds) * 1000
            : Number(v.fechaHora);
    const tVal = new Date(Number.isFinite(timestampMs) ? timestampMs : getTrustedNowMs());
    const time = tVal.toLocaleTimeString('es-PE', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Lima'
    });
    
    const num = String(v.id || '').replace(/^T-/, '').slice(0, 8).toUpperCase() || '---';
    const editBdge = v.editado ? `<span class="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[9px] px-1 rounded uppercase font-bold ml-2 animate-pulse">Modificado</span>` : '';
    const lockBadge = (isLocked || isRecoverable) ? `
        <div class="mt-2 rounded-lg border border-orange-400/50 bg-orange-500/15 px-2.5 py-2 text-orange-300">
            <div class="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider">
                <i data-lucide="${isLocked ? 'lock-keyhole' : 'clock-alert'}" class="w-3.5 h-3.5"></i>
                ${isLocked ? 'Editando pedido' : 'Edición expirada'}
            </div>
            <p class="mt-0.5 text-[10px] text-orange-200/80 truncate">
                ${isLocked
                    ? `Bloqueado por ${escaparHtml(editLock.ownerName)}`
                    : 'Pulsa editar para recuperar el pedido'}
            </p>
        </div>` : '';
    
    // --- NUEVO: Etiqueta Visual del Método de Pago ---
    const metodoPago = (v.metodoPago || v.metodo_pago || 'efectivo').toLowerCase();
    let badgePago = '';
    
    if (metodoPago.includes('yape') || metodoPago.includes('plin')) {
        badgePago = `<div class="flex items-center gap-1 bg-purple-500/10 text-purple-400 border border-purple-500/30 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider" title="Yape / Plin"><i data-lucide="smartphone" class="w-3 h-3"></i> Yape</div>`;
    } else if (metodoPago === 'mixto') {
        badgePago = `<div class="flex items-center gap-1 bg-sky-500/10 text-sky-400 border border-sky-500/30 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider" title="Pago Mixto"><i data-lucide="split-square-horizontal" class="w-3 h-3"></i> Mixto</div>`;
    } else {
        badgePago = `<div class="flex items-center gap-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider" title="Efectivo"><i data-lucide="banknote" class="w-3 h-3"></i> Efectivo</div>`;
    }

    // Si es Master/Admin, mostrar de qué sede viene el pedido
    const badgeLocal = isAdminUser() && v.localNombre && v.localNombre !== 'Sin Local' 
        ? `<div class="text-[9px] text-slate-400 mt-1 uppercase font-bold"><i data-lucide="store" class="w-3 h-3 inline"></i> ${v.localNombre}</div>` 
        : '';

    // Destacar el nombre del cliente si existe (incluye claves de versiones anteriores)
    const clienteNombre = obtenerNombreCliente(v);
    const clienteBadge = clienteNombre ? `
        <div class="mt-2 mb-2 bg-slate-900 border border-slate-700 p-2 rounded-lg flex items-center gap-2 shadow-inner">
            <i data-lucide="user" class="w-4 h-4 text-sky-400 shrink-0"></i>
            <span class="text-xs font-bold text-sky-400 uppercase tracking-wider truncate">${escaparHtml(clienteNombre)}</span>
        </div>` : '';

    let actionBtn = esListo ? '' : `
        <div class="flex gap-2 mt-3 pt-3 border-t border-slate-700/50">
            <button data-action="rechazar-pedido" data-id="${v.id}" ${isLocked ? 'disabled aria-disabled="true"' : ''} class="min-h-11 min-w-11 flex items-center justify-center p-2 rounded-lg transition-colors border border-transparent ${isLocked ? 'text-orange-300/40 cursor-not-allowed' : 'text-slate-400 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30'}" title="${isLocked ? 'Pedido reservado para edición' : 'Rechazar (Devuelve Stock)'}">
                <i data-lucide="x" class="w-4 h-4"></i>
            </button>
            <button data-action="editar-pedido" data-id="${v.id}" ${isLocked ? 'disabled aria-disabled="true"' : ''} class="min-h-11 min-w-11 flex items-center justify-center p-2 rounded-lg transition-colors border border-transparent ${isLocked ? 'text-orange-300/40 cursor-not-allowed' : 'text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/30'}" title="${isLocked ? 'Pedido bloqueado por edición' : (isRecoverable ? 'Recuperar edición expirada' : 'Devolver a Caja')}">
                <i data-lucide="edit" class="w-4 h-4"></i>
            </button>
            <button data-action="despachar-pedido" data-id="${v.id}" ${isLocked ? 'disabled aria-disabled="true"' : ''} class="min-h-11 flex-1 rounded-lg py-2 text-xs font-bold transition-all shadow-lg flex justify-center items-center gap-1 ${isLocked ? 'bg-orange-500/15 border border-orange-400/40 text-orange-300 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-500 border border-emerald-500 text-white'}">
                <i data-lucide="${isLocked ? 'lock-keyhole' : 'check-circle'}" class="w-4 h-4"></i> ${isLocked ? 'En edición' : 'Despachar'}
            </button>
        </div>`;

    return `
        <div class="${(isLocked || isRecoverable) ? 'bg-orange-500/10 border-orange-400/60 ring-1 ring-orange-400/20' : 'bg-slate-800 border-slate-700'} border p-3 rounded-xl flex flex-col shadow-lg transition-colors">
            <div class="flex justify-between items-start mb-2">
                <div class="flex items-center gap-2">
                    <div class="bg-slate-900 text-slate-300 font-mono text-[10px] px-1.5 py-0.5 rounded border border-slate-700">#${num}</div>
                    <span class="text-[10px] text-slate-500 font-bold">${time}</span>
                    ${editBdge}
                </div>
                ${badgePago}
            </div>
            ${badgeLocal}
            ${clienteBadge}
            ${lockBadge}
            <div class="mb-1 mt-1 border-l-2 border-slate-700 pl-2">
                ${iHtml}
            </div>
            ${actionBtn}
        </div>`;
}

function actualizarEstadoPedido(idVenta, nuevoEstado) {
    const venta = pedidosGlobales.find(item => item.id === idVenta);
    const editLock = getSaleEditLockState(venta);
    if (editLock.active) {
        if (window.mostrarToast) {
            window.mostrarToast(
                'Pedido bloqueado',
                `${editLock.ownerName} lo está editando.`,
                'amber'
            );
        }
        return;
    }

    if (nuevoEstado === 'rechazado') {
        if(window.mostrarConfirmacion) window.mostrarConfirmacion(`¿Rechazar pedido? Se ocultará de la cola y el stock regresará al inventario.`, () => { 
            ejecutarCambioEstado(idVenta, nuevoEstado); 
        });
    } else { 
        ejecutarCambioEstado(idVenta, nuevoEstado); 
    }
}

async function ejecutarCambioEstado(idVenta, nuevoEstado) {
    if (operacionesPedidoEnCurso.has(idVenta)) return;

    const venta = pedidosGlobales.find(item => item.id === idVenta);
    if (!venta) {
        if (window.mostrarToast) {
            window.mostrarToast('Pedido no disponible', 'El pedido ya cambió o dejó de estar visible.', 'amber');
        }
        return;
    }

    const autorCambio = state.currentUser?.username || state.currentUser?.email || 'Desconocido';
    let legacyInventoryMovements = [];
    if (nuevoEstado === 'rechazado') {
        try {
            legacyInventoryMovements = buildLegacyInventoryMovements(venta.items);
        } catch (error) {
            console.warn('No se pudo reconstruir todo el inventario legado:', error);
        }
    }

    operacionesPedidoEnCurso.add(idVenta);
    try {
        const result = await transitionSaleTransaction({
            saleId: idVenta,
            operationId: createUuid('OP-'),
            nextState: nuevoEstado,
            allowedStates: ['pendiente'],
            actor: autorCambio,
            reason: nuevoEstado === 'rechazado' ? 'rechazado_en_preparacion' : 'despachado',
            legacyInventoryMovements
        });

        if (nuevoEstado === 'listo') {
            if(window.mostrarToast) {
                window.mostrarToast(
                    'Actualizado',
                    result.alreadyApplied ? 'El pedido ya estaba despachado.' : 'Pedido despachado.',
                    'emerald'
                );
            }
        } else if(window.mostrarToast) {
            const warning = result.missingProducts?.length
                ? ` No se pudieron reponer ${result.missingProducts.length} productos eliminados.`
                : '';
            window.mostrarToast(
                'Rechazado',
                `${result.alreadyApplied ? 'El pedido ya estaba anulado.' : 'Pedido anulado y stock devuelto.'}${warning}`,
                'amber'
            );
        }
    } catch (error) {
        console.error('Error al actualizar pedido:', error);
        if(window.mostrarAlerta) {
            window.mostrarAlerta(
                'No se pudo actualizar',
                error?.message || 'Revisa la conexión e inténtalo nuevamente.',
                'red'
            );
        }
    } finally {
        operacionesPedidoEnCurso.delete(idVenta);
    }
}

function editarPedido(idVenta) {
    if(!window.mostrarConfirmacion) return;
    window.mostrarConfirmacion("¿Abrir este pedido en caja? La venta original se conservará hasta que confirmes los cambios.", () => {
        iniciarEdicionPedido(idVenta);
    });
}

async function iniciarEdicionPedido(idVenta) {
    if (operacionesPedidoEnCurso.has(idVenta)) return;

    if (isSaleOperationInProgress()) {
        window.mostrarToast?.(
            'Venta en proceso',
            'Espera la confirmación actual antes de editar otro pedido.',
            'amber'
        );
        return;
    }

    const currentEdit = window.ticketEditadoContext;
    if (currentEdit?.saleId) {
        if (currentEdit.saleId === idVenta) {
            window.switchView?.('ventas');
            window.mostrarToast?.(
                'Edición en curso',
                'Este pedido ya está abierto en Ventas.',
                'amber'
            );
        } else {
            window.mostrarAlerta?.(
                'Termina la edición actual',
                'Guarda o cancela el pedido abierto antes de editar otro.',
                'amber'
            );
        }
        return;
    }

    if (editLockAcquisitionInProgress) {
        window.mostrarToast?.(
            'Preparando edición',
            'Espera a que termine la solicitud anterior.',
            'amber'
        );
        return;
    }

    const visibleSale = pedidosGlobales.find(v => v.id === idVenta);
    const visibleState = String(visibleSale?.estado || '').toLowerCase();
    if (!visibleSale || !['pendiente', 'editando'].includes(visibleState)) {
        if(window.mostrarToast) {
            window.mostrarToast('Pedido no disponible', 'El pedido ya cambió de estado.', 'amber');
        }
        return;
    }

    const visibleLock = getSaleEditLockState(visibleSale);
    if (visibleLock.active) {
        if (window.mostrarAlerta) {
            window.mostrarAlerta(
                'Pedido en edición',
                `${visibleLock.ownerName} ya está modificando este pedido.`,
                'amber'
            );
        }
        return;
    }

    const lockToken = createUuid('LOCK-');
    const ownerName = state.currentUser?.username
        || state.currentUser?.email
        || 'Usuario';
    const ownerId = state.currentUser?.uid
        || state.currentUser?.email
        || ownerName;
    const sessionGeneration = getVentasSessionGeneration();
    const lifecycleGeneration = pedidosLifecycleGeneration;
    const sessionOwnerId = String(ownerId);

    editLockAcquisitionInProgress = true;
    operacionesPedidoEnCurso.add(idVenta);
    try {
        const lockResult = await acquireSaleEditLock({
            saleId: idVenta,
            lockToken,
            ownerId,
            ownerName
        });

        const requestBecameObsolete = (
            sessionGeneration !== getVentasSessionGeneration()
            || lifecycleGeneration !== pedidosLifecycleGeneration
            || sessionOwnerId !== String(
                state.currentUser?.uid
                || state.currentUser?.email
                || ''
            )
            || Boolean(window.ticketEditadoContext?.saleId)
        );
        if (requestBecameObsolete) {
            try {
                await releaseSaleEditLock({
                    saleId: idVenta,
                    lockToken,
                    actor: ownerName,
                    reason: 'solicitud_edicion_obsoleta'
                });
            } catch (releaseError) {
                console.warn(
                    'El bloqueo obsoleto se liberará por expiración si la sesión ya terminó:',
                    releaseError
                );
            }
            return;
        }

        const vData = lockResult.sale;

        let legacyInventoryMovements = [];
        try {
            legacyInventoryMovements = buildLegacyInventoryMovements(vData.items);
        } catch (error) {
            console.warn('Inventario legado incompleto al editar:', error);
        }

        const editItems = typeof structuredClone === 'function'
            ? structuredClone(vData.items || [])
            : JSON.parse(JSON.stringify(vData.items || []));
        state.carrito = editItems.map((item, index) => ({
            ...item,
            cartId: getSaleItemCartId(idVenta, item, index)
        }));
        window.ticketEditadoOriginal = true;
        window.ticketEditadoContext = {
            saleId: idVenta,
            expectedRevision: lockResult.expectedRevision,
            legacyInventoryMovements,
            localId: vData.localId || state.userLocalId || 'general',
            localNombre: vData.localNombre || state.userLocal || 'Sin Local',
            lockToken,
            lockOwnerId: ownerId,
            lockOwnerName: ownerName,
            lockExpiresAtMs: lockResult.expiresAtMs
        };

        const inputCliente = document.getElementById('input-cliente-nombre');
        if (inputCliente) inputCliente.value = obtenerNombreCliente(vData);

        const paymentMethod = String(
            vData.metodoFinal || vData.metodo_pago || 'efectivo'
        ).toLowerCase();
        const paymentRadio = document.querySelector(
            `input[name="metodo_pago"][value="${paymentMethod}"]`
        );
        if (paymentRadio) {
            paymentRadio.checked = true;
            window.toggleMetodoPago?.(paymentMethod);
        }
        if (paymentMethod === 'mixto') {
            const cashInput = document.getElementById('input-mixto-efectivo');
            const digitalInput = document.getElementById('input-mixto-yape');
            if (cashInput) {
                cashInput.value = Number(
                    vData.pagoEfectivo ?? vData.pago_efectivo ?? 0
                ).toFixed(2);
            }
            if (digitalInput) {
                digitalInput.value = Number(
                    vData.pagoYape ?? vData.pago_yape ?? 0
                ).toFixed(2);
            }
        }

        if (window.actualizarCarritoUI) window.actualizarCarritoUI();
        if (window.switchView) window.switchView('ventas');
        if (window.mostrarToast) {
            window.mostrarToast(
                'Edición bloqueada',
                'Este pedido quedó reservado para este dispositivo.',
                'amber'
            );
        }
    } catch (error) {
        console.error('No se pudo bloquear el pedido para edición:', error);
        if (window.mostrarAlerta) {
            window.mostrarAlerta(
                'No se puede editar',
                error?.message || 'Otro dispositivo tomó el pedido. Actualiza la vista.',
                'amber'
            );
        }
    } finally {
        editLockAcquisitionInProgress = false;
        operacionesPedidoEnCurso.delete(idVenta);
    }
}
