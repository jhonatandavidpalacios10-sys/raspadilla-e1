import { auth, db, doc, getDoc, setDoc, signInWithEmailAndPassword, signOut, onAuthStateChanged } from './firebase-setup.js';
import { state } from './store.js';
const MASTER_UID = "kRG6hOWsWHfoJwWLCXAkqRuVNLk2";
export function initAuth() {
    onAuthStateChanged(auth, async (user) => {
        const loginScreen = document.getElementById('login-screen'); const appContainer = document.getElementById('app-container');
        if (user) {
            state.currentUser = user;
            try {
                const userDoc = await getDoc(doc(db, "usuarios", user.uid));
                let r = 'vendedor', l = 'Sin Local', lId = '';
                if (userDoc.exists()) { r = userDoc.data().rol || 'vendedor'; l = userDoc.data().localNombre || 'Sin Local'; lId = userDoc.data().localId || ''; }
                if (user.uid === MASTER_UID) { r = 'master'; l = 'Dueño Supremo'; }
                await setDoc(doc(db, "usuarios", user.uid), { email: user.email, rol: r, localNombre: l, localId: lId, ultimoAcceso: new Date().toISOString() }, { merge: true });
                state.userRole = r; state.userLocal = l; state.userLocalId = lId;
                ['user-local-display', 'user-local-display-desktop', 'user-local-display-mobile'].forEach(id => { const el = document.getElementById(id); if(el) el.textContent = `${l} - ${user.email.split('@')[0]}`; });
            } catch (e) { console.error(e); state.userRole = 'vendedor'; }
            aplicarPermisosVisuales();
            if(loginScreen && appContainer) { loginScreen.classList.add('opacity-0'); setTimeout(() => { loginScreen.classList.add('hidden'); appContainer.classList.remove('hidden'); setTimeout(() => appContainer.classList.remove('opacity-0'), 50); }, 300); }
        } else {
            state.currentUser = null; state.userRole = null;
            if(loginScreen && appContainer) { appContainer.classList.add('opacity-0'); setTimeout(() => { appContainer.classList.add('hidden'); loginScreen.classList.remove('hidden'); setTimeout(() => loginScreen.classList.remove('opacity-0'), 50); }, 300); }
        }
    });
}
function aplicarPermisosVisuales() {
    const adminEls = document.querySelectorAll('.solo-admin');
    const btns = [document.getElementById('nav-caja'), document.getElementById('nav-analisis'), document.getElementById('nav-usuarios'), document.getElementById('nav-respaldo')];
    if (state.userRole === 'admin' || state.userRole === 'master') { adminEls.forEach(e => e.classList.remove('hidden')); btns.forEach(b => { if(b) b.classList.remove('hidden'); }); } 
    else { adminEls.forEach(e => e.classList.add('hidden')); btns.forEach(b => { if(b) b.classList.add('hidden'); }); }
}
export async function login(e, p) { return await signInWithEmailAndPassword(auth, e, p); }
export async function logout() { return await signOut(auth); }