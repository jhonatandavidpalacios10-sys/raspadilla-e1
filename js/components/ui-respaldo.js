import { db, collection, getDocs, doc, writeBatch } from '../core/firebase-setup.js';

export function initRespaldo() { 
    document.getElementById('btn-exportar-backup')?.addEventListener('click', exportBackup);
    document.getElementById('btn-importar-backup')?.addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput')?.addEventListener('change', handleImportBackup);
}

async function exportBackup() {
    const chkInv = document.getElementById('chkExpInv')?.checked; const chkVentas = document.getElementById('chkExpVentas')?.checked; const chkConf = document.getElementById('chkExpConf')?.checked;
    if (!chkInv && !chkVentas && !chkConf) { if(window.mostrarAlerta) return window.mostrarAlerta('Error', 'Selecciona al menos una.', 'amber'); else return; }
    if(window.mostrarToast) window.mostrarToast('Procesando', 'Generando backup...', 'sky');
    try {
        const colecciones = []; if(chkInv) colecciones.push('productos'); if(chkVentas) colecciones.push('ventas', 'caja_diaria', 'gastos'); if(chkConf) colecciones.push('locales', 'usuarios');
        const backupData = {};
        for (const col of colecciones) { const snap = await getDocs(collection(db, col)); backupData[col] = []; snap.forEach(doc => backupData[col].push({ id: doc.id, ...doc.data() })); }
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2)); const downloadAnchorNode = document.createElement('a'); downloadAnchorNode.setAttribute("href", dataStr); downloadAnchorNode.setAttribute("download", `IcePOS_Backup_${new Date().getTime()}.json`); document.body.appendChild(downloadAnchorNode); downloadAnchorNode.click(); downloadAnchorNode.remove();
    } catch(e) {}
}

function handleImportBackup(event) {
    const file = event.target.files[0]; if (!file) return;
    const chkInv = document.getElementById('chkImpInv')?.checked; const chkVentas = document.getElementById('chkImpVentas')?.checked; const chkConf = document.getElementById('chkImpConf')?.checked;
    if (!chkInv && !chkVentas && !chkConf) { event.target.value = ''; if(window.mostrarAlerta) return window.mostrarAlerta('Error', 'Selecciona qué áreas restaurar.', 'amber'); else return;}
    if(window.mostrarConfirmacion) {
        window.mostrarConfirmacion('⚠️ Se sobrescribirán los datos de las categorías seleccionadas. ¿Continuar?', () => {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const data = JSON.parse(e.target.result); window.mostrarAlerta('Restaurando', 'Aplicando respaldo...', 'sky');
                    const batch = writeBatch(db); let operations = 0; const colPermitidas = [];
                    if(chkInv) colPermitidas.push('productos'); if(chkVentas) colPermitidas.push('ventas', 'caja_diaria', 'gastos'); if(chkConf) colPermitidas.push('locales', 'usuarios');
                    for (const [colName, docs] of Object.entries(data)) { if(colPermitidas.includes(colName) && Array.isArray(docs)) { docs.forEach(d => { const ref = doc(db, colName, d.id); const docData = { ...d }; delete docData.id; batch.set(ref, docData); operations++; }); } }
                    if(operations > 490) return window.mostrarAlerta('Error', 'Archivo muy grande.', 'red');
                    await batch.commit(); window.mostrarAlerta('Éxito', 'Sistema restaurado.', 'emerald'); setTimeout(() => window.location.reload(), 2000);
                } catch(err) { window.mostrarAlerta('Error', 'Archivo corrupto.', 'red'); }
            }; reader.readAsText(file);
        });
    }
    event.target.value = '';
}
