import type {
  LingColorScheme,
  LingPresentationProfileId,
  ThemeImageAnalysis,
} from "@ling-stack/ui-react/theme";
import {
  WEB_THEME_DRAFT_ASSET_DRAFT_INDEX,
  WEB_THEME_DRAFT_ASSET_STORE,
  WEB_THEME_DRAFT_STORE,
  openWebThemeDatabase,
  waitForThemeTransaction,
} from "../web-theme-database.js";
import type { QuickThemeImageMimeType } from "./web-quick-theme-image.js";

export interface QuickThemeDraftSourceMetadata {
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly displayName: string;
  readonly height: number;
  readonly mimeType: QuickThemeImageMimeType;
  readonly width: number;
}

export interface WebQuickThemeDraftRecord {
  readonly analysis?: ThemeImageAnalysis;
  readonly artworkIntensity: "balanced" | "strong" | "subtle";
  readonly colorScheme: LingColorScheme;
  readonly createdAt: string;
  readonly id: string;
  readonly name: string;
  readonly presentationProfileId: LingPresentationProfileId;
  readonly revision: number;
  readonly source?: QuickThemeDraftSourceMetadata;
  readonly themeId: string;
  readonly updatedAt: string;
}

export interface WebQuickThemeDraftPublication {
  readonly draft: WebQuickThemeDraftRecord;
  readonly sourceBlob?: Blob;
}

export interface StoredWebQuickThemeDraft extends WebQuickThemeDraftRecord {
  readonly sourceBlob?: Blob;
}

interface StoredDraftAssetRecord {
  readonly blob: Blob;
  readonly draftId: string;
  readonly key: string;
  readonly kind: "source";
}

export async function readWebQuickThemeDraft(draftId: string): Promise<StoredWebQuickThemeDraft | undefined> {
  const database = await openWebThemeDatabase();
  if (!database) return undefined;
  try {
    const transaction = database.transaction([WEB_THEME_DRAFT_STORE, WEB_THEME_DRAFT_ASSET_STORE], "readonly");
    const completion = waitForThemeTransaction(transaction);
    const draft = await requestValue<WebQuickThemeDraftRecord | undefined>(
      transaction.objectStore(WEB_THEME_DRAFT_STORE).get(draftId),
    );
    const source = draft?.source
      ? await requestValue<StoredDraftAssetRecord | undefined>(
        transaction.objectStore(WEB_THEME_DRAFT_ASSET_STORE).get(draftAssetKey(draftId, "source")),
      )
      : undefined;
    await completion;
    return draft ? Object.freeze({ ...draft, ...(source ? { sourceBlob: source.blob } : {}) }) : undefined;
  } finally {
    database.close();
  }
}

export async function putWebQuickThemeDraft(
  publication: WebQuickThemeDraftPublication,
): Promise<StoredWebQuickThemeDraft> {
  assertDraftPublication(publication);
  const database = await openWebThemeDatabase();
  if (!database) throw new Error("Theme draft storage is unavailable.");
  try {
    const transaction = database.transaction([WEB_THEME_DRAFT_STORE, WEB_THEME_DRAFT_ASSET_STORE], "readwrite");
    const completion = waitForThemeTransaction(transaction);
    try {
      transaction.objectStore(WEB_THEME_DRAFT_STORE).put(publication.draft);
      replaceDraftAssets(
        transaction.objectStore(WEB_THEME_DRAFT_ASSET_STORE),
        publication.draft.id,
        publication.sourceBlob,
      );
    } catch (error) {
      transaction.abort();
      throw error;
    }
    await completion;
    return Object.freeze({
      ...publication.draft,
      ...(publication.sourceBlob ? { sourceBlob: publication.sourceBlob } : {}),
    });
  } finally {
    database.close();
  }
}

export async function deleteWebQuickThemeDraft(draftId: string): Promise<void> {
  const database = await openWebThemeDatabase();
  if (!database) throw new Error("Theme draft storage is unavailable.");
  try {
    const transaction = database.transaction([WEB_THEME_DRAFT_STORE, WEB_THEME_DRAFT_ASSET_STORE], "readwrite");
    const completion = waitForThemeTransaction(transaction);
    try {
      transaction.objectStore(WEB_THEME_DRAFT_STORE).delete(draftId);
      replaceDraftAssets(transaction.objectStore(WEB_THEME_DRAFT_ASSET_STORE), draftId);
    } catch (error) {
      transaction.abort();
      throw error;
    }
    await completion;
  } finally {
    database.close();
  }
}

function replaceDraftAssets(store: IDBObjectStore, draftId: string, sourceBlob?: Blob): void {
  const cursorRequest = store.index(WEB_THEME_DRAFT_ASSET_DRAFT_INDEX).openCursor(IDBKeyRange.only(draftId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
      return;
    }
    if (sourceBlob) {
      const record: StoredDraftAssetRecord = Object.freeze({
        blob: sourceBlob,
        draftId,
        key: draftAssetKey(draftId, "source"),
        kind: "source",
      });
      store.put(record);
    }
  };
}

function assertDraftPublication(publication: WebQuickThemeDraftPublication): void {
  if (!publication.draft.id || !publication.draft.themeId) throw new Error("Theme draft identity is required.");
  if (publication.draft.source && !publication.sourceBlob) {
    throw new Error("Theme draft source metadata requires a source Blob.");
  }
  if (!publication.draft.source && publication.sourceBlob) {
    throw new Error("Theme draft source Blob requires source metadata.");
  }
  if (publication.sourceBlob && publication.draft.source?.byteLength !== publication.sourceBlob.size) {
    throw new Error("Theme draft source Blob size does not match its metadata.");
  }
}

function draftAssetKey(draftId: string, kind: StoredDraftAssetRecord["kind"]): string {
  return `${draftId}\u0000${kind}`;
}

function requestValue<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("Theme draft storage request failed."));
  });
}
