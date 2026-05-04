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
    window.toggleSabor = toggleSabor;
    window.confirmarVaso = confirmarVaso;
    window.agregarProductoDirecto = agregarProductoDirecto;
    window.eliminarDelCarrito = eliminarDelCarrito;

    window.toggleMetodoPago = function(val) {
        const areaVuelto = document.getElementById('area-vuelto');
        const areaMixto = document.getElementById('area-mixto');
        
        if (areaVuelto) areaVuelto.classList.toggle('hidden', val !== 'efectivo');
        if (areaMixto) areaMixto.classList.toggle('hidden', val !== 'mixto');
        
        document.querySelectorAll('input[name="metodo_pago"]').forEach(radio => {
            const label = radio.closest('label');
            if (label) {
                if (radio.checked) {
                    label.classList.add('ring-2', 'ring-sky-500', 'bg-sky-50', 'dark:bg-sky-900/30');
                    label.classList.remove('border-slate-200', 'dark:border-slate-700');
                } else {
                    label.classList.remove('ring-2', 'ring-sky-500', 'bg-sky-50', 'dark:bg-sky-900/30');
                    label.classList.add('border-slate-200', 'dark:border-slate-700');
                }
            }
        });
        calcularVuelto();
    };

    // Eventos del formulario de cobro
    document.getElementById('input-paga-con')?.addEventListener('input', calcularVuelto);
    document.getElementById('form-cobro')?.addEventListener('submit', procesarCobroFinal);
}

export function renderProductosVenta() {
    // Filtrar productos para la sede actual o global
    const productosValidos = state.productos.filter(p => {
        if (state.userRole === 'admin' || state.userRole === 'master') return true;
        return !p.localId || p.localId === 'global' || p.localId === state.userLocalId;
    });

    const vasos = productosValidos.filter(p => p.categoria === 'vaso');
    const extras = productosValidos.filter(p => p.categoria === 'extra');

    const gridVasos = document.getElementById('grid-vasos');
    const gridExtras = document.getElementById('grid-extras');

    if (gridVasos) {
        gridVasos.innerHTML = vasos.map(p => {
            const isAgotado = p.stock !== null && p.stock <= 0;
            return `
            <button onclick="${isAgotado ? '' : `window.abrirModalArmar('${p.id}')`}" class="relative p-3 rounded-xl border ${isAgotado ? 'border-red-300 bg-red-50 opacity-60 cursor-not-allowed' : 'border-slate-200 bg-white hover:border-sky-500 hover:shadow-md transition-all active:scale-95'} dark:bg-slate-800 dark:border-slate-700 flex flex-col items-center text-center">
                ${isAgotado ? '<span class="absolute top-0 right-0 bg-red-500 text-white text-[9px] px-2 py-0.5 rounded-bl-lg rounded-tr-lg font-bold">Agotado</span>' : ''}
                <div class="w-12 h-12 mb-2 bg-sky-100 text-sky-500 rounded-full flex items-center justify-center dark:bg-sky-500/20"><i data-lucide="cup-soda" class="w-6 h-6"></i></div>
                <span class="text-sm font-bold text-slate-800 dark:text-white leading-tight">${p.nombre}</span>
                <span class="text-xs font-black text-sky-500 mt-1">${formatMoney(p.precio)}</span>
            </button>`;
        }).join('');
    }

    if (gridExtras) {
        gridExtras.innerHTML = extras.map(p => {
            const isAgotado = p.stock !== null && p.stock <= 0;
            return `
            <button onclick="${isAgotado ? '' : `window.agregarProductoDirecto('${p.id}')`}" class="relative p-3 rounded-xl border ${isAgotado ? 'border-red-300 bg-red-50 opacity-60 cursor-not-allowed' : 'border-slate-200 bg-white hover:border-sky-500 hover:shadow-md transition-all active:scale-95'} dark:bg-slate-800 dark:border-slate-700 flex flex-col items-center text-center">
                ${isAgotado ? '<span class="absolute top-0 right-0 bg-red-500 text-white text-[9px] px-2 py-0.5 rounded-bl-lg rounded-tr-lg font-bold">Agotado</span>' : ''}
                <div class="w-10 h-10 mb-2 bg-slate-100 text-slate-500 rounded-full flex items-center justify-center dark:bg-slate-700 dark:text-slate-300"><i data-lucide="package" class="w-5 h-5"></i></div>
                <span class="text-xs font-bold text-slate-800 dark:text-white leading-tight">${p.nombre}</span>
                <span class="text-xs font-black text-sky-500 mt-1">${formatMoney(p.precio)}</span>
            </button>`;
        }).join('');
    }

    if(window.lucide) window.lucide.createIcons();
}

function abrirModalArmar(prodId) {
    vasoActual = state.productos.find(p => p.id === prodId);
    if (!vasoActual) return;
    
    saboresElegidos = [];
    
    const m = document.getElementById('modal-vaso');
    const title = document.getElementById('modal-vaso-title');
    const subtitle = document.getElementById('modal-vaso-subtitle');
    const gridSabores = document.getElementById('grid-sabores-modal');
    
    if(title) title.textContent = `Armando: ${vasoActual.nombre}`;
    if(subtitle) subtitle.textContent = `Elige hasta ${vasoActual.limite_sabores || 1} sabores`;
    
    const sabores = state.productos.filter(p => p.categoria === 'sabor' && (!p.localId || p.localId === 'global' || p.localId === state.userLocalId));
    
    if (gridSabores) {
        gridSabores.innerHTML = sabores.map(s => {
            const isAgotado = s.stock !== null && s.stock <= 0;
            return `
            <button ${isAgotado ? 'disabled' : `onclick="window.toggleSabor('${s.nombre}')"`} id="btn-sabor-${s.nombre.replace(/\s+/g, '-')}" class="p-3 border rounded-xl flex items-center gap-2 transition-all ${isAgotado ? 'border-red-200 bg-red-50 opacity-50 cursor-not-allowed' : 'border-slate-200 bg-white hover:border-sky-300 dark:bg-slate-800 dark:border-slate-700'}">
                <div class="w-4 h-4 rounded-full border border-slate-300 flex items-center justify-center indicator-sabor dark:border-slate-600"></div>
                <span class="text-sm font-bold text-slate-700 dark:text-white capitalize ${isAgotado ? 'text-red-500 line-through' : ''}">${s.nombre}</span>
            </button>`;
        }).join('');
    }

    actualizarUIBotonesSabor();

    m.classList.remove('hidden');
    setTimeout(() => m.classList.remove('opacity-0'), 10);
}

function cerrarModalArmar() {
    const m = document.getElementById('modal-vaso');
    if(m) {
        m.classList.add('opacity-0');
        setTimeout(() => m.classList.add('hidden'), 300);
    }
}

function toggleSabor(nombre) {
    if (!vasoActual) return;
    const limit = vasoActual.limite_sabores || 1;
    
    const idx = saboresElegidos.indexOf(nombre);
    if (idx !== -1) {
        saboresElegidos.splice(idx, 1);
    } else {
        if (saboresElegidos.length < limit) {
            saboresElegidos.push(nombre);
        } else {
            if (window.mostrarToast) window.mostrarToast('Límite', `Solo puedes elegir ${limit} sabores.`, 'amber');
            return;
        }
    }
    actualizarUIBotonesSabor();
}

function actualizarUIBotonesSabor() {
    const btnConfirmar = document.getElementById('btn-confirmar-vaso');
    if (btnConfirmar) {
        if (saboresElegidos.length > 0) {
            btnConfirmar.disabled = false;
            btnConfirmar.classList.remove('opacity-50', 'cursor-not-allowed');
        } else {
            btnConfirmar.disabled = true;
            btnConfirmar.classList.add('opacity-50', 'cursor-not-allowed');
        }
    }

    const sabores = state.productos.filter(p => p.categoria === 'sabor');
    sabores.forEach(s => {
        const btnId = `btn-sabor-${s.nombre.replace(/\s+/g, '-')}`;
        const btn = document.getElementById(btnId);
        if (!btn) return;

        const isSelected = saboresElegidos.includes(s.nombre);
        const indicator = btn.querySelector('.indicator-sabor');
        
        if (isSelected) {
            btn.classList.add('border-sky-500', 'bg-sky-50', 'dark:bg-sky-900/30', 'ring-1', 'ring-sky-500');
            btn.classList.remove('border-slate-200', 'bg-white');
            if(indicator) {
                indicator.classList.add('bg-sky-500', 'border-sky-500');
                indicator.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-white"></i>';
            }
        } else {
            btn.classList.remove('border-sky-500', 'bg-sky-50', 'dark:bg-sky-900/30', 'ring-1', 'ring-sky-500');
            if(!btn.classList.contains('cursor-not-allowed')) btn.classList.add('border-slate-200', 'bg-white');
            if(indicator) {
                indicator.classList.remove('bg-sky-500', 'border-sky-500');
                indicator.innerHTML = '';
            }
        }
    });
    if(window.lucide) window.lucide.createIcons();
}

function confirmarVaso() {
    if (!vasoActual || saboresElegidos.length === 0) return;
    
    // --- LA MAGIA ESTÁ AQUÍ ---
    // Agrega al carrito y pasa el arreglo con los sabores seleccionados
    agregarAlCarrito(vasoActual, 1, [...saboresElegidos]);
    cerrarModalArmar();
}

function agregarProductoDirecto(prodId) {
    const prod = state.productos.find(p => p.id === prodId);
    if (!prod) return;
    agregarAlCarrito(prod, 1, []);
}

function agregarAlCarrito(prod, cant, sabores) {
    // Buscar si ya existe el mismo producto con exactamente los MISMOS sabores
    const exist = state.carrito.find(item => 
        item.productoId === prod.id && 
        JSON.stringify(item.sabores) === JSON.stringify(sabores) &&
        item.precio === (prod.precio || 0)
    );

    if (exist) {
        exist.cantidad += cant;
    } else {
        state.carrito.push({
            productoId: prod.id,
            nombre: prod.nombre,
            precio: prod.precio || 0,
            costo: prod.costo || 0,
            cantidad: cant,
            sabores: sabores // <--- GUARDA LOS SABORES AQUÍ
        });
    }
    
    actualizarCarritoUI();
    if(window.mostrarToast) window.mostrarToast('Agregado', `${prod.nombre} al carrito.`, 'sky');
}

function eliminarDelCarrito(index) {
    state.carrito.splice(index, 1);
    actualizarCarritoUI();
}

export function actualizarCarritoUI() {
    const list = document.getElementById('carrito-list');
    const subBtn = document.getElementById('btn-submit-cobro');
    const badge = document.getElementById('badge-carrito');
    const emptyState = document.getElementById('empty-cart-state');
    
    let total = 0;
    let cantTotal = 0;

    if (list) {
        if (state.carrito.length === 0) {
            list.innerHTML = '';
            if(emptyState) emptyState.classList.remove('hidden');
            if(subBtn) subBtn.disabled = true;
        } else {
            if(emptyState) emptyState.classList.add('hidden');
            if(subBtn) subBtn.disabled = false;
            
            list.innerHTML = state.carrito.map((item, index) => {
                const totalItem = item.precio * item.cantidad;
                total += totalItem;
                cantTotal += item.cantidad;

                let isAjuste = item.productoId === 'AJUSTE';
                
                // --- VISUALIZAR SABORES EN EL CARRITO ---
                let saboresTxt = '';
                if (item.sabores && item.sabores.length > 0) {
                    saboresTxt = `<p class="text-[10px] text-slate-500 italic leading-tight mt-0.5 mb-1 dark:text-slate-400">↳ ${item.sabores.join(', ')}</p>`;
                }

                return `
                <div class="flex justify-between items-center py-3 border-b border-slate-200 dark:border-slate-700/50 last:border-0 relative group">
                    <div class="flex-1 pr-3">
                        <p class="text-sm font-bold text-slate-800 dark:text-white flex items-start gap-1.5 leading-tight">
                            <span class="text-sky-500 font-black">${item.cantidad}x</span> 
                            <span class="${isAjuste ? 'text-amber-500' : ''}">${item.nombre}</span>
                        </p>
                        ${saboresTxt}
                    </div>
                    <div class="flex items-center gap-3">
                        <p class="font-bold text-slate-800 dark:text-white whitespace-nowrap">${isAjuste && item.precio < 0 ? '' : '+'}${formatMoney(totalItem)}</p>
                        <button onclick="window.eliminarDelCarrito(${index})" class="text-red-400 hover:text-red-600 bg-red-50 hover:bg-red-100 p-1.5 rounded-lg transition-colors dark:bg-slate-800 dark:hover:bg-red-500/20">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                </div>`;
            }).join('');
        }
    }

    const elTotal = document.getElementById('carrito-total');
    if (elTotal) elTotal.textContent = formatMoney(total);
    if (badge) {
        badge.textContent = cantTotal;
        badge.classList.toggle('hidden', cantTotal === 0);
    }
    
    calcularVuelto();
    if(window.lucide) window.lucide.createIcons();
}

function calcularVuelto() {
    let total = state.carrito.reduce((acc, item) => acc + (item.precio * item.cantidad), 0);
    const method = document.querySelector('input[name="metodo_pago"]:checked')?.value || 'efectivo';
    const tv = document.getElementById('txt-vuelto');
    
    if (!tv) return;
    
    if (method === 'efectivo') {
        const val = parseFloat(document.getElementById('input-paga-con')?.value || 0);
        const v = val - total;
        tv.textContent = v >= 0 ? formatMoney(v) : 'S/ 0.00';
        tv.classList.toggle('text-emerald-500', v >= 0);
        tv.classList.toggle('text-slate-400', v < 0);
    } else {
        tv.textContent = 'S/ 0.00';
        tv.classList.remove('text-emerald-500');
        tv.classList.add('text-slate-400');
    }
}

function abrirModalAjuste(tipo) {
    if (state.carrito.length === 0) {
        if(window.mostrarToast) window.mostrarToast('Carrito vacío', 'Agrega productos primero.', 'amber');
        return;
    }
    
    const m = document.getElementById('modal-ajuste');
    const title = document.getElementById('ajuste-titulo');
    const desc = document.getElementById('ajuste-desc');
    const monto = document.getElementById('ajuste-monto');
    
    if(title) title.textContent = tipo === 'Descuento' ? 'Aplicar Descuento' : 'Cargo Extra';
    if(desc) desc.value = tipo === 'Descuento' ? 'Descuento por promoción' : 'Cargo adicional';
    if(monto) monto.value = '';
    
    m.dataset.tipo = tipo;
    m.classList.remove('hidden');
    setTimeout(() => m.classList.remove('opacity-0'), 10);
}

function confirmarAjuste() {
    const m = document.getElementById('modal-ajuste');
    const tipo = m.dataset.tipo;
    const desc = document.getElementById('ajuste-desc').value.trim() || tipo;
    let monto = parseFloat(document.getElementById('ajuste-monto').value);
    
    if (isNaN(monto) || monto <= 0) return;
    
    if (tipo === 'Descuento') monto = -Math.abs(monto);
    
    state.carrito.push({
        productoId: 'AJUSTE',
        nombre: desc,
        precio: monto,
        costo: 0,
        cantidad: 1,
        sabores: []
    });
    
    actualizarCarritoUI();
    
    m.classList.add('opacity-0');
    setTimeout(() => m.classList.add('hidden'), 300);
}

async function procesarCobroFinal(e) {
    e.preventDefault();
    if (state.carrito.length === 0) return;

    const btn = document.getElementById('btn-submit-cobro');
    const origTxt = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline mr-2"></i> Cobrando...';
    btn.disabled = true;

    const total = state.carrito.reduce((acc, item) => acc + (item.precio * item.cantidad), 0);
    const method = document.querySelector('input[name="metodo_pago"]:checked')?.value || 'efectivo';
    
    let pEfe = 0, pYap = 0;
    
    if (method === 'efectivo') pEfe = total;
    else if (method === 'yape') pYap = total;
    else if (method === 'mixto') {
        pEfe = parseFloat(document.getElementById('input-mixto-efectivo')?.value || 0);
        pYap = parseFloat(document.getElementById('input-mixto-yape')?.value || 0);
        if (Math.abs((pEfe + pYap) - total) > 0.01) {
            if(window.mostrarAlerta) window.mostrarAlerta('Montos Inválidos', 'El pago mixto no cuadra con el total.', 'red');
            btn.innerHTML = origTxt; btn.disabled = false;
            return;
        }
    }

    const tId = generateTicketId();
    const cr = [...state.carrito];
    const editado = window.ticketEditadoOriginal || false;
    
    const locId = state.userLocalId || 'general';
    const locNom = state.userLocal || 'Sin Local';

    // --- LÓGICA OPTIMISTA BATCH ---
    const bt = writeBatch(db);
    const vRef = doc(collection(db, "ventas"), tId);
    const fStr = getTodayDateStr();
    const ts = serverTimestamp();

    // 1. Guardar la Venta (con los sabores viajando integrados)
    bt.set(vRef, {
        items: cr,
        total: total,
        costo_total: cr.reduce((acc, item) => acc + (item.costo * item.cantidad), 0),
        pago_efectivo: pEfe,
        pago_yape: pYap,
        metodo_pago: method,
        metodoFinal: method,
        estado: 'pendiente',
        cajeroEmail: state.currentUser?.email || 'Desconocido',
        localId: locId,
        localNombre: locNom,
        fechaStr: fStr,
        fechaHora: Date.now(),
        timestamp: ts,
        editado: editado
    });

    // 2. Actualizar Caja Diaria
    bt.set(doc(db, "caja_diaria", `${fStr}_${locId}`), {
        total_ingresos: increment(total),
        total_efectivo: increment(pEfe),
        total_yape: increment(pYap),
        total_costos: increment(cr.reduce((acc, item) => acc + (item.costo * item.cantidad), 0)),
        cantidad_ventas: increment(1)
    }, { merge: true });

    // 3. Descontar Stock en BD
    cr.forEach(item => {
        if (item.productoId !== 'AJUSTE') {
            const prod = state.productos.find(x => x.id === item.productoId);
            if (prod && prod.stock !== null) {
                bt.update(doc(db, "productos", item.productoId), { stock: increment(-item.cantidad) });
            }
        } 
    });
    
    // --- Enviar a la nube en background ---
    bt.commit().catch(err => console.error("Error sincronizando venta:", err));
    
    // --- Limpieza INMEDIATA UI ---
    window.clearCart(); 
    window.ticketEditadoOriginal = false;
    actualizarCarritoUI(); 
    
    const inPagaCon = document.getElementById('input-paga-con');
    const inMixEfe = document.getElementById('input-mixto-efectivo');
    const inMixYap = document.getElementById('input-mixto-yape');
    const txtVuelto = document.getElementById('txt-vuelto');

    if (inPagaCon) inPagaCon.value = ''; 
    if (inMixEfe) inMixEfe.value = ''; 
    if (inMixYap) inMixYap.value = ''; 
    if (txtVuelto) txtVuelto.textContent = 'S/ 0.00';
    
    if(window.mostrarToast) window.mostrarToast('Venta Exitosa', `Ticket #${tId.split('-')[1]} registrado en cola.`, 'emerald');
    
    // Descontar RAM
    cr.forEach(item => {
        if(item.productoId !== 'AJUSTE') {
            const prod = state.productos.find(x => x.id === item.productoId);
            if (prod && prod.stock !== null) prod.stock -= item.cantidad;
        }
    });
    renderProductosVenta();
    
    btn.innerHTML = origTxt; 
    btn.disabled = false;
}
