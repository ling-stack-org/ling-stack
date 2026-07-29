import type { LingThemePackManifest } from "@ling-stack/ui-react/theme";
import {
  WEB_THEME_ASSET_STORE,
  WEB_THEME_ASSET_THEME_INDEX,
  WEB_THEME_MANIFEST_STORE,
  WEB_THEME_PACKAGE_STORE,
  openWebThemeDatabase,
  waitForThemeTransaction,
} from "../web-theme-database.js";
import type { ParsedWebThemePreview, WebThemePreviewMimeType } from "./web-theme-package-types.js";

export interface WebThemePackagePublication {
  readonly licenseText?: string;
  readonly manifest: LingThemePackManifest;
  readonly packageChecksumSha256: string;
  readonly preview?: ParsedWebThemePreview;
}

export interface StoredWebThemePackage {
  readonly installedAt: string;
  readonly licenseText?: string;
  readonly manifest: LingThemePackManifest;
  readonly packageChecksumSha256?: string;
  readonly preview?: StoredWebThemePreview;
  readonly updatedAt: string;
}

export interface StoredWebThemePreview {
  readonly blob: Blob;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly height: number;
  readonly mimeType: WebThemePreviewMimeType;
  readonly path: string;
  readonly width: number;
}

interface StoredPackageRecord {
  readonly installedAt: string;
  readonly licenseText?: string;
  readonly packageChecksumSha256: string;
  readonly previewPath?: string;
  readonly themeId: string;
  readonly updatedAt: string;
}

interface StoredAssetRecord extends StoredWebThemePreview {
  readonly key: string;
  readonly themeId: string;
}

export async function readStoredWebThemePackage(themeId: string): Promise<StoredWebThemePackage | undefined> {
  const database = await openWebThemeDatabase();
  if (!database) return undefined;
  try {
    const transaction = database.transaction(
      [WEB_THEME_MANIFEST_STORE, WEB_THEME_PACKAGE_STORE, WEB_THEME_ASSET_STORE],
      "readonly",
    );
    const completion = waitForThemeTransaction(transaction);
    const manifestRequest = transaction.objectStore(WEB_THEME_MANIFEST_STORE).get(themeId);
    const packageRequest = transaction.objectStore(WEB_THEME_PACKAGE_STORE).get(themeId);
    const manifest = await requestValue<LingThemePackManifest | undefined>(manifestRequest);
    const metadata = await requestValue<StoredPackageRecord | undefined>(packageRequest);
    if (!manifest) {
      await completion;
      return undefined;
    }
    const preview = metadata?.previewPath
      ? await requestValue<StoredAssetRecord | undefined>(
        transaction.objectStore(WEB_THEME_ASSET_STORE).get(assetKey(themeId, metadata.previewPath)),
      )
      : undefined;
    await completion;
    return Object.freeze({
      manifest,
      installedAt: metadata?.installedAt ?? new Date(0).toISOString(),
      updatedAt: metadata?.updatedAt ?? new Date(0).toISOString(),
      ...(metadata?.licenseText !== undefined ? { licenseText: metadata.licenseText } : {}),
      ...(metadata?.packageChecksumSha256 ? { packageChecksumSha256: metadata.packageChecksumSha256 } : {}),
      ...(preview ? { preview: storedPreview(preview) } : {}),
    });
  } finally {
    database.close();
  }
}

export async function putStoredWebThemePackage(
  publication: WebThemePackagePublication,
  installedAt?: string,
): Promise<StoredWebThemePackage> {
  const previous = await readStoredWebThemePackage(publication.manifest.id);
  const database = await openWebThemeDatabase();
  if (!database) throw new Error("Theme package storage is unavailable.");
  const now = new Date().toISOString();
  const record: StoredPackageRecord = Object.freeze({
    themeId: publication.manifest.id,
    packageChecksumSha256: publication.packageChecksumSha256,
    installedAt: installedAt ?? previous?.installedAt ?? now,
    updatedAt: now,
    ...(publication.licenseText !== undefined ? { licenseText: publication.licenseText } : {}),
    ...(publication.preview ? { previewPath: publication.preview.path } : {}),
  });
  try {
    const transaction = database.transaction(
      [WEB_THEME_MANIFEST_STORE, WEB_THEME_PACKAGE_STORE, WEB_THEME_ASSET_STORE],
      "readwrite",
    );
    try {
      transaction.objectStore(WEB_THEME_MANIFEST_STORE).put(publication.manifest);
      transaction.objectStore(WEB_THEME_PACKAGE_STORE).put(record);
      replaceThemeAssets(transaction.objectStore(WEB_THEME_ASSET_STORE), publication.manifest.id, publication.preview);
    } catch (error) {
      transaction.abort();
      throw error;
    }
    await waitForThemeTransaction(transaction);
    return Object.freeze({
      manifest: publication.manifest,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      packageChecksumSha256: publication.packageChecksumSha256,
      ...(publication.licenseText !== undefined ? { licenseText: publication.licenseText } : {}),
      ...(publication.preview ? { preview: publication.preview } : {}),
    });
  } finally {
    database.close();
  }
}

export async function deleteStoredWebThemePackage(themeId: string): Promise<void> {
  const database = await openWebThemeDatabase();
  if (!database) throw new Error("Theme package storage is unavailable.");
  try {
    const transaction = database.transaction(
      [WEB_THEME_MANIFEST_STORE, WEB_THEME_PACKAGE_STORE, WEB_THEME_ASSET_STORE],
      "readwrite",
    );
    try {
      transaction.objectStore(WEB_THEME_MANIFEST_STORE).delete(themeId);
      transaction.objectStore(WEB_THEME_PACKAGE_STORE).delete(themeId);
      replaceThemeAssets(transaction.objectStore(WEB_THEME_ASSET_STORE), themeId);
    } catch (error) {
      transaction.abort();
      throw error;
    }
    await waitForThemeTransaction(transaction);
  } finally {
    database.close();
  }
}

function replaceThemeAssets(
  store: IDBObjectStore,
  themeId: string,
  preview?: ParsedWebThemePreview,
): void {
  const cursorRequest = store.index(WEB_THEME_ASSET_THEME_INDEX).openCursor(IDBKeyRange.only(themeId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
      return;
    }
    if (preview) {
      const record: StoredAssetRecord = Object.freeze({
        key: assetKey(themeId, preview.path),
        themeId,
        path: preview.path,
        blob: preview.blob,
        byteLength: preview.byteLength,
        checksumSha256: preview.checksumSha256,
        height: preview.height,
        mimeType: preview.mimeType,
        width: preview.width,
      });
      store.put(record);
    }
  };
}

function storedPreview(record: StoredAssetRecord): StoredWebThemePreview {
  return Object.freeze({
    blob: record.blob,
    byteLength: record.byteLength,
    checksumSha256: record.checksumSha256,
    height: record.height,
    mimeType: record.mimeType,
    path: record.path,
    width: record.width,
  });
}

function assetKey(themeId: string, path: string): string {
  return `${themeId}\u0000${path}`;
}

function requestValue<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("Theme storage request failed."));
  });
}
