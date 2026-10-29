import { BackgroundError, INITIAL_BACKGROUND, parseBackgroundPreference, parsePrepareBackgroundRequest,
  verifyBackgroundCommit, commitBackgroundPreference, type BackgroundImage, type BackgroundPreference, type BackgroundRepository,
  type BackgroundSnapshot, type CommitBackgroundRequest, type PrepareBackgroundRequest } from "@ling-stack/ui-react/theme";
import { openWebThemeDatabase, WEB_BACKGROUND_ASSETS_STORE as ASSETS, WEB_BACKGROUND_SETTINGS_STORE as SETTINGS,
  waitForThemeTransaction } from "../theme/web-theme-database.js";
import { prepareWebBackground, verifyBackgroundImage } from "./prepare-background-image.js";

interface RecordValue { preference: BackgroundPreference; receipt?: { requestId: string; payloadDigest: string } }
export class WebBackgroundRepository implements BackgroundRepository {
  private candidate?: { requestId: string; image: BackgroundImage };
  private preparing?: { requestId: string; abort: AbortController };
  constructor(private readonly prepareImage = prepareWebBackground) {}
  async read(): Promise<BackgroundSnapshot> {
    const database = await this.open();
    try {
      const tx = database.transaction([SETTINGS, ASSETS], "readonly");
      const done = waitForThemeTransaction(tx);
      const record = await readRequest<RecordValue | undefined>(tx.objectStore(SETTINGS).get("current"));
      const preference = record ? parseBackgroundPreference(record.preference) : INITIAL_BACKGROUND;
      const image = preference.selection.kind !== "none"
        ? await readRequest<BackgroundImage | undefined>(tx.objectStore(ASSETS).get(preference.selection.assetId)) : undefined;
      await done;
      if (preference.selection.kind === "none") return { preference };
      try {
        if (!image || image.asset.assetId !== preference.selection.assetId) throw new BackgroundError("corrupt");
        return { preference, image: await verifyBackgroundImage(image) };
      } catch { return { preference, resourceError: "corrupt" }; }
    } finally { database.close(); }
  }
  async prepare(input: PrepareBackgroundRequest): Promise<BackgroundImage> {
    const request = parsePrepareBackgroundRequest(input);
    if (this.preparing) throw new BackgroundError("unavailable");
    this.candidate = undefined;
    const abort = new AbortController();
    this.preparing = { requestId: request.requestId, abort };
    try {
      const image = await this.prepareImage(request, abort.signal);
      if (abort.signal.aborted) throw new BackgroundError("aborted");
      this.candidate = { requestId: request.requestId, image };
      return image;
    } finally { this.preparing = undefined; }
  }
  async release(requestId: string): Promise<void> {
    if (this.preparing?.requestId === requestId) this.preparing.abort.abort();
    if (this.candidate?.requestId === requestId) this.candidate = undefined;
  }
  async commit(input: CommitBackgroundRequest): Promise<BackgroundPreference> {
    const request = await verifyBackgroundCommit(input);
    const candidate = this.candidate?.image;
    if (candidate && request.selection.kind !== "none" && candidate.asset.assetId === request.selection.assetId) await verifyBackgroundImage(candidate);
    const database = await this.open();
    try {
      return await new Promise<BackgroundPreference>((resolve, reject) => {
        const tx = database.transaction([SETTINGS, ASSETS], "readwrite");
        const settings = tx.objectStore(SETTINGS), assets = tx.objectStore(ASSETS);
        let result: BackgroundPreference, failure: unknown;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(failure ?? new BackgroundError("unavailable"));
        const currentRequest = settings.get("current");
        currentRequest.onsuccess = () => {
          try {
            const record = currentRequest.result as RecordValue | undefined;
            const current = record ? parseBackgroundPreference(record.preference) : INITIAL_BACKGROUND;
            if (record?.receipt?.requestId === request.requestId) {
              if (record.receipt.payloadDigest !== request.payloadDigest) throw new BackgroundError("invalid-request");
              result = current; return;
            }
            if (current.revision !== request.expectedRevision) throw new BackgroundError("conflict");
            result = commitBackgroundPreference(current, request);
            const publish = () => {
              // Only this feature's store is collected, in the same transaction as the reference.
              const keep = request.selection.kind !== "none" ? request.selection.assetId : undefined;
              const keys = assets.openKeyCursor();
              keys.onsuccess = () => { const cursor = keys.result; if (cursor) { if (cursor.key !== keep) assets.delete(cursor.key); cursor.continue(); } };
              settings.put({ preference: result, receipt: { requestId: request.requestId, payloadDigest: request.payloadDigest } }, "current");
            };
            if (request.selection.kind === "none") { publish(); return; }
            if (candidate?.asset.assetId === request.selection.assetId) { assets.put(candidate, candidate.asset.assetId); publish(); return; }
            if (current.selection.kind === "none" || current.selection.assetId !== request.selection.assetId) throw new BackgroundError("invalid-request");
            const existing = assets.get(request.selection.assetId);
            existing.onsuccess = () => { if (existing.result) publish(); else { failure = new BackgroundError("corrupt"); tx.abort(); } };
          } catch (error) { failure = error; tx.abort(); }
        };
      });
    } finally { database.close(); }
  }
  private async open(): Promise<IDBDatabase> {
    const database = await openWebThemeDatabase();
    if (!database) throw new BackgroundError("unavailable");
    return database;
  }
}
function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new BackgroundError("unavailable")); });
}
