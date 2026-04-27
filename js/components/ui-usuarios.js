import { db, collection, getDocs, doc, updateDoc, deleteDoc, setDoc, secondaryAuth, createUserWithEmailAndPassword, updatePassword, signInWithEmailAndPassword, query, where } from '../core/firebase-setup.js';
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
            
            if(btn.dataset.action === 'copiar-pass') {
                navigator.clipboard.writeText(btn.dataset.pass);
                if(window.mostrarToast) window.mostrarToast('Copiado', 'Contraseña copiada', 'sky');
            }

            if(btn.dataset.action === 'editar-pass') {
                abrirModalEditarUsuario(btn.dataset.uid, btn.dataset.email, btn.dataset.oldpass, btn.dataset.rol, btn.dataset.localid, btn.dataset.localnombre);
            }
        };

        listaUsuariosEl.onchange = e => {
            const sel = e.target;
            if(sel.dataset.action === 'cambiar-local') cambiarLocalUsuario(sel.dataset.uid, sel.value);
            else if(sel.dataset.action === 'cambiar-rol') cambiarRolUsuario(sel.dataset.uid, sel.value);
        };
    }
}

function abrirModalEditarUsuario(uid, email, oldPass, rol, localId, localNombre) {
    let m = document.getElementById('modal-editar-usuario');
    if(!m) {
        m = document.createElement('div');
        m.id = 'modal-editar-usuario';
        m.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] hidden flex items-center justify-center px-4 transition-opacity duration-300 opacity-0';
        m.innerHTML = `
            <div class="bg-slate-800 p-6 rounded-2xl shadow-2xl w-full max-w-sm border border-slate-700">
                <h3 class="text-lg font-bold text-white mb-4">Editar Usuario / Contraseña</h3>
                
                <input type="hidden" id="edit-target-uid">
                <input type="hidden" id="edit-target-oldpass">
                <input type="hidden" id="edit-target-email">
                <input type="hidden" id="edit-target-rol">
                <input type="hidden" id="edit-target-localId">
                <input type="hidden" id="edit-target-localNombre">

                <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Nombre de Usuario</label>
                <div class="flex mb-3">
                    <input type="text" id="edit-user-nombre" autocomplete="off" class="flex-1 bg-slate-900 border border-slate-700 rounded-l-lg px-3 py-2 text-white lowercase outline-none focus:border-sky-500">
                    <span class="bg-slate-700 border-y border-r border-slate-700 rounded-r-lg px-2 py-2 text-xs text-slate-400 flex items-center">@raspadillas.com</span>
                </div>

                <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Nueva Contraseña</label>
                <input type="text" id="edit-user-pass" autocomplete="off" spellcheck="false" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white outline-none focus:border-sky-500 mb-5">
                
                <div class="flex gap-2">
                    <button id="btn-cancel-edit-user" class="flex-1 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-xl font-bold transition-colors">Cancelar</button>
                    <button id="btn-confirm-edit-user" class="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 text-white rounded-xl font-bold transition-colors">Guardar</button>
                </div>
            </div>
        `;
        document.body.appendChild(m);

        document.getElementById('btn-cancel-edit-user').onclick = () => { m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300); };
        document.getElementById('btn-confirm-edit-user').onclick = ejecutarEditarUsuario;
        document.getElementById('edit-user-nombre').oninput = (e) => e.target.value = e.target.value.toLowerCase().replace(/@.*/g, '').replace(/[^a-z0-9_.]/g, '');
    }

    document.getElementById('edit-target-uid').value = uid;
    document.getElementById('edit-target-oldpass').value = oldPass || '';
    document.getElementById('edit-target-email').value = email;
    document.getElementById('edit-target-rol').value = rol;
    document.getElementById('edit-target-localId').value = localId;
    document.getElementById('edit-target-localNombre').value = localNombre;
    
    document.getElementById('edit-user-nombre').value = email.split('@')[0];
    document.getElementById('edit-user-pass').value = oldPass || '';

    m.classList.remove('hidden'); setTimeout(() => m.classList.remove('opacity-0'), 10);
}

async function ejecutarEditarUsuario() {
    const uid = document.getElementById('edit-target-uid').value;
    const oldPass = document.getElementById('edit-target-oldpass').value;
    const currentEmail = document.getElementById('edit-target-email').value;
    
    const newUsername = document.getElementById('edit-user-nombre').value.trim();
    const newEmail = newUsername + '@raspadillas.com';
    const newPass = document.getElementById('edit-user-pass').value.trim();
    
    const rol = document.getElementById('edit-target-rol').value;
    const localId = document.getElementById('edit-target-localId').value;
    const localNombre = document.getElementById('edit-target-localNombre').value;

    if (newUsername.length < 3) { if(window.mostrarToast) window.mostrarToast('Error', 'Usuario muy corto', 'amber'); return; }
    if (newPass.length < 6) { if(window.mostrarToast) window.mostrarToast('Error', 'Mínimo 6 caracteres', 'amber'); return; }

    if (currentEmail === newEmail && newPass === oldPass) {
        const m = document.getElementById('modal-editar-usuario'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300);
        return;
    }

    const btn = document.getElementById('btn-confirm-edit-user'); const originalText = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline"></i> Guardando...'; if(window.lucide) window.lucide.createIcons(); btn.disabled = true;

    try {
        if (currentEmail !== newEmail) {
            const secCred = await createUserWithEmailAndPassword(secondaryAuth, newEmail, newPass);
            const nuevoUID = secCred.user.uid;
            await secondaryAuth.signOut();

            await setDoc(doc(db, "usuarios", nuevoUID), { 
                email: newEmail, rol: rol, localId: localId, localNombre: localNombre, 
                creado_manualmente: true, pass_visible: newPass, activo: true 
            });
            
            // Aquí sí aplicamos el soft-delete al viejo
            await updateDoc(doc(db, "usuarios", uid), { activo: false });
            if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta recreada con nuevo usuario', 'emerald');
        } 
        else {
            if (uid === state.currentUser.uid) { 
                await updatePassword(state.currentUser, newPass); 
            } else {
                if(!oldPass) throw new Error("no_old_pass");
                const secCred = await signInWithEmailAndPassword(secondaryAuth, currentEmail, oldPass);
                await updatePassword(secCred.user, newPass); await secondaryAuth.signOut();
            }
            await updateDoc(doc(db, "usuarios", uid), { pass_visible: newPass, activo: true });
            if(window.mostrarToast) window.mostrarToast('Éxito', 'Contraseña actualizada', 'emerald');
        }

        const m = document.getElementById('modal-editar-usuario'); m.classList.add('opacity-0'); setTimeout(() => m.classList.add('hidden'), 300);
        cargarUsuariosYLocales();
    } catch (err) {
        console.error(err); 
        if(err.message === 'no_old_pass') {
            if(window.mostrarAlerta) window.mostrarAlerta('Contraseña Oculta', 'No podemos actualizar la clave directamente porque la original está oculta en Firebase.<br><br>Para forzar el cambio, <b>modifica también el Nombre de Usuario</b> (ej: añade un número o letra). Esto recreará la cuenta limpia y solucionará el problema.', 'amber');
        } else if(err.code === 'auth/email-already-in-use') {
            if(window.mostrarAlerta) window.mostrarAlerta('Usuario Ocupado', 'Ese nuevo nombre de usuario ya existe. Elige otro diferente.', 'amber');
        } else if(err.code === 'auth/requires-recent-login') {
            if(window.mostrarAlerta) window.mostrarAlerta('Seguridad', 'Por seguridad, cierra tu sesión y vuelve a entrar para cambiar TU propia clave.', 'red');
        } else {
            if(window.mostrarAlerta) window.mostrarAlerta('Error', err.message, 'red'); else alert(err.message);
        }
    } finally { btn.innerHTML = originalText; btn.disabled = false; }
}

function abrirModalUsuarioConfig() { 
    document.getElementById('form-usuario').reset(); document.getElementById('user-id').value = ''; 
    const selectRol = document.getElementById('user-rol');
    if(selectRol) {
        selectRol.innerHTML = `<option value="vendedor">Vendedor</option><option value="admin">Administrador</option>`;
        if (state.userRole === 'master') { selectRol.innerHTML += `<option value="master" class="font-bold text-amber-400">Master (Dueño)</option>`; }
    }
    const m = document.getElementById('modal-usuario'); m.classList.remove('hidden'); setTimeout(() => m.classList.remove('opacity-0'), 10); 
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
        const snap = await getDocs(collection(db, "usuarios")); let allU = []; 
        // FILTRO IMPORTANTE: Solo mostramos los usuarios que NO tengan activo en false.
        snap.forEach(d => {
            const data = d.data();
            if (data.activo !== false) {
                allU.push({uid: d.id, ...data});
            }
        });
        
        let html = ''; let selectOptions = '<option value="">Sin Local</option>'; state.locales.forEach(l => selectOptions += `<option value="${l.id}">${l.nombre}</option>`);
        state.locales.forEach(loc => { const usrsLoc = allU.filter(u => u.localId === loc.id); if(usrsLoc.length > 0) { html += `<div class="mt-4 mb-2 border-b border-slate-700 pb-1"><h4 class="text-xs font-bold text-sky-400 uppercase tracking-wider">${loc.nombre}</h4></div>`; usrsLoc.forEach(u => html += genU(u, selectOptions)); } });
        const usrsSin = allU.filter(u => !u.localId); if(usrsSin.length > 0) { html += `<div class="mt-4 mb-2 border-b border-slate-700 pb-1"><h4 class="text-xs font-bold text-slate-500 uppercase tracking-wider">Sin Asignar / Master</h4></div>`; usrsSin.forEach(u => html += genU(u, selectOptions)); }
        listaUsuariosEl.innerHTML = html || '<p class="text-xs text-slate-500 p-2">Sin usuarios.</p>'; if (window.lucide) window.lucide.createIcons();
    } catch (e) {}
}

function genU(u, opts) {
    const isThisCardMaster = u.rol === 'master' || u.uid === MASTER_UID;
    if (isThisCardMaster && state.userRole !== 'master') return ''; 
    
    const isPrivileged = state.userRole === 'admin' || state.userRole === 'Administrador' || state.userRole === 'master';
    const isMe = (u.uid === state.currentUser?.uid);
    
    let passDisplay = u.pass_visible || 'Oculta';
    let passHtml = '';
    
    if (isPrivileged) {
        const btnEditHtml = state.userRole === 'master' ? `<button data-action="editar-pass" data-uid="${u.uid}" data-email="${u.email}" data-oldpass="${u.pass_visible || ''}" data-rol="${u.rol}" data-localid="${u.localId || ''}" data-localnombre="${u.localNombre || ''}" title="Editar Usuario y Contraseña" class="text-amber-400 hover:text-white p-0.5 ml-1"><i data-lucide="edit-3" class="w-3 h-3"></i></button>` : '';
        
        passHtml = `<div class="flex items-center gap-1 mt-1 bg-slate-900 w-fit px-2 py-0.5 rounded border border-slate-700">
            <span class="text-[10px] text-sky-400 font-mono tracking-wider">${passDisplay}</span>
            ${u.pass_visible ? `<button data-action="copiar-pass" data-pass="${u.pass_visible}" title="Copiar Contraseña" class="text-slate-400 hover:text-white p-0.5"><i data-lucide="copy" class="w-3 h-3"></i></button>` : ''}
            ${btnEditHtml}
        </div>`;
    }

    let roleOptions = `<option value="vendedor" ${u.rol === 'vendedor' ? 'selected' : ''}>Vendedor</option>
                       <option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Admin</option>`;
    if (state.userRole === 'master') {
        roleOptions += `<option value="master" ${u.rol === 'master' ? 'selected' : ''}>Master</option>`;
    }

    let cardBorderColor = 'border-slate-700';
    let userIconColor = 'text-sky-400';
    let userIconBg = 'bg-sky-500/10';
    let userIconType = 'user';
    let roleTextColor = 'text-slate-500';

    if (isThisCardMaster) {
        cardBorderColor = 'border-amber-500/50 shadow-lg shadow-amber-500/10';
        userIconColor = 'text-amber-400';
        userIconBg = 'bg-amber-500/20';
        userIconType = 'crown';
        roleTextColor = 'text-amber-400';
    } else if (u.rol === 'admin') {
        cardBorderColor = 'border-purple-500/50 shadow-lg shadow-purple-500/10';
        userIconColor = 'text-purple-400';
        userIconBg = 'bg-purple-500/20';
        userIconType = 'shield-check';
        roleTextColor = 'text-purple-400';
    }

    const renderRoleSelector = isMe 
        ? `<span class="bg-slate-900 border border-slate-700 ${roleTextColor} rounded px-2 py-1 text-xs font-bold uppercase tracking-wider">${u.rol}</span>`
        : `<select data-action="cambiar-rol" data-uid="${u.uid}" class="bg-slate-900 border border-slate-600 text-slate-300 rounded px-1 py-1 text-xs cursor-pointer">${roleOptions}</select>`;

    return `<div class="bg-slate-800 border ${cardBorderColor} rounded-xl p-3 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-2 mb-2 transition-all">
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full ${userIconBg} flex items-center justify-center ${userIconColor} shrink-0"><i data-lucide="${userIconType}" class="w-4 h-4"></i></div>
            <div>
                <p class="font-bold text-white text-sm flex items-center gap-2">${u.email || 'Sin correo'} ${isMe ? '<span class="text-[9px] bg-slate-700 text-white px-1.5 py-0.5 rounded uppercase">Tú</span>' : ''}</p>
                <p class="text-[10px] ${roleTextColor}">Rol: <span class="uppercase font-bold tracking-wide">${u.rol}</span></p>
                ${passHtml}
            </div>
        </div>
        ${(u.uid === MASTER_UID && !isMe) ? `<span class="bg-amber-500 text-white px-2 py-0.5 rounded text-xs font-bold">Dueño Principal</span>` : 
        `<div class="flex gap-2 w-full lg:w-auto mt-2 lg:mt-0">
            <select data-action="cambiar-local" data-uid="${u.uid}" class="bg-slate-900 border border-slate-600 text-slate-300 rounded px-1 py-1 text-xs cursor-pointer">${opts.replace(`value="${u.localId || ''}"`, `value="${u.localId || ''}" selected`)}</select>
            ${renderRoleSelector}
            ${!isMe ? `<button data-action="eliminar-usuario" data-uid="${u.uid}" class="text-red-400 hover:text-red-300 bg-slate-900 border border-slate-700 rounded p-1"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
        </div>`}
    </div>`;
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
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline"></i> Guardando...';
    if(window.lucide) window.lucide.createIcons();
    btn.disabled = true;

    try { 
        // 1. Intentamos crear el usuario
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, pass);
        const nuevoUID = userCredential.user.uid;
        await secondaryAuth.signOut();

        await setDoc(doc(db, "usuarios", nuevoUID), { 
            email: email, 
            rol: rol, 
            localId: locId, 
            localNombre: loc?.nombre || 'Sin Local',
            creado_manualmente: true,
            pass_visible: pass,
            activo: true // Añadido estado activo
        }); 
        
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta creada con éxito', 'emerald');
        cerrarModalUsuario(); 
        cargarUsuariosYLocales(); 
        
    } catch(error) {
        console.error("DEBUG - ERROR DE FIREBASE:", error);
        
        // RECUPERACIÓN DE USUARIO ELIMINADO LÓGICAMENTE
        if (error.code === 'auth/email-already-in-use') {
            try {
                // Buscamos si existe en Firestore pero está oculto
                const q = query(collection(db, "usuarios"), where("email", "==", email));
                const snap = await getDocs(q);
                
                if (!snap.empty) {
                    const existingDoc = snap.docs[0];
                    const existingData = existingDoc.data();
                    
                    if (existingData.activo === false) {
                        // El usuario fue "eliminado", vamos a revivirlo
                        const oldPass = existingData.pass_visible;
                        
                        if (!oldPass) {
                             if(window.mostrarAlerta) window.mostrarAlerta('Error de Recuperación', 'Este usuario fue eliminado y su contraseña original está oculta. No podemos revivirlo de forma segura. Por favor, crea un usuario con un nombre diferente (ej: '+n+'2).', 'amber');
                             return;
                        }

                        // Entramos con la contraseña vieja para poder cambiarla
                        const secCred = await signInWithEmailAndPassword(secondaryAuth, email, oldPass);
                        await updatePassword(secCred.user, pass);
                        await secondaryAuth.signOut();
                        
                        // Actualizamos su documento en Firestore
                        await updateDoc(doc(db, "usuarios", existingDoc.id), { 
                            rol: rol, 
                            localId: locId, 
                            localNombre: loc?.nombre || 'Sin Local',
                            pass_visible: pass,
                            activo: true // Lo volvemos visible
                        });

                        if(window.mostrarToast) window.mostrarToast('Recuperado', 'Cuenta restaurada con éxito', 'emerald');
                        cerrarModalUsuario(); 
                        cargarUsuariosYLocales();
                    } else {
                        // Si está activo y existe
                        if(window.mostrarAlerta) window.mostrarAlerta('Usuario Existente', 'Este nombre de usuario ya está activo en el sistema. Elige otro o edita el actual.', 'amber');
                    }
                } else {
                    // Existe en Firebase Auth pero NO en Firestore (desincronizado)
                    if(window.mostrarAlerta) window.mostrarAlerta('Usuario Ocupado', 'Este usuario existe en la base de datos de credenciales. Elige otro nombre diferente.', 'amber');
                }
            } catch (recoveryError) {
                console.error("Error en recuperación:", recoveryError);
                if(window.mostrarAlerta) window.mostrarAlerta('Error', 'Hubo un fallo al intentar restaurar el usuario. Usa un nombre diferente.', 'red');
            }
        } else if (error.code === 'auth/weak-password') {
            if(window.mostrarToast) window.mostrarToast('Error', 'La contraseña debe tener mínimo 6 caracteres.', 'red');
        } else {
            if(window.mostrarAlerta) window.mostrarAlerta('Error', `No se pudo crear la cuenta.<br><br>Código: ${error.code}`, 'red');
            else alert(`🚨 ERROR AL CREAR USUARIO 🚨\n\nCÓDIGO: ${error.code}\n\nMENSAJE: ${error.message}`);
        }
    } finally {
        btn.innerHTML = btnOriginal;
        btn.disabled = false;
    }
}

// MODIFICADO: Borrado lógico
async function eliminarUsuario(uid) { 
    if(window.mostrarConfirmacion) {
        window.mostrarConfirmacion("¿Borrar usuario de la lista? (Podrá ser restaurado si se vuelve a crear con el mismo nombre)", async () => { 
            await updateDoc(doc(db, "usuarios", uid), { activo: false }); 
            cargarUsuariosYLocales(); 
            if(window.mostrarToast) window.mostrarToast('Eliminado', 'Usuario ocultado correctamente.', 'sky');
        }); 
    }
}

async function cambiarRolUsuario(uid, rol) { 
    await updateDoc(doc(db, "usuarios", uid), { rol }); 
    if(window.mostrarToast) window.mostrarToast('Listo', 'Rol actualizado', 'sky'); 
    cargarUsuariosYLocales(); 
}

async function cambiarLocalUsuario(uid, locId) { 
    const l = state.locales.find(x => x.id === locId); 
    await updateDoc(doc(db, "usuarios", uid), { localId: locId, localNombre: l?.nombre||'Sin Local' }); 
}
