import { db, collection, getDocs, doc, writeBatch, setDoc, getDoc, onSnapshot } from '../core/firebase-setup.js';
import { state } from '../core/store.js';

let sysEstadoUnsubscribe = null;
let respaldoInicializado = false; // CANDADO AÑADIDO

export function initRespaldo() { 
    // FIX CRÍTICO: Prevenir duplicación de eventos al rotar turnos
    if (respaldoInicializado) return;
    respaldoInicializado = true;

    // Eventos de Backup
    document.getElementById('btn-exportar-backup')?.addEventListener('click', exportBackup);
    document.getElementById('btn-importar-backup')?.addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput')?.addEventListener('change', handleImportBackup);

    // Evento Nuevo: Borrado Seguro (Solo Master)
    document.getElementById('btn-borrado-masivo')?.addEventListener('click', iniciarBorradoSeguro);

    // --- FIX CRÍTICO: Conectar el botón de suspensión directamente ---
    // Esto asegura que el botón siempre responda, sin importar cómo cambie su diseño
    document.getElementById('btn-toggle-sistema')?.addEventListener('click', toggleSistemaLock);

    // Funciones globales expuestas para el HTML
    window.toggleSistemaLock = toggleSistemaLock;
    window.subirLogoApp = subirLogoApp;
    window.resetLogoApp = resetLogoApp;
    window.cambiarNombreApp = cambiarNombreApp;

    // Escuchar el estado actual para UI Master (Bloqueo 503)
    if (sysEstadoUnsubscribe) sysEstadoUnsubscribe();
    sysEstadoUnsubscribe = onSnapshot(doc(db, "configuracion", "estado_sistema"), (docSnap) => {
        const btn = document.getElementById('btn-toggle-sistema');
        const txt = document.getElementById('txt-sys-estado');
        
        if (!btn || !txt) return;

        if (docSnap.exists() && docSnap.data().cerrado === true) {
            txt.textContent = "Desconectado (Error 503)";
            txt.className = "text-xs font-bold text-red-500 animate-pulse";
            
            // Usamos innerHTML con pointer-events-none para que el icono no absorba el clic
            btn.innerHTML = '<i data-lucide="power" class="w-5 h-5 pointer-events-none"></i> <span class="pointer-events-none">Reactivar Conexión</span>';
            
            // Modificamos solo los colores usando classList (Evita borrar la estructura del botón)
            btn.classList.remove('bg-red-600', 'hover:bg-red-500', 'shadow-red-500/20');
            btn.classList.add('bg-emerald-600', 'hover:bg-emerald-500', 'shadow-emerald-500/20');
        } else {
            txt.textContent = "En Línea";
            txt.className = "text-xs font-bold text-emerald-500";
            
            btn.innerHTML = '<i data-lucide="alert-octagon" class="w-5 h-5 pointer-events-none"></i> <span class="pointer-events-none">Suspender</span>';
            
            btn.classList.remove('bg-emerald-600', 'hover:bg-emerald-500', 'shadow-emerald-500/20');
            btn.classList.add('bg-red-600', 'hover:bg-red-500', 'shadow-red-500/20');
        }
        if (window.lucide) window.lucide.createIcons();
    });
}

// -----------------------------------------------------
// 1. IDENTIDAD CORPORATIVA (NOMBRE Y LOGO)
// -----------------------------------------------------

async function cambiarNombreApp() {
    const inputNombre = document.getElementById('input-nombre-app');
    if(!inputNombre) return;
    
    const nuevoNombre = inputNombre.value.trim();
    if (!nuevoNombre) {
        if(window.mostrarToast) window.mostrarToast("Error", "Ingresa un nombre válido.", "amber");
        return;
    }

    const btn = document.getElementById('btn-cambiar-nombre');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> Guardando...';
    if(window.lucide) window.lucide.createIcons();
    btn.disabled = true;

    try {
        await setDoc(doc(db, "configuracion", "estado_sistema"), { 
            nombreApp: nuevoNombre,
            fechaNombre: new Date().toISOString()
        }, { merge: true });

        if(window.mostrarToast) window.mostrarToast("Éxito", "Nombre de aplicación actualizado.", "emerald");
        inputNombre.value = '';
    } catch (err) {
        console.error(err);
        if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo guardar el nombre.", "red");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
        if(window.lucide) window.lucide.createIcons();
    }
}

async function subirLogoApp(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 800 * 1024) {
        if(window.mostrarAlerta) window.mostrarAlerta("Imagen muy pesada", "El logo debe pesar menos de 800KB para guardarse gratuitamente.", "amber");
        return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
        const base64 = event.target.result;
        try {
            if(window.mostrarToast) window.mostrarToast("Procesando", "Actualizando imagen corporativa...", "sky");
            await setDoc(doc(db, "configuracion", "estado_sistema"), { 
                logoUrl: base64,
                fechaLogo: new Date().toISOString()
            }, { merge: true });
            if(window.mostrarToast) window.mostrarToast("Éxito", "Logo actualizado globalmente", "emerald");
        } catch (err) {
            console.error(err);
            if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo guardar la imagen.", "red");
        }
    };
    reader.readAsDataURL(file);
}

async function resetLogoApp() {
    if(!window.mostrarConfirmacion) return;
    window.mostrarConfirmacion("¿Restaurar el nombre y logo originales de la app?", async () => {
        await setDoc(doc(db, "configuracion", "estado_sistema"), { 
            logoUrl: "assets/img/logo.svg",
            nombreApp: "IcePOS"
        }, { merge: true });
        window.location.reload();
    });
}

// -----------------------------------------------------
// 2. BLOQUEO 503 (SUSPENSIÓN DE SISTEMA)
// -----------------------------------------------------
async function toggleSistemaLock() {
    if(!window.mostrarConfirmacion) return;
    const ref = doc(db, "configuracion", "estado_sistema");
    const snap = await getDoc(ref);
    let isCurrentlyClosed = false;
    
    if (snap.exists()) isCurrentlyClosed = snap.data().cerrado;

    const mensajeAlerta = isCurrentlyClosed 
        ? "¿Reconectar los servidores? Todos los dispositivos volverán a tener acceso al sistema inmediatamente."
        : "¿Estás seguro de provocar un Error de Conexión? Esto expulsará a TODOS en todos los locales. Solo tú podrás seguir usando el sistema.";

    window.mostrarConfirmacion(mensajeAlerta, async () => {
        try {
            await setDoc(ref, { cerrado: !isCurrentlyClosed, fechaModificacion: new Date().toISOString() }, { merge: true });
            if(window.mostrarToast) window.mostrarToast("Estado Modificado", !isCurrentlyClosed ? "Sistema bloqueado globalmente." : "Servidores restaurados.", !isCurrentlyClosed ? "amber" : "emerald");
        } catch (error) {
            if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo comunicar con los servidores.", "red");
        }
    });
}

// -----------------------------------------------------
// 3. EXPORTAR / IMPORTAR BACKUPS
// -----------------------------------------------------
async function exportBackup() {
    const chkInv = document.getElementById('chkExpInv')?.checked; 
    const chkVentas = document.getElementById('chkExpVentas')?.checked; 
    const chkConf = document.getElementById('chkExpConf')?.checked;
    const filtroLocal = document.getElementById('exportLocalFilter')?.value || 'todas';
    
    if (!chkInv && !chkVentas && !chkConf) { 
        if(window.mostrarAlerta) return window.mostrarAlerta('Error', 'Selecciona al menos una categoría.', 'amber'); else return; 
    }
    
    if(window.mostrarToast) window.mostrarToast('Procesando', 'Extrayendo datos de la nube...', 'sky');
    
    try {
        const colecciones = []; 
        if(chkInv) colecciones.push('productos'); 
        if(chkVentas) colecciones.push('ventas', 'caja_diaria', 'gastos'); 
        if(chkConf) colecciones.push('locales', 'usuarios', 'configuracion');
        
        const backupData = {};
        for (const col of colecciones) { 
            const snap = await getDocs(collection(db, col)); 
            backupData[col] = []; 
            snap.forEach(docSnap => {
                const data = docSnap.data();
                
                // Filtro por local si no es 'todas'
                if (filtroLocal !== 'todas') {
                    if (col === 'ventas' || col === 'gastos' || col === 'caja_diaria' || col === 'usuarios') {
                        if (data.localId !== filtroLocal && data.localId) return; // Salta este registro si no pertenece
                    }
                    if (col === 'productos') {
                        // FIX: Siempre incluye los productos globales en todos los backups
                        if (data.localId !== 'global' && data.localId !== filtroLocal && data.localId) return;
                    }
                }

                backupData[col].push({ id: docSnap.id, ...data }); 
            }); 
        }
        
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", `Backup_${filtroLocal==='todas'?'General':filtroLocal}_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Archivo JSON descargado', 'emerald');
    } catch (e) {
        if(window.mostrarAlerta) window.mostrarAlerta('Error Crítico', 'No se pudo generar el archivo de respaldo.', 'red');
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
                    
                    if(operations > 490) return window.mostrarAlerta('Error', 'El archivo de respaldo supera el límite por operación (500). Contacta a soporte técnico.', 'red');
                    
                    await batch.commit(); 
                    window.mostrarAlerta('Éxito', 'Sistema restaurado. Reiniciando...', 'emerald'); 
                    setTimeout(() => window.location.reload(), 2000);
                } catch(err) { 
                    window.mostrarAlerta('Error', 'El archivo está corrupto o no es válido.', 'red');
                }
            };
            reader.readAsText(file);
        });
    }
}

// -----------------------------------------------------
// 4. CUENTA REGRESIVA Y BORRADO SEGURO DE DATOS (NUEVO)
// -----------------------------------------------------
let deleteTimer = null;

function iniciarBorradoSeguro() {
    // 1. Doble validación de seguridad
    if (state.userRole !== 'master') {
        if(window.mostrarAlerta) window.mostrarAlerta("Acceso Restringido", "Esta acción es irreversible y requiere privilegios de Dueño Supremo.", "red");
        return;
    }

    // 2. Leer qué quiere borrar (Añadiremos los checkboxes en el HTML al final)
    const borrarVentas = document.getElementById('chkDelVentas')?.checked;
    const borrarProductos = document.getElementById('chkDelProductos')?.checked;

    if (!borrarVentas && !borrarProductos) {
        if(window.mostrarToast) window.mostrarToast("Aviso", "Selecciona al menos una categoría de datos para limpiar.", "amber");
        return;
    }

    // 3. Crear el Overlay Rojo de Emergencia
    const overlay = document.createElement('div');
    overlay.id = 'countdown-overlay';
    overlay.className = 'fixed inset-0 bg-red-950/95 z-[999] flex flex-col items-center justify-center text-white p-4 backdrop-blur-md';
    
    let timeLeft = 5;
    overlay.innerHTML = `
        <i data-lucide="alert-triangle" class="w-24 h-24 text-red-500 mb-6 animate-pulse drop-shadow-[0_0_15px_rgba(239,68,68,0.8)]"></i>
        <h1 class="text-4xl md:text-5xl font-black mb-2 text-center tracking-tight">¡ATENCIÓN!</h1>
        <p class="text-center mb-6 max-w-md text-red-200 text-sm md:text-base">Estás a punto de borrar de forma <b>permanente e irreversible</b> los datos seleccionados en toda la base de datos.</p>
        
        <div class="text-9xl font-black mb-10 tabular-nums drop-shadow-[0_0_20px_rgba(255,255,255,0.3)]" id="countdown-timer">${timeLeft}</div>
        
        <button id="btn-cancel-delete" class="px-8 py-4 bg-white text-red-900 hover:bg-slate-200 font-black rounded-xl shadow-2xl transition-transform active:scale-95 text-lg">
            ¡CANCELAR BORRADO AHORA!
        </button>
    `;
    document.body.appendChild(overlay);
    if(window.lucide) window.lucide.createIcons();

    const timerEl = document.getElementById('countdown-timer');
    const cancelBtn = document.getElementById('btn-cancel-delete');

    // Acción si le da a cancelar antes de que acabe el tiempo
    cancelBtn.onclick = () => {
        clearInterval(deleteTimer);
        overlay.remove();
        if(window.mostrarToast) window.mostrarToast("Misión Abortada", "El borrado fue cancelado a tiempo.", "sky");
    };

    // Temporizador
    deleteTimer = setInterval(async () => {
        timeLeft--;
        if(timeLeft > 0) {
            timerEl.textContent = timeLeft;
            // Efecto visual cada segundo
            timerEl.classList.remove('scale-110');
            void timerEl.offsetWidth; // Forzar reflow
            timerEl.classList.add('scale-110', 'transition-transform');
        } else {
            // Se acabó el tiempo. ¡Fuego!
            clearInterval(deleteTimer);
            overlay.innerHTML = `
                <i data-lucide="loader-2" class="w-20 h-20 animate-spin text-white mb-6"></i>
                <h2 class="text-3xl font-bold animate-pulse">Eliminando registros de la Nube...</h2>
                <p class="text-red-300 mt-4 text-sm">Por favor, no cierres la aplicación.</p>
            `;
            if(window.lucide) window.lucide.createIcons();
            
            await ejecutarBorradoBaseDatos(borrarVentas, borrarProductos);
            overlay.remove();
        }
    }, 1000);
}

// Función real que elimina los documentos en Firestore
async function ejecutarBorradoBaseDatos(borrarVentas, borrarProductos) {
    try {
        let coleccionesParaBorrar = [];
        // Dependiendo de lo seleccionado en la UI
        if (borrarVentas) coleccionesParaBorrar.push('ventas', 'gastos', 'caja_diaria');
        if (borrarProductos) coleccionesParaBorrar.push('productos');

        let totalEliminados = 0;

        for (const col of coleccionesParaBorrar) {
            const snap = await getDocs(collection(db, col));
            let currentBatch = writeBatch(db);
            let operationCount = 0;
            
            for (const docSnap of snap.docs) {
                currentBatch.delete(doc(db, col, docSnap.id));
                operationCount++;
                totalEliminados++;

                // Firebase permite máximo 500 escrituras por lote
                if (operationCount >= 490) {
                    await currentBatch.commit();
                    currentBatch = writeBatch(db); // Crear un lote nuevo
                    operationCount = 0;
                }
            }
            // Commitear lo que sobre del último lote
            if (operationCount > 0) {
                await currentBatch.commit();
            }
        }
        
        if(window.mostrarAlerta) window.mostrarAlerta("Borrado Exitoso", `La purga finalizó correctamente. Se han destruido <b>${totalEliminados} registros</b> del sistema.`, "emerald");
        
        // Refrescar inventario si se borraron productos para actualizar la interfaz
        if(borrarProductos && window.cargarInventarioDesdeFirebase) {
            window.cargarInventarioDesdeFirebase();
        }

    } catch(e) {
        console.error("Error crítico durante el borrado:", e);
        if(window.mostrarAlerta) window.mostrarAlerta("Fallo en Operación", "Hubo un error de conexión al intentar purgar los datos. Revisa la consola.", "red");
    }
}
