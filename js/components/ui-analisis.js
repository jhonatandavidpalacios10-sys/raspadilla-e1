import { db, collection, query, where, onSnapshot } from '../core/firebase-setup.js';
import { formatMoney, getTodayDateStr, obtenerNombreCliente, escaparHtml } from '../utils/helpers.js';
import { state } from '../core/store.js';

let analysisData = []; 
let analysisGastos = []; 
let currentDateAnalysis = new Date(); 
window.currentSelectedDayObj = null;

let unsubscribeVentas = null;
let unsubscribeGastos = null;
let readyV = false;
let readyG = false;
let analisisInicializado = false; // CANDADO AÑADIDO

export function initAnalisis() {
    // FIX CRÍTICO: Prevenir duplicación de eventos al rotar turnos
    if (analisisInicializado) return;
    analisisInicializado = true;

    window.updateAnalysisRange = updateAnalysisRange; 
    window.setAnalysisRange = setAnalysisRange; 
    window.changeAnalysisMonth = changeAnalysisMonth; 
    window.showBreakdown = showBreakdown; 
    window.closeBreakdownModal = closeBreakdownModal;
    
    // Configurar fechas por defecto (Mes actual en lugar de solo hoy para mejor vista de calendario)
    const d = new Date();
    const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    
    document.getElementById('filterStartDate').value = firstDay.toISOString().split('T')[0]; 
    document.getElementById('filterEndDate').value = lastDay.toISOString().split('T')[0];

    // Eventos
    document.getElementById('filterStartDate')?.addEventListener('change', () => {
        currentDateAnalysis = new Date(document.getElementById('filterStartDate').value + "T00:00:00");
        updateAnalysisRange();
    });
    document.getElementById('filterEndDate')?.addEventListener('change', updateAnalysisRange);
    document.getElementById('analisisLocalFilter')?.addEventListener('change', processAndRenderAnalysis); // En vivo desde RAM
    
    document.getElementById('btn-filtro-hoy')?.addEventListener('click', () => setAnalysisRange('hoy'));
    document.getElementById('btn-filtro-semana')?.addEventListener('click', () => setAnalysisRange('semana'));
    document.getElementById('btn-filtro-mes')?.addEventListener('click', () => setAnalysisRange('mes'));
    
    document.getElementById('btn-mes-prev')?.addEventListener('click', () => changeAnalysisMonth(-1));
    document.getElementById('btn-mes-next')?.addEventListener('click', () => changeAnalysisMonth(1));

    updateAnalysisRange(); 
}

function updateAnalysisRange() {
    const fS = document.getElementById('filterStartDate').value; 
    const fE = document.getElementById('filterEndDate').value;
    
    if (!fS || !fE) return;

    if (unsubscribeVentas) unsubscribeVentas();
    if (unsubscribeGastos) unsubscribeGastos();

    const cSum = document.getElementById('analysisRangeSummary');
    if(cSum) cSum.innerHTML = '<div class="col-span-4 text-center py-2"><i data-lucide="loader-2" class="w-5 h-5 animate-spin mx-auto text-sky-500"></i></div>';
    if(window.lucide) window.lucide.createIcons();

    const qV = query(collection(db, "ventas"), where("fechaStr", ">=", fS), where("fechaStr", "<=", fE));
    const qG = query(collection(db, "gastos"), where("fechaStr", ">=", fS), where("fechaStr", "<=", fE));
    
    readyV = false;
    readyG = false;

    // Escucha en tiempo real de ventas
    unsubscribeVentas = onSnapshot(qV, (snapshot) => {
        analysisData = [];
        // FIX: Time-jump bug
        snapshot.forEach(d => { analysisData.push({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }); });
        readyV = true;
        if(readyV && readyG) processAndRenderAnalysis();
    }, (error) => {
        console.error("Error cargando ventas para análisis:", error);
    });

    // Escucha en tiempo real de gastos
    unsubscribeGastos = onSnapshot(qG, (snapshot) => {
        analysisGastos = [];
        // FIX: Time-jump bug
        snapshot.forEach(d => { analysisGastos.push({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }); });
        readyG = true;
        if(readyV && readyG) processAndRenderAnalysis();
    }, (error) => {
        console.error("Error cargando gastos para análisis:", error);
    });
}

function processAndRenderAnalysis() {
    let lF = document.getElementById('analisisLocalFilter')?.value || 'todas';
    const miSedeId = state.userLocalId || "";

    let filteredVentas = [];
    let filteredGastos = [];

    // FIX CRÍTICO: Procesar ventas con filtro local unificado
    analysisData.forEach(v => { 
        let mostrar = false;
        if (state.userRole === 'admin' || state.userRole === 'master') {
            mostrar = (lF === 'todas') || (v.localId === lF) || (lF === '' && (!v.localId || v.localId === '' || v.localId === 'general'));
        } else {
            mostrar = (v.localId === miSedeId || (!v.localId && miSedeId === "") || (v.localId === 'general' && miSedeId === ""));
        }
        
        if (mostrar && v.estado !== 'rechazado') filteredVentas.push(v); 
    });
    
    // FIX CRÍTICO: Procesar gastos con filtro local unificado
    analysisGastos.forEach(g => { 
        let mostrar = false;
        if (state.userRole === 'admin' || state.userRole === 'master') {
            mostrar = (lF === 'todas') || (g.localId === lF) || (lF === '' && (!g.localId || g.localId === '' || g.localId === 'general'));
        } else {
            mostrar = (g.localId === miSedeId || (!g.localId && miSedeId === "") || (g.localId === 'general' && miSedeId === ""));
        }
        if (mostrar) filteredGastos.push(g); 
    });

    // Totales globales
    let ing = 0, cost = 0, efe = 0, yap = 0, tar = 0, gas = 0;
    filteredVentas.forEach(v => { 
        ing += parseFloat(v.total||0); 
        efe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); 
        yap += parseFloat(v.pago_yape || v.pagoYape || 0); 
        if (String(v.metodo_pago).toLowerCase() === 'tarjeta' || String(v.metodoFinal).toLowerCase() === 'tarjeta') {
            tar += parseFloat(v.total||0);
        }
    });
    
    filteredGastos.forEach(g => { gas += parseFloat(g.monto||0); });

    // Actualizar UI de Tarjetas Superiores
    const cSum = document.getElementById('analysisRangeSummary');
    if(cSum) {
        cSum.innerHTML = `
            <div class="bg-white dark:bg-slate-800 rounded-xl p-3 md:p-4 border border-slate-200 dark:border-slate-700 text-center cursor-pointer hover:border-sky-500 transition-colors shadow-sm" onclick="window.showBreakdown('BRUTO', null, ${ing}, ${efe}, ${yap}, ${tar}, ${gas})">
                <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                    <i data-lucide="trending-up" class="w-3.5 h-3.5 text-sky-500"></i>
                    <p class="text-[10px] md:text-[11px] text-slate-500 uppercase font-bold tracking-wider">Ingresos</p>
                </div>
                <p class="text-sm md:text-xl font-black text-slate-800 dark:text-white" id="tot-ingresos">${formatMoney(ing)}</p>
            </div>
            <div class="bg-white dark:bg-slate-800 rounded-xl p-3 md:p-4 border border-slate-200 dark:border-slate-700 text-center cursor-pointer hover:border-emerald-500 transition-colors shadow-sm" onclick="window.showBreakdown('GANANCIA', null, ${ing}, ${efe}, ${yap}, ${tar}, ${gas})">
                <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                    <i data-lucide="pie-chart" class="w-3.5 h-3.5 text-emerald-500"></i>
                    <p class="text-[10px] md:text-[11px] text-slate-500 uppercase font-bold tracking-wider">Ganancia Neta</p>
                </div>
                <p class="text-sm md:text-xl font-black text-emerald-500" id="tot-neta">${formatMoney(ing - gas)}</p>
            </div>
            <div class="bg-white dark:bg-slate-800 rounded-xl p-3 md:p-4 border border-slate-200 dark:border-slate-700 text-center shadow-sm">
                <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                    <i data-lucide="trending-down" class="w-3.5 h-3.5 text-red-500"></i>
                    <p class="text-[10px] md:text-[11px] text-slate-500 uppercase font-bold tracking-wider">Gastos</p>
                </div>
                <p class="text-sm md:text-xl font-bold text-red-500" id="tot-gastos">${formatMoney(gas)}</p>
            </div>
            <div class="bg-white dark:bg-slate-800 rounded-xl p-3 md:p-4 border border-slate-200 dark:border-slate-700 text-center shadow-sm">
                <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                    <i data-lucide="list-checks" class="w-3.5 h-3.5 text-purple-500"></i>
                    <p class="text-[10px] md:text-[11px] text-slate-500 uppercase font-bold tracking-wider">Transacciones</p>
                </div>
                <p class="text-sm md:text-xl font-bold text-slate-800 dark:text-white">${filteredVentas.length}</p>
            </div>
        `;
    }
    
    if(window.lucide) window.lucide.createIcons();
    renderCalendar(filteredVentas, filteredGastos);

    // Re-render en vivo del detalle del día seleccionado
    if (window.currentSelectedDayObj) {
        const dStr = window.currentSelectedDayObj.dStr;
        const vDay = filteredVentas.filter(v => v.fechaStr === dStr);
        const gDay = filteredGastos.filter(g => g.fechaStr === dStr);
        
        let tIngD = 0, tEfeD = 0, tYapD = 0, tTarD = 0, tGasD = 0;
        vDay.forEach(v => { 
            tIngD += parseFloat(v.total||0); 
            tEfeD += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); 
            tYapD += parseFloat(v.pago_yape || v.pagoYape || 0); 
            if (String(v.metodo_pago).toLowerCase() === 'tarjeta' || String(v.metodoFinal).toLowerCase() === 'tarjeta') tTarD += parseFloat(v.total||0);
        });
        gDay.forEach(g => { tGasD += parseFloat(g.monto||0); });

        showDayDetails(dStr, vDay, gDay, tIngD, tEfeD, tYapD, tTarD, tGasD);
    }
}

function setAnalysisRange(tipo) {
    const d = new Date(); 
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
    
    document.getElementById('filterStartDate').value = fS.toISOString().split('T')[0];
    document.getElementById('filterEndDate').value = fE.toISOString().split('T')[0];
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
    document.getElementById('filterStartDate').value = firstDay.toISOString().split('T')[0];
    document.getElementById('filterEndDate').value = lastDay.toISOString().split('T')[0];
    
    // 4. Forzar descarga de los datos del nuevo mes desde Firebase
    updateAnalysisRange();
}

function renderCalendar(filteredVentas, filteredGastos) {
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
        
        const vDay = filteredVentas.filter(v => v.fechaStr === dStr);
        const gDay = filteredGastos.filter(g => g.fechaStr === dStr);
        
        let tIng = 0, tGas = 0;
        vDay.forEach(v => { tIng += parseFloat(v.total||0); });
        gDay.forEach(g => { tGas += parseFloat(g.monto||0); });

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
        
        div.onclick = () => showDayDetails(dStr, vDay, gDay, tIng, 0, 0, 0, tGas); // Totales exactos se recalculan en showDayDetails
        grid.appendChild(div);
    }
}

function showDayDetails(dStr, ventas, gastos, tIng, _tEfe, _tYap, _tTar, tGas) {
    // Recalcular montos exactos para breakdown
    let tEfe = 0, tYap = 0, tTar = 0;
    ventas.forEach(v => {
        tEfe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); 
        tYap += parseFloat(v.pago_yape || v.pagoYape || 0); 
        if (String(v.metodo_pago).toLowerCase() === 'tarjeta' || String(v.metodoFinal).toLowerCase() === 'tarjeta') tTar += parseFloat(v.total||0);
    });

    window.currentSelectedDayObj = { dStr, ventas, gastos, tIng, tEfe, tYap, tTar, tGas };
    
    const fSplit = dStr.split('-');
    const dateObj = new Date(fSplit[0], fSplit[1]-1, fSplit[2]);
    const fechaLegible = dateObj.toLocaleDateString('es-ES', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'});

    document.getElementById('selectedDateLabel').textContent = fechaLegible;
    document.getElementById('selectedDayIngresos').textContent = formatMoney(tIng);
    document.getElementById('selectedDayGanancias').textContent = formatMoney(tIng - tGas);
    
    const list = document.getElementById('selectedDayTransactions'); 
    if(!list) return;
    list.innerHTML = '';
    
    if (ventas.length === 0 && gastos.length === 0) { 
        list.innerHTML = '<div class="text-center py-8"><i data-lucide="calendar-x" class="w-12 h-12 mx-auto text-slate-400 mb-2 opacity-50"></i><p class="text-xs text-slate-500">No hay movimientos registrados este día.</p></div>'; 
        if(window.lucide) window.lucide.createIcons();
        return; 
    }
    
    const isAdmin = state.userRole === 'master' || state.userRole === 'admin';
    let lHtml = '';
    
    ventas.forEach(v => {
        // FIX: Mostrar hora correcta o actual si no hay timestamp temporal
        const time = v.timestamp ? new Date(v.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const num = v.id.split('-')[1] || '--';
        const cantItems = v.items ? v.items.reduce((s,i) => s + i.cantidad, 0) : 0;
        const localInfo = v.localNombre ? ` • <span class="text-[9px] uppercase tracking-wider">${v.localNombre}</span>` : '';
        const clienteNombre = obtenerNombreCliente(v);
        const clienteInfo = clienteNombre ? `<p class="text-[10px] text-sky-500 font-bold mt-0.5 flex items-center gap-1"><i data-lucide="user" class="w-3 h-3 shrink-0"></i><span class="truncate">Cliente: ${escaparHtml(clienteNombre)}</span></p>` : '';
        const metodoPago = String(v.metodo_pago || v.metodoFinal || 'Efectivo').toUpperCase();
        
        let iHtml = `<div id="det-${v.id}" class="hidden mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50 space-y-1.5">`;
        v.items?.forEach(i => { 
            iHtml += `<div class="flex justify-between text-xs items-center"><p class="text-slate-500 pr-2 leading-tight"><span class="text-sky-500 font-bold">${i.cantidad}x</span> ${i.nombre}</p><p class="text-[10px] text-emerald-500 font-bold">${formatMoney(i.precio * i.cantidad)}</p></div>`; 
        });
        
        // Botones de acción dinámicos para administradores (Igual que en Caja)
        if (isAdmin) {
            iHtml += `
            <div class="flex gap-1.5 mt-3 justify-end border-t border-slate-200 dark:border-slate-700/30 pt-2">
                <button onclick="window.editarOperacionCaja('venta', '${v.id}', ${v.total})" class="text-slate-500 hover:text-amber-500 bg-slate-50 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Editar</button>
                <button onclick="window.eliminarOperacionCaja('venta', '${v.id}')" class="text-slate-500 hover:text-red-500 bg-slate-50 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Anular</button>
            </div>
            `;
        }
        iHtml += `</div>`;
        
        lHtml += `
            <div class="bg-white dark:bg-slate-800 p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-col cursor-pointer hover:border-emerald-500/50 transition-colors group mb-2 shadow-sm" onclick="if(event.target.closest('button')) return; document.getElementById('det-${v.id}').classList.toggle('hidden')">
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
                        <p class="text-sm font-black text-emerald-500">+ ${formatMoney(v.total)}</p>
                        <p class="text-[9px] text-slate-400 font-bold mt-0.5">${time} • ${metodoPago}</p>
                    </div>
                </div>
                ${iHtml}
            </div>`;
    });
    
    gastos.forEach(g => { 
        // FIX: Mostrar hora correcta o actual si no hay timestamp temporal
        const time = g.timestamp ? new Date(g.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const localInfo = g.localNombre && g.localNombre !== 'Global' ? ` • <span class="text-[9px] uppercase tracking-wider">${g.localNombre}</span>` : '';
        
        let gHtml = `<div id="det-${g.id}" class="hidden mt-3 pt-2">`;
        if (isAdmin) {
            gHtml += `
            <div class="flex gap-1.5 justify-end border-t border-red-200 dark:border-red-500/20 pt-2">
                <button onclick="window.editarOperacionCaja('gasto', '${g.id}', ${g.monto})" class="text-slate-500 hover:text-amber-500 bg-white dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Editar</button>
                <button onclick="window.eliminarOperacionCaja('gasto', '${g.id}')" class="text-slate-500 hover:text-red-500 bg-white dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] uppercase font-bold"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Borrar</button>
            </div>
            `;
        }
        gHtml += `</div>`;

        lHtml += `
            <div class="bg-red-50 dark:bg-red-500/5 p-3.5 rounded-xl border border-red-200 dark:border-red-500/20 flex flex-col cursor-pointer hover:border-red-300 dark:hover:border-red-500/40 transition-colors group mb-2 shadow-sm" onclick="if(event.target.closest('button')) return; document.getElementById('det-${g.id}').classList.toggle('hidden')">
                <div class="flex justify-between items-center">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full bg-red-100 dark:bg-red-500/10 flex items-center justify-center text-red-500 shrink-0 border border-red-200 dark:border-red-500/20"><i data-lucide="trending-down" class="w-4 h-4"></i></div>
                        <div>
                            <p class="text-xs font-bold text-red-500">Gasto</p>
                            <p class="text-[10px] text-slate-500">${g.descripcion} ${localInfo}</p>
                        </div>
                    </div>
                    <div class="text-right">
                        <p class="text-sm font-black text-red-500">- ${formatMoney(g.monto)}</p>
                        <p class="text-[9px] text-red-400/70 font-bold mt-0.5">${time}</p>
                    </div>
                </div>
                ${gHtml}
            </div>`; 
    });
    
    list.innerHTML = lHtml; 
    if(window.lucide) window.lucide.createIcons();
}

/**
 * Reconstruye el modal interno de detalle de ingresos exactamente como la imagen proporcionada.
 */
function showBreakdown(type, dayObj, gIng = null, gEfe = null, gYap = null, gTar = null, gGas = null) {
    const m = document.getElementById('breakdownModal'); 
    if(!m) return;
    
    const cL = document.getElementById('brkCategoriesList'); 
    cL.innerHTML = '';
    
    let dVentas = dayObj ? dayObj.ventas : analysisData;
    let tIng = dayObj ? dayObj.tIng : gIng;
    let tEfe = dayObj ? dayObj.tEfe : gEfe;
    let tYap = dayObj ? dayObj.tYap : gYap;
    let tTar = dayObj ? dayObj.tTar : gTar;
    let tGas = dayObj ? dayObj.tGas : gGas;
    
    const fechaText = dayObj ? dayObj.dStr : `${document.getElementById('filterStartDate').value} - ${document.getElementById('filterEndDate').value}`;
    
    const paymentContainer = document.getElementById('brkEfectivo').parentElement.parentElement;
    
    if (type === 'BRUTO') {
        document.getElementById('brkTitle').innerHTML = `
            <div class="flex flex-col">
                <span class="text-lg font-bold text-slate-800 dark:text-white">Desglose de Ingresos (Bruto)</span>
                <span class="text-[10px] text-slate-500 font-normal mt-0.5">${fechaText}</span>
            </div>
        `;
        
        paymentContainer.innerHTML = `
            <div class="flex justify-between items-center bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm mb-2">
                <span class="text-sm font-bold text-slate-800 dark:text-white flex items-center"><i data-lucide="banknote" class="w-4 h-4 inline mr-2 text-emerald-500"></i> Efectivo</span>
                <span class="font-black text-slate-800 dark:text-white text-base">${formatMoney(tEfe)}</span>
            </div>
            <div class="flex justify-between items-center bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm mb-2">
                <span class="text-sm font-bold text-slate-800 dark:text-white flex items-center"><i data-lucide="alert-circle" class="w-4 h-4 inline mr-2 text-purple-500"></i> Yape / Plin</span>
                <span class="font-black text-slate-800 dark:text-white text-base">${formatMoney(tYap)}</span>
            </div>
            <div class="flex justify-between items-center bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <span class="text-sm font-bold text-slate-800 dark:text-white flex items-center"><i data-lucide="credit-card" class="w-4 h-4 inline mr-2 text-sky-500"></i> Tarjeta</span>
                <span class="font-black text-slate-800 dark:text-white text-base">${formatMoney(tTar)}</span>
            </div>
        `;
        
        let catTotals = {};
        
        // FIX CRÍTICO: Recalcular por las ventas ya filtradas en RAM usando la lógica unificada
        let lF = document.getElementById('analisisLocalFilter')?.value || 'todas';
        const miSedeId = state.userLocalId || "";
        
        dVentas.forEach(v => { 
            let mostrar = false;
            if (state.userRole === 'admin' || state.userRole === 'master') {
                mostrar = (lF === 'todas') || (v.localId === lF) || (lF === '' && (!v.localId || v.localId === '' || v.localId === 'general'));
            } else {
                mostrar = (v.localId === miSedeId || (!v.localId && miSedeId === "") || (v.localId === 'general' && miSedeId === ""));
            }

            if (mostrar && v.estado !== 'rechazado') {
                v.items?.forEach(i => { 
                    const catStr = String(i.categoria || 'otros').toLowerCase();
                    if(catTotals[catStr] === undefined) catTotals[catStr] = 0;
                    catTotals[catStr] += (i.precio * i.cantidad); 
                }); 
            }
        });
        
        let htmlCats = `<p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 mt-4">Desglose por Categorías</p>`;
        
        for (const [catName, totalCat] of Object.entries(catTotals)) {
            let icon = 'tag';
            if (catName.includes('cerveza') || catName.includes('vaso')) icon = 'cup-soda';
            if (catName.includes('vodka') || catName.includes('ron') || catName.includes('vino')) icon = 'wine';
            if (catName.includes('extra') || catName.includes('tabaco') || catName.includes('snack')) icon = 'package';
            if (catName.includes('gaseosa')) icon = 'droplets';
            
            htmlCats += `
                <div class="flex justify-between items-center bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-700/50 mb-2 shadow-sm">
                    <div class="flex items-center gap-3">
                        <i data-lucide="${icon}" class="w-4 h-4 text-slate-500"></i>
                        <span class="text-sm font-bold text-slate-800 dark:text-white capitalize">${catName}</span>
                    </div>
                    <span class="text-sm text-emerald-500 font-bold">${formatMoney(totalCat)}</span>
                </div>
            `;
        }
        
        cL.innerHTML = htmlCats;
        document.getElementById('brkCategories').classList.remove('hidden');
        
    } else {
        document.getElementById('brkTitle').innerHTML = `
            <div class="flex flex-col">
                <span class="text-lg font-bold text-slate-800 dark:text-white">Análisis de Ganancia</span>
                <span class="text-[10px] text-slate-500 font-normal mt-0.5">${fechaText}</span>
            </div>
        `;
        
        paymentContainer.innerHTML = `
            <div class="flex justify-between items-center bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm mb-2">
                <span class="text-sm font-bold text-slate-800 dark:text-white flex items-center"><i data-lucide="trending-up" class="w-4 h-4 inline mr-2 text-sky-500"></i> Ingreso Total</span>
                <span class="font-black text-slate-800 dark:text-white text-base">${formatMoney(tIng)}</span>
            </div>
            <div class="flex justify-between items-center bg-red-50 dark:bg-red-500/10 p-3 rounded-xl border border-red-200 dark:border-red-500/30 shadow-sm">
                <span class="text-sm font-bold text-red-500 flex items-center"><i data-lucide="trending-down" class="w-4 h-4 inline mr-2 text-red-500"></i> Gastos/Retiros</span>
                <span class="font-black text-red-500 text-base">-${formatMoney(tGas)}</span>
            </div>
        `;
        
        cL.innerHTML = `
            <div class="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 p-4 rounded-xl mt-4 flex justify-between items-center shadow-sm">
                <div>
                    <p class="text-[10px] font-bold text-emerald-600 uppercase tracking-widest mb-1">Caja Neta Real</p>
                    <p class="text-xs text-emerald-600/70 dark:text-emerald-500/70">Dinero disponible tras egresos</p>
                </div>
                <span class="text-2xl font-black text-emerald-500">${formatMoney(tIng - tGas)}</span>
            </div>
        `;
        document.getElementById('brkCategories').classList.remove('hidden');
    }
    
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10); 
    if(window.lucide) window.lucide.createIcons();
}

function closeBreakdownModal() { 
    const m = document.getElementById('breakdownModal'); 
    if(m) {
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
    }
}
