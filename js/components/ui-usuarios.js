import { db, collection, getDocs, addDoc, doc, updateDoc, deleteDoc, setDoc, getDoc, secondaryAuth, createUserWithEmailAndPassword, updatePassword, signInWithEmailAndPassword, query, where, writeBatch } from '../core/firebase-setup.js';
import { state } from '../core/store.js';
import {
    subscribeLocations,
    subscribeUsers
} from '../core/data-service.js';
import { escaparHtml } from '../utils/helpers.js';

let listaUsuariosEl, listaLocalesEl, selectLocalUsuario; 
const MASTER_UID = "kRG6hOWsWHfoJwWLCXAkqRuVNLk2";
let usuariosInicializado = false;
let unsubscribeUsuarios = null;
let unsubscribeLocalesUsuarios = null;
let usuariosEnMemoria = [];
let usuariosSessionGeneration = 0;
let usuariosSnapshotReady = false;
let localesSnapshotReady = false;
let usuariosSubscriptionError = false;
let usuariosRetryTimer = null;
let usuariosRetryAttempts = 0;
let lastUsuariosMarkup = null;
let lastLocalesMarkup = null;
let localesSubscriptionError = false;
let localesRetryTimer = null;
let localesRetryAttempts = 0;
let createModalHideTimer = null;
let createModalShowTimer = null;
let editModalHideTimer = null;
let editModalShowTimer = null;
let createModalGeneration = 0;
let editModalGeneration = 0;
const USER_SUBMIT_IDLE_HTML = 'Guardar Personal';

function resetUserSubmitButton() {
    const button = document.querySelector('#form-usuario button[type="submit"]');
    if (!button) return;
    button.innerHTML = USER_SUBMIT_IDLE_HTML;
    button.disabled = false;
}

function clearCreateModalTimers() {
    if (createModalHideTimer !== null) clearTimeout(createModalHideTimer);
    if (createModalShowTimer !== null) clearTimeout(createModalShowTimer);
    createModalHideTimer = null;
    createModalShowTimer = null;
}

function clearEditModalTimers() {
    if (editModalHideTimer !== null) clearTimeout(editModalHideTimer);
    if (editModalShowTimer !== null) clearTimeout(editModalShowTimer);
    editModalHideTimer = null;
    editModalShowTimer = null;
}

function scheduleLocalesRetry(generation) {
    clearTimeout(localesRetryTimer);
    localesRetryAttempts++;
    const delay = Math.min(30_000, 2_000 * (2 ** (localesRetryAttempts - 1)));
    localesRetryTimer = setTimeout(() => {
        localesRetryTimer = null;
        if (generation !== usuariosSessionGeneration || !usuariosInicializado) return;
        startLocalesSubscription(generation);
    }, delay);
}

function startLocalesSubscription(generation) {
    unsubscribeLocalesUsuarios?.();
    unsubscribeLocalesUsuarios = subscribeLocations((locations, metadata) => {
        if (generation !== usuariosSessionGeneration) return;
        if (metadata?.deferredEmptyCache !== true) {
            localesSnapshotReady = true;
        }
        clearTimeout(localesRetryTimer);
        localesRetryTimer = null;
        localesRetryAttempts = 0;
        localesSubscriptionError = false;
        renderLocales(locations);
        renderUsuarios(usuariosEnMemoria);
    }, error => {
        if (generation !== usuariosSessionGeneration) return;
        console.warn('Las sedes continuarán desde la caché local:', error);
        unsubscribeLocalesUsuarios = null;
        localesSubscriptionError = true;
        localesSnapshotReady = true;
        renderLocales(state.locales);
        renderUsuarios(usuariosEnMemoria);
        scheduleLocalesRetry(generation);
    });
}

function scheduleUsuariosRetry(generation) {
    clearTimeout(usuariosRetryTimer);
    usuariosRetryAttempts++;
    const delay = Math.min(30_000, 2_000 * (2 ** (usuariosRetryAttempts - 1)));
    usuariosRetryTimer = setTimeout(() => {
        usuariosRetryTimer = null;
        if (generation !== usuariosSessionGeneration || !usuariosInicializado) return;
        startUsuariosSubscription(generation);
    }, delay);
}

function startUsuariosSubscription(generation) {
    unsubscribeUsuarios?.();
    unsubscribeUsuarios = subscribeUsers((rows, metadata) => {
        if (generation !== usuariosSessionGeneration) return;
        if (
            rows.length === 0
            && metadata?.fromCache === true
            && metadata?.hasPendingWrites !== true
            && (
                usuariosEnMemoria.length > 0
                || metadata?.emptyCacheSettled !== true
            )
            && (typeof navigator === 'undefined' || navigator.onLine !== false)
        ) {
            renderUsuarios(usuariosEnMemoria);
            return;
        }
        clearTimeout(usuariosRetryTimer);
        usuariosRetryTimer = null;
        usuariosRetryAttempts = 0;
        usuariosSubscriptionError = false;
        usuariosEnMemoria = rows;
        usuariosSnapshotReady = true;
        renderUsuarios(usuariosEnMemoria);
    }, error => {
        if (generation !== usuariosSessionGeneration) return;
        console.warn('Los usuarios continuarán desde la caché local:', error);
        unsubscribeUsuarios = null;
        usuariosSubscriptionError = true;
        renderUsuarios(usuariosEnMemoria);
        scheduleUsuariosRetry(generation);
    });
}

export function initUsuarios() {
    if (usuariosInicializado) return;
    usuariosInicializado = true;
    const generation = ++usuariosSessionGeneration;

    listaUsuariosEl = document.getElementById('usuarios-list'); 
    listaLocalesEl = document.getElementById('locales-list'); 
    selectLocalUsuario = document.getElementById('user-local');
    localesSnapshotReady = state.locales.length > 0;
    
    // Formularios y Botones Principales
    const formUsuario = document.getElementById('form-usuario'); 
    if(formUsuario) formUsuario.onsubmit = guardarNuevoUsuario;
    resetUserSubmitButton();
    
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

    renderLocales(state.locales);
    renderUsuarios(usuariosEnMemoria);

    startLocalesSubscription(generation);

    startUsuariosSubscription(generation);
}

export function destroyUsuarios() {
    usuariosSessionGeneration++;
    createModalGeneration++;
    editModalGeneration++;
    clearCreateModalTimers();
    clearEditModalTimers();
    unsubscribeUsuarios?.();
    unsubscribeLocalesUsuarios?.();
    unsubscribeUsuarios = null;
    unsubscribeLocalesUsuarios = null;
    clearTimeout(usuariosRetryTimer);
    usuariosRetryTimer = null;
    usuariosRetryAttempts = 0;
    clearTimeout(localesRetryTimer);
    localesRetryTimer = null;
    localesRetryAttempts = 0;
    usuariosEnMemoria = [];
    usuariosSnapshotReady = false;
    localesSnapshotReady = false;
    usuariosSubscriptionError = false;
    localesSubscriptionError = false;
    lastUsuariosMarkup = null;
    lastLocalesMarkup = null;
    usuariosInicializado = false;

    const formUsuario = document.getElementById('form-usuario');
    const formLocal = document.getElementById('form-local');
    const btnNuevo = document.getElementById('btn-nuevo-usuario');
    const btnCerrar = document.getElementById('btn-cerrar-modal-usuario');
    const btnSincronizar = document.getElementById('btn-sincronizar-usuarios');
    if (formUsuario) formUsuario.onsubmit = null;
    if (formLocal) formLocal.onsubmit = null;
    if (btnNuevo) btnNuevo.onclick = null;
    if (btnCerrar) btnCerrar.onclick = null;
    btnSincronizar?.removeEventListener('click', sincronizarDirectorioLogin);
    if (btnSincronizar) {
        btnSincronizar.disabled = false;
        btnSincronizar.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i> <span class="hidden sm:inline">Sincronizar</span>';
        if (window.lucide) window.lucide.createIcons({ root: btnSincronizar });
    }
    resetUserSubmitButton();
    if (listaLocalesEl) {
        listaLocalesEl.onclick = null;
        listaLocalesEl.innerHTML = '';
    }
    if (listaUsuariosEl) {
        listaUsuariosEl.onclick = null;
        listaUsuariosEl.onchange = null;
        listaUsuariosEl.innerHTML = '';
    }
    listaUsuariosEl = null;
    listaLocalesEl = null;
    selectLocalUsuario = null;

    const editModal = document.getElementById('modal-editar-usuario');
    if (editModal) {
        editModal.innerHTML = '';
        editModal.remove();
    }
    const createModal = document.getElementById('modal-usuario');
    if (createModal) {
        createModal.classList.add('hidden', 'opacity-0');
        createModal.querySelector('form')?.reset();
        createModal.querySelectorAll('input').forEach(input => {
            if (input.type !== 'checkbox' && input.type !== 'radio') input.value = '';
        });
    }
}

/**
 * Función Maestra para migrar cuentas antiguas al nuevo sistema de login.
 * Crea las entradas en 'directorio_login' basándose en los usuarios existentes.
 */
async function sincronizarDirectorioLogin() {
    if (state.userRole !== 'master') return;
    const generation = usuariosSessionGeneration;
    
    if (window.mostrarConfirmacion) {
        window.mostrarConfirmacion("¿Sincronizar cuentas antiguas con el nuevo sistema de login?", async () => {
            if (generation !== usuariosSessionGeneration) return;
            const btn = document.getElementById('btn-sincronizar-usuarios');
            const originalHtml = btn ? btn.innerHTML : '';
            if (btn) {
                btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline mr-2"></i> Procesando...';
                btn.disabled = true;
                if(window.lucide) window.lucide.createIcons({ root: btn });
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
                if (generation !== usuariosSessionGeneration) return;
                if(window.mostrarToast) window.mostrarToast('Éxito', `${procesados} cuentas sincronizadas correctamente.`, 'emerald');
                cargarUsuariosYLocales();
            } catch (err) {
                console.error("Error en sincronización:", err);
                if (generation !== usuariosSessionGeneration) return;
                if(window.mostrarAlerta) window.mostrarAlerta("Error", "No se pudo completar la sincronización masiva.", "red");
            } finally {
                if (btn && generation === usuariosSessionGeneration) {
                    btn.innerHTML = originalHtml;
                    btn.disabled = false;
                    if(window.lucide) window.lucide.createIcons({ root: btn });
                }
            }
        });
    }
}

function cerrarModalEditarUsuario(modal = document.getElementById('modal-editar-usuario')) {
    if (!modal) return;
    const generation = usuariosSessionGeneration;
    const modalGeneration = ++editModalGeneration;
    clearEditModalTimers();
    modal.classList.add('opacity-0');
    editModalHideTimer = setTimeout(() => {
        editModalHideTimer = null;
        if (
            generation !== usuariosSessionGeneration
            || modalGeneration !== editModalGeneration
            || !modal.isConnected
        ) return;
        modal.classList.add('hidden');
    }, 300);
}

function abrirModalEditarUsuario(uid, username, email, oldPass, rol, localId, localNombre, permisosStr) {
    clearEditModalTimers();
    const generation = usuariosSessionGeneration;
    const modalGeneration = ++editModalGeneration;
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

    const safeUid = escaparHtml(uid || '');
    const safeUsername = escaparHtml(username || '');
    const safeEmail = escaparHtml(email || '');
    const safeOldPass = escaparHtml(oldPass || '');
    const safeRol = escaparHtml(rol || '');
    const safeLocalId = escaparHtml(localId || '');
    const safeLocalNombre = escaparHtml(localNombre || '');
    
    m.innerHTML = `
        <div class="bg-slate-800 p-6 rounded-2xl shadow-2xl w-full max-w-sm border border-slate-700 relative">
            <header class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-bold text-slate-800 dark:text-white">Editar Cuenta</h3>
                <button type="button" id="btn-close-x-edit-user" class="text-slate-400 hover:text-slate-800 dark:hover:text-white bg-slate-100 dark:bg-slate-700 p-1.5 rounded-lg transition-colors"><i data-lucide="x" class="w-5 h-5"></i></button>
            </header>
            
            <input type="hidden" id="edit-target-uid" value="${safeUid}">
            <input type="hidden" id="edit-target-oldpass" value="${safeOldPass}">
            <input type="hidden" id="edit-target-email" value="${safeEmail}">
            <input type="hidden" id="edit-target-oldusername" value="${safeUsername}">
            <input type="hidden" id="edit-target-rol" value="${safeRol}">
            <input type="hidden" id="edit-target-localId" value="${safeLocalId}">
            <input type="hidden" id="edit-target-localNombre" value="${safeLocalNombre}">
            
            <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Nombre de Usuario (Login)</label>
            <input type="text" id="edit-user-nombre" value="${safeUsername}" autocomplete="off" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-800 dark:text-white lowercase outline-none focus:border-sky-500 transition-colors mb-3">
            
            <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Nueva Contraseña</label>
            <input type="text" id="edit-user-pass" value="${safeOldPass}" autocomplete="off" spellcheck="false" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-800 dark:text-white outline-none focus:border-sky-500 transition-colors mb-3">
            
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
    
    const closeModalFn = () => cerrarModalEditarUsuario(m);
    
    document.getElementById('btn-cancel-edit-user').onclick = closeModalFn;
    document.getElementById('btn-close-x-edit-user').onclick = closeModalFn;
    document.getElementById('btn-confirm-edit-user').onclick = ejecutarEditarUsuario;
    document.getElementById('edit-user-nombre').oninput = (e) => e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    
    m.classList.remove('hidden'); 
    editModalShowTimer = setTimeout(() => {
        editModalShowTimer = null;
        if (
            generation !== usuariosSessionGeneration
            || modalGeneration !== editModalGeneration
            || !m.isConnected
        ) return;
        m.classList.remove('opacity-0');
    }, 10);
    if(window.lucide) window.lucide.createIcons({ root: m });
}

async function ejecutarEditarUsuario() {
    const generation = usuariosSessionGeneration;
    const modalGeneration = editModalGeneration;
    const isCurrentEditRequest = () => (
        generation === usuariosSessionGeneration
        && modalGeneration === editModalGeneration
    );
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
    if(window.lucide) window.lucide.createIcons({ root: btn }); 
    btn.disabled = true;

    try {
        // Validar si el nuevo nombre ya está ocupado por OTRA cuenta ACTIVA
        if (newUsername !== oldUsername) {
            const qCheck = query(collection(db, "usuarios"), where("username", "==", newUsername), where("activo", "==", true));
            const checkSnap = await getDocs(qCheck);
            if (!isCurrentEditRequest()) return;
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
        
        if (!isCurrentEditRequest()) return;
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta actualizada correctamente', 'emerald');
        cerrarModalEditarUsuario();
        
    } catch (err) {
        console.error(err);
        if (!isCurrentEditRequest()) return;
        if(window.mostrarAlerta) window.mostrarAlerta('Error', 'No se pudo actualizar la cuenta.', 'red'); 
    } finally { 
        if (isCurrentEditRequest() && btn.isConnected) {
            btn.innerHTML = originalText; 
            btn.disabled = false; 
        }
    }
}

function abrirModalUsuarioConfig() { 
    clearCreateModalTimers();
    const generation = usuariosSessionGeneration;
    const modalGeneration = ++createModalGeneration;
    resetUserSubmitButton();
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
    createModalShowTimer = setTimeout(() => {
        createModalShowTimer = null;
        if (
            generation !== usuariosSessionGeneration
            || modalGeneration !== createModalGeneration
        ) return;
        m.classList.remove('opacity-0');
    }, 10); 
}

function cerrarModalUsuario() { 
    const m = document.getElementById('modal-usuario'); 
    if(m) {
        clearCreateModalTimers();
        const generation = usuariosSessionGeneration;
        const modalGeneration = ++createModalGeneration;
        resetUserSubmitButton();
        m.classList.add('opacity-0'); 
        createModalHideTimer = setTimeout(() => {
            createModalHideTimer = null;
            if (
                generation !== usuariosSessionGeneration
                || modalGeneration !== createModalGeneration
            ) return;
            m.classList.add('hidden');
        }, 300); 
    }
}

export function cargarUsuariosYLocales() {
    return Promise.resolve();
}

function renderLocales(rows = []) {
    if (!listaLocalesEl) return;
    const locations = [...rows].sort((a, b) => (
        String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es')
    ));
    const selectedLocation = selectLocalUsuario?.value || '';
    let html = '';
    let asignHtml = '<option value="">Sin Asignar</option>';

    locations.forEach(loc => {
        const id = escaparHtml(loc?.id || '');
        const nombre = escaparHtml(loc?.nombre || 'Sin nombre');
        html += `<div class="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 rounded-xl flex items-center justify-between mb-2 transition-colors hover:border-emerald-500/50"><div><span class="font-bold text-slate-800 dark:text-white text-sm">${nombre}</span></div><div class="flex gap-2"><button data-action="eliminar-local" data-id="${id}" class="text-slate-400 hover:text-red-500 p-1 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div></div>`;
        asignHtml += `<option value="${id}">${nombre}</option>`;
    });

    const listMarkup = html || (
        localesSubscriptionError
            ? '<p class="text-xs text-amber-500 p-2">Sin conexión. Reintentando sedes automáticamente…</p>'
            : localesSnapshotReady
            ? '<p class="text-xs text-slate-500 p-2">Sin sucursales registradas.</p>'
            : '<p class="text-xs text-slate-500 p-2">Preparando sedes guardadas…</p>'
    );
    const markupSignature = `${listMarkup}\u0000${asignHtml}`;
    if (markupSignature !== lastLocalesMarkup) {
        listaLocalesEl.innerHTML = listMarkup;
        if (selectLocalUsuario) {
            selectLocalUsuario.innerHTML = asignHtml;
            const selectedStillExists = [...selectLocalUsuario.options]
                .some(option => option.value === selectedLocation);
            if (selectedStillExists) selectLocalUsuario.value = selectedLocation;
        }
        lastLocalesMarkup = markupSignature;
        if (window.lucide) window.lucide.createIcons({ root: listaLocalesEl });
    }
}

function renderUsuarios(rows = []) {
    if (!listaUsuariosEl) return;
    if (!usuariosSnapshotReady || !localesSnapshotReady) {
        const loadingMarkup = usuariosSubscriptionError
            ? '<p class="text-xs text-amber-500 p-2">Sin conexión. Reintentando usuarios automáticamente…</p>'
            : !localesSnapshotReady
                ? '<p class="text-xs text-slate-500 p-2">Preparando usuarios y sedes guardados…</p>'
                : '<p class="text-xs text-slate-500 p-2">Preparando usuarios guardados…</p>';
        if (loadingMarkup !== lastUsuariosMarkup) {
            listaUsuariosEl.innerHTML = loadingMarkup;
            lastUsuariosMarkup = loadingMarkup;
        }
        return;
    }

    const allU = rows
        .filter(user => user?.activo !== false || state.userRole === 'master')
        .map(user => ({ ...user, uid: user.id || user.uid }))
        .sort((a, b) => String(a.username || a.email || '').localeCompare(
            String(b.username || b.email || ''),
            'es'
        ));

    let html = '';
    let selectOptions = '<option value="">Sin Local</option>';
    state.locales.forEach(location => {
        selectOptions += `<option value="${escaparHtml(location.id || '')}">${escaparHtml(location.nombre || 'Sin nombre')}</option>`;
    });

    const knownLocationIds = new Set(
        state.locales.map(location => String(location.id || ''))
    );
    state.locales.forEach(location => {
        const usrsLoc = allU.filter(user => user.localId === location.id);
        if (usrsLoc.length === 0) return;
        html += `<div class="mt-4 mb-2 border-b border-slate-200 dark:border-slate-700 pb-1"><h4 class="text-xs font-bold text-sky-500 uppercase tracking-wider">${escaparHtml(location.nombre || 'Sin nombre')}</h4></div>`;
        usrsLoc.forEach(user => {
            html += genU(user, selectOptions);
        });
    });

    const usrsSin = allU.filter(user => (
        !user.localId || !knownLocationIds.has(String(user.localId))
    ));
    if (usrsSin.length > 0) {
        html += '<div class="mt-4 mb-2 border-b border-slate-200 dark:border-slate-700 pb-1"><h4 class="text-xs font-bold text-slate-500 uppercase tracking-wider">Sin Asignar / Sede no disponible</h4></div>';
        usrsSin.forEach(user => {
            html += genU(user, selectOptions);
        });
    }

    const markup = html || '<p class="text-xs text-slate-500 p-2">Sin usuarios.</p>';
    if (markup !== lastUsuariosMarkup) {
        listaUsuariosEl.innerHTML = markup;
        lastUsuariosMarkup = markup;
        if (window.lucide) window.lucide.createIcons({ root: listaUsuariosEl });
    }
}

function genU(u, opts) {
    const normalizedRole = String(u.rol || 'vendedor').trim().toLowerCase();
    const roleValue = normalizedRole === 'administrador'
        ? 'admin'
        : normalizedRole;
    const isThisCardMaster = roleValue === 'master' || u.uid === MASTER_UID;
    if (isThisCardMaster && state.userRole !== 'master') return ''; 
    const currentRole = String(state.userRole || '').trim().toLowerCase();
    const isPrivileged = ['admin', 'administrador', 'master'].includes(currentRole);
    const isMe = (u.uid === state.currentUser?.uid); 
    const isInactive = u.activo === false;
    
    // Fallback por si hay usuarios muy antiguos sin el campo username
    const usernameDisplay = u.username || (u.email ? u.email.split('@')[0] : 'Desconocido');
    const safeUid = escaparHtml(u.uid || '');
    const safeUsername = escaparHtml(usernameDisplay);
    const safeEmail = escaparHtml(u.email || '');
    const safePassword = escaparHtml(u.pass_visible || '');
    const safeRole = escaparHtml(
        roleValue === 'admin'
            ? 'Administrador'
            : (roleValue || 'vendedor')
    );
    const safeLocalId = escaparHtml(u.localId || '');
    const safeLocalName = escaparHtml(u.localNombre || '');
    
    let passDisplay = u.pass_visible || 'Oculta'; 
    let passHtml = '';
    
    if (isPrivileged) {
        const permisosJson = escaparHtml(
            u.permisos && u.permisos.length > 0 ? JSON.stringify(u.permisos) : ''
        );
        const btnEditHtml = `<button data-action="editar-pass" data-uid="${safeUid}" data-username="${safeUsername}" data-email="${safeEmail}" data-oldpass="${safePassword}" data-rol="${safeRole}" data-localid="${safeLocalId}" data-localnombre="${safeLocalName}" data-permisos="${permisosJson}" title="Editar Cuenta" class="min-h-8 min-w-8 flex items-center justify-center text-amber-500 hover:text-amber-600 p-0.5 ml-1 transition-colors"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>`;
        passHtml = `<div class="flex items-center gap-1 mt-1 bg-slate-100 dark:bg-slate-900 w-fit px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700"><span class="text-[10px] text-sky-500 font-mono tracking-wider">${escaparHtml(passDisplay)}</span>${u.pass_visible ? `<button data-action="copiar-pass" data-pass="${safePassword}" title="Copiar Contraseña" class="text-slate-400 hover:text-slate-600 dark:hover:text-white p-0.5 transition-colors"><i data-lucide="copy" class="w-3.5 h-3.5"></i></button>` : ''}${btnEditHtml}</div>`;
    }

    let roleOptions = `<option value="vendedor" ${roleValue === 'vendedor' ? 'selected' : ''}>Vendedor</option><option value="admin" ${roleValue === 'admin' ? 'selected' : ''}>Admin</option>`;
    if (state.userRole === 'master') roleOptions += `<option value="master" ${roleValue === 'master' ? 'selected' : ''}>Master</option>`;
    
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
    } else if (roleValue === 'admin' && !isInactive) { 
        cardBorderColor = 'border-purple-300 dark:border-purple-500/50 shadow-lg shadow-purple-500/10 bg-gradient-to-r from-purple-50/50 to-white dark:from-purple-900/10 dark:to-slate-800'; 
        userIconColor = 'text-purple-500'; 
        userIconBg = 'bg-purple-100 dark:bg-purple-500/20'; 
        userIconType = 'shield-check'; 
        roleTextColor = 'text-purple-600 dark:text-purple-400'; 
    }
    
    const inactiveBadge = isInactive ? `<span class="bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/30 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ml-2">Desactivado</span>` : '';
    const renderRoleSelector = isMe ? `<span class="min-h-11 flex items-center bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 ${roleTextColor} rounded-lg px-2 py-1 text-xs font-bold uppercase tracking-wider">${safeRole}</span>` : `<select data-action="cambiar-rol" data-uid="${safeUid}" class="min-h-11 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 rounded-lg px-2 py-1 text-xs cursor-pointer outline-none focus:border-sky-500 transition-colors">${roleOptions}</select>`;

    // Mostrar el correo oculto real solo si es Master
    const correoOcultoHtml = state.userRole === 'master' ? `<p class="text-[9px] text-slate-400 font-mono mt-0.5" title="Correo interno del sistema">${safeEmail}</p>` : '';

    return `
    <div class="border ${cardBorderColor} rounded-xl p-3 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-2 transition-all hover:shadow-md min-w-0">
        <div class="flex items-center gap-3 min-w-0">
            <div class="w-8 h-8 rounded-full ${userIconBg} flex items-center justify-center ${userIconColor} shrink-0"><i data-lucide="${userIconType}" class="w-4 h-4"></i></div>
            <div class="min-w-0">
                <p class="font-bold text-slate-800 dark:text-white text-sm flex items-center gap-2 capitalize min-w-0"><span class="truncate">${safeUsername}</span> ${isMe ? '<span class="text-[9px] bg-slate-800 text-white px-1.5 py-0.5 rounded uppercase shrink-0">Tú</span>' : ''} ${inactiveBadge}</p>
                <p class="text-[10px] ${roleTextColor}">Rol: <span class="uppercase font-bold tracking-wide">${safeRole}</span></p>
                ${correoOcultoHtml}
                ${passHtml}
            </div>
        </div>
        ${(u.uid === MASTER_UID && !isMe) ? 
            `<span class="bg-amber-500 text-white px-2 py-0.5 rounded text-xs font-bold shadow-md">Dueño Principal</span>` : 
            `<div class="flex gap-2 w-full sm:w-auto mt-2 sm:mt-0 items-center min-w-0">
                <select data-action="cambiar-local" data-uid="${safeUid}" class="min-h-11 min-w-0 flex-1 sm:flex-none bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 rounded-lg px-2 py-1 text-xs cursor-pointer outline-none focus:border-sky-500 transition-colors">${opts.replace(`value="${safeLocalId}"`, `value="${safeLocalId}" selected`)}</select>
                ${renderRoleSelector}
                ${!isMe ? `<button data-action="eliminar-usuario" data-uid="${safeUid}" data-activo="${!isInactive}" title="${isInactive ? 'Eliminar Definitivamente (Solo Master)' : 'Desactivar Acceso'}" class="min-h-11 min-w-11 flex items-center justify-center text-red-500 hover:text-red-600 bg-red-50 dark:bg-slate-900 border border-red-200 dark:border-slate-700 rounded-lg p-1 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
            </div>`
        }
    </div>`;
}

async function guardarLocal(e) { 
    e.preventDefault(); 
    const generation = usuariosSessionGeneration;
    const n = document.getElementById('nuevo-local-nombre').value.trim(); 
    if (!n) return;
    if (state.locales.some(local => (
        String(local.nombre || '').trim().toLowerCase() === n.toLowerCase()
    ))) {
        window.mostrarToast?.('Sede duplicada', 'Ya existe una sede con ese nombre.', 'amber');
        return;
    }

    try {
        await addDoc(collection(db, "locales"), { nombre: n }); 
        if (generation !== usuariosSessionGeneration) return;
        document.getElementById('nuevo-local-nombre').value = ''; 
        window.mostrarToast?.('Sede creada', 'La sede ya está disponible en los filtros.', 'emerald');
    } catch (error) {
        console.error('No se pudo crear la sede:', error);
        if (generation !== usuariosSessionGeneration) return;
        window.mostrarAlerta?.('No se pudo crear', 'Revisa la conexión e inténtalo nuevamente.', 'red');
    }
}

async function eliminarLocal(id) { 
    const generation = usuariosSessionGeneration;
    if(window.mostrarConfirmacion) window.mostrarConfirmacion("¿Eliminar sede definitivamente?", async () => {
        if (generation !== usuariosSessionGeneration) return;
        try {
            const referencedCollections = ['usuarios', 'productos', 'ventas', 'gastos'];
            const references = await Promise.all(
                referencedCollections.map(name => getDocs(
                    query(collection(db, name), where('localId', '==', id))
                ))
            );
            if (generation !== usuariosSessionGeneration) return;
            if (references.some(snapshot => !snapshot.empty)) {
                window.mostrarAlerta?.(
                    'Sede en uso',
                    'No se puede eliminar mientras tenga usuarios, productos, ventas o gastos asociados.',
                    'amber'
                );
                return;
            }

            await deleteDoc(doc(db, "locales", id)); 
            if (generation !== usuariosSessionGeneration) return;
            window.mostrarToast?.('Sede eliminada', 'La sede fue retirada de los filtros.', 'emerald');
        } catch (error) {
            console.error('No se pudo eliminar la sede:', error);
            if (generation !== usuariosSessionGeneration) return;
            window.mostrarAlerta?.('No se pudo eliminar', 'Revisa la conexión e inténtalo nuevamente.', 'red');
        }
    }); 
}

// NUEVA LÓGICA DE CREACIÓN: Nombre limpio visible + Correo aleatorio oculto
async function guardarNuevoUsuario(e) { 
    e.preventDefault(); 
    const generation = usuariosSessionGeneration;
    const modalGeneration = createModalGeneration;
    const isCurrentCreateRequest = () => (
        generation === usuariosSessionGeneration
        && modalGeneration === createModalGeneration
    );
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
    const btnOriginal = USER_SUBMIT_IDLE_HTML; 
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline"></i> Creando...'; 
    if(window.lucide) window.lucide.createIcons({ root: btn }); 
    btn.disabled = true;

    try { 
        // 1. Verificar que el nombre NO esté siendo usado por una cuenta ACTIVA
        const qActive = query(collection(db, "usuarios"), where("username", "==", rawName), where("activo", "==", true));
        const activeSnap = await getDocs(qActive);
        if (!isCurrentCreateRequest()) return;
        
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
        
        if (!isCurrentCreateRequest()) return;
        if(window.mostrarToast) window.mostrarToast('Éxito', 'Cuenta creada con éxito', 'emerald'); 
        cerrarModalUsuario(); 
    } catch(error) {
        if (!isCurrentCreateRequest()) return;
        if (error.code === 'auth/weak-password') { 
            if(window.mostrarToast) window.mostrarToast('Error', 'La contraseña debe tener mínimo 6 caracteres.', 'red'); 
        } else { 
            if(window.mostrarAlerta) window.mostrarAlerta('Error', `Fallo al conectar: ${error.code}`, 'red'); 
        }
    } finally { 
        if (isCurrentCreateRequest() && btn.isConnected) {
            btn.innerHTML = btnOriginal; 
            btn.disabled = false; 
        }
    }
}

async function eliminarUsuario(uid, isActivo) { 
    const generation = usuariosSessionGeneration;
    if(window.mostrarConfirmacion) {
        if (isActivo) { 
            window.mostrarConfirmacion("¿Desactivar acceso? El usuario no podrá entrar, pero mantendrás su historial.", async () => { 
                if (generation !== usuariosSessionGeneration) return;
                try {
                    await updateDoc(doc(db, "usuarios", uid), { activo: false }); 
                    if (generation !== usuariosSessionGeneration) return;
                    cargarUsuariosYLocales(); 
                    if(window.mostrarToast) window.mostrarToast('Desactivado', 'Usuario bloqueado exitosamente.', 'sky'); 
                } catch (error) {
                    console.error('No se pudo desactivar el usuario:', error);
                    if (generation !== usuariosSessionGeneration) return;
                    window.mostrarAlerta?.('No se pudo desactivar', 'Revisa la conexión e inténtalo nuevamente.', 'red');
                }
            }); 
        } else { 
            // Solo los Masters deberían poder ver y clickear esto según la UI
            if (state.userRole !== 'master') return;
            window.mostrarConfirmacion("¿Eliminar DEFINITIVAMENTE del sistema? Esto no se puede deshacer.", async () => { 
                if (generation !== usuariosSessionGeneration) return;
                try {
                    // Limpiar del directorio público también
                    const uRef = doc(db, "usuarios", uid);
                    const uSnap = await getDoc(uRef);
                    if (uSnap.exists() && uSnap.data().username) {
                        await deleteDoc(doc(db, "directorio_login", uSnap.data().username));
                    }

                    await deleteDoc(uRef); 
                    if (generation !== usuariosSessionGeneration) return;
                    cargarUsuariosYLocales(); 
                    if(window.mostrarToast) window.mostrarToast('Eliminado', 'Registro borrado permanentemente.', 'emerald'); 
                } catch (error) {
                    console.error('No se pudo eliminar el usuario:', error);
                    if (generation !== usuariosSessionGeneration) return;
                    window.mostrarAlerta?.('No se pudo eliminar', 'Revisa la conexión e inténtalo nuevamente.', 'red');
                }
            }); 
        }
    }
}

async function cambiarRolUsuario(uid, rol) { 
    const generation = usuariosSessionGeneration;
    const index = usuariosEnMemoria.findIndex(user => (user.uid || user.id) === uid);
    const previous = index >= 0 ? usuariosEnMemoria[index] : null;
    if (index >= 0) {
        usuariosEnMemoria[index] = { ...usuariosEnMemoria[index], rol };
        renderUsuarios(usuariosEnMemoria);
    }
    try {
        await updateDoc(doc(db, "usuarios", uid), { rol });
        if (generation !== usuariosSessionGeneration) return;
        window.mostrarToast?.('Listo', 'Nivel de acceso actualizado', 'sky');
    } catch (error) {
        console.error('No se pudo actualizar el rol:', error);
        if (generation !== usuariosSessionGeneration) return;
        if (index >= 0 && previous) {
            usuariosEnMemoria[index] = previous;
            renderUsuarios(usuariosEnMemoria);
        }
        window.mostrarAlerta?.(
            'No se pudo actualizar',
            'El rol volvió a su valor anterior. Revisa la conexión.',
            'red'
        );
    }
}

async function cambiarLocalUsuario(uid, locId) { 
    const l = state.locales.find(x => x.id === locId); 
    const generation = usuariosSessionGeneration;
    const index = usuariosEnMemoria.findIndex(user => (user.uid || user.id) === uid);
    const previous = index >= 0 ? usuariosEnMemoria[index] : null;
    const localNombre = l?.nombre || 'Sin Local';
    if (index >= 0) {
        usuariosEnMemoria[index] = {
            ...usuariosEnMemoria[index],
            localId: locId,
            localNombre
        };
        renderUsuarios(usuariosEnMemoria);
    }
    try {
        await updateDoc(doc(db, "usuarios", uid), { localId: locId, localNombre });
        if (generation !== usuariosSessionGeneration) return;
        window.mostrarToast?.(
            'Sede actualizada',
            'El usuario fue movido de local.',
            'sky'
        );
    } catch (error) {
        console.error('No se pudo cambiar la sede del usuario:', error);
        if (generation !== usuariosSessionGeneration) return;
        if (index >= 0 && previous) {
            usuariosEnMemoria[index] = previous;
            renderUsuarios(usuariosEnMemoria);
        }
        window.mostrarAlerta?.(
            'No se pudo actualizar',
            'La sede volvió a su valor anterior. Revisa la conexión.',
            'red'
        );
    }
}
