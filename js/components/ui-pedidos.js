import { db, collection, query, where, onSnapshot, doc, updateDoc, writeBatch, increment } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; 
import { getTodayDateStr, obtenerNombreCliente, escaparHtml } from '../utils/helpers.js';

let unsubscribePedidos = null;
let pedidosInicializado = false;
let pedidosGlobales = []; 
let filtroLocalPedidos = 'todas'; 

export function initPedidos() { 
    if (pedidosInicializado) return;
    pedidosInicializado = true;

    // Conectar el filtro desplegable
    const selectFiltro = document.getElementById('filtro-local-pedidos');
    if (selectFiltro) {
        selectFiltro.addEventListener('change', (e) => {
            filtroLocalPedidos = e.target.value;
            renderPedidosUI(); 
        });
    }

    // Delegación de eventos para los botones de las tarjetas
    const listaPendientes = document.getElementById('pedidos-pendientes-list');
    if (listaPendientes) {
        listaPendientes.addEventListener('click', e => {
            const btn = e.target.closest('button[data-action]'); 
            if (!btn) return;
            
            const id = btn.dataset.id;
            if(btn.dataset.action === 'editar-pedido') editarPedido(id);
            else if(btn.dataset.action === 'despachar-pedido') actualizarEstadoPedido(id, 'listo');
            else if(btn.dataset.action === 'rechazar-pedido') actualizarEstadoPedido(id, 'rechazado');
        });
    }
    
    iniciarEscuchaPedidos(); 
}

function iniciarEscuchaPedidos() {
    if(unsubscribePedidos) unsubscribePedidos();
    const hoy = getTodayDateStr(); 
    
    // Traemos los pedidos del día (Por reglas de seguridad y rendimiento, 
    // filtramos en memoria RAM para no hacer consultas compuestas complejas)
    const q = query(collection(db, "ventas"), where("fechaStr", "==", hoy));
    
    unsubscribePedidos = onSnapshot(q, (snapshot) => {
        pedidosGlobales = [];
        snapshot.forEach(d => { 
            const v = d.data({ serverTimestamps: 'estimate' }); 
            v.id = d.id; 
            pedidosGlobales.push(v); 
        });
        renderPedidosUI();
    });
}

function renderPedidosUI() {
    let pendientes = [], listos = [];
    
    pedidosGlobales.forEach(v => {
        const isAdmin = (state.userRole === 'admin' || state.userRole === 'master');
        const miSedeId = state.userLocalId || ""; 
        
        let mostrar = false;
        if (isAdmin) {
            if (filtroLocalPedidos === 'todas') {
                mostrar = true;
            } else if (filtroLocalPedidos === '') {
                mostrar = !v.localId || v.localId === '';
            } else {
                mostrar = v.localId === filtroLocalPedidos;
            }
        } else {
            mostrar = (!v.localId || v.localId === miSedeId);
        }

        if (mostrar) {
            if (v.estado === 'pendiente') pendientes.push(v);
            else if (v.estado === 'listo') listos.push(v);
        }
    });

    // Ordenar: Los más antiguos primero
    const getTime = (v) => v.fechaHora || (v.timestamp?.seconds ? v.timestamp.seconds * 1000 : Date.now());
    
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
    
    if (window.lucide) window.lucide.createIcons();
}

function generarHTMLPedido(v, esListo = false) {
    let iHtml = '';
    v.items.forEach(i => { 
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
    
    // FIX: Hora correcta usando el fallback del dispositivo si es null
    const tVal = v.timestamp ? new Date(v.timestamp.seconds * 1000) : new Date();
    const time = tVal.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    const num = v.id.split('-')[1] || '---';
    const editBdge = v.editado ? `<span class="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[9px] px-1 rounded uppercase font-bold ml-2 animate-pulse">Modificado</span>` : '';
    
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
    const badgeLocal = (state.userRole === 'admin' || state.userRole === 'master') && v.localNombre && v.localNombre !== 'Sin Local' 
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
            <button data-action="rechazar-pedido" data-id="${v.id}" class="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors border border-transparent hover:border-red-500/30" title="Rechazar (Devuelve Stock)">
                <i data-lucide="x" class="w-4 h-4"></i>
            </button>
            <button data-action="editar-pedido" data-id="${v.id}" class="p-2 text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors border border-transparent hover:border-amber-500/30" title="Devolver a Caja">
                <i data-lucide="edit" class="w-4 h-4"></i>
            </button>
            <button data-action="despachar-pedido" data-id="${v.id}" class="flex-1 bg-emerald-600 hover:bg-emerald-500 border border-emerald-500 text-white rounded-lg py-2 text-xs font-bold transition-all shadow-lg flex justify-center items-center gap-1">
                <i data-lucide="check-circle" class="w-4 h-4"></i> Despachar
            </button>
        </div>`;

    return `
        <div class="bg-slate-800 border border-slate-700 p-3 rounded-xl flex flex-col shadow-lg">
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
            <div class="mb-1 mt-1 border-l-2 border-slate-700 pl-2">
                ${iHtml}
            </div>
            ${actionBtn}
        </div>`;
}

function actualizarEstadoPedido(idVenta, nuevoEstado) {
    if (nuevoEstado === 'rechazado') {
        if(window.mostrarConfirmacion) window.mostrarConfirmacion(`¿Rechazar pedido? Se ocultará de la cola y el stock regresará al inventario.`, () => { 
            ejecutarCambioEstado(idVenta, nuevoEstado); 
        });
    } else { 
        ejecutarCambioEstado(idVenta, nuevoEstado); 
    }
}

function ejecutarCambioEstado(idVenta, nuevoEstado) {
    const autorCambio = state.currentUser?.username || state.currentUser?.email || 'Desconocido';

    if (nuevoEstado === 'listo') {
        updateDoc(doc(db, "ventas", idVenta), { 
            estado: nuevoEstado, 
            modificadoPor: autorCambio, 
            fechaModificacion: new Date().toISOString() 
        }).catch(e => console.error("Error al actualizar pedido:", e)); 
        
        if(window.mostrarToast) window.mostrarToast('Actualizado', `Pedido despachado`, 'emerald'); 
    } else if (nuevoEstado === 'rechazado') {
        
        // Búsqueda en RAM inmediata
        const vData = pedidosGlobales.find(v => v.id === idVenta);
        if (!vData || vData.estado === 'rechazado') return;

        const batch = writeBatch(db);
        const vRef = doc(db, "ventas", idVenta);

        // 1. Marcar como rechazado
        batch.update(vRef, { 
            estado: 'rechazado',
            modificadoPor: autorCambio,
            fechaModificacion: new Date().toISOString()
        });

        // 2. Restar dinero de la caja diaria
        const locId = vData.localId || 'general';
        const fStr = vData.fechaStr;
        const cRef = doc(db, "caja_diaria", `${fStr}_${locId}`);

        batch.set(cRef, {
            total_ingresos: increment(-(vData.total || 0)),
            total_costos: increment(-(vData.costoTotal || vData.costo_total || 0)),
            total_efectivo: increment(-(vData.pagoEfectivo || vData.pago_efectivo || 0)),
            total_yape: increment(-(vData.pagoYape || vData.pago_yape || 0)),
            cantidad_ventas: increment(-1)
        }, { merge: true });

        // 3. Devolver los productos Y Toppings al inventario
        if (vData.items) {
            vData.items.forEach(item => {
                if (item.productoId !== 'AJUSTE') {
                    // Restaurar producto principal
                    const p = state.productos.find(x => x.id === item.productoId);
                    if (p && p.stock !== null) {
                        const pRef = doc(db, "productos", item.productoId);
                        batch.update(pRef, { stock: increment(item.cantidad) });
                    }
                    // Restaurar toppings
                    if (item.toppings && item.toppings.length > 0) {
                        item.toppings.forEach(top => {
                            const pTop = state.productos.find(x => x.id === top.id);
                            if (pTop && pTop.stock !== null) {
                                const ptRef = doc(db, "productos", top.id);
                                batch.update(ptRef, { stock: increment(item.cantidad) });
                            }
                        });
                    }
                }
            });
        }

        batch.commit().catch(e => console.error("Error al rechazar pedido:", e));
        if(window.mostrarToast) window.mostrarToast('Rechazado', `El pedido fue anulado y el stock devuelto.`, 'amber'); 
    }
}

function editarPedido(idVenta) {
    if(!window.mostrarConfirmacion) return;
    window.mostrarConfirmacion("¿Mandar a caja para editarlo? Se borrará de la cola y el stock se liberará momentáneamente.", () => {
        // 1. Buscamos la orden instantáneamente en RAM
        const vData = pedidosGlobales.find(v => v.id === idVenta);
        if (!vData) return;

        // 2. Cargamos el ticket al carrito y cambiamos la pantalla inmediatamente
        state.carrito = vData.items; 
        window.ticketEditadoOriginal = true; 

        const inputCliente = document.getElementById('input-cliente-nombre');
        if (inputCliente) inputCliente.value = obtenerNombreCliente(vData);
        
        if (window.actualizarCarritoUI) window.actualizarCarritoUI(); 
        if (window.switchView) window.switchView('ventas');
        if (window.mostrarToast) window.mostrarToast('En Caja', 'Ticket devuelto para edición.', 'sky');

        // 3. Empaquetamos la limpieza de la base de datos y la mandamos en background
        const batch = writeBatch(db);
        const r = doc(db, "ventas", idVenta); 

        // Restar de la caja
        const locId = vData.localId || 'general';
        const fStr = vData.fechaStr;
        const cRef = doc(db, "caja_diaria", `${fStr}_${locId}`);

        batch.set(cRef, {
            total_ingresos: increment(-(vData.total || 0)),
            total_costos: increment(-(vData.costoTotal || vData.costo_total || 0)),
            total_efectivo: increment(-(vData.pagoEfectivo || vData.pago_efectivo || 0)),
            total_yape: increment(-(vData.pagoYape || vData.pago_yape || 0)),
            cantidad_ventas: increment(-1)
        }, { merge: true });

        // Liberar el stock original Y los Toppings
        if (vData.items) {
            vData.items.forEach(item => {
                if (item.productoId !== 'AJUSTE') {
                    // Restaurar producto
                    const p = state.productos.find(x => x.id === item.productoId);
                    if (p && p.stock !== null) {
                        const pRef = doc(db, "productos", item.productoId);
                        batch.update(pRef, { stock: increment(item.cantidad) });
                    }
                    // Restaurar toppings
                    if (item.toppings && item.toppings.length > 0) {
                        item.toppings.forEach(top => {
                            const pTop = state.productos.find(x => x.id === top.id);
                            if (pTop && pTop.stock !== null) {
                                const ptRef = doc(db, "productos", top.id);
                                batch.update(ptRef, { stock: increment(item.cantidad) });
                            }
                        });
                    }
                }
            });
        }

        // Borrar el ticket original
        batch.delete(r);

        batch.commit().catch(e => console.error("Error al devolver pedido a caja:", e));
    });
}
