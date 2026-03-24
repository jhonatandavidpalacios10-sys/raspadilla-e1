import { db, collection, getDocs, doc, updateDoc, deleteDoc, setDoc, secondaryAuth, createUserWithEmailAndPassword } from '../core/firebase-setup.js';
import { state } from '../core/store.js';

let listaUsuariosEl, listaLocalesEl, selectLocalUsuario; const MASTER_UID = "kRG6hOWsWHfoJwWLCXAkqRuVNLk2";

export async function initUsuarios() {
    listaUsuariosEl = document.getElementById('usuarios-list'); 
    listaLocalesEl = document.getElementById('locales-list'); 
    selectLocalUsuario = document.getElementById('user-local');
    
    const formUsuario = document.getElementById('form-usuario');
    if(formUsuario) formUsuario.onsubmit = guardarUsuarioSimulado;
    
    const formLocal = document.getElementById('form-local');
    if(formLocal) formLocal.onsubmit = guardarLocal;

    const btnNuevo = document.getElementById('btn-nuevo-usuario');
    if(btnNuevo) btnNuevo.onclick = abrirModalUsuarioConfig;

    const btnCerrar = document.getElementById('btn-cerrar-modal-usuario');
    if(btnCerrar) btnCerrar.onclick = cerrarModalUsuario;
    
    const inN = document.getElementById('user-nombre'); 
    if(inN) inN.oninput = (e) => e.target.value = e.target.value.toLowerCase().replace(/@.*/g, '').replace(/[^a-z0-9_.]/g, '');
    
    if(listaLocalesEl) {
        listaLocalesEl.onclick = e => {
            const btn = e.target.closest('button[data-action]'); if(!btn) return;
            if(btn.dataset.action === 'editar-local') editarLocal(btn.dataset.id);
            else if(btn.dataset.action === 'eliminar-local') eliminarLocal(btn.dataset.id);
        };
    }

    if(listaUsuariosEl) {
        listaUsuariosEl.onclick = e => {
            const btn = e.target.closest('button[data-action]'); if(!btn) return;
            if(btn.dataset.action === 'eliminar-usuario') eliminarUsuario(btn.dataset.uid);
            
            // Lógica para copiar contraseña
            if(btn.dataset.action === 'copiar-pass') {
                navigator.clipboard.writeText(btn.dataset.pass);
                if(window.mostrarToast) window.mostrarToast('Copiado', 'Contraseña en el portapapeles', 'sky');
            }
        };

        listaUsuariosEl.onchange = e => {
            const sel = e.target;
            if(sel.dataset.action === 'cambiar-local') cambiarLocalUsuario(sel.dataset.uid, sel.value);
            else if(sel.dataset.action === 'cambiar-rol') cambiarRolUsuario(sel.dataset.uid, sel.value);
        };
    }
}

function abrirModalUsuarioConfig() { 
    document.getElementById('form-usuario').reset(); 
    document.getElementById('user-id').value = ''; 
    
    // Inyectar Rol Master dinámicamente si el creador es el Master
    const selectRol = document.getElementById('user-rol');
    if(selectRol) {
        selectRol.innerHTML = `<option value="vendedor">Vendedor</option><option value="admin">Administrador</option>`;
        if (state.userRole === 'master') {
            selectRol.innerHTML += `<option value="master" class="font-bold text-amber-400">Master (Dueño)</option>`;
        }
    }

    const m = document.getElementById('modal-usuario'); 
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10); 
}

function cerrarModalUsuario() { const m = document.getElementById('modal-usuario'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300); }

export async function cargarUsuariosYLocales() { await cargarLocales(); await cargarUsuarios(); }
async function cargarLocales() {
    if (!listaLocalesEl) return;
    try {
        const snap = await getDocs(collection(db, "locales")); state.locales = []; let html = '', optionsHtml = '<option value="">Sin Asignar</option>';
        snap.forEach(d => { const loc = { id: d.id, ...d.data() }; state.locales.push(loc); html += `<div class="bg-slate-800 border border-slate-700 p-3 rounded-xl flex items-center justify-between mb-2"><div><span class="font-bold text-white text-sm">${loc.nombre}</span></div><div class="flex gap-2"><button data-action="editar-local" data-id="${loc.id}" class="text-slate-400 hover:text-sky-400 p-1"><i data-lucide="edit" class="w-4 h-4"></i></button><button data-action="eliminar-local" data-id="${loc.id}" class="text-slate-500 hover:text-red-400 p-1"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div></div>`; optionsHtml += `<option value="${loc.id}">${loc.nombre}</option>`; });
        listaLocalesEl.innerHTML = html || '<p class="text-xs text-slate-500 p-2">Sin sucursales.</p>';
        if (selectLocalUsuario) selectLocalUsuario.innerHTML = optionsHtml;
        ['filtro-local-caja', 'analisisLocalFilter'].forEach(f => { const el = document.getElementById(f); if(el) el.innerHTML = '<option value="todas">Todas las Sedes</option>' + optionsHtml; });
    } catch (e) {}
}

async function cargarUsuarios() {
    if (!listaUsuariosEl) return;
    try {
        const snap = await getDocs(collection(db, "usuarios")); let allU = []; snap.forEach(d => allU.push({uid: d.id, ...d.data()}));
        let html = ''; let selectOptions = '<option value="">Sin Local</option>'; state.locales.forEach(l => selectOptions += `<option value="${l.id}">${l.nombre}</option>`);
        state.locales.forEach(loc => { const usrsLoc = allU.filter(u => u.localId === loc.id); if(usrsLoc.length > 0) { html += `<div class="mt-4 mb-2 border-b border-slate-700 pb-1"><h4 class="text-xs font-bold text-sky-400 uppercase tracking-wider">${loc.nombre}</h4></div>`; usrsLoc.forEach(u => html += genU(u, selectOptions)); } });
        const usrsSin = allU.filter(u => !u.localId); if(usrsSin.length > 0) { html += `<div class="mt-4 mb-2 border-b border-slate-700 pb-1"><h4 class="text-xs font-bold text-slate-500 uppercase tracking-wider">Sin Asignar / Master</h4></div>`; usrsSin.forEach(u => html += genU(u, selectOptions)); }
        listaUsuariosEl.innerHTML = html || '<p class="text-xs text-slate-500 p-2">Sin usuarios.</p>'; if (window.lucide) window.lucide.createIcons();
    } catch (e) {}
}

function genU(u, opts) {
    if ((u.rol === 'master' || u.uid === MASTER_UID) && state.currentUser?.uid !== MASTER_UID) return '';
    
    // MAGIA: Mostrar contraseña solo a Admins/Masters
    const isPrivileged = state.userRole === 'admin' || state.userRole === 'master';
    const passHtml = (isPrivileged && u.pass_visible) 
        ? `<div class="flex items-center gap-1 mt-1 bg-slate-900 w-fit px-2 py-0.5 rounded border border-slate-700"><span class="text-[10px] text-sky-400 font-mono tracking-wider">${u.pass_visible}</span><button data-action="copiar-pass" data-pass="${u.pass_visible}" title="Copiar Contraseña" class="text-slate-400 hover:text-white p-0.5"><i data-lucide="copy" class="w-3 h-3"></i></button></div>` 
        : '';

    // Selector de roles (Permite ver el rol Master si el actual es Master)
    let roleOptions = `<option value="vendedor" ${u.rol === 'vendedor' ? 'selected' : ''}>Vendedor</option>
                       <option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Admin</option>`;
    if (state.userRole === 'master') {
        roleOptions += `<option value="master" ${u.rol === 'master' ? 'selected' : ''}>Master</option>`;
    }

    return `<div class="bg-slate-800 border border-slate-700 rounded-xl p-3 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-2 mb-2"><div class="flex items-center gap-3"><div class="w-8 h-8 rounded-full bg-slate-900 flex items-center justify-center text-slate-400 shrink-0"><i data-lucide="user" class="w-4 h-4"></i></div><div><p class="font-bold text-white text-sm">${u.email || 'Sin correo'}</p><p class="text-[10px] text-slate-500">Rol: <span class="uppercase font-bold">${u.rol}</span></p>${passHtml}</div></div>${u.uid === MASTER_UID ? `<span class="bg-purple-500 text-white px-2 py-0.5 rounded text-xs font-bold">Dueño Principal</span>` : `<div class="flex gap-2 w-full lg:w-auto mt-2 lg:mt-0"><select data-action="cambiar-local" data-uid="${u.uid}" class="bg-slate-900 border border-slate-600 text-slate-300 rounded px-1 py-1 text-xs">${opts.replace(`value="${u.localId || ''}"`, `value="${u.localId || ''}" selected`)}</select><select data-action="cambiar-rol" data-uid="${u.uid}" class="bg-slate-900 border border-slate-600 text-slate-300 rounded px-1 py-1 text-xs">${roleOptions}</select><button data-action="eliminar-usuario" data-uid="${u.uid}" class="text-red-400 p-1"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div>`}</div>`;
}

async function editarLocal(id) { /* omitted for brevity */ }
async function guardarLocal(e) { e.preventDefault(); const n = document.getElementById('nuevo-local-nombre').value.trim(); if(n) { await addDoc(collection(db, "locales"), { nombre: n }); cargarUsuariosYLocales(); document.getElementById('nuevo-local-nombre').value = ''; } }
async function eliminarLocal(id) { if(window.mostrarConfirmacion) window.mostrarConfirmacion("¿Eliminar sede?", async () => { await deleteDoc(doc(db, "locales", id)); cargarUsuariosYLocales(); }); }

async function guardarUsuarioSimulado(e) { 
    e.preventDefault(); 
    
    const n = document.getElementById('user-nombre').value.trim(); 
    const email = n + '@raspadillas.com'; 
    const pass = document.getElementById('user-pass').value; 
    const locId = document.getElementById('user-local').value; 
    const rol = document.getElementById('user-rol').value; 
    const loc = state.locales.find(l => l.id === locId); 
    
    const btn = document.querySelector('#form-usuario button[type="submit"]');
    const btnOriginal = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline"></i> Creando...';
    if(window.lucide) window.lucide.createIcons();
    btn.disabled = true;

    try { 
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, pass);
        const nuevoUID = userCredential.user.uid;
        await secondaryAuth.signOut();

        // Se guarda la contraseña en el campo pass_visible
        await setDoc(doc(db, "usuarios", nuevoUID), { 
            email: email, 
            rol: rol, 
            localId: locId, 
            localNombre: loc?.nombre || 'Sin Local',
            creado_manualmente: true,
            pass_visible: pass 
        }); 
        
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta creada con éxito', 'emerald');
        cerrarModalUsuario(); 
        cargarUsuariosYLocales(); 
        
    } catch(error) {
        console.error("DEBUG - ERROR DE FIREBASE:", error);
        alert(`🚨 ERROR AL CREAR USUARIO 🚨\n\nCÓDIGO: ${error.code}\n\nMENSAJE: ${error.message}`);
    } finally {
        btn.innerHTML = btnOriginal;
        btn.disabled = false;
    }
}

async function eliminarUsuario(uid) { if(window.mostrarConfirmacion) window.mostrarConfirmacion("¿Borrar de la lista?", async () => { await deleteDoc(doc(db, "usuarios", uid)); cargarUsuariosYLocales(); }); }
async function cambiarRolUsuario(uid, rol) { await updateDoc(doc(db, "usuarios", uid), { rol }); if(window.mostrarToast) window.mostrarToast('Listo', 'Rol actualizado', 'sky'); }
async function cambiarLocalUsuario(uid, locId) { const l = state.locales.find(x => x.id === locId); await updateDoc(doc(db, "usuarios", uid), { localId: locId, localNombre: l?.nombre||'Sin Local' }); }
