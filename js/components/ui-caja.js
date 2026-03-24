import { db, collection, query, where, getDocs, addDoc, serverTimestamp } from '../core/firebase-setup.js';
import { getTodayDateStr, formatMoney } from '../utils/helpers.js'; import { state } from '../core/store.js';

export function initCaja() {
    // Estáticos
    document.getElementById('filtro-local-caja')?.addEventListener('change', (e) => cargarArqueoCaja(e.target.value));
    document.getElementById('form-gasto')?.addEventListener('submit', guardarGasto);
    document.getElementById('btn-registrar-gasto')?.addEventListener('click', abrirModalGasto);
    document.getElementById('btn-cerrar-modal-gasto')?.addEventListener('click', cerrarModalGasto);

    // Dinámicos (Acordeón de Caja)
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
        select.innerHTML = opts;
    } else if (select) { select.innerHTML = `<option value="${state.userLocalId}">${state.userLocal}</option>`; }
    modal.classList.remove('hidden'); setTimeout(() => modal.classList.remove('opacity-0'), 10);
}

function cerrarModalGasto() {
    const m = document.getElementById('modal-gasto'); document.getElementById('form-gasto').reset();
    m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300);
}

async function guardarGasto(e) {
    e.preventDefault();
    const monto = parseFloat(document.getElementById('gasto-monto').value); const desc = document.getElementById('gasto-desc').value;
    const localId = document.getElementById('gasto-local').value;
    const localNombre = localId === 'ambas' ? 'Gasto Global' : state.locales.find(l => l.id === localId)?.nombre || state.userLocal;

    try {
        await addDoc(collection(db, "gastos"), { monto, descripcion: desc, localId, localNombre, fechaStr: getTodayDateStr(), fecha: serverTimestamp(), usuario: state.currentUser.email });
        if(window.mostrarToast) window.mostrarToast('Gasto Registrado', 'Descontado de caja', 'emerald');
        cerrarModalGasto(); cargarArqueoCaja(document.getElementById('filtro-local-caja')?.value || 'todas');
    } catch(err) { console.error(err); }
}

export async function cargarArqueoCaja(localFiltroId) {
    const hoyStr = getTodayDateStr(); let total = 0, yape = 0, efe = 0, tickets = 0, gastosTotal = 0; let itemsCaja = [];
    try {
        let qVentas = query(collection(db, "ventas"), where("fechaStr", "==", hoyStr));
        if(localFiltroId && localFiltroId !== 'todas') qVentas = query(collection(db, "ventas"), where("fechaStr", "==", hoyStr), where("localId", "==", localFiltroId));
        const snapV = await getDocs(qVentas);
        snapV.forEach(d => { const v = d.data(); v.id = d.id; v.tipoDoc = 'venta'; total += v.total || 0; efe += v.pagoEfectivo || 0; yape += v.pagoYape || 0; tickets += 1; itemsCaja.push(v); });

        let qGastos = query(collection(db, "gastos"), where("fechaStr", "==", hoyStr));
        const snapG = await getDocs(qGastos);
        snapG.forEach(d => {
            const g = d.data(); g.id = d.id; g.tipoDoc = 'gasto';
            if(localFiltroId === 'todas' || g.localId === localFiltroId || g.localId === 'ambas') {
                let mA = g.monto; if(localFiltroId !== 'todas' && g.localId === 'ambas') mA = mA / 2;
                gastosTotal += mA; itemsCaja.push(g);
            }
        });

        itemsCaja.sort((a,b) => (b.fecha?.seconds || 0) - (a.fecha?.seconds || 0));
        let listHtml = '';
        itemsCaja.forEach(item => {
            const hora = item.fecha ? new Date(item.fecha.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '...';
            if (item.tipoDoc === 'venta') {
                const safeId = (item.id && item.id.includes('-')) ? item.id.split('-')[1] : (item.id || 'N/A');
                let subHtml = `<div class="mt-2 pt-2 border-t border-slate-700/50 hidden space-y-1" id="caja-det-${item.id}">`;
                item.items.forEach(i => {
                    const sab = (i.sabores && i.sabores.length > 0) ? `<span class="text-[9px] text-sky-300 ml-1">(${i.sabores.join(', ')})</span>` : '';
                    subHtml += `<div class="flex justify-between text-[10px] text-slate-300"><p><span class="text-sky-400 font-bold">${i.cantidad}x</span> ${i.nombre} ${sab}</p><p class="text-emerald-400 font-bold">${formatMoney(i.precio * i.cantidad)}</p></div>`;
                });
                subHtml += `</div>`;
                listHtml += `<div class="bg-slate-900 p-3 md:p-4 rounded-xl border border-slate-800 hover:border-slate-600 transition-colors cursor-pointer group" data-action="toggle-detalle" data-target="caja-det-${item.id}"><div class="flex justify-between items-center"><div><div class="flex items-center gap-2 mb-1"><p class="text-sm font-bold text-white">#${safeId}</p><span class="text-[9px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-md font-bold">${item.localNombre}</span></div><p class="text-[10px] text-slate-400">${item.items ? item.items.length : 0} productos</p></div><div class="text-right flex flex-col items-end"><p class="font-black text-emerald-400 text-base">+ ${formatMoney(item.total)}</p><p class="text-[9px] font-bold text-slate-500 uppercase mt-0.5">${item.metodoFinal} • ${hora} <i data-lucide="chevron-down" class="w-2.5 h-2.5 inline ml-1"></i></p></div></div>${subHtml}</div>`;
            } else {
                listHtml += `<div class="bg-red-500/10 p-3 md:p-4 rounded-xl border border-red-500/20"><div class="flex justify-between items-center"><div><div class="flex items-center gap-2 mb-1"><i data-lucide="trending-down" class="w-4 h-4 text-red-400"></i><p class="text-sm font-bold text-red-400">Gasto</p><span class="text-[9px] bg-red-500/20 text-red-300 px-2 py-0.5 rounded-md font-bold">${item.localNombre}</span></div><p class="text-[10px] text-slate-400">${item.descripcion}</p></div><div class="text-right"><p class="font-black text-red-400 text-base">- ${formatMoney(item.monto)}</p><p class="text-[9px] font-bold text-red-500/50 uppercase mt-0.5">${hora}</p></div></div></div>`;
            }
        });
        
        document.getElementById('caja-total').textContent = formatMoney(total);
        document.getElementById('caja-gastos').textContent = formatMoney(gastosTotal);
        document.getElementById('caja-efectivo').textContent = formatMoney(efe);
        document.getElementById('caja-yape').textContent = formatMoney(yape);
        
        const cajaNeta = total - gastosTotal; const netEl = document.getElementById('caja-neta');
        if(netEl) { netEl.textContent = formatMoney(cajaNeta); netEl.className = cajaNeta >= 0 ? "text-xl md:text-2xl font-black text-emerald-400" : "text-xl md:text-2xl font-black text-red-400"; }
        const container = document.getElementById('caja-historial-list');
        if(container) container.innerHTML = listHtml || '<div class="text-center text-slate-500 text-sm py-10">No hay movimientos hoy.</div>';
        if(window.lucide) lucide.createIcons();
    } catch(e) { console.error(e); }
}
