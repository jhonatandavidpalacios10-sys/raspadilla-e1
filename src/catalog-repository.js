import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { db as defaultDb } from './firebase.js';
import {
  buildVesselCatalogProducts,
  GENERAL_LOCATION_ID,
} from './catalog-model.js';

function snapshotRows(snapshot) {
  return snapshot.docs.map((item) => ({
    id: item.id,
    ...item.data(),
  }));
}

export class CatalogRepository {
  constructor({
    db = defaultDb,
    collectionImpl = collection,
    docImpl = doc,
    getDocImpl = getDoc,
    onSnapshotImpl = onSnapshot,
    queryImpl = query,
    whereImpl = where,
  } = {}) {
    this.db = db;
    this.collection = collectionImpl;
    this.doc = docImpl;
    this.getDoc = getDocImpl;
    this.onSnapshot = onSnapshotImpl;
    this.query = queryImpl;
    this.where = whereImpl;
    this.locationsUnsubscribe = null;
    this.productsUnsubscribes = [];
    this.productGeneration = 0;
  }

  watchLocations({ onData, onError } = {}) {
    this.locationsUnsubscribe?.();
    const reference = this.query(
      this.collection(this.db, 'catalogos_publicos'),
      this.where('activo', '==', true),
    );

    this.locationsUnsubscribe = this.onSnapshot(
      reference,
      { includeMetadataChanges: true },
      (snapshot) => {
        onData?.(snapshotRows(snapshot), {
          fromCache: snapshot.metadata?.fromCache === true,
        });
      },
      (error) => onError?.(error),
    );

    return () => {
      this.locationsUnsubscribe?.();
      this.locationsUnsubscribe = null;
    };
  }

  watchProducts(locationId, { onData, onError } = {}) {
    this.stopProducts();
    const generation = ++this.productGeneration;
    const selectedId = String(locationId || GENERAL_LOCATION_ID);
    const reference = this.collection(
      this.db,
      'catalogos_publicos',
      selectedId,
      'productos',
    );

    const unsubscribe = this.onSnapshot(
      reference,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (generation !== this.productGeneration) return;
        onData?.(buildVesselCatalogProducts(snapshotRows(snapshot)), {
          fromCache: snapshot.metadata?.fromCache === true,
          locationId: selectedId,
        });
      },
      (error) => {
        if (generation !== this.productGeneration) return;
        onError?.(error);
      },
    );
    this.productsUnsubscribes.push(unsubscribe);

    return () => {
      if (generation === this.productGeneration) this.stopProducts();
    };
  }

  async getImageDocument(imageId) {
    const reference = this.doc(this.db, 'catalogo_imagenes', imageId);
    return this.getDoc(reference);
  }

  stopProducts() {
    this.productGeneration += 1;
    this.productsUnsubscribes.splice(0).forEach((unsubscribe) => {
      try {
        unsubscribe?.();
      } catch (_) {
        // Unsubscribe is best-effort.
      }
    });
  }

  dispose() {
    this.locationsUnsubscribe?.();
    this.locationsUnsubscribe = null;
    this.stopProducts();
  }
}
