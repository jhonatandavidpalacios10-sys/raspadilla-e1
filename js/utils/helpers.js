export function formatMoney(amount) { return 'S/ ' + parseFloat(amount).toFixed(2); }
export function getTodayDateStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function generateTicketId() { return 'T-' + Date.now().toString(36).toUpperCase(); }

export function obtenerNombreCliente(venta) {
    const candidatos = [
        venta?.clienteNombre,
        venta?.nombreCliente,
        venta?.nombre_cliente,
        venta?.cliente?.nombre,
        typeof venta?.cliente === 'string' ? venta.cliente : ''
    ];

    for (const valor of candidatos) {
        if (typeof valor === 'string' && valor.trim()) return valor.trim();
    }

    return '';
}

export function escaparHtml(valor) {
    return String(valor)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
