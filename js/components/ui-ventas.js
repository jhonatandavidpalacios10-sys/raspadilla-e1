import { db, doc, collection, serverTimestamp, increment, writeBatch } from '../core/firebase-setup.js';
import { state, clearCart } from '../core/store.js'; 
import { formatMoney, getTodayDateStr, generateTicketId } from '../utils/helpers.js';

let vasoActual = null; 
let saboresElegidos = [];
let ventasInicializado = false;
let categoriaActual = 'vaso'; // Por defecto

export function initVentas() {
    // CANDADO: Evita duplicación de eventos al cambiar de usuario
    if (ventasInicializado) return; 
    ventasInicializado = true;

    // --- Exponer funciones globalmente para el index.html ---\
    window.renderProductosVenta = renderProductosVenta; 
    window.abrirModalAjuste = abrirModalAjuste; 
    window.confirmarAjuste = confirmarAjuste;
    window.clearCart = clearCart;
    window.actualizarCarritoUI = actualizarCarritoUI;
    window.cerrarModalArmar = cerrarModalArmar;
    window.setCantidadChange = setCantidadChange; // Nueva función para UX del input
    window.cambiarCantidadBoton = cambiarCantidadBoton; // Nueva función para botones +/-
    window.quitarDelCarrito = quitarDelCarrito;
    window.procesarVenta = procesarVenta;
    window.agregarAlCarrito = agregarAlCarrito;
    window.abrirModalArmarVaso = abrirModalArmarVaso;
    window.toggleSabor = toggleSabor;
    window.confirmarVaso = confirmarVaso;

    window.toggleMetodoPago = function(val) {
        document.getElementById('area-vuelto')?.classList.toggle('hidden', val !== 'efectivo');
        document.getElementById('area-mixto')?.classList.toggle('hidden', val !== 'mixto');
        
        document.querySelectorAll('input[name="metodo_pago"]').forEach(radio => {
            const label = radio.closest('label');
            if (radio.value === val) { 
                label.classList.add('border-sky-500', 'bg-slate-800'); 
                label.classList.remove('border-slate-700', 'bg-slate-900'); 
            } else { 
                label.classList.remove('border-sky-500', 'bg-slate-800'); 
                label.classList.add('border-slate-700', 'bg-slate-900'); 
            }
        });
        calcularVuelto();
    };

    // --- EVENTOS BLINDADOS ---
    // FIX CRÍTICO: Prevenir recarga de página al usar la tecla Enter en Ajustes
    document.getElementById('form-ajuste')?.addEventListener('submit', (e) => {
        e.preventDefault();
        confirmarAjuste();
    });

    document.getElementById('btn-cobrar')?.addEventListener('click', procesarVenta);
    
    // Cálculo de vuelto en tiempo real
    document.getElementById('input-paga-con')?.addEventListener('input', calcularVuelto);
    document.getElementById('input-mixto-efectivo')?.addEventListener('input', calcularVuelto);
    document.getElementById('input-mixto-yape')?.addEventListener('input', calcularVuelto);

    // Tabs de Categorías en Ventas
    const tabsVentas = document.querySelectorAll('#tabs-ventas button');
    tabsVentas.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            tabsVentas.forEach(t => t.classList.replace('text-sky-500', 'text-slate-500'));
            tabsVentas.forEach(t => t.classList.remove('border-sky-500', 'border-b-2'));
            tab.classList.replace('text-slate-500', 'text-sky-500');
            tab.classList.add('border-sky-500', 'border-b-2');
            
            // FIX: Fallback seguro a la posición (index) si el HTML no tiene el atributo data-cat
            categoriaActual = tab.dataset.cat || ['vaso', 'sabor', 'extra'][index] || 'vaso';
            renderProductosVenta();
        });
    });

    // Carga inicial
    renderProductosVenta();
    actualizarCarritoUI();
}

export function renderProductosVenta() {
    // FIX CRÍTICO: Búsqueda flexible de IDs y Alerta en consola si falta
    const grid = document.getElementById('grid-productos-venta') || document.getElementById('productos-grid') || document.getElementById('lista-ventas');
    
    if (!grid) {
        console.error("⚠️ ALERTA CRÍTICA: No se encontró el contenedor de productos en el HTML. Se esperaba un div con id='grid-productos-venta'. Revisa tu index.html");
        return;
    }

    // FIX: Filtrar por categoría Y POR SEDE (Local)
    let filtrados = state.productos.filter(p => {
        if (p.categoria !== categoriaActual) return false;
        
        // Si es vendedor, solo ve productos globales o de su propio local
        if (state.userRole !== 'admin' && state.userRole !== 'master') {
            return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
        }
        return true; // Admin/Master ven todo el catálogo
    });

    // Búsqueda en tiempo real (si hubiera un input de búsqueda)
    const queryTerm = document.getElementById('buscador-ventas')?.value.toLowerCase() || '';
    if (queryTerm) {
        filtrados = filtrados.filter(p => p.nombre.toLowerCase().includes(queryTerm));
    }

    if (filtrados.length === 0) {
        grid.innerHTML = '<div class="col-span-full text-center text-slate-500 py-8">No hay productos en esta categoría.</div>';
        return;
    }

    grid.innerHTML = filtrados.map(p => {
        const outOfStock = p.stock !== null && p.stock <= 0;
        const color = categoriaActual === 'vaso' ? 'sky' : (categoriaActual === 'raspadilla' ? 'emerald' : 'amber');
        const clickAction = outOfStock ? '' : (p.categoria === 'vaso' ? `abrirModalArmarVaso('${p.id}')` : `agregarAlCarrito('${p.id}', '${p.nombre.replace(/'/g, "\\'")}', ${p.precio}, '${p.categoria}')`);
        
        return `
        <div onclick="${clickAction}" class="bg-white dark:bg-slate-800 rounded-xl border ${outOfStock ? 'border-red-300 dark:border-red-900 opacity-60 cursor-not-allowed' : 'border-slate-200 dark:border-slate-700 cursor-pointer hover:border-'+color+'-400 hover:shadow-md'} p-3 flex flex-col justify-between transition-all select-none relative overflow-hidden group">
            ${outOfStock ? '<div class="absolute top-2 right-2 bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider z-10">Agotado</div>' : ''}
            
            <div class="font-bold text-slate-800 dark:text-white text-sm leading-tight group-hover:text-${color}-500 transition-colors">${p.nombre}</div>
            
            <div class="mt-3 flex justify-between items-end">
                <span class="text-${color}-500 font-black text-lg">${formatMoney(p.precio)}</span>
                ${p.stock !== null ? `<span class="text-[10px] ${outOfStock ? 'text-red-500' : 'text-slate-400'} font-medium bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded-md">Stock: ${p.stock}</span>` : ''}
            </div>
        </div>
        `;
    }).join('');
}

// --- LÓGICA DE ARMADO DE VASOS ---
function abrirModalArmarVaso(id) {
    const p = state.productos.find(x => x.id === id);
    if (!p) return;
    
    vasoActual = p;
    saboresElegidos = [];
    
    document.getElementById('modal-armar-vaso-title').textContent = `Armar ${p.nombre}`;
    document.getElementById('modal-armar-vaso-limite').textContent = `Máximo ${p.limiteSabores || 1} sabores`;
    
    renderSaboresDisponibles();
    
    const modal = document.getElementById('modal-armar-vaso');
    modal.classList.remove('hidden');
    setTimeout(() => modal.classList.remove('opacity-0'), 10);
}

function renderSaboresDisponibles() {
    const grid = document.getElementById('grid-sabores-vaso');
    const sabores = state.productos.filter(p => p.categoria === 'sabor');
    
    grid.innerHTML = sabores.map(s => {
        const isSelected = saboresElegidos.find(x => x.id === s.id);
        const outOfStock = s.stock !== null && s.stock <= 0;
        
        return `
        <div onclick="${outOfStock ? '' : `toggleSabor('${s.id}')`}" class="relative p-2 border-2 rounded-lg cursor-pointer transition-all text-center ${outOfStock ? 'border-red-200 bg-red-50 opacity-50' : (isSelected ? 'border-sky-500 bg-sky-50 dark:bg-sky-500/10 scale-[0.98]' : 'border-slate-200 dark:border-slate-700 hover:border-sky-300')}">
            <div class="font-bold text-xs ${isSelected ? 'text-sky-600 dark:text-sky-400' : 'text-slate-700 dark:text-slate-300'}">${s.nombre}</div>
            ${outOfStock ? '<div class="text-[9px] text-red-500 font-bold mt-1">AGOTADO</div>' : ''}
            ${isSelected ? '<div class="absolute -top-2 -right-2 bg-sky-500 text-white rounded-full p-0.5 shadow-sm"><i data-lucide="check" class="w-3 h-3"></i></div>' : ''}
        </div>`;
    }).join('');
    
    if(window.lucide) window.lucide.createIcons();
}

function toggleSabor(id) {
    if (!vasoActual) return;
    const limite = parseInt(vasoActual.limiteSabores) || 1;
    
    const idx = saboresElegidos.findIndex(x => x.id === id);
    if (idx >= 0) {
        saboresElegidos.splice(idx, 1); // Quitar si ya está
    } else {
        if (saboresElegidos.length >= limite) {
            if(window.mostrarToast) window.mostrarToast('Límite Alcanzado', `Este vaso solo permite ${limite} sabores.`, 'amber');
            return;
        }
        const s = state.productos.find(x => x.id === id);
        if (s) saboresElegidos.push({ id: s.id, nombre: s.nombre });
    }
    renderSaboresDisponibles();
}

function confirmarVaso() {
    if (!vasoActual) return;
    if (saboresElegidos.length === 0) {
        if(window.mostrarAlerta) window.mostrarAlerta('Aviso', 'Debes elegir al menos un sabor para el vaso.', 'amber');
        return;
    }
    
    // El ID en el carrito será único basado en los sabores para que no se agrupen vasos distintos
    const subId = saboresElegidos.map(s => s.id).sort().join('-');
    const cartItemId = `${vasoActual.id}_${subId}`;
    
    const descSabores = saboresElegidos.map(s => s.nombre).join(' + ');
    const nombreFinal = `${vasoActual.nombre} (${descSabores})`;
    
    agregarAlCarrito(cartItemId, nombreFinal, vasoActual.precio, 'vaso', vasoActual.id, saboresElegidos);
    cerrarModalArmar();
}

function cerrarModalArmar() {
    const m = document.getElementById('modal-armar-vaso');
    m.classList.add('opacity-0');
    setTimeout(() => { m.classList.add('hidden'); vasoActual = null; saboresElegidos = []; }, 300);
}
// -------------------------------

function agregarAlCarrito(id, nombre, precio, tipo, idRealProducto = null, saboresDetails = []) {
    const realId = idRealProducto || id;
    
    // Verificar stock maestro si no es un ajuste
    if (id !== 'AJUSTE') {
        const prodDb = state.productos.find(p => p.id === realId);
        if (prodDb && prodDb.stock !== null) {
            // Contar cuántos ya hay en el carrito de este producto raíz
            const enCarrito = state.carrito.filter(c => c.productoId === realId).reduce((sum, item) => sum + item.cantidad, 0);
            if (enCarrito >= prodDb.stock) {
                if(window.mostrarToast) window.mostrarToast('Stock Insuficiente', 'No queda más stock de este producto.', 'red');
                return;
            }
        }
    }

    const ex = state.carrito.find(x => x.id === id);
    if (ex) {
        ex.cantidad += 1;
    } else {
        state.carrito.push({ 
            id, 
            productoId: realId, 
            nombre, 
            precio: parseFloat(precio), 
            cantidad: 1, 
            tipo, 
            sabores: saboresDetails 
        });
    }
    actualizarCarritoUI();
}

// FIX DE UX: Modificar cantidad con botones (Refresco instantáneo)
function cambiarCantidadBoton(id, delta) {
    const item = state.carrito.find(x => x.id === id);
    if (!item) return;
    
    const nuevaCant = item.cantidad + delta;
    if (nuevaCant <= 0) {
        quitarDelCarrito(id);
        return;
    }

    // Verificar límite de stock
    if (item.productoId !== 'AJUSTE') {
        const prodDb = state.productos.find(p => p.id === item.productoId);
        if (prodDb && prodDb.stock !== null) {
            // Sumar todas las variaciones de este producto en el carrito
            const totalEnCarrito = state.carrito.filter(c => c.productoId === item.productoId && c.id !== item.id).reduce((s, i) => s + i.cantidad, 0) + nuevaCant;
            if (totalEnCarrito > prodDb.stock) {
                if(window.mostrarToast) window.mostrarToast('Límite', 'Stock máximo alcanzado.', 'amber');
                return;
            }
        }
    }

    item.cantidad = nuevaCant;
    actualizarCarritoUI();
}

// FIX DE UX: Modificar cantidad tecleando (Evita saltos del cursor)
function setCantidadChange(id, valStr) {
    const val = parseInt(valStr);
    if (isNaN(val) || val <= 0) {
        quitarDelCarrito(id);
        return;
    }
    
    const item = state.carrito.find(x => x.id === id);
    if (!item) return;

    // Verificar límite de stock
    if (item.productoId !== 'AJUSTE') {
        const prodDb = state.productos.find(p => p.id === item.productoId);
        if (prodDb && prodDb.stock !== null) {
            const otrosEnCarrito = state.carrito.filter(c => c.productoId === item.productoId && c.id !== item.id).reduce((s, i) => s + i.cantidad, 0);
            if ((otrosEnCarrito + val) > prodDb.stock) {
                if(window.mostrarToast) window.mostrarToast('Límite', 'Supera el stock actual. Se ajustará al máximo disponible.', 'amber');
                item.cantidad = prodDb.stock - otrosEnCarrito;
                actualizarCarritoUI();
                return;
            }
        }
    }

    item.cantidad = val;
    actualizarCarritoUI();
}

function quitarDelCarrito(id) {
    state.carrito = state.carrito.filter(x => x.id !== id);
    actualizarCarritoUI();
}

export function actualizarCarritoUI() {
    const list = document.getElementById('carrito-items'); 
    const emp = document.getElementById('carrito-vacio'); 
    const btn = document.getElementById('btn-procesar-cobro');
    const elTotal = document.getElementById('carrito-total');
    
    // POSIBLES IDS ANTIGUOS (Blindaje extra por si acaso)
    const btnCobrar = document.getElementById('btn-cobrar');
    const elBtnTotal = document.getElementById('btn-cobrar-total');
    
    if(!list) return;
    
    const activeElementId = document.activeElement?.dataset?.id;

    let t = 0; let html = '';
    state.carrito.forEach(i => {
        t += i.precio * i.cantidad;
        const color = i.precio < 0 ? 'text-red-500' : 'text-emerald-500';
        const btnYapeClass = i.isYape ? 'bg-purple-100 text-purple-600 border-purple-300 dark:bg-purple-500/20 dark:text-purple-400' : 'bg-slate-200 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-400';

        html += `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-2.5 shadow-sm relative group mb-2">
            <div class="flex justify-between items-start">
                <div class="flex-1 pr-2">
                    <h4 class="text-xs font-bold text-slate-800 dark:text-white leading-tight">${i.nombre}</h4>
                    ${i.sabores.length > 0 ? `<p class="text-[9px] text-sky-500 font-medium mt-0.5">${i.sabores.join(', ')}</p>` : ''}
                    ${i.productoId !== 'AJUSTE' ? `<div class="flex items-center bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5 border border-slate-300 dark:border-slate-600 w-fit mt-1.5"><button data-action="restar" data-id="${i.cartId}" class="w-6 h-5 flex items-center justify-center text-slate-500 hover:text-slate-800 dark:hover:text-white"><i data-lucide="minus" class="w-3 h-3"></i></button><input type="number" data-id="${i.cartId}" value="${i.cantidad}" class="w-7 text-center bg-transparent text-xs font-bold text-slate-800 dark:text-white focus:outline-none hide-arrows"><button data-action="sumar" data-id="${i.cartId}" class="w-6 h-5 flex items-center justify-center text-slate-500 hover:text-slate-800 dark:hover:text-white"><i data-lucide="plus" class="w-3 h-3"></i></button></div>` : ''}
                </div>
                <div class="text-right flex flex-col items-end justify-between">
                    <p class="font-bold ${color} text-sm">${formatMoney(i.precio * i.cantidad)}</p>
                    <div class="flex items-center gap-1.5 mt-2">
                        <button data-action="toggle-yape" data-id="${i.cartId}" class="px-2 py-0.5 rounded text-[9px] font-bold border transition-colors flex items-center gap-1 ${btnYapeClass}" title="Pagar con Yape">Yape</button>
                        <button data-action="eliminar" data-id="${i.cartId}" class="text-slate-400 hover:text-red-500 p-0.5"><i data-lucide="trash" class="w-3.5 h-3.5"></i></button>
                    </div>
                </div>
            </div>
        </div>`;
    });

    if(state.carrito.length > 0) { 
        if(emp) emp.classList.add('hidden'); 
        list.classList.remove('hidden'); 
        list.innerHTML = html; 
        if(btn) { btn.classList.remove('opacity-50', 'cursor-not-allowed'); btn.disabled = false; }
        if(btnCobrar) { btnCobrar.classList.remove('opacity-50', 'cursor-not-allowed'); btnCobrar.disabled = false; }
    } else { 
        if(emp) emp.classList.remove('hidden'); 
        list.classList.add('hidden'); 
        list.innerHTML = ''; 
        if(btn) { btn.classList.add('opacity-50', 'cursor-not-allowed'); btn.disabled = true; }
        if(btnCobrar) { btnCobrar.classList.add('opacity-50', 'cursor-not-allowed'); btnCobrar.disabled = true; }
    }
    
    // FIX CRÍTICO: Validaciones anti-nulos obligatorias
    if(elTotal) elTotal.textContent = formatMoney(t); 
    if(elBtnTotal) elBtnTotal.textContent = formatMoney(t); 

    const hasYape = state.carrito.some(c => c.isYape); 
    const hasEfe = state.carrito.some(c => !c.isYape);
    
    const rMixto = document.getElementById('radio-mixto');
    const rYape = document.getElementById('radio-yape');
    if (hasYape) {
        if (hasEfe && rMixto && !rMixto.checked) { 
            rMixto.checked = true; 
            if(typeof window.toggleMetodoPago === 'function') window.toggleMetodoPago('mixto'); 
        } else if (!hasEfe && rYape && !rYape.checked) { 
            rYape.checked = true; 
            if(typeof window.toggleMetodoPago === 'function') window.toggleMetodoPago('yape'); 
        } else if (rMixto && rMixto.checked) { 
            if(typeof window.toggleMetodoPago === 'function') window.toggleMetodoPago('mixto'); 
        }
    }

    if(window.lucide) window.lucide.createIcons(); 
    calcularVuelto();

    if (activeElementId) {
        const inputToRefocus = document.querySelector(`input[data-id="${activeElementId}"]`);
        if (inputToRefocus) { 
            inputToRefocus.focus(); 
            const val = inputToRefocus.value; 
            inputToRefocus.value = ''; 
            inputToRefocus.value = val; 
        }
    }
}

function calcularVuelto() {
    const t = state.carrito.reduce((s, i) => s + (i.precio * i.cantidad), 0);
    
    // Validar de forma segura el método seleccionado
    const methodEl = document.querySelector('input[name="metodo_pago"]:checked');
    const checkedMethod = methodEl ? methodEl.value : 'efectivo';
    
    if(checkedMethod === 'efectivo') {
        const inputPagaCon = document.getElementById('input-paga-con');
        const txtVuelto = document.getElementById('txt-vuelto');
        
        const pc = parseFloat(inputPagaCon?.value) || 0; 
        const v = pc - t;
        
        // FIX CRÍTICO: Validar existencia en el DOM
        if (txtVuelto) {
            txtVuelto.textContent = v >= 0 ? formatMoney(v) : 'S/ 0.00'; 
            if(v < 0) {
                txtVuelto.classList.add('text-red-500');
            } else {
                txtVuelto.classList.remove('text-red-500');
            }
        }
    }
}

function abrirModalAjuste(tipo) {
    document.getElementById('modal-ajuste-tipo').textContent = tipo;
    document.getElementById('input-ajuste-motivo').value = '';
    document.getElementById('input-ajuste-monto').value = '';
    
    const m = document.getElementById('modal-ajuste');
    m.classList.remove('hidden');
    setTimeout(() => m.classList.remove('opacity-0'), 10);
    setTimeout(() => document.getElementById('input-ajuste-monto').focus(), 300);
}

function confirmarAjuste() {
    const tipo = document.getElementById('modal-ajuste-tipo').textContent;
    let motivo = document.getElementById('input-ajuste-motivo').value.trim() || (tipo === 'Descuento' ? 'Descuento Especial' : 'Cargo Extra');
    let monto = parseFloat(document.getElementById('input-ajuste-monto').value);

    if (isNaN(monto) || monto <= 0) {
        if(window.mostrarAlerta) window.mostrarAlerta('Error', 'Ingrese un monto válido mayor a 0', 'red');
        return;
    }

    if (tipo === 'Descuento') {
        monto = -monto; // Negativo para restar del total
        motivo = `[DTO] ${motivo}`;
    } else {
        motivo = `[CARGO] ${motivo}`;
    }

    agregarAlCarrito(`AJUSTE_${Date.now()}`, motivo, monto, 'ajuste', 'AJUSTE');

    const m = document.getElementById('modal-ajuste');
    m.classList.add('opacity-0');
    setTimeout(() => m.classList.add('hidden'), 300);
}

async function procesarVenta() {
    if (state.carrito.length === 0) return;
    const total = state.carrito.reduce((s, c) => s + (c.precio * c.cantidad), 0);
    
    if (total < 0) {
        if(window.mostrarAlerta) window.mostrarAlerta('Aviso', 'El ticket no puede tener un total negativo.', 'amber');
        return;
    }

    const btn = document.getElementById('btn-cobrar');
    const ot = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin mx-auto"></i>';
    btn.disabled = true;

    try {
        const localId = state.userLocalId || 'general';
        const fStr = getTodayDateStr();
        const tId = generateTicketId();
        const mp = document.querySelector('input[name="metodo_pago"]:checked').value;
        
        let pEfe = 0, pYap = 0;
        
        if (mp === 'efectivo') {
            pEfe = total;
        } else if (mp === 'yape') {
            pYap = total;
        } else if (mp === 'mixto') {
            const mEfeIn = parseFloat(document.getElementById('input-mixto-efectivo').value) || 0;
            const mYapIn = parseFloat(document.getElementById('input-mixto-yape').value) || 0;
            
            if ((mEfeIn + mYapIn) < total) {
                if(window.mostrarAlerta) window.mostrarAlerta('Error', 'La suma de montos mixtos es menor al total.', 'red');
                btn.innerHTML = ot; btn.disabled = false; return;
            }
            
            pYap = mYapIn; // Asumimos que Yape es exacto, el vuelto sale del Efectivo
            pEfe = total - pYap; 
        }

        const venta = {
            ticketId: tId,
            items: state.carrito.map(c => ({
                id: c.id,
                productoId: c.productoId,
                nombre: c.nombre,
                precio: c.precio,
                cantidad: c.cantidad,
                tipo: c.tipo || 'normal',
                sabores: c.sabores || []
            })),
            total,
            pago_efectivo: pEfe,
            pagoEfectivo: pEfe,
            pago_yape: pYap,
            pagoYape: pYap,
            metodo_pago: mp,
            metodoFinal: mp, // Clave para la auditoría y caja diaria
            fechaStr: fStr,
            fechaHora: Date.now(),
            timestamp: serverTimestamp(),
            localId,
            localNombre: state.userLocal || 'Local Desconocido',
            cajeroEmail: state.currentUser?.email || 'Desconocido',
            creadoPor: state.currentUser?.username || state.currentUser?.email || 'Desconocido',
            estado: 'listo'
        };

        const bt = writeBatch(db);
        
        // 1. Crear documento de Venta
        bt.set(doc(collection(db, "ventas")), venta);
        
        // 2. Actualizar Caja Diaria (Upsert)
        const cajaRef = doc(db, "caja_diaria", `${fStr}_${localId}`);
        bt.set(cajaRef, {
            total_ingresos: increment(total),
            total_efectivo: increment(pEfe),
            total_yape: increment(pYap),
            cantidad_ventas: increment(1)
        }, { merge: true });

        // 3. Descontar Stock de Productos Reales
        state.carrito.forEach(i => { 
            if(i.productoId !== 'AJUSTE') { 
                const p = state.productos.find(x => x.id === i.productoId); 
                if(p && p.stock !== null) bt.update(doc(db, "productos", p.id), { stock: increment(-i.cantidad) }); 
            } 
        });
        
        // Enviar a la nube en background (Optimistic UI)
        bt.commit().catch(err => console.error("Error en batch de venta:", err));
        
        // --- LIMPIEZA INMEDIATA DE UI ---
        // Sincronizar stock localmente para UI instantánea
        state.carrito.forEach(item => {
            if(item.productoId !== 'AJUSTE') {
                const prod = state.productos.find(x => x.id === item.productoId);
                if (prod && prod.stock !== null) prod.stock -= item.cantidad;
            }
        });

        window.clearCart(); 
        actualizarCarritoUI(); 
        renderProductosVenta();
        
        document.getElementById('input-paga-con').value = ''; 
        document.getElementById('input-mixto-efectivo').value = ''; 
        document.getElementById('input-mixto-yape').value = ''; 
        document.getElementById('txt-vuelto').textContent = 'S/ 0.00';
        
        if(window.mostrarToast) window.mostrarToast('Venta Exitosa', `Ticket #${tId.split('-')[1]} procesado correctamente.`, 'emerald');

    } catch (err) {
        console.error("Fallo general en venta:", err);
        if(window.mostrarAlerta) window.mostrarAlerta('Error', 'No se pudo completar la venta. Revisa tu conexión.', 'red');
    } finally {
        btn.innerHTML = ot;
        btn.disabled = false;
        if(window.lucide) window.lucide.createIcons();
    }
}
