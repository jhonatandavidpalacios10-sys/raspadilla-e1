import { db, collection, getDocs, doc, writeBatch, setDoc, getDoc, onSnapshot } from '../core/firebase-setup.js';

let sysEstadoUnsubscribe = null;

export function initRespaldo() { 
    // Botones de Backup
    document.getElementById('btn-exportar-backup')?.addEventListener('click', exportBackup);
    document.getElementById('btn-importar-backup')?.addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput')?.addEventListener('change', handleImportBackup);

    // Botón Global de Control de Servidor (Master)
    window.toggleSistemaLock = toggleSistemaLock;

    // Escuchar el estado actual para iluminar el botón del Master en tiempo real
    if (sysEstadoUnsubscribe) sysEstadoUnsubscribe();
    sysEstadoUnsubscribe = onSnapshot(doc(db, "configuracion", "estado_sistema"), (docSnap) => {
        const btn = document.getElementById('btn-toggle-sistema');
        const txt = document.getElementById('txt-sys-estado');
        
        if (!btn || !txt) return;

        if (docSnap.exists() && docSnap.data().cerrado === true) {
            // Diseño de SISTEMA CAÍDO
            txt.textContent = "Desconectado (Error 503)";
            txt.className = "text-sm font-bold text-red-500 animate-pulse";
            
            btn.innerHTML = '<i data-lucide="power" class="w-5 h-5"></i> Reactivar Conexión de Red';
            btn.className = "w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold flex justify-center items-center gap-2 relative z-10 shadow-lg shadow-emerald-500/20";
        } else {
            // Diseño de SISTEMA EN LÍNEA
            txt.textContent = "En Línea";
            txt.className = "text-sm font-bold text-emerald-400";
            
            btn.innerHTML = '<i data-lucide="alert-octagon" class="w-5 h-5"></i> Suspender Sistema';
            btn.className = "w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold flex justify-center items-center gap-2 relative z-10 shadow-lg shadow-red-500/20";
        }
        if (window.lucide) window.lucide.createIcons();
    });
}

// Función que escribe en Firebase el estado de cerrado o abierto para provocar el Error 404/503
async function toggleSistemaLock() {
    if(!window.mostrarConfirmacion) return;
    
    const ref = doc(db, "configuracion", "estado_sistema");
    const snap = await getDoc(ref);
    let isCurrentlyClosed = false;
    
    if (snap.exists()) {
        isCurrentlyClosed = snap.data().cerrado;
    }

    const mensajeAlerta = isCurrentlyClosed 
        ? "¿Reconectar los servidores? Todos los dispositivos en las franquicias volverán a tener acceso al sistema inmediatamente."
        : "¿Estás seguro de provocar un Error de Conexión? Esto expulsará a TODOS los vendedores y administradores en todos los locales, mostrando una pantalla técnica de error. Solo tú (Dueño Supremo) podrás seguir usando el sistema.";

    window.mostrarConfirmacion(mensajeAlerta, async () => {
        try {
            await setDoc(ref, { 
                cerrado: !isCurrentlyClosed,
                fechaModificacion: new Date().toISOString()
            }, { merge: true });
            
            if(window.mostrarToast) {
                window.mostrarToast(
                    "Estado de Red Modificado", 
                    !isCurrentlyClosed ? "El sistema ha sido bloqueado en todas las franquicias." : "Servidores restaurados con éxito.", 
                    !isCurrentlyClosed ? "amber" : "emerald"
                );
            }
        } catch (error) {
            console.error(error);
            if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo comunicar el cambio a los servidores.", "red");
        }
    });
}

// --- LOGICA NORMAL DE BACKUP ---

async function exportBackup() {
    const chkInv = document.getElementById('chkExpInv')?.checked; 
    const chkVentas = document.getElementById('chkExpVentas')?.checked; 
    const chkConf = document.getElementById('chkExpConf')?.checked;
    
    if (!chkInv && !chkVentas && !chkConf) { 
        if(window.mostrarAlerta) return window.mostrarAlerta('Error', 'Selecciona al menos una categoría.', 'amber'); else return; 
    }
    
    if(window.mostrarToast) window.mostrarToast('Procesando', 'Generando backup...', 'sky');
    
    try {
        const colecciones = []; 
        if(chkInv) colecciones.push('productos'); 
        if(chkVentas) colecciones.push('ventas', 'caja_diaria', 'gastos'); 
        if(chkConf) colecciones.push('locales', 'usuarios', 'configuracion');
        
        const backupData = {};
        for (const col of colecciones) { 
            const snap = await getDocs(collection(db, col)); 
            backupData[col] = []; 
            snap.forEach(doc => backupData[col].push({ id: doc.id, ...doc.data() })); 
        }
        
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href",     dataStr);
        downloadAnchorNode.setAttribute("download", `IcePOS_Backup_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Archivo descargado en tu dispositivo', 'emerald');
    } catch (e) {
        console.error(e);
        if(window.mostrarAlerta) window.mostrarAlerta('Error Crítico', 'No se pudo generar el archivo.', 'red');
    }
}

async function handleImportBackup(e) {
    const file = e.target.files[0];
    if (!file) return;

    const chkInv = document.getElementById('chkImpInv')?.checked; 
    const chkVentas = document.getElementById('chkImpVentas')?.checked; 
    const chkConf = document.getElementById('chkImpConf')?.checked;
    
    document.getElementById('importFileInput').value = '';

    if (!chkInv && !chkVentas && !chkConf) { 
        if(window.mostrarAlerta) window.mostrarAlerta('Error', 'Selecciona qué áreas restaurar.', 'amber'); 
        return;
    }
    
    if(window.mostrarConfirmacion) {
        window.mostrarConfirmacion('⚠️ Se sobrescribirán los datos de las categorías seleccionadas. ¿Continuar?', () => {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const data = JSON.parse(e.target.result); 
                    window.mostrarAlerta('Restaurando', 'Aplicando respaldo...', 'sky');
                    
                    const batch = writeBatch(db); let operations = 0; const colPermitidas = [];
                    
                    if(chkInv) colPermitidas.push('productos'); 
                    if(chkVentas) colPermitidas.push('ventas', 'caja_diaria', 'gastos'); 
                    if(chkConf) colPermitidas.push('locales', 'usuarios', 'configuracion');
                    
                    for (const [colName, docs] of Object.entries(data)) { 
                        if(colPermitidas.includes(colName) && Array.isArray(docs)) { 
                            docs.forEach(d => { 
                                const ref = doc(db, colName, d.id); 
                                const docData = { ...d }; 
                                delete docData.id; 
                                batch.set(ref, docData); 
                                operations++; 
                            }); 
                        } 
                    }
                    
                    if(operations > 490) return window.mostrarAlerta('Error', 'Archivo de respaldo demasiado grande (Límite 500 ops).', 'red');
                    
                    await batch.commit(); 
                    window.mostrarAlerta('Éxito', 'Sistema restaurado. Reiniciando...', 'emerald'); 
                    setTimeout(() => window.location.reload(), 2000);
                } catch(err) { 
                    window.mostrarAlerta('Error', 'El archivo está corrupto o es inválido.', 'red');
                }
            };
            reader.readAsText(file);
        });
    }
}
