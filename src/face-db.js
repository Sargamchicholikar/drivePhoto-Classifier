/**
 * face-db.js — IndexedDB wrapper for face recognition and smart albums.
 *
 * DB: SmartAlbumDB v1
 * Stores:
 *   persons        { id, name, centroid: number[], photoCount, thumbnailDataUrl, createdAt,
 *                    starred: boolean  ← user marked this person as important }
 *   faceEmbeddings { id, photoId, photoName, photoDate,
 *                    sourceFolderId: string,   ← Drive folder ID where photo was found (Human/ or Group/)
 *                    sourceFolderName: string, ← "Human" or "Group"
 *                    embedding: number[], box, score, personId, thumbnailDataUrl }
 *   photoFaces     { photoId, faceIds: string[], processedAt, error? }
 */

const DB_NAME    = "SmartAlbumDB";
const DB_VERSION = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("persons")) {
        db.createObjectStore("persons", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("faceEmbeddings")) {
        const store = db.createObjectStore("faceEmbeddings", { keyPath: "id" });
        store.createIndex("byPersonId", "personId", { unique: false });
        store.createIndex("byPhotoId",  "photoId",  { unique: false });
      }
      if (!db.objectStoreNames.contains("photoFaces")) {
        db.createObjectStore("photoFaces", { keyPath: "photoId" });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = ()  => reject(req.error);
  });
}

function dbRun(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, mode);
    const obj = tx.objectStore(store);
    const req = fn(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

function dbIndexRun(store, index, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, "readonly");
    const idx = tx.objectStore(store).index(index);
    const req = fn(idx);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

export const faceDB = {
  getAllPersons: () =>
    dbRun("persons", "readonly", s => s.getAll()),

  getPerson: (id) =>
    dbRun("persons", "readonly", s => s.get(id)).then(r => r ?? null),

  savePerson: (p) =>
    dbRun("persons", "readwrite", s => s.put(p)),

  deletePerson: (id) =>
    dbRun("persons", "readwrite", s => s.delete(id)),

  // Toggle starred (important) flag on a person
  starPerson: async (id, starred) => {
    const p = await faceDB.getPerson(id);
    if (!p) return;
    p.starred = starred;
    return dbRun("persons", "readwrite", s => s.put(p));
  },

  // Get only starred persons
  getStarredPersons: async () => {
    const all = await faceDB.getAllPersons();
    return all.filter(p => p.starred === true);
  },

  getAllEmbeddings: () =>
    dbRun("faceEmbeddings", "readonly", s => s.getAll()),

  getEmbeddingsByPerson: (personId) =>
    dbIndexRun("faceEmbeddings", "byPersonId", i => i.getAll(personId)),

  getEmbeddingsByPhoto: (photoId) =>
    dbIndexRun("faceEmbeddings", "byPhotoId", i => i.getAll(photoId)),

  saveEmbedding: (e) =>
    dbRun("faceEmbeddings", "readwrite", s => s.put(e)),

  getPhotoFaces: (photoId) =>
    dbRun("photoFaces", "readonly", s => s.get(photoId)).then(r => r ?? null),

  savePhotoFaces: (record) =>
    dbRun("photoFaces", "readwrite", s => s.put(record)),

  clearAll: async () => {
    const db = await openDB();
    await Promise.all(["persons", "faceEmbeddings", "photoFaces"].map(
      store => new Promise((resolve, reject) => {
        const req = db.transaction(store, "readwrite").objectStore(store).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      })
    ));
    _db = null; // reset connection so next open triggers fresh upgrade check
  },
};
