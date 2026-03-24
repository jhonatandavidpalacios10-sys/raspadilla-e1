import { db, collection, getDocs, addDoc, updateDoc, deleteDoc, doc } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; import { formatMoney } from '../utils/helpers.js';
import { renderProductosVenta } from './ui-ventas.js';

let listaInventarioEl; let categoriaActual = 'vaso';

export async function initInventario() {
    listaInventarioEl = document.getElementById('inventario-list');
    
    // Estáticos
    document.getElementById('form-insumo')?.addEventListener('submit', guardarProducto);
    document.getElementById('btn-nuevo-producto')?.addEventListener('click', abrirModalProducto);
    document.getElementById('btn-cerrar-modal-producto')?.addEventListener('click', () => {
        document.getElementById('modal-producto').classList.add('hidden');
    });
    
    // Pestañas
    const tabs = document.querySelectorAll('#tabs-insumos button');
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.replace('text-emerald-400', 'text-slate-500'));
            tabs.forEach(t => t.classList.remove('border-emerald-400', 'border-b-2'));
            tab.classList.replace('text-slate-500', 'text-emerald-400'); tab.classList.add('border-emerald-400', 'border-b-2');
            categoriaActual = ['vaso', 'sabor', 'extra'][index]; renderInventarioUI(categoriaActual);
        });
    });

    // Delegación (Dinámico)
    listaInventarioEl?.addEventListener('click', e => {
        const btn = e.target.closest('button[data-action]'); if(!btn) return;
        if(btn.dataset.action === 'editar-producto') editarProducto(btn.dataset.id);
        else if(btn.dataset.action === 'eliminar-producto') eliminarProducto(btn.dataset.id);
    });

    await cargarInventarioDesdeFirebase();
}

function abrirModalProducto() {
    document.getElementById('form-insumo').reset(); document.getElementById('prod-id').value = '';
    adaptarCamposSegunCategoria(categoriaActual);
    const modal = document.getElementById('modal-producto'); modal.classList.remove('hidden'); setTimeout(() => modal.classList.remove('opacity-0'), 10);
}

function adaptarCamposSegunCategoria(cat) {
    const divCostos = document.getElementById('div-campos-costos'); const divLimites = document.getElementById('div-limite-sabores');
    if(!divCostos) return;
    if (cat === 'sabor') { divCostos.classList.add('hidden'); divLimites.classList.add('hidden'); document.getElementById('prod-precio').required = false; } 
    else { divCostos.classList.remove('hidden'); document.getElementById('prod-precio').required = true; if(cat === 'vaso') divLimites.classList.remove('hidden'); else divLimites.classList.add('hidden'); }
}

export async function cargarInventarioDesdeFirebase() {
    try {
        const snap = await getDocs(collection(db, "productos")); state.productos = [];
        snap.forEach((d) => state.productos.push({ id: d.id, ...d.data() }));
        renderInventarioUI(categoriaActual);
        renderProductosVenta();
    } catch (e) { console.error(e); }
}

function renderInventarioUI(filtroCategoria = 'vaso') {
    if (!listaInventarioEl) return;
    const filtrados = state.productos.filter(p => p.categoria === filtroCategoria);
    if (filtrados.length === 0) { listaInventarioEl.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-500 text-sm">Vacío.</td></tr>`; return; }
    
    let html = '';
    filtrados.forEach(p => {
        const stockInfo = p.stock !== null && p.stock !== undefined ? (p.stock <= 10 ? `<span class="text-red-400 font-bold">${p.stock}</span>` : `<span class="text-emerald-400">${p.stock}</span>`) : `<span class="text-slate-500">Ilimitado</span>`;
        const precioTxt = p.categoria === 'sabor' ? '-' : formatMoney(p.precio);
        html += `
        <tr class="bg-slate-800/50 hover:bg-slate-800 transition-colors border-b border-slate-700/50">
            <td class="p-3"><div class="flex items-center gap-2"><i data-lucide="${p.categoria === 'vaso' ? 'cup-soda' : p.categoria === 'sabor' ? 'droplet' : 'package'}" class="w-4 h-4 text-emerald-400"></i><span class="font-bold text-white text-sm">${p.nombre}</span></div></td>
            <td class="p-3 text-xs text-slate-400 capitalize">${p.categoria}</td>
            <td class="p-3 text-right font-black text-emerald-400">${precioTxt}</td>
            <td class="p-3 text-center text-sm">${stockInfo}</td>
            <td class="p-3 text-center">
                <button data-action="editar-producto" data-id="${p.id}" class="text-slate-400 hover:text-sky-400 p-1.5 bg-slate-900 rounded-lg mr-1"><i data-lucide="edit" class="w-4 h-4"></i></button>
                <button data-action="eliminar-producto" data-id="${p.id}" class="text-slate-500 hover:text-red-400 p-1.5 bg-slate-900 rounded-lg"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </td>
        </tr>`;
    });
    listaInventarioEl.innerHTML = html; if (window.lucide) lucide.createIcons();
}

function editarProducto(id) {
    const p = state.productos.find(x => x.id === id); if(!p) return;
    document.getElementById('prod-id').value = p.id; document.getElementById('prod-nombre').value = p.nombre; document.getElementById('prod-precio').value = p.precio || 0; document.getElementById('prod-costo').value = p.costo || 0; document.getElementById('prod-limite').value = p.limite === 999 ? '' : p.limite; document.getElementById('prod-stock').value = p.stock === null ? '' : p.stock;
    adaptarCamposSegunCategoria(p.categoria);
    const m = document.getElementById('modal-producto'); m.classList.remove('hidden'); setTimeout(() => m.classList.remove('opacity-0'), 10);
}

async function guardarProducto(e) {
    e.preventDefault();
    const id = document.getElementById('prod-id').value; const nombre = document.getElementById('prod-nombre').value.trim(); const cat = categoriaActual; 
    const precio = cat === 'sabor' ? 0 : (parseFloat(document.getElementById('prod-precio').value) || 0);
    const costo = cat === 'sabor' ? 0 : (parseFloat(document.getElementById('prod-costo').value) || 0);
    const limStr = document.getElementById('prod-limite').value; const limite = (cat === 'sabor' || cat === 'extra') ? 999 : (limStr ? parseInt(limStr) : 999);
    const stkStr = document.getElementById('prod-stock').value; const stock = (stkStr !== "" && cat !== 'sabor') ? parseInt(stkStr) : null;
    const prodData = { nombre, categoria: cat, precio, costo, limite, stock };
    
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
            renderInventarioUI(categoriaActual);
            renderProductosVenta();
            await deleteDoc(doc(db, "productos", id));
            if(window.mostrarToast) window.mostrarToast('Eliminado', 'Producto retirado.', 'emerald');
        });
    }
}
