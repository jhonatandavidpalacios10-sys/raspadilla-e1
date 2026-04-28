import { db, collection, query, where, getDocs } from '../core/firebase-setup.js';
import { formatMoney, getTodayDateStr } from '../utils/helpers.js';
import { state } from '../core/store.js'; // Añadido para acceder a userRole

let analysisData = []; let analysisGastos = []; let currentDateAnalysis = new Date(); window.currentSelectedDayObj = null;

export function initAnalisis() {
    window.updateAnalysisRange = updateAnalysisRange; 
    window.setAnalysisRange = setAnalysisRange; 
    window.changeAnalysisMonth = changeAnalysisMonth; 
    window.showBreakdown = showBreakdown; 
    window.closeBreakdownModal = closeBreakdownModal;
    
    const d = new Date(); document.getElementById('filterStartDate').value = d.toISOString().split('T')[0]; document.getElementById('filterEndDate').value = d.toISOString().split('T')[0];
    
    // Inyectar Local
    const sel = document.getElementById('analisisLocalFilter');
    if(sel && state.locales) {
        let op = '<option value="todas">Todas las Sedes</option>';
        state.locales.forEach(l => op += `<option value="${l.id}">${l.nombre}</option>`);
        sel.innerHTML = op;
    }

    updateAnalysisRange(); renderCalendar();
}

async function updateAnalysisRange() {
    const fS = document.getElementById('filterStartDate').value; const fE = document.getElementById('filterEndDate').value;
    const lF = document.getElementById('analisisLocalFilter')?.value || 'todas';
    if (!fS || !fE) return;

    try {
        const qV = query(collection(db, "ventas"), where("fechaStr", ">=", fS), where("fechaStr", "<=", fE));
        const qG = query(collection(db, "gastos"), where("fechaStr", ">=", fS), where("fechaStr", "<=", fE));
        
        const [sV, sG] = await Promise.all([getDocs(qV), getDocs(qG)]);
        
        analysisData = []; analysisGastos = [];
        
        sV.forEach(d => { 
            const v = d.data(); 
            // Filtro local JS
            if (lF !== 'todas' && v.localId !== lF) return;
            if (v.estado !== 'rechazado') analysisData.push({ id: d.id, ...v }); 
        });
        
        sG.forEach(d => { 
            const g = d.data(); 
            if (lF !== 'todas' && g.localId !== lF && g.localId !== '') return;
            analysisGastos.push({ id: d.id, ...g }); 
        });

        let ing = 0, cost = 0, efe = 0, yap = 0, gas = 0;
        analysisData.forEach(v => { ing += parseFloat(v.total||0); cost += parseFloat(v.costo_total || v.costoTotal || 0); efe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); yap += parseFloat(v.pago_yape || v.pagoYape || 0); });
        analysisGastos.forEach(g => { gas += parseFloat(g.monto||0); });

        const cSum = document.getElementById('analysisRangeSummary');
        if(cSum) {
            cSum.innerHTML = `<div class="bg-slate-900 rounded p-1.5 md:p-2 border border-slate-700 text-center"><p class="text-[9px] md:text-[10px] text-slate-400 uppercase">Ingresos</p><p class="text-xs md:text-sm font-bold text-sky-400">${formatMoney(ing)}</p></div><div class="bg-slate-900 rounded p-1.5 md:p-2 border border-slate-700 text-center"><p class="text-[9px] md:text-[10px] text-slate-400 uppercase">Gastos</p><p class="text-xs md:text-sm font-bold text-red-400">${formatMoney(gas)}</p></div><div class="bg-slate-900 rounded p-1.5 md:p-2 border border-emerald-500/30 text-center"><p class="text-[9px] md:text-[10px] text-slate-400 uppercase">Neta</p><p class="text-xs md:text-sm font-black text-emerald-400">${formatMoney(ing - gas)}</p></div><div class="bg-slate-900 rounded p-1.5 md:p-2 border border-slate-700 text-center"><p class="text-[9px] md:text-[10px] text-slate-400 uppercase">Efec/Yape</p><p class="text-[9px] md:text-xs font-bold text-white">${formatMoney(efe)} / ${formatMoney(yap)}</p></div>`;
        }
        renderCalendar();
    } catch(e) { console.error(e); }
}

function setAnalysisRange(tipo) {
    const d = new Date(); let fS = new Date(d); let fE = new Date(d);
    if(tipo === 'semana') fS.setDate(d.getDate() - 6);
    if(tipo === 'mes') fS.setDate(d.getDate() - 29);
    document.getElementById('filterStartDate').value = fS.toISOString().split('T')[0];
    document.getElementById('filterEndDate').value = fE.toISOString().split('T')[0];
    updateAnalysisRange();
}

function changeAnalysisMonth(delta) {
    // CORRECCIÓN BUG CALENDARIO: Evitamos que salte de mes fijando el día a 1 primero
    currentDateAnalysis.setDate(1); 
    currentDateAnalysis.setMonth(currentDateAnalysis.getMonth() + delta);
    renderCalendar();
}

function renderCalendar() {
    const y = currentDateAnalysis.getFullYear(); const m = currentDateAnalysis.getMonth();
    const lbl = document.getElementById('calendarMonthLabel'); if(lbl) lbl.textContent = currentDateAnalysis.toLocaleDateString('es-ES', {month:'long', year:'numeric'}).replace(/^\w/, c => c.toUpperCase());
    const grid = document.getElementById('calendarGrid'); if(!grid) return;
    grid.innerHTML = '';
    
    const fDay = new Date(y, m, 1).getDay(); const daysInM = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < fDay; i++) grid.innerHTML += `<div class="p-1 md:p-2"></div>`;
    
    const lF = document.getElementById('analisisLocalFilter')?.value || 'todas';

    for (let d = 1; d <= daysInM; d++) {
        const dStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const vDay = analysisData.filter(v => v.fechaStr === dStr);
        const gDay = analysisGastos.filter(g => g.fechaStr === dStr);
        
        let tIng = 0, tEfe = 0, tYap = 0, tGas = 0;
        vDay.forEach(v => { tIng += parseFloat(v.total||0); tEfe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); tYap += parseFloat(v.pago_yape || v.pagoYape || 0); });
        gDay.forEach(g => { tGas += parseFloat(g.monto||0); });

        const isToday = dStr === getTodayDateStr(); const hasData = tIng > 0 || tGas > 0;
        const colorClass = hasData ? (tIng - tGas >= 0 ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-red-500/50 bg-red-500/10') : 'border-slate-700 bg-slate-800';
        const ring = isToday ? 'ring-2 ring-sky-500' : '';

        const div = document.createElement('div');
        div.className = `p-1 md:p-2 border rounded-lg md:rounded-xl cursor-pointer hover:border-sky-400 transition-colors flex flex-col justify-between min-h-[50px] md:min-h-[70px] relative overflow-hidden ${colorClass} ${ring}`;
        div.innerHTML = `<span class="text-[10px] md:text-xs font-bold text-white mb-1 absolute top-1 md:top-2 left-1 md:left-2">${d}</span><div class="mt-auto text-right w-full">${hasData ? `<p class="text-[9px] md:text-[11px] font-black ${tIng - tGas >= 0 ? 'text-emerald-400' : 'text-red-400'}">${formatMoney(tIng - tGas)}</p>` : ''}</div>`;
        
        div.onclick = () => showDayDetails(dStr, vDay, gDay, tIng, tEfe, tYap, tGas);
        grid.appendChild(div);
    }
}

function showDayDetails(dStr, ventas, gastos, tIng, tEfe, tYap, tGas) {
    window.currentSelectedDayObj = { dStr, ventas, gastos, tIng, tEfe, tYap, tGas };
    document.getElementById('selectedDateLabel').textContent = dStr;
    document.getElementById('selectedDayIngresos').textContent = formatMoney(tIng);
    document.getElementById('selectedDayGanancias').textContent = formatMoney(tIng - tGas);
    
    const list = document.getElementById('selectedDayTransactions'); if(!list) return;
    list.innerHTML = '';
    
    if (ventas.length === 0 && gastos.length === 0) { list.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">Sin registros este día.</p>'; return; }
    
    let lHtml = '';
    ventas.forEach(v => {
        const time = v.timestamp ? new Date(v.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--';
        const num = v.id.split('-')[1] || '--';
        let iHtml = `<div id="det-${v.id}" class="hidden mt-2 pt-2 border-t border-slate-700 space-y-1">`;
        v.items?.forEach(i => { iHtml += `<div class="flex justify-between text-xs"><p class="text-slate-300 pr-2"><span class="text-sky-400 font-bold">${i.cantidad}x</span> ${i.nombre}</p><p class="text-[10px] text-emerald-400 font-bold">${formatMoney(i.precio * i.cantidad)}</p></div>`; });
        iHtml += `</div>`;
        lHtml += `<div class="bg-slate-900 p-2.5 rounded-lg border border-slate-700 flex flex-col cursor-pointer hover:border-sky-500 group" onclick="document.getElementById('det-${v.id}').classList.toggle('hidden')"><div class="flex justify-between items-center"><div><p class="text-xs font-bold text-white">#${num} <span class="text-[9px] text-slate-400 font-normal ml-1">${time}</span></p><p class="text-[9px] text-slate-400">${v.items ? v.items.length : 0} prod.</p></div><div class="text-right flex flex-col items-end"><p class="text-sm font-black text-emerald-400">${formatMoney(v.total)}</p></div></div>${iHtml}</div>`;
    });
    gastos.forEach(g => { lHtml += `<div class="bg-red-500/10 p-2.5 rounded-lg border border-red-500/30 flex justify-between items-center"><div class="flex items-center gap-2"><i data-lucide="trending-down" class="w-4 h-4 text-red-400"></i><div><p class="text-xs font-bold text-red-400">Gasto</p><p class="text-[9px] text-slate-400">${g.descripcion}</p></div></div><p class="text-sm font-black text-red-400">-${formatMoney(g.monto)}</p></div>`; });
    
    list.innerHTML = lHtml; if(window.lucide) window.lucide.createIcons();
}

function showBreakdown(type, dayObj) {
    if(!dayObj) return; const m = document.getElementById('breakdownModal'); if(!m) return;
    const lF = document.getElementById('analisisLocalFilter')?.value || 'todas';
    const cL = document.getElementById('brkCategoriesList'); cL.innerHTML = '';
    
    if (type === 'BRUTO') {
        document.getElementById('brkTitle').innerHTML = `<i data-lucide="bar-chart" class="w-5 h-5 inline text-sky-400 mr-2"></i>Ventas Brutas`;
        document.getElementById('brkEfectivo').textContent = formatMoney(dayObj.tEfe); document.getElementById('brkYape').textContent = formatMoney(dayObj.tYap);
        
        let catTotals = { 'vaso': 0, 'extra': 0, 'ajuste': 0 };
        dayObj.ventas.forEach(v => { v.items?.forEach(i => { if(catTotals[i.categoria] !== undefined) catTotals[i.categoria] += (i.precio * i.cantidad); }); });
        
        cL.innerHTML = `
            <div class="flex justify-between text-xs"><span class="text-slate-400">Vasos y Helados</span><span class="text-white font-bold">${formatMoney(catTotals.vaso)}</span></div>
            <div class="flex justify-between text-xs"><span class="text-slate-400">Extras</span><span class="text-white font-bold">${formatMoney(catTotals.extra)}</span></div>
            <div class="flex justify-between text-xs"><span class="text-slate-400">Cargos/Descuentos</span><span class="${catTotals.ajuste < 0 ? 'text-red-400' : 'text-emerald-400'} font-bold">${formatMoney(catTotals.ajuste)}</span></div>
        `;
        document.getElementById('brkCategories').classList.remove('hidden');
    } else {
        document.getElementById('brkTitle').innerHTML = `<i data-lucide="pie-chart" class="w-5 h-5 inline text-emerald-400 mr-2"></i>Ganancia Neta`;
        document.getElementById('brkEfectivo').textContent = 'Ingresos Totales'; document.getElementById('brkYape').textContent = formatMoney(dayObj.tIng);
        cL.innerHTML = `
            <div class="flex justify-between text-xs"><span class="text-slate-400">(-) Gastos y Retiros</span><span class="text-red-400 font-bold">-${formatMoney(dayObj.tGas)}</span></div>
            <div class="flex justify-between text-sm mt-2 pt-2 border-t border-slate-700"><span class="text-white font-bold">Neta Restante</span><span class="text-emerald-400 font-black">${formatMoney(dayObj.tIng - dayObj.tGas)}</span></div>
        `;
        document.getElementById('brkCategories').classList.remove('hidden');
    }
    
    m.classList.remove('hidden'); setTimeout(() => m.classList.remove('opacity-0'), 10); if(window.lucide) window.lucide.createIcons();
}

function closeBreakdownModal() { const m = document.getElementById('breakdownModal'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300); }
