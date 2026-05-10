import { db, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, increment, onSnapshot } from '../core/firebase-setup.js';
import { state } from '../core/store.js'; 
import { formatMoney, getTodayDateStr } from '../utils/helpers.js';
import { renderProductosVenta } from './ui-ventas.js';

let listaInventarioEl; 
let categoriaActual = 'vaso';
let unsubscribeInventario = null;
let inventarioInicializado = false;

// Estado temporal para construir los tamaños en el modal
let tamanosActuales = [];

export async function initInventario() {
    // Prevenir duplicación de eventos al rotar turnos
    if (inventarioInicializado) return;
    inventarioInicializado = true;

    listaInventarioEl = document.getElementById('inventario-list');
    
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
            
            // Estilo visual: Insumos resalta en ámbar, el resto en sky (que es nuestro nuevo rojo suave en CSS)
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
            if (unsubscribeInventario) unsubscribeInventario();
            try {
                unsubscribeInventario = onSnapshot(collection(db, "productos"), (snapshot) => {
                    state.productos = [];
                    snapshot.forEach(d => state.productos.push({ id: d.id, ...d.data() }));
                    renderInventarioUI(categoriaActual); 
                    if (window.renderProductosVenta) window.renderProductosVenta();
                    resolve();
                }, (error) => {
                    console.error("Error escuchando inventario:", error);
                    reject(error);
                });
            } catch(e) { 
                console.error("Error configurando inventario:", e); 
                reject(e);
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
    if(window.lucide) window.lucide.createIcons();
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

function procesarIngresoStock(e) {
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

    // LÓGICA OPTIMISTA
    try {
        prod.stock += cant;
        renderInventarioUI(categoriaActual);
        if (window.renderProductosVenta) window.renderProductosVenta(); 
        
        const m = document.getElementById('modal-ingreso-stock'); 
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300);

        if(window.mostrarToast) window.mostrarToast('Ingreso Exitoso', `+${cant} a ${prod.nombre}.`, 'emerald');

        const promesasBackground = [];
        promesasBackground.push(updateDoc(doc(db, "productos", prodId), { stock: increment(cant) }));
        
        if (costo > 0) {
            let localAfectado = document.getElementById('ingreso-local')?.value || '';
            let nombreL = 'Sede';

            if (state.userRole !== 'master' && state.userRole !== 'admin') {
                localAfectado = state.userLocalId || '';
                nombreL = state.userLocal || 'Mi Local';
            } else {
                nombreL = localAfectado === 'ambas' ? 'Global' : (state.locales.find(x => x.id === localAfectado)?.nombre || 'Sede');
            }
            
            promesasBackground.push(addDoc(collection(db, "gastos"), { 
                monto: costo, 
                descripcion: `Stock: Ingreso de ${cant}x ${prod.nombre}`, 
                fechaStr: getTodayDateStr(), 
                timestamp: serverTimestamp(), 
                localId: localAfectado === 'ambas' ? '' : localAfectado, 
                localNombre: nombreL, 
                registradoPor: state.currentUser.email 
            }));
        }

        Promise.all(promesasBackground).catch(err => {
            console.error("Error en background al procesar ingreso:", err);
            if(window.mostrarAlerta) window.mostrarAlerta('Error de Sincronización', 'No se pudo guardar completamente en la nube.', 'red');
        });
        
    } catch(err) {
        console.error("Error UI al procesar ingreso:", err);
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

export function renderInventarioUI(cat) {
    if (!listaInventarioEl) return;
    listaInventarioEl.innerHTML = '';
    
    const items = state.productos.filter(p => {
        if (p.categoria !== cat) return false;
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
    });

    if (items.length === 0) { 
        listaInventarioEl.innerHTML = `<tr><td colspan=\"5\" class=\"p-8 text-center text-slate-500 text-sm\">No hay ítems registrados en esta categoría.</td></tr>`; 
        return; 
    }
    
    items.forEach(p => {
        const stkStr = p.stock !== null && p.stock !== '' && p.stock !== undefined ? `<span class=\"font-mono text-emerald-500 font-bold\">${p.stock}</span>` : '<i data-lucide=\"infinity\" class=\"w-4 h-4 mx-auto text-slate-500\"></i>';
        
        let badgeLocal = '';
        if (p.localId && p.localId !== 'global') {
            const nLoc = state.locales.find(l => l.id === p.localId)?.nombre || 'Sede';
            badgeLocal = `<span class=\"ml-2 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 text-[9px] px-1.5 py-0.5 rounded uppercase border border-slate-200 dark:border-slate-600\">${nLoc}</span>`;
        } else if (state.userRole === 'master' || state.userRole === 'admin') {
            badgeLocal = `<span class=\"ml-2 bg-sky-50 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 border border-sky-200 dark:border-sky-500/30 text-[9px] px-1.5 py-0.5 rounded uppercase\">Global</span>`;
        }

        // Construir string de precio múltiple
        let priceStr = '-';
        if (p.categoria !== 'sabor') {
            if (p.tamanos && p.tamanos.length > 1) {
                const precios = p.tamanos.map(t => t.precio);
                const min = Math.min(...precios);
                const max = Math.max(...precios);
                priceStr = min === max ? formatMoney(min) : `<span class="text-xs text-slate-400">Desde</span> ${formatMoney(min)}`;
            } else if (p.tamanos && p.tamanos.length === 1) {
                priceStr = formatMoney(p.tamanos[0].precio);
            } else {
                priceStr = formatMoney(p.precio || 0);
            }
        }

        const tr = document.createElement('tr'); 
        tr.className = 'hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group border-b border-slate-200 dark:border-slate-700/50 last:border-0';
        tr.innerHTML = `
            <td class=\"p-3 text-sm text-slate-800 dark:text-white font-bold\">${p.nombre} ${badgeLocal}</td>
            <td class=\"p-3 text-xs text-slate-500 uppercase\">${p.categoria}</td>
            <td class=\"p-3 text-sm text-sky-600 dark:text-sky-500 font-bold text-right\">${priceStr}</td>
            <td class=\"p-3 text-center\">${stkStr}</td>
            <td class=\"p-3 text-center\">
                <div class=\"flex justify-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity\">
                    <button onclick=\"window.editarProducto('${p.id}')\" class=\"text-slate-400 hover:text-sky-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-sky-300 dark:hover:border-sky-500/50 p-1.5 rounded transition-colors\"><i data-lucide=\"edit-2\" class=\"w-4 h-4\"></i></button>
                    <button onclick=\"window.eliminarProducto('${p.id}')\" class=\"text-slate-400 hover:text-red-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-500/50 p-1.5 rounded transition-colors\"><i data-lucide=\"trash\" class=\"w-4 h-4\"></i></button>
                </div>
            </td>
        `;
        listaInventarioEl.appendChild(tr);
    });
    if(window.lucide) window.lucide.createIcons();
}

function guardarProducto(e) {
    e.preventDefault(); 
    
    // Validar tamaños
    if (tamanosActuales.length === 0) {
        if(window.mostrarToast) window.mostrarToast('Error', 'Debes añadir al menos un tamaño y precio.', 'amber');
        return;
    }

    const id = document.getElementById('prod-id').value;
    let selectedLocal = document.getElementById('prod-local').value;
    if (state.userRole === 'vendedor') selectedLocal = state.userLocalId || 'global';

    const prodData = {
        nombre: document.getElementById('prod-nombre').value.trim(),
        categoria: categoriaActual,
        tamanos: tamanosActuales,
        precio: tamanosActuales[0].precio || 0, // Fallback por compatibilidad con historiales viejos
        costo: parseFloat(document.getElementById('prod-costo').value) || 0,
        limite_sabores: parseInt(document.getElementById('prod-limite').value) || 0,
        stock: document.getElementById('prod-stock').value !== '' ? parseInt(document.getElementById('prod-stock').value) : null,
        localId: selectedLocal
    };

    const btn = document.getElementById('btn-guardar-prod'); 
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i data-lucide=\"loader-2\" class=\"w-4 h-4 animate-spin inline mr-1\"></i> Guardando...'; 
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
            }).catch(console.error); 
        }
        
        document.getElementById('modal-producto').classList.add('hidden');
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Catálogo actualizado.', 'emerald');
        if (window.renderProductosVenta) window.renderProductosVenta(); 
    } catch(e) {
        console.error(e);
        if(window.mostrarAlerta) window.mostrarAlerta("Error", "Ocurrió un problema al actualizar la UI", "red");
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
                renderInventarioUI(categoriaActual); 
                if (window.renderProductosVenta) window.renderProductosVenta();
                
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
