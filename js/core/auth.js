import { auth, db, doc, setDoc, getDoc, signInWithEmailAndPassword, signOut, onAuthStateChanged, onSnapshot } from './firebase-setup.js';
import { state } from './store.js';

const MASTER_UID = "kRG6hOWsWHfoJwWLCXAkqRuVNLk2";
let userUnsubscribe = null;
let sysUnsubscribe = null;
let isSystemLocked = false;

export function initAuth() {
    onAuthStateChanged(auth, async (user) => {
        const loginScreen = document.getElementById('login-screen'); 
        const appContainer = document.getElementById('app-container');
        
        if (userUnsubscribe) { userUnsubscribe(); userUnsubscribe = null; }
        if (sysUnsubscribe) { sysUnsubscribe(); sysUnsubscribe = null; }

        // 1. Escuchar el estado del sistema y el LOGO GLOBAL
        sysUnsubscribe = onSnapshot(doc(db, "configuracion", "estado_sistema"), (sysDoc) => {
            if (sysDoc.exists()) {
                const data = sysDoc.data();
                isSystemLocked = data.cerrado === true;
                
                if (data.logoUrl) actualizarLogoGlobal(data.logoUrl);
            } else {
                isSystemLocked = false;
            }
            
            if (state.currentUser) verificarBloqueoSistema(state.currentUser);
        });

        if (user) {
            state.currentUser = user;

            // 2. Escucha en TIEMPO REAL los permisos y rol
            userUnsubscribe = onSnapshot(doc(db, "usuarios", user.uid), async (userDoc) => {
                let r = 'vendedor', l = 'Sin Local', lId = '';
                let userData = null;
                
                if (userDoc.exists()) { 
                    userData = userDoc.data();
                    r = userData.rol || 'vendedor'; 
                    l = userData.localNombre || 'Sin Local'; 
                    lId = userData.localId || ''; 
                }
                
                if (user.uid === MASTER_UID) { r = 'master'; l = 'Dueño Supremo'; }
                
                state.userRole = r; state.userLocal = l; state.userLocalId = lId;
                
                ['user-local-display', 'user-local-display-desktop', 'user-local-display-mobile'].forEach(id => { 
                    const el = document.getElementById(id); 
                    if(el) el.textContent = `${l} - ${user.email.split('@')[0]}`; 
                });
                
                aplicarPermisosVisuales(userData);
                verificarBloqueoSistema(user);
            });

            await setDoc(doc(db, "usuarios", user.uid), { email: user.email, ultimoAcceso: new Date().toISOString() }, { merge: true });
            
            if(loginScreen && appContainer) { 
                loginScreen.classList.add('opacity-0'); 
                setTimeout(() => { 
                    loginScreen.classList.add('hidden'); 
                    verificarBloqueoSistema(user);
                }, 300); 
            }
        } else {
            state.currentUser = null; state.userRole = null;
            quitarError404();
            if(loginScreen && appContainer) { 
                appContainer.classList.add('opacity-0'); 
                setTimeout(() => { 
                    appContainer.classList.add('hidden'); 
                    loginScreen.classList.remove('hidden'); 
                    setTimeout(() => loginScreen.classList.remove('opacity-0'), 50); 
                }, 300); 
            }
        }
    });
}

function actualizarLogoGlobal(url) {
    const logosImg = document.querySelectorAll('img[alt="IcePOS Logo"], img[alt="IcePOS"]');
    logosImg.forEach(img => {
        img.src = url; img.style.objectFit = 'contain';
        img.classList.remove('drop-shadow-[0_0_15px_rgba(14,165,233,0.3)]');
        if(img.parentElement.classList.contains('bg-sky-500/20')) {
            img.parentElement.classList.replace('bg-sky-500/20', 'bg-transparent');
        }
    });
    const sidebarIcon = document.querySelector('nav .bg-sky-600.rounded-xl i[data-lucide="snowflake"]');
    if (sidebarIcon) {
        const container = sidebarIcon.parentElement;
        container.innerHTML = `<img src="${url}" class="w-full h-full object-contain p-1" alt="Logo">`;
        container.classList.replace('bg-sky-600', 'bg-transparent');
        container.classList.remove('shadow-lg', 'shadow-sky-500/30');
    }
}

async function verificarBloqueoSistema(user) {
    const appContainer = document.getElementById('app-container');
    const loginScreen = document.getElementById('login-screen');
    let isMaster = (user.uid === MASTER_UID) || (String(state.userRole).trim().toLowerCase() === 'master');

    if (loginScreen && !loginScreen.classList.contains('hidden')) return;

    if (isSystemLocked && !isMaster) {
        try {
            const userDoc = await getDoc(doc(db, "usuarios", user.uid));
            if (userDoc.exists() && String(userDoc.data().rol).trim().toLowerCase() === 'master') {
                isMaster = true; state.userRole = 'master';
            }
        } catch (error) {}
    }
    
    if (isSystemLocked && !isMaster) {
        mostrarError404();
    } else {
        quitarError404();
        if (appContainer && appContainer.classList.contains('hidden')) {
            appContainer.classList.remove('hidden');
            setTimeout(() => appContainer.classList.remove('opacity-0'), 50);
        }
    }
}

function mostrarError404() {
    let errorDiv = document.getElementById('error-404-screen');
    if (!errorDiv) {
        errorDiv = document.createElement('div'); errorDiv.id = 'error-404-screen';
        errorDiv.className = 'fixed inset-0 z-[300] bg-[#090b14] flex flex-col items-center justify-center text-center p-6 transition-opacity duration-300';
        errorDiv.innerHTML = `
            <div class="flex flex-col items-center max-w-lg font-sans">
                <div class="mb-8 relative"><div class="absolute inset-0 bg-red-600 blur-[60px] opacity-20 rounded-full animate-pulse"></div><svg class="w-32 h-32 text-slate-800 relative z-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path></svg><div class="absolute bottom-4 right-4 bg-[#090b14] rounded-full p-1 border-4 border-[#090b14] z-20"><svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width=\"2.5\" d=\"M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z\"></path></svg></div></div>
                <h1 class="text-4xl md:text-5xl font-black text-white mb-4 tracking-tight drop-shadow-md">503 Service Unavailable</h1>
                <div class="bg-slate-900/50 border border-slate-800 rounded-xl p-6 w-full text-left mb-8 shadow-2xl backdrop-blur-sm"><p class="text-red-400 font-mono text-sm mb-3 flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-red-500 animate-ping"></span>ERR_CONNECTION_TIMED_OUT</p><p class="text-slate-400 text-sm leading-relaxed mb-4">No se pudo establecer conexión con los servidores principales. El nodo de la base de datos ha rechazado la solicitud por tiempo de espera agotado o problemas de enrutamiento en la red.</p><div class="pt-4 border-t border-slate-800/80 bg-slate-950/30 p-3 rounded-lg"><p class="text-xs text-slate-500 font-mono leading-relaxed">Host: api.db-cluster-south.com<br>Status: <span class="text-red-500">Disconnected (Code 404)</span><br>Timeout: 30000ms<br>Trace ID: ${Math.random().toString(36).substr(2, 9).toUpperCase()}</p></div></div>
                <button id="btn-logout-404" class="px-8 py-3.5 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl font-bold border border-slate-700 transition-colors shadow-lg flex items-center gap-2"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>Volver e intentar de nuevo</button>
            </div>
        `;
        document.body.appendChild(errorDiv);
        document.getElementById('btn-logout-404').addEventListener('click', logout);
    }
    errorDiv.classList.remove('hidden'); document.getElementById('app-container')?.classList.add('hidden'); document.getElementById('app-container')?.classList.add('opacity-0');
}

function quitarError404() { document.getElementById('error-404-screen')?.classList.add('hidden'); }

function aplicarPermisosVisuales(userDocData) {
    const r = state.userRole;
    const permisosVendedor = userDocData?.permisos || []; 
    const views = { 'nav-ventas': document.getElementById('nav-ventas'), 'nav-pedidos': document.getElementById('nav-pedidos'), 'nav-inventario': document.getElementById('nav-inventario'), 'nav-caja': document.getElementById('nav-caja'), 'nav-analisis': document.getElementById('nav-analisis'), 'nav-usuarios': document.getElementById('nav-usuarios'), 'nav-respaldo': document.getElementById('nav-respaldo') };

    if (r === 'master') {
        Object.values(views).forEach(v => v && v.classList.remove('hidden'));
    } else if (r === 'admin' || r === 'Administrador') {
        Object.values(views).forEach(v => v && v.classList.remove('hidden'));
        if (views['nav-respaldo']) views['nav-respaldo'].classList.add('hidden');
        const viewRespaldo = document.getElementById('view-respaldo');
        if (viewRespaldo && !viewRespaldo.classList.contains('hidden')) window.switchView('ventas');
    } else {
        const defaultVendedor = ['nav-ventas', 'nav-pedidos', 'nav-inventario'];
        for (const [id, el] of Object.entries(views)) {
            if (!el) continue;
            const hasAccess = permisosVendedor.length > 0 ? permisosVendedor.includes(id) : defaultVendedor.includes(id);
            if (hasAccess) el.classList.remove('hidden');
            else {
                el.classList.add('hidden');
                const viewSection = document.getElementById(id.replace('nav-', 'view-'));
                if (viewSection && !viewSection.classList.contains('hidden')) window.switchView('ventas');
            }
        }
    }
}

export async function login(e, p) { return await signInWithEmailAndPassword(auth, e, p); }
export async function logout() { return await signOut(auth); }
