import type { LingThemePackManifest } from "@ling-stack/ui-react/theme";
import {
  WEB_THEME_ASSET_STORE,
  WEB_THEME_ASSET_THEME_INDEX,
  WEB_THEME_MANIFEST_STORE,
  WEB_THEME_PACKAGE_STORE,
  openWebThemeDatabase,
  waitForThemeTransaction,
} from "../web-theme-database.js";
import type {
  ParsedWebThemeLaunchAnimation,
  ParsedWebThemePreview,
  WebThemePreviewMimeType,
} from "./web-theme-package-types.js";

export interface WebThemePackagePublication {
  readonly licenseText?: string;
  readonly manifest: LingThemePackManifest;
  readonly packageChecksumSha256: string;
  readonly launchAnimation?: ParsedWebThemeLaunchAnimation;
  readonly preview?: ParsedWebThemePreview;
}

export interface StoredWebThemePackage {
  readonly installedAt: string;
  readonly licenseText?: string;
  readonly manifest: LingThemePackManifest;
  readonly packageChecksumSha256?: string;
  readonly launchAnimation?: StoredWebThemePreview;
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
  readonly launchAnimationPath?: string;
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
    const launchAnimation = metadata?.launchAnimationPath
      ? await requestValue<StoredAssetRecord | undefined>(
        transaction.objectStore(WEB_THEME_ASSET_STORE).get(assetKey(themeId, metadata.launchAnimationPath)),
      )
      : undefined;
    await completion;
    return Object.freeze({
      manifest,
      installedAt: metadata?.installedAt ?? new Date(0).toISOString(),
      updatedAt: metadata?.updatedAt ?? new Date(0).toISOString(),
      ...(metadata?.licenseText !== undefined ? { licenseText: metadata.licenseText } : {}),
      ...(metadata?.packageChecksumSha256 ? { packageChecksumSha256: metadata.packageChecksumSha256 } : {}),
      ...(launchAnimation ? { launchAnimation: storedAsset(launchAnimation) } : {}),
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
    ...(publication.launchAnimation ? { launchAnimationPath: publication.launchAnimation.path } : {}),
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
      replaceThemeAssets(
        transaction.objectStore(WEB_THEME_ASSET_STORE),
        publication.manifest.id,
        publication.preview,
        publication.launchAnimation,
      );
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
      ...(publication.launchAnimation ? { launchAnimation: publication.launchAnimation } : {}),
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
  launchAnimation?: ParsedWebThemeLaunchAnimation,
): void {
  const cursorRequest = store.index(WEB_THEME_ASSET_THEME_INDEX).openCursor(IDBKeyRange.only(themeId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
      return;
    }
    for (const asset of [preview, launchAnimation]) {
      if (!asset) continue;
      const record: StoredAssetRecord = Object.freeze({
        key: assetKey(themeId, asset.path),
        themeId,
        path: asset.path,
        blob: asset.blob,
        byteLength: asset.byteLength,
        checksumSha256: asset.checksumSha256,
        height: asset.height,
        mimeType: asset.mimeType,
        width: asset.width,
      });
      store.put(record);
    }
  };
}

function storedAsset(record: StoredAssetRecord): StoredWebThemePreview {
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

function storedPreview(record: StoredAssetRecord): StoredWebThemePreview {
  return storedAsset(record);
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
