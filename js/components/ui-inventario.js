import { db, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, increment } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; 
import { formatMoney, getTodayDateStr } from '../utils/helpers.js';
import { renderProductosVenta } from './ui-ventas.js';

let listaInventarioEl; 
let categoriaActual = 'vaso';

export async function initInventario() {
    listaInventarioEl = document.getElementById('inventario-list');
    
    // Eventos Inventario Normal
    document.getElementById('form-insumo')?.addEventListener('submit', guardarProducto);
    document.getElementById('btn-nuevo-producto')?.addEventListener('click', abrirModalProducto);
    document.getElementById('btn-cerrar-modal-producto')?.addEventListener('click', () => {
        const m = document.getElementById('modal-producto'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300);
    });
    
    // Tabs de Categorías
    const tabs = document.querySelectorAll('#tabs-insumos button');
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.replace('text-emerald-500', 'text-slate-500'));
            tabs.forEach(t => t.classList.remove('border-emerald-500', 'border-b-2'));
            tab.classList.replace('text-slate-500', 'text-emerald-500'); 
            tab.classList.add('border-emerald-500', 'border-b-2');
            categoriaActual = ['vaso', 'sabor', 'extra'][index]; 
            renderInventarioUI(categoriaActual);
        });
    });

    // --- Eventos Ingreso de Mercadería (Stock) ---
    document.getElementById('btn-ingreso-stock')?.addEventListener('click', abrirModalIngresoStock);
    document.getElementById('btn-cerrar-modal-ingreso')?.addEventListener('click', () => {
        const m = document.getElementById('modal-ingreso-stock'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300);
    });
    document.getElementById('form-ingreso-stock')?.addEventListener('submit', procesarIngresoStock);

    // Funciones globales
    window.cargarInventarioDesdeFirebase = async () => {
        try {
            const s = await getDocs(collection(db, "productos")); 
            state.productos = [];
            s.forEach(d => state.productos.push({ id: d.id, ...d.data() }));
            renderInventarioUI(categoriaActual); 
            renderProductosVenta();
        } catch(e) { console.error("Error cargando inventario:", e); }
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

// ========================================================
// LÓGICA DE INGRESO DE STOCK (COMPRAS)
// ========================================================

function abrirModalIngresoStock() {
    const m = document.getElementById('modal-ingreso-stock');
    if (!m) return;
    
    document.getElementById('form-ingreso-stock').reset();
    
    const selProd = document.getElementById('ingreso-producto');
    const selLocal = document.getElementById('ingreso-local');
    
    // 1. Llenar Select de Productos (Solo los que manejan stock y pertenecen a la sede)
    let prodOpts = '<option value="" disabled selected>Selecciona un producto...</option>';
    const productosValidos = state.productos.filter(p => {
        // Ignoramos productos que tienen stock infinito (null)
        if (p.stock === null || p.stock === undefined) return false;
        // Filtro por local
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
    });
    
    // Agrupar visualmente
    productosValidos.forEach(p => {
        const sede = p.localId && p.localId !== 'global' ? `(${state.locales.find(l=>l.id===p.localId)?.nombre || 'Local'})` : '(Global)';
        prodOpts += `<option value="${p.id}">${p.nombre} - Stock actual: ${p.stock} ${sede}</option>`;
    });
    selProd.innerHTML = prodOpts || '<option value="" disabled>No hay productos que administren stock</option>';
    
    // 2. Llenar Select de Locales para asignar el Gasto
    if (selLocal) {
        if (state.userRole === 'admin' || state.userRole === 'master') {
            let locOpts = '<option value="ambas">Dividir Gasto en Todas las Sedes</option>';
            state.locales.forEach(l => locOpts += `<option value="${l.id}">Caja: ${l.nombre}</option>`);
            selLocal.innerHTML = locOpts;
            selLocal.parentElement.classList.remove('hidden');
        } else {
            selLocal.innerHTML = `<option value="${state.userLocalId || ''}">${state.userLocal || 'Mi Local'}</option>`;
            selLocal.parentElement.classList.add('hidden'); // Vendedor no puede elegir dónde cargar el gasto
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
    if(window.lucide) window.lucide.createIcons();

    const prodId = document.getElementById('ingreso-producto').value;
    const cant = parseInt(document.getElementById('ingreso-cantidad').value);
    const costo = parseFloat(document.getElementById('ingreso-costo').value);

    if (!prodId || isNaN(cant) || cant <= 0 || isNaN(costo) || costo < 0) {
        if(window.mostrarToast) window.mostrarToast('Error', 'Verifica los datos ingresados.', 'amber');
        btn.innerHTML = oT; btn.disabled = false;
        return;
    }

    const prod = state.productos.find(p => p.id === prodId);
    if (!prod) return;

    try {
        // 1. Sumar Stock en la base de datos
        await updateDoc(doc(db, "productos", prodId), { stock: increment(cant) });
        
        // 2. Registrar el Gasto automáticamente (Seguridad de Sede)
        if (costo > 0) {
            let localAfectado = document.getElementById('ingreso-local')?.value || '';
            let nombreL = 'Sede';

            // FIX: Forzamos la asignación al local del vendedor para evitar gastos huérfanos
            if (state.userRole !== 'master' && state.userRole !== 'admin') {
                localAfectado = state.userLocalId || '';
                nombreL = state.userLocal || 'Mi Local';
            } else {
                nombreL = localAfectado === 'ambas' ? 'Global' : (state.locales.find(x => x.id === localAfectado)?.nombre || 'Sede');
            }
            
            await addDoc(collection(db, "gastos"), { 
                monto: costo, 
                descripcion: `Stock: Ingreso de ${cant}x ${prod.nombre}`, 
                fechaStr: getTodayDateStr(), 
                timestamp: serverTimestamp(), 
                localId: localAfectado === 'ambas' ? '' : localAfectado, 
                localNombre: nombreL, 
                registradoPor: state.currentUser.email 
            });
        }

        // 3. Actualizar memoria local para que la UI se refresque sin recargar
        prod.stock += cant;
        renderInventarioUI(categoriaActual);
        renderProductosVenta(); // Para actualizar los badges de "Agotado" en la pantalla de ventas
        
        if(window.mostrarToast) window.mostrarToast('Ingreso Exitoso', `+${cant} a ${prod.nombre}.`, 'emerald');
        
        // Cerrar modal
        const m = document.getElementById('modal-ingreso-stock'); 
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300);
        
    } catch(err) {
        console.error("Error al procesar ingreso:", err);
        if(window.mostrarAlerta) window.mostrarAlerta('Error de Conexión', 'No se pudo registrar el ingreso de mercadería.', 'red');
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

    const cC = document.getElementById('div-campos-costos'); 
    const cL = document.getElementById('div-limite-sabores');
    
    if (categoriaActual === 'vaso') { 
        cC.classList.remove('hidden'); cL.classList.remove('hidden'); 
    } else if (categoriaActual === 'extra') { 
        cC.classList.remove('hidden'); cL.classList.add('hidden'); document.getElementById('prod-limite').value = 0; 
    } else { 
        cC.classList.add('hidden'); cL.classList.add('hidden'); document.getElementById('prod-precio').value = 0; document.getElementById('prod-costo').value = 0; document.getElementById('prod-limite').value = 0; 
    }
    
    const m = document.getElementById('modal-producto'); m.classList.remove('hidden'); setTimeout(() => m.classList.remove('opacity-0'), 10);
}

export function renderInventarioUI(cat) {
    if (!listaInventarioEl) return;
    listaInventarioEl.innerHTML = '';
    
    // Filtro Multi-Sede
    const items = state.productos.filter(p => {
        if (p.categoria !== cat) return false;
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
    });

    if (items.length === 0) { 
        listaInventarioEl.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-500 text-sm">No hay ítems registrados en esta sede.</td></tr>`; 
        return; 
    }
    
    items.forEach(p => {
        const stkStr = p.stock !== null && p.stock !== '' && p.stock !== undefined ? `<span class="font-mono text-emerald-500 font-bold">${p.stock}</span>` : '<i data-lucide="infinity" class="w-4 h-4 mx-auto text-slate-500"></i>';
        
        let badgeLocal = '';
        if (p.localId && p.localId !== 'global') {
            const nLoc = state.locales.find(l => l.id === p.localId)?.nombre || 'Sede';
            badgeLocal = `<span class="ml-2 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 text-[9px] px-1.5 py-0.5 rounded uppercase border border-slate-200 dark:border-slate-600">${nLoc}</span>`;
        } else if (state.userRole === 'master' || state.userRole === 'admin') {
            badgeLocal = `<span class="ml-2 bg-sky-50 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 border border-sky-200 dark:border-sky-500/30 text-[9px] px-1.5 py-0.5 rounded uppercase">Global</span>`;
        }

        const tr = document.createElement('tr'); 
        tr.className = 'hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group border-b border-slate-200 dark:border-slate-700/50 last:border-0';
        tr.innerHTML = `
            <td class="p-3 text-sm text-slate-800 dark:text-white font-bold">${p.nombre} ${badgeLocal}</td>
            <td class="p-3 text-xs text-slate-500 uppercase">${p.categoria}</td>
            <td class="p-3 text-sm text-sky-600 dark:text-sky-500 font-bold text-right">${p.categoria === 'sabor' ? '-' : formatMoney(p.precio)}</td>
            <td class="p-3 text-center">${stkStr}</td>
            <td class="p-3 text-center">
                <div class="flex justify-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onclick="window.editarProducto('${p.id}')" class="text-slate-400 hover:text-sky-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-sky-300 dark:hover:border-sky-500/50 p-1.5 rounded transition-colors"><i data-lucide="edit-2" class="w-4 h-4"></i></button>
                    <button onclick="window.eliminarProducto('${p.id}')" class="text-slate-400 hover:text-red-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-500/50 p-1.5 rounded transition-colors"><i data-lucide="trash" class="w-4 h-4"></i></button>
                </div>
            </td>
        `;
        listaInventarioEl.appendChild(tr);
    });
    if(window.lucide) window.lucide.createIcons();
}

async function guardarProducto(e) {
    e.preventDefault(); 
    const id = document.getElementById('prod-id').value;
    
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

    const btn = document.getElementById('btn-guardar-prod'); 
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline mr-1"></i> Guardando...'; 
    btn.disabled = true;
    if(window.lucide) window.lucide.createIcons();

    try {
        if(id) { 
            const idx = state.productos.findIndex(x => x.id === id); 
            if(idx !== -1) state.productos[idx] = { id, ...prodData }; 
            renderInventarioUI(categoriaActual); 
            updateDoc(doc(db, "productos", id), prodData).catch(console.error); 
        } else { 
            const tempId = 'temp-' + Date.now(); 
            state.productos.push({ id: tempId, ...prodData }); 
            renderInventarioUI(categoriaActual); 
            addDoc(collection(db, "productos"), prodData).then(ref => { 
                const p = state.productos.find(x => x.id === tempId); 
                if(p) p.id = ref.id; 
            }); 
        }
        
        document.getElementById('modal-producto').classList.add('hidden');
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Catálogo actualizado.', 'emerald');
        renderProductosVenta(); // Sincroniza la ventana de ventas inmediatamente
    } catch(e) {
        console.error(e);
        if(window.mostrarAlerta) window.mostrarAlerta("Error", "Ocurrió un problema al guardar el producto", "red");
    } finally {
        btn.innerHTML = originalText; 
        btn.disabled = false;
    }
}

function eliminarProducto(id) {
    if(window.mostrarConfirmacion) {
        window.mostrarConfirmacion("¿Eliminar definitivamente este ítem del catálogo?", async () => {
            try {
                // Borrado optimista de UI
                state.productos = state.productos.filter(p => p.id !== id);
                renderInventarioUI(categoriaActual); 
                renderProductosVenta();
                
                // Borrado en BD
                await deleteDoc(doc(db, "productos", id));
                if(window.mostrarToast) window.mostrarToast('Eliminado', 'Producto borrado de la nube.', 'sky');
            } catch(e) {
                console.error(e);
                window.cargarInventarioDesdeFirebase(); // Revertir si hay error
                if(window.mostrarToast) window.mostrarToast('Error', 'No se pudo eliminar', 'red');
            }
        });
    }
}
