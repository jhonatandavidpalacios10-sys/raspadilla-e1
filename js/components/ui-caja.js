import { db, collection, query, where, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, deleteDoc, getDoc, writeBatch, increment } from '../core/firebase-setup.js';
import { getTodayDateStr, formatMoney } from '../utils/helpers.js'; 
import { state } from '../core/store.js';

let unsubscribeVentasCaja = null;
let unsubscribeGastosCaja = null;
let cajaInicializada = false;
let ventasDelDia = [];
let gastosDelDia = [];

export function initCaja() {
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

    // Traemos todo lo del día actual a la RAM (Optimizando lecturas)
    const qVentas = query(collection(db, "ventas"), where("fechaStr", "==", hoy));
    const qGastos = query(collection(db, "gastos"), where("fechaStr", "==", hoy));

    unsubscribeVentasCaja = onSnapshot(qVentas, (snapshot) => {
        ventasDelDia = [];
        snapshot.forEach(d => { ventasDelDia.push({ id: d.id, ...d.data() }); });
        renderArqueoCaja();
    });

    unsubscribeGastosCaja = onSnapshot(qGastos, (snapshot) => {
        gastosDelDia = [];
        snapshot.forEach(d => { gastosDelDia.push({ id: d.id, ...d.data() }); });
        renderArqueoCaja();
    });
}

function abrirModalGasto() {
    const modal = document.getElementById('modal-gasto'); 
    if(!modal) return;
    
    const select = document.getElementById('gasto-local');
    if(select && (state.userRole === 'admin' || state.userRole === 'master')) {
        let opts = '<option value="ambas">Dividir en todas las sedes (Global)</option>';
        state.locales.forEach(l => opts += `<option value="${l.id}">${l.nombre}</option>`);
        select.innerHTML = opts; 
        select.parentElement.classList.remove('hidden');
    } else if (select) {
        select.innerHTML = `<option value="${state.userLocalId || ''}">${state.userLocal || 'Mi Local'}</option>`;
        select.parentElement.classList.add('hidden');
    }
    
    document.getElementById('form-gasto').reset();
    modal.classList.remove('hidden'); 
    setTimeout(() => modal.classList.remove('opacity-0'), 10);
    if(window.lucide) window.lucide.createIcons();
}

function cerrarModalGasto() { 
    const m = document.getElementById('modal-gasto'); 
    if(m) {
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
    }
}

async function guardarGasto(e) {
    e.preventDefault();
    const b = document.querySelector('#form-gasto button[type="submit"]'); 
    const oT = b.innerHTML; 
    b.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline"></i> Guardando...'; 
    b.disabled = true;
    
    try {
        const m = parseFloat(document.getElementById('gasto-monto').value); 
        const d = document.getElementById('gasto-desc').value.trim(); 
        const l = document.getElementById('gasto-local').value;
        const nombreL = l === 'ambas' ? 'Global' : (state.locales.find(x => x.id === l)?.nombre || 'Sede');
        
        await addDoc(collection(db, "gastos"), { 
            monto: m, 
            descripcion: d, 
            fechaStr: getTodayDateStr(), 
            timestamp: serverTimestamp(), 
            localId: l === 'ambas' ? '' : l, 
            localNombre: nombreL, 
            registradoPor: state.currentUser.email 
        });
        
        if(window.mostrarToast) window.mostrarToast('Gasto Registrado', `Se descontaron ${formatMoney(m)}`, 'red');
        cerrarModalGasto(); 
        // No llamamos a renderArqueoCaja() manualmente porque onSnapshot lo hará al instante
    } catch(err) {
        console.error(err);
        if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo guardar el gasto.", "red");
    } finally { 
        b.innerHTML = oT; 
        b.disabled = false; 
        if(window.lucide) window.lucide.createIcons();
    }
}

function renderArqueoCaja() {
    const list = document.getElementById('caja-historial-list'); 
    if(!list) return;
    
    let filtroLocal = document.getElementById('filtro-local-caja')?.value || 'todas';
    if (state.userRole !== 'master' && state.userRole !== 'admin') {
        filtroLocal = state.userLocalId || '';
    }

    let total = 0, gastosTotal = 0, efe = 0, yape = 0; 
    let allItems = [];
    const isAdmin = state.userRole === 'master' || state.userRole === 'admin';

    // 1. Procesar Ventas en RAM
    ventasDelDia.forEach(v => {
        let mostrar = false;
        if (isAdmin) {
            if (filtroLocal === 'todas') mostrar = true;
            else if (filtroLocal === '') mostrar = !v.localId || v.localId === '';
            else mostrar = v.localId === filtroLocal;
        } else {
            mostrar = (!v.localId || v.localId === state.userLocalId);
        }
        
        if (mostrar && v.estado !== 'rechazado') {
            total += parseFloat(v.total || 0); 
            efe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); 
            yape += parseFloat(v.pago_yape || v.pagoYape || 0);
        }
        if (mostrar) allItems.push({ tipo: 'venta', ...v });
    });

    // 2. Procesar Gastos en RAM
    gastosDelDia.forEach(g => {
        let mostrar = false;
        if (isAdmin) {
            if (filtroLocal === 'todas') mostrar = true;
            else if (filtroLocal === '') mostrar = !g.localId || g.localId === '';
            else mostrar = g.localId === filtroLocal;
        } else {
            mostrar = (!g.localId || g.localId === state.userLocalId);
        }
        
        if (mostrar) {
            gastosTotal += parseFloat(g.monto || 0);
            allItems.push({ tipo: 'gasto', ...g });
        }
    });

    // Ordenar cronológicamente (más recientes primero)
    allItems.sort((a,b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

    // Renderizado UI
    if (allItems.length === 0) {
        list.innerHTML = '<div class="col-span-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-6 text-center text-slate-500 shadow-sm"><i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 opacity-50"></i><p class="text-sm font-bold">No hay operaciones registradas aún.</p></div>';
    } else {
        let html = '';
        allItems.forEach(item => {
            const hora = item.timestamp ? new Date(item.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--';
            
            // Botones de acción dinámicos
            const btnActions = isAdmin ? `
                <div class="flex gap-1.5 mt-2 opacity-100 lg:opacity-0 group-hover:opacity-100 transition-opacity justify-end border-t border-slate-200 dark:border-slate-700/50 pt-2">
                    <button onclick="window.editarOperacionCaja('${item.tipo}', '${item.id}', ${item.tipo === 'venta' ? item.total : item.monto})" class="text-slate-500 hover:text-amber-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 dark:hover:bg-slate-700/50 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Editar</button>
                    <button onclick="window.eliminarOperacionCaja('${item.tipo}', '${item.id}')" class="text-slate-500 hover:text-red-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 dark:hover:bg-slate-700/50 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> ${item.tipo === 'venta' ? 'Anular' : 'Borrar'}</button>
                </div>
            ` : '';

            if (item.tipo === 'venta') {
                const isRechazado = item.estado === 'rechazado';
                const numItems = item.items ? item.items.length : 0;
                const mp = String(item.metodo_pago || item.metodoFinal || 'EFECTIVO').toUpperCase();
                const opacity = isRechazado ? 'opacity-50 grayscale' : '';
                const amountColor = isRechazado ? 'text-slate-400 line-through' : 'text-emerald-500';
                const sign = isRechazado ? '' : '+';
                
                html += `
                <div class="bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 p-3 rounded-xl hover:border-slate-300 dark:hover:border-slate-600 transition-all group shadow-sm ${opacity}">
                    <div class="flex justify-between items-start">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-500 shrink-0 border border-emerald-200 dark:border-emerald-500/20">
                                <i data-lucide="shopping-cart" class="w-4 h-4"></i>
                            </div>
                            <div>
                                <p class="text-sm font-bold text-slate-800 dark:text-white">Venta POS ${isRechazado ? '<span class="text-[9px] bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-400 px-1.5 py-0.5 rounded uppercase ml-2 border border-red-200 dark:border-transparent">Anulada</span>' : ''}</p>
                                <p class="text-[10px] text-slate-500">${numItems} item(s) ${item.localNombre && item.localNombre !== 'Sin Local' ? `• ${item.localNombre}` : ''}</p>
                            </div>
                        </div>
                        <div class="text-right">
                            <p class="font-black ${amountColor} text-sm">${sign} ${formatMoney(item.total)}</p>
                            <p class="text-[9px] text-slate-400 dark:text-slate-500 mt-0.5 font-bold">${hora} • <span class="${mp === 'YAPE' ? 'text-purple-500' : (mp === 'EFECTIVO' ? 'text-emerald-500' : 'text-sky-500')}">${mp}</span></p>
                        </div>
                    </div>
                    ${btnActions}
                </div>`;
            } else {
                html += `
                <div class="bg-red-50 dark:bg-red-500/5 border border-red-200 dark:border-red-500/20 p-3 rounded-xl hover:border-red-300 dark:hover:border-red-500/40 transition-all group shadow-sm">
                    <div class="flex justify-between items-start">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-full bg-red-100 dark:bg-red-500/10 flex items-center justify-center text-red-500 shrink-0 border border-red-200 dark:border-red-500/20">
                                <i data-lucide="trending-down" class="w-4 h-4"></i>
                            </div>
                            <div>
                                <p class="text-sm font-bold text-red-500">Gasto Registrado</p>
                                <p class="text-[10px] text-slate-500">${item.descripcion} ${item.localNombre && item.localNombre !== 'Global' ? `• ${item.localNombre}` : ''}</p>
                            </div>
                        </div>
                        <div class="text-right">
                            <p class="font-black text-red-500 text-sm">- ${formatMoney(item.monto)}</p>
                            <p class="text-[9px] text-red-400/70 mt-0.5 font-bold">${hora}</p>
                        </div>
                    </div>
                    ${btnActions}
                </div>`;
            }
        });
        list.innerHTML = html;
    }
    
    // Actualizar Tarjetas
    if(document.getElementById('caja-total')) document.getElementById('caja-total').textContent = formatMoney(total);
    if(document.getElementById('caja-gastos')) document.getElementById('caja-gastos').textContent = formatMoney(gastosTotal);
    if(document.getElementById('caja-efectivo')) document.getElementById('caja-efectivo').textContent = formatMoney(efe);
    if(document.getElementById('caja-yape')) document.getElementById('caja-yape').textContent = formatMoney(yape);
    
    const cN = total - gastosTotal; 
    const netEl = document.getElementById('caja-neta');
    if(netEl) { 
        netEl.textContent = formatMoney(cN); 
        netEl.className = cN >= 0 ? "text-xl md:text-2xl font-black text-emerald-500" : "text-xl md:text-2xl font-black text-red-500"; 
    }
    
    if(window.lucide) window.lucide.createIcons();
}

// ========================================================
// EDICIÓN Y ANULACIÓN CON REEMBOLSO DE STOCK Y CAJA
// ========================================================
async function eliminarOperacionCaja(tipo, id) {
    if (state.userRole !== 'master' && state.userRole !== 'admin') return;
    
    if (window.mostrarConfirmacion) {
        window.mostrarConfirmacion(`¿Estás seguro de ${tipo === 'venta' ? 'anular esta venta? (El stock se devolverá)' : 'eliminar este gasto?'}`, async () => {
            try {
                if (tipo === 'venta') {
                    const vRef = doc(db, "ventas", id);
                    const vSnap = await getDoc(vRef);
                    
                    if (!vSnap.exists()) return;
                    const vData = vSnap.data();

                    if (vData.estado === 'rechazado') {
                        if(window.mostrarToast) window.mostrarToast('Aviso', 'Esta venta ya fue anulada previamente.', 'amber');
                        return;
                    }

                    const batch = writeBatch(db);

                    // 1. Marcar ticket como anulado
                    batch.update(vRef, { 
                        estado: 'rechazado',
                        anuladoPor: state.currentUser.email,
                        fechaAnulacion: new Date().toISOString()
                    });

                    // 2. Restar de la caja acumulada del día (Evita descuadres financieros)
                    const locId = vData.localId || 'general';
                    const fStr = vData.fechaStr;
                    const cRef = doc(db, "caja_diaria", `${fStr}_${locId}`);

                    batch.set(cRef, {
                        total_ingresos: increment(-(vData.total || 0)),
                        total_costos: increment(-(vData.costoTotal || vData.costo_total || 0)),
                        total_efectivo: increment(-(vData.pagoEfectivo || vData.pago_efectivo || 0)),
                        total_yape: increment(-(vData.pagoYape || vData.pago_yape || 0)),
                        cantidad_ventas: increment(-1)
                    }, { merge: true });

                    // 3. Devolver los productos al inventario (Protección para productos ilimitados)
                    if (vData.items) {
                        vData.items.forEach(item => {
                            if (item.productoId !== 'AJUSTE') {
                                const p = state.productos.find(x => x.id === item.productoId);
                                // Verificamos que el producto exista y maneje stock (que no sea infinito/null)
                                if (p && p.stock !== null) {
                                    const pRef = doc(db, "productos", item.productoId);
                                    batch.update(pRef, { stock: increment(item.cantidad) });
                                }
                            }
                        });
                    }

                    await batch.commit();

                    // Refrescar Inventario local para que la UI de Ventas tenga el nuevo stock real
                    if (window.cargarInventarioDesdeFirebase) {
                        await window.cargarInventarioDesdeFirebase();
                    }

                } else if (tipo === 'gasto') {
                    await deleteDoc(doc(db, "gastos", id));
                }
                
                if (window.mostrarToast) window.mostrarToast('Completado', 'Operación anulada y balances corregidos.', 'emerald');
            } catch (err) {
                console.error(err);
                if (window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo completar la acción.", "red");
            }
        });
    }
}

async function editarOperacionCaja(tipo, id, montoActual) {
    if (state.userRole !== 'master' && state.userRole !== 'admin') return;
    
    const nuevoMontoStr = prompt(`Ingresa el nuevo total (S/) para este ${tipo}:`, montoActual);
    
    if (nuevoMontoStr === null || nuevoMontoStr.trim() === "") return;
    
    const nuevoMonto = parseFloat(nuevoMontoStr);
    if (isNaN(nuevoMonto) || nuevoMonto < 0) {
        if(window.mostrarToast) window.mostrarToast('Dato Inválido', 'El monto ingresado no es correcto.', 'amber');
        return;
    }

    try {
        if (tipo === 'venta') {
            const vRef = doc(db, "ventas", id);
            const vSnap = await getDoc(vRef);
            if (!vSnap.exists()) return;
            
            const vData = vSnap.data();

            if (vData.estado === 'rechazado') {
                if(window.mostrarToast) window.mostrarToast('Aviso', 'No puedes editar una venta que ya fue anulada.', 'amber');
                return;
            }

            // Identificar método de pago original para no descuadrar Yape o Efectivo
            let nEfe = 0, nYap = 0;
            const mp = String(vData.metodo_pago || vData.metodoFinal || 'efectivo').toLowerCase();

            if (mp === 'yape') {
                nYap = nuevoMonto;
            } else if (mp === 'mixto') {
                // En edición rápida asume que la diferencia/total es efectivo (puedes expandir esta lógica luego)
                nEfe = nuevoMonto; 
            } else {
                nEfe = nuevoMonto;
            }

            // Calcular diferencia para ajustar el acumulado diario
            const diffTotal = nuevoMonto - (vData.total || 0);
            const diffEfe = nEfe - (vData.pagoEfectivo || vData.pago_efectivo || 0);
            const diffYap = nYap - (vData.pagoYape || vData.pago_yape || 0);

            const batch = writeBatch(db);

            // Actualizar ticket
            batch.update(vRef, { 
                total: nuevoMonto,
                pago_efectivo: nEfe,
                pagoEfectivo: nEfe,
                pago_yape: nYap,
                pagoYape: nYap,
                metodoFinal: mp === 'mixto' ? 'efectivo' : mp, // Normalizar si era mixto
                editado: true,
                editadoPor: state.currentUser.email,
                fechaEdicion: new Date().toISOString()
            });

            // Actualizar caja diaria
            const locId = vData.localId || 'general';
            const fStr = vData.fechaStr;
            const cRef = doc(db, "caja_diaria", `${fStr}_${locId}`);

            batch.set(cRef, {
                total_ingresos: increment(diffTotal),
                total_efectivo: increment(diffEfe),
                total_yape: increment(diffYap)
            }, { merge: true });

            await batch.commit();

        } else if (tipo === 'gasto') {
            await updateDoc(doc(db, "gastos", id), { 
                monto: nuevoMonto,
                editadoPor: state.currentUser.email
            });
        }
        
        if (window.mostrarToast) window.mostrarToast('Modificado', 'Totales y reportes diarios recalculados al centavo.', 'sky');
    } catch(e) {
        console.error(e);
        if(window.mostrarAlerta) window.mostrarAlerta("Fallo de conexión", "No se guardaron los cambios.", "red");
    }
}
