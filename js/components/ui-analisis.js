import { db, collection, query, where, getDocs } from '../core/firebase-setup.js';
import { formatMoney, getTodayDateStr } from '../utils/helpers.js';
import { state } from '../core/store.js';

let analysisData = []; 
let analysisGastos = []; 
let currentDateAnalysis = new Date(); 
window.currentSelectedDayObj = null;

export function initAnalisis() {
    window.updateAnalysisRange = updateAnalysisRange; 
    window.setAnalysisRange = setAnalysisRange; 
    window.changeAnalysisMonth = changeAnalysisMonth; 
    window.showBreakdown = showBreakdown; 
    window.closeBreakdownModal = closeBreakdownModal;
    
    // Configurar fechas por defecto (Hoy)
    const d = new Date(); 
    document.getElementById('filterStartDate').value = d.toISOString().split('T')[0]; 
    document.getElementById('filterEndDate').value = d.toISOString().split('T')[0];
    
    // Inyectar opciones de filtro de Locales (Solo Admin/Master)
    const sel = document.getElementById('analisisLocalFilter');
    if(sel && state.locales) {
        if (state.userRole === 'admin' || state.userRole === 'master') {
            let op = '<option value="todas">Todas las Sedes</option>';
            state.locales.forEach(l => op += `<option value="${l.id}">${l.nombre}</option>`);
            sel.innerHTML = op;
            sel.classList.remove('hidden');
        } else {
            // Vendedores no ven el filtro, se auto-aplica su local
            sel.innerHTML = `<option value="${state.userLocalId}">${state.userLocal}</option>`;
            sel.classList.add('hidden');
        }
    }

    // Eventos
    document.getElementById('filterStartDate')?.addEventListener('change', updateAnalysisRange);
    document.getElementById('filterEndDate')?.addEventListener('change', updateAnalysisRange);
    document.getElementById('analisisLocalFilter')?.addEventListener('change', updateAnalysisRange);

    updateAnalysisRange(); 
}

async function updateAnalysisRange() {
    const fS = document.getElementById('filterStartDate').value; 
    const fE = document.getElementById('filterEndDate').value;
    
    // El filtro aplica el valor seleccionado para admins, o el local del vendedor
    let lF = document.getElementById('analisisLocalFilter')?.value || 'todas';
    if (state.userRole === 'vendedor') {
        lF = state.userLocalId || '';
    }

    if (!fS || !fE) return;

    // Mostrar loader temporal
    const cSum = document.getElementById('analysisRangeSummary');
    if(cSum) cSum.innerHTML = '<div class="col-span-4 text-center py-2"><i data-lucide="loader-2" class="w-5 h-5 animate-spin mx-auto text-sky-500"></i></div>';
    if(window.lucide) window.lucide.createIcons();

    try {
        const qV = query(collection(db, "ventas"), where("fechaStr", ">=", fS), where("fechaStr", "<=", fE));
        const qG = query(collection(db, "gastos"), where("fechaStr", ">=", fS), where("fechaStr", "<=", fE));
        
        const [sV, sG] = await Promise.all([getDocs(qV), getDocs(qG)]);
        
        analysisData = []; 
        analysisGastos = [];
        
        // Procesar ventas (Ignoramos las rechazadas/anuladas)
        sV.forEach(d => { 
            const v = d.data(); 
            // Filtro local JS
            if (lF !== 'todas' && v.localId !== lF) return; 
            if (v.estado !== 'rechazado') analysisData.push({ id: d.id, ...v }); 
        });
        
        // Procesar gastos
        sG.forEach(d => { 
            const g = d.data(); 
            if (lF !== 'todas' && g.localId !== lF && g.localId !== '') return;
            analysisGastos.push({ id: d.id, ...g }); 
        });

        // Totales globales
        let ing = 0, cost = 0, efe = 0, yap = 0, gas = 0;
        analysisData.forEach(v => { 
            ing += parseFloat(v.total||0); 
            cost += parseFloat(v.costo_total || v.costoTotal || 0); 
            efe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); 
            yap += parseFloat(v.pago_yape || v.pagoYape || 0); 
        });
        
        analysisGastos.forEach(g => { gas += parseFloat(g.monto||0); });

        // Actualizar UI de Tarjetas Superiores
        if(cSum) {
            cSum.innerHTML = `
                <div class="bg-slate-900 rounded-xl p-3 md:p-4 border border-slate-700 text-center cursor-pointer hover:border-sky-500 transition-colors" onclick="window.showBreakdown('BRUTO', null, ${ing}, ${efe}, ${yap})">
                    <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                        <i data-lucide="trending-up" class="w-3.5 h-3.5 text-sky-400"></i>
                        <p class="text-[10px] md:text-[11px] text-slate-400 uppercase font-bold tracking-wider">Ingresos Brutos</p>
                    </div>
                    <p class="text-sm md:text-xl font-black text-white" id="tot-ingresos">${formatMoney(ing)}</p>
                </div>
                <div class="bg-slate-900 rounded-xl p-3 md:p-4 border border-slate-700 text-center cursor-pointer hover:border-emerald-500 transition-colors" onclick="window.showBreakdown('GANANCIA', null, ${ing}, ${efe}, ${yap}, ${gas})">
                    <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                        <i data-lucide="pie-chart" class="w-3.5 h-3.5 text-emerald-400"></i>
                        <p class="text-[10px] md:text-[11px] text-slate-400 uppercase font-bold tracking-wider">Ganancia Neta</p>
                    </div>
                    <p class="text-sm md:text-xl font-black text-emerald-400" id="tot-neta">${formatMoney(ing - gas)}</p>
                </div>
                <div class="bg-slate-900 rounded-xl p-3 md:p-4 border border-slate-700 text-center">
                    <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                        <i data-lucide="trending-down" class="w-3.5 h-3.5 text-red-400"></i>
                        <p class="text-[10px] md:text-[11px] text-slate-400 uppercase font-bold tracking-wider">Gastos</p>
                    </div>
                    <p class="text-sm md:text-xl font-bold text-red-400" id="tot-gastos">${formatMoney(gas)}</p>
                </div>
                <div class="bg-slate-900 rounded-xl p-3 md:p-4 border border-slate-700 text-center">
                    <div class="flex items-center justify-center gap-1.5 mb-1 opacity-80">
                        <i data-lucide="credit-card" class="w-3.5 h-3.5 text-purple-400"></i>
                        <p class="text-[10px] md:text-[11px] text-slate-400 uppercase font-bold tracking-wider">Transacciones</p>
                    </div>
                    <p class="text-sm md:text-xl font-bold text-white">${analysisData.length}</p>
                </div>
            `;
        }
        
        if(window.lucide) window.lucide.createIcons();
        renderCalendar();

    } catch(e) { 
        console.error(e); 
        if(cSum) cSum.innerHTML = '<p class="col-span-4 text-center text-red-400 text-xs">Error cargando análisis.</p>';
    }
}

function setAnalysisRange(tipo) {
    const d = new Date(); 
    let fS = new Date(d); 
    let fE = new Date(d);
    
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
    const y = currentDateAnalysis.getFullYear(); 
    const m = currentDateAnalysis.getMonth();
    const lbl = document.getElementById('calendarMonthLabel'); 
    
    if(lbl) {
        // Formato: "Mes Año" (Ej. Abril 2026)
        lbl.textContent = currentDateAnalysis.toLocaleDateString('es-ES', {month:'long', year:'numeric'}).replace(/^\w/, c => c.toUpperCase());
    }
    
    const grid = document.getElementById('calendarGrid'); 
    if(!grid) return;
    grid.innerHTML = '';
    
    const fDay = new Date(y, m, 1).getDay(); 
    const daysInM = new Date(y, m + 1, 0).getDate();
    
    // Espacios vacíos antes del primer día del mes
    for (let i = 0; i < fDay; i++) grid.innerHTML += `<div class="p-1 md:p-2 bg-slate-900/30 rounded-lg md:rounded-xl border border-transparent"></div>`;
    
    for (let d = 1; d <= daysInM; d++) {
        const dStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        
        // Ventas y Gastos de ese día específico
        const vDay = analysisData.filter(v => v.fechaStr === dStr);
        const gDay = analysisGastos.filter(g => g.fechaStr === dStr);
        
        let tIng = 0, tEfe = 0, tYap = 0, tGas = 0;
        vDay.forEach(v => { 
            tIng += parseFloat(v.total||0); 
            tEfe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0); 
            tYap += parseFloat(v.pago_yape || v.pagoYape || 0); 
        });
        gDay.forEach(g => { tGas += parseFloat(g.monto||0); });

        const isToday = dStr === getTodayDateStr(); 
        const hasData = tIng > 0 || tGas > 0;
        const neto = tIng - tGas;
        
        const colorClass = hasData ? (neto >= 0 ? 'border-slate-700 bg-slate-800' : 'border-red-500/30 bg-slate-800') : 'border-transparent bg-slate-900/50';
        const ring = isToday ? 'ring-2 ring-sky-500' : '';
        const textColor = neto >= 0 ? 'text-emerald-400' : 'text-red-400';

        const div = document.createElement('div');
        div.className = `p-2 md:p-3 border rounded-lg md:rounded-xl cursor-pointer hover:border-sky-500 transition-colors flex flex-col justify-between min-h-[60px] md:min-h-[85px] relative overflow-hidden ${colorClass} ${ring} group`;
        
        let pointIndicators = '';
        if (hasData) {
            if (tIng > 0) pointIndicators += `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>`;
            if (tGas > 0) pointIndicators += `<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>`;
        }

        div.innerHTML = `
            <span class="text-xs md:text-sm font-bold ${isToday ? 'text-sky-400' : 'text-slate-300'} mb-1">${d}</span>
            <div class="mt-auto text-right w-full flex flex-col items-end gap-1">
                ${hasData ? `<p class="text-[10px] md:text-xs font-black ${textColor} group-hover:scale-110 origin-right transition-transform">${formatMoney(neto)}</p>` : ''}
                <div class="flex gap-0.5 justify-end">${pointIndicators}</div>
            </div>
        `;
        
        div.onclick = () => showDayDetails(dStr, vDay, gDay, tIng, tEfe, tYap, tGas);
        grid.appendChild(div);
    }
}

function showDayDetails(dStr, ventas, gastos, tIng, tEfe, tYap, tGas) {
    window.currentSelectedDayObj = { dStr, ventas, gastos, tIng, tEfe, tYap, tGas };
    
    // Formatear la fecha para que se vea legible
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
        list.innerHTML = '<div class="text-center py-8"><i data-lucide="calendar-x" class="w-12 h-12 mx-auto text-slate-600 mb-2 opacity-50"></i><p class="text-xs text-slate-500">No hay movimientos registrados este día.</p></div>'; 
        if(window.lucide) window.lucide.createIcons();
        return; 
    }
    
    let lHtml = '';
    
    // Renderizar Ventas del Día
    ventas.forEach(v => {
        const time = v.timestamp ? new Date(v.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--';
        const num = v.id.split('-')[1] || '--';
        const cantItems = v.items ? v.items.reduce((s,i) => s + i.cantidad, 0) : 0;
        const localInfo = v.localNombre ? ` • <span class="text-[9px] uppercase tracking-wider">${v.localNombre}</span>` : '';
        const metodoPago = String(v.metodo_pago || v.metodoFinal || 'Efectivo').toUpperCase();
        
        let iHtml = `<div id="det-${v.id}" class="hidden mt-3 pt-3 border-t border-slate-700/50 space-y-1.5">`;
        v.items?.forEach(i => { 
            iHtml += `<div class="flex justify-between text-xs items-center"><p class="text-slate-300 pr-2 leading-tight"><span class="text-sky-400 font-bold">${i.cantidad}x</span> ${i.nombre}</p><p class="text-[10px] text-emerald-400 font-bold">${formatMoney(i.precio * i.cantidad)}</p></div>`; 
        });
        iHtml += `</div>`;
        
        lHtml += `
            <div class="bg-slate-900/80 p-3.5 rounded-xl border border-slate-700 flex flex-col cursor-pointer hover:border-emerald-500/50 transition-colors group mb-2" onclick="document.getElementById('det-${v.id}').classList.toggle('hidden')">
                <div class="flex justify-between items-center">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0"><i data-lucide="shopping-cart" class="w-4 h-4"></i></div>
                        <div>
                            <p class="text-xs font-bold text-white">Venta POS <span class="text-[9px] text-slate-500 font-normal ml-1">#${num}</span></p>
                            <p class="text-[10px] text-slate-400">${cantItems} item(s) ${localInfo}</p>
                        </div>
                    </div>
                    <div class="text-right flex flex-col items-end">
                        <p class="text-sm font-black text-emerald-400">+ ${formatMoney(v.total)}</p>
                        <p class="text-[9px] text-slate-500 font-bold mt-0.5">${time} • ${metodoPago}</p>
                    </div>
                </div>
                ${iHtml}
            </div>`;
    });
    
    // Renderizar Gastos del Día
    gastos.forEach(g => { 
        const time = g.timestamp ? new Date(g.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--';
        const localInfo = g.localNombre && g.localNombre !== 'Global' ? ` • <span class="text-[9px] uppercase tracking-wider">${g.localNombre}</span>` : '';
        
        lHtml += `
            <div class="bg-red-500/10 p-3.5 rounded-xl border border-red-500/20 flex justify-between items-center mb-2">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-red-400 shrink-0"><i data-lucide="trending-down" class="w-4 h-4"></i></div>
                    <div>
                        <p class="text-xs font-bold text-red-400">Gasto</p>
                        <p class="text-[10px] text-slate-400">${g.descripcion} ${localInfo}</p>
                    </div>
                </div>
                <div class="text-right">
                    <p class="text-sm font-black text-red-400">- ${formatMoney(g.monto)}</p>
                    <p class="text-[9px] text-red-400/50 font-bold mt-0.5">${time}</p>
                </div>
            </div>`; 
    });
    
    list.innerHTML = lHtml; 
    if(window.lucide) window.lucide.createIcons();
}

/**
 * Desglose detallado de Finanzas (Como en la imagen de referencia)
 * @param {string} type - 'BRUTO' o 'GANANCIA'
 * @param {object} dayObj - Objeto del día (si se clicó en el detalle del día)
 * @param {number} gIng - Total global de Ingresos del rango seleccionado (opcional)
 * @param {number} gEfe - Total global de Efectivo del rango seleccionado (opcional)
 * @param {number} gYap - Total global de Yape del rango seleccionado (opcional)
 * @param {number} gGas - Total global de Gastos del rango seleccionado (opcional)
 */
function showBreakdown(type, dayObj, gIng = null, gEfe = null, gYap = null, gGas = null) {
    const m = document.getElementById('breakdownModal'); 
    if(!m) return;
    
    const cL = document.getElementById('brkCategoriesList'); 
    cL.innerHTML = '';
    
    // Determinar de dónde sacamos los datos (Del rango global o de un día específico)
    let dVentas = dayObj ? dayObj.ventas : analysisData;
    let tIng = dayObj ? dayObj.tIng : gIng;
    let tEfe = dayObj ? dayObj.tEfe : gEfe;
    let tYap = dayObj ? dayObj.tYap : gYap;
    let tGas = dayObj ? dayObj.tGas : gGas;
    
    const fechaText = dayObj ? dayObj.dStr : `${document.getElementById('filterStartDate').value} a ${document.getElementById('filterEndDate').value}`;
    
    if (type === 'BRUTO') {
        document.getElementById('brkTitle').innerHTML = `
            <div class="flex flex-col">
                <span class="text-lg font-bold text-white">Desglose de Ingresos (Bruto)</span>
                <span class="text-[10px] text-slate-400 font-normal">${fechaText}</span>
            </div>
        `;
        
        // Bloques Superiores: Efectivo, Yape, Tarjeta
        document.getElementById('brkEfectivo').textContent = formatMoney(tEfe); 
        document.getElementById('brkYape').textContent = formatMoney(tYap);
        
        // Cálculos por categoría (Desglose Inferior)
        let catTotals = {};
        
        dVentas.forEach(v => { 
            v.items?.forEach(i => { 
                const catStr = String(i.categoria || 'otros').toLowerCase();
                if(catTotals[catStr] === undefined) catTotals[catStr] = 0;
                catTotals[catStr] += (i.precio * i.cantidad); 
            }); 
        });
        
        let htmlCats = `<p class="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Desglose por Categorías</p>`;
        
        // Mapeamos íconos para cada categoría estándar
        for (const [catName, totalCat] of Object.entries(catTotals)) {
            let icon = 'tag';
            let color = 'slate';
            if (catName === 'vaso') { icon = 'cup-soda'; color = 'sky'; }
            if (catName === 'extra') { icon = 'plus-circle'; color = 'amber'; }
            if (catName === 'ajuste') { icon = 'receipt'; color = 'purple'; }
            
            htmlCats += `
                <div class="flex justify-between items-center bg-slate-900/50 p-2.5 rounded-lg border border-slate-700/50 mb-1.5 group hover:border-${color}-500/50 transition-colors">
                    <div class="flex items-center gap-2">
                        <i data-lucide="${icon}" class="w-3.5 h-3.5 text-${color}-400 opacity-70"></i>
                        <span class="text-xs text-slate-300 capitalize">${catName}</span>
                    </div>
                    <span class="text-sm text-emerald-400 font-bold">${formatMoney(totalCat)}</span>
                </div>
            `;
        }
        
        cL.innerHTML = htmlCats;
        document.getElementById('brkCategories').classList.remove('hidden');
        
    } else {
        document.getElementById('brkTitle').innerHTML = `
            <div class="flex flex-col">
                <span class="text-lg font-bold text-white">Análisis de Ganancia</span>
                <span class="text-[10px] text-slate-400 font-normal">${fechaText}</span>
            </div>
        `;
        
        // Usamos los espacios superiores para el resumen de ingreso vs egreso
        document.getElementById('brkEfectivo').parentElement.querySelector('span:first-child').textContent = 'Total Ingresado';
        document.getElementById('brkEfectivo').textContent = formatMoney(tIng); 
        
        document.getElementById('brkYape').parentElement.querySelector('span:first-child').innerHTML = '<span class="text-red-400">Total Gastos/Retiros</span>';
        document.getElementById('brkYape').parentElement.classList.replace('border-slate-700', 'border-red-500/30');
        document.getElementById('brkYape').innerHTML = `<span class="text-red-400">-${formatMoney(tGas)}</span>`;
        
        cL.innerHTML = `
            <div class="bg-emerald-500/10 border border-emerald-500/30 p-4 rounded-xl mt-4 flex justify-between items-center">
                <div>
                    <p class="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mb-1">Caja Neta Real</p>
                    <p class="text-xs text-slate-400">Dinero disponible tras egresos</p>
                </div>
                <span class="text-2xl font-black text-emerald-400">${formatMoney(tIng - tGas)}</span>
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
    m.classList.add('opacity-0'); 
    setTimeout(() => {
        m.classList.add('hidden');
        // Reset estilos de Yape por si se cambiaron en "Ganancia"
        document.getElementById('brkYape').parentElement.classList.replace('border-red-500/30', 'border-slate-700');
        document.getElementById('brkEfectivo').parentElement.querySelector('span:first-child').innerHTML = '<i data-lucide="banknote" class="w-4 h-4 inline mr-1 text-emerald-400"></i> Efectivo';
        document.getElementById('brkYape').parentElement.querySelector('span:first-child').innerHTML = '<i data-lucide="smartphone" class="w-4 h-4 inline mr-1 text-purple-400"></i> Yape / Plin';
    }, 300); 
}
