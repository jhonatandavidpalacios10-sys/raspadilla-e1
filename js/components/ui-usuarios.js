import { db, collection, getDocs, doc, updateDoc, deleteDoc, setDoc, getDoc, secondaryAuth, createUserWithEmailAndPassword, updatePassword, signInWithEmailAndPassword, query, where, writeBatch } from '../core/firebase-setup.js';
import { state } from '../core/store.js';

let listaUsuariosEl, listaLocalesEl, selectLocalUsuario; 
const MASTER_UID = "kRG6hOWsWHfoJwWLCXAkqRuVNLk2";

export async function initUsuarios() {
    listaUsuariosEl = document.getElementById('usuarios-list'); 
    listaLocalesEl = document.getElementById('locales-list'); 
    selectLocalUsuario = document.getElementById('user-local');
    
    // Formularios y Botones Principales
    const formUsuario = document.getElementById('form-usuario'); 
    if(formUsuario) formUsuario.onsubmit = guardarNuevoUsuario;
    
    const formLocal = document.getElementById('form-local'); 
    if(formLocal) formLocal.onsubmit = guardarLocal;
    
    const btnNuevo = document.getElementById('btn-nuevo-usuario'); 
    if(btnNuevo) btnNuevo.onclick = abrirModalUsuarioConfig;
    
    // Botón de Cerrar Modal Principal
    const btnCerrar = document.getElementById('btn-cerrar-modal-usuario'); 
    if(btnCerrar) btnCerrar.onclick = cerrarModalUsuario;
    
    // Botón de Sincronización para cuentas antiguas (Solo Master)
    document.getElementById('btn-sincronizar-usuarios')?.addEventListener('click', sincronizarDirectorioLogin);
    
    // Filtro de caracteres para el nombre de usuario
    const inN = document.getElementById('user-nombre'); 
    if(inN) inN.oninput = (e) => e.target.value = e.target.value.toLowerCase().replace(/@.*/g, '').replace(/[^a-z0-9_.]/g, '');
    
    // Delegación Locales
    if(listaLocalesEl) {
        listaLocalesEl.onclick = e => {
            const btn = e.target.closest('button[data-action]'); 
            if(!btn) return;
            if(btn.dataset.action === 'editar-local') editarLocal(btn.dataset.id);
            else if(btn.dataset.action === 'eliminar-local') eliminarLocal(btn.dataset.id);
        };
    }

    // Delegación Usuarios
    if(listaUsuariosEl) {
        listaUsuariosEl.onclick = e => {
            const btn = e.target.closest('button[data-action]'); 
            if(!btn) return;
            if(btn.dataset.action === 'eliminar-usuario') eliminarUsuario(btn.dataset.uid, btn.dataset.activo === 'true');
            if(btn.dataset.action === 'copiar-pass') { 
                navigator.clipboard.writeText(btn.dataset.pass); 
                if(window.mostrarToast) window.mostrarToast('Copiado', 'Contraseña copiada al portapapeles', 'sky'); 
            }
            if(btn.dataset.action === 'editar-pass') { 
                abrirModalEditarUsuario(btn.dataset.uid, btn.dataset.username, btn.dataset.email, btn.dataset.oldpass, btn.dataset.rol, btn.dataset.localid, btn.dataset.localnombre, btn.dataset.permisos); 
            }
        };
        listaUsuariosEl.onchange = e => {
            const sel = e.target;
            if(sel.dataset.action === 'cambiar-local') cambiarLocalUsuario(sel.dataset.uid, sel.value);
            else if(sel.dataset.action === 'cambiar-rol') cambiarRolUsuario(sel.dataset.uid, sel.value);
        };
    }
}

/**
 * Función Maestra para migrar cuentas antiguas al nuevo sistema de login.
 * Crea las entradas en 'directorio_login' basándose en los usuarios existentes.
 */
async function sincronizarDirectorioLogin() {
    if (state.userRole !== 'master') return;
    
    if (window.mostrarConfirmacion) {
        window.mostrarConfirmacion("¿Sincronizar cuentas antiguas con el nuevo sistema de login?", async () => {
            const btn = document.getElementById('btn-sincronizar-usuarios');
            const originalHtml = btn ? btn.innerHTML : '';
            if (btn) {
                btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline mr-2"></i> Procesando...';
                btn.disabled = true;
                if(window.lucide) window.lucide.createIcons();
            }

            try {
                const snap = await getDocs(collection(db, "usuarios"));
                const batch = writeBatch(db);
                let procesados = 0;

                for (const docSnap of snap.docs) {
                    const u = docSnap.data();
                    const uid = docSnap.id;
                    
                    // Si el usuario no tiene 'username', usamos la parte inicial del correo
                    const username = u.username || u.email.split('@')[0];
                    
                    // 1. Asegurar que el documento de usuario tenga el campo username
                    if (!u.username) {
                        batch.update(doc(db, "usuarios", uid), { username: username });
                    }

                    // 2. Crear la entrada en el directorio público
                    const dirRef = doc(db, "directorio_login", username);
                    batch.set(dirRef, {
                        username: username,
                        email: u.email
                    });
                    procesados++;
                }

                await batch.commit();
                if(window.mostrarToast) window.mostrarToast('Éxito', `${procesados} cuentas sincronizadas correctamente.`, 'emerald');
                cargarUsuariosYLocales();
            } catch (err) {
                console.error("Error en sincronización:", err);
                if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo completar la sincronización masiva.", "red");
            } finally {
                if (btn) {
                    btn.innerHTML = originalHtml;
                    btn.disabled = false;
                    if(window.lucide) window.lucide.createIcons();
                }
            }
        });
    }
}

function abrirModalEditarUsuario(uid, username, email, oldPass, rol, localId, localNombre, permisosStr) {
    let m = document.getElementById('modal-editar-usuario'); 
    let permisos = [];
    try { permisos = JSON.parse(permisosStr || '[]'); } catch(e) { permisos = ['nav-ventas', 'nav-pedidos', 'nav-inventario']; }
    if (permisos.length === 0) permisos = ['nav-ventas', 'nav-pedidos', 'nav-inventario'];
    
    if(!m) { 
        m = document.createElement('div'); 
        m.id = 'modal-editar-usuario'; 
        m.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] hidden flex items-center justify-center px-4 transition-opacity duration-300 opacity-0'; 
        document.body.appendChild(m); 
    }
    
    m.innerHTML = `
        <div class="bg-slate-800 p-6 rounded-2xl shadow-2xl w-full max-w-sm border border-slate-700 relative">
            <header class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-bold text-slate-800 dark:text-white">Editar Cuenta</h3>
                <button type="button" id="btn-close-x-edit-user" class="text-slate-400 hover:text-slate-800 dark:hover:text-white bg-slate-100 dark:bg-slate-700 p-1.5 rounded-lg transition-colors"><i data-lucide="x" class="w-5 h-5"></i></button>
            </header>
            
            <input type="hidden" id="edit-target-uid" value="${uid}">
            <input type="hidden" id="edit-target-oldpass" value="${oldPass || ''}">
            <input type="hidden" id="edit-target-email" value="${email}">
            <input type="hidden" id="edit-target-oldusername" value="${username}">
            <input type="hidden" id="edit-target-rol" value="${rol}">
            <input type="hidden" id="edit-target-localId" value="${localId}">
            <input type="hidden" id="edit-target-localNombre" value="${localNombre}">
            
            <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Nombre de Usuario (Login)</label>
            <input type="text" id="edit-user-nombre" value="${username}" autocomplete="off" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-800 dark:text-white lowercase outline-none focus:border-sky-500 transition-colors mb-3">
            
            <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Nueva Contraseña</label>
            <input type="text" id="edit-user-pass" value="${oldPass || ''}" autocomplete="off" spellcheck="false" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-800 dark:text-white outline-none focus:border-sky-500 transition-colors mb-3">
            
            <div id="edit-container-permisos" class="bg-slate-100 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-lg p-3 mb-4 ${rol === 'vendedor' ? '' : 'hidden'}">
                <p class="text-[10px] font-bold text-slate-500 uppercase mb-2">Permisos de Módulos</p>
                <div class="grid grid-cols-2 gap-2">
                    <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="edit-permisos[]" value="nav-ventas" class="rounded border-slate-300" ${permisos.includes('nav-ventas')?'checked':''}><span class="text-xs text-slate-700 dark:text-slate-300">Ventas</span></label>
                    <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="edit-permisos[]" value="nav-pedidos" class="rounded border-slate-300" ${permisos.includes('nav-pedidos')?'checked':''}><span class="text-xs text-slate-700 dark:text-slate-300">Pedidos</span></label>
                    <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="edit-permisos[]" value="nav-inventario" class="rounded border-slate-300" ${permisos.includes('nav-inventario')?'checked':''}><span class="text-xs text-slate-700 dark:text-slate-300">Catálogo</span></label>
                    <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="edit-permisos[]" value="nav-caja" class="rounded border-slate-300" ${permisos.includes('nav-caja')?'checked':''}><span class="text-xs text-slate-700 dark:text-slate-300">Caja</span></label>
                </div>
            </div>
            
            <div class="flex gap-2">
                <button type="button" id="btn-cancel-edit-user" class="flex-1 py-2.5 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-800 dark:text-white rounded-xl font-bold transition-colors">Cancelar</button>
                <button type="button" id="btn-confirm-edit-user" class="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 text-white rounded-xl font-bold transition-colors shadow-md shadow-sky-500/20">Guardar Cambios</button>
            </div>
        </div>
    `;
    
    const closeModalFn = () => { 
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
    };
    
    document.getElementById('btn-cancel-edit-user').onclick = closeModalFn;
    document.getElementById('btn-close-x-edit-user').onclick = closeModalFn;
    document.getElementById('btn-confirm-edit-user').onclick = ejecutarEditarUsuario;
    document.getElementById('edit-user-nombre').oninput = (e) => e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
    if(window.lucide) window.lucide.createIcons();
}

async function ejecutarEditarUsuario() {
    const uid = document.getElementById('edit-target-uid').value; 
    const currentEmail = document.getElementById('edit-target-email').value; // Ej: maria_k9x2@raspadillas.com
    const oldPass = document.getElementById('edit-target-oldpass').value; 
    const oldUsername = document.getElementById('edit-target-oldusername').value;
    const newUsername = document.getElementById('edit-user-nombre').value.trim(); 
    const newPass = document.getElementById('edit-user-pass').value.trim();
    const rol = document.getElementById('edit-target-rol').value; 

    let permisosArray = [];
    if (rol === 'vendedor') { 
        const checks = document.querySelectorAll('input[name="edit-permisos[]"]:checked'); 
        permisosArray = Array.from(checks).map(c => c.value); 
    }
    
    if (newUsername.length < 3) { if(window.mostrarToast) window.mostrarToast('Error', 'Usuario muy corto', 'amber'); return; }
    if (newPass.length < 6) { if(window.mostrarToast) window.mostrarToast('Error', 'Mínimo 6 caracteres', 'amber'); return; }

    const btn = document.getElementById('btn-confirm-edit-user'); 
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline"></i> Actualizando...'; 
    if(window.lucide) window.lucide.createIcons(); 
    btn.disabled = true;

    try {
        // Validar si el nuevo nombre ya está ocupado por OTRA cuenta ACTIVA
        if (newUsername !== oldUsername) {
            const qCheck = query(collection(db, "usuarios"), where("username", "==", newUsername), where("activo", "==", true));
            const checkSnap = await getDocs(qCheck);
            if (!checkSnap.empty) {
                if(window.mostrarAlerta) window.mostrarAlerta('Nombre Ocupado', 'Ya existe una cuenta activa con ese nombre de usuario.', 'amber');
                btn.innerHTML = originalText; btn.disabled = false;
                return;
            }
        }

        // Si cambiaron la contraseña, actualizamos Firebase Auth conectándonos con su correo oculto
        if (newPass !== oldPass && oldPass) {
            if (uid === state.currentUser.uid) { 
                await updatePassword(state.currentUser, newPass); 
            } else { 
                const secCred = await signInWithEmailAndPassword(secondaryAuth, currentEmail, oldPass); 
                await updatePassword(secCred.user, newPass); 
                await secondaryAuth.signOut(); 
            }
        }

        // Actualizamos Firestore (Solo el nombre público y los datos, el correo auth oculto no hace falta cambiarlo)
        await updateDoc(doc(db, "usuarios", uid), { 
            username: newUsername,
            pass_visible: newPass, 
            permisos: permisosArray 
        });
        
        // Actualizar Directorio Público si el nombre cambió
        if (newUsername !== oldUsername) {
            await setDoc(doc(db, "directorio_login", newUsername), {
                username: newUsername,
                email: currentEmail
            });
            if (oldUsername) await deleteDoc(doc(db, "directorio_login", oldUsername));
        }
        
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta actualizada correctamente', 'emerald');
        const m = document.getElementById('modal-editar-usuario'); 
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
        cargarUsuariosYLocales();
        
    } catch (err) {
        console.error(err);
        if(window.mostrarAlerta) window.mostrarAlerta('Error', 'No se pudo actualizar la cuenta.', 'red'); 
    } finally { 
        btn.innerHTML = originalText; 
        btn.disabled = false; 
    }
}

function abrirModalUsuarioConfig() { 
    document.getElementById('form-usuario').reset(); 
    document.getElementById('user-id').value = ''; 
    const selectRol = document.getElementById('user-rol');
    
    if(selectRol) { 
        selectRol.innerHTML = `<option value="vendedor">Vendedor</option><option value="admin">Administrador</option>`; 
        if (state.userRole === 'master') { 
            selectRol.innerHTML += `<option value="master" class="font-bold text-amber-500">Master (Dueño)</option>`; 
        } 
    }
    
    const container = document.getElementById('container-permisos-vendedor'); 
    if(container) container.classList.remove('hidden'); 
    
    const m = document.getElementById('modal-usuario'); 
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10); 
}

function cerrarModalUsuario() { 
    const m = document.getElementById('modal-usuario'); 
    if(m) {
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
    }
}

export async function cargarUsuariosYLocales() { 
    await cargarLocales(); 
    await cargarUsuarios(); 
}

async function cargarLocales() {
    if (!listaLocalesEl) return;
    try {
        const snap = await getDocs(collection(db, "locales")); 
        state.locales = []; 
        let html = '';
        
        let optionsHtml = '<option value="todas">Todas las Sedes / General</option>'; 
        let asignHtml = '<option value="">Sin Asignar</option>';
        
        snap.forEach(d => { 
            const loc = { id: d.id, ...d.data() }; 
            state.locales.push(loc); 
            html += `<div class="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 rounded-xl flex items-center justify-between mb-2 transition-colors hover:border-emerald-500/50"><div><span class="font-bold text-slate-800 dark:text-white text-sm">${loc.nombre}</span></div><div class="flex gap-2"><button data-action="eliminar-local" data-id="${loc.id}" class="text-slate-400 hover:text-red-500 p-1 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div></div>`; 
            optionsHtml += `<option value="${loc.id}">${loc.nombre}</option>`; 
            asignHtml += `<option value="${loc.id}">${loc.nombre}</option>`;
        });
        
        optionsHtml += '<option value="">Sin Asignar / Antiguas</option>';

        listaLocalesEl.innerHTML = html || '<p class="text-xs text-slate-500 p-2">Sin sucursales registradas.</p>';
        if (selectLocalUsuario) selectLocalUsuario.innerHTML = asignHtml;
        
        const selectoresGlobales = ['filtro-local-caja', 'analisisLocalFilter', 'filtro-local-pedidos', 'exportLocalFilter'];
        selectoresGlobales.forEach(f => { const el = document.getElementById(f); if(el) el.innerHTML = optionsHtml; });

    } catch (e) { console.error("Error al cargar sedes:", e); }
}

async function cargarUsuarios() {
    if (!listaUsuariosEl) return;
    try {
        const snap = await getDocs(collection(db, "usuarios")); 
        let allU = []; 
        
        snap.forEach(d => { 
            const data = d.data();
            // LÓGICA DE VISIBILIDAD: Solo el master ve cuentas desactivadas
            if (data.activo === false && state.userRole !== 'master') return;
            allU.push({uid: d.id, ...data}); 
        });
        
        let html = ''; 
        let selectOptions = '<option value="">Sin Local</option>'; 
        state.locales.forEach(l => selectOptions += `<option value="${l.id}">${l.nombre}</option>`);
        
        state.locales.forEach(loc => { 
            const usrsLoc = allU.filter(u => u.localId === loc.id); 
            if(usrsLoc.length > 0) { 
                html += `<div class="mt-4 mb-2 border-b border-slate-200 dark:border-slate-700 pb-1"><h4 class="text-xs font-bold text-sky-500 uppercase tracking-wider">${loc.nombre}</h4></div>`; 
                usrsLoc.forEach(u => html += genU(u, selectOptions)); 
            } 
        });
        
        const usrsSin = allU.filter(u => !u.localId); 
        if(usrsSin.length > 0) { 
            html += `<div class="mt-4 mb-2 border-b border-slate-200 dark:border-slate-700 pb-1"><h4 class="text-xs font-bold text-slate-500 uppercase tracking-wider">Sin Asignar / Global</h4></div>`; 
            usrsSin.forEach(u => html += genU(u, selectOptions)); 
        }
        
        listaUsuariosEl.innerHTML = html || '<p class="text-xs text-slate-500 p-2">Sin usuarios.</p>'; 
        if (window.lucide) window.lucide.createIcons();
    } catch (e) {
        console.error("Error cargando usuarios:", e);
    }
}

function genU(u, opts) {
    const isThisCardMaster = u.rol === 'master' || u.uid === MASTER_UID;
    if (isThisCardMaster && state.userRole !== 'master') return ''; 
    const isPrivileged = state.userRole === 'admin' || state.userRole === 'Administrador' || state.userRole === 'master'; 
    const isMe = (u.uid === state.currentUser?.uid); 
    const isInactive = u.activo === false;
    
    // Fallback por si hay usuarios muy antiguos sin el campo username
    const usernameDisplay = u.username || (u.email ? u.email.split('@')[0] : 'Desconocido');
    
    let passDisplay = u.pass_visible || 'Oculta'; 
    let passHtml = '';
    
    if (isPrivileged) {
        const permisosJson = (u.permisos && u.permisos.length > 0) ? JSON.stringify(u.permisos).replace(/"/g, '&quot;') : '';
        const btnEditHtml = `<button data-action="editar-pass" data-uid="${u.uid}" data-username="${usernameDisplay}" data-email="${u.email}" data-oldpass="${u.pass_visible || ''}" data-rol="${u.rol}" data-localid="${u.localId || ''}" data-localnombre="${u.localNombre || ''}" data-permisos="${permisosJson}" title="Editar Cuenta" class="text-amber-500 hover:text-amber-600 p-0.5 ml-1 transition-colors"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>`;
        passHtml = `<div class="flex items-center gap-1 mt-1 bg-slate-100 dark:bg-slate-900 w-fit px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700"><span class="text-[10px] text-sky-500 font-mono tracking-wider">${passDisplay}</span>${u.pass_visible ? `<button data-action="copiar-pass" data-pass="${u.pass_visible}" title="Copiar Contraseña" class="text-slate-400 hover:text-slate-600 dark:hover:text-white p-0.5 transition-colors"><i data-lucide="copy" class="w-3.5 h-3.5"></i></button>` : ''}${btnEditHtml}</div>`;
    }

    let roleOptions = `<option value="vendedor" ${u.rol === 'vendedor' ? 'selected' : ''}>Vendedor</option><option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Admin</option>`;
    if (state.userRole === 'master') roleOptions += `<option value="master" ${u.rol === 'master' ? 'selected' : ''}>Master</option>`;
    
    let cardBorderColor = isInactive ? 'border-red-500/30 opacity-70 bg-red-50/50 dark:bg-red-900/10' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'; 
    let userIconColor = isInactive ? 'text-red-500' : 'text-sky-500'; 
    let userIconBg = isInactive ? 'bg-red-100 dark:bg-red-500/10' : 'bg-sky-100 dark:bg-sky-500/10'; 
    let userIconType = isInactive ? 'user-x' : 'user'; 
    let roleTextColor = isInactive ? 'text-slate-500' : 'text-slate-500';
    
    if (isThisCardMaster) { 
        cardBorderColor = 'border-amber-400/50 shadow-lg shadow-amber-500/10 bg-gradient-to-r from-amber-50/50 to-white dark:from-amber-900/10 dark:to-slate-800'; 
        userIconColor = 'text-amber-500'; 
        userIconBg = 'bg-amber-100 dark:bg-amber-500/20'; 
        userIconType = 'crown'; 
        roleTextColor = 'text-amber-600 dark:text-amber-400'; 
    } else if (u.rol === 'admin' && !isInactive) { 
        cardBorderColor = 'border-purple-300 dark:border-purple-500/50 shadow-lg shadow-purple-500/10 bg-gradient-to-r from-purple-50/50 to-white dark:from-purple-900/10 dark:to-slate-800'; 
        userIconColor = 'text-purple-500'; 
        userIconBg = 'bg-purple-100 dark:bg-purple-500/20'; 
        userIconType = 'shield-check'; 
        roleTextColor = 'text-purple-600 dark:text-purple-400'; 
    }
    
    const inactiveBadge = isInactive ? `<span class="bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/30 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ml-2">Desactivado</span>` : '';
    const renderRoleSelector = isMe ? `<span class="bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 ${roleTextColor} rounded px-2 py-1 text-xs font-bold uppercase tracking-wider">${u.rol}</span>` : `<select data-action="cambiar-rol" data-uid="${u.uid}" class="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 rounded px-1 py-1 text-xs cursor-pointer outline-none focus:border-sky-500 transition-colors">${roleOptions}</select>`;

    // Mostrar el correo oculto real solo si es Master
    const correoOcultoHtml = state.userRole === 'master' ? `<p class="text-[9px] text-slate-400 font-mono mt-0.5" title="Correo interno del sistema">${u.email}</p>` : '';

    return `
    <div class="border ${cardBorderColor} rounded-xl p-3 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-2 mb-2 transition-all hover:shadow-md">
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full ${userIconBg} flex items-center justify-center ${userIconColor} shrink-0"><i data-lucide="${userIconType}" class="w-4 h-4"></i></div>
            <div>
                <p class="font-bold text-slate-800 dark:text-white text-sm flex items-center gap-2 capitalize">${usernameDisplay} ${isMe ? '<span class="text-[9px] bg-slate-800 text-white px-1.5 py-0.5 rounded uppercase">Tú</span>' : ''} ${inactiveBadge}</p>
                <p class="text-[10px] ${roleTextColor}">Rol: <span class="uppercase font-bold tracking-wide">${u.rol}</span></p>
                ${correoOcultoHtml}
                ${passHtml}
            </div>
        </div>
        ${(u.uid === MASTER_UID && !isMe) ? 
            `<span class="bg-amber-500 text-white px-2 py-0.5 rounded text-xs font-bold shadow-md">Dueño Principal</span>` : 
            `<div class="flex gap-2 w-full lg:w-auto mt-2 lg:mt-0 items-center">
                <select data-action="cambiar-local" data-uid="${u.uid}" class="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 rounded px-1 py-1 text-xs cursor-pointer outline-none focus:border-sky-500 transition-colors">${opts.replace(`value="${u.localId || ''}"`, `value="${u.localId || ''}" selected`)}</select>
                ${renderRoleSelector}
                ${!isMe ? `<button data-action="eliminar-usuario" data-uid="${u.uid}" data-activo="${!isInactive}" title="${isInactive ? 'Eliminar Definitivamente (Solo Master)' : 'Desactivar Acceso'}" class="text-red-500 hover:text-red-600 bg-red-50 dark:bg-slate-900 border border-red-200 dark:border-slate-700 rounded p-1 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
            </div>`
        }
    </div>`;
}

async function guardarLocal(e) { 
    e.preventDefault(); 
    const n = document.getElementById('nuevo-local-nombre').value.trim(); 
    if(n) { 
        await addDoc(collection(db, "locales"), { nombre: n }); 
        cargarUsuariosYLocales(); 
        document.getElementById('nuevo-local-nombre').value = ''; 
    } 
}

async function eliminarLocal(id) { 
    if(window.mostrarConfirmacion) window.mostrarConfirmacion("¿Eliminar sede definitivamente?", async () => { 
        await deleteDoc(doc(db, "locales", id)); 
        cargarUsuariosYLocales(); 
    }); 
}

// NUEVA LÓGICA DE CREACIÓN: Nombre limpio visible + Correo aleatorio oculto
async function guardarNuevoUsuario(e) { 
    e.preventDefault(); 
    const rawName = document.getElementById('user-nombre').value.trim().toLowerCase().replace(/@.*/g, '').replace(/[^a-z0-9_.]/g, '');
    const pass = document.getElementById('user-pass').value; 
    const locId = document.getElementById('user-local').value; 
    const rol = document.getElementById('user-rol').value; 
    const loc = state.locales.find(l => l.id === locId); 
    
    if (rawName.length < 3) { if(window.mostrarToast) window.mostrarToast('Error', 'Nombre muy corto', 'amber'); return; }

    let permisosArray = [];
    if (rol === 'vendedor') { 
        const checks = document.querySelectorAll('#container-permisos-vendedor input[type="checkbox"]:checked'); 
        permisosArray = Array.from(checks).map(c => c.value); 
    }

    const btn = document.querySelector('#form-usuario button[type="submit"]'); 
    const btnOriginal = btn.innerHTML; 
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline"></i> Creando...'; 
    if(window.lucide) window.lucide.createIcons(); 
    btn.disabled = true;

    try { 
        // 1. Verificar que el nombre NO esté siendo usado por una cuenta ACTIVA
        const qActive = query(collection(db, "usuarios"), where("username", "==", rawName), where("activo", "==", true));
        const activeSnap = await getDocs(qActive);
        
        if(!activeSnap.empty) {
            if(window.mostrarAlerta) window.mostrarAlerta('Ocupado', 'Ese nombre de usuario ya existe y está activo.', 'amber');
            btn.innerHTML = btnOriginal; btn.disabled = false;
            return;
        }

        // 2. Generar Correo Único y Oculto (A prueba de choques de Firebase Auth)
        const randomSuffix = Math.random().toString(36).substring(2, 6);
        const secretEmail = `${rawName}_${randomSuffix}@raspadillas.com`;

        // 3. Crear en Firebase Auth
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, secretEmail, pass); 
        const nuevoUID = userCredential.user.uid; 
        await secondaryAuth.signOut();

        // 4. Guardar en Base de Datos (Privado)
        await setDoc(doc(db, "usuarios", nuevoUID), { 
            username: rawName,       // <- Lo que ve el dueño y usa el cajero para loguearse
            email: secretEmail,      // <- El correo real usado por detrás
            rol: rol, 
            localId: locId, 
            localNombre: loc?.nombre || 'Sin Local', 
            creado_manualmente: true, 
            pass_visible: pass, 
            activo: true, 
            permisos: permisosArray 
        }); 
        
        // 5. Guardar en el Directorio Público (Para que el Login funcione libremente)
        await setDoc(doc(db, "directorio_login", rawName), {
            username: rawName,
            email: secretEmail
        });
        
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta creada con éxito', 'emerald'); 
        cerrarModalUsuario(); 
        cargarUsuariosYLocales(); 
    } catch(error) {
        if (error.code === 'auth/weak-password') { 
            if(window.mostrarToast) window.mostrarToast('Error', 'La contraseña debe tener mínimo 6 caracteres.', 'red'); 
        } else { 
            if(window.mostrarAlerta) window.mostrarAlerta('Error', `Fallo al conectar: ${error.code}`, 'red'); 
        }
    } finally { 
        btn.innerHTML = btnOriginal; 
        btn.disabled = false; 
    }
}

async function eliminarUsuario(uid, isActivo) { 
    if(window.mostrarConfirmacion) {
        if (isActivo) { 
            window.mostrarConfirmacion("¿Desactivar acceso? El usuario no podrá entrar, pero mantendrás su historial.", async () => { 
                await updateDoc(doc(db, "usuarios", uid), { activo: false }); 
                cargarUsuariosYLocales(); 
                if(window.mostrarToast) window.mostrarToast('Desactivado', 'Usuario bloqueado exitosamente.', 'sky'); 
            }); 
        } else { 
            // Solo los Masters deberían poder ver y clickear esto según la UI
            if (state.userRole !== 'master') return;
            window.mostrarConfirmacion("¿Eliminar DEFINITIVAMENTE del sistema? Esto no se puede deshacer.", async () => { 
                // Limpiar del directorio público también
                const uRef = doc(db, "usuarios", uid);
                const uSnap = await getDoc(uRef);
                if (uSnap.exists() && uSnap.data().username) {
                    await deleteDoc(doc(db, "directorio_login", uSnap.data().username));
                }

                await deleteDoc(uRef); 
                cargarUsuariosYLocales(); 
                if(window.mostrarToast) window.mostrarToast('Eliminado', 'Registro borrado permanentemente.', 'emerald'); 
            }); 
        }
    }
}

async function cambiarRolUsuario(uid, rol) { 
    await updateDoc(doc(db, "usuarios", uid), { rol }); 
    if(window.mostrarToast) window.mostrarToast('Listo', 'Nivel de acceso actualizado', 'sky'); 
    cargarUsuariosYLocales(); 
}

async function cambiarLocalUsuario(uid, locId) { 
    const l = state.locales.find(x => x.id === locId); 
    await updateDoc(doc(db, "usuarios", uid), { localId: locId, localNombre: l?.nombre||'Sin Local' }); 
    if(window.mostrarToast) window.mostrarToast('Sede Actualizada', 'El usuario fue movido de local', 'sky');
}
