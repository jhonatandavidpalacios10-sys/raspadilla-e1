export function formatMoney(amount) { return 'S/ ' + parseFloat(amount).toFixed(2); }

let trustedClockAnchorMs = null;
let trustedClockPerformanceAnchorMs = null;
let clockSyncPromise = null;
let lastClockSyncPerformanceMs = 0;
const CLOCK_RESYNC_INTERVAL_MS = 30 * 60 * 1000;

const LIMA_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima',
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

/**
 * Devuelve el instante corregido con la hora HTTP del mismo despliegue cuando
 * ya fue posible sincronizarla. performance.now() mantiene el avance aunque
 * el usuario cambie manualmente el reloj del dispositivo durante la sesión.
 */
export function getTrustedNowMs() {
    if (
        Number.isFinite(trustedClockAnchorMs)
        && Number.isFinite(trustedClockPerformanceAnchorMs)
        && typeof globalThis.performance?.now === 'function'
    ) {
        return trustedClockAnchorMs
            + (globalThis.performance.now() - trustedClockPerformanceAnchorMs);
    }
    return Date.now();
}

/**
 * Sincroniza el reloj sin escribir en Firebase ni usar servicios externos:
 * toma la cabecera Date de manifest.json en el mismo dominio. Si no hay red,
 * la aplicación continúa con el reloj del dispositivo y vuelve a intentarlo.
 */
export function syncTrustedClock({ force = false } = {}) {
    if (typeof window === 'undefined' || typeof fetch !== 'function') {
        return Promise.resolve(false);
    }

    const performanceNow = typeof globalThis.performance?.now === 'function'
        ? globalThis.performance.now()
        : 0;
    if (
        !force
        && Number.isFinite(trustedClockAnchorMs)
        && performanceNow - lastClockSyncPerformanceMs < CLOCK_RESYNC_INTERVAL_MS
    ) {
        return Promise.resolve(true);
    }
    if (clockSyncPromise) return clockSyncPromise;

    clockSyncPromise = (async () => {
        try {
            const startedAt = typeof globalThis.performance?.now === 'function'
                ? globalThis.performance.now()
                : 0;
            const url = new URL('/manifest.json', window.location.href);
            url.searchParams.set('__clock_sync', String(Math.round(startedAt)));
            const response = await fetch(url, {
                method: 'HEAD',
                cache: 'no-store',
                credentials: 'same-origin'
            });
            if (!response.ok) return false;

            const serverDateMs = Date.parse(response.headers.get('date') || '');
            if (!Number.isFinite(serverDateMs)) return false;

            const finishedAt = typeof globalThis.performance?.now === 'function'
                ? globalThis.performance.now()
                : startedAt;
            const halfRoundTripMs = Math.max(
                0,
                Math.min(2000, (finishedAt - startedAt) / 2)
            );
            trustedClockAnchorMs = serverDateMs + halfRoundTripMs;
            trustedClockPerformanceAnchorMs = finishedAt;
            lastClockSyncPerformanceMs = finishedAt;
            return true;
        } catch {
            return false;
        } finally {
            clockSyncPromise = null;
        }
    })();

    return clockSyncPromise;
}

export function getTodayDateStr(instant) {
    const date = instant === undefined
        ? new Date(getTrustedNowMs())
        : (instant instanceof Date ? instant : new Date(instant));
    if (Number.isNaN(date.getTime())) throw new RangeError('Fecha inválida');

    const parts = Object.fromEntries(
        LIMA_DATE_FORMATTER
            .formatToParts(date)
            .filter(({ type }) => type === 'year' || type === 'month' || type === 'day')
            .map(({ type, value }) => [type, value])
    );

    if (!parts.year || !parts.month || !parts.day) {
        throw new Error('No se pudo obtener la fecha contable de Lima');
    }

    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function generateTicketId() { return 'T-' + Math.round(getTrustedNowMs()).toString(36).toUpperCase(); }

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
