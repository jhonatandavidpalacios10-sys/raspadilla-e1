import { db, collection, query, where, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, deleteDoc, getDoc, writeBatch, increment } from '../core/firebase-setup.js';
import { getTodayDateStr, formatMoney } from '../utils/helpers.js'; 
import { state } from '../core/store.js';

let unsubscribeVentasCaja = null;
let unsubscribeGastosCaja = null;
let cajaInicializada = false;
let ventasDelDia = [];
let gastosDelDia = [];

export function initCaja() {
    // CANDADO: Evita duplicación de listeners si cambia el turno (Bug Fantasma solucionado)
    if(cajaInicializada) return;
    cajaInicializada = true;

    // Filtros y Formularios
    document.getElementById('filtro-local-caja')?.addEventListener('change', () => renderArqueoCaja());
    document.getElementById('form-gasto')?.addEventListener('submit', guardarGasto);
    document.getElementById('btn-registrar-gasto')?.addEventListener('click', abrirModalGasto);
    document.getElementById('btn-cerrar-modal-gasto')?.addEventListener('click', cerrarModalGasto);

    // Exponer funciones de edición/eliminación al entorno global para poder llamarlas desde el HTML
    window.eliminarOperacionCaja = eliminarOperacionCaja;
    window.editarOperacionCaja = editarOperacionCaja;

    // Iniciar escucha en tiempo real
    iniciarEscuchaCaja();
}

function iniciarEscuchaCaja() {
    const hoy = getTodayDateStr();

    if(unsubscribeVentasCaja) unsubscribeVentasCaja();
    if(unsubscribeGastosCaja) unsubscribeGastosCaja();

    // Traemos todas las ventas del día actual
    const qVentas = query(collection(db, "ventas"), where("fechaStr", "==", hoy));
    unsubscribeVentasCaja = onSnapshot(qVentas, (snapshot) => {
        // FIX: Usamos serverTimestamps: 'estimate' para evitar saltos temporales
        ventasDelDia = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) }));
        renderArqueoCaja();
    });

    // Traemos todos los gastos/retiros del día actual
    const qGastos = query(collection(db, "gastos"), where("fechaStr", "==", hoy));
    unsubscribeGastosCaja = onSnapshot(qGastos, (snapshot) => {
        // FIX: Usamos serverTimestamps: 'estimate' para evitar saltos temporales
        gastosDelDia = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) }));
        renderArqueoCaja();
    });
}

function renderArqueoCaja() {
    const localSelect = document.getElementById('filtro-local-caja');
    const localFiltro = localSelect ? localSelect.value : 'todas';

    // FIX CRÍTICO: Filtrar por local unificando lógica con pedidos
    const isAdmin = (state.userRole === 'admin' || state.userRole === 'master');
    const miSedeId = state.userLocalId || "";

    let vFiltradas = ventasDelDia.filter(v => {
        if (isAdmin) {
            if (localFiltro === 'todas') return true;
            if (localFiltro === '') return !v.localId || v.localId === '' || v.localId === 'general';
            return v.localId === localFiltro;
        } else {
            return (v.localId === miSedeId || (!v.localId && miSedeId === "") || (v.localId === 'general' && miSedeId === ""));
        }
    });

    let gFiltrados = gastosDelDia.filter(g => {
        if (isAdmin) {
            if (localFiltro === 'todas') return true;
            if (localFiltro === '') return !g.localId || g.localId === '' || g.localId === 'general';
            return g.localId === localFiltro;
        } else {
            return (g.localId === miSedeId || (!g.localId && miSedeId === "") || (g.localId === 'general' && miSedeId === ""));
        }
    });

    let totalIngresos = 0;
    let totalEfectivo = 0;
    let totalYape = 0;
    let totalGastos = 0;

    vFiltradas.forEach(v => {
        totalIngresos += parseFloat(v.total || 0);
        totalEfectivo += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0);
        totalYape += parseFloat(v.pago_yape || v.pagoYape || 0);
    });

    gFiltrados.forEach(g => {
        totalGastos += parseFloat(g.monto || 0);
    });

    const netoEfectivo = totalEfectivo - totalGastos;

    // Actualizar Panel Superior (Dashboard de Caja) - FIX: Sincronizados con index.html
    const elIngresos = document.getElementById('caja-total');
    const elEfectivo = document.getElementById('caja-efectivo');
    const elYape = document.getElementById('caja-yape');
    const elGastos = document.getElementById('caja-gastos');
    const elNeto = document.getElementById('caja-neta');

    if(elIngresos) elIngresos.textContent = formatMoney(totalIngresos);
    if(elEfectivo) elEfectivo.textContent = formatMoney(totalEfectivo);
    if(elYape) elYape.textContent = formatMoney(totalYape);
    if(elGastos) elGastos.textContent = formatMoney(totalGastos);
    if(elNeto) elNeto.textContent = formatMoney(netoEfectivo);

    // Pintar tarjetas
    renderListaOperaciones(vFiltradas, gFiltrados);
}

function renderListaOperaciones(ventas, gastos) {
    // FIX CRÍTICO: ID sincronizado con index.html
    const lista = document.getElementById('caja-historial-list');
    if (!lista) return;

    let operaciones = [
        ...ventas.map(v => ({...v, tipoOp: 'venta', time: v.fechaHora || (v.timestamp && typeof v.timestamp.toMillis === 'function' ? v.timestamp.toMillis() : (v.timestamp?.seconds * 1000)) || Date.now()})),
        ...gastos.map(g => ({...g, tipoOp: 'gasto', time: g.fechaHora || (g.timestamp && typeof g.timestamp.toMillis === 'function' ? g.timestamp.toMillis() : (g.timestamp?.seconds * 1000)) || Date.now()}))
    ];

    // Ordenar de la más reciente a la más antigua
    operaciones.sort((a, b) => b.time - a.time);

    if (operaciones.length === 0) {
        lista.innerHTML = '<div class="text-center text-slate-500 py-8 flex flex-col items-center"><i data-lucide="inbox" class="w-10 h-10 mb-2 opacity-50"></i><p>No hay operaciones registradas aún.</p></div>';
        if(window.lucide) window.lucide.createIcons();
        return;
    }

    lista.innerHTML = operaciones.map(op => {
        const isVenta = op.tipoOp === 'venta';
        const icon = isVenta ? 'trending-up' : 'trending-down';
        const color = isVenta ? 'text-emerald-500' : 'text-red-500';
        const bgIcon = isVenta ? 'bg-emerald-500/10' : 'bg-red-500/10';
        const titulo = isVenta ? `Venta #${op.id.split('-')[1] || op.id.substring(0,6)}` : `Gasto: ${op.descripcion}`;
        const monto = isVenta ? formatMoney(op.total) : formatMoney(op.monto);
        
        // --- TRAZABILIDAD VISUAL (AUDITORÍA AÑADIDA) ---
        const autorOriginal = op.cajeroEmail || op.creadoPor || 'Vendedor Anónimo';
        const autorEdicion = op.editadoPor ? `<span class="text-amber-500 ml-2 font-medium">(Editado por: ${op.editadoPor})</span>` : '';
        const tagAutor = `<div class="text-[10.5px] text-slate-500 flex items-center mt-1"><i data-lucide="user" class="w-3 h-3 mr-1"></i> Cajero: <b class="ml-1">${autorOriginal}</b> ${autorEdicion}</div>`;

        let badges = '';
        if (isVenta) {
            const efe = parseFloat(op.pago_efectivo || op.pagoEfectivo || 0);
            const yap = parseFloat(op.pago_yape || op.pagoYape || 0);
            if (efe > 0) badges += `<span class="bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 text-[10px] px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-500/30 mr-1">EFE: ${formatMoney(efe)}</span>`;
            if (yap > 0) badges += `<span class="bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400 text-[10px] px-2 py-0.5 rounded border border-purple-200 dark:border-purple-500/30">YAP: ${formatMoney(yap)}</span>`;
        }

        return `
        <div class="bg-white dark:bg-slate-800 p-4 rounded-xl border ${op.editadoPor ? 'border-amber-300 dark:border-amber-700/50 shadow-amber-500/10' : 'border-slate-200 dark:border-slate-700'} shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 relative transition-all hover:border-sky-300">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${bgIcon} ${color}">
                    <i data-lucide="${icon}" class="w-5 h-5"></i>
                </div>
                <div>
                    <p class="text-sm font-bold text-slate-800 dark:text-white capitalize flex items-center gap-2">
                        ${titulo}
                        ${op.editadoPor ? '<i data-lucide="alert-circle" class="w-3 h-3 text-amber-500" title="Ticket Editado"></i>' : ''}
                    </p>
                    <div class="mt-1">${badges}</div>
                    ${tagAutor}
                </div>
            </div>
            <div class="flex flex-col sm:items-end w-full sm:w-auto mt-2 sm:mt-0">
                <span class="text-lg font-black ${color} mb-2 sm:mb-0">${isVenta ? '+' : '-'}${monto}</span>
                
                <!-- Solo administradores o dueños deberían editar/eliminar -->
                ${(state.userRole === 'admin' || state.userRole === 'master') ? `
                <div class="flex gap-2 w-full sm:w-auto justify-end">
                    <button onclick="editarOperacionCaja('${op.id}', '${op.tipoOp}')" class="p-1.5 text-sky-500 hover:bg-sky-50 dark:hover:bg-sky-500/10 rounded transition-colors border border-transparent hover:border-sky-200 dark:hover:border-sky-900" title="Editar Monto">
                        <i data-lucide="edit" class="w-4 h-4"></i>
                    </button>
                    <button onclick="eliminarOperacionCaja('${op.id}', '${op.tipoOp}')" class="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded transition-colors border border-transparent hover:border-red-200 dark:hover:border-red-900" title="Anular Operación">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                </div>
                ` : ''}
            </div>
        </div>`;
    }).join('');

    if(window.lucide) window.lucide.createIcons();
}

function guardarGasto(e) {
    e.preventDefault();
    // 🚀 Lógica optimista y sin esperas
    const desc = document.getElementById('input-desc-gasto')?.value.trim() || document.getElementById('gasto-desc')?.value.trim();
    const monto = parseFloat(document.getElementById('input-monto-gasto')?.value || document.getElementById('gasto-monto')?.value);
    
    const localSelect = document.getElementById('filtro-local-caja') || document.getElementById('gasto-local');
    // FIX CRÍTICO: Usamos el ID de local exacto para el documento o 'general' si está vacío
    const localId = localSelect && localSelect.value !== 'todas' ? localSelect.value : (state.userLocalId || '');
    const cajaId = localId || 'general';
    
    if (!desc || isNaN(monto) || monto <= 0) return;

    try {
        const batch = writeBatch(db);
        const gRef = doc(collection(db, "gastos"));
        const fStr = getTodayDateStr();

        batch.set(gRef, {
            descripcion: desc,
            monto: monto,
            fechaStr: fStr,
            fechaHora: Date.now(),
            timestamp: serverTimestamp(),
            localId: localId,
            creadoPor: state.currentUser?.username || state.currentUser?.email || 'Desconocido',
            tipo: 'gasto'
        });

        // Actualizar métricas diarias
        const cRef = doc(db, "caja_diaria", `${fStr}_${cajaId}`);
        batch.set(cRef, {
            total_gastos: increment(monto)
        }, { merge: true });

        // 1. CIERRE INSTANTÁNEO DE UI
        cerrarModalGasto();
        const formGasto = document.getElementById('form-gasto');
        if(formGasto) formGasto.reset();
        if(window.mostrarToast) window.mostrarToast('Procesando', 'Gasto registrado en background.', 'sky');

        // 2. ENVÍO A LA NUBE SIN AWAIT
        batch.commit().catch(e => {
            console.error("Error al guardar gasto:", e);
            if(window.mostrarAlerta) window.mostrarAlerta('Error', 'No se pudo sincronizar el gasto.', 'red');
        });

    } catch (error) {
        console.error("Error al guardar gasto:", error);
    }
}

// LÓGICA RECONSTRUIDA Y BLINDADA MATEMÁTICAMENTE
function editarOperacionCaja(id, tipo) {
    // 🚀 Lógica optimista (quitamos async/await de validaciones y UI)
    try {
        if (tipo === 'venta') {
            const vData = ventasDelDia.find(v => v.id === id);
            if (!vData) return;

            const nuevoMontoStr = prompt(`Venta Original: S/ ${vData.total.toFixed(2)}\nIngresa el NUEVO monto total correcto:`);
            if (!nuevoMontoStr) return;
            
            const nuevoMonto = parseFloat(nuevoMontoStr);
            if (isNaN(nuevoMonto) || nuevoMonto < 0) {
                if(window.mostrarAlerta) window.mostrarAlerta('Error', 'Monto inválido', 'red');
                return;
            }

            const diffTotal = nuevoMonto - vData.total;
            if (diffTotal === 0) return; // No hay cambios

            let nEfe = parseFloat(vData.pago_efectivo || vData.pagoEfectivo || 0);
            let nYap = parseFloat(vData.pago_yape || vData.pagoYape || 0);
            let diffEfe = 0;
            let diffYap = 0;
            const mp = (vData.metodoFinal || vData.metodo_pago || 'efectivo').toLowerCase();

            // RESPETAR LA NATURALEZA DEL PAGO ORIGINAL
            if (mp === 'efectivo') {
                diffEfe = diffTotal;
                nEfe = nuevoMonto;
            } else if (mp === 'yape' || mp === 'transferencia') {
                diffYap = diffTotal;
                nYap = nuevoMonto;
            } else if (mp === 'mixto') {
                // Al ser mixto, asumimos que el ajuste fue por un vuelto mal dado en efectivo.
                diffEfe = diffTotal;
                nEfe = nEfe + diffTotal;
                
                // Salvavidas: si le restamos tanto que el efectivo es negativo, jalamos de Yape
                if (nEfe < 0) {
                    diffYap = nEfe; 
                    nYap = nYap + diffYap;
                    nEfe = 0;
                }
            }

            const batch = writeBatch(db);
            const vRef = doc(db, "ventas", id);

            batch.update(vRef, { 
                total: nuevoMonto,
                pago_efectivo: nEfe,
                pagoEfectivo: nEfe,
                pago_yape: nYap,
                pagoYape: nYap,
                metodoFinal: mp, // Preservar 'mixto' en la BD
                editado: true,
                editadoPor: state.currentUser?.username || state.currentUser?.email || 'Desconocido',
                fechaEdicion: new Date().toISOString()
            });

            // FIX CRÍTICO: Re-cuadrar la Caja Diaria global con el ID seguro
            const locId = vData.localId || '';
            const cajaId = locId || 'general';
            const fStr = vData.fechaStr || getTodayDateStr();
            const cRef = doc(db, "caja_diaria", `${fStr}_${cajaId}`);

            batch.set(cRef, {
                total_ingresos: increment(diffTotal),
                total_efectivo: increment(diffEfe),
                total_yape: increment(diffYap)
            }, { merge: true });

            batch.commit().catch(e => console.error("Error al editar venta:", e));

        } else if (tipo === 'gasto') {
            const gData = gastosDelDia.find(g => g.id === id);
            if (!gData) return;
            
            const nuevoMontoStr = prompt(`Gasto Original: S/ ${gData.monto.toFixed(2)}\nIngresa el NUEVO monto del gasto:`);
            if (!nuevoMontoStr) return;
            
            const nuevoMonto = parseFloat(nuevoMontoStr);
            if (isNaN(nuevoMonto) || nuevoMonto < 0) return;

            const diffMonto = nuevoMonto - gData.monto;
            if (diffMonto === 0) return;

            const batch = writeBatch(db);
            const gRef = doc(db, "gastos", id);

            batch.update(gRef, { 
                monto: nuevoMonto,
                editadoPor: state.currentUser?.username || state.currentUser?.email || 'Desconocido',
                fechaEdicion: new Date().toISOString()
            });

            const locId = gData.localId || '';
            const cajaId = locId || 'general';
            const fStr = gData.fechaStr || getTodayDateStr();
            const cRef = doc(db, "caja_diaria", `${fStr}_${cajaId}`);

            batch.set(cRef, {
                total_gastos: increment(diffMonto)
            }, { merge: true });

            batch.commit().catch(e => console.error("Error al editar gasto:", e));
        }
        
        if (window.mostrarToast) window.mostrarToast('Modificado', 'Arqueo recalculado al centavo.', 'sky');
    } catch(e) {
        console.error(e);
        if(window.mostrarAlerta) window.mostrarAlerta('Error', 'Fallo al editar la operación.', 'red');
    }
}

function eliminarOperacionCaja(id, tipo) {
    if (!window.confirm(`ATENCIÓN: ¿Estás completamente seguro de ANULAR este registro de ${tipo.toUpperCase()}?`)) return;

    // 🚀 Lógica optimista
    try {
        const batch = writeBatch(db);

        if (tipo === 'venta') {
            const vData = ventasDelDia.find(v => v.id === id);
            if (!vData) return;
            
            const total = vData.total || 0;
            const efe = parseFloat(vData.pago_efectivo || vData.pagoEfectivo || 0);
            const yap = parseFloat(vData.pago_yape || vData.pagoYape || 0);

            const vRef = doc(db, "ventas", id);
            batch.delete(vRef);

            const locId = vData.localId || '';
            const cajaId = locId || 'general';
            const fStr = vData.fechaStr || getTodayDateStr();
            const cRef = doc(db, "caja_diaria", `${fStr}_${cajaId}`);

            batch.set(cRef, {
                total_ingresos: increment(-total),
                total_efectivo: increment(-efe),
                total_yape: increment(-yap)
            }, { merge: true });

            // Sincronizar de vuelta el stock si la venta se anula
            if (vData.items) {
                vData.items.forEach(item => {
                    if (item.productoId !== 'AJUSTE') {
                        const pRef = doc(db, "productos", item.productoId);
                        batch.update(pRef, { stock: increment(item.cantidad) });
                    }
                });
            }

        } else {
            // Anular un gasto
            const gData = gastosDelDia.find(g => g.id === id);
            if (!gData) return;
            
            const gRef = doc(db, "gastos", id);
            batch.delete(gRef);

            const locId = gData.localId || '';
            const cajaId = locId || 'general';
            const fStr = gData.fechaStr || getTodayDateStr();
            const cRef = doc(db, "caja_diaria", `${fStr}_${cajaId}`);

            batch.set(cRef, {
                total_gastos: increment(-(gData.monto || 0))
            }, { merge: true });
        }

        batch.commit().catch(e => console.error("Error en anulación background:", e));
        
        // Forzar actualización visual si inventario o carrito están expuestos
        if (window.cargarInventarioDesdeFirebase) window.cargarInventarioDesdeFirebase();
        if(window.mostrarToast) window.mostrarToast('Anulado', 'Registro borrado y stock repuesto.', 'red');

    } catch (e) {
        console.error("Error en anulación:", e);
    }
}

// Utilidades UI para Modales
function abrirModalGasto() {
    const m = document.getElementById('modal-gasto');
    if(m) {
        m.classList.remove('hidden');
        setTimeout(() => m.classList.remove('opacity-0'), 10);
    }
}

function cerrarModalGasto() {
    const m = document.getElementById('modal-gasto');
    if(m) {
        m.classList.add('opacity-0');
        setTimeout(() => m.classList.add('hidden'), 300);
    }
}
