import { db, collection, query, where, onSnapshot } from '../core/firebase-setup.js';
import { formatMoney, getTodayDateStr } from '../utils/helpers.js';
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
    document.getElementById('filterAnalysisLocal')?.addEventListener('change', updateAnalysisRange);

    updateAnalysisRange();
}

function updateAnalysisRange() {
    const sStr = document.getElementById('filterStartDate').value;
    const eStr = document.getElementById('filterEndDate').value;
    const locId = document.getElementById('filterAnalysisLocal')?.value || 'todas';

    if (!sStr || !eStr) return;

    if (unsubscribeVentas) unsubscribeVentas();
    if (unsubscribeGastos) unsubscribeGastos();

    readyV = false; readyG = false;
    document.getElementById('analysis-kpis').innerHTML = '<div class="col-span-full text-center text-slate-500 py-4"><i data-lucide="loader-2" class="w-6 h-6 animate-spin mx-auto mb-2"></i>Calculando métricas...</div>';
    if(window.lucide) window.lucide.createIcons();

    const qVentas = query(collection(db, "ventas"), where("fechaStr", ">=", sStr), where("fechaStr", "<=", eStr));
    unsubscribeVentas = onSnapshot(qVentas, (snapshot) => {
        analysisData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (locId !== 'todas') analysisData = analysisData.filter(v => v.localId === locId);
        readyV = true; 
        if(readyV && readyG) buildAnalysisUI();
    }, (error) => { console.error("Error análisis ventas:", error); });

    const qGastos = query(collection(db, "gastos"), where("fechaStr", ">=", sStr), where("fechaStr", "<=", eStr));
    unsubscribeGastos = onSnapshot(qGastos, (snapshot) => {
        analysisGastos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (locId !== 'todas') analysisGastos = analysisGastos.filter(g => g.localId === locId);
        readyG = true; 
        if(readyV && readyG) buildAnalysisUI();
    }, (error) => { console.error("Error análisis gastos:", error); });
}

function buildAnalysisUI() {
    renderKPIs();
    renderCalendar();
    renderTopProducts();
}

function renderKPIs() {
    let tIng = 0, tEfe = 0, tYap = 0, tGas = 0, totalTkts = 0;

    analysisData.forEach(v => {
        tIng += parseFloat(v.total || 0);
        tEfe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0);
        tYap += parseFloat(v.pago_yape || v.pagoYape || 0);
        totalTkts++;
    });

    analysisGastos.forEach(g => tGas += parseFloat(g.monto || 0));

    const neto = tIng - tGas;
    const ticketProm = totalTkts > 0 ? (tIng / totalTkts) : 0;

    const cont = document.getElementById('analysis-kpis');
    if(!cont) return;

    cont.innerHTML = `
        <div class="bg-gradient-to-br from-emerald-400 to-teal-500 rounded-2xl p-5 text-white shadow-lg relative overflow-hidden group">
            <div class="absolute -right-4 -top-4 opacity-10 group-hover:scale-110 transition-transform duration-500"><i data-lucide="trending-up" class="w-32 h-32"></i></div>
            <p class="text-emerald-50 text-sm font-medium mb-1 relative z-10 flex items-center gap-2"><i data-lucide="wallet" class="w-4 h-4"></i> Ingresos Brutos</p>
            <p class="text-3xl font-black relative z-10">${formatMoney(tIng)}</p>
            <div class="mt-4 pt-3 border-t border-emerald-300/30 flex justify-between text-xs relative z-10">
                <span>Efe: <b>${formatMoney(tEfe)}</b></span>
                <span>Yape: <b>${formatMoney(tYap)}</b></span>
            </div>
        </div>

        <div class="bg-gradient-to-br from-sky-400 to-indigo-500 rounded-2xl p-5 text-white shadow-lg relative overflow-hidden group">
            <div class="absolute -right-4 -top-4 opacity-10 group-hover:scale-110 transition-transform duration-500"><i data-lucide="piggy-bank" class="w-32 h-32"></i></div>
            <p class="text-sky-50 text-sm font-medium mb-1 relative z-10 flex items-center gap-2"><i data-lucide="calculator" class="w-4 h-4"></i> Utilidad Neta</p>
            <p class="text-3xl font-black relative z-10">${formatMoney(neto)}</p>
            <div class="mt-4 pt-3 border-t border-sky-300/30 flex justify-between items-center text-xs relative z-10">
                <span class="text-red-200">Gastos: -${formatMoney(tGas)}</span>
                <button onclick="showBreakdown('gastos')" class="bg-white/20 hover:bg-white/30 px-2 py-1 rounded transition-colors backdrop-blur-sm flex items-center gap-1">Ver <i data-lucide="arrow-right" class="w-3 h-3"></i></button>
            </div>
        </div>

        <div class="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between">
            <div>
                <p class="text-slate-500 dark:text-slate-400 text-sm font-medium mb-1 flex items-center gap-2"><i data-lucide="receipt" class="w-4 h-4 text-slate-400"></i> Tickets Emitidos</p>
                <p class="text-2xl font-black text-slate-800 dark:text-white">${totalTkts}</p>
            </div>
            <div class="mt-3 bg-slate-50 dark:bg-slate-900 rounded-lg p-2.5 border border-slate-100 dark:border-slate-800">
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-0.5">Ticket Promedio</p>
                <p class="text-sm font-bold text-slate-700 dark:text-slate-300">${formatMoney(ticketProm)}</p>
            </div>
        </div>
    `;
    if(window.lucide) window.lucide.createIcons();
}

function renderTopProducts() {
    const counts = {};
    const ingresos = {};
    
    analysisData.forEach(v => {
        if(v.items) {
            v.items.forEach(i => {
                if (i.productoId === 'AJUSTE') return;
                counts[i.nombre] = (counts[i.nombre] || 0) + i.cantidad;
                ingresos[i.nombre] = (ingresos[i.nombre] || 0) + (i.precio * i.cantidad);
            });
        }
    });

    const top = Object.keys(counts).map(k => ({ nombre: k, cant: counts[k], ing: ingresos[k] })).sort((a,b) => b.cant - a.cant).slice(0, 5);

    const cont = document.getElementById('analysis-top-products');
    if(!cont) return;

    if (top.length === 0) {
        cont.innerHTML = '<div class="text-center text-slate-500 py-8 text-sm">No hay ventas registradas en este periodo.</div>';
        return;
    }

    const maxVal = top[0].cant;

    cont.innerHTML = `
        <div class="space-y-4">
            ${top.map((p, idx) => {
                const pct = (p.cant / maxVal) * 100;
                const colors = ['bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500', 'bg-pink-500'];
                const color = colors[idx % colors.length];
                
                return `
                <div>
                    <div class="flex justify-between text-xs font-bold mb-1">
                        <span class="text-slate-700 dark:text-slate-300 truncate pr-2 flex items-center gap-2">
                            <span class="w-4 h-4 rounded-full ${color} text-white flex items-center justify-center text-[8px]">${idx+1}</span>
                            ${p.nombre}
                        </span>
                        <span class="text-slate-500 shrink-0">${p.cant} un. <span class="text-slate-300 dark:text-slate-600 mx-1">|</span> <span class="${color.replace('bg-', 'text-')}">${formatMoney(p.ing)}</span></span>
                    </div>
                    <div class="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2 overflow-hidden">
                        <div class="${color} h-2 rounded-full transition-all duration-1000" style="width: ${pct}%"></div>
                    </div>
                </div>
                `;
            }).join('')}
        </div>
    `;
}

// Lógica de Calendario
const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function setAnalysisRange(days) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    
    document.getElementById('filterStartDate').value = start.toISOString().split('T')[0];
    document.getElementById('filterEndDate').value = end.toISOString().split('T')[0];
    currentDateAnalysis = start;
    updateAnalysisRange();
}

function changeAnalysisMonth(delta) {
    currentDateAnalysis.setMonth(currentDateAnalysis.getMonth() + delta);
    const firstDay = new Date(currentDateAnalysis.getFullYear(), currentDateAnalysis.getMonth(), 1);
    const lastDay = new Date(currentDateAnalysis.getFullYear(), currentDateAnalysis.getMonth() + 1, 0);
    
    document.getElementById('filterStartDate').value = firstDay.toISOString().split('T')[0];
    document.getElementById('filterEndDate').value = lastDay.toISOString().split('T')[0];
    updateAnalysisRange();
}

function renderCalendar() {
    const dStr = document.getElementById('filterStartDate').value;
    if (!dStr) return;
    const refDate = new Date(dStr + "T00:00:00");
    
    const year = refDate.getFullYear();
    const month = refDate.getMonth();
    
    document.getElementById('cal-month-label').textContent = `${monthNames[month]} ${year}`;
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    const grid = document.getElementById('analysis-calendar-grid');
    grid.innerHTML = '';
    
    // Rellenar días vacíos al inicio (Domingo = 0 en JS, ajustamos si empieza en Lunes, pero dejaremos estándar Domingo)
    for (let i = 0; i < firstDay; i++) {
        grid.innerHTML += `<div class="p-2 opacity-0"></div>`;
    }
    
    const mapVentas = {};
    const mapGastos = {};
    
    analysisData.forEach(v => {
        mapVentas[v.fechaStr] = (mapVentas[v.fechaStr] || 0) + parseFloat(v.total || 0);
    });
    
    analysisGastos.forEach(g => {
        mapGastos[g.fechaStr] = (mapGastos[g.fechaStr] || 0) + parseFloat(g.monto || 0);
    });
    
    let maxIngreso = 0;
    Object.values(mapVentas).forEach(v => { if(v > maxIngreso) maxIngreso = v; });
    
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month+1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const ing = mapVentas[dateStr] || 0;
        const gas = mapGastos[dateStr] || 0;
        const neto = ing - gas;
        
        let intensityClass = 'bg-slate-50 dark:bg-slate-800 border-slate-100 dark:border-slate-700/50';
        let textClass = 'text-slate-400';
        
        if (ing > 0) {
            const pct = ing / maxIngreso;
            if (pct > 0.7) { intensityClass = 'bg-emerald-500 border-emerald-600 text-white shadow-md shadow-emerald-500/20 scale-105 z-10'; textClass = 'text-emerald-50'; }
            else if (pct > 0.4) { intensityClass = 'bg-emerald-400 border-emerald-500 text-white'; textClass = 'text-emerald-50'; }
            else if (pct > 0.1) { intensityClass = 'bg-emerald-300 dark:bg-emerald-500/60 border-emerald-400 dark:border-emerald-500 text-emerald-900 dark:text-white'; textClass = 'text-emerald-800 dark:text-emerald-100'; }
            else { intensityClass = 'bg-emerald-100 dark:bg-emerald-500/20 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300'; textClass = 'text-emerald-600 dark:text-emerald-400'; }
        }
        
        const isToday = dateStr === getTodayDateStr() ? 'ring-2 ring-sky-500 ring-offset-2 dark:ring-offset-slate-900' : '';
        
        const dot = gas > 0 ? `<div class="w-1.5 h-1.5 rounded-full bg-red-500 absolute top-1.5 right-1.5 shadow-sm" title="Hubo gastos este día"></div>` : '';
        
        const stringifiedObj = encodeURIComponent(JSON.stringify({ dateStr, ing, gas, neto }));
        
        grid.innerHTML += `
            <div onclick="window.currentSelectedDayObj = JSON.parse(decodeURIComponent('${stringifiedObj}')); showBreakdown('dia')" 
                 class="p-2 border rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all hover:ring-2 hover:ring-sky-300 relative min-h-[60px] sm:min-h-[80px] ${intensityClass} ${isToday}">
                ${dot}
                <span class="text-xs sm:text-sm font-black mb-1 ${ing > 0 && textClass === 'text-slate-400' ? '' : textClass}">${day}</span>
                ${ing > 0 ? `<span class="text-[9px] sm:text-[10px] font-bold truncate w-full text-center">${formatMoney(ing).replace('S/ ','')}</span>` : ''}
                ${(gas > 0 && ing <= 0) ? `<span class="text-[9px] text-red-500 font-bold truncate w-full text-center">-${formatMoney(gas).replace('S/ ','')}</span>` : ''}
            </div>
        `;
    }
}

function showBreakdown(type) {
    const m = document.getElementById('modal-breakdown');
    const title = document.getElementById('brkTitle');
    const cL = document.getElementById('brkContent');
    const ul = document.getElementById('brkList');
    
    cL.innerHTML = '';
    ul.innerHTML = '';
    document.getElementById('brkCategories').classList.add('hidden');
    
    if (type === 'gastos') {
        title.innerHTML = '<i data-lucide="trending-down" class="w-5 h-5 inline mr-2 text-red-500"></i> Desglose de Gastos';
        
        if (analysisGastos.length === 0) {
            ul.innerHTML = '<li class="text-center text-slate-500 py-4 text-sm">No hay gastos en este periodo.</li>';
        } else {
            // Agrupar gastos iguales si es necesario, o listarlos ordenados por fecha
            const sortedGastos = [...analysisGastos].sort((a,b) => b.fechaHora - a.fechaHora);
            
            ul.innerHTML = sortedGastos.map(g => {
                const dateObj = g.fechaHora ? new Date(g.fechaHora) : new Date();
                const dForm = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                const autor = g.editadoPor || g.creadoPor || g.cajeroEmail || 'Admin';
                
                return `
                <li class="flex justify-between items-center p-3 border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <div>
                        <p class="font-bold text-sm text-slate-800 dark:text-white">${g.descripcion}</p>
                        <p class="text-[10px] text-slate-500 flex items-center gap-2 mt-0.5">
                            <span><i data-lucide="calendar" class="w-3 h-3 inline"></i> ${dForm}</span>
                            <span><i data-lucide="user" class="w-3 h-3 inline"></i> ${autor}</span>
                        </p>
                    </div>
                    <span class="font-black text-red-500 text-sm">-${formatMoney(g.monto)}</span>
                </li>`;
            }).join('');
        }
    } else if (type === 'dia' && window.currentSelectedDayObj) {
        const obj = window.currentSelectedDayObj;
        
        // Extraer partes de la fecha
        const [year, month, day] = obj.dateStr.split('-');
        const objDate = new Date(year, month - 1, day); // month es 0-indexed en Date
        
        const fDate = objDate.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        title.innerHTML = `<i data-lucide="calendar-days" class="w-5 h-5 inline mr-2 text-sky-500"></i> <span class="capitalize">${fDate}</span>`;
        
        // Filtrar datos de ese día exacto
        const vDia = analysisData.filter(v => v.fechaStr === obj.dateStr);
        const gDia = analysisGastos.filter(g => g.fechaStr === obj.dateStr);
        
        let tEfe = 0, tYap = 0;
        vDia.forEach(v => {
            tEfe += parseFloat(v.pago_efectivo || v.pagoEfectivo || 0);
            tYap += parseFloat(v.pago_yape || v.pagoYape || 0);
        });
        
        let tIng = obj.ing;
        let tGas = obj.gas;
        
        document.getElementById('brkValEfe').textContent = formatMoney(tEfe);
        document.getElementById('brkValYap').textContent = formatMoney(tYap);
        
        document.getElementById('brkBoxIng').innerHTML = `
            <div class="flex justify-between items-center bg-emerald-50 dark:bg-emerald-500/10 p-3 rounded-xl border border-emerald-200 dark:border-emerald-500/30 shadow-sm">
                <span class="text-sm font-bold text-emerald-600 dark:text-emerald-500 flex items-center"><i data-lucide="trending-up" class="w-4 h-4 inline mr-2 text-emerald-500"></i> Ventas Brutas</span>
                <span class="font-black text-emerald-600 dark:text-emerald-500 text-base">${formatMoney(tIng)}</span>
            </div>
        `;
        document.getElementById('brkBoxGas').innerHTML = `
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
    const m = document.getElementById('modal-breakdown');
    m.classList.add('opacity-0');
    setTimeout(() => { m.classList.add('hidden'); window.currentSelectedDayObj = null; }, 300);
}
