import { BACKGROUND_LIMITS, BACKGROUND_VIDEO_LIMITS, BACKGROUND_PROFILE_LIMIT, BackgroundError, backgroundVideoMimeType,
  checkBackgroundVideoMetadata, exactObject, isBackgroundAssetId, isBackgroundOpacity, parseBackgroundSelection,
  parseBackgroundPresentation, parseBackgroundPreference,
  type BackgroundAsset, type BackgroundPreference, type BackgroundPresentation } from "./background-model.js";

export interface BackgroundImage { readonly asset: BackgroundAsset; readonly bytes: Uint8Array }
export type BackgroundMedia = BackgroundImage;
export interface BackgroundSnapshot {
  readonly preference: BackgroundPreference;
  readonly image?: BackgroundImage;
  readonly resourceError?: "corrupt";
}
export interface PrepareBackgroundRequest {
  readonly requestId: string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
}
export interface CommitBackgroundRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly payloadDigest: string;
  readonly selection: BackgroundPreference["selection"];
  readonly opacity: number;
  readonly presentation?: BackgroundPresentation;
}
export interface BackgroundRepository {
  read(): Promise<BackgroundSnapshot>;
  prepare(request: PrepareBackgroundRequest): Promise<BackgroundImage>;
  release(requestId: string): Promise<void>;
  commit(request: CommitBackgroundRequest): Promise<BackgroundPreference>;
}
export function isBackgroundRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,80}$/u.test(value);
}
export function parsePrepareBackgroundRequest(value: unknown): PrepareBackgroundRequest {
  if (!exactObject(value, ["requestId", "bytes", "fileName", "mimeType"])
    && !exactObject(value, ["requestId", "bytes", "fileName", "mimeType", "width", "height", "duration"])) {
    throw new BackgroundError("invalid-request");
  }
  if (!isBackgroundRequestId(value.requestId) || !(value.bytes instanceof Uint8Array) || !value.bytes.length
    || value.bytes.length > BACKGROUND_VIDEO_LIMITS.bytes || typeof value.fileName !== "string"
    || value.fileName.length > 255 || /[\\/\u0000]/u.test(value.fileName)
    || typeof value.mimeType !== "string" || value.mimeType.length > 80) throw new BackgroundError("invalid-request");
  const video = backgroundVideoMimeType(value.bytes, value.fileName, value.mimeType);
  if (video) {
    if (![value.width, value.height].every(Number.isSafeInteger) || typeof value.duration !== "number") throw new BackgroundError("invalid-request");
    checkBackgroundVideoMetadata(value.width as number, value.height as number, value.duration);
    return Object.freeze({ ...value, mimeType: video }) as unknown as PrepareBackgroundRequest;
  }
  if (value.bytes.length > BACKGROUND_LIMITS.bytes) throw new BackgroundError("invalid-request");
  return value as unknown as PrepareBackgroundRequest;
}
export function parseCommitBackgroundRequest(value: unknown): CommitBackgroundRequest {
  if ((!exactObject(value, ["requestId", "expectedRevision", "payloadDigest", "selection", "opacity"])
      && !exactObject(value, ["requestId", "expectedRevision", "payloadDigest", "selection", "opacity", "presentation"]))
    || !isBackgroundRequestId(value.requestId) || !isBackgroundAssetId(value.payloadDigest)
    || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0
    || (value.expectedRevision as number) >= Number.MAX_SAFE_INTEGER || !isBackgroundOpacity(value.opacity)) {
    throw new BackgroundError("invalid-request");
  }
  try { parseBackgroundSelection(value.selection); }
  catch { throw new BackgroundError("invalid-request"); }
  if ("presentation" in value) parseBackgroundPresentation(value.presentation);
  return value as unknown as CommitBackgroundRequest;
}
export async function backgroundDigest(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function backgroundPayloadDigest(input: Omit<CommitBackgroundRequest, "requestId" | "payloadDigest">): Promise<string> {
  const payload: unknown[] = [
    input.expectedRevision,
    input.selection.kind,
    input.selection.kind === "none" ? null : input.selection.assetId,
    input.opacity,
  ];
  if (input.presentation) payload.push([input.presentation.themeId, input.presentation.focusX, input.presentation.focusY, input.presentation.paused]);
  return backgroundDigest(new TextEncoder().encode(JSON.stringify(payload)));
}
/** Both repositories merge inside their existing revision-checked transaction. */
export function commitBackgroundPreference(current: BackgroundPreference, request: CommitBackgroundRequest): BackgroundPreference {
  const profiles = { ...current.profiles };
  if (request.presentation) {
    const { themeId, focusX, focusY, paused } = request.presentation;
    profiles[themeId] = { opacity: request.opacity, focusX, focusY, paused };
  }
  if (Object.keys(profiles).length > BACKGROUND_PROFILE_LIMIT) throw new BackgroundError("capacity");
  return parseBackgroundPreference({ schemaVersion: 3, revision: current.revision + 1,
    selection: request.selection, opacity: request.presentation ? current.opacity : request.opacity, profiles });
}
export async function verifyBackgroundCommit(input: unknown): Promise<CommitBackgroundRequest> {
  const request = parseCommitBackgroundRequest(input);
  if (await backgroundPayloadDigest(request) !== request.payloadDigest) throw new BackgroundError("invalid-request");
  return request;
}
