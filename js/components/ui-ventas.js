import { db, doc, collection, serverTimestamp, increment, writeBatch } from '../core/firebase-setup.js';
import { state, clearCart } from '../core/store.js'; 
import { formatMoney, getTodayDateStr, generateTicketId } from '../utils/helpers.js';

let vasoActual = null; 
let saboresElegidos = [];
let toppingsElegidos = []; // NUEVO: Estado para toppings
let tamanoElegido = null;  // NUEVO: Estado para tamaño
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
    window.toggleSabor = toggleSabor;
    window.toggleTamano = toggleTamano;   // NUEVO
    window.toggleTopping = toggleTopping; // NUEVO

    window.toggleMetodoPago = function(val) {
        const areaVuelto = document.getElementById('area-vuelto');
        const areaMixto = document.getElementById('area-mixto');
        
        if (areaVuelto) areaVuelto.classList.toggle('hidden', val !== 'efectivo');
        if (areaMixto) areaMixto.classList.toggle('hidden', val !== 'mixto');
        
        document.querySelectorAll('input[name="metodo_pago"]').forEach(radio => {
            const label = radio.closest('label');
            if (!label) return;
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
                const inputMixYape = document.getElementById('input-mixto-yape');
                const inputMixEfe = document.getElementById('input-mixto-efectivo');
                if (inputMixYape) inputMixYape.value = sumYape > 0 ? sumYape.toFixed(2) : '';
                if (inputMixEfe) inputMixEfe.value = sumEfe > 0 ? sumEfe.toFixed(2) : '';
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
            
            const prod = state.productos.find(p => p.id === card.dataset.id);
            if (!prod) return;

            // NUEVA LÓGICA: Si es un vaso, o si tiene múltiples tamaños, abrir constructor
            if (prod.categoria === 'vaso' || (prod.tamanos && prod.tamanos.length > 1)) {
                iniciarArmadoVaso(prod.id);
            } else {
                agregarExtra(prod.id); // Directo al carrito
            }
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
        toppings: [], // NUEVO
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
// RENDERIZADO DEL CATÁLOGO EN POS (ORDENADO POR POPULARIDAD)
// ========================================================
export function renderProductosVenta() {
    const grid = document.getElementById('productos-venta-grid'); 
    if (!grid) return;
    
    const term = document.getElementById('searchInput')?.value.toLowerCase() || ''; 
    const catFiltro = document.getElementById('posCategoryFilter')?.value.toLowerCase() || '';
    const rolUsuario = String(state.userRole || '').toLowerCase();
    const isAdmin = ['admin', 'administrador', 'master'].includes(rolUsuario);
    
    // Filtro por Sede y Categoría
    let filtrados = state.productos.filter(p => {
        const prodCat = String(p.categoria || '').toLowerCase();
        // Solo mostramos Vasos y Extras en la grilla principal
        const isRightCat = prodCat === 'vaso' || prodCat === 'extra';
        const isRightLocal = isAdmin ? true : (!p.localId || p.localId === 'global' || p.localId === state.userLocalId);
        return isRightCat && isRightLocal;
    });

    if(catFiltro !== '' && catFiltro !== 'todo' && catFiltro !== 'todas') {
        filtrados = filtrados.filter(p => String(p.categoria || '').toLowerCase() === catFiltro);
    }

    if(term !== '') {
        filtrados = filtrados.filter(p => String(p.nombre || '').toLowerCase().includes(term));
    }

    // 🚀 ORDENAMIENTO POR POPULARIDAD (Más vendidos primero)
    filtrados.sort((a, b) => {
        const ventasA = a.ventasTotales || 0;
        const ventasB = b.ventasTotales || 0;
        return ventasB - ventasA; // Orden Descendente
    });
    
    if(filtrados.length === 0) { 
        grid.innerHTML = `<div class="col-span-full flex justify-center py-10 text-slate-500 text-sm">No hay productos disponibles.</div>`; 
        return; 
    }
    
    let html = '';
    filtrados.forEach(p => {
        const catLower = String(p.categoria || '').toLowerCase();
        const isAgt = p.stock !== null && p.stock <= 0;
        const blockCls = isAgt ? 'opacity-50 grayscale cursor-not-allowed' : 'cursor-pointer hover:border-sky-500 hover:shadow-sky-500/20 active:scale-95';
        
        const limite = Number(p.limite_sabores !== undefined ? p.limite_sabores : (p.limiteSabores || p.limite || 0));
        const badgeLocal = (p.localId && p.localId !== 'global' && isAdmin) ? `<span class="absolute top-1 left-1 bg-slate-900 text-[8px] text-slate-400 px-1 py-0.5 rounded border border-slate-700 truncate max-w-[60px]">${state.locales.find(l => l.id === p.localId)?.nombre || 'Sede'}</span>` : '';
        const badgeHtml = isAgt ? `<div class="absolute top-0 right-0 bg-red-500 text-white text-[8px] md:text-[9px] font-bold px-1.5 md:px-2 py-0.5 rounded-bl-lg">Agotado</div>` : (catLower ==='vaso' ? `<div class="absolute top-0 right-0 bg-sky-500 text-white text-[8px] md:text-[9px] font-bold px-1.5 md:px-2 py-0.5 rounded-bl-lg">${limite===999?'Ilimitados':limite}</div>` : '');
        const cCls = catLower === 'vaso' ? 'from-sky-400 to-red-400' : 'from-emerald-400 to-teal-500';
        
        // Mostrar "S/ 3 - 5" si tiene múltiples tamaños
        let priceDisplay = formatMoney(p.precio || 0);
        if (p.tamanos && p.tamanos.length > 1) {
            const min = Math.min(...p.tamanos.map(t => t.precio));
            const max = Math.max(...p.tamanos.map(t => t.precio));
            
            // Función auxiliar para quitar '.00' si es entero
            const formatShort = (val) => Number.isInteger(val) ? val.toString() : val.toFixed(2);

            priceDisplay = min === max ? formatMoney(min) : `S/ ${formatShort(min)} - ${formatShort(max)}`;
        }

        // Indicador visual de popularidad (opcional, solo para depuración o si el admin quiere verlo)
        // Puedes descomentar esta línea si quieres mostrar un pequeño badge con las ventas totales de cada producto
        // const popularBadge = isAdmin && p.ventasTotales > 0 ? `<div class="absolute bottom-1 left-1 text-[8px] text-slate-500"><i data-lucide="trending-up" class="w-2 h-2 inline"></i> ${p.ventasTotales}</div>` : '';
        const popularBadge = '';

        html += `
        <div data-id="${p.id}" data-categoria="${catLower}" class="producto-card bg-slate-800 border border-slate-700 rounded-xl md:rounded-2xl p-2 md:p-3 flex flex-col items-center text-center transition-all relative overflow-hidden ${blockCls}">
            ${badgeLocal}
            ${badgeHtml}
            ${popularBadge}
            <div class="w-10 h-10 md:w-14 md:h-14 bg-gradient-to-br ${cCls} rounded-full flex items-center justify-center mt-3 mb-2 shadow-md">
                <i data-lucide="${catLower === 'vaso' ? 'cup-soda' : 'package'}" class="w-5 h-5 md:w-7 md:h-7 text-white"></i>
            </div>
            <h3 class="text-[10px] md:text-sm font-bold text-slate-800 dark:text-white mb-1 leading-tight line-clamp-2">${p.nombre}</h3>
            <p class="text-${catLower ==='vaso'?'sky':'emerald'}-500 font-black text-xs md:text-sm mt-auto">${priceDisplay}</p>
        </div>`;
    });
    
    grid.innerHTML = html; 
    if(window.lucide) window.lucide.createIcons();
}

// ========================================================
// ACORDEÓN DE ARMADO (TAMAÑOS, SABORES, TOPPINGS)
// ========================================================
function actualizarPrecioModal() {
    let t = (tamanoElegido ? parseFloat(tamanoElegido.precio) : 0);
    toppingsElegidos.forEach(top => t += parseFloat(top.precio));
    document.getElementById('modal-vaso-subtitle').textContent = `Total: ${formatMoney(t)}`;
}

function iniciarArmadoVaso(id) {
    vasoActual = state.productos.find(p => p.id === id); 
    if(!vasoActual) return; 

    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));

    saboresElegidos = [];
    toppingsElegidos = [];
    
    // Normalizar tamaños del producto
    if (!vasoActual.tamanos || vasoActual.tamanos.length === 0) {
         vasoActual.tamanos = [{ nombre: 'Estándar', precio: vasoActual.precio }];
    }
    tamanoElegido = vasoActual.tamanos[0]; // Seleccionar el primero por defecto

    document.getElementById('modal-vaso-title').textContent = vasoActual.nombre; 
    document.getElementById('limite-sabores-txt').textContent = limite === 999 ? 'Ilimitados' : `Max: ${limite}`;
    
    // 1. RENDERIZAR TAMAÑOS
    renderTamanosUI();

    // 2. RENDERIZAR SABORES
    const c = document.getElementById('builder-sabores'); 
    let htmlSabores = '';
    const saboresDisp = state.productos.filter(p => String(p.categoria || '').toLowerCase() === 'sabor' && (!p.localId || p.localId === 'global' || p.localId === state.userLocalId));
    
    if (vasoActual.categoria !== 'vaso' || limite === 0) {
        htmlSabores = '<p class="text-xs text-slate-500 col-span-2 italic text-center">Este producto no lleva sabores.</p>';
    } else {
        saboresDisp.forEach(j => {
            const dis = (j.stock !== null && j.stock <= 0) ? 'opacity-50 pointer-events-none line-through' : 'cursor-pointer hover:border-sky-500 hover:shadow-md';
            const clickAction = (j.stock !== null && j.stock <= 0) ? '' : `onclick="window.toggleSabor('${j.nombre}')"`;
            
            htmlSabores += `
            <div ${clickAction} data-nombre="${j.nombre}" class="sabor-btn bg-slate-900 border border-slate-700 p-3 rounded-xl flex items-center gap-2 transition-all select-none ${dis}">
                <div class="check-icon w-4 h-4 rounded-full border border-slate-500 flex items-center justify-center transition-colors"></div>
                <span class="text-sm font-medium text-slate-300 w-full">${j.nombre}</span>
            </div>`;
        });
    }
    c.innerHTML = htmlSabores || '<p class="text-xs text-slate-500 col-span-2 text-center">No hay sabores disponibles.</p>'; 
    document.getElementById('builder-count').textContent = '0';

    // 3. RENDERIZAR TOPPINGS
    const ct = document.getElementById('builder-toppings');
    let htmlToppings = '';
    const toppingsDisp = state.productos.filter(p => String(p.categoria || '').toLowerCase() === 'topping' && (!p.localId || p.localId === 'global' || p.localId === state.userLocalId));
    
    toppingsDisp.forEach(top => {
        const isAgt = top.stock !== null && top.stock <= 0;
        const cls = isAgt ? 'opacity-50 pointer-events-none' : 'cursor-pointer hover:border-amber-500 hover:bg-slate-800';
        const tPrecio = top.tamanos && top.tamanos.length > 0 ? top.tamanos[0].precio : (top.precio || 0);

        htmlToppings += `
        <div onclick="${isAgt ? '' : `window.toggleTopping('${top.id}')`}" data-id="${top.id}" class="topping-btn bg-slate-900 border border-slate-700 p-2.5 rounded-xl flex items-center gap-2 transition-all select-none ${cls}">
            <div class="check-icon w-4 h-4 rounded-sm border border-slate-500 flex items-center justify-center transition-colors shrink-0"></div>
            <div class="flex flex-col w-full">
                <span class="text-xs font-medium text-slate-300 leading-tight">${top.nombre}</span>
                <span class="text-[10px] text-amber-400 font-bold leading-tight">+${formatMoney(tPrecio)}</span>
            </div>
        </div>`;
    });
    ct.innerHTML = htmlToppings || '<p class="text-xs text-slate-500 col-span-2 text-center italic">No hay toppings disponibles.</p>';

    actualizarPrecioModal();
    
    const m = document.getElementById('modal-armar-vaso'); 
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);

    // Expandir automáticamente la primera sección necesaria
    if (vasoActual.tamanos.length > 1) window.toggleAcordeon('tamanos');
    else if (limite > 0) window.toggleAcordeon('sabores');
    else window.toggleAcordeon('toppings');
}

function renderTamanosUI() {
    let tamHtml = '';
    vasoActual.tamanos.forEach((t, idx) => {
        const isSel = tamanoElegido.nombre === t.nombre;
        const cls = isSel ? 'bg-sky-500 border-sky-500 shadow-lg shadow-sky-500/20' : 'bg-slate-900 border-slate-700 hover:border-sky-500/50';
        const txtCls = isSel ? 'text-white' : 'text-slate-300';
        const priceCls = isSel ? 'text-sky-100' : 'text-sky-400';
        
        tamHtml += `
        <button onclick="window.toggleTamano(${idx})" class="p-3 border rounded-xl flex flex-col items-start transition-all ${cls}">
            <span class="font-bold text-xs md:text-sm ${txtCls}">${t.nombre}</span>
            <span class="text-xs font-black ${priceCls} mt-1">${formatMoney(t.precio)}</span>
        </button>`;
    });
    document.getElementById('builder-tamanos').innerHTML = tamHtml;
}

function toggleTamano(idx) {
    if(!vasoActual || !vasoActual.tamanos[idx]) return;
    tamanoElegido = vasoActual.tamanos[idx];
    renderTamanosUI();
    actualizarPrecioModal();
    
    // Auto-avanzar al siguiente paso
    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));
    if (limite > 0) window.toggleAcordeon('sabores');
    else window.toggleAcordeon('toppings');
}

function toggleTopping(id) {
    const toppingData = state.productos.find(p => p.id === id);
    if (!toppingData) return;

    const existeIdx = toppingsElegidos.findIndex(t => t.id === id);
    
    if (existeIdx >= 0) {
        toppingsElegidos.splice(existeIdx, 1);
    } else {
        const tPrecio = toppingData.tamanos && toppingData.tamanos.length > 0 ? toppingData.tamanos[0].precio : (toppingData.precio || 0);
        toppingsElegidos.push({
            id: toppingData.id,
            nombre: toppingData.nombre,
            precio: parseFloat(tPrecio)
        });
    }

    // Actualizar UI Visual de los botones de Toppings
    document.querySelectorAll('.topping-btn').forEach(btn => {
        const tid = btn.dataset.id; 
        const chk = btn.querySelector('.check-icon');
        if (!chk) return;

        if(toppingsElegidos.some(t => t.id === tid)) { 
            btn.classList.add('border-amber-500', 'bg-slate-800'); 
            btn.classList.remove('border-slate-700', 'bg-slate-900'); 
            chk.classList.replace('border-slate-500', 'border-transparent'); 
            chk.classList.add('bg-amber-500');
            chk.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-white"></i>'; 
        } else { 
            btn.classList.remove('border-amber-500', 'bg-slate-800'); 
            btn.classList.add('border-slate-700', 'bg-slate-900'); 
            chk.classList.replace('border-transparent', 'border-slate-500'); 
            chk.classList.remove('bg-amber-500');
            chk.innerHTML = ''; 
        }
    });

    if(window.lucide) window.lucide.createIcons();
    actualizarPrecioModal();
}

function toggleSabor(n) {
    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));

    if(saboresElegidos.includes(n)) {
        saboresElegidos = saboresElegidos.filter(s => s !== n);
    } else { 
        if(limite === 999 || saboresElegidos.length < limite) {
            saboresElegidos.push(n); 
        } else {
            if(window.mostrarToast) window.mostrarToast('Límite alcanzado', `Solo puedes elegir hasta ${limite} sabores.`, 'amber');
            return; 
        }
    }
    
    document.querySelectorAll('.sabor-btn').forEach(btn => {
        const nm = btn.dataset.nombre; 
        const chk = btn.querySelector('.check-icon');
        if (!chk) return;

        if(saboresElegidos.includes(nm)) { 
            btn.classList.add('bg-sky-500', 'border-sky-500'); 
            btn.classList.remove('bg-slate-900', 'border-slate-700'); 
            btn.querySelector('span').classList.replace('text-slate-300', 'text-white');
            chk.classList.replace('border', 'bg-white/30'); 
            chk.classList.replace('border-slate-500', 'border-transparent'); 
            chk.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-white"></i>'; 
        } else { 
            btn.classList.remove('bg-sky-500', 'border-sky-500'); 
            btn.classList.add('bg-slate-900', 'border-slate-700'); 
            btn.querySelector('span').classList.replace('text-white', 'text-slate-300');
            chk.classList.replace('bg-white/30', 'border'); 
            chk.classList.replace('border-transparent', 'border-slate-500'); 
            chk.innerHTML = ''; 
        }
    });
    
    const countEl = document.getElementById('builder-count');
    if (countEl) countEl.textContent = saboresElegidos.length;
    if(window.lucide) window.lucide.createIcons();
    
    // Auto-avanzar si llega al límite
    if (saboresElegidos.length === limite && limite !== 999) {
        setTimeout(() => window.toggleAcordeon('toppings'), 300);
    }
}

function cerrarModalArmar() { 
    const m = document.getElementById('modal-armar-vaso'); 
    if(m) {
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
    }
}

function confirmarVasoAlCarrito() {
    const limite = Number(vasoActual.limite_sabores !== undefined ? vasoActual.limite_sabores : (vasoActual.limiteSabores || vasoActual.limite || 0));

    if(saboresElegidos.length === 0 && limite !== 0 && window.mostrarToast) { 
        window.mostrarToast('Atención', 'Elige 1 sabor mínimo.', 'amber'); 
        // Abrir la pestaña de sabores para que el usuario lo vea
        window.toggleAcordeon('sabores');
        return; 
    }

    let precioTotal = parseFloat(tamanoElegido.precio) || 0;
    toppingsElegidos.forEach(t => precioTotal += t.precio);

    state.carrito.push({ 
        cartId: generateTicketId(), 
        productoId: vasoActual.id, 
        nombre: vasoActual.nombre, 
        tamano: tamanoElegido.nombre, // NUEVO
        precio: precioTotal, 
        costo: vasoActual.costo || 0, 
        sabores: [...saboresElegidos], 
        toppings: [...toppingsElegidos], // NUEVO
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
    
    const tPrecio = p.tamanos && p.tamanos.length > 0 ? p.tamanos[0].precio : (p.precio || 0);
    const tNombre = p.tamanos && p.tamanos.length > 0 ? p.tamanos[0].nombre : 'Estándar';

    const it = state.carrito.find(i => i.productoId === id && i.categoria === 'extra');
    if (it) {
        it.cantidad++; 
    } else {
        state.carrito.push({ 
            cartId: generateTicketId(), 
            productoId: p.id, 
            nombre: p.nombre, 
            tamano: tNombre,
            precio: parseFloat(tPrecio), 
            costo: p.costo || 0, 
            sabores: [], 
            toppings: [],
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
    const totalEl = document.getElementById('carrito-total');
    
    if(!list) return;
    
    const activeElementId = document.activeElement?.dataset?.id;

    let t = 0; let html = '';
    state.carrito.forEach(i => {
        t += i.precio * i.cantidad;
        const color = i.precio < 0 ? 'text-red-500' : 'text-emerald-500';
        const btnYapeClass = i.isYape ? 'bg-purple-100 text-purple-600 border-purple-300 dark:bg-purple-500/20 dark:text-purple-400' : 'bg-slate-200 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-400';

        // Construir detalles visuales (Tamaño, Sabores, Toppings)
        let detallesHtml = '';
        if (i.tamano && i.tamano !== 'Estándar' && i.tamano !== 'Único / Estándar' && i.productoId !== 'AJUSTE') {
            detallesHtml += `<p class="text-[9px] text-emerald-400 font-medium mt-0.5"><span class="text-slate-400">Tam:</span> ${i.tamano}</p>`;
        }
        if (i.sabores && i.sabores.length > 0) {
            detallesHtml += `<p class="text-[9px] text-sky-400 font-medium mt-0.5"><span class="text-slate-400">Sab:</span> ${i.sabores.join(', ')}</p>`;
        }
        if (i.toppings && i.toppings.length > 0) {
            detallesHtml += `<p class="text-[9px] text-amber-400 font-medium mt-0.5"><span class="text-slate-400">Top:</span> ${i.toppings.map(x=>x.nombre).join(', ')}</p>`;
        }

        html += `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-2.5 shadow-sm relative group mb-2">
            <div class="flex justify-between items-start">
                <div class="flex-1 pr-2">
                    <h4 class="text-xs font-bold text-slate-800 dark:text-white leading-tight">${i.nombre}</h4>
                    ${detallesHtml}
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
        if(btn) {
            btn.classList.remove('opacity-50', 'cursor-not-allowed'); 
            btn.disabled = false; 
        }
    } else { 
        if(emp) emp.classList.remove('hidden'); 
        list.classList.add('hidden'); 
        list.innerHTML = ''; 
        if(btn) {
            btn.classList.add('opacity-50', 'cursor-not-allowed'); 
            btn.disabled = true; 
        }
    }
    
    if (totalEl) totalEl.textContent = formatMoney(t); 

    const hasYape = state.carrito.some(c => c.isYape); 
    const hasEfe = state.carrito.some(c => !c.isYape);
    
    const rMixto = document.getElementById('radio-mixto');
    const rYape = document.getElementById('radio-yape');

    if (hasYape) {
        if (hasEfe && rMixto && !rMixto.checked) { 
            rMixto.checked = true; window.toggleMetodoPago('mixto'); 
        } else if (!hasEfe && rYape && !rYape.checked) { 
            rYape.checked = true; window.toggleMetodoPago('yape'); 
        } else if (rMixto && rMixto.checked) { 
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
    const radioSelect = document.querySelector('input[name="metodo_pago"]:checked');
    const inputCon = document.getElementById('input-paga-con');
    const txtVuel = document.getElementById('txt-vuelto');

    if(radioSelect && radioSelect.value === 'efectivo' && inputCon && txtVuel) {
        const pc = parseFloat(inputCon.value) || 0; 
        const v = pc - t;
        txtVuel.textContent = v >= 0 ? formatMoney(v) : 'S/ 0.00'; 
        txtVuel.classList.toggle('text-red-500', v < 0);
    }
}

// ========================================================
// PROCESAR COBRO Y DESCUENTO DE INVENTARIOS
// ========================================================
function procesarCobroFinal() {
    const btn = document.getElementById('btn-procesar-cobro');
    if(!btn || state.carrito.length === 0 || btn.disabled) return;
    
    const t = state.carrito.reduce((s, i) => s + (i.precio * i.cantidad), 0); 
    const c = state.carrito.reduce((s, i) => s + (i.costo * i.cantidad), 0);
    const methodEl = document.querySelector('input[name="metodo_pago"]:checked');
    const m = methodEl ? methodEl.value : 'efectivo'; 
    let pE = 0, pY = 0;
    
    if(m === 'efectivo') { 
        pE = t; 
        const pc = parseFloat(document.getElementById('input-paga-con')?.value || 0); 
        if(pc < t && pc > 0 && window.mostrarToast) return window.mostrarToast('Error', 'Efectivo menor al total.', 'red'); 
    } 
    else if (m === 'yape') { pY = t; } 
    else { 
        pE = parseFloat(document.getElementById('input-mixto-efectivo')?.value || 0); 
        pY = parseFloat(document.getElementById('input-mixto-yape')?.value || 0); 
        if(Math.abs((pE + pY) - t) > 0.01 && window.mostrarToast) return window.mostrarToast('Error', 'Sumas no cuadran.', 'amber'); 
    }

    const clienteNombre = document.getElementById('input-cliente-nombre')?.value.trim() || '';

    // Datos del Ticket
    const tId = generateTicketId(); 
    const hs = getTodayDateStr(); 
    const cr = [...state.carrito];
    const esEditado = window.ticketEditadoOriginal === true; 
    window.ticketEditadoOriginal = false;
    const idLocalSeguro = state.userLocalId || 'general';
    const creador = state.currentUser?.username || state.currentUser?.email || 'Desconocido';

    try {
        const bt = writeBatch(db);
        
        // 1. Guardar Venta en Firestore
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
            localNombre: state.userLocal || 'Sin Local', 
            cajeroEmail: state.currentUser?.email || '',
            creadoPor: creador,
            clienteNombre: clienteNombre, // NUEVO
            estado: 'pendiente', 
            editado: esEditado 
        });
        
        // 2. Acumular en Caja Diaria
        bt.set(doc(db, "caja_diaria", hs + "_" + idLocalSeguro), { 
            localId: idLocalSeguro, 
            localNombre: state.userLocal || 'Sin Local', 
            fechaStr: hs, 
            total_ingresos: increment(t), 
            total_costos: increment(c), 
            total_efectivo: increment(pE), 
            total_yape: increment(pY), 
            cantidad_ventas: increment(1) 
        }, { merge: true });
        
        // 3. Descuento Automático de Stock (Producto y Toppings) y Popularidad (ventasTotales)
        cr.forEach(i => { 
            if(i.productoId !== 'AJUSTE') { 
                // Descontar Producto Principal (Vasos, Extras) y Sumar Popularidad
                const p = state.productos.find(x => x.id === i.productoId); 
                if(p) {
                    const updateData = { ventasTotales: increment(i.cantidad) };
                    if (p.stock !== null) updateData.stock = increment(-i.cantidad);
                    bt.update(doc(db, "productos", p.id), updateData);
                }

                // Descontar Toppings Extra y Sumar su Popularidad
                if (i.toppings && i.toppings.length > 0) {
                    i.toppings.forEach(top => {
                        const pTop = state.productos.find(x => x.id === top.id);
                        if (pTop) {
                            const topUpdate = { ventasTotales: increment(i.cantidad) };
                            if (pTop.stock !== null) topUpdate.stock = increment(-i.cantidad);
                            bt.update(doc(db, "productos", pTop.id), topUpdate);
                        }
                    });
                }
            } 
        });
        
        // --- Enviar a la nube (Background) ---
        bt.commit().catch(err => console.error("Error sincronizando venta en background:", err));
        
        // --- Limpieza INMEDIATA de la UI ---
        window.clearCart(); 
        actualizarCarritoUI(); 
        
        const inPagaCon = document.getElementById('input-paga-con');
        const inMixEfe = document.getElementById('input-mixto-efectivo');
        const inMixYap = document.getElementById('input-mixto-yape');
        const txtVuelto = document.getElementById('txt-vuelto');
        const inputCliente = document.getElementById('input-cliente-nombre');

        if (inPagaCon) inPagaCon.value = ''; 
        if (inMixEfe) inMixEfe.value = ''; 
        if (inMixYap) inMixYap.value = ''; 
        if (txtVuelto) txtVuelto.textContent = 'S/ 0.00';
        if (inputCliente) inputCliente.value = ''; // Limpiar nombre
        
        if(window.mostrarToast) window.mostrarToast('Venta Exitosa', `Ticket #T-${tId.split('-')[1]} registrado en cola.`, 'emerald');
        
        // Actualizar visualmente el stock y popularidad en la grilla sin esperar a Firestore
        cr.forEach(item => {
            if(item.productoId !== 'AJUSTE') {
                const prod = state.productos.find(x => x.id === item.productoId);
                if (prod) {
                    if (prod.stock !== null) prod.stock -= item.cantidad;
                    prod.ventasTotales = (prod.ventasTotales || 0) + item.cantidad;
                }

                if (item.toppings && item.toppings.length > 0) {
                    item.toppings.forEach(top => {
                        const pTop = state.productos.find(x => x.id === top.id);
                        if (pTop) {
                            if (pTop.stock !== null) pTop.stock -= item.cantidad;
                            pTop.ventasTotales = (pTop.ventasTotales || 0) + item.cantidad;
                        }
                    });
                }
            }
        });
        renderProductosVenta(); // Aquí es donde el método .sort() que agregamos arriba hará su magia

    } catch (err) { 
        console.error(err); 
        if(window.mostrarToast) window.mostrarToast('Error', 'Hubo un error procesando la venta.', 'red');
    }
}
