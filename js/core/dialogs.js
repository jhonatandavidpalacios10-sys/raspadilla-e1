let activeDialogCleanup = null;

function closePreviousDialog() {
    activeDialogCleanup?.(null);
    activeDialogCleanup = null;
}

function createDialogShell({
    title,
    message,
    tone = 'amber',
    confirmText = 'Aceptar',
    cancelText = 'Cancelar'
}) {
    closePreviousDialog();

    const toneClasses = {
        amber: ['border-amber-500/30', 'bg-amber-500/10', 'text-amber-400', 'bg-amber-600', 'hover:bg-amber-500'],
        red: ['border-red-500/30', 'bg-red-500/10', 'text-red-400', 'bg-red-600', 'hover:bg-red-500'],
        sky: ['border-sky-500/30', 'bg-sky-500/10', 'text-sky-400', 'bg-sky-600', 'hover:bg-sky-500']
    };
    const selectedTone = toneClasses[tone] || toneClasses.amber;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[190] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 opacity-0 transition-opacity duration-200';
    overlay.innerHTML = `
        <section role="dialog" aria-modal="true" class="w-full max-w-sm scale-95 rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-2xl transition-transform duration-200">
            <div data-dialog-icon class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border-4">
                <i data-lucide="edit-3" class="h-7 w-7"></i>
            </div>
            <h3 data-dialog-title class="mb-2 text-center text-lg font-bold text-white"></h3>
            <p data-dialog-message class="mb-5 text-center text-sm leading-relaxed text-slate-400"></p>
            <div data-dialog-content></div>
            <p data-dialog-error class="mb-3 hidden rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400"></p>
            <div class="mt-5 flex gap-3">
                <button data-dialog-cancel type="button" class="flex-1 rounded-xl bg-slate-700 py-2.5 font-bold text-white transition-colors hover:bg-slate-600"></button>
                <button data-dialog-confirm type="button" class="flex-1 rounded-xl py-2.5 font-bold text-white shadow-lg transition-colors"></button>
            </div>
        </section>
    `;

    const panel = overlay.querySelector('section');
    const icon = overlay.querySelector('[data-dialog-icon]');
    const confirmButton = overlay.querySelector('[data-dialog-confirm]');
    icon.classList.add(selectedTone[0], selectedTone[1], selectedTone[2]);
    confirmButton.classList.add(selectedTone[3], selectedTone[4]);
    overlay.querySelector('[data-dialog-title]').textContent = title;
    overlay.querySelector('[data-dialog-message]').textContent = message;
    overlay.querySelector('[data-dialog-cancel]').textContent = cancelText;
    confirmButton.textContent = confirmText;

    document.body.appendChild(overlay);
    window.lucide?.createIcons({ root: overlay });
    requestAnimationFrame(() => {
        overlay.classList.remove('opacity-0');
        panel.classList.remove('scale-95');
        panel.classList.add('scale-100');
    });

    return { overlay, panel };
}

function finishDialog(overlay, value, resolve) {
    if (!overlay.isConnected || overlay.dataset.dialogSettled === 'true') return;
    overlay.dataset.dialogSettled = 'true';
    const panel = overlay.querySelector('section');
    overlay.classList.add('opacity-0');
    panel?.classList.remove('scale-100');
    panel?.classList.add('scale-95');
    activeDialogCleanup = null;
    setTimeout(() => overlay.remove(), 180);
    resolve(value);
}

export function showSystemConfirm({
    title = 'Confirmar acción',
    message = '¿Deseas continuar?',
    tone = 'amber',
    confirmText = 'Aceptar',
    cancelText = 'Cancelar'
} = {}) {
    return new Promise(resolve => {
        const { overlay } = createDialogShell({
            title,
            message,
            tone,
            confirmText,
            cancelText
        });

        const finish = value => finishDialog(overlay, value, resolve);
        activeDialogCleanup = finish;
        overlay.querySelector('[data-dialog-confirm]').addEventListener('click', () => finish(true));
        overlay.querySelector('[data-dialog-cancel]').addEventListener('click', () => finish(false));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) finish(false);
        });
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') finish(false);
            if (event.key === 'Enter') finish(true);
        });
        overlay.querySelector('[data-dialog-confirm]').focus();
    });
}

export function showSystemInput({
    title = 'Editar valor',
    message = 'Ingresa el nuevo valor.',
    value = '',
    inputMode = 'decimal',
    type = 'number',
    min = '0.01',
    step = '0.01',
    placeholder = '0.00',
    prefix = 'S/',
    tone = 'sky',
    confirmText = 'Guardar',
    cancelText = 'Cancelar',
    validate
} = {}) {
    return new Promise(resolve => {
        const { overlay } = createDialogShell({
            title,
            message,
            tone,
            confirmText,
            cancelText
        });
        const content = overlay.querySelector('[data-dialog-content]');
        const errorElement = overlay.querySelector('[data-dialog-error]');
        const field = document.createElement('div');
        field.className = 'relative';
        field.innerHTML = `
            <span data-dialog-prefix class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500"></span>
            <input data-dialog-input class="w-full rounded-xl border border-slate-700 bg-slate-900 py-3 pl-10 pr-3 text-lg font-black text-white outline-none transition-colors focus:border-sky-500" />
        `;
        const input = field.querySelector('[data-dialog-input]');
        field.querySelector('[data-dialog-prefix]').textContent = prefix;
        input.type = type;
        input.inputMode = inputMode;
        input.min = min;
        input.step = step;
        input.placeholder = placeholder;
        input.value = value;
        content.appendChild(field);

        const showError = messageText => {
            errorElement.textContent = messageText;
            errorElement.classList.toggle('hidden', !messageText);
        };
        const finish = result => finishDialog(overlay, result, resolve);
        const submit = () => {
            const result = input.value.trim();
            const validationMessage = validate?.(result) || '';
            if (validationMessage) {
                showError(validationMessage);
                input.focus();
                input.select();
                return;
            }
            finish(result);
        };

        activeDialogCleanup = finish;
        overlay.querySelector('[data-dialog-confirm]').addEventListener('click', submit);
        overlay.querySelector('[data-dialog-cancel]').addEventListener('click', () => finish(null));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) finish(null);
        });
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') finish(null);
            if (event.key === 'Enter') {
                event.preventDefault();
                submit();
            }
        });
        input.addEventListener('input', () => showError(''));
        input.focus();
        input.select();
    });
}

window.mostrarConfirmacionSistema = showSystemConfirm;
window.solicitarEntradaSistema = showSystemInput;
