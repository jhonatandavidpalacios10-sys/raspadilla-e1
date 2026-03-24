import { initAuth, login, logout } from './core/auth.js';
import { initVentas } from './components/ui-ventas.js'; import { initInventario } from './components/ui-inventario.js';
import { initCaja } from './components/ui-caja.js'; import { initUsuarios, cargarUsuariosYLocales } from './components/ui-usuarios.js';
import { initPedidos } from './components/ui-pedidos.js'; import { initAnalisis } from './components/ui-analisis.js'; import { initRespaldo } from './components/ui-respaldo.js';
import { auth, onAuthStateChanged } from './core/firebase-setup.js';

document.addEventListener("DOMContentLoaded", () => {
    initAuth(); let datosCargados = false;
    
    onAuthStateChanged(auth, async (user) => {
        if (user && !datosCargados) {
            initVentas(); initCaja(); initPedidos(); initAnalisis(); initRespaldo();
            await initUsuarios(); await initInventario(); 
            cargarUsuariosYLocales(); datosCargados = true;
        } else if (!user) { datosCargados = false; }
    });

    const lf = document.getElementById('login-form'); const bs = document.getElementById('btn-submit-login');
    if (lf) {
        lf.addEventListener('submit', async (e) => {
            e.preventDefault(); document.getElementById('login-error').classList.add('hidden');
            const ot = bs.innerHTML; bs.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> Conectando...'; bs.disabled = true;
            try { 
                // MAGIA: Auto-completar el correo si el usuario solo pone su nombre
                const inputUser = document.getElementById('login-username') || document.getElementById('login-email');
                const rawUser = inputUser.value.trim().toLowerCase();
                const finalEmail = rawUser.includes('@') ? rawUser : rawUser + '@raspadillas.com';
                
                await login(finalEmail, document.getElementById('login-password').value); 
                setTimeout(() => { bs.innerHTML = ot; bs.disabled = false; }, 1000); 
            } catch (err) { 
                document.getElementById('login-error').classList.remove('hidden'); bs.innerHTML = ot; bs.disabled = false; if(window.lucide) window.lucide.createIcons(); 
            }
        });
    }
    
    const hL = async () => { 
        try { 
            await logout(); 
            if(lf) lf.reset(); 
            if(bs) { bs.innerHTML = 'Ingresar'; bs.disabled = false; } 
            if(window.switchView) window.switchView('ventas'); 
        } catch (e) { console.error(e); } 
    };
    
    document.getElementById('btn-logout-desktop')?.addEventListener('click', hL); 
    document.getElementById('btn-logout-mobile')?.addEventListener('click', hL);
});
