import { db, collection, query, where, onSnapshot, doc, updateDoc, deleteDoc, getDoc } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; import { getTodayDateStr } from '../utils/helpers.js';

let unsubscribePedidos = null;
let pedidosInicializado = false;

export function initPedidos() { 
    if (pedidosInicializado) return;
    pedidosInicializado = true;

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
    
    const q = query(collection(db, "ventas"), where("fechaStr", "==", hoy));
    
    unsubscribePedidos = onSnapshot(q, (snapshot) => {
        let pendientes = [], listos = [];
        
        snapshot.forEach(d => { 
            const v = d.data(); v.id = d.id; 
            
            if (state.userRole !== 'admin' && state.userRole !== 'master' && v.localId !== state.userLocalId) {
                return; 
            }

            if(v.estado === 'pendiente') pendientes.push(v); 
            else if (v.estado === 'listo' || v.estado === 'rechazado') listos.push(v); 
        });
        
        pendientes.sort((a,b) => (a.fecha?.seconds || 0) - (b.fecha?.seconds || 0)); 
        listos.sort((a,b) => (b.fecha?.seconds || 0) - (a.fecha?.seconds || 0));
        
        renderPedidos(pendientes, listos);
    });
}

function renderPedidos(pendientes, listos) {
    const listPen = document.getElementById('pedidos-pendientes-list'); const listLis = document.getElementById('pedidos-listos-list');
    if(!listPen) return;
    
    document.getElementById('contador-pendientes').textContent = pendientes.length; document.getElementById('contador-listos').textContent = listos.length;
    const badgeSidebar = document.getElementById('badge-pedidos'); if(badgeSidebar) { if(pendientes.length > 0) badgeSidebar.classList.remove('hidden'); else badgeSidebar.classList.add('hidden'); }

    let hPen = '';
    pendientes.forEach(p => {
        let itemsHtml = '';
        p.items.forEach(i => {
            const sabTag = (i.sabores && i.sabores.length > 0) ? `<div class="flex flex-wrap gap-1 mt-1 ml-4">${i.sabores.map(s => `<span class="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded">${s}</span>`).join('')}</div>` : '';
            itemsHtml += `<div class="mb-2"><p class="text-sm text-white font-bold"><span class="text-sky-400">${i.cantidad}x</span> ${i.nombre}</p>${sabTag}</div>`;
        });
        const safeId = p.id.includes('-') ? p.id.split('-')[1] : p.id;
        
        // Etiqueta de ESTRELLA Modificado si proviene de una edición
        const badgeEditado = p.editado ? `<span class="text-[10px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded font-bold ml-2 inline-flex items-center gap-1"><i data-lucide="star" class="w-3 h-3 fill-amber-400"></i> Modificado</span>` : '';

        // Botones de acción para Vendedores y Admins
        const actionButtons = `
            <div class="grid grid-cols-2 gap-2 mt-4">
                <button data-action="rechazar-pedido" data-id="${p.id}" class="py-2.5 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-500/50 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5"><i data-lucide="x-circle" class="w-4 h-4"></i> <span>Rechazar</span></button>
                <button data-action="editar-pedido" data-id="${p.id}" class="py-2.5 bg-sky-600/20 hover:bg-sky-600 text-sky-400 hover:text-white border border-sky-500/50 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5"><i data-lucide="edit-2" class="w-4 h-4"></i> <span>Editar</span></button>
                <button data-action="despachar-pedido" data-id="${p.id}" class="col-span-2 py-2.5 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white border border-emerald-500/50 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5"><i data-lucide="check-circle-2" class="w-4 h-4"></i> <span>Despachar</span></button>
            </div>
        `;

        hPen += `<div class="bg-slate-800 border-l-4 border-amber-500 p-4 rounded-r-xl shadow-lg relative mb-3"><div class="flex justify-between items-start mb-3"><div class="flex flex-col gap-1"><div class="flex items-center"><h4 class="text-xl font-black text-white">#${safeId}</h4>${badgeEditado}</div><span class="text-[10px] bg-slate-700 text-slate-300 px-2 py-0.5 rounded font-bold w-fit">${p.localNombre}</span></div></div><div class="space-y-2 bg-slate-900/50 p-3 rounded-lg border border-slate-700">${itemsHtml}</div>${actionButtons}</div>`;
    });
    listPen.innerHTML = hPen || '<p class="text-xs text-slate-500 text-center py-4">No hay pedidos pendientes.</p>';

    let hLis = '';
    listos.slice(0, 15).forEach(p => {
        const safeId = p.id.includes('-') ? p.id.split('-')[1] : p.id;
        
        let iconoEstado = '<i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-500/50"></i>';
        let textoEstado = 'Despachado';
        
        if(p.estado === 'rechazado') { iconoEstado = '<i data-lucide="x-circle" class="w-5 h-5 text-red-500/50"></i>'; textoEstado = 'Rechazado'; }

        hLis += `<div class="bg-slate-800/50 border border-slate-700 p-4 rounded-xl mb-3"><div class="flex justify-between items-center mb-1"><h4 class="text-base font-bold text-slate-500 line-through">#${safeId}</h4>${iconoEstado}</div><p class="text-[10px] text-slate-500">${p.items.length} productos • ${textoEstado}</p></div>`;
    });
    listLis.innerHTML = hLis || '<p class="text-xs text-slate-500 text-center py-4">Aún no se ha procesado nada.</p>';
    if(window.lucide) window.lucide.createIcons();
}

async function actualizarEstadoPedido(idVenta, nuevoEstado) {
    if (nuevoEstado === 'rechazado') {
        if(window.mostrarConfirmacion) {
            window.mostrarConfirmacion(`¿Seguro que deseas marcar este pedido como RECHAZADO?`, async () => {
                ejecutarCambioEstado(idVenta, nuevoEstado);
            });
        } else { ejecutarCambioEstado(idVenta, nuevoEstado); }
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
    } catch(e) { console.error(e); }
}

async function editarPedido(idVenta) {
    if(!window.mostrarConfirmacion) return;
    window.mostrarConfirmacion("¿Mandar a caja para editarlo? Se borrará de la cola.", async () => {
        try {
            const r = doc(db, "ventas", idVenta); const s = await getDoc(r);
            if(s.exists()) {
                state.carrito = s.data().items; 
                window.ticketEditadoOriginal = true; // Activa la bandera de Modificado para la siguiente venta
                await deleteDoc(r);
                if (window.actualizarCarritoUI) window.actualizarCarritoUI(); window.switchView('ventas');
                if(window.mostrarToast) window.mostrarToast('En Caja', 'Modifica el pedido.', 'sky');
            }
        } catch(err) { console.error(err); }
    });
}
