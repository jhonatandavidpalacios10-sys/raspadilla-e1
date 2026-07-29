import {
    escaparHtml,
    formatMoney,
    getTodayDateStr,
    getTrustedNowMs,
    obtenerNombreCliente
} from '../utils/helpers.js'; 
import { state } from '../core/store.js';
import { subscribeDailyExpenses, subscribeDailySales } from '../core/data-service.js';
import {
    buildLegacyInventoryMovements,
    createUuid,
    deleteExpenseTransaction,
    roundMoney,
    saveExpenseTransaction,
    transitionSaleTransaction,
    updateExpenseAmountTransaction,
    updateSaleAmountTransaction
} from '../core/sales-service.js';

let unsubscribeVentasCaja = null;
let unsubscribeGastosCaja = null;
let cajaInicializada = false;
let ventasDelDia = [];
let gastosDelDia = [];
let gastoPendiente = null;
const operacionesCajaEnCurso = new Set();

function isAdminUser() {
    return ['admin', 'administrador', 'master'].includes(
        String(state.userRole || '').trim().toLowerCase()
    );
}

function handleFiltroCajaChange() {
    iniciarEscuchaCaja();
}

export function initCaja() {
    // CANDADO: Evita duplicación de listeners si cambia el turno (Bug Fantasma solucionado)
    if(cajaInicializada) return;
    cajaInicializada = true;

    // Filtros y Formularios
    document.getElementById('filtro-local-caja')?.addEventListener('change', handleFiltroCajaChange);
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
    const localFilter = document.getElementById('filtro-local-caja');
    const requestedLocalId = localFilter ? localFilter.value : 'todas';

    if(unsubscribeVentasCaja) unsubscribeVentasCaja();
    if(unsubscribeGastosCaja) unsubscribeGastosCaja();

    unsubscribeVentasCaja = subscribeDailySales(rows => {
        ventasDelDia = rows;
        renderArqueoCaja();
    }, error => {
        console.error('Error escuchando ventas de caja:', error);
    }, hoy, requestedLocalId);

    unsubscribeGastosCaja = subscribeDailyExpenses(rows => {
        gastosDelDia = rows;
        renderArqueoCaja();
    }, error => {
        console.error('Error escuchando gastos de caja:', error);
    }, hoy, requestedLocalId);
}

export function destroyCaja() {
    if (unsubscribeVentasCaja) {
        unsubscribeVentasCaja();
        unsubscribeVentasCaja = null;
    }
    if (unsubscribeGastosCaja) {
        unsubscribeGastosCaja();
        unsubscribeGastosCaja = null;
    }

    document.getElementById('filtro-local-caja')
        ?.removeEventListener('change', handleFiltroCajaChange);
    document.getElementById('form-gasto')
        ?.removeEventListener('submit', guardarGasto);
    document.getElementById('btn-registrar-gasto')
        ?.removeEventListener('click', abrirModalGasto);
    document.getElementById('btn-cerrar-modal-gasto')
        ?.removeEventListener('click', cerrarModalGasto);

    ventasDelDia = [];
    gastosDelDia = [];
    gastoPendiente = null;
    operacionesCajaEnCurso.clear();
    cajaInicializada = false;
}

function renderArqueoCaja() {
    const localSelect = document.getElementById('filtro-local-caja');
    const localFiltro = localSelect ? localSelect.value : 'todas';

    // FIX: Filtrar y ocultar los tickets que han sido "rechazados" en la cocina/cola para que no sumen ingresos fantasma
    let vFiltradas = ventasDelDia.filter(
        v => String(v.estado || '').toLowerCase() !== 'rechazado'
    );
    let gFiltrados = gastosDelDia;

    if (!isAdminUser()) {
        // FIX CRÍTICO: Vendedores solo ven su propia caja
        const localId = state.userLocalId || '';
        const belongsToScope = item => localId
            ? item.localId === localId
            : (!item.localId || item.localId === '' || item.localId === 'general');
        vFiltradas = vFiltradas.filter(belongsToScope);
        gFiltrados = gFiltrados.filter(belongsToScope);
    } else if (localFiltro === '') {
        vFiltradas = vFiltradas.filter(v => !v.localId || v.localId === '' || v.localId === 'general');
        gFiltrados = gFiltrados.filter(g => !g.localId || g.localId === '' || g.localId === 'general');
    } else if (localFiltro !== 'todas') {
        vFiltradas = vFiltradas.filter(v => v.localId === localFiltro);
        gFiltrados = gFiltrados.filter(g => g.localId === localFiltro);
    }

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
        ...ventas.map(v => ({...v, tipoOp: 'venta', time: v.fechaHora || (v.timestamp && typeof v.timestamp.toMillis === 'function' ? v.timestamp.toMillis() : (v.timestamp?.seconds * 1000)) || getTrustedNowMs()})),
        ...gastos.map(g => ({...g, tipoOp: 'gasto', time: g.fechaHora || (g.timestamp && typeof g.timestamp.toMillis === 'function' ? g.timestamp.toMillis() : (g.timestamp?.seconds * 1000)) || getTrustedNowMs()}))
    ];

    // Ordenar de la más reciente a la más antigua
    operaciones.sort((a, b) => b.time - a.time);

    if (operaciones.length === 0) {
        lista.innerHTML = '<div class="text-center text-slate-500 py-8 flex flex-col items-center"><i data-lucide="inbox" class="w-10 h-10 mb-2 opacity-50"></i><p>No hay operaciones registradas aún.</p></div>';
        if(window.lucide) window.lucide.createIcons({ root: lista });
        return;
    }

    lista.innerHTML = operaciones.map(op => {
        const isVenta = op.tipoOp === 'venta';
        const icon = isVenta ? 'trending-up' : 'trending-down';
        const color = isVenta ? 'text-emerald-500' : 'text-red-500';
        const bgIcon = isVenta ? 'bg-emerald-500/10' : 'bg-red-500/10';
        const shortId = String(op.id || '').replace(/^T-/, '').slice(0, 8).toUpperCase();
        const titulo = isVenta ? `Venta #${shortId}` : `Gasto: ${op.descripcion}`;
        const monto = isVenta ? formatMoney(op.total) : formatMoney(op.monto);
        
        // --- TRAZABILIDAD VISUAL (AUDITORÍA AÑADIDA) ---
        const autorOriginal = op.cajeroEmail || op.creadoPor || 'Vendedor Anónimo';
        const autorEdicion = op.editadoPor
            ? `<div class="cash-operation-meta text-[10.5px] text-amber-500 font-medium"><i data-lucide="pencil" class="w-3 h-3"></i><span>Editado por: <b>${escaparHtml(op.editadoPor)}</b></span></div>`
            : '';
        const tagAutor = `<div class="cash-operation-meta text-[10.5px] text-slate-500"><i data-lucide="user" class="w-3 h-3"></i><span>Cajero: <b>${escaparHtml(autorOriginal)}</b></span></div>${autorEdicion}`;
        const clienteNombre = isVenta ? obtenerNombreCliente(op) : '';
        const tagCliente = clienteNombre ? `<div class="cash-operation-meta text-[10.5px] text-sky-500"><i data-lucide="user" class="w-3 h-3"></i><span>Cliente: <b>${escaparHtml(clienteNombre)}</b></span></div>` : '';
        const syncBadge = op.sincronizacionPendiente
            ? '<span class="rounded border border-sky-400/40 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-500">Sincronizando</span>'
            : '';

        let badges = '';
        if (isVenta) {
            const efe = parseFloat(op.pago_efectivo || op.pagoEfectivo || 0);
            const yap = parseFloat(op.pago_yape || op.pagoYape || 0);
            if (efe > 0) badges += `<span class="bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 text-[10px] px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-500/30 mr-1">EFE: ${formatMoney(efe)}</span>`;
            if (yap > 0) badges += `<span class="bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400 text-[10px] px-2 py-0.5 rounded border border-purple-200 dark:border-purple-500/30">YAP: ${formatMoney(yap)}</span>`;
        }

        return `
        <div class="cash-operation-card min-w-0 bg-white dark:bg-slate-800 p-4 rounded-xl border ${op.editadoPor ? 'border-amber-300 dark:border-amber-700/50 shadow-amber-500/10' : 'border-slate-200 dark:border-slate-700'} shadow-sm gap-3 relative transition-all hover:border-sky-300">
            <div class="cash-operation-main min-w-0">
                <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${bgIcon} ${color}">
                    <i data-lucide="${icon}" class="w-5 h-5"></i>
                </div>
                <div class="min-w-0">
                    <p class="cash-operation-title min-w-0 text-sm font-bold text-slate-800 dark:text-white capitalize">
                        <span>${escaparHtml(titulo)}</span>
                        ${op.editadoPor ? '<i data-lucide="alert-circle" class="w-3 h-3 text-amber-500" title="Ticket Editado"></i>' : ''}
                        ${syncBadge}
                    </p>
                    <div class="cash-operation-badges mt-1">${badges}</div>
                    ${tagCliente}
                    ${tagAutor}
                </div>
            </div>
            <div class="cash-operation-total flex flex-col items-end">
                <span class="whitespace-nowrap text-lg font-black ${color} mb-2">${isVenta ? '+' : '-'}${monto}</span>
                
                <!-- Solo administradores o dueños deberían editar/eliminar -->
                ${isAdminUser() ? `
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

    if(window.lucide) window.lucide.createIcons({ root: lista });
}

function guardarGasto(e) {
    e.preventDefault();
    const desc = document.getElementById('input-desc-gasto')?.value.trim() || document.getElementById('gasto-desc')?.value.trim();
    const monto = roundMoney(
        document.getElementById('input-monto-gasto')?.value
        || document.getElementById('gasto-monto')?.value
    );

    const localSelect = document.getElementById('gasto-local');
    const localId = isAdminUser()
        ? (localSelect?.value || 'general')
        : (state.userLocalId || 'general');
    const localNombre = state.locales.find(local => local.id === localId)?.nombre
        || (localId === 'general' ? 'General' : state.userLocal || 'Sin Local');
    
    if (!desc || !Number.isFinite(monto) || monto <= 0) return;

    try {
        const fStr = getTodayDateStr();
        const fingerprint = JSON.stringify({ desc, monto, fStr, localId });
        if (!gastoPendiente || gastoPendiente.fingerprint !== fingerprint) {
            gastoPendiente = {
                fingerprint,
                expenseId: createUuid('G-'),
                operationId: createUuid('OP-')
            };
        }

        saveExpenseTransaction({
            expenseId: gastoPendiente.expenseId,
            operationId: gastoPendiente.operationId,
            expense: {
            descripcion: desc,
            monto,
            fechaStr: fStr,
            fechaHora: getTrustedNowMs(),
            localId,
            localNombre,
            creadoPor: state.currentUser?.username || state.currentUser?.email || 'Desconocido',
            tipo: 'gasto'
            }
        });

        gastoPendiente = null;
        cerrarModalGasto();
        const formGasto = document.getElementById('form-gasto');
        if(formGasto) formGasto.reset();
        window.mostrarToast?.(
            'Gasto guardado',
            'Registrado en este dispositivo y sincronizándose.',
            'emerald'
        );
    } catch (error) {
        console.error("Error al guardar gasto:", error);
        if(window.mostrarAlerta) {
            window.mostrarAlerta(
                'Gasto no registrado',
                'No se pudo confirmar el gasto. El formulario se conservó.',
                'red'
            );
        }
    }
}

function normalizeOperationArguments(first, second, fallbackAmount) {
    const operationTypes = new Set(['venta', 'gasto']);
    const firstNormalized = String(first || '').toLowerCase();
    const secondNormalized = String(second || '').toLowerCase();

    if (operationTypes.has(firstNormalized)) {
        return { id: second, type: firstNormalized, fallbackAmount };
    }
    if (operationTypes.has(secondNormalized)) {
        return { id: first, type: secondNormalized, fallbackAmount };
    }
    return { id: first, type: secondNormalized, fallbackAmount };
}

function getActorName() {
    return state.currentUser?.username || state.currentUser?.email || 'Desconocido';
}

export async function editarOperacionCaja(first, second, fallbackAmount) {
    const { id, type, fallbackAmount: externalAmount } = normalizeOperationArguments(
        first,
        second,
        fallbackAmount
    );
    if (!id || !['venta', 'gasto'].includes(type)) return;

    const operationKey = `edit:${type}:${id}`;
    if (operacionesCajaEnCurso.has(operationKey)) return;

    let currentData = type === 'venta'
        ? ventasDelDia.find(item => item.id === id)
        : gastosDelDia.find(item => item.id === id);

    const currentAmount = Number(
        type === 'venta'
            ? (currentData?.total ?? externalAmount)
            : (currentData?.monto ?? externalAmount)
    );

    if (!Number.isFinite(currentAmount)) {
        if(window.mostrarAlerta) {
            window.mostrarAlerta(
                'Operación no disponible',
                'No se pudo determinar el monto actual. Actualiza la vista e inténtalo nuevamente.',
                'amber'
            );
        }
        return;
    }

    const newAmountText = await window.solicitarEntradaSistema?.({
        title: `Editar ${type === 'venta' ? 'venta' : 'gasto'}`,
        message: `Monto actual: S/ ${currentAmount.toFixed(2)}. Ingresa el nuevo monto correcto.`,
        value: currentAmount.toFixed(2),
        tone: 'sky',
        confirmText: 'Guardar cambio',
        validate: rawValue => {
            const parsed = Number(rawValue);
            return Number.isFinite(parsed) && parsed > 0
                ? ''
                : 'El monto debe ser mayor que cero.';
        }
    });
    if (newAmountText === null || newAmountText === undefined || newAmountText.trim() === '') return;

    const newAmount = Number(newAmountText);
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
        if(window.mostrarAlerta) {
            window.mostrarAlerta('Error', 'El monto debe ser mayor que cero.', 'red');
        }
        return;
    }
    if (Math.abs(newAmount - currentAmount) < 0.005) return;

    operacionesCajaEnCurso.add(operationKey);
    try {
        if (type === 'venta') {
            updateSaleAmountTransaction({
                saleId: id,
                operationId: createUuid('OP-'),
                newTotal: newAmount,
                actor: getActorName(),
                currentSale: currentData
            });
        } else {
            updateExpenseAmountTransaction({
                expenseId: id,
                operationId: createUuid('OP-'),
                newAmount,
                actor: getActorName()
            });
        }

        if (window.mostrarToast) {
            window.mostrarToast(
                'Cambio guardado',
                'La operación se actualizó en este dispositivo y está sincronizándose.',
                'sky'
            );
        }
    } catch(error) {
        console.error('Error al editar operación:', error);
        if(window.mostrarAlerta) {
            window.mostrarAlerta(
                'No se pudo modificar',
                error?.message || 'Actualiza la vista e inténtalo nuevamente.',
                'red'
            );
        }
    } finally {
        operacionesCajaEnCurso.delete(operationKey);
    }
}

export async function eliminarOperacionCaja(first, second) {
    const { id, type } = normalizeOperationArguments(first, second);
    if (!id || !['venta', 'gasto'].includes(type)) return;
    const confirmed = await window.mostrarConfirmacionSistema?.({
        title: 'Anular operación',
        message: `¿Confirmas que deseas anular este registro de ${type === 'venta' ? 'venta' : 'gasto'}?`,
        tone: 'red',
        confirmText: 'Sí, anular',
        cancelText: 'Conservar'
    });
    if (!confirmed) return;

    const operationKey = `delete:${type}:${id}`;
    if (operacionesCajaEnCurso.has(operationKey)) return;
    operacionesCajaEnCurso.add(operationKey);

    try {
        let result;

        if (type === 'venta') {
            let sale = ventasDelDia.find(item => item.id === id);

            let legacyInventoryMovements = [];
            if (sale) {
                try {
                    legacyInventoryMovements =
                        Array.isArray(sale.inventarioMovimientos)
                        && sale.inventarioMovimientos.length > 0
                            ? sale.inventarioMovimientos
                            : buildLegacyInventoryMovements(sale.items)
                                .map(movement => {
                                    const { stockAfectado, ...legacyMovement } = movement;
                                    return legacyMovement;
                                });
                } catch (error) {
                    console.warn('Inventario legado incompleto al anular:', error);
                }
            }

            result = transitionSaleTransaction({
                saleId: id,
                operationId: createUuid('OP-'),
                nextState: 'rechazado',
                allowedStates: ['pendiente', 'listo'],
                actor: getActorName(),
                reason: 'anulado_desde_caja',
                legacyInventoryMovements,
                cupControlDate: getTodayDateStr()
            });
        } else {
            result = deleteExpenseTransaction({
                expenseId: id,
                operationId: createUuid('OP-')
            });
        }

        if(window.mostrarToast) {
            const warning = result?.missingProducts?.length
                ? ` No se repusieron ${result.missingProducts.length} productos eliminados.`
                : '';
            window.mostrarToast(
                'Cambio guardado',
                `${result?.alreadyApplied ? 'La anulación ya estaba en la cola.' : 'Operación anulada localmente y sincronizándose.'}${warning}`,
                'red'
            );
        }
    } catch (error) {
        console.error('Error en anulación:', error);
        if(window.mostrarAlerta) {
            window.mostrarAlerta(
                'No se pudo anular',
                error?.message || 'Actualiza la vista e inténtalo nuevamente.',
                'red'
            );
        }
    } finally {
        operacionesCajaEnCurso.delete(operationKey);
    }
}

// Utilidades UI para Modales
function abrirModalGasto() {
    const m = document.getElementById('modal-gasto');
    if(m) {
        const gastoLocal = document.getElementById('gasto-local');
        const cajaLocal = document.getElementById('filtro-local-caja');
        if (gastoLocal && isAdminUser() && cajaLocal?.value && cajaLocal.value !== 'todas') {
            gastoLocal.value = cajaLocal.value;
        }
        m.classList.remove('hidden', 'pointer-events-none');
        setTimeout(() => m.classList.remove('opacity-0'), 10);
    }
}

function cerrarModalGasto() {
    const m = document.getElementById('modal-gasto');
    if(m) {
        m.classList.add('pointer-events-none');
        m.classList.add('opacity-0');
        setTimeout(() => m.classList.add('hidden'), 300);
    }
}
