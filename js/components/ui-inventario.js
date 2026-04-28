import { db, collection, getDocs, addDoc, updateDoc, deleteDoc, doc } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; import { formatMoney } from '../utils/helpers.js';
import { renderProductosVenta } from './ui-ventas.js';

let listaInventarioEl; let categoriaActual = 'vaso';

export async function initInventario() {
    listaInventarioEl = document.getElementById('inventario-list');
    
    document.getElementById('form-insumo')?.addEventListener('submit', guardarProducto);
    document.getElementById('btn-nuevo-producto')?.addEventListener('click', abrirModalProducto);
    document.getElementById('btn-cerrar-modal-producto')?.addEventListener('click', () => document.getElementById('modal-producto').classList.add('hidden'));
    
    const tabs = document.querySelectorAll('#tabs-insumos button');
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.replace('text-emerald-400', 'text-slate-500'));
            tabs.forEach(t => t.classList.remove('border-emerald-400', 'border-b-2'));
            tab.classList.replace('text-slate-500', 'text-emerald-400'); tab.classList.add('border-emerald-400', 'border-b-2');
            categoriaActual = ['vaso', 'sabor', 'extra'][index]; renderInventarioUI(categoriaActual);
        });
    });

    window.cargarInventarioDesdeFirebase = async () => {
        try {
            const s = await getDocs(collection(db, "productos")); state.productos = [];
            s.forEach(d => state.productos.push({ id: d.id, ...d.data() }));
            renderInventarioUI(categoriaActual); renderProductosVenta();
        } catch(e) {}
    };
    
    window.editarProducto = (id) => {
        const p = state.productos.find(x => x.id === id); if(!p) return;
        abrirModalProducto();
        document.getElementById('prod-id').value = p.id;
        document.getElementById('prod-nombre').value = p.nombre;
        document.getElementById('prod-precio').value = p.precio;
        document.getElementById('prod-costo').value = p.costo || 0;
        document.getElementById('prod-stock').value = p.stock !== null ? p.stock : '';
        document.getElementById('prod-local').value = p.localId || 'global';
        if (p.categoria === 'vaso') document.getElementById('prod-limite').value = p.limite_sabores || 0;
    };
    window.eliminarProducto = eliminarProducto;

    await window.cargarInventarioDesdeFirebase();
}

function abrirModalProducto() {
    document.getElementById('form-insumo').reset(); document.getElementById('prod-id').value = '';
    
    // Inyectar Locales en el Select de Producto
    const selLocal = document.getElementById('prod-local');
    if (selLocal && state.locales) {
        let opts = '<option value="global">Disponible en Todas (Global)</option>';
        state.locales.forEach(l => opts += `<option value="${l.id}">${l.nombre}</option>`);
        selLocal.innerHTML = opts;
        
        // Bloquear cambio de sede a vendedores (se auto-asigna a la suya)
        if (state.userRole === 'vendedor') {
            selLocal.value = state.userLocalId || 'global';
            selLocal.disabled = true;
            selLocal.parentElement.classList.add('hidden'); // Ocultarlo para que no se confundan
        } else {
            selLocal.disabled = false;
            selLocal.parentElement.classList.remove('hidden');
        }
    }

    const cC = document.getElementById('div-campos-costos'); const cL = document.getElementById('div-limite-sabores');
    if (categoriaActual === 'vaso') { cC.classList.remove('hidden'); cL.classList.remove('hidden'); } 
    else if (categoriaActual === 'extra') { cC.classList.remove('hidden'); cL.classList.add('hidden'); document.getElementById('prod-limite').value = 0; } 
    else { cC.classList.add('hidden'); cL.classList.add('hidden'); document.getElementById('prod-precio').value = 0; document.getElementById('prod-costo').value = 0; document.getElementById('prod-limite').value = 0; }
    
    const m = document.getElementById('modal-producto'); m.classList.remove('hidden'); setTimeout(() => m.classList.remove('opacity-0'), 10);
}

export function renderInventarioUI(cat) {
    if (!listaInventarioEl) return;
    listaInventarioEl.innerHTML = '';
    
    // Filtro para que el vendedor solo vea lo Global y lo de su sede
    const items = state.productos.filter(p => {
        if (p.categoria !== cat) return false;
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
    });

    if (items.length === 0) { listaInventarioEl.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500 text-sm">No hay ítems en esta categoría.</td></tr>`; return; }
    
    items.forEach(p => {
        const stkStr = p.stock !== null && p.stock !== '' && p.stock !== undefined ? `<span class="font-mono text-emerald-400 font-bold">${p.stock}</span>` : '<i data-lucide="infinity" class="w-4 h-4 mx-auto text-slate-500"></i>';
        
        // Etiqueta visual para distinguir sedes
        let badgeLocal = '';
        if (p.localId && p.localId !== 'global') {
            const nLoc = state.locales.find(l => l.id === p.localId)?.nombre || 'Sede';
            badgeLocal = `<span class="ml-2 bg-slate-700 text-slate-300 text-[9px] px-1.5 py-0.5 rounded uppercase">${nLoc}</span>`;
        } else if (state.userRole === 'master' || state.userRole === 'admin') {
            badgeLocal = `<span class="ml-2 bg-sky-500/20 text-sky-400 text-[9px] px-1.5 py-0.5 rounded uppercase">Global</span>`;
        }

        const tr = document.createElement('tr'); tr.className = 'hover:bg-slate-800/50 transition-colors group';
        tr.innerHTML = `
            <td class="p-3 text-sm text-white font-bold">${p.nombre} ${badgeLocal}</td>
            <td class="p-3 text-xs text-slate-400 uppercase">${p.categoria}</td>
            <td class="p-3 text-sm text-sky-400 font-bold text-right">${p.categoria === 'sabor' ? '-' : formatMoney(p.precio)}</td>
            <td class="p-3 text-center">${stkStr}</td>
            <td class="p-3 text-center">
                <div class="flex justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onclick="window.editarProducto('${p.id}')" class="text-slate-400 hover:text-sky-400 bg-slate-900 border border-slate-700 p-1.5 rounded-lg"><i data-lucide="edit" class="w-4 h-4"></i></button>
                    <button onclick="window.eliminarProducto('${p.id}')" class="text-slate-400 hover:text-red-400 bg-slate-900 border border-slate-700 p-1.5 rounded-lg"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                </div>
            </td>
        `;
        listaInventarioEl.appendChild(tr);
    });
    if(window.lucide) window.lucide.createIcons();
}

async function guardarProducto(e) {
    e.preventDefault(); const id = document.getElementById('prod-id').value;
    let selectedLocal = document.getElementById('prod-local').value;
    if (state.userRole === 'vendedor') selectedLocal = state.userLocalId || 'global';

    const prodData = {
        nombre: document.getElementById('prod-nombre').value.trim(),
        categoria: categoriaActual,
        precio: parseFloat(document.getElementById('prod-precio').value) || 0,
        costo: parseFloat(document.getElementById('prod-costo').value) || 0,
        limite_sabores: parseInt(document.getElementById('prod-limite').value) || 0,
        stock: document.getElementById('prod-stock').value !== '' ? parseInt(document.getElementById('prod-stock').value) : null,
        localId: selectedLocal
    };

    try {
        const btn = document.getElementById('btn-guardar-prod'); btn.innerHTML = 'Guardando...'; btn.disabled = true;
        if(id) { const idx = state.productos.findIndex(x => x.id === id); if(idx !== -1) state.productos[idx] = { id, ...prodData }; renderInventarioUI(categoriaActual); updateDoc(doc(db, "productos", id), prodData).catch(console.error); } 
        else { const tempId = 'temp-' + Date.now(); state.productos.push({ id: tempId, ...prodData }); renderInventarioUI(categoriaActual); addDoc(collection(db, "productos"), prodData).then(ref => { const p = state.productos.find(x => x.id === tempId); if(p) p.id = ref.id; }); }
        document.getElementById('modal-producto').classList.add('hidden');
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Catálogo actualizado.', 'emerald');
        btn.innerHTML = '<i data-lucide="save" class="w-4 h-4 inline"></i> Guardar'; btn.disabled = false;
        if(window.lucide) lucide.createIcons(); renderProductosVenta();
    } catch(e) {}
}

function eliminarProducto(id) {
    if(window.mostrarConfirmacion) {
        window.mostrarConfirmacion("¿Eliminar este ítem del catálogo?", async () => {
            state.productos = state.productos.filter(p => p.id !== id);
            renderInventarioUI(categoriaActual); renderProductosVenta();
            await deleteDoc(doc(db, "productos", id));
            if(window.mostrarToast) window.mostrarToast('Eliminado', 'Producto borrado', 'sky');
        });
    }
}
