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
    tabsVentas.forEach(tab => {
        tab.addEventListener('click', () => {
            tabsVentas.forEach(t => t.classList.replace('text-sky-500', 'text-slate-500'));
            tabsVentas.forEach(t => t.classList.remove('border-sky-500', 'border-b-2'));
            tab.classList.replace('text-slate-500', 'text-sky-500');
            tab.classList.add('border-sky-500', 'border-b-2');
            categoriaActual = tab.dataset.cat;
            renderProductosVenta();
        });
    });

    // Carga inicial
    renderProductosVenta();
    actualizarCarritoUI();
}

export function renderProductosVenta() {
    const grid = document.getElementById('grid-productos-venta');
    if (!grid) return;

    // Filtrar por categoría
    let filtrados = state.productos.filter(p => p.categoria === categoriaActual);

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
    const cont = document.getElementById('carrito-items');
    const elTotal = document.getElementById('carrito-total');
    const elBtnTotal = document.getElementById('btn-cobrar-total');
    const btnCobrar = document.getElementById('btn-cobrar');
    
    if (!cont) return;

    if (state.carrito.length === 0) {
        cont.innerHTML = `
        <div class="h-full flex flex-col items-center justify-center text-slate-400 space-y-4 opacity-50 py-10">
            <i data-lucide="shopping-basket" class="w-16 h-16"></i>
            <p class="font-medium text-sm">El carrito está vacío</p>
        </div>`;
        elTotal.textContent = 'S/ 0.00';
        elBtnTotal.textContent = 'S/ 0.00';
        btnCobrar.disabled = true;
        btnCobrar.classList.add('opacity-50', 'cursor-not-allowed');
        if(window.lucide) window.lucide.createIcons();
        calcularVuelto();
        return;
    }

    btnCobrar.disabled = false;
    btnCobrar.classList.remove('opacity-50', 'cursor-not-allowed');

    let total = 0;
    cont.innerHTML = state.carrito.map(c => {
        const sub = c.precio * c.cantidad;
        total += sub;
        const isAjuste = c.productoId === 'AJUSTE';
        const colorTitle = isAjuste ? (c.precio < 0 ? 'text-red-500' : 'text-sky-500') : 'text-slate-800 dark:text-white';
        
        return `
        <div class="p-3 bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700/50 flex justify-between items-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
            <div class="flex-1 min-w-0">
                <p class="font-bold text-sm ${colorTitle} truncate pr-2">${c.nombre}</p>
                <p class="text-[11px] font-medium text-slate-500 mt-0.5">${formatMoney(c.precio)} c/u</p>
            </div>
            
            <div class="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-900 rounded-lg p-1">
                ${!isAjuste ? `
                    <button onclick="cambiarCantidadBoton('${c.id}', -1)" class="w-7 h-7 flex justify-center items-center rounded-md bg-white dark:bg-slate-800 text-slate-600 shadow-sm border border-slate-200 dark:border-slate-700 hover:bg-slate-50 active:scale-95 transition-all">
                        <i data-lucide="minus" class="w-3 h-3"></i>
                    </button>
                    <!-- FIX UX: onchange en lugar de oninput para evitar saltos al teclear -->
                    <input type="number" value="${c.cantidad}" onchange="setCantidadChange('${c.id}', this.value)" class="w-9 h-7 text-center bg-transparent font-bold text-sm text-slate-800 dark:text-white hide-arrows focus:outline-none focus:ring-2 focus:ring-sky-500 rounded" />
                    <button onclick="cambiarCantidadBoton('${c.id}', 1)" class="w-7 h-7 flex justify-center items-center rounded-md bg-white dark:bg-slate-800 text-slate-600 shadow-sm border border-slate-200 dark:border-slate-700 hover:bg-slate-50 active:scale-95 transition-all">
                        <i data-lucide="plus" class="w-3 h-3"></i>
                    </button>
                ` : `
                    <div class="px-2 font-bold text-sm">1</div>
                `}
            </div>
            
            <div class="text-right ml-2 min-w-[60px]">
                <p class="font-black text-sm text-slate-800 dark:text-white">${formatMoney(sub)}</p>
                <button onclick="quitarDelCarrito('${c.id}')" class="text-[10px] text-red-400 hover:text-red-600 font-medium mt-1 flex items-center justify-end w-full">
                    <i data-lucide="trash" class="w-3 h-3 mr-0.5"></i> Quitar
                </button>
            </div>
        </div>
        `;
    }).join('');

    elTotal.textContent = formatMoney(total);
    elBtnTotal.textContent = formatMoney(total);
    
    if(window.lucide) window.lucide.createIcons();
    calcularVuelto();
}

function calcularVuelto() {
    const mp = document.querySelector('input[name="metodo_pago"]:checked')?.value || 'efectivo';
    const total = state.carrito.reduce((s, c) => s + (c.precio * c.cantidad), 0);
    const elVuelto = document.getElementById('txt-vuelto');
    
    if (mp === 'efectivo') {
        const pagaCon = parseFloat(document.getElementById('input-paga-con').value) || 0;
        const vuelto = pagaCon - total;
        if (elVuelto) elVuelto.textContent = vuelto > 0 ? formatMoney(vuelto) : 'S/ 0.00';
    } else if (mp === 'mixto') {
        const mEfe = parseFloat(document.getElementById('input-mixto-efectivo').value) || 0;
        const mYap = parseFloat(document.getElementById('input-mixto-yape').value) || 0;
        const suma = mEfe + mYap;
        const vuelto = suma - total;
        if (elVuelto) elVuelto.textContent = vuelto > 0 ? formatMoney(vuelto) : 'S/ 0.00';
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
