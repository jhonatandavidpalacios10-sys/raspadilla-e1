import { auth, db, doc, setDoc, signInWithEmailAndPassword, signOut, onAuthStateChanged, onSnapshot } from './firebase-setup.js';
import { state } from './store.js';

const MASTER_UID = "kRG6hOWsWHfoJwWLCXAkqRuVNLk2";
let userUnsubscribe = null;
let sysUnsubscribe = null;
let isSystemLocked = false;

export function initAuth() {
    onAuthStateChanged(auth, async (user) => {
        const loginScreen = document.getElementById('login-screen'); 
        const appContainer = document.getElementById('app-container');
        
        // Limpiar escuchadores anteriores si existen
        if (userUnsubscribe) { userUnsubscribe(); userUnsubscribe = null; }
        if (sysUnsubscribe) { sysUnsubscribe(); sysUnsubscribe = null; }

        if (user) {
            state.currentUser = user;
            
            // 1. Escuchar el estado de Pago/Bloqueo del sistema globalmente
            sysUnsubscribe = onSnapshot(doc(db, "configuracion", "estado_sistema"), (sysDoc) => {
                if (sysDoc.exists() && sysDoc.data().cerrado === true) {
                    isSystemLocked = true;
                } else {
                    isSystemLocked = false;
                }
                verificarBloqueoSistema(user);
            });

            // 2. Escucha en TIEMPO REAL los cambios en tu propio documento de usuario
            userUnsubscribe = onSnapshot(doc(db, "usuarios", user.uid), async (userDoc) => {
                let r = 'vendedor', l = 'Sin Local', lId = '';
                let userData = null;
                
                if (userDoc.exists()) { 
                    userData = userDoc.data();
                    r = userData.rol || 'vendedor'; 
                    l = userData.localNombre || 'Sin Local'; 
                    lId = userData.localId || ''; 
                }
                
                // Si eres el DUEÑO PRINCIPAL, tu rol está blindado por código
                if (user.uid === MASTER_UID) { r = 'master'; l = 'Dueño Supremo'; }
                
                state.userRole = r; state.userLocal = l; state.userLocalId = lId;
                
                // Actualizar nombres en la pantalla
                ['user-local-display', 'user-local-display-desktop', 'user-local-display-mobile'].forEach(id => { 
                    const el = document.getElementById(id); 
                    if(el) el.textContent = `${l} - ${user.email.split('@')[0]}`; 
                });
                
                // Refrescar qué menús puedes ver en ese exacto segundo
                aplicarPermisosVisuales(userData);
            });

            // Asegurar que el usuario exista en la BD (último acceso)
            await setDoc(doc(db, "usuarios", user.uid), { email: user.email, ultimoAcceso: new Date().toISOString() }, { merge: true });
            
            if(loginScreen && appContainer) { 
                loginScreen.classList.add('opacity-0'); 
                setTimeout(() => { 
                    loginScreen.classList.add('hidden'); 
                    // Solo mostramos la app si no está bloqueada, o si eres el Master
                    if(!isSystemLocked || user.uid === MASTER_UID) {
                        appContainer.classList.remove('hidden'); 
                        setTimeout(() => appContainer.classList.remove('opacity-0'), 50); 
                    }
                }, 300); 
            }
        } else {
            state.currentUser = null; state.userRole = null;
            if(loginScreen && appContainer) { 
                appContainer.classList.add('opacity-0'); 
                setTimeout(() => { appContainer.classList.add('hidden'); loginScreen.classList.remove('hidden'); setTimeout(() => loginScreen.classList.remove('opacity-0'), 50); }, 300); 
            }
        }
    });
}

// Función que inyecta la pantalla técnica de Error si el sistema está cerrado
function verificarBloqueoSistema(user) {
    const appContainer = document.getElementById('app-container');
    
    // Si está bloqueado y NO es la cuenta Master, mostramos el Error de Servidor (503)
    if (isSystemLocked && user.uid !== MASTER_UID) {
        mostrarError404();
    } else {
        quitarError404();
        if (appContainer && document.getElementById('login-screen').classList.contains('hidden')) {
            appContainer.classList.remove('hidden');
            setTimeout(() => appContainer.classList.remove('opacity-0'), 50);
        }
    }
}

function mostrarError404() {
    let errorDiv = document.getElementById('error-404-screen');
    if (!errorDiv) {
        errorDiv = document.createElement('div');
        errorDiv.id = 'error-404-screen';
        // Diseño que simula una desconexión crítica del servidor en la nube
        errorDiv.className = 'fixed inset-0 z-[300] bg-[#090b14] flex flex-col items-center justify-center text-center p-6 transition-opacity duration-300';
        errorDiv.innerHTML = `
            <div class="flex flex-col items-center max-w-lg text-center font-sans">
                <div class="mb-8 relative">
                    <div class="absolute inset-0 bg-red-600 blur-[60px] opacity-20 rounded-full animate-pulse"></div>
                    <svg class="w-32 h-32 text-slate-800 relative z-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                       <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path>
                    </svg>
                    <div class="absolute bottom-4 right-4 bg-[#090b14] rounded-full p-1 border-4 border-[#090b14] z-20">
                        <svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                    </div>
                </div>
                
                <h1 class="text-4xl md:text-5xl font-black text-white mb-4 tracking-tight drop-shadow-md">503 Service Unavailable</h1>
                
                <div class="bg-slate-900/50 border border-slate-800 rounded-xl p-6 w-full text-left mb-8 shadow-2xl backdrop-blur-sm">
                    <p class="text-red-400 font-mono text-sm mb-3 flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full bg-red-500 animate-ping"></span>
                        ERR_CONNECTION_TIMED_OUT
                    </p>
                    <p class="text-slate-400 text-sm leading-relaxed mb-4">No se pudo establecer conexión con los servidores principales. El nodo de la base de datos ha rechazado la solicitud por tiempo de espera agotado o problemas de enrutamiento en la red.</p>
                    <div class="pt-4 border-t border-slate-800/80 bg-slate-950/30 p-3 rounded-lg">
                        <p class="text-xs text-slate-500 font-mono leading-relaxed">
                            Host: api.db-cluster-south.com<br>
                            Status: <span class="text-red-500">Disconnected (Code 404)</span><br>
                            Timeout: 30000ms<br>
                            Trace ID: ${Math.random().toString(36).substr(2, 9).toUpperCase()}
                        </p>
                    </div>
                </div>
                
                <button id="btn-logout-404" class="px-8 py-3.5 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl font-bold border border-slate-700 transition-colors shadow-lg flex items-center gap-2">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                    Volver e intentar de nuevo
                </button>
            </div>
        `;
        document.body.appendChild(errorDiv);
        document.getElementById('btn-logout-404').addEventListener('click', logout);
    }
    errorDiv.classList.remove('hidden');
    document.getElementById('app-container')?.classList.add('hidden');
    document.getElementById('app-container')?.classList.add('opacity-0');
}

function quitarError404() {
    const errorDiv = document.getElementById('error-404-screen');
    if (errorDiv) {
        errorDiv.classList.add('hidden');
    }
}

function aplicarPermisosVisuales(userDocData) {
    const r = state.userRole;
    const permisosVendedor = userDocData?.permisos || []; // Array de menús permitidos guardados en la BD

    const views = {
        'nav-ventas': document.getElementById('nav-ventas'),
        'nav-pedidos': document.getElementById('nav-pedidos'),
        'nav-inventario': document.getElementById('nav-inventario'),
        'nav-caja': document.getElementById('nav-caja'),
        'nav-analisis': document.getElementById('nav-analisis'),
        'nav-usuarios': document.getElementById('nav-usuarios'),
        'nav-respaldo': document.getElementById('nav-respaldo')
    };

    if (r === 'master') {
        // Master ve TODO
        Object.values(views).forEach(v => v && v.classList.remove('hidden'));
    } 
    else if (r === 'admin' || r === 'Administrador') {
        // Admin ve todo EXCEPTO Respaldo
        Object.values(views).forEach(v => v && v.classList.remove('hidden'));
        if (views['nav-respaldo']) views['nav-respaldo'].classList.add('hidden');
        
        // Si estaba en respaldo, botarlo a ventas
        const viewRespaldo = document.getElementById('view-respaldo');
        if (viewRespaldo && !viewRespaldo.classList.contains('hidden')) window.switchView('ventas');
    } 
    else {
        // Vendedor usa permisos personalizados o los básicos por defecto
        const defaultVendedor = ['nav-ventas', 'nav-pedidos', 'nav-inventario'];
        
        for (const [id, el] of Object.entries(views)) {
            if (!el) continue;
            
            // Verificamos si tiene acceso personalizado (marcado en las casillas), sino usamos default
            const hasAccess = permisosVendedor.length > 0 ? permisosVendedor.includes(id) : defaultVendedor.includes(id);
            
            if (hasAccess) {
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
                // Si el vendedor intentaba ver una sección sin permiso, lo devuelve a ventas
                const viewSection = document.getElementById(id.replace('nav-', 'view-'));
                if (viewSection && !viewSection.classList.contains('hidden')) {
                    window.switchView('ventas');
                }
            }
        }
    }
}

export async function login(e, p) { return await signInWithEmailAndPassword(auth, e, p); }
export async function logout() { return await signOut(auth); }
