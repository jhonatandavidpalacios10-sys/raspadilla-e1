export function formatMoney(amount) { return 'S/ ' + parseFloat(amount).toFixed(2); }
export function getTodayDateStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function generateTicketId() { return 'T-' + Date.now().toString(36).toUpperCase(); }