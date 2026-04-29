import { initAuth, login, logout } from './core/auth.js';
import { initVentas } from './components/ui-ventas.js'; 
import { initInventario } from './components/ui-inventario.js';
import { initCaja } from './components/ui-caja.js'; 
import { initUsuarios, cargarUsuariosYLocales } from './components/ui-usuarios.js';
import { initPedidos } from './components/ui-pedidos.js'; 
import { initAnalisis } from './components/ui-analisis.js'; 
import { initRespaldo } from './components/ui-respaldo.js';
import { auth, onAuthStateChanged } from './core/firebase-setup.js';

// ---- REGISTRO DEL SERVICE WORKER (Background Sync & Offline) ----
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(registration => {
                console.log('ServiceWorker registrado con éxito con alcance:', registration.scope);
            })
            .catch(error => {
                console.error('El registro del ServiceWorker falló:', error);
            });
    });
}
// -----------------------------------------------------------------

// ---- LÓGICA DE PERFILES LOCALES (INICIO RÁPIDO) ----
function getSavedAccounts() {
    try { return JSON.parse(localStorage.getItem('icepos_accounts')) || []; } catch(e) { return []; }
}

function saveAccount(email, pass) {
    let accs = getSavedAccounts();
    const username = email.split('@')[0];
    const encodedPass = btoa(pass); // Ofuscación básica para localStorage
    const existingIdx = accs.findIndex(a => a.email === email);
    
    if (existingIdx >= 0) {
        accs[existingIdx].pass = encodedPass;
    } else {
        accs.push({ email, username, pass: encodedPass });
    }
    localStorage.setItem('icepos_accounts', JSON.stringify(accs));
}

function removeAccount(email) {
    let accs = getSavedAccounts();
    accs = accs.filter(a => a.email !== email);
    localStorage.setItem('icepos_accounts', JSON.stringify(accs));
    renderProfiles();
}

function renderProfiles() {
    const accs = getSavedAccounts();
    const profilesSec = document.getElementById('login-profiles-section');
    const manualSec = document.getElementById('login-manual-section');
    const list = document.getElementById('saved-profiles-list');
    const btnVolver = document.getElementById('btn-show-profiles');
    const subtitle = document.getElementById('login-subtitle');

    if (accs.length > 0) {
        if(subtitle) subtitle.textContent = "Selecciona tu cuenta";
        profilesSec.classList.remove('hidden');
        profilesSec.classList.add('flex');
        manualSec.classList.add('hidden');
        btnVolver.classList.remove('hidden');

        list.innerHTML = accs.map(a => `
            <div class="relative group">
                <button data-action="quick-login" data-email="${a.email}" data-pass="${a.pass}" class="flex flex-col items-center gap-2 p-3 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-sky-500 rounded-xl transition-all w-20 sm:w-24 active:scale-95">
                    <div class="w-10 h-10 bg-sky-500 text-white rounded-full flex items-center justify-center shrink-0 shadow-lg shadow-sky-500/30">
                        <i data-lucide="user" class="w-5 h-5"></i>
                    </div>
                    <span class="text-[10px] sm:text-xs font-bold text-slate-800 dark:text-white truncate w-full text-center">${a.username}</span>
                </button>
                <button data-action="remove-profile" data-email="${a.email}" class="absolute -top-1.5 -right-1.5 bg-red-500 hover:bg-red-600 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
                    <i data-lucide="x" class="w-3 h-3"></i>
                </button>
            </div>
        `).join('');
        if(window.lucide) window.lucide.createIcons();
    } else {
        if(subtitle) subtitle.textContent = "Punto de Venta Profesional";
        profilesSec.classList.add('hidden');
        profilesSec.classList.remove('flex');
        manualSec.classList.remove('hidden');
        btnVolver.classList.add('hidden');
    }
}
// ---------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    initAuth(); 
    let datosCargados = false;
    
    renderProfiles();

    document.getElementById('btn-show-manual-login')?.addEventListener('click', () => {
        document.getElementById('login-profiles-section').classList.add('hidden');
        document.getElementById('login-profiles-section').classList.remove('flex');
        document.getElementById('login-manual-section').classList.remove('hidden');
        if(document.getElementById('login-subtitle')) document.getElementById('login-subtitle').textContent = "Ingresa tus credenciales";
    });

    document.getElementById('btn-show-profiles')?.addEventListener('click', () => {
        renderProfiles(); 
    });

    document.getElementById('saved-profiles-list')?.addEventListener('click', async (e) => {
        const btnLogin = e.target.closest('button[data-action="quick-login"]');
        const btnRemove = e.target.closest('button[data-action="remove-profile"]');

        if (btnRemove) {
            removeAccount(btnRemove.dataset.email);
            return;
        }

        if (btnLogin) {
            const email = btnLogin.dataset.email;
            const pass = atob(btnLogin.dataset.pass);
            
            const originalHtml = btnLogin.innerHTML;
            btnLogin.innerHTML = '<div class="w-10 h-10 flex items-center justify-center shrink-0"><i data-lucide="loader-2" class="w-6 h-6 animate-spin text-sky-500"></i></div><span class="text-xs font-bold text-sky-500 mt-2">Cargando...</span>';
            if(window.lucide) window.lucide.createIcons();
            
            try {
                await login(email, pass);
            } catch (err) {
                btnLogin.innerHTML = originalHtml;
                if(window.lucide) window.lucide.createIcons();
                if(window.mostrarAlerta) window.mostrarAlerta('Credenciales Caducadas', 'La contraseña fue cambiada o el usuario no existe. Inicia sesión manualmente.', 'amber');
                removeAccount(email);
            }
        }
    });

    // Escuchador del Estado de Autenticación
    onAuthStateChanged(auth, async (user) => {
        if (user && !datosCargados) {
            try {
                // 1. PRIMERO cargar usuarios y locales (para que los filtros se llenen de datos)
                await initUsuarios(); 
                await cargarUsuariosYLocales(); 
                
                // 2. DESPUÉS cargar el inventario (que depende de los locales)
                await initInventario(); 
                
                // 3. FINALMENTE inicializar las vistas que dependen de que los filtros ya existan
                initVentas(); 
                initPedidos(); 
                initRespaldo();
                initCaja(); 
                initAnalisis(); 
                
                datosCargados = true;
            } catch(e) {
                console.error("Error inicializando componentes modulares:", e);
                // Forzamos a true para que deje al usuario entrar, aunque alguna parte no cargue bien
                datosCargados = true; 
            }
        } else if (!user) { 
            datosCargados = false; 
            renderProfiles();
        }
    });

    const lf = document.getElementById('login-form'); 
    const bs = document.getElementById('btn-submit-login');
    
    if (lf) {
        lf.addEventListener('submit', async (e) => {
            e.preventDefault(); 
            document.getElementById('login-error').classList.add('hidden');
            const ot = bs.innerHTML; 
            bs.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> Conectando...'; 
            bs.disabled = true;
            
            try { 
                const inputUser = document.getElementById('login-username');
                const rawUser = inputUser.value.trim().toLowerCase();
                const finalEmail = rawUser.includes('@') ? rawUser : rawUser + '@raspadillas.com';
                const pass = document.getElementById('login-password').value;
                
                await login(finalEmail, pass); 
                saveAccount(finalEmail, pass);

                setTimeout(() => { bs.innerHTML = ot; bs.disabled = false; }, 1000); 
            } catch (err) { 
                document.getElementById('login-error').classList.remove('hidden'); 
                bs.innerHTML = ot; 
                bs.disabled = false; 
                if(window.lucide) window.lucide.createIcons(); 
            }
        });
    }
    
    // Función de Cerrar Sesión
    const hL = async () => { 
        try { 
            await logout(); 
            if(lf) lf.reset(); 
            if(bs) { bs.innerHTML = 'Ingresar al Sistema'; bs.disabled = false; } 
            if(window.switchView) window.switchView('ventas'); 
        } catch (e) { 
            console.error("Error cerrando sesión:", e); 
        } 
    };
    
    document.getElementById('btn-logout-desktop')?.addEventListener('click', hL); 
    document.getElementById('btn-logout-mobile')?.addEventListener('click', hL);
});
