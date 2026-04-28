import { db, collection, query, where, getDocs, addDoc, serverTimestamp } from '../core/firebase-setup.js';
import { getTodayDateStr, formatMoney } from '../utils/helpers.js'; import { state } from '../core/store.js';

export function initCaja() {
    document.getElementById('filtro-local-caja')?.addEventListener('change', (e) => cargarArqueoCaja(e.target.value));
    document.getElementById('form-gasto')?.addEventListener('submit', guardarGasto);
    document.getElementById('btn-registrar-gasto')?.addEventListener('click', abrirModalGasto);
    document.getElementById('btn-cerrar-modal-gasto')?.addEventListener('click', cerrarModalGasto);

    document.getElementById('caja-historial-list')?.addEventListener('click', e => {
        const item = e.target.closest('[data-action="toggle-detalle"]'); if(!item) return;
        document.getElementById(item.dataset.target)?.classList.toggle('hidden');
    });

    cargarArqueoCaja('todas');
}

function abrirModalGasto() {
    const modal = document.getElementById('modal-gasto'); if(!modal) return;
    const select = document.getElementById('gasto-local');
    if(select && (state.userRole === 'admin' || state.userRole === 'master')) {
        let opts = '<option value="ambas">Dividir en todas las sedes (Global)</option>';
        state.locales.forEach(l => opts += `<option value="${l.id}">${l.nombre}</option>`);
        select.innerHTML = opts; select.parentElement.classList.remove('hidden');
    } else if (select) {
        select.innerHTML = `<option value="${state.userLocalId || ''}">${state.userLocal || 'Mi Local'}</option>`;
        select.parentElement.classList.add('hidden');
    }
    document.getElementById('form-gasto').reset();
    modal.classList.remove('hidden'); setTimeout(() => modal.classList.remove('opacity-0'), 10);
    if(window.lucide) window.lucide.createIcons();
}

function cerrarModalGasto() { const m = document.getElementById('modal-gasto'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300); }

async function guardarGasto(e) {
    e.preventDefault();
    const b = document.querySelector('#form-gasto button[type="submit"]'); const oT = b.innerHTML; b.innerHTML = 'Guardando...'; b.disabled = true;
    try {
        const m = parseFloat(document.getElementById('gasto-monto').value); const d = document.getElementById('gasto-desc').value.trim(); const l = document.getElementById('gasto-local').value;
        const nombreL = l === 'ambas' ? 'Global' : (state.locales.find(x => x.id === l)?.nombre || 'Sede');
        await addDoc(collection(db, "gastos"), { monto: m, descripcion: d, fechaStr: getTodayDateStr(), timestamp: serverTimestamp(), localId: l === 'ambas' ? '' : l, localNombre: nombreL, registradoPor: state.currentUser.email });
        if(window.mostrarToast) window.mostrarToast('Gasto Guardado', `S/ ${m} registrado.`, 'red');
        cerrarModalGasto(); cargarArqueoCaja(document.getElementById('filtro-local-caja')?.value || 'todas');
    } catch(err) {} finally { b.innerHTML = oT; b.disabled = false; }
}

async function cargarArqueoCaja(filtroLocal = 'todas') {
    const list = document.getElementById('caja-historial-list'); if(!list) return;
    list.innerHTML = '<div class="flex justify-center p-4"><i data-lucide="loader-2" class="w-6 h-6 animate-spin text-sky-500"></i></div>'; if(window.lucide) window.lucide.createIcons();
    const hoy = getTodayDateStr();
    
    try {
        // MAGIA JS: Trae TODO del día. El filtro lo hacemos en Javascript para no excluir ventas viejas sin localId.
        const qVentas = query(collection(db, "ventas"), where("fechaStr", "==", hoy));
        const qGastos = query(collection(db, "gastos"), where("fechaStr", "==", hoy));
        const [snapVentas, snapGastos] = await Promise.all([getDocs(qVentas), getDocs(qGastos)]);
        
        let total = 0, gastosTotal = 0, efe = 0, yape = 0; let allItems = [];

        snapVentas.forEach(d => {
            const v = d.data();
            // Filtro local JS
            if (filtroLocal !== 'todas' && v.localId !== filtroLocal) return; // Si es 'todas', las viejas sin local pasan
            
            if (v.estado !== 'rechazado') {
                total += parseFloat(v.total || 0); efe += parseFloat(v.pago_efectivo || 0); yape += parseFloat(v.pago_yape || 0);
            }
            allItems.push({ tipo: 'venta', id: d.id, ...v });
        });

        snapGastos.forEach(d => {
            const g = d.data();
            if (filtroLocal !== 'todas' && g.localId !== filtroLocal && g.localId !== '') return; // Pasa el gasto si es Global ('') o del local
            
            gastosTotal += parseFloat(g.monto || 0);
            allItems.push({ tipo: 'gasto', id: d.id, ...g });
        });

        allItems.sort((a,b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

        if (allItems.length === 0) list.innerHTML = '<p class="text-slate-500 text-sm text-center p-4">No hay movimientos.</p>';
        else {
            list.innerHTML = '';
            allItems.forEach(item => {
                const hora = item.timestamp ? new Date(item.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--';
                if (item.tipo === 'venta') {
                    const r = item.estado === 'rechazado'; const op = r ? 'opacity-50' : ''; const strike = r ? 'line-through text-slate-500' : 'text-sky-400';
                    let det = `<div id="det-${item.id}" class="hidden mt-2 pt-2 border-t border-slate-700/50 space-y-1">`;
                    item.items?.forEach(i => det += `<div class="flex justify-between text-xs"><p class="text-slate-300"><span class="text-sky-400 font-bold">${i.cantidad}x</span> ${i.nombre}</p><p class="text-slate-400">${formatMoney(i.precio * i.cantidad)}</p></div>`);
                    det += `</div>`;
                    list.innerHTML += `<div class="bg-slate-900 border border-slate-700 p-3 rounded-xl hover:border-sky-500/50 transition-colors cursor-pointer group ${op}" data-action="toggle-detalle" data-target="det-${item.id}"><div class="flex justify-between items-start"><div><div class="flex items-center gap-2 mb-1"><i data-lucide="receipt" class="w-4 h-4 text-sky-400"></i><p class="text-sm font-bold text-white">Venta #${item.id.split('-')[1]||'--'}</p><span class="text-[9px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-md font-bold uppercase">${item.localNombre || 'Sin Local'}</span>${r?'<span class="text-[9px] bg-red-500/20 text-red-400 px-1 rounded uppercase font-bold">Anulado</span>':''}</div><p class="text-[10px] text-slate-500">Por: ${item.cajeroEmail?.split('@')[0]}</p></div><div class="text-right"><p class="font-black ${strike} text-base">+ ${formatMoney(item.total)}</p><p class="text-[9px] font-bold text-slate-500 uppercase mt-0.5">${hora}</p></div></div>${det}</div>`;
                } else {
                    list.innerHTML += `<div class="bg-red-500/10 border border-red-500/30 p-3 rounded-xl"><div class="flex justify-between items-start"><div><div class="flex items-center gap-2 mb-1"><i data-lucide="trending-down" class="w-4 h-4 text-red-400"></i><p class="text-sm font-bold text-red-400">Gasto</p><span class="text-[9px] bg-red-500/20 text-red-300 px-2 py-0.5 rounded-md font-bold">${item.localNombre}</span></div><p class="text-[10px] text-slate-400">${item.descripcion}</p></div><div class="text-right"><p class="font-black text-red-400 text-base">- ${formatMoney(item.monto)}</p><p class="text-[9px] font-bold text-red-500/50 uppercase mt-0.5">${hora}</p></div></div></div>`;
                }
            });
        }
        
        document.getElementById('caja-total').textContent = formatMoney(total);
        document.getElementById('caja-gastos').textContent = formatMoney(gastosTotal);
        document.getElementById('caja-efectivo').textContent = formatMoney(efe);
        document.getElementById('caja-yape').textContent = formatMoney(yape);
        
        const cN = total - gastosTotal; const netEl = document.getElementById('caja-neta');
        if(netEl) { netEl.textContent = formatMoney(cN); netEl.className = cN >= 0 ? "text-xl md:text-2xl font-black text-emerald-400" : "text-xl md:text-2xl font-black text-red-400"; }
        if(window.lucide) window.lucide.createIcons();
    } catch (err) {}
}
