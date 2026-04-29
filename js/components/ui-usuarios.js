import { db, collection, getDocs, doc, updateDoc, deleteDoc, setDoc, secondaryAuth, createUserWithEmailAndPassword, updatePassword, signInWithEmailAndPassword, query, where } from '../core/firebase-setup.js';
import { state } from '../core/store.js';

let listaUsuariosEl, listaLocalesEl, selectLocalUsuario; 
const MASTER_UID = "kRG6hOWsWHfoJwWLCXAkqRuVNLk2";

export async function initUsuarios() {
    listaUsuariosEl = document.getElementById('usuarios-list'); 
    listaLocalesEl = document.getElementById('locales-list'); 
    selectLocalUsuario = document.getElementById('user-local');
    
    // Formularios y Botones Principales
    const formUsuario = document.getElementById('form-usuario'); 
    if(formUsuario) formUsuario.onsubmit = guardarUsuarioSimulado;
    
    const formLocal = document.getElementById('form-local'); 
    if(formLocal) formLocal.onsubmit = guardarLocal;
    
    const btnNuevo = document.getElementById('btn-nuevo-usuario'); 
    if(btnNuevo) btnNuevo.onclick = abrirModalUsuarioConfig;
    
    // Botón de Cerrar Modal Principal
    const btnCerrar = document.getElementById('btn-cerrar-modal-usuario'); 
    if(btnCerrar) btnCerrar.onclick = cerrarModalUsuario;
    
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
                abrirModalEditarUsuario(btn.dataset.uid, btn.dataset.email, btn.dataset.oldpass, btn.dataset.rol, btn.dataset.localid, btn.dataset.localnombre, btn.dataset.permisos); 
            }
        };
        listaUsuariosEl.onchange = e => {
            const sel = e.target;
            if(sel.dataset.action === 'cambiar-local') cambiarLocalUsuario(sel.dataset.uid, sel.value);
            else if(sel.dataset.action === 'cambiar-rol') cambiarRolUsuario(sel.dataset.uid, sel.value);
        };
    }
}

async function crearUsuarioFuerzaBruta(baseName, pass) {
    let attempt = 1;
    while (attempt < 20) {
        let testName = attempt === 1 ? `${baseName}_nuevo` : `${baseName}_${attempt}`;
        let testEmail = `${testName}@raspadillas.com`;
        try {
            const cred = await createUserWithEmailAndPassword(secondaryAuth, testEmail, pass);
            const uid = cred.user.uid; 
            await secondaryAuth.signOut();
            return { uid, email: testEmail, username: testName };
        } catch(e) { 
            if (e.code === 'auth/email-already-in-use') attempt++; 
            else throw e; 
        }
    }
    throw new Error("No se pudo forzar la creación.");
}

function abrirModalEditarUsuario(uid, email, oldPass, rol, localId, localNombre, permisosStr) {
    let m = document.getElementById('modal-editar-usuario'); 
    let permisos = [];
    try { 
        permisos = JSON.parse(permisosStr || '[]'); 
    } catch(e) { 
        permisos = ['nav-ventas', 'nav-pedidos', 'nav-inventario']; 
    }
    
    if (permisos.length === 0) permisos = ['nav-ventas', 'nav-pedidos', 'nav-inventario'];
    
    if(!m) { 
        m = document.createElement('div'); 
        m.id = 'modal-editar-usuario'; 
        m.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] hidden flex items-center justify-center px-4 transition-opacity duration-300 opacity-0'; 
        document.body.appendChild(m); 
    }
    
    m.innerHTML = `
        <div class="bg-slate-800 p-6 rounded-2xl shadow-2xl w-full max-w-sm border border-slate-700">
            <header class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-bold text-white">Editar Usuario</h3>
                <button type="button" id="btn-close-x-edit-user" class="text-slate-400 hover:text-white bg-slate-700 p-1.5 rounded-lg transition-colors"><i data-lucide="x" class="w-5 h-5"></i></button>
            </header>
            
            <input type="hidden" id="edit-target-uid" value="${uid}">
            <input type="hidden" id="edit-target-oldpass" value="${oldPass || ''}">
            <input type="hidden" id="edit-target-email" value="${email}">
            <input type="hidden" id="edit-target-rol" value="${rol}">
            <input type="hidden" id="edit-target-localId" value="${localId}">
            <input type="hidden" id="edit-target-localNombre" value="${localNombre}">
            
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Nombre de Usuario</label>
            <div class="flex mb-3">
                <input type="text" id="edit-user-nombre" value="${email.split('@')[0]}" autocomplete="off" class="flex-1 bg-slate-900 border border-slate-700 rounded-l-lg px-3 py-2 text-white lowercase outline-none focus:border-sky-500 transition-colors">
                <span class="bg-slate-700 border-y border-r border-slate-700 rounded-r-lg px-2 py-2 text-xs text-slate-400 flex items-center">@raspadillas.com</span>
            </div>
            
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Nueva Contraseña</label>
            <input type="text" id="edit-user-pass" value="${oldPass || ''}" autocomplete="off" spellcheck="false" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white outline-none focus:border-sky-500 transition-colors mb-3">
            
            <div id="edit-container-permisos" class="bg-slate-900/50 border border-slate-700 rounded-lg p-3 mb-4 ${rol === 'vendedor' ? '' : 'hidden'}">
                <p class="text-[10px] font-bold text-slate-400 uppercase mb-2">Permisos de Módulos</p>
                <div class="grid grid-cols-2 gap-2">
                    <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="edit-permisos[]" value="nav-ventas" class="rounded bg-slate-800" ${permisos.includes('nav-ventas')?'checked':''}><span class="text-xs text-slate-300">Ventas</span></label>
                    <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="edit-permisos[]" value="nav-pedidos" class="rounded bg-slate-800" ${permisos.includes('nav-pedidos')?'checked':''}><span class="text-xs text-slate-300">Pedidos</span></label>
                    <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="edit-permisos[]" value="nav-inventario" class="rounded bg-slate-800" ${permisos.includes('nav-inventario')?'checked':''}><span class="text-xs text-slate-300">Catálogo</span></label>
                    <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="edit-permisos[]" value="nav-caja" class="rounded bg-slate-800" ${permisos.includes('nav-caja')?'checked':''}><span class="text-xs text-slate-300">Caja</span></label>
                </div>
            </div>
            
            <div class="flex gap-2">
                <button type="button" id="btn-cancel-edit-user" class="flex-1 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-xl font-bold transition-colors">Cancelar</button>
                <button type="button" id="btn-confirm-edit-user" class="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 text-white rounded-xl font-bold transition-colors">Guardar</button>
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
    document.getElementById('edit-user-nombre').oninput = (e) => e.target.value = e.target.value.toLowerCase().replace(/@.*/g, '').replace(/[^a-z0-9_.]/g, '');
    
    m.classList.remove('hidden'); 
    setTimeout(() => m.classList.remove('opacity-0'), 10);
    if(window.lucide) window.lucide.createIcons();
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

    let permisosArray = [];
    if (rol === 'vendedor') { 
        const checks = document.querySelectorAll('input[name="edit-permisos[]"]:checked'); 
        permisosArray = Array.from(checks).map(c => c.value); 
    }
    
    if (newUsername.length < 3) { if(window.mostrarToast) window.mostrarToast('Error', 'Usuario muy corto', 'amber'); return; }
    if (newPass.length < 6) { if(window.mostrarToast) window.mostrarToast('Error', 'Mínimo 6 caracteres', 'amber'); return; }

    const btn = document.getElementById('btn-confirm-edit-user'); 
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline"></i> Guardando...'; 
    if(window.lucide) window.lucide.createIcons(); 
    btn.disabled = true;

    try {
        if (currentEmail === newEmail) {
            if (newPass !== oldPass) {
                if (!oldPass) {
                    const baseUsername = currentEmail.split('@')[0]; 
                    const newRes = await crearUsuarioFuerzaBruta(baseUsername, newPass);
                    await setDoc(doc(db, "usuarios", newRes.uid), { email: newRes.email, rol, localId, localNombre, creado_manualmente: true, pass_visible: newPass, activo: true, permisos: permisosArray });
                    await deleteDoc(doc(db, "usuarios", uid)); 
                    if(window.mostrarAlerta) window.mostrarAlerta('Cuenta Recreada', `La cuenta fue reemplazada forzosamente por: <b>${newRes.username}</b>`, 'sky');
                } else {
                    if (uid === state.currentUser.uid) { 
                        await updatePassword(state.currentUser, newPass); 
                    } else { 
                        const secCred = await signInWithEmailAndPassword(secondaryAuth, currentEmail, oldPass); 
                        await updatePassword(secCred.user, newPass); 
                        await secondaryAuth.signOut(); 
                    }
                    await updateDoc(doc(db, "usuarios", uid), { pass_visible: newPass, activo: true, rol, localId, localNombre, permisos: permisosArray });
                    if(window.mostrarToast) window.mostrarToast('Éxito', 'Datos y/o Contraseña actualizados', 'emerald');
                }
            } else {
                await updateDoc(doc(db, "usuarios", uid), { rol, localId, localNombre, permisos: permisosArray, activo: true });
                if(window.mostrarToast) window.mostrarToast('Éxito', 'Permisos y datos actualizados', 'emerald');
            }
        } else {
            const secCred = await createUserWithEmailAndPassword(secondaryAuth, newEmail, newPass); 
            const nuevoUID = secCred.user.uid; 
            await secondaryAuth.signOut();
            await setDoc(doc(db, "usuarios", nuevoUID), { email: newEmail, rol, localId, localNombre, creado_manualmente: true, pass_visible: newPass, activo: true, permisos: permisosArray });
            await updateDoc(doc(db, "usuarios", uid), { activo: false });
            if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta recreada con nuevo usuario', 'emerald');
        }
        
        const m = document.getElementById('modal-editar-usuario'); 
        m.classList.add('opacity-0'); 
        setTimeout(() => m.classList.add('hidden'), 300); 
        cargarUsuariosYLocales();
        
    } catch (err) {
        if(err.code === 'auth/email-already-in-use') { 
            if(window.mostrarAlerta) window.mostrarAlerta('Usuario Ocupado', 'Ese nuevo nombre de usuario ya existe.', 'amber'); 
        } else { 
            if(window.mostrarAlerta) window.mostrarAlerta('Error', err.message, 'red'); 
        }
    } finally { 
        btn.innerHTML = originalText; 
        btn.disabled = false; 
        if(window.lucide) window.lucide.createIcons();
    }
}

function abrirModalUsuarioConfig() { 
    document.getElementById('form-usuario').reset(); 
    document.getElementById('user-id').value = ''; 
    const selectRol = document.getElementById('user-rol');
    
    if(selectRol) { 
        selectRol.innerHTML = `<option value="vendedor">Vendedor</option><option value="admin">Administrador</option>`; 
        if (state.userRole === 'master') { 
            selectRol.innerHTML += `<option value="master" class="font-bold text-amber-400">Master (Dueño)</option>`; 
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

// ========================================================
// INYECCIÓN GLOBAL DE SEDES EN LOS FILTROS DE LA APP
// ========================================================
async function cargarLocales() {
    if (!listaLocalesEl) return;
    try {
        const snap = await getDocs(collection(db, "locales")); 
        state.locales = []; 
        let html = '';
        
        // 1. Opciones Iniciales
        let optionsHtml = '<option value="todas">Todas las Sedes / General</option>'; 
        let asignHtml = '<option value="">Sin Asignar</option>';
        
        // 2. Iterar Locales creados
        snap.forEach(d => { 
            const loc = { id: d.id, ...d.data() }; 
            state.locales.push(loc); 
            html += `<div class="bg-slate-800 border border-slate-700 p-3 rounded-xl flex items-center justify-between mb-2 transition-colors hover:border-emerald-500/50"><div><span class="font-bold text-white text-sm">${loc.nombre}</span></div><div class="flex gap-2"><button data-action="eliminar-local" data-id="${loc.id}" class="text-slate-500 hover:text-red-400 p-1 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div></div>`; 
            optionsHtml += `<option value="${loc.id}">${loc.nombre}</option>`; 
            asignHtml += `<option value="${loc.id}">${loc.nombre}</option>`;
        });
        
        // 3. AGREGAR OPCIÓN DE 'SIN ASIGNAR' AL FILTRO GLOBAL (Para Master/Admin)
        optionsHtml += '<option value="">Sin Asignar / Antiguas</option>';

        // Insertar a los elementos de configuración de Local
        listaLocalesEl.innerHTML = html || '<p class="text-xs text-slate-500 p-2">Sin sucursales registradas.</p>';
        if (selectLocalUsuario) selectLocalUsuario.innerHTML = asignHtml;
        
        // 4. INYECTAR OPCIONES A TODOS LOS FILTROS DE LA APLICACIÓN
        const selectoresGlobales = [
            'filtro-local-caja', 
            'analisisLocalFilter', 
            'filtro-local-pedidos', 
            'exportLocalFilter' 
        ];
        
        selectoresGlobales.forEach(f => { 
            const el = document.getElementById(f); 
            if(el) el.innerHTML = optionsHtml; 
        });

    } catch (e) {
        console.error("Error al cargar sedes:", e);
    }
}

async function cargarUsuarios() {
    if (!listaUsuariosEl) return;
    try {
        const snap = await getDocs(collection(db, "usuarios")); 
        let allU = []; 
        snap.forEach(d => { allU.push({uid: d.id, ...d.data()}); });
        
        let html = ''; 
        let selectOptions = '<option value="">Sin Local</option>'; 
        state.locales.forEach(l => selectOptions += `<option value="${l.id}">${l.nombre}</option>`);
        
        state.locales.forEach(loc => { 
            const usrsLoc = allU.filter(u => u.localId === loc.id); 
            if(usrsLoc.length > 0) { 
                html += `<div class="mt-4 mb-2 border-b border-slate-700 pb-1"><h4 class="text-xs font-bold text-sky-400 uppercase tracking-wider">${loc.nombre}</h4></div>`; 
                usrsLoc.forEach(u => html += genU(u, selectOptions)); 
            } 
        });
        
        const usrsSin = allU.filter(u => !u.localId); 
        if(usrsSin.length > 0) { 
            html += `<div class="mt-4 mb-2 border-b border-slate-700 pb-1"><h4 class="text-xs font-bold text-slate-500 uppercase tracking-wider">Sin Asignar / Master</h4></div>`; 
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
    
    let passDisplay = u.pass_visible || 'Oculta'; 
    let passHtml = '';
    
    if (isPrivileged) {
        const permisosJson = (u.permisos && u.permisos.length > 0) ? JSON.stringify(u.permisos).replace(/"/g, '&quot;') : '';
        const btnEditHtml = state.userRole === 'master' || state.userRole === 'admin' ? `<button data-action="editar-pass" data-uid="${u.uid}" data-email="${u.email}" data-oldpass="${u.pass_visible || ''}" data-rol="${u.rol}" data-localid="${u.localId || ''}" data-localnombre="${u.localNombre || ''}" data-permisos="${permisosJson}" title="Editar" class="text-amber-400 hover:text-white p-0.5 ml-1 transition-colors"><i data-lucide="edit-3" class="w-3 h-3"></i></button>` : '';
        passHtml = `<div class="flex items-center gap-1 mt-1 bg-slate-900 w-fit px-2 py-0.5 rounded border border-slate-700"><span class="text-[10px] text-sky-400 font-mono tracking-wider">${passDisplay}</span>${u.pass_visible ? `<button data-action="copiar-pass" data-pass="${u.pass_visible}" title="Copiar Contraseña" class="text-slate-400 hover:text-white p-0.5 transition-colors"><i data-lucide="copy" class="w-3 h-3"></i></button>` : ''}${btnEditHtml}</div>`;
    }

    let roleOptions = `<option value="vendedor" ${u.rol === 'vendedor' ? 'selected' : ''}>Vendedor</option><option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Admin</option>`;
    if (state.userRole === 'master') roleOptions += `<option value="master" ${u.rol === 'master' ? 'selected' : ''}>Master</option>`;
    
    let cardBorderColor = isInactive ? 'border-red-500/30 opacity-70' : 'border-slate-700'; 
    let userIconColor = isInactive ? 'text-red-400' : 'text-sky-400'; 
    let userIconBg = isInactive ? 'bg-red-500/10' : 'bg-sky-500/10'; 
    let userIconType = isInactive ? 'user-x' : 'user'; 
    let roleTextColor = isInactive ? 'text-slate-600' : 'text-slate-500';
    
    if (isThisCardMaster) { 
        cardBorderColor = 'border-amber-500/50 shadow-lg shadow-amber-500/10'; 
        userIconColor = 'text-amber-400'; 
        userIconBg = 'bg-amber-500/20'; 
        userIconType = 'crown'; 
        roleTextColor = 'text-amber-400'; 
    } else if (u.rol === 'admin' && !isInactive) { 
        cardBorderColor = 'border-purple-500/50 shadow-lg shadow-purple-500/10'; 
        userIconColor = 'text-purple-400'; 
        userIconBg = 'bg-purple-500/20'; 
        userIconType = 'shield-check'; 
        roleTextColor = 'text-purple-400'; 
    }
    
    const inactiveBadge = isInactive ? `<span class="bg-red-500/20 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ml-2">Inactivo</span>` : '';
    const renderRoleSelector = isMe ? `<span class="bg-slate-900 border border-slate-700 ${roleTextColor} rounded px-2 py-1 text-xs font-bold uppercase tracking-wider">${u.rol}</span>` : `<select data-action="cambiar-rol" data-uid="${u.uid}" class="bg-slate-900 border border-slate-600 text-slate-300 rounded px-1 py-1 text-xs cursor-pointer outline-none focus:border-sky-500 transition-colors">${roleOptions}</select>`;

    return `
    <div class="bg-slate-800 border ${cardBorderColor} rounded-xl p-3 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-2 mb-2 transition-all hover:opacity-100 hover:shadow-md">
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full ${userIconBg} flex items-center justify-center ${userIconColor} shrink-0"><i data-lucide="${userIconType}" class="w-4 h-4"></i></div>
            <div>
                <p class="font-bold text-white text-sm flex items-center gap-2">${u.email || 'Sin correo'} ${isMe ? '<span class="text-[9px] bg-slate-700 text-white px-1.5 py-0.5 rounded uppercase">Tú</span>' : ''} ${inactiveBadge}</p>
                <p class="text-[10px] ${roleTextColor}">Rol: <span class="uppercase font-bold tracking-wide">${u.rol}</span></p>
                ${passHtml}
            </div>
        </div>
        ${(u.uid === MASTER_UID && !isMe) ? 
            `<span class="bg-amber-500 text-white px-2 py-0.5 rounded text-xs font-bold shadow-md">Dueño Principal</span>` : 
            `<div class="flex gap-2 w-full lg:w-auto mt-2 lg:mt-0">
                <select data-action="cambiar-local" data-uid="${u.uid}" class="bg-slate-900 border border-slate-600 text-slate-300 rounded px-1 py-1 text-xs cursor-pointer outline-none focus:border-sky-500 transition-colors">${opts.replace(`value="${u.localId || ''}"`, `value="${u.localId || ''}" selected`)}</select>
                ${renderRoleSelector}
                ${!isMe ? `<button data-action="eliminar-usuario" data-uid="${u.uid}" data-activo="${!isInactive}" title="${isInactive ? 'Eliminar Definitivamente' : 'Desactivar Usuario'}" class="text-red-400 hover:text-red-300 bg-slate-900 border border-slate-700 rounded p-1 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
            </div>`
        }
    </div>`;
}

async function editarLocal(id) { /* omitted for brevity */ }

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

async function guardarUsuarioSimulado(e) { 
    e.preventDefault(); 
    const n = document.getElementById('user-nombre').value.trim(); 
    const email = n + '@raspadillas.com'; 
    const pass = document.getElementById('user-pass').value; 
    const locId = document.getElementById('user-local').value; 
    const rol = document.getElementById('user-rol').value; 
    const loc = state.locales.find(l => l.id === locId); 
    
    let permisosArray = [];
    if (rol === 'vendedor') { 
        const checks = document.querySelectorAll('#container-permisos-vendedor input[type="checkbox"]:checked'); 
        permisosArray = Array.from(checks).map(c => c.value); 
    }

    const btn = document.querySelector('#form-usuario button[type="submit"]'); 
    const btnOriginal = btn.innerHTML; 
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline"></i> Guardando...'; 
    if(window.lucide) window.lucide.createIcons(); 
    btn.disabled = true;

    try { 
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, pass); 
        const nuevoUID = userCredential.user.uid; 
        await secondaryAuth.signOut();
        
        await setDoc(doc(db, "usuarios", nuevoUID), { email: email, rol: rol, localId: locId, localNombre: loc?.nombre || 'Sin Local', creado_manualmente: true, pass_visible: pass, activo: true, permisos: permisosArray }); 
        
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta creada con éxito', 'emerald'); 
        cerrarModalUsuario(); 
        cargarUsuariosYLocales(); 
    } catch(error) {
        if (error.code === 'auth/email-already-in-use') {
            try {
                const q = query(collection(db, "usuarios"), where("email", "==", email)); 
                const snap = await getDocs(q);
                if (!snap.empty) {
                    const existingDoc = snap.docs[0]; 
                    const existingData = existingDoc.data();
                    if (existingData.activo === false) {
                        const oldPass = existingData.pass_visible;
                        if (oldPass) {
                            const secCred = await signInWithEmailAndPassword(secondaryAuth, email, oldPass); 
                            await updatePassword(secCred.user, pass); 
                            await secondaryAuth.signOut();
                            
                            await updateDoc(doc(db, "usuarios", existingDoc.id), { rol, localId: locId, localNombre: loc?.nombre || 'Sin Local', pass_visible: pass, activo: true, permisos: permisosArray });
                            
                            if(window.mostrarToast) window.mostrarToast('Recuperado', 'Cuenta restaurada con éxito', 'emerald'); 
                            cerrarModalUsuario(); 
                            cargarUsuariosYLocales(); 
                            return;
                        }
                    } else { 
                        if(window.mostrarAlerta) return window.mostrarAlerta('Usuario Existente', 'Este usuario ya está activo en el sistema.', 'amber'); 
                    }
                }
                const newRes = await crearUsuarioFuerzaBruta(n, pass);
                await setDoc(doc(db, "usuarios", newRes.uid), { email: newRes.email, rol, localId: locId, localNombre: loc?.nombre || 'Sin Local', creado_manualmente: true, pass_visible: pass, activo: true, permisos: permisosArray });
                if(window.mostrarAlerta) window.mostrarAlerta('Forzado', `Variante creada forzosamente: <b>${newRes.username}</b>`, 'amber'); 
                cerrarModalUsuario(); 
                cargarUsuariosYLocales();
            } catch (rErr) {
                console.error(rErr);
            }
        } else if (error.code === 'auth/weak-password') { 
            if(window.mostrarToast) window.mostrarToast('Error', 'La contraseña debe tener mínimo 6 caracteres.', 'red'); 
        } else { 
            if(window.mostrarAlerta) window.mostrarAlerta('Error', `Código de error: ${error.code}`, 'red'); 
        }
    } finally { 
        btn.innerHTML = btnOriginal; 
        btn.disabled = false; 
    }
}

async function eliminarUsuario(uid, isActivo) { 
    if(window.mostrarConfirmacion) {
        if (isActivo) { 
            window.mostrarConfirmacion("¿Desactivar usuario? Perderá el acceso al sistema.", async () => { 
                await updateDoc(doc(db, "usuarios", uid), { activo: false }); 
                cargarUsuariosYLocales(); 
                if(window.mostrarToast) window.mostrarToast('Desactivado', 'Usuario bloqueado exitosamente.', 'sky'); 
            }); 
        } else { 
            window.mostrarConfirmacion("¿Eliminar DEFINITIVAMENTE del sistema?", async () => { 
                await deleteDoc(doc(db, "usuarios", uid)); 
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
