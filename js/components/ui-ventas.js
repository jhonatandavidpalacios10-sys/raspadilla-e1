import { db, doc, collection, serverTimestamp, increment, writeBatch } from '../core/firebase-setup.js';
import { state, clearCart } from '../core/store.js'; 
import { formatMoney, getTodayDateStr, generateTicketId } from '../utils/helpers.js';

let vasoActual = null; 
let saboresElegidos = [];
let ventasInicializado = false;

export function initVentas() {
    if (ventasInicializado) return; 
    ventasInicializado = true;

    // --- Exponer funciones globalmente para el index.html ---
    window.renderProductosVenta = renderProductosVenta; 
    window.abrirModalAjuste = abrirModalAjuste; 
    window.confirmarAjuste = confirmarAjuste;
    window.clearCart = clearCart;
    window.actualizarCarritoUI = actualizarCarritoUI;
    window.cerrarModalArmar = cerrarModalArmar;

    window.toggleMetodoPago = function(val) {
        document.getElementById('area-vuelto').classList.toggle('hidden', val !== 'efectivo');
        document.getElementById('area-mixto').classList.toggle('hidden', val !== 'mixto');
        
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
        
        if (val === 'mixto') {
            const hasYapeItem = state.carrito.some(i => i.isYape);
            if (hasYapeItem) {
                let sumYape = 0; let sumEfe = 0;
                state.carrito.forEach(i => { 
                    if (i.isYape) sumYape += i.precio * i.cantidad; 
                    else sumEfe += i.precio * i.cantidad; 
                });
                document.getElementById('input-mixto-yape').value = sumYape > 0 ? sumYape.toFixed(2) : '';
                document.getElementById('input-mixto-efectivo').value = sumEfe > 0 ? sumEfe.toFixed(2) : '';
            }
        }
        calcularVuelto();
    };

    window.toggleYapeItem = function(id) {
        const it = state.carrito.find(c => c.cartId === id);
        if (it) { it.isYape = !it.isYape; actualizarCarritoUI(); }
    };

    // --- Delegación de eventos para Grillas y Carrito ---
    const grid = document.getElementById('productos-venta-grid');
    if (grid) {
        grid.addEventListener('click', e => {
            const card = e.target.closest('.producto-card');
            if (!card || card.classList.contains('opacity-50')) return;
            if (card.dataset.categoria === 'vaso') iniciarArmadoVaso(card.dataset.id);
            else agregarExtra(card.dataset.id);
        });
    }

    const gridSabores = document.getElementById('builder-sabores');
    if (gridSabores) {
        gridSabores.addEventListener('click', e => {
            const btn = e.target.closest('.sabor-btn');
            if (!btn || btn.classList.contains('opacity-50')) return;
            toggleSabor(btn.dataset.nombre);
        });
    }

    const listCarrito = document.getElementById('carrito-items');
    if (listCarrito) {
        listCarrito.addEventListener('click', e => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const id = btn.dataset.id;
            if (btn.dataset.action === 'sumar') modificarCantidad(id, 1);
            if (btn.dataset.action === 'restar') modificarCantidad(id, -1);
            if (btn.dataset.action === 'eliminar') eliminarItemCarrito(id);
            if (btn.dataset.action === 'toggle-yape') window.toggleYapeItem(id);
        });

        listCarrito.addEventListener('input', e => {
            if(e.target.tagName === 'INPUT') setCantidad(e.target.dataset.id, e.target.value);
        });
    }

    // --- Botones directos ---
    document.getElementById('btn-builder-add')?.addEventListener('click', confirmarVasoAlCarrito);
    document.getElementById('btn-procesar-cobro')?.addEventListener('click', procesarCobroFinal);
    
    // --- Escuchadores de inputs de montos ---
    ['input-paga-con', 'input-mixto-yape', 'input-mixto-efectivo'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', calcularVuelto);
    });
    
    // --- Filtros de Búsqueda ---
    document.getElementById('searchInput')?.addEventListener('input', renderProductosVenta);
    document.getElementById('posCategoryFilter')?.addEventListener('change', renderProductosVenta);

    // FIX: Forzar el primer renderizado para que los productos aparezcan de inmediato al abrir la app
    renderProductosVenta();
}

// ========================================================
// AJUSTES Y DESCUENTOS
// ========================================================
function abrirModalAjuste(tipo) {
    const elTipo = document.getElementById('ajuste-tipo'); 
    const m = document.getElementById('modal-ajuste');
    if(!m || !elTipo) return;
    
    elTipo.value = tipo; 
    document.getElementById('ajuste-monto').value = ''; 
    document.getElementById('ajuste-desc').value = '';
    
    document.getElementById('modal-ajuste-titulo').innerHTML = tipo === 'Descuento' 
        ? '<i data-lucide="minus-circle" class="w-5 h-5 text-red-400"></i> Descuento' 
        : '<i data-lucide="plus-circle" class="w-5 h-5 text-emerald-400"></i> Cargo Extra';
        
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
    if(window.lucide) window.lucide.createIcons();
}

function confirmarAjuste(e) {
    e.preventDefault();
    const tipo = document.getElementById('ajuste-tipo').value; 
    let monto = parseFloat(document.getElementById('ajuste-monto').value);
    const desc = document.getElementById('ajuste-desc').value || tipo;
    
    if(isNaN(monto) || monto <= 0) { 
        if(window.mostrarToast) window.mostrarToast('Error', 'Monto inválido', 'amber'); 
        return; 
    }
    
    if(tipo === 'Descuento') monto = -monto;
    
    state.carrito.push({ 
        cartId: generateTicketId(), 
        productoId: 'AJUSTE', 
        nombre: `${tipo}: ${desc}`, 
        precio: monto, 
        costo: 0, 
        sabores: [], 
        cantidad: 1, 
        categoria: 'ajuste', 
        isYape: false 
    });
    
    const m = document.getElementById('modal-ajuste'); 
    m.classList.add('opacity-0'); 
    setTimeout(() => m.classList.add('hidden'), 300);
    actualizarCarritoUI();
}

// ========================================================
// RENDERIZADO DEL CATÁLOGO EN POS
// ========================================================
export function renderProductosVenta() {
    const grid = document.getElementById('productos-venta-grid'); 
    if (!grid) return;
    
    const term = document.getElementById('searchInput')?.value.toLowerCase() || ''; 
    const cat = document.getElementById('posCategoryFilter')?.value || '';
    
    // Filtro por Sede (Multi-franquicia)
    let filtrados = state.productos.filter(p => {
        const isRightCat = p.categoria === 'vaso' || p.categoria === 'extra';
        const isRightLocal = (state.userRole === 'admin' || state.userRole === 'master') ? true : (!p.localId || p.localId === 'global' || p.localId === state.userLocalId);
        return isRightCat && isRightLocal;
    });

    if(cat !== '') filtrados = filtrados.filter(p => p.categoria === cat);
    if(term !== '') filtrados = filtrados.filter(p => p.nombre.toLowerCase().includes(term));
    
    if(filtrados.length === 0) { 
        grid.innerHTML = `<div class="col-span-full flex justify-center py-10 text-slate-500 text-sm">No hay productos disponibles.</div>`; 
        return; 
    }
    
    let html = '';
    filtrados.forEach(p => {
        const isAgt = p.stock !== null && p.stock <= 0;
        const blockCls = isAgt ? 'opacity-50 grayscale cursor-not-allowed' : 'cursor-pointer hover:border-sky-500 hover:shadow-sky-500/20 active:scale-95';
        
        const badgeLocal = (p.localId && p.localId !== 'global' && (state.userRole === 'master' || state.userRole === 'admin')) ? `<span class="absolute top-1 left-1 bg-slate-900 text-[8px] text-slate-400 px-1 py-0.5 rounded border border-slate-700 truncate max-w-[60px]">${state.locales.find(l => l.id === p.localId)?.nombre || 'Sede'}</span>` : '';
        const badgeHtml = isAgt ? `<div class="absolute top-0 right-0 bg-red-500 text-white text-[8px] md:text-[9px] font-bold px-1.5 md:px-2 py-0.5 rounded-bl-lg">Agotado</div>` : (p.categoria==='vaso' ? `<div class="absolute top-0 right-0 bg-sky-500 text-white text-[8px] md:text-[9px] font-bold px-1.5 md:px-2 py-0.5 rounded-bl-lg">${p.limite===999?'Ilimitados':p.limite}</div>` : '');
        const cCls = p.categoria === 'vaso' ? 'from-sky-400 to-indigo-500' : 'from-emerald-400 to-teal-500';
        
        html += `
        <div data-id="${p.id}" data-categoria="${p.categoria}" class="producto-card bg-slate-800 border border-slate-700 rounded-xl md:rounded-2xl p-2 md:p-3 flex flex-col items-center text-center transition-all relative overflow-hidden ${blockCls}">
            ${badgeLocal}
            ${badgeHtml}
            <div class="w-10 h-10 md:w-14 md:h-14 bg-gradient-to-br ${cCls} rounded-full flex items-center justify-center mt-3 mb-2 shadow-md">
                <i data-lucide="${p.categoria === 'vaso' ? 'cup-soda' : 'package'}" class="w-5 h-5 md:w-7 md:h-7 text-white"></i>
            </div>
            <h3 class="text-[10px] md:text-sm font-bold text-slate-800 dark:text-white mb-1 leading-tight line-clamp-2">${p.nombre}</h3>
            <p class="text-${p.categoria==='vaso'?'sky':'emerald'}-500 font-black text-xs md:text-sm mt-auto">${formatMoney(p.precio)}</p>
        </div>`;
    });
    
    grid.innerHTML = html; 
    if(window.lucide) window.lucide.createIcons();
}

// ========================================================
// ARMADO DE VASOS (SABORES)
// ========================================================
function iniciarArmadoVaso(id) {
    vasoActual = state.productos.find(p => p.id === id); 
    if(!vasoActual) return; 
    
    saboresElegidos = [];
    document.getElementById('modal-vaso-title').textContent = vasoActual.nombre; 
    document.getElementById('modal-vaso-subtitle').textContent = `Precio: ${formatMoney(vasoActual.precio)}`;
    document.getElementById('limite-sabores-txt').textContent = vasoActual.limite === 999 ? 'Ilimitados' : `Max: ${vasoActual.limite}`;
    
    const c = document.getElementById('builder-sabores'); 
    let html = '';
    
    const saboresDisp = state.productos.filter(p => p.categoria === 'sabor' && (!p.localId || p.localId === 'global' || p.localId === state.userLocalId));
    
    saboresDisp.forEach(j => {
        const dis = (j.stock !== null && j.stock <= 0) ? 'opacity-50 pointer-events-none line-through' : 'cursor-pointer hover:border-slate-400';
        html += `<div data-nombre="${j.nombre}" class="sabor-btn bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-xl flex items-center gap-2 transition-colors ${dis}"><div class="check-icon w-4 h-4 rounded-full border border-slate-400 dark:border-slate-600 flex items-center justify-center"></div><span class="text-sm font-medium text-slate-700 dark:text-slate-300">${j.nombre}</span></div>`;
    });
    
    c.innerHTML = html || '<p class="text-xs text-slate-500 col-span-2">No hay sabores disponibles en esta sede.</p>'; 
    document.getElementById('builder-count').textContent = '0';
    
    const m = document.getElementById('modal-armar-vaso'); 
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
}

function toggleSabor(n) {
    if(saboresElegidos.includes(n)) {
        saboresElegidos = saboresElegidos.filter(s => s !== n);
    } else { 
        if(vasoActual.limite === 999 || saboresElegidos.length < vasoActual.limite) {
            saboresElegidos.push(n); 
        } else return; 
    }
    
    document.querySelectorAll('.sabor-btn').forEach(btn => {
        const nm = btn.dataset.nombre; 
        const chk = btn.querySelector('.check-icon');
        if(saboresElegidos.includes(nm)) { 
            btn.classList.add('bg-sky-500', 'text-white', 'border-sky-500'); 
            btn.classList.remove('bg-slate-100', 'dark:bg-slate-900', 'border-slate-300', 'dark:border-slate-700'); 
            chk.classList.replace('border', 'bg-white/30'); 
            chk.classList.replace('border-slate-400', 'border-transparent'); 
            chk.classList.replace('dark:border-slate-600', 'border-transparent'); 
            chk.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-white"></i>'; 
        } else { 
            btn.classList.remove('bg-sky-500', 'text-white', 'border-sky-500'); 
            btn.classList.add('bg-slate-100', 'dark:bg-slate-900', 'border-slate-300', 'dark:border-slate-700'); 
            chk.classList.replace('bg-white/30', 'border'); 
            chk.classList.replace('border-transparent', 'border-slate-400'); 
            chk.classList.remove('dark:border-slate-600'); // Resetea estado
            chk.innerHTML = ''; 
        }
    });
    document.getElementById('builder-count').textContent = saboresElegidos.length;
    if(window.lucide) window.lucide.createIcons();
}

function cerrarModalArmar() { 
    const m = document.getElementById('modal-armar-vaso'); 
    if(m) {
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
    }
}

function confirmarVasoAlCarrito() {
    if(saboresElegidos.length === 0 && vasoActual.limite !== 0 && window.mostrarToast) { 
        window.mostrarToast('Atención', 'Elige 1 sabor mínimo.', 'amber'); 
        return; 
    }
    state.carrito.push({ 
        cartId: generateTicketId(), 
        productoId: vasoActual.id, 
        nombre: vasoActual.nombre, 
        precio: vasoActual.precio, 
        costo: vasoActual.costo || 0, 
        sabores: [...saboresElegidos], 
        cantidad: 1, 
        categoria: 'vaso', 
        isYape: false 
    });
    cerrarModalArmar(); 
    actualizarCarritoUI();
}

// ========================================================
// GESTIÓN DEL CARRITO
// ========================================================
function agregarExtra(id) {
    const p = state.productos.find(x => x.id === id); 
    if(!p) return;
    const it = state.carrito.find(i => i.productoId === id && i.categoria === 'extra');
    if (it) {
        it.cantidad++; 
    } else {
        state.carrito.push({ 
            cartId: generateTicketId(), 
            productoId: p.id, 
            nombre: p.nombre, 
            precio: p.precio, 
            costo: p.costo || 0, 
            sabores: [], 
            cantidad: 1, 
            categoria: 'extra', 
            isYape: false 
        });
    }
    actualizarCarritoUI();
}

function modificarCantidad(id, delta) { 
    const it = state.carrito.find(c => c.cartId === id); 
    if(it) { 
        it.cantidad += delta; 
        if(it.cantidad <= 0) eliminarItemCarrito(id); 
        else actualizarCarritoUI(); 
    } 
}

function setCantidad(id, cantStr) {
    if (cantStr === '') return; 
    const cant = parseInt(cantStr); 
    if(isNaN(cant) || cant <= 0) { eliminarItemCarrito(id); return; }
    const it = state.carrito.find(c => c.cartId === id); 
    if(it) { it.cantidad = cant; actualizarCarritoUI(); }
}

function eliminarItemCarrito(id) { 
    state.carrito = state.carrito.filter(c => c.cartId !== id); 
    actualizarCarritoUI(); 
}

export function actualizarCarritoUI() {
    const list = document.getElementById('carrito-items'); 
    const emp = document.getElementById('carrito-vacio'); 
    const btn = document.getElementById('btn-procesar-cobro');
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
        emp.classList.add('hidden'); 
        list.classList.remove('hidden'); 
        list.innerHTML = html; 
        btn.classList.remove('opacity-50', 'cursor-not-allowed'); 
        btn.disabled = false; 
    } else { 
        emp.classList.remove('hidden'); 
        list.classList.add('hidden'); 
        list.innerHTML = ''; 
        btn.classList.add('opacity-50', 'cursor-not-allowed'); 
        btn.disabled = true; 
    }
    
    document.getElementById('carrito-total').textContent = formatMoney(t); 

    const hasYape = state.carrito.some(c => c.isYape); 
    const hasEfe = state.carrito.some(c => !c.isYape);
    
    if (hasYape) {
        if (hasEfe && !document.getElementById('radio-mixto').checked) { 
            document.getElementById('radio-mixto').checked = true; window.toggleMetodoPago('mixto'); 
        } else if (!hasEfe && !document.getElementById('radio-yape').checked) { 
            document.getElementById('radio-yape').checked = true; window.toggleMetodoPago('yape'); 
        } else if (document.getElementById('radio-mixto').checked) { 
            window.toggleMetodoPago('mixto'); 
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
    if(document.querySelector('input[name="metodo_pago"]:checked')?.value === 'efectivo') {
        const pc = parseFloat(document.getElementById('input-paga-con').value) || 0; 
        const v = pc - t;
        document.getElementById('txt-vuelto').textContent = v >= 0 ? formatMoney(v) : 'S/ 0.00'; 
        document.getElementById('txt-vuelto').classList.toggle('text-red-500', v < 0);
    }
}

// ========================================================
// PROCESAR COBRO (Envío a 2do Plano / Instantáneo)
// ========================================================
function procesarCobroFinal() {
    const btn = document.getElementById('btn-procesar-cobro');
    if(state.carrito.length === 0 || btn.disabled) return;
    
    const t = state.carrito.reduce((s, i) => s + (i.precio * i.cantidad), 0); 
    const c = state.carrito.reduce((s, i) => s + (i.costo * i.cantidad), 0);
    const m = document.querySelector('input[name="metodo_pago"]:checked').value; 
    let pE = 0, pY = 0;
    
    if(m === 'efectivo') { 
        pE = t; 
        const pc = parseFloat(document.getElementById('input-paga-con').value) || 0; 
        if(pc < t && pc > 0 && window.mostrarToast) return window.mostrarToast('Error', 'Efectivo menor al total.', 'red'); 
    } 
    else if (m === 'yape') { pY = t; } 
    else { 
        pE = parseFloat(document.getElementById('input-mixto-efectivo').value) || 0; 
        pY = parseFloat(document.getElementById('input-mixto-yape').value) || 0; 
        if(Math.abs((pE + pY) - t) > 0.01 && window.mostrarToast) return window.mostrarToast('Error', 'Sumas no cuadran.', 'amber'); 
    }

    // Datos del Ticket
    const tId = generateTicketId(); 
    const hs = getTodayDateStr(); 
    const cr = [...state.carrito];
    const esEditado = window.ticketEditadoOriginal === true; 
    window.ticketEditadoOriginal = false;
    const idLocalSeguro = state.userLocalId || 'general';

    try {
        const bt = writeBatch(db);
        
        // 1. Guardar Venta
        bt.set(doc(db, "ventas", tId), { 
            id: tId, 
            fecha: serverTimestamp(), 
            timestamp: serverTimestamp(), 
            fechaStr: hs, 
            items: cr, 
            total: t, 
            costoTotal: c, 
            costo_total: c, 
            pagoEfectivo: pE, 
            pago_efectivo: pE, 
            pagoYape: pY, 
            pago_yape: pY, 
            metodoFinal: m, 
            metodo_pago: m, 
            localId: idLocalSeguro, 
            localNombre: state.userLocal, 
            cajeroEmail: state.currentUser.email, 
            estado: 'pendiente', 
            editado: esEditado 
        });
        
        // 2. Acumular en Caja
        bt.set(doc(db, "caja_diaria", hs + "_" + idLocalSeguro), { 
            localId: idLocalSeguro, 
            localNombre: state.userLocal, 
            fechaStr: hs, 
            total_ingresos: increment(t), 
            total_costos: increment(c), 
            total_efectivo: increment(pE), 
            total_yape: increment(pY), 
            cantidad_ventas: increment(1) 
        }, { merge: true });
        
        // 3. Restar Stock
        cr.forEach(i => { 
            if(i.productoId !== 'AJUSTE') { 
                const p = state.productos.find(x => x.id === i.productoId); 
                if(p && p.stock !== null) bt.update(doc(db, "productos", p.id), { stock: increment(-i.cantidad) }); 
            } 
        });
        
        // --- MAGIA: Enviar a la nube sin "await" para que sea instantáneo en UI ---
        bt.commit().catch(err => console.error("Error sincronizando venta en background:", err));
        
        // --- Limpieza INMEDIATA de la UI ---
        window.clearCart(); 
        actualizarCarritoUI(); 
        document.getElementById('input-paga-con').value = ''; 
        document.getElementById('input-mixto-efectivo').value = ''; 
        document.getElementById('input-mixto-yape').value = ''; 
        document.getElementById('txt-vuelto').textContent = 'S/ 0.00';
        
        if(window.mostrarToast) window.mostrarToast('Venta Exitosa', `Ticket #T-${tId.split('-')[1]} registrado en cola.`, 'emerald');
        
        // Actualizar visualmente el stock de la UI (sin requerir recarga)
        cr.forEach(item => {
            if(item.productoId !== 'AJUSTE') {
                const prod = state.productos.find(x => x.id === item.productoId);
                if (prod && prod.stock !== null) prod.stock -= item.cantidad;
            }
        });
        renderProductosVenta();

    } catch (err) { 
        console.error(err); 
        if(window.mostrarToast) window.mostrarToast('Error', 'Hubo un error procesando la venta.', 'red');
    }
}
