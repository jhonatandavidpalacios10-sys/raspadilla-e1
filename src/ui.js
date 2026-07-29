import {
  formatPrice,
  getCategoryLabel,
  getImageKey,
  getPriceSummary,
  getProductPrices,
} from './catalog-model.js';

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Falta el elemento #${id}.`);
  return element;
}

function setText(element, value) {
  element.textContent = String(value ?? '');
}

function createStaticCard() {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'product-card';
  card.innerHTML = `
    <span class="card-image-wrap">
      <img class="product-image" alt="" loading="lazy" decoding="async">
      <span class="image-placeholder" aria-hidden="true">
        <img src="/assets/img/logo.png" alt="">
      </span>
      <span class="sold-out-badge hidden">Agotado</span>
    </span>
    <span class="card-body">
      <span class="product-category"></span>
      <span class="card-title"></span>
      <span class="card-description"></span>
      <span class="card-footer">
        <span class="card-price"></span>
        <span class="details-cue" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="m9 6 6 6-6 6"></path>
          </svg>
        </span>
      </span>
    </span>
  `;
  return card;
}

export class CatalogUI {
  constructor({
    imageRepository,
    onRetry,
  }) {
    this.imageRepository = imageRepository;
    this.onRetry = onRetry;
    this.products = [];
    this.productsById = new Map();
    this.locations = [];
    this.selectedLocationId = 'general';
    this.cards = new Map();
    this.imageRetryTimers = new WeakMap();
    this.retryTimeouts = new Set();
    this.lastFocusedElement = null;
    this.dialogToken = 0;
    this.dialogProductId = '';
    this.brandImageToken = 0;

    this.elements = {
      title: requiredElement('catalog-title'),
      brandLogo: requiredElement('brand-logo'),
      statusBanner: requiredElement('status-banner'),
      loading: requiredElement('catalog-loading'),
      grid: requiredElement('product-grid'),
      empty: requiredElement('empty-state'),
      emptyTitle: requiredElement('empty-title'),
      emptyMessage: requiredElement('empty-message'),
      error: requiredElement('error-state'),
      errorMessage: requiredElement('error-message'),
      retry: requiredElement('retry-button'),
      dialogLayer: requiredElement('product-dialog'),
      dialogBackdrop: requiredElement('dialog-backdrop'),
      dialogClose: requiredElement('dialog-close'),
      dialogImage: requiredElement('dialog-image'),
      dialogImageWrap: requiredElement('dialog-image-wrap'),
      dialogImagePlaceholder: requiredElement('dialog-image-placeholder'),
      dialogSoldOut: requiredElement('dialog-sold-out'),
      dialogCategory: requiredElement('dialog-category'),
      dialogTitle: requiredElement('dialog-title'),
      dialogDescription: requiredElement('dialog-description'),
      dialogSizesSection: requiredElement('dialog-sizes-section'),
      dialogPrices: requiredElement('dialog-prices'),
      dialogFlavorsSection: requiredElement('dialog-flavors-section'),
      dialogFlavorsLimit: requiredElement('dialog-flavors-limit'),
      dialogFlavors: requiredElement('dialog-flavors'),
      dialogToppingsSection: requiredElement('dialog-toppings-section'),
      dialogToppings: requiredElement('dialog-toppings'),
      dialogAvailability: requiredElement('dialog-availability'),
    };

    this.imageObserver = typeof globalThis.IntersectionObserver === 'function'
      ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            this.imageObserver.unobserve(entry.target);
            void this.#loadCardImage(entry.target);
          }
        },
        { rootMargin: '320px 0px' },
      )
      : null;

    this.#bindEvents();
  }

  #bindEvents() {
    this.elements.retry.addEventListener('click', () => this.onRetry?.());
    this.elements.dialogClose.addEventListener('click', () => this.closeDialog());
    this.elements.dialogBackdrop.addEventListener('click', () => this.closeDialog());

    document.addEventListener('keydown', (event) => {
      if (this.elements.dialogLayer.classList.contains('hidden')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeDialog();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        this.elements.dialogClose.focus();
      }
    });
  }

  setLoading(isLoading) {
    this.elements.loading.classList.toggle('hidden', !isLoading);
    if (isLoading) {
      this.elements.grid.classList.add('hidden');
      this.elements.empty.classList.add('hidden');
      this.elements.error.classList.add('hidden');
    }
  }

  setLocations(locations, selectedLocationId) {
    this.locations = locations;
    this.selectedLocationId = selectedLocationId;
  }

  selectLocation(locationId) {
    this.selectedLocationId = locationId;
  }

  setBrand(location = {}) {
    setText(this.elements.title, location.titulo || 'Raffaelito');
    document.title = `${location.titulo || 'Raffaelito'} · Catálogo`;

    const token = ++this.brandImageToken;
    this.elements.brandLogo.src = '/assets/img/logo.png';
    if (!location.logoImagenId) return;
    void this.imageRepository
      .load(location.logoImagenId, location.logoImagenVersion)
      .then(({ url }) => {
        if (token !== this.brandImageToken) return;
        this.elements.brandLogo.src = url;
      })
      .catch(() => {
        if (token === this.brandImageToken) {
          this.elements.brandLogo.src = '/assets/img/logo.png';
        }
      });
  }

  setProducts(products) {
    this.products = Array.isArray(products) ? products : [];
    this.productsById = new Map(
      this.products.map((product) => [product.id, product]),
    );
    this.elements.loading.classList.add('hidden');
    this.elements.error.classList.add('hidden');
    this.elements.grid.classList.remove('hidden');
    this.#renderProducts();

    if (!this.elements.dialogLayer.classList.contains('hidden')) {
      const openProduct = this.productsById.get(this.dialogProductId);
      if (openProduct) this.#updateDialogProduct(openProduct);
      else this.closeDialog();
    }
  }

  showError(message, { preserveProducts = false } = {}) {
    this.elements.loading.classList.add('hidden');
    if (preserveProducts && this.products.length > 0) {
      this.showBanner(
        message || 'No se pudo actualizar la carta. Conservamos la última versión.',
      );
      return;
    }

    this.elements.grid.classList.add('hidden');
    this.elements.empty.classList.add('hidden');
    this.elements.error.classList.remove('hidden');
    setText(
      this.elements.errorMessage,
      message || 'Revisa tu conexión e inténtalo nuevamente.',
    );
  }

  showBanner(message, tone = 'warning') {
    if (!message) {
      this.elements.statusBanner.classList.add('hidden');
      setText(this.elements.statusBanner, '');
      return;
    }
    setText(this.elements.statusBanner, message);
    this.elements.statusBanner.classList.toggle('is-info', tone === 'info');
    this.elements.statusBanner.classList.remove('hidden');
  }

  retryImages() {
    for (const card of this.cards.values()) {
      const image = card.querySelector('.product-image');
      if (!image || image.classList.contains('is-loaded')) continue;
      this.#clearImageRetry(image);
      delete image.dataset.failed;
      delete image.dataset.retryAfter;
      delete image.dataset.retryAttempts;
      if (this.imageObserver) this.imageObserver.observe(image);
      else void this.#loadCardImage(image);
    }

    if (!this.elements.dialogLayer.classList.contains('hidden')) {
      const product = this.productsById.get(this.dialogProductId);
      if (product) {
        this.elements.dialogImage.dataset.imageKey = '';
        this.#updateDialogProduct(product);
      }
    }
  }

  #renderProducts() {
    const currentIds = new Set(this.products.map((product) => product.id));

    for (const [id, card] of this.cards) {
      if (currentIds.has(id)) continue;
      const image = card.querySelector('.product-image');
      this.imageObserver?.unobserve(image);
      this.#clearImageRetry(image);
      card.remove();
      this.cards.delete(id);
    }

    const fragment = document.createDocumentFragment();
    for (const product of this.products) {
      let card = this.cards.get(product.id);
      if (!card) {
        card = createStaticCard();
        card.dataset.productId = product.id;
        card.addEventListener('click', () => {
          const current = this.productsById.get(card.dataset.productId);
          if (current) this.openDialog(current, card);
        });
        this.cards.set(product.id, card);
      }
      this.#updateCard(card, product);
      fragment.appendChild(card);
    }

    this.elements.grid.replaceChildren(fragment);
    const isEmpty = this.products.length === 0;
    this.elements.grid.classList.toggle('hidden', isEmpty);
    this.elements.empty.classList.toggle('hidden', !isEmpty);
    this.elements.error.classList.add('hidden');

    if (isEmpty) {
      setText(this.elements.emptyTitle, 'Aún no hay productos');
      setText(this.elements.emptyMessage, 'Esta sede todavía no publicó productos.');
    }
  }

  #updateCard(card, product) {
    card.classList.toggle('is-unavailable', !product.disponible);
    card.setAttribute(
      'aria-label',
      `${product.nombre}${product.disponible ? '' : ', agotado'}`,
    );

    setText(card.querySelector('.product-category'), getCategoryLabel(product.categoria));
    setText(card.querySelector('.card-title'), product.nombre);

    const description = card.querySelector('.card-description');
    setText(description, product.descripcion);
    description.classList.toggle('hidden', !product.descripcion);

    const soldOut = card.querySelector('.sold-out-badge');
    soldOut.classList.toggle('hidden', product.disponible);

    const price = card.querySelector('.card-price');
    const priceSummary = getPriceSummary(product);
    setText(price, priceSummary);
    price.classList.toggle('hidden', !priceSummary);

    const image = card.querySelector('.product-image');
    image.alt = product.imagenId ? product.nombre : '';
    const nextImageKey = getImageKey(product);
    if (image.dataset.imageKey !== nextImageKey) {
      this.imageObserver?.unobserve(image);
      this.#clearImageRetry(image);
      image.dataset.imageKey = nextImageKey;
      image.classList.remove('is-loaded');
      image.removeAttribute('src');
      delete image.dataset.failed;
      delete image.dataset.retryAfter;
      delete image.dataset.retryAttempts;
    }

    if (!nextImageKey || image.classList.contains('is-loaded')) return;
    if (this.imageObserver) this.imageObserver.observe(image);
    else void this.#loadCardImage(image);
  }

  async #loadCardImage(image) {
    const key = image.dataset.imageKey || '';
    const retryAfter = Number(image.dataset.retryAfter || 0);
    if (!key || image.dataset.loadingKey === key || retryAfter > Date.now()) {
      return;
    }

    const separatorIndex = key.lastIndexOf('@');
    const imageId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
    const version = separatorIndex >= 0 ? key.slice(separatorIndex + 1) : '1';
    image.dataset.loadingKey = key;

    try {
      const result = await this.imageRepository.load(imageId, version);
      if (!image.isConnected || image.dataset.imageKey !== key) return;
      this.#clearImageRetry(image);
      delete image.dataset.failed;
      delete image.dataset.retryAfter;
      delete image.dataset.retryAttempts;
      image.src = result.url;
      image.onload = () => {
        if (image.dataset.imageKey === key) image.classList.add('is-loaded');
      };
      image.onerror = () => {
        if (image.dataset.imageKey !== key) return;
        image.classList.remove('is-loaded');
        image.dataset.failed = key;
        image.removeAttribute('src');
        this.#scheduleImageRetry(image, key);
      };
      if (image.complete && image.naturalWidth > 0) {
        image.classList.add('is-loaded');
      }
    } catch (_) {
      if (image.dataset.imageKey === key) {
        image.dataset.failed = key;
        this.#scheduleImageRetry(image, key);
      }
    } finally {
      if (image.dataset.loadingKey === key) delete image.dataset.loadingKey;
    }
  }

  #clearImageRetry(image) {
    const timer = this.imageRetryTimers.get(image);
    if (timer) {
      clearTimeout(timer);
      this.retryTimeouts.delete(timer);
      this.imageRetryTimers.delete(image);
    }
  }

  #scheduleImageRetry(image, key) {
    this.#clearImageRetry(image);
    const attempts = Number(image.dataset.retryAttempts || 0) + 1;
    image.dataset.retryAttempts = String(attempts);
    if (attempts > 3) {
      delete image.dataset.retryAfter;
      return;
    }

    const delay = [5000, 15000, 30000][attempts - 1];
    image.dataset.retryAfter = String(Date.now() + delay);
    const timer = setTimeout(() => {
      this.retryTimeouts.delete(timer);
      this.imageRetryTimers.delete(image);
      if (
        !image.isConnected
        || image.dataset.imageKey !== key
        || image.classList.contains('is-loaded')
      ) {
        return;
      }
      delete image.dataset.retryAfter;
      void this.#loadCardImage(image);
    }, delay);
    this.imageRetryTimers.set(image, timer);
    this.retryTimeouts.add(timer);
  }

  openDialog(product, trigger) {
    this.lastFocusedElement = trigger || document.activeElement;
    this.dialogProductId = product.id;
    this.#updateDialogProduct(product);

    this.elements.dialogLayer.classList.remove('hidden');
    this.elements.dialogLayer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('dialog-open');
    requestAnimationFrame(() => this.elements.dialogClose.focus());
  }

  #updateDialogProduct(product) {
    setText(this.elements.dialogCategory, getCategoryLabel(product.categoria));
    setText(this.elements.dialogTitle, product.nombre);
    setText(this.elements.dialogDescription, product.descripcion);
    this.elements.dialogDescription.classList.toggle(
      'hidden',
      !product.descripcion,
    );
    this.elements.dialogSoldOut.classList.toggle('hidden', product.disponible);
    setText(
      this.elements.dialogAvailability,
      product.disponible
        ? 'Disponible en esta sede.'
        : 'Este producto está agotado por el momento.',
    );
    this.elements.dialogAvailability.classList.toggle(
      'is-unavailable',
      !product.disponible,
    );

    const prices = Array.isArray(product.tamanos) && product.tamanos.length > 0
      ? product.tamanos
      : getProductPrices(product);
    const priceFragment = document.createDocumentFragment();
    for (const price of prices) {
      const row = document.createElement('div');
      row.className = 'price-row';
      const label = document.createElement('span');
      setText(label, price.nombre);
      row.append(label);

      if (
        product.mostrarPrecio
        && Number.isFinite(Number(price.precio))
        && Number(price.precio) >= 0
      ) {
        const amount = document.createElement('strong');
        setText(amount, formatPrice(price.precio));
        row.append(amount);
      } else {
        row.classList.add('is-label-only');
      }
      priceFragment.appendChild(row);
    }
    this.elements.dialogPrices.replaceChildren(priceFragment);
    this.elements.dialogSizesSection.classList.toggle(
      'hidden',
      prices.length === 0,
    );

    const flavors = Array.isArray(product.sabores)
      ? product.sabores
      : [];
    const flavorFragment = document.createDocumentFragment();
    for (const flavor of flavors) {
      const item = document.createElement('li');
      item.className = 'option-chip';
      item.classList.toggle('is-unavailable', flavor.disponible === false);
      const name = document.createElement('span');
      setText(name, flavor.nombre);
      item.append(name);
      if (flavor.disponible === false) {
        const status = document.createElement('small');
        setText(status, 'Agotado');
        item.append(status);
      }
      flavorFragment.appendChild(item);
    }
    this.elements.dialogFlavors.replaceChildren(flavorFragment);
    this.elements.dialogFlavorsSection.classList.toggle(
      'hidden',
      flavors.length === 0,
    );
    const flavorLimit = Number(product.limiteSabores || 0);
    setText(
      this.elements.dialogFlavorsLimit,
      flavorLimit > 0
        ? flavorLimit >= 999
          ? 'Sabores ilimitados'
          : `Elige hasta ${flavorLimit} ${flavorLimit === 1 ? 'sabor' : 'sabores'}`
        : '',
    );
    this.elements.dialogFlavorsLimit.classList.toggle(
      'hidden',
      flavorLimit <= 0,
    );

    const toppings = Array.isArray(product.toppings)
      ? product.toppings
      : [];
    const toppingFragment = document.createDocumentFragment();
    for (const topping of toppings) {
      const item = document.createElement('li');
      item.className = 'topping-row';
      item.classList.toggle('is-unavailable', topping.disponible === false);
      const name = document.createElement('span');
      setText(name, topping.nombre);
      item.append(name);

      const meta = document.createElement('span');
      meta.className = 'topping-meta';
      if (
        topping.mostrarPrecio
        && Number.isFinite(Number(topping.precio))
        && Number(topping.precio) >= 0
      ) {
        const amount = document.createElement('strong');
        setText(amount, `+ ${formatPrice(topping.precio)}`);
        meta.append(amount);
      }
      if (topping.disponible === false) {
        const status = document.createElement('small');
        setText(status, 'Agotado');
        meta.append(status);
      }
      if (meta.childElementCount > 0) item.append(meta);
      toppingFragment.appendChild(item);
    }
    this.elements.dialogToppings.replaceChildren(toppingFragment);
    this.elements.dialogToppingsSection.classList.toggle(
      'hidden',
      toppings.length === 0,
    );

    const dialogImage = this.elements.dialogImage;
    const nextImageKey = getImageKey(product);
    if (dialogImage.dataset.imageKey === nextImageKey) return;

    const token = ++this.dialogToken;
    dialogImage.dataset.imageKey = nextImageKey;
    dialogImage.classList.remove('is-loaded');
    dialogImage.removeAttribute('src');
    dialogImage.alt = product.imagenId ? product.nombre : '';

    if (product.imagenId) {
      void this.imageRepository
        .load(product.imagenId, product.imagenVersion)
        .then(({ url }) => {
          if (token !== this.dialogToken) return;
          dialogImage.src = url;
          dialogImage.onload = () => {
            if (token === this.dialogToken) dialogImage.classList.add('is-loaded');
          };
          if (dialogImage.complete && dialogImage.naturalWidth > 0) {
            dialogImage.classList.add('is-loaded');
          }
        })
        .catch(() => {
          if (token === this.dialogToken) dialogImage.removeAttribute('src');
        });
    }
  }

  closeDialog() {
    if (this.elements.dialogLayer.classList.contains('hidden')) return;
    this.dialogToken += 1;
    this.elements.dialogLayer.classList.add('hidden');
    this.elements.dialogLayer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('dialog-open');
    this.dialogProductId = '';
    if (this.lastFocusedElement?.isConnected) this.lastFocusedElement.focus();
    this.lastFocusedElement = null;
  }

  dispose() {
    this.closeDialog();
    this.imageObserver?.disconnect();
    for (const timer of this.retryTimeouts) clearTimeout(timer);
    this.retryTimeouts.clear();
    this.cards.clear();
  }
}
