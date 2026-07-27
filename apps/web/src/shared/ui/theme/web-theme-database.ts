export const WEB_THEME_DATABASE_NAME = "ling-stack-ui2";
export const WEB_THEME_DATABASE_VERSION = 3;
export const WEB_THEME_MANIFEST_STORE = "themes";
export const WEB_THEME_PACKAGE_STORE = "theme-packages";
export const WEB_THEME_ASSET_STORE = "theme-assets";
export const WEB_THEME_ASSET_THEME_INDEX = "themeId";
export const WEB_THEME_DRAFT_STORE = "theme-drafts";
export const WEB_THEME_DRAFT_ASSET_STORE = "theme-draft-assets";
export const WEB_THEME_DRAFT_ASSET_DRAFT_INDEX = "draftId";

export async function openWebThemeDatabase(): Promise<IDBDatabase | undefined> {
  if (!globalThis.indexedDB) return undefined;
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(WEB_THEME_DATABASE_NAME, WEB_THEME_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WEB_THEME_MANIFEST_STORE)) {
        database.createObjectStore(WEB_THEME_MANIFEST_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(WEB_THEME_PACKAGE_STORE)) {
        database.createObjectStore(WEB_THEME_PACKAGE_STORE, { keyPath: "themeId" });
      }
      const assetStore = database.objectStoreNames.contains(WEB_THEME_ASSET_STORE)
        ? request.transaction!.objectStore(WEB_THEME_ASSET_STORE)
        : database.createObjectStore(WEB_THEME_ASSET_STORE, { keyPath: "key" });
      if (!assetStore.indexNames.contains(WEB_THEME_ASSET_THEME_INDEX)) {
        assetStore.createIndex(WEB_THEME_ASSET_THEME_INDEX, "themeId", { unique: false });
      }
      if (!database.objectStoreNames.contains(WEB_THEME_DRAFT_STORE)) {
        database.createObjectStore(WEB_THEME_DRAFT_STORE, { keyPath: "id" });
      }
      const draftAssetStore = database.objectStoreNames.contains(WEB_THEME_DRAFT_ASSET_STORE)
        ? request.transaction!.objectStore(WEB_THEME_DRAFT_ASSET_STORE)
        : database.createObjectStore(WEB_THEME_DRAFT_ASSET_STORE, { keyPath: "key" });
      if (!draftAssetStore.indexNames.contains(WEB_THEME_DRAFT_ASSET_DRAFT_INDEX)) {
        draftAssetStore.createIndex(WEB_THEME_DRAFT_ASSET_DRAFT_INDEX, "draftId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Theme registry database could not be opened."));
    request.onblocked = () => reject(new Error("Theme registry database upgrade is blocked."));
  });
}

export function waitForThemeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Theme storage transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Theme storage transaction was aborted."));
  });
}
