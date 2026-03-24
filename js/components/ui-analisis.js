import { db, collection, query, where, getDocs } from '../core/firebase-setup.js';
import { formatMoney, getTodayDateStr } from '../utils/helpers.js';

let analysisData = []; let analysisGastos = []; let currentDateAnalysis = new Date(); window.currentSelectedDayObj = null;

export function initAnalisis() {
    window.updateAnalysisRange = updateAnalysisRange; 
    window.setAnalysisRange = setAnalysisRange; 
    window.changeAnalysisMonth = changeAnalysisMonth; 
    window.showBreakdown = showBreakdown; 
    window.closeBreakdownModal = closeBreakdownModal;
    
    // Inyectar nueva UI de filtros dinámicamente sin tocar el HTML
    const btnHoy = document.getElementById('btn-filtro-hoy');
    if (btnHoy && btnHoy.parentElement) {
        const container = btnHoy.parentElement;
        container.innerHTML = `
            <div class="flex items-center gap-1.5">
                <select id="analisis-rango-predefinido" class="bg-slate-700 text-white rounded text-[10px] px-2 py-1 outline-none cursor-pointer border border-slate-600">
                    <option value="hoy">Hoy</option>
                    <option value="semana">Últimos 7 Días</option>
                    <option value="mes" selected>Últimos 30 Días</option>
                    <option value="todo">Todo el historial</option>
                    <option value="custom">Personalizado...</option>
                </select>
                <div id="analisis-custom-days-container" class="hidden items-center gap-1">
                    <input type="number" id="analisis-custom-days" min="1" class="w-12 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-white outline-none text-center hide-arrows" placeholder="Ej: 15">
                    <button id="btn-aplicar-custom-days" title="Aplicar Días" class="px-2 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded text-[10px] font-bold"><i data-lucide="check" class="w-3 h-3"></i></button>
                </div>
            </div>
        `;

        const selectRango = document.getElementById('analisis-rango-predefinido');
        const customContainer = document.getElementById('analisis-custom-days-container');
        const customInput = document.getElementById('analisis-custom-days');
        const btnAplicar = document.getElementById('btn-aplicar-custom-days');

        selectRango.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val === 'custom') {
                customContainer.classList.remove('hidden');
                customContainer.classList.add('flex');
                customInput.focus();
            } else {
                customContainer.classList.add('hidden');
                customContainer.classList.remove('flex');
                setAnalysisRange(val);
            }
        });

        btnAplicar.addEventListener('click', () => {
            const days = parseInt(customInput.value);
            if (!isNaN(days) && days > 0) {
                setAnalysisRange('custom', days);
            } else {
                if(window.mostrarToast) window.mostrarToast('Error', 'Ingresa un número válido de días', 'amber');
            }
        });
        
        customInput.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') btnAplicar.click();
        });
        
        if(window.lucide) window.lucide.createIcons();
    }

    document.getElementById('filterStartDate')?.addEventListener('change', updateAnalysisRange);
    document.getElementById('filterEndDate')?.addEventListener('change', updateAnalysisRange);
    document.getElementById('analisisLocalFilter')?.addEventListener('change', updateAnalysisRange);
    
    document.getElementById('btn-mes-prev')?.addEventListener('click', () => changeAnalysisMonth(-1));
    document.getElementById('btn-mes-next')?.addEventListener('click', () => changeAnalysisMonth(1));
    
    document.getElementById('card-bruto-dia')?.addEventListener('click', () => showBreakdown('BRUTO', window.currentSelectedDayObj));
    document.getElementById('card-ganancia-dia')?.addEventListener('click', () => showBreakdown('GANANCIA', window.currentSelectedDayObj));
    document.getElementById('btn-cerrar-modal-breakdown')?.addEventListener('click', closeBreakdownModal);

    document.getElementById('calendarGrid')?.addEventListener('click', e => {
        const d = e.target.closest('[data-action="select-day"]'); if(!d) return;
        selectDayAnalysis(d.dataset.fecha, d.dataset.info);
    });

    setAnalysisRange('mes'); 
}

export function setAnalysisRange(type, customDays = null) {
    const endStr = getTodayDateStr(); let startStr = endStr;
    if(type === 'semana') { const d = new Date(); d.setDate(d.getDate() - 6); startStr = d.toISOString().split('T')[0]; } 
    else if(type === 'mes') { const d = new Date(); d.setDate(d.getDate() - 29); startStr = d.toISOString().split('T')[0]; } 
    else if(type === 'todo') { startStr = '2023-01-01'; } // Fecha inicial desde donde comenzó el sistema
    else if(type === 'custom' && customDays) { const d = new Date(); d.setDate(d.getDate() - (customDays - 1)); startStr = d.toISOString().split('T')[0]; }
    
    document.getElementById('filterStartDate').value = startStr; 
    document.getElementById('filterEndDate').value = endStr; 
    updateAnalysisRange();
}

export async function updateAnalysisRange() {
    const start = document.getElementById('filterStartDate').value; const end = document.getElementById('filterEndDate').value; const localFiltro = document.getElementById('analisisLocalFilter')?.value || 'todas';
    if(!start || !end) return;
    try {
        const snapV = await getDocs(query(collection(db, "ventas"), where("fechaStr", ">=", start), where("fechaStr", "<=", end)));
        let ventas = []; snapV.forEach(d => { const v = d.data(); v.id = d.id; if(localFiltro === 'todas' || v.localId === localFiltro) ventas.push(v); }); analysisData = ventas;

        const snapG = await getDocs(query(collection(db, "gastos"), where("fechaStr", ">=", start), where("fechaStr", "<=", end)));
        let gastos = []; snapG.forEach(d => { const g = d.data(); g.id = d.id; if(localFiltro === 'todas' || g.localId === localFiltro || g.localId === 'ambas') { g.montoAplicado = (localFiltro !== 'todas' && g.localId === 'ambas') ? g.monto / 2 : g.monto; gastos.push(g); } }); analysisGastos = gastos;

        renderSummary(ventas, gastos); renderCalendar();
    } catch(e) { console.error(e); }
}

function renderSummary(ventas, gastos) {
    let ingresos = 0, costos = 0, cant = 0, totalGastos = 0;
    ventas.forEach(v => { ingresos += v.total || 0; costos += v.costoTotal || 0; cant += 1; }); gastos.forEach(g => { totalGastos += g.montoAplicado; });
    const ganancia = ingresos - costos - totalGastos;
    const sumEl = document.getElementById('analysisRangeSummary');
    if(sumEl) {
        sumEl.innerHTML = `<div class="bg-slate-900 rounded p-2 text-center border border-slate-700"><p class="text-[9px] text-slate-400 uppercase font-bold mb-0.5">Tickets</p><p class="text-sm font-black text-white">${cant}</p></div><div class="bg-slate-900 rounded p-2 text-center border border-slate-700"><p class="text-[9px] text-slate-400 uppercase font-bold mb-0.5">Ingreso Bruto</p><p class="text-sm font-black text-sky-400">${formatMoney(ingresos)}</p></div><div class="bg-slate-900 rounded p-2 text-center border border-slate-700"><p class="text-[9px] text-slate-400 uppercase font-bold mb-0.5">Gastos</p><p class="text-sm font-black text-red-400">${formatMoney(totalGastos)}</p></div><div class="bg-slate-900 rounded p-2 text-center border border-emerald-500/30"><p class="text-[9px] text-emerald-400 uppercase font-bold mb-0.5">Ganancia Neta</p><p class="text-sm font-black text-emerald-400">${formatMoney(ganancia)}</p></div>`;
    }
}

export function changeAnalysisMonth(delta) { currentDateAnalysis.setMonth(currentDateAnalysis.getMonth() + delta); renderCalendar(); }

function renderCalendar() {
    const year = currentDateAnalysis.getFullYear(); const month = currentDateAnalysis.getMonth();
    document.getElementById('calendarMonthLabel').textContent = new Date(year, month, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }).toUpperCase();
    const firstDayIndex = new Date(year, month, 1).getDay(); const daysInMonth = new Date(year, month + 1, 0).getDate();
    const datosPorDia = {};
    analysisData.forEach(v => { if(!datosPorDia[v.fechaStr]) datosPorDia[v.fechaStr] = { ingresos: 0, ganancia: 0, ventas: [], gastos: [] }; datosPorDia[v.fechaStr].ingresos += (v.total || 0); datosPorDia[v.fechaStr].ganancia += ((v.total || 0) - (v.costoTotal || 0)); datosPorDia[v.fechaStr].ventas.push(v); });
    analysisGastos.forEach(g => { if(!datosPorDia[g.fechaStr]) datosPorDia[g.fechaStr] = { ingresos: 0, ganancia: 0, ventas: [], gastos: [] }; datosPorDia[g.fechaStr].ganancia -= g.montoAplicado; datosPorDia[g.fechaStr].gastos.push(g); });

    const grid = document.getElementById('calendarGrid'); let html = '';
    for(let i = 0; i < firstDayIndex; i++) html += `<div class="p-1 md:p-2 opacity-0"></div>`;
    for(let i = 1; i <= daysInMonth; i++) {
        const currentStr = `${year}-${String(month+1).padStart(2, '0')}-${String(i).padStart(2, '0')}`; const dataDia = datosPorDia[currentStr];
        let indicator = dataDia && (dataDia.ventas.length > 0) ? `<div class="absolute bottom-1 left-1/2 transform -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-emerald-500"></div>` : '';
        const isTodayClass = currentStr === getTodayDateStr() ? 'border-sky-500 bg-sky-900/20' : 'border-slate-700 bg-slate-800 hover:bg-slate-700';
        const dataSafe = dataDia ? encodeURIComponent(JSON.stringify(dataDia)) : 'null';
        
        html += `<div data-action="select-day" data-fecha="${currentStr}" data-info="${dataSafe}" class="calendar-day relative flex flex-col items-center justify-center p-1 md:p-2 rounded border ${isTodayClass} cursor-pointer transition-colors h-8 md:h-12"><span class="text-[10px] md:text-xs font-bold ${currentStr === getTodayDateStr() ? 'text-sky-400' : 'text-slate-300'}">${i}</span>${indicator}</div>`;
    }
    grid.innerHTML = html;
}

function selectDayAnalysis(fechaStr, dataSafeObj) {
    document.getElementById('selectedDateLabel').textContent = fechaStr;
    const dataDiaObj = dataSafeObj !== 'null' ? JSON.parse(decodeURIComponent(dataSafeObj)) : null; window.currentSelectedDayObj = dataDiaObj;
    const listEl = document.getElementById('selectedDayTransactions');
    if(!dataDiaObj) { document.getElementById('selectedDayIngresos').textContent = 'S/ 0.00'; document.getElementById('selectedDayGanancias').textContent = 'S/ 0.00'; listEl.innerHTML = '<div class="h-full flex items-center justify-center text-slate-500 text-xs">Sin operaciones.</div>'; return; }
    
    document.getElementById('selectedDayIngresos').textContent = formatMoney(dataDiaObj.ingresos); document.getElementById('selectedDayGanancias').textContent = formatMoney(dataDiaObj.ganancia);
    let lHtml = ''; dataDiaObj.ventas.sort((a, b) => (b.fecha?.seconds || 0) - (a.fecha?.seconds || 0));
    
    dataDiaObj.ventas.forEach(v => {
        const t = v.fecha ? new Date(v.fecha.seconds*1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : ''; const safeId = (v.id && v.id.includes('-')) ? v.id.split('-')[1] : (v.id || 'N/A');
        let itemsHtml = `<div class="mt-2 pt-2 border-t border-slate-700/50 hidden space-y-1.5" id="det-${v.id}">`;
        if (v.items) v.items.forEach(i => { itemsHtml += `<div class="flex justify-between items-start"><p class="text-[10px] text-slate-300 flex-1 pr-2"><span class="text-sky-400 font-bold">${i.cantidad}x</span> ${i.nombre}</p><p class="text-[10px] text-emerald-400 font-bold">${formatMoney(i.precio * i.cantidad)}</p></div>`; });
        itemsHtml += `</div>`;
        lHtml += `<div class="bg-slate-900 p-2.5 rounded-lg border border-slate-700 flex flex-col cursor-pointer hover:border-sky-500 group" onclick="document.getElementById('det-${v.id}').classList.toggle('hidden')"><div class="flex justify-between items-center"><div><p class="text-xs font-bold text-white">#${safeId} <span class="text-[9px] text-slate-400 font-normal ml-1">${t}</span></p><p class="text-[9px] text-slate-400">${v.items ? v.items.length : 0} prod.</p></div><div class="text-right flex flex-col items-end"><p class="text-sm font-black text-emerald-400">${formatMoney(v.total)}</p></div></div>${itemsHtml}</div>`;
    });
    if(dataDiaObj.gastos) dataDiaObj.gastos.forEach(g => { lHtml += `<div class="bg-red-500/10 p-2.5 rounded-lg border border-red-500/30 flex justify-between items-center"><div class="flex items-center gap-2"><i data-lucide="trending-down" class="w-4 h-4 text-red-400"></i><div><p class="text-xs font-bold text-red-400">Gasto</p><p class="text-[9px] text-red-300/70">${g.descripcion}</p></div></div><p class="text-sm font-black text-red-400">- ${formatMoney(g.montoAplicado)}</p></div>`; });
    listEl.innerHTML = lHtml; if(window.lucide) window.lucide.createIcons();
}

export function showBreakdown() {} export function closeBreakdownModal() {}
