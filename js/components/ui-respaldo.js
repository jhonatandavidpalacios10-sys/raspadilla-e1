import { db, collection, getDocs, doc, writeBatch, setDoc, getDoc, onSnapshot } from '../core/firebase-setup.js';
import { state } from '../core/store.js';
import { buildLegacyInventoryMovements } from '../core/sales-service.js';
import { getTodayDateStr } from '../utils/helpers.js';

let sysEstadoUnsubscribe = null;
let respaldoInicializado = false; // CANDADO AÑADIDO
let limpiandoLogoObsoleto = false;
let respaldoEventsController = null;
const LOGO_PREDETERMINADO = '/assets/img/logo.png';

export function initRespaldo() { 
    // FIX CRÍTICO: Prevenir duplicación de eventos al rotar turnos
    if (respaldoInicializado) return;
    respaldoInicializado = true;
    respaldoEventsController = new AbortController();
    const eventOptions = { signal: respaldoEventsController.signal };

    // Eventos de Backup
    document.getElementById('btn-exportar-backup')?.addEventListener('click', exportBackup, eventOptions);
    document.getElementById('btn-importar-backup')?.addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    }, eventOptions);
    document.getElementById('importFileInput')?.addEventListener('change', handleImportBackup, eventOptions);

    // Evento: Borrado Seguro (Solo Master)
    document.getElementById('btn-borrado-masivo')?.addEventListener('click', iniciarBorradoSeguro, eventOptions);

    // Conectar el botón de suspensión directamente
    document.getElementById('btn-toggle-sistema')?.addEventListener('click', toggleSistemaLock, eventOptions);

    // Sin Firebase Storage no se guardan archivos dentro de Firestore. El logo
    // personalizado se conserva únicamente como una URL HTTPS pública.
    document.getElementById('input-logo-app')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            solicitarLogoUrl();
        }
    }, eventOptions);
    const btnCambiarLogo = document.getElementById('btn-cambiar-logo');
    if (btnCambiarLogo) {
        btnCambiarLogo.onclick = solicitarLogoUrl;
        btnCambiarLogo.innerHTML = '<i data-lucide="link" class="w-5 h-5"></i> Usar URL de Logo';
    }

    // Funciones globales expuestas para el HTML
    window.toggleSistemaLock = toggleSistemaLock;
    window.subirLogoApp = solicitarLogoUrl;
    window.resetLogoApp = resetLogoApp;
    window.cambiarNombreApp = cambiarNombreApp;
    window.sincronizarPopularidad = sincronizarPopularidad; // NUEVA EXPOSICIÓN

    // Escuchar el estado actual para UI Master (Bloqueo 503)
    if (sysEstadoUnsubscribe) sysEstadoUnsubscribe();
    sysEstadoUnsubscribe = onSnapshot(doc(db, "configuracion", "estado_sistema"), (docSnap) => {
        const btn = document.getElementById('btn-toggle-sistema');
        const txt = document.getElementById('txt-sys-estado');
        
        if (!btn || !txt) return;

        const configuracion = docSnap.exists() ? docSnap.data() : {};
        reemplazarLogoObsoleto(configuracion.logoUrl);

        if (configuracion.cerrado === true) {
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
        if (window.lucide) window.lucide.createIcons({ root: btn });
    });
}

export function destroyRespaldo() {
    sysEstadoUnsubscribe?.();
    sysEstadoUnsubscribe = null;
    respaldoEventsController?.abort();
    respaldoEventsController = null;
    respaldoInicializado = false;
    if (deleteTimer) {
        clearInterval(deleteTimer);
        deleteTimer = null;
    }
    document.getElementById('countdown-overlay')?.remove();
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
    if(window.lucide) window.lucide.createIcons({ root: btn });
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
        if(window.lucide) window.lucide.createIcons({ root: btn });
    }
}

function normalizarLogoUrl(valor) {
    try {
        const url = new URL(String(valor || '').trim());
        return url.protocol === 'https:' ? url.href : null;
    } catch (_) {
        return null;
    }
}

function validarCargaImagen(url) {
    return new Promise((resolve, reject) => {
        const imagen = new Image();
        const timeout = setTimeout(() => reject(new Error('Tiempo de espera agotado')), 10000);
        imagen.onload = () => {
            clearTimeout(timeout);
            resolve();
        };
        imagen.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('La URL no devolvió una imagen accesible'));
        };
        imagen.src = url;
    });
}

async function solicitarLogoUrl() {
    const inputLogo = document.getElementById('input-logo-app');
    const valor = inputLogo?.value || '';

    const logoUrl = normalizarLogoUrl(valor);
    if (!logoUrl) {
        if (window.mostrarAlerta) {
            window.mostrarAlerta('URL inválida', 'Ingresa una URL pública que comience con https://.', 'amber');
        }
        return;
    }

    const btn = document.getElementById('btn-cambiar-logo');
    const originalHtml = btn?.innerHTML || '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> Validando...';
        if (window.lucide) window.lucide.createIcons({ root: btn });
    }

    try {
        await validarCargaImagen(logoUrl);
        await setDoc(doc(db, 'configuracion', 'estado_sistema'), {
            logoUrl,
            fechaLogo: new Date().toISOString()
        }, { merge: true });
        try { localStorage.setItem('app_custom_logo', logoUrl); } catch (_) {}
        if (inputLogo) inputLogo.value = '';
        if (window.mostrarToast) window.mostrarToast('Éxito', 'Logo actualizado globalmente.', 'emerald');
    } catch (err) {
        console.error('No se pudo establecer el logo remoto:', err);
        if (window.mostrarAlerta) {
            window.mostrarAlerta(
                'Logo no disponible',
                'La URL no cargó una imagen pública. Revisa el enlace e inténtalo nuevamente.',
                'red'
            );
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            if (window.lucide) window.lucide.createIcons({ root: btn });
        }
    }
}

function esLogoEmpaquetadoObsoleto(logoUrl) {
    try {
        const parsedUrl = new URL(logoUrl, window.location.origin);
        return (
            parsedUrl.origin === window.location.origin
            && /^\/assets\/img\/logo\.[^/]+$/i.test(parsedUrl.pathname)
            && parsedUrl.pathname !== LOGO_PREDETERMINADO
        );
    } catch (_) {
        return false;
    }
}

async function reemplazarLogoObsoleto(logoUrl) {
    const requiereReemplazo = (
        typeof logoUrl === 'string'
        && (logoUrl.startsWith('data:') || esLogoEmpaquetadoObsoleto(logoUrl))
    );
    if (limpiandoLogoObsoleto || !requiereReemplazo) return;
    if (state.userRole !== 'master') return;

    limpiandoLogoObsoleto = true;
    try {
        await setDoc(doc(db, 'configuracion', 'estado_sistema'), {
            logoUrl: LOGO_PREDETERMINADO,
            fechaLogo: new Date().toISOString()
        }, { merge: true });
        try { localStorage.setItem('app_custom_logo', LOGO_PREDETERMINADO); } catch (_) {}
    } catch (err) {
        console.error('No se pudo reemplazar el logo obsoleto:', err);
    } finally {
        limpiandoLogoObsoleto = false;
    }
}

async function resetLogoApp() {
    if(!window.mostrarConfirmacion) return;
    window.mostrarConfirmacion("¿Restaurar el nombre y logo originales de la app?", async () => {
        try {
            await setDoc(doc(db, "configuracion", "estado_sistema"), { 
                logoUrl: LOGO_PREDETERMINADO,
                nombreApp: "Raffaelito"
            }, { merge: true });
            try { localStorage.setItem('app_custom_logo', LOGO_PREDETERMINADO); } catch (_) {}
            window.location.reload();
        } catch (error) {
            console.error('No se pudo restaurar la identidad visual:', error);
            window.mostrarAlerta?.(
                'No se pudo restaurar',
                'Revisa la conexión e inténtalo nuevamente.',
                'red'
            );
        }
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
function serializeBackupValue(value) {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) {
        return { __iceposType: 'timestamp', iso: value.toISOString() };
    }
    if (typeof value?.toDate === 'function') {
        return { __iceposType: 'timestamp', iso: value.toDate().toISOString() };
    }
    if (Array.isArray(value)) return value.map(serializeBackupValue);
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
                serializeBackupValue(child)
            ])
        );
    }
    return value;
}

function deserializeBackupValue(value) {
    if (value === null || value === undefined) return value;
    if (
        typeof value === 'object'
        && !Array.isArray(value)
        && value.__iceposType === 'timestamp'
        && typeof value.iso === 'string'
    ) {
        const date = new Date(value.iso);
        if (Number.isFinite(date.getTime())) return date;
    }
    if (Array.isArray(value)) return value.map(deserializeBackupValue);
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
                deserializeBackupValue(child)
            ])
        );
    }
    return value;
}

async function exportBackup() {
    const chkInv = document.getElementById('chkExpInv')?.checked; 
    const chkVentas = document.getElementById('chkExpVentas')?.checked; 
    const chkConf = document.getElementById('chkExpConf')?.checked;
    const localFilter = document.getElementById('exportLocalFilter');
    const filtroLocal = localFilter ? localFilter.value : 'todas';
    
    if (!chkInv && !chkVentas && !chkConf) { 
        if(window.mostrarAlerta) return window.mostrarAlerta('Error', 'Selecciona al menos una categoría.', 'amber'); else return; 
    }
    
    if(window.mostrarToast) window.mostrarToast('Procesando', 'Extrayendo datos de la nube...', 'sky');
    
    try {
        const colecciones = []; 
        if(chkInv) colecciones.push('productos'); 
        if(chkVentas) colecciones.push('ventas', 'caja_diaria', 'gastos'); 
        if(chkConf) colecciones.push('locales', 'usuarios', 'configuracion', 'directorio_login');
        
        const backupData = {
            __meta: {
                format: 'icepos-backup',
                version: 2,
                createdAt: new Date().toISOString(),
                localFilter: filtroLocal
            }
        };
        const snapshots = await Promise.all(
            colecciones.map(async col => ({
                col,
                snap: await getDocs(collection(db, col))
            }))
        );

        snapshots.forEach(({ col, snap }) => {
            backupData[col] = []; 
            snap.forEach(docSnap => {
                const data = docSnap.data();
                
                const localId = data.localId || '';
                const legacyMatch = !localId || localId === 'general';
                if (filtroLocal !== 'todas' && ['ventas', 'gastos', 'caja_diaria', 'usuarios'].includes(col)) {
                    const matches = filtroLocal === ''
                        ? legacyMatch
                        : localId === filtroLocal;
                    if (!matches) return;
                }
                if (filtroLocal !== 'todas' && col === 'productos') {
                    const matches = localId === 'global'
                        || (filtroLocal === '' ? legacyMatch : localId === filtroLocal);
                    if (!matches) return;
                }

                backupData[col].push(serializeBackupValue({ ...data, id: docSnap.id })); 
            }); 
        });
        
        const blob = new Blob([JSON.stringify(backupData)], { type: 'application/json;charset=utf-8' });
        const downloadUrl = URL.createObjectURL(blob);
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", downloadUrl);
        downloadAnchorNode.setAttribute("download", `Backup_${filtroLocal==='todas'?'General':(filtroLocal || 'SinAsignar')}_${getTodayDateStr()}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
        
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Archivo JSON descargado', 'emerald');
    } catch (e) {
        if(window.mostrarAlerta) window.mostrarAlerta('Error Crítico', 'No se pudo generar el archivo de respaldo.', 'red');
    }
}

async function handleImportBackup(e) {
    const file = e.target.files[0];
    if (!file) return;

    // La misma selección visible controla exportación y restauración. Antes se
    // consultaban chkImp*, elementos que no existen en la interfaz.
    const chkInv = document.getElementById('chkExpInv')?.checked; 
    const chkVentas = document.getElementById('chkExpVentas')?.checked; 
    const chkConf = document.getElementById('chkExpConf')?.checked;
    
    document.getElementById('importFileInput').value = '';

    if (!chkInv && !chkVentas && !chkConf) { 
        if(window.mostrarAlerta) window.mostrarAlerta('Error', 'Selecciona qué áreas restaurar.', 'amber'); 
        return;
    }
    
    if(window.mostrarConfirmacion) {
        window.mostrarConfirmacion('Se reemplazarán los documentos incluidos en el archivo. Los registros adicionales actuales no se borrarán. ¿Continuar?', () => {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const data = JSON.parse(e.target.result);
                    if (!data || Array.isArray(data) || typeof data !== 'object') {
                        throw new Error('Formato de respaldo inválido');
                    }

                    if (window.mostrarAlerta) window.mostrarAlerta('Restaurando', 'Aplicando respaldo...', 'sky');
                    
                    const colPermitidas = [];
                    
                    if(chkInv) colPermitidas.push('productos'); 
                    if(chkVentas) colPermitidas.push('ventas', 'caja_diaria', 'gastos'); 
                    if(chkConf) colPermitidas.push('locales', 'usuarios', 'configuracion', 'directorio_login');

                    const documentosParaRestaurar = [];
                    for (const [colName, docs] of Object.entries(data)) { 
                        if(colPermitidas.includes(colName) && Array.isArray(docs)) { 
                            docs.forEach(d => {
                                if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.id !== 'string' || !d.id) return;
                                const docData = deserializeBackupValue({ ...d }); 
                                delete docData.id;
                                documentosParaRestaurar.push({
                                    ref: doc(db, colName, d.id),
                                    data: docData
                                });
                            }); 
                        } 
                    }

                    if (documentosParaRestaurar.length === 0) {
                        if (window.mostrarAlerta) window.mostrarAlerta('Sin datos', 'El archivo no contiene registros de las áreas seleccionadas.', 'amber');
                        return;
                    }

                    // Firestore admite hasta 500 escrituras por lote. Se usan
                    // bloques de 450 para restaurar respaldos grandes sin alterar
                    // el formato { coleccion: [{ id, ...campos }] } existente.
                    for (let i = 0; i < documentosParaRestaurar.length; i += 450) {
                        const batch = writeBatch(db);
                        documentosParaRestaurar.slice(i, i + 450).forEach(item => {
                            batch.set(item.ref, item.data);
                        });
                        await batch.commit();
                    }

                    if (window.mostrarAlerta) window.mostrarAlerta('Éxito', `${documentosParaRestaurar.length} registros restaurados. Reiniciando...`, 'emerald'); 
                    setTimeout(() => window.location.reload(), 2000);
                } catch(err) { 
                    console.error('Error restaurando respaldo:', err);
                    if (window.mostrarAlerta) window.mostrarAlerta('Error', 'El archivo está corrupto, no es válido o no pudo restaurarse.', 'red');
                }
            };
            reader.readAsText(file);
        });
    }
}

// -----------------------------------------------------
// 4. NUEVO: ESCÁNER HISTÓRICO DE POPULARIDAD
// -----------------------------------------------------
async function sincronizarPopularidad() {
    if (!window.mostrarConfirmacion) return;
    window.mostrarConfirmacion("¿Deseas escanear el historial de ventas para identificar los productos más populares?", async () => {
        const btn = document.getElementById('btn-sincronizar-popularidad');
        if(!btn) return;
        
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline mr-2"></i> Escaneando Base de Datos...';
        btn.disabled = true;
        if(window.lucide) window.lucide.createIcons({ root: btn });

        try {
            // 1. Obtener TODO el historial de ventas de forma segura
            const ventasSnap = await getDocs(collection(db, "ventas"));
            const contadorProductos = {};

            // 2. Tally: Contar las cantidades vendidas de cada producto (ignorando los rechazados)
            ventasSnap.forEach(docSnap => {
                const venta = docSnap.data();
                if (String(venta.estado || '').toLowerCase() !== 'rechazado') {
                    const movements = Array.isArray(venta.inventarioMovimientos)
                        && venta.inventarioMovimientos.length > 0
                        ? venta.inventarioMovimientos
                        : buildLegacyInventoryMovements(venta.items);

                    movements.forEach(movement => {
                        const productId = movement?.productoId || movement?.id;
                        const quantity = Number(movement?.cantidad || 0);
                        if (productId && Number.isFinite(quantity) && quantity > 0) {
                            contadorProductos[productId] =
                                (contadorProductos[productId] || 0) + quantity;
                        }
                    });
                }
            });

            // 3. Actualizar la base de datos de productos por Lotes (Batch) para no saturar la red
            let currentBatch = writeBatch(db);
            let operationCount = 0;
            let totalActualizados = 0;

            for (const prod of state.productos) {
                const totalVendido = contadorProductos[prod.id] || 0;
                
                currentBatch.update(doc(db, "productos", prod.id), { 
                    ventasTotales: totalVendido 
                });
                
                // Actualizar también en RAM de inmediato para la UI actual
                prod.ventasTotales = totalVendido;

                operationCount++;
                totalActualizados++;

                // Límite de Firebase: 500 operaciones por Batch
                if (operationCount >= 490) {
                    await currentBatch.commit();
                    currentBatch = writeBatch(db);
                    operationCount = 0;
                }
            }

            // Enviar cualquier sobrante
            if (operationCount > 0) {
                await currentBatch.commit();
            }

            if(window.mostrarAlerta) {
                window.mostrarAlerta(
                    "Análisis Completado", 
                    `Se escanearon <b>${ventasSnap.size} tickets</b> exitosamente.<br>Se actualizaron <b>${totalActualizados} productos</b> con su nueva popularidad de ventas.`, 
                    "emerald"
                );
            }

            // Si estamos en la ventana de ventas, forzamos un re-render para ordenarlo
            if (window.renderProductosVenta) {
                window.renderProductosVenta();
            }

        } catch (error) {
            console.error("Error al sincronizar popularidad:", error);
            if(window.mostrarAlerta) window.mostrarAlerta("Fallo en Operación", "No se pudo escanear el historial debido a un error de conexión.", "red");
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
            if(window.lucide) window.lucide.createIcons({ root: btn });
        }
    });
}


// -----------------------------------------------------
// 5. CUENTA REGRESIVA Y BORRADO SEGURO DE DATOS
// -----------------------------------------------------
let deleteTimer = null;

function iniciarBorradoSeguro() {
    // 1. Doble validación de seguridad
    if (state.userRole !== 'master') {
        if(window.mostrarAlerta) window.mostrarAlerta("Acceso Restringido", "Esta acción es irreversible y requiere privilegios de Dueño Supremo.", "red");
        return;
    }

    // 2. Leer qué quiere borrar
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
    if(window.lucide) window.lucide.createIcons({ root: overlay });

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
            if(window.lucide) window.lucide.createIcons({ root: overlay });
            
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
