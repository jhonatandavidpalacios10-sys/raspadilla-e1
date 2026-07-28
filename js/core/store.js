export const state = {
    currentUser: null,
    userRole: 'vendedor',
    userLocal: 'Local Desconocido',
    userLocalId: '',
    carrito: [],
    pendingSaleAttempt: null,
    productos: [],
    locales: [],
    inventoryFresh: false
};
export function clearCart() { state.carrito = []; }
export function replaceCart(items) {
    state.carrito = Array.isArray(items) ? items : [];
}
export function setPendingSaleAttempt(attempt) {
    state.pendingSaleAttempt = attempt || null;
}
