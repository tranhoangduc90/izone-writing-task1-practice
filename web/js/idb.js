const DB_NAME = "izone-task1-practice";
const STORE = "drafts";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(mode, action) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const request = action(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

export const getDraft = (key) => transaction("readonly", (store) => store.get(key));
export async function getLatestDraft(prefix) {
  const values = await transaction("readonly", (store) => store.getAll());
  return values.filter(item => String(item.key || "").startsWith(prefix) && item.sessionRef && item.identity)
    .sort((left, right) => Number(right.savedAt || 0) - Number(left.savedAt || 0))[0] || null;
}
export const putDraft = (value) => transaction("readwrite", (store) => store.put(value));
export const deleteDraft = (key) => transaction("readwrite", (store) => store.delete(key));
