import { formatMoney, getTodayDateStr, obtenerNombreCliente, escaparHtml } from '../utils/helpers.js';
import { state } from '../core/store.js';
import { subscribeSalesRange, subscribeExpensesRange } from '../core/data-service.js';
import {
    editarOperacionCaja,
    eliminarOperacionCaja
} from './ui-caja.js';

let analysisData = []; 
let analysisGastos = []; 
let currentDateAnalysis = new Date(); 
window.currentSelectedDayObj = null;

let unsubscribeVentas = null;
let unsubscribeGastos = null;
let readyV = false;
let readyG = false;
let analisisInicializado = false; // CANDADO AÑADIDO
let analysisEventsController = null;
const analysisLoadErrors = new Set();
let analysisByDate = new Map();
let currentRangeSummary = createEmptyAnalysisSummary();
let breakdownCloseTimer = null;
let breakdownShowTimer = null;
let analysisHasRendered = false;
let analysisRequestGeneration = 0;
let renderedAnalysisKey = '';
let pendingAnalysisKey = '';
let lastAnalysisDataSignature = '';

function toAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
}

function createEmptyAnalysisSummary(dStr = '') {
    return {
        dStr,
        ventas: [],
        gastos: [],
        tIng: 0,
        tEfe: 0,
        tYap: 0,
        tTar: 0,
        tOtros: 0,
        tGas: 0
    };
}

function getSalePaymentBreakdown(sale) {
    const total = toAmount(sale?.total);
    const hasCashValue = sale?.pago_efectivo !== undefined || sale?.pagoEfectivo !== undefined;
    const hasDigitalValue = sale?.pago_yape !== undefined || sale?.pagoYape !== undefined;
    let efectivo = toAmount(sale?.pago_efectivo ?? sale?.pagoEfectivo);
    let yape = toAmount(sale?.pago_yape ?? sale?.pagoYape);
    let tarjeta = 0;
    const metodo = String(sale?.metodo_pago || sale?.metodoFinal || '').trim().toLowerCase();

    // Compatibilidad con ventas antiguas que guardaban únicamente el método.
    if (!hasCashValue && !hasDigitalValue) {
        if (metodo === 'yape' || metodo === 'plin') yape = total;
        else if (metodo === 'tarjeta') tarjeta = total;
        else efectivo = total;
    } else if (metodo === 'tarjeta' && efectivo === 0 && yape === 0) {
        tarjeta = total;
    }

    const otros = total - efectivo - yape - tarjeta;
    return {
        efectivo,
        yape,
        tarjeta,
        otros: Math.abs(otros) >= 0.005 ? otros : 0
    };
}

function addSaleToSummary(summary, sale) {
    const payment = getSalePaymentBreakdown(sale);
    summary.ventas.push(sale);
    summary.tIng += toAmount(sale?.total);
    summary.tEfe += payment.efectivo;
    summary.tYap += payment.yape;
    summary.tTar += payment.tarjeta;
    summary.tOtros += payment.otros;
}

function addExpenseToSummary(summary, expense) {
    summary.gastos.push(expense);
    summary.tGas += toAmount(expense?.monto);
}

function buildAnalysisAggregates(ventas, gastos) {
    const rangeSummary = createEmptyAnalysisSummary();
    const groupedByDate = new Map();
    const getDaySummary = dStr => {
        if (!groupedByDate.has(dStr)) {
            groupedByDate.set(dStr, createEmptyAnalysisSummary(dStr));
        }
        return groupedByDate.get(dStr);
    };

    ventas.forEach(venta => {
        addSaleToSummary(rangeSummary, venta);
        if (venta?.fechaStr) addSaleToSummary(getDaySummary(venta.fechaStr), venta);
    });

    gastos.forEach(gasto => {
        addExpenseToSummary(rangeSummary, gasto);
        if (gasto?.fechaStr) addExpenseToSummary(getDaySummary(gasto.fechaStr), gasto);
    });

    return { rangeSummary, groupedByDate };
}

function getAnalysisDataSignature(ventas, gastos) {
    const saleRows = ventas.map(sale => [
        String(sale.id || ''),
        Number(sale.revision || 0),
        String(sale.lastOperationId || ''),
        String(sale.estado || ''),
        Number(sale.total || 0),
        Number(sale.pago_efectivo ?? sale.pagoEfectivo ?? 0),
        Number(sale.pago_yape ?? sale.pagoYape ?? 0),
        String(sale.metodo_pago || sale.metodoFinal || ''),
        String(sale.localId || ''),
        String(sale.localNombre || ''),
        obtenerNombreCliente(sale),
        Number(sale.fechaHora || sale.timestamp?.seconds || 0),
        (Array.isArray(sale.items) ? sale.items : []).map(item => [
            String(item?.nombre || ''),
            Number(item?.cantidad || 0),
            Number(item?.precio || 0),
            String(item?.categoria || '')
        ])
    ]).sort((left, right) => left[0].localeCompare(right[0]));
    const expenseRows = gastos.map(expense => [
        String(expense.id || ''),
        String(expense.lastOperationId || ''),
        Number(expense.monto || 0),
        String(expense.descripcion || ''),
        String(expense.categoria || expense.tipo || ''),
        String(expense.localId || ''),
        String(expense.localNombre || ''),
        Number(expense.fechaHora || expense.timestamp?.seconds || 0)
    ]).sort((left, right) => left[0].localeCompare(right[0]));
    return JSON.stringify([saleRows, expenseRows]);
}

function toLocalDateInput(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function getLimaCalendarDate() {
    const [year, month, day] = getTodayDateStr().split('-').map(Number);
    // Mediodía evita que la conversión local del navegador cambie el día.
    return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function isAdminUser() {
    return ['admin', 'administrador', 'master'].includes(
        String(state.userRole || '').trim().toLowerCase()
    );
}

function getOperationTime(record) {
    const timestamp = record?.timestamp;
    let date = null;
    if (timestamp && typeof timestamp.toDate === 'function') date = timestamp.toDate();
    else if (timestamp && typeof timestamp.toMillis === 'function') date = new Date(timestamp.toMillis());
    else if (Number.isFinite(timestamp?.seconds)) date = new Date(timestamp.seconds * 1000);
    else if (Number.isFinite(Number(record?.fechaHora))) date = new Date(Number(record.fechaHora));
    return date && Number.isFinite(date.getTime())
        ? date.toLocaleTimeString('es-PE', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Lima'
        })
        : '--:--';
}

function ensureSelectedDayExpenseCard() {
    const grossCard = document.getElementById('card-bruto-dia');
    const cardsGrid = grossCard?.parentElement;
    if (!cardsGrid) return;

    cardsGrid.classList.remove('grid-cols-2');
    cardsGrid.classList.add('grid-cols-3');

    if (document.getElementById('card-gastos-dia')) return;
    const expenseCard = document.createElement('div');
    expenseCard.id = 'card-gastos-dia';
    expenseCard.className = 'bg-slate-900 rounded-lg p-2 border border-slate-700 text-center cursor-pointer hover:border-red-500 transition-colors';
    expenseCard.innerHTML = `
        <p class="text-[10px] text-slate-400 uppercase mb-0.5">Gastos</p>
        <p class="text-sm md:text-base font-bold text-red-400" id="selectedDayGastos">${formatMoney(0)}</p>
    `;
    cardsGrid.appendChild(expenseCard);
}

function handleSelectedTransactionsClick(event) {
    const actionButton = event.target.closest('button[data-analysis-action]');
    if (actionButton) {
        const recordId = actionButton.dataset.recordId || '';
        const kind = actionButton.dataset.recordKind || '';
        const action = actionButton.dataset.analysisAction;
        if (action === 'edit') {
            editarOperacionCaja(
                recordId,
                kind,
                Number(actionButton.dataset.recordAmount) || 0
            );
        } else if (action === 'delete') {
            eliminarOperacionCaja(recordId, kind);
        }
        return;
    }

    const card = event.target.closest('[data-analysis-transaction-card]');
    card?.querySelector('[data-analysis-transaction-detail]')
        ?.classList.toggle('hidden');
}

export function initAnalisis() {
    // FIX CRÍTICO: Prevenir duplicación de eventos al rotar turnos
    if (analisisInicializado) return;
    analisisInicializado = true;
    analysisEventsController = new AbortController();
    const eventOptions = { signal: analysisEventsController.signal };

    window.updateAnalysisRange = updateAnalysisRange; 
    window.setAnalysisRange = setAnalysisRange; 
    window.changeAnalysisMonth = changeAnalysisMonth; 
    window.showBreakdown = showBreakdown; 
    window.closeBreakdownModal = closeBreakdownModal;
    ensureSelectedDayExpenseCard();
    window.editarOperacionCaja = editarOperacionCaja;
    window.eliminarOperacionCaja = eliminarOperacionCaja;
    
    // Configurar fechas por defecto (Mes actual en lugar de solo hoy para mejor vista de calendario)
    const d = getLimaCalendarDate();
    currentDateAnalysis = new Date(d);
    const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    
    document.getElementById('filterStartDate').value = toLocalDateInput(firstDay); 
    document.getElementById('filterEndDate').value = toLocalDateInput(lastDay);

    // Eventos
    document.getElementById('filterStartDate')?.addEventListener('change', () => {
        currentDateAnalysis = new Date(document.getElementById('filterStartDate').value + "T00:00:00");
        updateAnalysisRange();
    }, eventOptions);
    document.getElementById('filterEndDate')?.addEventListener('change', updateAnalysisRange, eventOptions);
    document.getElementById('analisisLocalFilter')?.addEventListener('change', updateAnalysisRange, eventOptions);
    
    document.getElementById('btn-filtro-hoy')?.addEventListener('click', () => setAnalysisRange('hoy'), eventOptions);
    document.getElementById('btn-filtro-semana')?.addEventListener('click', () => setAnalysisRange('semana'), eventOptions);
    document.getElementById('btn-filtro-mes')?.addEventListener('click', () => setAnalysisRange('mes'), eventOptions);
    
    document.getElementById('btn-mes-prev')?.addEventListener('click', () => changeAnalysisMonth(-1), eventOptions);
    document.getElementById('btn-mes-next')?.addEventListener('click', () => changeAnalysisMonth(1), eventOptions);
    document.getElementById('card-bruto-dia')?.addEventListener('click', () => {
        if (window.currentSelectedDayObj) {
            showBreakdown('BRUTO', window.currentSelectedDayObj);
        }
    }, eventOptions);
    document.getElementById('card-ganancia-dia')?.addEventListener('click', () => {
        if (window.currentSelectedDayObj) {
            showBreakdown('CAJA', window.currentSelectedDayObj);
        }
    }, eventOptions);
    document.getElementById('card-gastos-dia')?.addEventListener('click', () => {
        if (window.currentSelectedDayObj) {
            showBreakdown('GASTOS', window.currentSelectedDayObj);
        }
    }, eventOptions);
    document.getElementById('analysisRangeSummary')?.addEventListener('click', event => {
        const trigger = event.target.closest('[data-analysis-breakdown]');
        if (trigger) showBreakdown(trigger.dataset.analysisBreakdown, null);
    }, eventOptions);
    document.getElementById('selectedDayTransactions')?.addEventListener(
        'click',
        handleSelectedTransactionsClick,
        eventOptions
    );

    updateAnalysisRange(); 
}

export function destroyAnalisis() {
    analysisRequestGeneration++;
    if (unsubscribeVentas) {
        unsubscribeVentas();
        unsubscribeVentas = null;
    }
    if (unsubscribeGastos) {
        unsubscribeGastos();
        unsubscribeGastos = null;
    }
    if (analysisEventsController) {
        analysisEventsController.abort();
        analysisEventsController = null;
    }

    analysisData = [];
    analysisGastos = [];
    readyV = false;
    readyG = false;
    analysisLoadErrors.clear();
    analisisInicializado = false;
    analysisByDate = new Map();
    currentRangeSummary = createEmptyAnalysisSummary();
    analysisHasRendered = false;
    renderedAnalysisKey = '';
    pendingAnalysisKey = '';
    lastAnalysisDataSignature = '';
    window.currentSelectedDayObj = null;
    if (breakdownCloseTimer) clearTimeout(breakdownCloseTimer);
    if (breakdownShowTimer) clearTimeout(breakdownShowTimer);
    breakdownCloseTimer = null;
    breakdownShowTimer = null;
    const breakdownModal = document.getElementById('breakdownModal');
    breakdownModal?.classList.add('hidden', 'opacity-0');

    const summary = document.getElementById('analysisRangeSummary');
    const calendar = document.getElementById('calendarGrid');
    const monthLabel = document.getElementById('calendarMonthLabel');
    const dateLabel = document.getElementById('selectedDateLabel');
    const dayIncome = document.getElementById('selectedDayIngresos');
    const dayNet = document.getElementById('selectedDayGanancias');
    const dayExpenses = document.getElementById('selectedDayGastos');
    const transactions = document.getElementById('selectedDayTransactions');
    if (summary) {
        summary.innerHTML = '';
        summary.removeAttribute('aria-busy');
    }
    if (calendar) calendar.innerHTML = '';
    if (monthLabel) monthLabel.textContent = 'Mes Año';
    if (dateLabel) dateLabel.textContent = 'Selecciona un día';
    if (dayIncome) dayIncome.textContent = formatMoney(0);
    if (dayNet) dayNet.textContent = formatMoney(0);
    if (dayExpenses) dayExpenses.textContent = formatMoney(0);
    if (transactions) transactions.innerHTML = '';
}

function finishAnalysisLoad() {
    if (!readyV || !readyG) return;
    if (analysisLoadErrors.size === 0) {
        processAndRenderAnalysis();
        analysisHasRendered = true;
        renderedAnalysisKey = pendingAnalysisKey;
        document.getElementById('analysisRangeSummary')?.removeAttribute('aria-busy');
        return;
    }

    const summary = document.getElementById('analysisRangeSummary');
    summary?.removeAttribute('aria-busy');
    if (
        analysisHasRendered
        && renderedAnalysisKey === pendingAnalysisKey
    ) {
        window.mostrarToast?.(
            'Análisis sin conexión',
            'Se mantienen los últimos datos disponibles.',
            'amber'
        );
        return;
    }
    if (summary) {
        summary.innerHTML = `
            <div class="col-span-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-center">
                <p class="text-sm font-bold text-amber-400">No se pudo completar el análisis.</p>
                <p class="text-xs text-slate-400 mt-1">Revisa la conexión y vuelve a intentarlo.</p>
                <button id="btn-reintentar-analisis" class="mt-3 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold">Reintentar</button>
            </div>`;
        summary.querySelector('#btn-reintentar-analisis')
            ?.addEventListener('click', updateAnalysisRange, { once: true });
    }
}

function updateAnalysisRange() {
    const fS = document.getElementById('filterStartDate').value; 
    const fE = document.getElementById('filterEndDate').value;
    
    if (!fS || !fE) return;

    if (unsubscribeVentas) unsubscribeVentas();
    if (unsubscribeGastos) unsubscribeGastos();
    const requestGeneration = ++analysisRequestGeneration;
    const localFilter = document.getElementById('analisisLocalFilter');
    const selectedLocal = localFilter ? localFilter.value : 'todas';
    const nextAnalysisKey = `${fS}:${fE}:${selectedLocal}`;
    const canKeepRenderedData = (
        analysisHasRendered
        && renderedAnalysisKey === nextAnalysisKey
    );
    pendingAnalysisKey = nextAnalysisKey;

    const cSum = document.getElementById('analysisRangeSummary');
    if (cSum) {
        cSum.setAttribute('aria-busy', 'true');
        if (!canKeepRenderedData) {
            cSum.innerHTML = '<div class="col-span-4 text-center py-2"><i data-lucide="loader-2" class="w-5 h-5 animate-spin mx-auto text-sky-500"></i></div>';
            if(window.lucide) window.lucide.createIcons({ root: cSum });
        }
    }
    if (!canKeepRenderedData) {
        analysisHasRendered = false;
        renderedAnalysisKey = '';
        lastAnalysisDataSignature = '';
        analysisData = [];
        analysisGastos = [];
        analysisByDate = new Map();
        currentRangeSummary = createEmptyAnalysisSummary();
        window.currentSelectedDayObj = null;
        renderCalendar(analysisByDate);
        const dateLabel = document.getElementById('selectedDateLabel');
        const dayIncome = document.getElementById('selectedDayIngresos');
        const dayNet = document.getElementById('selectedDayGanancias');
        const dayExpenses = document.getElementById('selectedDayGastos');
        const transactions = document.getElementById('selectedDayTransactions');
        if (dateLabel) dateLabel.textContent = 'Selecciona un día';
        if (dayIncome) dayIncome.textContent = formatMoney(0);
        if (dayNet) dayNet.textContent = formatMoney(0);
        if (dayExpenses) dayExpenses.textContent = formatMoney(0);
        if (transactions) transactions.innerHTML = '';
    }

    readyV = false;
    readyG = false;
    analysisLoadErrors.clear();

    unsubscribeVentas = subscribeSalesRange(fS, fE, (rows, metadata) => {
        if (requestGeneration !== analysisRequestGeneration) return;
        if (
            rows.length === 0
            && metadata?.fromCache === true
            && metadata?.hasPendingWrites !== true
            && (
                analysisData.length > 0
                || metadata?.emptyCacheSettled !== true
            )
            && (typeof navigator === 'undefined' || navigator.onLine !== false)
        ) return;
        analysisData = rows;
        readyV = true;
        finishAnalysisLoad();
    }, error => {
        if (requestGeneration !== analysisRequestGeneration) return;
        console.error("Error cargando ventas para análisis:", error);
        analysisData = [];
        readyV = true;
        analysisLoadErrors.add('ventas');
        finishAnalysisLoad();
    }, selectedLocal);

    unsubscribeGastos = subscribeExpensesRange(fS, fE, (rows, metadata) => {
        if (requestGeneration !== analysisRequestGeneration) return;
        if (
            rows.length === 0
            && metadata?.fromCache === true
            && metadata?.hasPendingWrites !== true
            && (
                analysisGastos.length > 0
                || metadata?.emptyCacheSettled !== true
            )
            && (typeof navigator === 'undefined' || navigator.onLine !== false)
        ) return;
        analysisGastos = rows;
        readyG = true;
        finishAnalysisLoad();
    }, error => {
        if (requestGeneration !== analysisRequestGeneration) return;
        console.error("Error cargando gastos para análisis:", error);
        analysisGastos = [];
        readyG = true;
        analysisLoadErrors.add('gastos');
        finishAnalysisLoad();
    }, selectedLocal);
}

function processAndRenderAnalysis() {
    const localFilter = document.getElementById('analisisLocalFilter');
    let lF = localFilter ? localFilter.value : 'todas';
    const miSedeId = state.userLocalId || "";

    let filteredVentas = [];
    let filteredGastos = [];

    // FIX CRÍTICO: Procesar ventas con filtro local unificado
    analysisData.forEach(v => { 
        let mostrar = false;
        if (isAdminUser()) {
            mostrar = (lF === 'todas') || (v.localId === lF) || (lF === '' && (!v.localId || v.localId === '' || v.localId === 'general'));
        } else {
            mostrar = (v.localId === miSedeId || (!v.localId && miSedeId === "") || (v.localId === 'general' && miSedeId === ""));
        }
        
        if (mostrar && String(v.estado || '').toLowerCase() !== 'rechazado') filteredVentas.push(v); 
    });
    
    // FIX CRÍTICO: Procesar gastos con filtro local unificado
    analysisGastos.forEach(g => { 
        let mostrar = false;
        if (isAdminUser()) {
            mostrar = (lF === 'todas') || (g.localId === lF) || (lF === '' && (!g.localId || g.localId === '' || g.localId === 'general'));
        } else {
            mostrar = (g.localId === miSedeId || (!g.localId && miSedeId === "") || (g.localId === 'general' && miSedeId === ""));
        }
        if (mostrar) filteredGastos.push(g); 
    });

    const dataSignature = getAnalysisDataSignature(
        filteredVentas,
        filteredGastos
    );
    if (
        analysisHasRendered
        && renderedAnalysisKey === pendingAnalysisKey
        && dataSignature === lastAnalysisDataSignature
    ) {
        document.getElementById('analysisRangeSummary')
            ?.removeAttribute('aria-busy');
        return;
    }
    lastAnalysisDataSignature = dataSignature;

    // Una sola agrupación por fecha alimenta el resumen, calendario y detalle.
    // Evita volver a recorrer todo el rango por cada casilla del calendario.
    const aggregates = buildAnalysisAggregates(filteredVentas, filteredGastos);
    currentRangeSummary = aggregates.rangeSummary;
    analysisByDate = aggregates.groupedByDate;
    const {
        tIng: ing,
        tGas: gas
    } = currentRangeSummary;

    // Actualizar UI de Tarjetas Superiores
    const cSum = document.getElementById('analysisRangeSummary');
    if(cSum) {
        cSum.innerHTML = `
            <button type="button" data-analysis-breakdown="BRUTO" aria-label="Ver desglose de ingresos" class="w-full bg-white dark:bg-slate-800 rounded-xl p-3 md:p-4 border border-slate-200 dark:border-slate-700 text-center cursor-pointer hover:border-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 transition-colors shadow-sm">
                <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                    <i data-lucide="trending-up" class="w-3.5 h-3.5 text-sky-500"></i>
                    <p class="text-[10px] md:text-[11px] text-slate-500 uppercase font-bold tracking-wider">Ingresos</p>
                </div>
                <p class="text-sm md:text-xl font-black text-slate-800 dark:text-white" id="tot-ingresos">${formatMoney(ing)}</p>
            </button>
            <button type="button" data-analysis-breakdown="CAJA" aria-label="Ver desglose de caja neta" class="w-full bg-white dark:bg-slate-800 rounded-xl p-3 md:p-4 border border-slate-200 dark:border-slate-700 text-center cursor-pointer hover:border-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 transition-colors shadow-sm">
                <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                    <i data-lucide="pie-chart" class="w-3.5 h-3.5 text-emerald-500"></i>
                    <p class="text-[10px] md:text-[11px] text-slate-500 uppercase font-bold tracking-wider">Caja Neta</p>
                </div>
                <p class="text-sm md:text-xl font-black text-emerald-500" id="tot-neta">${formatMoney(ing - gas)}</p>
            </button>
            <button type="button" data-analysis-breakdown="GASTOS" aria-label="Ver desglose de gastos" class="w-full bg-white dark:bg-slate-800 rounded-xl p-3 md:p-4 border border-slate-200 dark:border-slate-700 text-center cursor-pointer hover:border-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 transition-colors shadow-sm">
                <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                    <i data-lucide="trending-down" class="w-3.5 h-3.5 text-red-500"></i>
                    <p class="text-[10px] md:text-[11px] text-slate-500 uppercase font-bold tracking-wider">Gastos</p>
                </div>
                <p class="text-sm md:text-xl font-bold text-red-500" id="tot-gastos">${formatMoney(gas)}</p>
            </button>
            <div class="bg-white dark:bg-slate-800 rounded-xl p-3 md:p-4 border border-slate-200 dark:border-slate-700 text-center shadow-sm">
                <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                    <i data-lucide="list-checks" class="w-3.5 h-3.5 text-purple-500"></i>
                    <p class="text-[10px] md:text-[11px] text-slate-500 uppercase font-bold tracking-wider">Transacciones</p>
                </div>
                <p class="text-sm md:text-xl font-bold text-slate-800 dark:text-white">${filteredVentas.length}</p>
            </div>
        `;
    }
    
    if(window.lucide && cSum) window.lucide.createIcons({ root: cSum });
    renderCalendar(analysisByDate);

    // Re-render en vivo del detalle del día seleccionado
    if (window.currentSelectedDayObj) {
        const dStr = window.currentSelectedDayObj.dStr;
        showDayDetails(analysisByDate.get(dStr) || createEmptyAnalysisSummary(dStr));
    }
}

function setAnalysisRange(tipo) {
    const d = getLimaCalendarDate(); 
    let fS = new Date(d); 
    let fE = new Date(d);
    
    if(tipo === 'hoy') {
        // Mantiene ambas fechas en hoy
    } else if(tipo === 'semana') {
        fS.setDate(d.getDate() - 6);
    } else if(tipo === 'mes') {
        fS = new Date(d.getFullYear(), d.getMonth(), 1);
        fE = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    }
    
    document.getElementById('filterStartDate').value = toLocalDateInput(fS);
    document.getElementById('filterEndDate').value = toLocalDateInput(fE);
    currentDateAnalysis = new Date(fS);
    updateAnalysisRange();
}

function changeAnalysisMonth(delta) {
    // 1. Cambiar el mes interno
    currentDateAnalysis.setDate(1); 
    currentDateAnalysis.setMonth(currentDateAnalysis.getMonth() + delta);
    
    // 2. Calcular el primer y último día del nuevo mes
    const y = currentDateAnalysis.getFullYear();
    const m = currentDateAnalysis.getMonth();
    const firstDay = new Date(y, m, 1);
    const lastDay = new Date(y, m + 1, 0);
    
    // 3. Modificar los filtros de fecha visibles
    document.getElementById('filterStartDate').value = toLocalDateInput(firstDay);
    document.getElementById('filterEndDate').value = toLocalDateInput(lastDay);
    
    // 4. Forzar descarga de los datos del nuevo mes desde Firebase
    updateAnalysisRange();
}

function renderCalendar(groupedByDate) {
    const y = currentDateAnalysis.getFullYear(); 
    const m = currentDateAnalysis.getMonth();
    const lbl = document.getElementById('calendarMonthLabel'); 
    
    if(lbl) {
        lbl.textContent = currentDateAnalysis.toLocaleDateString('es-ES', {month:'long', year:'numeric'}).replace(/^\w/, c => c.toUpperCase());
    }
    
    const grid = document.getElementById('calendarGrid'); 
    if(!grid) return;
    grid.innerHTML = '';
    
    const fDay = new Date(y, m, 1).getDay(); 
    const daysInM = new Date(y, m + 1, 0).getDate();
    
    for (let i = 0; i < fDay; i++) grid.innerHTML += `<div class="p-1 md:p-2 bg-slate-100 dark:bg-slate-900/30 rounded-lg md:rounded-xl border border-transparent"></div>`;
    
    for (let d = 1; d <= daysInM; d++) {
        const dStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const daySummary = groupedByDate.get(dStr) || createEmptyAnalysisSummary(dStr);
        const { tIng, tGas } = daySummary;

        const isToday = dStr === getTodayDateStr(); 
        const hasData = tIng > 0 || tGas > 0;
        const neto = tIng - tGas;
        
        const colorClass = hasData ? (neto >= 0 ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10' : 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10') : 'border-slate-200 bg-white dark:border-slate-700/50 dark:bg-slate-900/50';
        const ring = isToday ? 'ring-2 ring-sky-500' : '';
        const textColor = neto >= 0 ? 'text-emerald-500' : 'text-red-500';

        const div = document.createElement('div');
        div.className = `p-2 md:p-3 border rounded-lg md:rounded-xl cursor-pointer hover:border-sky-500 transition-colors flex flex-col justify-between min-h-[60px] md:min-h-[85px] relative overflow-hidden ${colorClass} ${ring} group shadow-sm`;
        
        let pointIndicators = '';
        if (hasData) {
            if (tIng > 0) pointIndicators += `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-sm"></span>`;
            if (tGas > 0) pointIndicators += `<span class="w-1.5 h-1.5 rounded-full bg-red-500 shadow-sm"></span>`;
        }

        div.innerHTML = `
            <span class="text-xs md:text-sm font-bold ${isToday ? 'text-sky-500' : 'text-slate-500'} mb-1">${d}</span>
            <div class="mt-auto text-right w-full flex flex-col items-end gap-1">
                ${hasData ? `<p class="text-[10px] md:text-xs font-black ${textColor} group-hover:scale-110 origin-right transition-transform">${formatMoney(neto)}</p>` : ''}
                <div class="flex gap-0.5 justify-end">${pointIndicators}</div>
            </div>
        `;
        
        div.onclick = () => showDayDetails(daySummary);
        grid.appendChild(div);
    }
}

function showDayDetails(daySummary) {
    const {
        dStr,
        ventas,
        gastos,
        tIng,
        tGas
    } = daySummary;
    window.currentSelectedDayObj = daySummary;
    
    const fSplit = dStr.split('-');
    const dateObj = new Date(fSplit[0], fSplit[1]-1, fSplit[2]);
    const fechaLegible = dateObj.toLocaleDateString('es-ES', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'});

    document.getElementById('selectedDateLabel').textContent = fechaLegible;
    document.getElementById('selectedDayIngresos').textContent = formatMoney(tIng);
    document.getElementById('selectedDayGanancias').textContent = formatMoney(tIng - tGas);
    const selectedDayGastos = document.getElementById('selectedDayGastos');
    if (selectedDayGastos) selectedDayGastos.textContent = formatMoney(tGas);
    
    const list = document.getElementById('selectedDayTransactions'); 
    if(!list) return;
    list.innerHTML = '';
    
    if (ventas.length === 0 && gastos.length === 0) { 
        list.innerHTML = '<div class="text-center py-8"><i data-lucide="calendar-x" class="w-12 h-12 mx-auto text-slate-400 mb-2 opacity-50"></i><p class="text-xs text-slate-500">No hay movimientos registrados este día.</p></div>'; 
        if(window.lucide) window.lucide.createIcons({ root: list });
        return; 
    }
    
    const isAdmin = isAdminUser();
    let lHtml = '';
    
    ventas.forEach(v => {
        const time = getOperationTime(v);
        const saleId = String(v.id || '');
        const safeSaleId = escaparHtml(saleId);
        const num = escaparHtml(saleId.split('-')[1] || '--');
        const items = Array.isArray(v.items) ? v.items : [];
        const cantItems = items.reduce(
            (sum, item) => sum + (Number(item?.cantidad) || 0),
            0
        );
        const localInfo = v.localNombre
            ? ` • <span class="text-[9px] uppercase tracking-wider">${escaparHtml(v.localNombre)}</span>`
            : '';
        const clienteNombre = obtenerNombreCliente(v);
        const clienteInfo = clienteNombre ? `<p class="text-[10px] text-sky-500 font-bold mt-0.5 flex items-center gap-1"><i data-lucide="user" class="w-3 h-3 shrink-0"></i><span class="truncate">Cliente: ${escaparHtml(clienteNombre)}</span></p>` : '';
        const metodoPago = escaparHtml(
            String(v.metodo_pago || v.metodoFinal || 'Efectivo').toUpperCase()
        );
        
        let iHtml = '<div data-analysis-transaction-detail class="hidden mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50 space-y-1.5">';
        items.forEach(i => {
            const quantity = Number(i?.cantidad) || 0;
            const price = Number(i?.precio) || 0;
            iHtml += `<div class="flex justify-between text-xs items-center"><p class="text-slate-500 pr-2 leading-tight"><span class="text-sky-500 font-bold">${escaparHtml(quantity)}x</span> ${escaparHtml(i?.nombre || 'Producto')}</p><p class="text-[10px] text-emerald-500 font-bold">${formatMoney(price * quantity)}</p></div>`;
        });
        
        if (isAdmin) {
            iHtml += `
            <div class="flex gap-1.5 mt-3 justify-end border-t border-slate-200 dark:border-slate-700/30 pt-2">
                <button data-analysis-action="edit" data-record-id="${safeSaleId}" data-record-kind="venta" data-record-amount="${escaparHtml(Number(v.total) || 0)}" class="text-slate-500 hover:text-amber-500 bg-slate-50 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Editar</button>
                <button data-analysis-action="delete" data-record-id="${safeSaleId}" data-record-kind="venta" class="text-slate-500 hover:text-red-500 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Anular</button>
            </div>
            `;
        }
        iHtml += `</div>`;
        
        lHtml += `
            <div data-analysis-transaction-card class="bg-white dark:bg-slate-800 p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-col cursor-pointer hover:border-emerald-500/50 transition-colors group mb-2 shadow-sm">
                <div class="flex justify-between items-center">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-500 shrink-0 border border-emerald-200 dark:border-emerald-500/20"><i data-lucide="shopping-cart" class="w-4 h-4"></i></div>
                        <div>
                            <p class="text-xs font-bold text-slate-800 dark:text-white">Venta POS <span class="text-[9px] text-slate-400 font-normal ml-1">#${num}</span></p>
                            <p class="text-[10px] text-slate-500">${cantItems} item(s) ${localInfo}</p>
                            ${clienteInfo}
                        </div>
                    </div>
                    <div class="text-right flex flex-col items-end">
                        <p class="text-sm font-black text-emerald-500">+ ${formatMoney(Number(v.total) || 0)}</p>
                        <p class="text-[9px] text-slate-400 font-bold mt-0.5">${escaparHtml(time)} • ${metodoPago}</p>
                    </div>
                </div>
                ${iHtml}
            </div>`;
    });
    
    gastos.forEach(g => { 
        const time = getOperationTime(g);
        const expenseId = String(g.id || '');
        const safeExpenseId = escaparHtml(expenseId);
        const localInfo = g.localNombre && g.localNombre !== 'Global'
            ? ` • <span class="text-[9px] uppercase tracking-wider">${escaparHtml(g.localNombre)}</span>`
            : '';
        
        let gHtml = '<div data-analysis-transaction-detail class="hidden mt-3 pt-2">';
        if (isAdmin) {
            gHtml += `
            <div class="flex gap-1.5 justify-end border-t border-red-200 dark:border-red-500/20 pt-2">
                <button data-analysis-action="edit" data-record-id="${safeExpenseId}" data-record-kind="gasto" data-record-amount="${escaparHtml(Number(g.monto) || 0)}" class="text-slate-500 hover:text-amber-500 bg-white dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Editar</button>
                <button data-analysis-action="delete" data-record-id="${safeExpenseId}" data-record-kind="gasto" class="text-slate-500 hover:text-red-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Borrar</button>
            </div>
            `;
        }
        gHtml += `</div>`;

        lHtml += `
            <div data-analysis-transaction-card class="bg-red-50 dark:bg-red-500/5 p-3.5 rounded-xl border border-red-200 dark:border-red-500/20 flex flex-col cursor-pointer hover:border-red-300 dark:hover:border-red-500/40 transition-colors group mb-2 shadow-sm">
                <div class="flex justify-between items-center">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full bg-red-100 dark:bg-red-500/10 flex items-center justify-center text-red-500 shrink-0 border border-red-200 dark:border-red-500/20"><i data-lucide="trending-down" class="w-4 h-4"></i></div>
                        <div>
                            <p class="text-xs font-bold text-red-500">Gasto</p>
                            <p class="text-[10px] text-slate-500">${escaparHtml(g.descripcion || 'Sin descripción')} ${localInfo}</p>
                        </div>
                    </div>
                    <div class="text-right">
                        <p class="text-sm font-black text-red-500">- ${formatMoney(Number(g.monto) || 0)}</p>
                        <p class="text-[9px] text-red-400/70 font-bold mt-0.5">${escaparHtml(time)}</p>
                    </div>
                </div>
                ${gHtml}
            </div>`; 
    });
    
    list.innerHTML = lHtml; 
    if(window.lucide) window.lucide.createIcons({ root: list });
}

/**
 * Muestra un resumen ya filtrado y agregado. El modal nunca vuelve a consultar
 * ni a filtrar Firestore, por lo que sus cifras son las mismas de la tarjeta.
 */
function showBreakdown(type, dayObj) {
    if (!analisisInicializado) return;
    const modal = document.getElementById('breakdownModal');
    const title = document.getElementById('brkTitle');
    const paymentContainer = document.getElementById('brkPaymentSummary');
    const categoriesContainer = document.getElementById('brkCategories');
    const categoriesList = document.getElementById('brkCategoriesList');
    if (!modal || !title || !paymentContainer || !categoriesContainer || !categoriesList) return;

    const summary = dayObj || currentRangeSummary;
    const normalizedType = String(type || 'BRUTO').trim().toUpperCase();
    const isIncome = normalizedType === 'BRUTO' || normalizedType === 'INGRESOS';
    const isExpenses = normalizedType === 'GASTOS';
    const fechaText = dayObj
        ? dayObj.dStr
        : `${document.getElementById('filterStartDate')?.value || ''} - ${document.getElementById('filterEndDate')?.value || ''}`;
    const neto = summary.tIng - summary.tGas;

    const paymentRows = `
        <div class="flex justify-between items-center bg-sky-50 dark:bg-sky-500/10 p-3 rounded-xl border border-sky-200 dark:border-sky-500/30 shadow-sm">
            <span class="text-sm font-bold text-sky-700 dark:text-sky-400 flex items-center"><i data-lucide="trending-up" class="w-4 h-4 mr-2"></i> Ingresos</span>
            <span class="font-black text-sky-700 dark:text-sky-400 text-base">${formatMoney(summary.tIng)}</span>
        </div>
        <div class="flex justify-between items-center bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
            <span class="text-sm font-bold text-slate-800 dark:text-white flex items-center"><i data-lucide="banknote" class="w-4 h-4 mr-2 text-emerald-500"></i> Efectivo</span>
            <span class="font-black text-slate-800 dark:text-white text-base">${formatMoney(summary.tEfe)}</span>
        </div>
        <div class="flex justify-between items-center bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
            <span class="text-sm font-bold text-slate-800 dark:text-white flex items-center"><i data-lucide="smartphone" class="w-4 h-4 mr-2 text-purple-500"></i> Yape / Plin</span>
            <span class="font-black text-slate-800 dark:text-white text-base">${formatMoney(summary.tYap)}</span>
        </div>
        ${Math.abs(summary.tTar) >= 0.005 ? `
            <div class="flex justify-between items-center bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <span class="text-sm font-bold text-slate-800 dark:text-white flex items-center"><i data-lucide="credit-card" class="w-4 h-4 mr-2 text-cyan-500"></i> Tarjeta</span>
                <span class="font-black text-slate-800 dark:text-white text-base">${formatMoney(summary.tTar)}</span>
            </div>
        ` : ''}
        ${Math.abs(summary.tOtros) >= 0.005 ? `
            <div class="flex justify-between items-center bg-amber-50 dark:bg-amber-500/10 p-3 rounded-xl border border-amber-200 dark:border-amber-500/30 shadow-sm">
                <span class="text-sm font-bold text-amber-700 dark:text-amber-400 flex items-center"><i data-lucide="circle-dollar-sign" class="w-4 h-4 mr-2"></i> Otros / ajuste</span>
                <span class="font-black text-amber-700 dark:text-amber-400 text-base">${formatMoney(summary.tOtros)}</span>
            </div>
        ` : ''}
    `;

    if (isIncome) {
        title.innerHTML = `
            <div class="flex flex-col">
                <span class="text-lg font-bold text-slate-800 dark:text-white">Desglose de Ingresos</span>
                <span class="text-[10px] text-slate-500 font-normal mt-0.5">${escaparHtml(fechaText)}</span>
            </div>
        `;
        paymentContainer.innerHTML = paymentRows;

        const categoryTotals = new Map();
        summary.ventas.forEach(venta => {
            venta.items?.forEach(item => {
                const category = String(item.categoria || 'otros').trim().toLowerCase() || 'otros';
                categoryTotals.set(
                    category,
                    (categoryTotals.get(category) || 0) + toAmount(item.precio) * toAmount(item.cantidad)
                );
            });
        });

        let categoriesHtml = '<p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 mt-4">Desglose por categorías</p>';
        if (categoryTotals.size === 0) {
            categoriesHtml += '<p class="text-xs text-slate-500 text-center py-3">No hay ventas en este periodo.</p>';
        }
        for (const [category, total] of categoryTotals) {
            let icon = 'tag';
            if (category.includes('cerveza') || category.includes('vaso')) icon = 'cup-soda';
            if (category.includes('vodka') || category.includes('ron') || category.includes('vino')) icon = 'wine';
            if (category.includes('extra') || category.includes('tabaco') || category.includes('snack')) icon = 'package';
            if (category.includes('gaseosa')) icon = 'droplets';
            categoriesHtml += `
                <div class="flex justify-between items-center bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-700/50 mb-2 shadow-sm">
                    <div class="flex items-center gap-3 min-w-0">
                        <i data-lucide="${icon}" class="w-4 h-4 text-slate-500 shrink-0"></i>
                        <span class="text-sm font-bold text-slate-800 dark:text-white capitalize truncate">${escaparHtml(category)}</span>
                    </div>
                    <span class="text-sm text-emerald-500 font-bold shrink-0 ml-2">${formatMoney(total)}</span>
                </div>
            `;
        }
        categoriesList.innerHTML = categoriesHtml;
    } else if (isExpenses) {
        title.innerHTML = `
            <div class="flex flex-col">
                <span class="text-lg font-bold text-slate-800 dark:text-white">Desglose de Gastos</span>
                <span class="text-[10px] text-slate-500 font-normal mt-0.5">${escaparHtml(fechaText)}</span>
            </div>
        `;
        paymentContainer.innerHTML = `
            <div class="flex justify-between items-center bg-red-50 dark:bg-red-500/10 p-3 rounded-xl border border-red-200 dark:border-red-500/30 shadow-sm">
                <span class="text-sm font-bold text-red-600 dark:text-red-400 flex items-center"><i data-lucide="trending-down" class="w-4 h-4 mr-2"></i> Gastos</span>
                <span class="font-black text-red-600 dark:text-red-400 text-base">${formatMoney(summary.tGas)}</span>
            </div>
            <div class="flex justify-between items-center bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <span class="text-sm font-bold text-slate-600 dark:text-slate-300 flex items-center"><i data-lucide="list-checks" class="w-4 h-4 mr-2 text-slate-500"></i> Movimientos</span>
                <span class="font-black text-slate-800 dark:text-white text-base">${summary.gastos.length}</span>
            </div>
        `;

        const expenseTotals = new Map();
        summary.gastos.forEach(gasto => {
            const label = String(gasto.categoria || gasto.tipo || gasto.descripcion || 'Otros').trim() || 'Otros';
            expenseTotals.set(label, (expenseTotals.get(label) || 0) + toAmount(gasto.monto));
        });

        let expensesHtml = '<p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 mt-4">Detalle de egresos</p>';
        if (expenseTotals.size === 0) {
            expensesHtml += '<p class="text-xs text-slate-500 text-center py-3">No hay gastos en este periodo.</p>';
        }
        for (const [label, total] of expenseTotals) {
            expensesHtml += `
                <div class="flex justify-between items-center bg-red-50 dark:bg-red-500/5 p-3 rounded-xl border border-red-200 dark:border-red-500/20 mb-2 shadow-sm">
                    <div class="flex items-center gap-3 min-w-0">
                        <i data-lucide="receipt" class="w-4 h-4 text-red-500 shrink-0"></i>
                        <span class="text-sm font-bold text-slate-800 dark:text-white truncate">${escaparHtml(label)}</span>
                    </div>
                    <span class="text-sm text-red-500 font-bold shrink-0 ml-2">${formatMoney(total)}</span>
                </div>
            `;
        }
        categoriesList.innerHTML = expensesHtml;
    } else {
        const netPanelClasses = neto >= 0
            ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30'
            : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30';
        const netLabelClasses = neto >= 0
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-red-600 dark:text-red-400';
        const netDescriptionClasses = neto >= 0
            ? 'text-emerald-600/70 dark:text-emerald-500/70'
            : 'text-red-600/70 dark:text-red-500/70';
        const netValueClasses = neto >= 0 ? 'text-emerald-500' : 'text-red-500';
        title.innerHTML = `
            <div class="flex flex-col">
                <span class="text-lg font-bold text-slate-800 dark:text-white">Análisis de Caja Neta</span>
                <span class="text-[10px] text-slate-500 font-normal mt-0.5">${escaparHtml(fechaText)}</span>
            </div>
        `;
        paymentContainer.innerHTML = `
            ${paymentRows}
            <div class="flex justify-between items-center bg-red-50 dark:bg-red-500/10 p-3 rounded-xl border border-red-200 dark:border-red-500/30 shadow-sm">
                <span class="text-sm font-bold text-red-600 dark:text-red-400 flex items-center"><i data-lucide="trending-down" class="w-4 h-4 mr-2"></i> Gastos</span>
                <span class="font-black text-red-600 dark:text-red-400 text-base">${formatMoney(summary.tGas)}</span>
            </div>
        `;
        categoriesList.innerHTML = `
            <div class="${netPanelClasses} border p-4 rounded-xl mt-4 flex justify-between items-center gap-3 shadow-sm">
                <div>
                    <p class="text-[10px] font-bold ${netLabelClasses} uppercase tracking-widest mb-1">Caja Neta</p>
                    <p class="text-xs ${netDescriptionClasses}">Ingresos menos gastos</p>
                </div>
                <span class="text-2xl font-black ${netValueClasses} shrink-0">${formatMoney(neto)}</span>
            </div>
        `;
    }

    if (breakdownCloseTimer) {
        clearTimeout(breakdownCloseTimer);
        breakdownCloseTimer = null;
    }
    if (breakdownShowTimer) {
        clearTimeout(breakdownShowTimer);
        breakdownShowTimer = null;
    }
    categoriesContainer.classList.remove('hidden');
    modal.classList.remove('hidden');
    breakdownShowTimer = setTimeout(() => {
        breakdownShowTimer = null;
        if (!analisisInicializado) return;
        modal.classList.remove('opacity-0');
    }, 10);
    if(window.lucide) window.lucide.createIcons({ root: modal });
}

function closeBreakdownModal() { 
    const m = document.getElementById('breakdownModal'); 
    if(m) {
        if (breakdownCloseTimer) clearTimeout(breakdownCloseTimer);
        if (breakdownShowTimer) clearTimeout(breakdownShowTimer);
        breakdownShowTimer = null;
        m.classList.add('opacity-0'); 
        breakdownCloseTimer = setTimeout(() => {
            m.classList.add('hidden');
            breakdownCloseTimer = null;
        }, 300); 
    }
}
