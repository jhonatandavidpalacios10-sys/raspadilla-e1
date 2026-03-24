import { db, collection, query, where, getDocs } from '../core/firebase-setup.js';
import { formatMoney, getTodayDateStr } from '../utils/helpers.js';

let analysisData = []; let analysisGastos = []; let currentDateAnalysis = new Date(); window.currentSelectedDayObj = null;

export function initAnalisis() {
    window.updateAnalysisRange = updateAnalysisRange; window.setAnalysisRange = setAnalysisRange; window.changeAnalysisMonth = changeAnalysisMonth; window.showBreakdown = showBreakdown; window.closeBreakdownModal = closeBreakdownModal;
    setAnalysisRange('mes'); 
}

export function setAnalysisRange(type) {
    const endStr = getTodayDateStr(); let startStr = endStr;
    if(type === 'semana') { const d = new Date(); d.setDate(d.getDate() - 6); startStr = d.toISOString().split('T')[0]; } 
    else if(type === 'mes') { const d = new Date(); d.setDate(d.getDate() - 29); startStr = d.toISOString().split('T')[0]; } 
    document.getElementById('filterStartDate').value = startStr; document.getElementById('filterEndDate').value = endStr; updateAnalysisRange();
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
        
        // Ajuste CSS Móvil: padding p-1 en lugar de p-2. Altura h-8 en lugar de h-10. Texto text-[10px] en lugar de text-xs
        html += `<div data-action="select-day" data-fecha="${currentStr}" data-info="${dataSafe}" class="calendar-day relative flex flex-col items-center justify-center p-1 md:p-2 rounded border ${isTodayClass} cursor-pointer transition-colors h-8 md:h-12"><span class="text-[10px] md:text-xs font-bold ${currentStr === getTodayDateStr() ? 'text-sky-400' : 'text-slate-300'}">${i}</span>${indicator}</div>`;
    }
    grid.innerHTML = html;
}

export function showBreakdown() {} export function closeBreakdownModal() {}
