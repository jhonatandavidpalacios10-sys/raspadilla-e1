import { db, collection, query, where, getDocs, addDoc, serverTimestamp, doc, updateDoc, deleteDoc } from '../core/firebase-setup.js';
import { getTodayDateStr, formatMoney } from '../utils/helpers.js'; 
import { state } from '../core/store.js';

export function initCaja() {
    // Filtros y Formularios
    document.getElementById('filtro-local-caja')?.addEventListener('change', (e) => cargarArqueoCaja(e.target.value));
    document.getElementById('form-gasto')?.addEventListener('submit', guardarGasto);
    document.getElementById('btn-registrar-gasto')?.addEventListener('click', abrirModalGasto);
    document.getElementById('btn-cerrar-modal-gasto')?.addEventListener('click', cerrarModalGasto);

    // Exponer funciones de edición/eliminación al entorno global para poder llamarlas desde el HTML
    window.eliminarOperacionCaja = eliminarOperacionCaja;
    window.editarOperacionCaja = editarOperacionCaja;

    // Cargar automáticamente los datos de la fecha actual
    let filtroInicial = 'todas';
    if (state.userRole === 'vendedor') filtroInicial = state.userLocalId || '';
    cargarArqueoCaja(filtroInicial);
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
        cargarArqueoCaja(document.getElementById('filtro-local-caja')?.value || 'todas');
    } catch(err) {
        console.error(err);
        if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo guardar el gasto.", "red");
    } finally { 
        b.innerHTML = oT; 
        b.disabled = false; 
        if(window.lucide) window.lucide.createIcons();
    }
}

async function cargarArqueoCaja(filtroLocal = 'todas') {
    const list = document.getElementById('caja-historial-list'); 
    if(!list) return;
    
    list.innerHTML = '<div class="col-span-full flex justify-center p-8"><i data-lucide="loader-2" class="w-8 h-8 animate-spin text-sky-500"></i></div>'; 
    if(window.lucide) window.lucide.createIcons();
    
    const hoy = getTodayDateStr();
    
    try {
        // Obtenemos todos los movimientos del día
        const qVentas = query(collection(db, "ventas"), where("fechaStr", "==", hoy));
        const qGastos = query(collection(db, "gastos"), where("fechaStr", "==", hoy));
        
        const [snapVentas, snapGastos] = await Promise.all([getDocs(qVentas), getDocs(qGastos)]);
        
        let total = 0, gastosTotal = 0, efe = 0, yape = 0; 
        let allItems = [];

        // Procesar Ventas (Con corrección de filtro para ventas antiguas sin local)
        snapVentas.forEach(d => {
            const v = d.data();
            
            let mostrar = false;
            if (state.userRole === 'admin' || state.userRole === 'master') {
                mostrar = (filtroLocal === 'todas') || (v.localId === filtroLocal) || (filtroLocal === 'todas' && !v.localId);
            } else {
                mostrar = (v.localId === state.userLocalId) || (!v.localId);
            }
            
            if (mostrar && v.estado !== 'rechazado') {
                total += parseFloat(v.total || 0); 
                efe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); 
                yape += parseFloat(v.pago_yape || v.pagoYape || 0);
            }
            
            if (mostrar) {
                allItems.push({ tipo: 'venta', id: d.id, ...v });
            }
        });

        // Procesar Gastos (Con corrección de filtro)
        snapGastos.forEach(d => {
            const g = d.data();
            
            let mostrar = false;
            if (state.userRole === 'admin' || state.userRole === 'master') {
                mostrar = (filtroLocal === 'todas') || (g.localId === filtroLocal) || (g.localId === '') || (filtroLocal === 'todas' && !g.localId);
            } else {
                mostrar = (g.localId === state.userLocalId) || (g.localId === '') || (!g.localId);
            }
            
            if (mostrar) {
                gastosTotal += parseFloat(g.monto || 0);
                allItems.push({ tipo: 'gasto', id: d.id, ...g });
            }
        });

        // Ordenar cronológicamente (más recientes primero)
        allItems.sort((a,b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

        // Renderizado del Historial de Movimientos
        if (allItems.length === 0) {
            list.innerHTML = '<div class="col-span-full bg-slate-800 border border-slate-700 rounded-xl p-6 text-center text-slate-500 shadow-sm"><i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 opacity-50"></i><p class="text-sm font-bold">No hay operaciones registradas aún.</p></div>';
        } else {
            let html = '';
            const isAdmin = state.userRole === 'master' || state.userRole === 'admin';

            allItems.forEach(item => {
                const hora = item.timestamp ? new Date(item.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--';
                
                // Botones de acción dinámicos para administradores
                const btnActions = isAdmin ? `
                    <div class="flex gap-1.5 mt-2 opacity-100 lg:opacity-0 group-hover:opacity-100 transition-opacity justify-end border-t border-slate-700/50 pt-2">
                        <button onclick="window.editarOperacionCaja('${item.tipo}', '${item.id}', ${item.tipo === 'venta' ? item.total : item.monto})" class="text-slate-400 hover:text-amber-400 hover:bg-slate-700/50 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Editar</button>
                        <button onclick="window.eliminarOperacionCaja('${item.tipo}', '${item.id}')" class="text-slate-400 hover:text-red-400 hover:bg-slate-700/50 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> ${item.tipo === 'venta' ? 'Anular' : 'Borrar'}</button>
                    </div>
                ` : '';

                if (item.tipo === 'venta') {
                    const isRechazado = item.estado === 'rechazado';
                    const numItems = item.items ? item.items.length : 0;
                    const mp = String(item.metodo_pago || item.metodoFinal || 'EFECTIVO').toUpperCase();
                    const opacity = isRechazado ? 'opacity-40 grayscale' : '';
                    const amountColor = isRechazado ? 'text-slate-500 line-through' : 'text-emerald-400';
                    const sign = isRechazado ? '' : '+';
                    
                    html += `
                    <div class="bg-slate-800/50 border border-slate-700 p-3 rounded-xl hover:border-slate-600 transition-all group shadow-sm ${opacity}">
                        <div class="flex justify-between items-start">
                            <div class="flex items-center gap-3">
                                <div class="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0 border border-emerald-500/20">
                                    <i data-lucide="shopping-cart" class="w-4 h-4"></i>
                                </div>
                                <div>
                                    <p class="text-sm font-bold text-slate-800 dark:text-white">Venta POS ${isRechazado ? '<span class="text-[9px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded uppercase ml-2">Anulada</span>' : ''}</p>
                                    <p class="text-[10px] text-slate-500">${numItems} item(s) ${item.localNombre && item.localNombre !== 'Sin Local' ? `• ${item.localNombre}` : ''}</p>
                                </div>
                            </div>
                            <div class="text-right">
                                <p class="font-black ${amountColor} text-sm">${sign} ${formatMoney(item.total)}</p>
                                <p class="text-[9px] text-slate-500 mt-0.5 font-bold">${hora} • <span class="${mp === 'YAPE' ? 'text-purple-400' : (mp === 'EFECTIVO' ? 'text-emerald-400' : 'text-sky-400')}">${mp}</span></p>
                            </div>
                        </div>
                        ${btnActions}
                    </div>`;
                } else {
                    html += `
                    <div class="bg-red-500/5 border border-red-500/20 p-3 rounded-xl hover:border-red-500/40 transition-all group shadow-sm">
                        <div class="flex justify-between items-start">
                            <div class="flex items-center gap-3">
                                <div class="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center text-red-400 shrink-0 border border-red-500/20">
                                    <i data-lucide="trending-down" class="w-4 h-4"></i>
                                </div>
                                <div>
                                    <p class="text-sm font-bold text-red-400">Gasto Registrado</p>
                                    <p class="text-[10px] text-slate-500">${item.descripcion} ${item.localNombre && item.localNombre !== 'Global' ? `• ${item.localNombre}` : ''}</p>
                                </div>
                            </div>
                            <div class="text-right">
                                <p class="font-black text-red-400 text-sm">- ${formatMoney(item.monto)}</p>
                                <p class="text-[9px] text-red-400/70 mt-0.5 font-bold">${hora}</p>
                            </div>
                        </div>
                        ${btnActions}
                    </div>`;
                }
            });
            list.innerHTML = html;
        }
        
        // Actualizar las tarjetas de la cabecera
        if(document.getElementById('caja-total')) document.getElementById('caja-total').textContent = formatMoney(total);
        if(document.getElementById('caja-gastos')) document.getElementById('caja-gastos').textContent = formatMoney(gastosTotal);
        if(document.getElementById('caja-efectivo')) document.getElementById('caja-efectivo').textContent = formatMoney(efe);
        if(document.getElementById('caja-yape')) document.getElementById('caja-yape').textContent = formatMoney(yape);
        
        const cN = total - gastosTotal; 
        const netEl = document.getElementById('caja-neta');
        if(netEl) { 
            netEl.textContent = formatMoney(cN); 
            netEl.className = cN >= 0 ? "text-xl md:text-2xl font-black text-emerald-400" : "text-xl md:text-2xl font-black text-red-400"; 
        }
        
        if(window.lucide) window.lucide.createIcons();
    } catch (err) {
        console.error(err);
        list.innerHTML = '<p class="col-span-full text-red-400 text-sm text-center p-4">Error cargando el arqueo.</p>';
    }
}

// -----------------------------------------------------------------
// EDICIÓN Y ELIMINACIÓN DE REGISTROS (Funciones Master/Admin)
// -----------------------------------------------------------------

async function eliminarOperacionCaja(tipo, id) {
    if (state.userRole !== 'master' && state.userRole !== 'admin') return;
    
    if (window.mostrarConfirmacion) {
        window.mostrarConfirmacion(`¿Estás seguro de ${tipo === 'venta' ? 'anular' : 'eliminar'} este registro?`, async () => {
            try {
                if (tipo === 'venta') {
                    // Marcamos como anulado por seguridad fiscal (no se borra físicamente)
                    await updateDoc(doc(db, "ventas", id), { 
                        estado: 'rechazado',
                        anuladoPor: state.currentUser.email,
                        fechaAnulacion: new Date().toISOString()
                    });
                } else if (tipo === 'gasto') {
                    // Borramos el gasto definitivamente
                    await deleteDoc(doc(db, "gastos", id));
                }
                
                if (window.mostrarToast) window.mostrarToast('Completado', 'El registro ha sido retirado de los totales.', 'emerald');
                cargarArqueoCaja(document.getElementById('filtro-local-caja')?.value || 'todas');
                
            } catch (err) {
                console.error(err);
                if (window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo completar la acción.", "red");
            }
        });
    }
}

async function editarOperacionCaja(tipo, id, montoActual) {
    if (state.userRole !== 'master' && state.userRole !== 'admin') return;
    
    // Al ser una acción rápida administrativa, utilizamos un prompt nativo validado
    const nuevoMontoStr = prompt(`Ingresa el nuevo total (S/) para este ${tipo}:`, montoActual);
    
    if (nuevoMontoStr === null || nuevoMontoStr.trim() === "") return;
    
    const nuevoMonto = parseFloat(nuevoMontoStr);
    if (isNaN(nuevoMonto) || nuevoMonto < 0) {
        if(window.mostrarToast) window.mostrarToast('Dato Inválido', 'El monto ingresado no es correcto.', 'amber');
        return;
    }

    try {
        if (tipo === 'venta') {
            await updateDoc(doc(db, "ventas", id), { 
                total: nuevoMonto,
                pago_efectivo: nuevoMonto, // Por simplicidad, se asigna al total en efectivo
                pagoEfectivo: nuevoMonto,
                pago_yape: 0,
                pagoYape: 0,
                editado: true,
                editadoPor: state.currentUser.email
            });
        } else if (tipo === 'gasto') {
            await updateDoc(doc(db, "gastos", id), { 
                monto: nuevoMonto,
                editadoPor: state.currentUser.email
            });
        }
        
        if (window.mostrarToast) window.mostrarToast('Modificado', 'Los totales han sido recalculados.', 'sky');
        cargarArqueoCaja(document.getElementById('filtro-local-caja')?.value || 'todas');
        
    } catch(e) {
        console.error(e);
        if(window.mostrarAlerta) window.mostrarAlerta("Fallo de conexión", "No se guardaron los cambios.", "red");
    }
}
