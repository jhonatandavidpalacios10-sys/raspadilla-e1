export const GENERAL_LOCATION_ID = 'general';

const CATEGORY_ORDER = new Map([
  ['vaso', 10],
  ['producto', 20],
  ['sabor', 30],
  ['topping', 40],
  ['otro', 90],
]);

const CATEGORY_LABELS = {
  all: 'Todos',
  vaso: 'Raspadillas',
  producto: 'Productos',
  sabor: 'Sabores',
  topping: 'Toppings',
  otro: 'Otros',
};

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function asString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function asFiniteNumber(value, fallback = null) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function timestampVersion(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value?.toMillis === 'function') return String(value.toMillis());
  if (Number.isFinite(Number(value?.seconds))) {
    return `${Number(value.seconds)}-${Number(value.nanoseconds || 0)}`;
  }
  return '';
}

export function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCategory(value) {
  const normalized = normalizeSearchText(value);
  if (['vaso', 'vasos', 'raspadilla', 'raspadillas'].includes(normalized)) return 'vaso';
  if (['sabor', 'sabores'].includes(normalized)) return 'sabor';
  if (['topping', 'toppings'].includes(normalized)) return 'topping';
  if (['producto', 'productos'].includes(normalized)) return 'producto';
  return normalized || 'otro';
}

export function getCategoryLabel(category) {
  const normalized = category === 'all' ? 'all' : normalizeCategory(category);
  if (CATEGORY_LABELS[normalized]) return CATEGORY_LABELS[normalized];
  return normalized.charAt(0).toLocaleUpperCase('es') + normalized.slice(1);
}

function normalizeSizes(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((size, index) => {
      const row = asObject(size);
      const price = asFiniteNumber(row.precio ?? row.price);
      if (price === null || price < 0) return null;
      return {
        nombre: asString(
          row.nombre ?? row.name,
          value.length === 1 ? 'Precio' : `Opción ${index + 1}`,
        ),
        precio: price,
      };
    })
    .filter(Boolean);
}

function normalizeFlavorOptions(value) {
  if (!Array.isArray(value)) return [];

  const uniqueRows = new Map();
  for (const [index, item] of value.entries()) {
    const row = asObject(item);
    const name = asString(
      row.nombre ?? row.nombrePublico ?? row.name,
    );
    if (!name) continue;

    const id = asString(
      row.id ?? row.sourceProductId ?? row.productoId,
      `sabor-${index + 1}`,
    );
    const stock = asFiniteNumber(row.stock);
    const inferredAvailable = stock === null ? true : stock > 0;
    uniqueRows.set(id, {
      id,
      nombre: name,
      disponible: row.agotado === true
        ? false
        : asBoolean(row.disponible ?? row.available, inferredAvailable),
    });
  }

  return [...uniqueRows.values()];
}

function normalizeToppingOptions(value) {
  if (!Array.isArray(value)) return [];

  const uniqueRows = new Map();
  for (const [index, item] of value.entries()) {
    const row = asObject(item);
    const name = asString(
      row.nombre ?? row.nombrePublico ?? row.name,
    );
    if (!name) continue;

    const id = asString(
      row.id ?? row.sourceProductId ?? row.productoId,
      `topping-${index + 1}`,
    );
    const rawPrice = asFiniteNumber(row.precio ?? row.price);
    const price = rawPrice !== null && rawPrice >= 0 ? rawPrice : null;
    const stock = asFiniteNumber(row.stock);
    const inferredAvailable = stock === null ? true : stock > 0;
    uniqueRows.set(id, {
      id,
      nombre: name,
      precio: price,
      mostrarPrecio: asBoolean(
        row.mostrarPrecio ?? row.catalogoMostrarPrecio ?? row.showPrice,
        true,
      ),
      disponible: row.agotado === true
        ? false
        : asBoolean(row.disponible ?? row.available, inferredAvailable),
    });
  }

  return [...uniqueRows.values()];
}

export function normalizeProduct(id, input = {}) {
  const data = asObject(input);
  const productId = asString(id ?? data.id ?? data.sourceProductId);
  const stock = asFiniteNumber(data.stock);
  const explicitAvailable = data.disponible
    ?? data.catalogoDisponible
    ?? data.available;
  const inferredAvailable = stock === null ? true : stock > 0;
  const available = data.agotado === true
    ? false
    : asBoolean(explicitAvailable, inferredAvailable);
  const sizes = normalizeSizes(data.tamanos ?? data.sizes);
  const fallbackPrice = asFiniteNumber(data.precio ?? data.price);
  const imageId = asString(
    data.imagenId
      ?? data.catalogoImagenId
      ?? data.imagenRef
      ?? data.imageId,
  );
  const imageVersion = asString(
    data.imagenVersion
      ?? data.catalogoImagenVersion
      ?? data.imageVersion
      ?? timestampVersion(data.actualizadoEn ?? data.updatedAt),
    '1',
  );
  const category = normalizeCategory(data.categoria ?? data.category);
  const description = asString(
    data.descripcion
      ?? data.catalogoDescripcion
      ?? data.description,
  );

  return {
    id: productId,
    sourceProductId: asString(data.sourceProductId, productId),
    nombre: asString(
      data.catalogoNombre ?? data.nombrePublico ?? data.nombre ?? data.name,
      'Producto',
    ),
    descripcion: description,
    categoria: category,
    imagenId: imageId,
    imagenVersion: imageVersion,
    visible: asBoolean(
      data.visible ?? data.catalogoVisible ?? data.publicado,
      true,
    ),
    disponible: available,
    mostrarPrecio: asBoolean(
      data.mostrarPrecio ?? data.catalogoMostrarPrecio ?? data.showPrice,
      true,
    ),
    precio: fallbackPrice,
    tamanos: sizes,
    limiteSabores: Math.max(
      0,
      Math.trunc(asFiniteNumber(
        data.limiteSabores ?? data.limite_sabores,
        0,
      )),
    ),
    sabores: normalizeFlavorOptions(
      data.sabores ?? data.flavors ?? data.opcionesSabores,
    ),
    toppings: normalizeToppingOptions(
      data.toppings ?? data.opcionesToppings,
    ),
    orden: asFiniteNumber(data.orden ?? data.catalogoOrden, 9999),
    destacado: asBoolean(
      data.destacado ?? data.catalogoDestacado,
      false,
    ),
    _search: normalizeSearchText(
      `${data.catalogoNombre ?? data.nombrePublico ?? data.nombre ?? data.name ?? ''} `
      + `${description} ${category}`,
    ),
  };
}

function rawRowId(row) {
  return asString(row?.id ?? row?.sourceProductId);
}

export function normalizeCatalogProducts(rows = []) {
  const uniqueRows = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = rawRowId(row);
    if (!id) continue;
    uniqueRows.set(id, { ...asObject(row), id });
  }

  return [...uniqueRows.entries()]
    .map(([id, row]) => normalizeProduct(id, row))
    .filter((product) => product.id && product.visible)
    .sort(compareProducts);
}

function flavorFromCatalogProduct(product) {
  return {
    id: product.id,
    nombre: product.nombre,
    disponible: product.disponible,
  };
}

function toppingFromCatalogProduct(product) {
  const firstSizePrice = Array.isArray(product.tamanos)
    ? product.tamanos.find((size) => Number.isFinite(Number(size.precio)))?.precio
    : null;
  const normalizedSizePrice = asFiniteNumber(firstSizePrice);
  const normalizedFallbackPrice = asFiniteNumber(product.precio);
  const price = normalizedSizePrice !== null && normalizedSizePrice >= 0
    ? normalizedSizePrice
    : normalizedFallbackPrice !== null && normalizedFallbackPrice >= 0
      ? normalizedFallbackPrice
      : null;

  return {
    id: product.id,
    nombre: product.nombre,
    precio: price,
    mostrarPrecio: product.mostrarPrecio,
    disponible: product.disponible,
  };
}

export function buildVesselCatalogProducts(rows = []) {
  const products = normalizeCatalogProducts(rows);
  const derivedFlavors = products
    .filter((product) => product.categoria === 'sabor')
    .map(flavorFromCatalogProduct);
  const derivedToppings = products
    .filter((product) => product.categoria === 'topping')
    .map(toppingFromCatalogProduct);

  return products
    .filter((product) => product.categoria === 'vaso')
    .map((product) => {
      const embeddedFlavors = Array.isArray(product.sabores)
        ? product.sabores
        : [];
      const embeddedToppings = Array.isArray(product.toppings)
        ? product.toppings
        : [];

      return {
        ...product,
        sabores: product.limiteSabores > 0
          ? embeddedFlavors.length > 0
            ? embeddedFlavors
            : derivedFlavors
          : [],
        toppings: embeddedToppings.length > 0
          ? embeddedToppings
          : derivedToppings,
      };
    });
}

export function compareProducts(left, right) {
  const featuredDifference = Number(Boolean(right.destacado))
    - Number(Boolean(left.destacado));
  if (featuredDifference !== 0) return featuredDifference;

  const orderDifference = Number(left.orden || 0) - Number(right.orden || 0);
  if (orderDifference !== 0) return orderDifference;

  const leftCategoryOrder = CATEGORY_ORDER.get(left.categoria) ?? 70;
  const rightCategoryOrder = CATEGORY_ORDER.get(right.categoria) ?? 70;
  if (leftCategoryOrder !== rightCategoryOrder) {
    return leftCategoryOrder - rightCategoryOrder;
  }

  return String(left.nombre || '').localeCompare(
    String(right.nombre || ''),
    'es',
    { sensitivity: 'base', numeric: true },
  );
}

export function buildCategories(products = []) {
  const categories = new Set();
  for (const product of products) {
    if (product?.categoria) categories.add(product.categoria);
  }

  return [
    { id: 'all', label: getCategoryLabel('all') },
    ...[...categories]
      .sort((left, right) => {
        const orderDifference = (CATEGORY_ORDER.get(left) ?? 70)
          - (CATEGORY_ORDER.get(right) ?? 70);
        return orderDifference || left.localeCompare(right, 'es');
      })
      .map((id) => ({ id, label: getCategoryLabel(id) })),
  ];
}

export function filterProducts(products = [], {
  query = '',
  category = 'all',
} = {}) {
  const normalizedQuery = normalizeSearchText(query);
  return products.filter((product) => {
    if (category !== 'all' && product.categoria !== category) return false;
    if (!normalizedQuery) return true;
    return product._search.includes(normalizedQuery);
  });
}

export function formatPrice(value) {
  const number = asFiniteNumber(value);
  if (number === null || number < 0) return '';
  return `S/ ${number.toFixed(2)}`;
}

export function getProductPrices(product) {
  if (!product?.mostrarPrecio) return [];
  if (Array.isArray(product.tamanos) && product.tamanos.length > 0) {
    return product.tamanos.filter((size) => Number.isFinite(Number(size.precio)));
  }
  if (Number.isFinite(Number(product?.precio)) && product.precio >= 0) {
    return [{ nombre: 'Precio', precio: Number(product.precio) }];
  }
  return [];
}

export function getPriceSummary(product) {
  const prices = getProductPrices(product);
  if (prices.length === 0) return '';

  const values = prices.map((item) => Number(item.precio));
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (prices.length === 1 || Math.abs(maximum - minimum) < 0.005) {
    return formatPrice(minimum);
  }
  return `Desde ${formatPrice(minimum)}`;
}

export function getImageKey(product) {
  if (!product?.imagenId) return '';
  return `${product.imagenId}@${product.imagenVersion || '1'}`;
}

export function normalizeLocation(id, input = {}) {
  const data = asObject(input);
  const locationId = asString(id ?? data.id, GENERAL_LOCATION_ID);
  return {
    id: locationId,
    slug: asString(data.slug, locationId),
    nombre: asString(
      data.nombre ?? data.nombrePublico,
      locationId === GENERAL_LOCATION_ID ? 'Catálogo general' : 'Sede',
    ),
    activa: asBoolean(
      data.activo ?? data.activa ?? data.visible ?? data.publicado,
      true,
    ),
    orden: asFiniteNumber(data.orden, locationId === GENERAL_LOCATION_ID ? -1 : 9999),
    titulo: asString(data.titulo ?? data.nombreCatalogo ?? data.nombreApp),
    subtitulo: asString(data.subtitulo ?? data.descripcion),
    logoImagenId: asString(data.logoImagenId ?? data.logoId),
    logoImagenVersion: asString(
      data.logoImagenVersion ?? timestampVersion(data.actualizadoEn),
      '1',
    ),
  };
}

export function normalizeLocations(rows = []) {
  const locations = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const location = normalizeLocation(row?.id, row);
    if (location.activa) locations.set(location.id, location);
  }

  if (!locations.has(GENERAL_LOCATION_ID)) {
    locations.set(
      GENERAL_LOCATION_ID,
      normalizeLocation(GENERAL_LOCATION_ID, {
        nombre: 'Catálogo general',
        slug: GENERAL_LOCATION_ID,
        orden: -1,
      }),
    );
  }

  return [...locations.values()].sort((left, right) => (
    Number(left.orden) - Number(right.orden)
    || left.nombre.localeCompare(right.nombre, 'es', { sensitivity: 'base' })
  ));
}

export function resolveLocationId(requestedValue, locations = []) {
  const requested = asString(requestedValue, GENERAL_LOCATION_ID);
  const exact = locations.find((location) => location.id === requested);
  if (exact) return exact.id;
  const bySlug = locations.find((location) => location.slug === requested);
  return bySlug?.id || GENERAL_LOCATION_ID;
}
