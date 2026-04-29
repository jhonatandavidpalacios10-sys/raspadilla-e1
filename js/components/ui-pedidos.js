import { db, collection, query, where, onSnapshot, doc, updateDoc, deleteDoc, getDoc } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; 
import { getTodayDateStr } from '../utils/helpers.js';

let unsubscribePedidos = null;
let pedidosInicializado = false;
let pedidosGlobales = []; // Guarda todos los del día
let filtroLocalPedidos = 'todas'; // Controlado por el Select del Master/Admin

export function initPedidos() { 
    if (pedidosInicializado) return;
    pedidosInicializado = true;

    // Conectar el filtro desplegable
    const selectFiltro = document.getElementById('filtro-local-pedidos');
    if (selectFiltro) {
        selectFiltro.addEventListener('change', (e) => {
            filtroLocalPedidos = e.target.value;
            renderPedidosUI(); // Solo actualiza la vista (no gasta lecturas extras en Firebase)
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
    
    // FIX: Dar tiempo a que el perfil de usuario cargue completamente antes de iniciar la escucha
    // Esto evita que salgan en blanco la primera vez que se abre la aplicación.
    setTimeout(() => {
        iniciarEscuchaPedidos(); 
    }, 800);
}

function iniciarEscuchaPedidos() {
    if(unsubscribePedidos) unsubscribePedidos();
    const hoy = getTodayDateStr(); 
    
    // MAGIA: Traemos TODOS los pedidos del día a la RAM (Sin filtro de local aquí)
    const q = query(collection(db, "ventas"), where("fechaStr", "==", hoy));
    
    unsubscribePedidos = onSnapshot(q, (snapshot) => {
        pedidosGlobales = [];
        snapshot.forEach(d => { 
            const v = d.data(); 
            v.id = d.id; 
            pedidosGlobales.push(v); 
        });
        renderPedidosUI();
    });
}

function renderPedidosUI() {
    let pendientes = [], listos = [];
    
    pedidosGlobales.forEach(v => {
        // FILTRO JS MULTI-SEDE
        const isAdmin = (state.userRole === 'admin' || state.userRole === 'master');
        const miSedeId = state.userLocalId || ""; 
        
        let mostrar = false;
        if (isAdmin) {
            // Admin ve lo que elija en el select. Si elige 'todas', ve TODO.
            // Si el pedido no tiene localId (antiguo), lo muestra en "todas".
            mostrar = (filtroLocalPedidos === 'todas' || v.localId === filtroLocalPedidos || (filtroLocalPedidos === 'todas' && !v.localId));
        } else {
            // Vendedor ve solo las de su sede (O las que no tienen sede por si son viejas/globales)
            mostrar = (!v.localId || v.localId === miSedeId);
        }

        if (mostrar) {
            if (v.estado === 'pendiente') pendientes.push(v);
            else if (v.estado === 'listo') listos.push(v);
        }
    });

    // Ordenar: Los más antiguos primero (los que llevan más tiempo esperando)
    pendientes.sort((a,b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
    listos.sort((a,b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

    // Actualizar contadores
    const contPendientes = document.getElementById('contador-pendientes');
    const contListos = document.getElementById('contador-listos');
    if (contPendientes) contPendientes.textContent = pendientes.length;
    if (contListos) contListos.textContent = listos.length;
    
    // Renderizar HTML
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
        iHtml += `<div class="flex justify-between items-start mb-1 text-xs"><p class="text-white leading-tight pr-2"><span class="text-sky-400 font-bold">${i.cantidad}x</span> ${i.nombre}</p></div>`; 
    });
    
    const time = v.timestamp ? new Date(v.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--';
    const num = v.id.split('-')[1] || '---';
    const editBdge = v.editado ? `<span class="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[9px] px-1 rounded uppercase font-bold ml-2 animate-pulse">Modificado</span>` : '';
    
    // Si es Master/Admin, mostrar de qué sede viene el pedido en la tarjeta
    const badgeLocal = (state.userRole === 'admin' || state.userRole === 'master') && v.localNombre && v.localNombre !== 'Sin Local' 
        ? `<div class="text-[9px] text-slate-400 mt-1 uppercase font-bold"><i data-lucide="store" class="w-3 h-3 inline"></i> ${v.localNombre}</div>` 
        : '';

    let actionBtn = esListo ? '' : `
        <div class="flex gap-2 mt-3 pt-3 border-t border-slate-700/50">
            <button data-action="rechazar-pedido" data-id="${v.id}" class="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors border border-transparent hover:border-red-500/30" title="Rechazar y borrar">
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
            </div>
            ${badgeLocal}
            <div class="mb-1 mt-1 border-l-2 border-slate-700 pl-2">
                ${iHtml}
            </div>
            ${actionBtn}
        </div>`;
}

function actualizarEstadoPedido(idVenta, nuevoEstado) {
    if (nuevoEstado === 'rechazado') {
        if(window.mostrarConfirmacion) window.mostrarConfirmacion(`¿Rechazar y OCULTAR este pedido de la cola?`, async () => { 
            ejecutarCambioEstado(idVenta, nuevoEstado); 
        });
    } else { 
        ejecutarCambioEstado(idVenta, nuevoEstado); 
    }
}

async function ejecutarCambioEstado(idVenta, nuevoEstado) {
    try { 
        await updateDoc(doc(db, "ventas", idVenta), { 
            estado: nuevoEstado, 
            modificadoPor: state.currentUser.email, 
            fechaModificacion: new Date().toISOString() 
        }); 
        if(window.mostrarToast) window.mostrarToast('Actualizado', `Pedido ${nuevoEstado}`, nuevoEstado === 'listo' ? 'emerald' : 'amber'); 
    } catch(e) {
        console.error("Error al actualizar pedido:", e);
    }
}

async function editarPedido(idVenta) {
    if(!window.mostrarConfirmacion) return;
    window.mostrarConfirmacion("¿Mandar a caja para editarlo? Se borrará de la cola.", async () => {
        try {
            const r = doc(db, "ventas", idVenta); 
            const s = await getDoc(r);
            if(s.exists()) {
                state.carrito = s.data().items; 
                window.ticketEditadoOriginal = true; 
                await deleteDoc(r);
                
                if (window.actualizarCarritoUI) window.actualizarCarritoUI(); 
                if (window.switchView) window.switchView('ventas');
                if(window.mostrarToast) window.mostrarToast('En Caja', 'Edita y vuelve a cobrar.', 'sky');
            }
        } catch(e) {
            console.error("Error al devolver pedido a caja:", e);
        }
    });
}
