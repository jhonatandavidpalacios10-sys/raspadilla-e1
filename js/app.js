import { initAuth, login, logout } from './core/auth.js';
import { initVentas } from './components/ui-ventas.js'; 
import { initInventario } from './components/ui-inventario.js';
import { initCaja } from './components/ui-caja.js'; 
import { initUsuarios, cargarUsuariosYLocales } from './components/ui-usuarios.js';
import { initPedidos } from './components/ui-pedidos.js'; 
import { initAnalisis } from './components/ui-analisis.js'; 
import { initRespaldo } from './components/ui-respaldo.js';
import { auth, onAuthStateChanged, db, doc, getDoc } from './core/firebase-setup.js';
import { state } from './core/store.js';

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

function saveAccount(email, username, pass) {
    let accs = getSavedAccounts();
    const encodedPass = btoa(pass); // Ofuscación básica para localStorage
    const existingIdx = accs.findIndex(a => a.email === email);
    
    if (existingIdx >= 0) {
        accs[existingIdx].pass = encodedPass;
        accs[existingIdx].username = username;
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
        if(profilesSec) {
            profilesSec.classList.remove('hidden');
            profilesSec.classList.add('flex');
        }
        if(manualSec) manualSec.classList.add('hidden');
        if(btnVolver) btnVolver.classList.remove('hidden');

        if(list) {
            list.innerHTML = accs.map(a => `
                <div class="relative group">
                    <button data-action="quick-login" data-email="${a.email}" data-username="${a.username}" data-pass="${a.pass}" class="flex flex-col items-center gap-2 p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-sky-500 rounded-xl transition-all w-20 sm:w-24 active:scale-95 shadow-sm">
                        <div class="w-10 h-10 bg-sky-500 text-white rounded-full flex items-center justify-center shrink-0 shadow-md shadow-sky-500/30">
                            <i data-lucide="user" class="w-5 h-5"></i>
                        </div>
                        <span class="text-[10px] sm:text-xs font-bold text-slate-800 dark:text-white truncate w-full text-center capitalize">${a.username}</span>
                    </button>
                    <button data-action="remove-profile" data-email="${a.email}" class="absolute -top-1.5 -right-1.5 bg-red-500 hover:bg-red-600 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
                        <i data-lucide="x" class="w-3 h-3"></i>
                    </button>
                </div>
            `).join('');
        }
        if(window.lucide) window.lucide.createIcons();
    } else {
        if(subtitle) subtitle.textContent = "Punto de Venta Profesional";
        if(profilesSec) {
            profilesSec.classList.add('hidden');
            profilesSec.classList.remove('flex');
        }
        if(manualSec) manualSec.classList.remove('hidden');
        if(btnVolver) btnVolver.classList.add('hidden');
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
                // SOLUCIÓN AL BUG DE PANTALLAS VACÍAS (Condición de Carrera)
                // Esperamos a que auth.js termine de descargar el perfil y los permisos
                // antes de que los módulos intenten filtrar la información.
                let intentos = 0;
                while (!state.currentUser && intentos < 50) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    intentos++;
                }

                // 1. OBTENER IDENTIDAD PRIMERO (Crucial para filtros de sedes y roles)
                await initUsuarios(); 
                await cargarUsuariosYLocales(); 
                
                // 2. INICIALIZAR VISTAS (Preparar el DOM y exponer funciones globales)
                initVentas(); 
                initPedidos(); 
                initRespaldo();
                initCaja(); 
                initAnalisis(); 
                
                // 3. CARGAR INVENTARIO AL FINAL (Así window.renderProductosVenta ya existe cuando Firebase responda)
                await initInventario(); 
                
                // 4. DOBLE SEGURO: Forzar re-dibujado visual explícito (Garantiza que la UI despierte)
                if (typeof window.cargarInventarioDesdeFirebase === 'function') {
                    await window.cargarInventarioDesdeFirebase();
                }
                if (typeof window.renderProductosVenta === 'function') window.renderProductosVenta();
                if (typeof window.actualizarCarritoUI === 'function') window.actualizarCarritoUI();
                
                datosCargados = true;
            } catch(e) {
                console.error("Error inicializando componentes modulares:", e);
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
            bs.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline"></i> Conectando...'; 
            bs.disabled = true;
            if(window.lucide) window.lucide.createIcons(); // Renderiza el spinner de carga
            
            try { 
                const inputUser = document.getElementById('login-username');
                const rawUser = inputUser.value.trim().toLowerCase();
                const pass = document.getElementById('login-password').value;
                
                let finalEmail = '';
                let displayUsername = rawUser;

                // 1. LÓGICA DE BÚSQUEDA INTELIGENTE (DIRECTORIO PÚBLICO)
                if (rawUser.includes('@')) {
                    finalEmail = rawUser;
                    displayUsername = rawUser.split('@')[0];
                } else {
                    // BUSCAMOS EN EL DIRECTORIO PÚBLICO MEDIANTE GETDOC DIRECTO
                    const dirRef = doc(db, "directorio_login", rawUser);
                    const dirSnap = await getDoc(dirRef);

                    if (dirSnap.exists()) {
                        finalEmail = dirSnap.data().email;
                        displayUsername = dirSnap.data().username;
                    } else {
                        // SALVAVIDAS: Fallback para cuentas antiguas no migradas
                        finalEmail = rawUser + '@raspadillas.com';
                    }
                }
                
                // 2. Ejecutar Login
                await login(finalEmail, pass); 
                
                // 3. Guardar en perfiles locales
                saveAccount(finalEmail, displayUsername, pass);

                setTimeout(() => { bs.innerHTML = ot; bs.disabled = false; }, 1000); 
            } catch (err) { 
                console.error("Error de autenticación:", err);
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
