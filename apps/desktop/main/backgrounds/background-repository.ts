import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_LIMITS, BACKGROUND_VIDEO_LIMITS, BackgroundError, INITIAL_BACKGROUND, backgroundDigest,
  backgroundVideoMimeType, exactObject, inspectBackgroundImage, isBackgroundAssetId, isBackgroundRequestId,
  parseBackgroundAsset, parseBackgroundPreference,
  parsePrepareBackgroundRequest, verifyBackgroundCommit, commitBackgroundPreference, type BackgroundImage, type BackgroundPreference,
  type BackgroundRepository, type BackgroundSnapshot, type CommitBackgroundRequest, type PrepareBackgroundRequest } from "@ling-stack/ui-react/theme";
import { sanitizeBackground } from "./background-codec.js";

interface State { preference: BackgroundPreference; receipt?: { requestId: string; payloadDigest: string } }
export class DesktopBackgroundRepository implements BackgroundRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private candidate?: { requestId: string; image: BackgroundImage };
  private preparing?: { requestId: string; abort: AbortController };
  private readonly root: string;
  constructor(root: string, private readonly helperPath: string,
    private readonly codec = sanitizeBackground,
    private readonly checkpoint: (stage: string) => void = () => {}) { this.root = resolve(root); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  async initialize(): Promise<void> {
    await this.serial(async () => { await this.ensureRoot(); const state = await this.state(); await this.collect(state.preference); });
  }
  async read(): Promise<BackgroundSnapshot> {
    return this.serial(async () => {
      await this.ensureRoot(); const { preference } = await this.state();
      if (preference.selection.kind === "none") return { preference };
      try { return { preference, image: await this.readMedia(preference.selection.assetId) }; }
      catch { return { preference, resourceError: "corrupt" }; }
    });
  }
  async prepare(input: PrepareBackgroundRequest): Promise<BackgroundImage> {
    const request = parsePrepareBackgroundRequest(input);
    const videoType = backgroundVideoMimeType(request.bytes, request.fileName, request.mimeType);
    if (videoType) {
      if (this.preparing) throw new BackgroundError("unavailable");
      this.candidate = undefined;
      const abort = new AbortController(); this.preparing = { requestId: request.requestId, abort };
      try {
        if (request.bytes.length > BACKGROUND_VIDEO_LIMITS.bytes) throw new BackgroundError("capacity");
        const bytes = new Uint8Array(request.bytes);
        const image: BackgroundImage = { bytes, asset: { kind: "video", assetId: await backgroundDigest(bytes), mimeType: videoType,
          byteLength: bytes.length, width: request.width!, height: request.height!, duration: request.duration! } };
        if (abort.signal.aborted) throw new BackgroundError("aborted");
        this.candidate = { requestId: request.requestId, image }; return image;
      } finally { this.preparing = undefined; }
    }
    inspectBackgroundImage(request.bytes, request.fileName, request.mimeType);
    if (this.preparing) throw new BackgroundError("unavailable");
    this.candidate = undefined;
    const abort = new AbortController(); this.preparing = { requestId: request.requestId, abort };
    try {
      const bytes = await this.codec(request.bytes, this.helperPath, abort.signal);
      if (abort.signal.aborted) throw new BackgroundError("aborted");
      const header = inspectBackgroundImage(bytes);
      if (header.mimeType !== "image/png") throw new BackgroundError("invalid-image");
      const image: BackgroundImage = { bytes, asset: { kind: "image", assetId: await backgroundDigest(bytes), mimeType: "image/png",
        byteLength: bytes.length, width: header.width, height: header.height } };
      if (abort.signal.aborted) throw new BackgroundError("aborted");
      this.candidate = { requestId: request.requestId, image }; return image;
    } finally { this.preparing = undefined; }
  }
  async release(requestId: string): Promise<void> {
    if (!isBackgroundRequestId(requestId)) throw new BackgroundError("invalid-request");
    if (this.preparing?.requestId === requestId) this.preparing.abort.abort();
    if (this.candidate?.requestId === requestId) this.candidate = undefined;
  }
  async commit(input: CommitBackgroundRequest): Promise<BackgroundPreference> {
    const request = await verifyBackgroundCommit(input);
    // Capture the prepared lease before another window action can release it.
    const candidate = this.candidate?.image;
    return this.serial(async () => {
      await this.ensureRoot(); const state = await this.state();
      if (state.receipt?.requestId === request.requestId) {
        if (state.receipt.payloadDigest !== request.payloadDigest) throw new BackgroundError("invalid-request");
        return state.preference;
      }
      if (state.preference.revision !== request.expectedRevision) throw new BackgroundError("conflict");
      const preference = commitBackgroundPreference(state.preference, request);
      if (request.selection.kind !== "none") {
        if (candidate?.asset.assetId === request.selection.assetId) {
          if (await backgroundDigest(candidate.bytes) !== candidate.asset.assetId) throw new BackgroundError("corrupt");
          if (candidate.asset.kind === "image") inspectBackgroundImage(candidate.bytes);
          else if (!backgroundVideoMimeType(candidate.bytes, `background.${candidate.asset.mimeType === "video/mp4" ? "mp4" : "webm"}`, candidate.asset.mimeType)) throw new BackgroundError("corrupt");
          await this.publish(`${candidate.asset.assetId}.${candidate.asset.kind === "image" ? "png" : candidate.asset.mimeType === "video/mp4" ? "mp4" : "webm"}`, candidate.bytes, "asset");
          await this.publish(`${candidate.asset.assetId}.json`, new TextEncoder().encode(JSON.stringify(candidate.asset)), "metadata");
        } else {
          if (state.preference.selection.kind === "none" || state.preference.selection.assetId !== request.selection.assetId) throw new BackgroundError("invalid-request");
          await this.readMedia(request.selection.assetId);
        }
      }
      const next: State = { preference, receipt: { requestId: request.requestId, payloadDigest: request.payloadDigest } };
      await this.publish("settings.json", new TextEncoder().encode(JSON.stringify(next)), "config");
      // Config publication is authoritative even when collection fails; startup retries collection.
      try { await this.collect(preference); } catch { /* preserve successful receipt */ }
      return preference;
    });
  }
  dispose(): void { this.preparing?.abort.abort(); this.candidate = undefined; }
  private async ensureRoot(): Promise<void> {
    if (await realpath(dirname(this.root)) !== dirname(this.root)) throw new BackgroundError("unavailable");
    await mkdir(this.root, { recursive: true });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root) throw new BackgroundError("unavailable");
  }
  private async boundedRead(name: string, limit: number): Promise<Uint8Array> {
    await this.ensureRoot();
    const path = join(this.root, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit || await realpath(path) !== path) throw new BackgroundError("corrupt");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw new BackgroundError("corrupt");
      // Fixed-size allocation also bounds concurrent external changes to the file.
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw new BackgroundError("corrupt"); offset += bytesRead; }
      if ((await handle.stat()).size !== bytes.length) throw new BackgroundError("corrupt");
      return new Uint8Array(bytes);
    } finally { await handle.close(); }
  }
  private async state(): Promise<State> {
    let bytes: Uint8Array;
    try { bytes = await this.boundedRead("settings.json", 8192); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { preference: INITIAL_BACKGROUND }; throw error; }
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!exactObject(raw, ["preference", "receipt"]) || !exactObject(raw.receipt, ["requestId", "payloadDigest"])
      || !isBackgroundRequestId(raw.receipt.requestId) || !isBackgroundAssetId(raw.receipt.payloadDigest)) throw new BackgroundError("corrupt");
    return { preference: parseBackgroundPreference(raw.preference), receipt: raw.receipt as State["receipt"] };
  }
  private async readMedia(assetId: string): Promise<BackgroundImage> {
    if (!isBackgroundAssetId(assetId)) throw new BackgroundError("invalid-request");
    for (const extension of ["png", "mp4", "webm"] as const) {
      try {
        const bytes = await this.boundedRead(`${assetId}.${extension}`, extension === "png" ? BACKGROUND_LIMITS.bytes : BACKGROUND_VIDEO_LIMITS.bytes);
        if (await backgroundDigest(bytes) !== assetId) throw new BackgroundError("corrupt");
        if (extension === "png") {
          const header = inspectBackgroundImage(bytes);
          if (header.mimeType !== "image/png") throw new BackgroundError("corrupt");
          return { bytes, asset: parseBackgroundAsset({ kind: "image", assetId, mimeType: "image/png", byteLength: bytes.length, width: header.width, height: header.height }) };
        }
        const mimeType = backgroundVideoMimeType(bytes, `background.${extension}`, extension === "mp4" ? "video/mp4" : "video/webm");
        if (!mimeType) throw new BackgroundError("corrupt");
        const metadataBytes = await this.boundedRead(`${assetId}.json`, 8192);
        const metadata = parseBackgroundAsset(JSON.parse(new TextDecoder().decode(metadataBytes)));
        if (metadata.kind !== "video" || metadata.mimeType !== mimeType || metadata.assetId !== assetId || metadata.byteLength !== bytes.length) throw new BackgroundError("corrupt");
        return { bytes, asset: metadata };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    throw new BackgroundError("corrupt");
  }
  private async publish(name: string, bytes: Uint8Array, stage: string): Promise<void> {
    await this.ensureRoot();
    const temporary = join(this.root, `.stage-${randomUUID()}`), target = join(this.root, name);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    this.checkpoint(`${stage}-staged`);
    try {
      try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new BackgroundError("corrupt"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(temporary, target);
      if (process.platform !== "win32") { const dir = await open(this.root, "r"); try { await dir.sync(); } finally { await dir.close(); } }
      this.checkpoint(`${stage}-published`);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  private async collect(preference: BackgroundPreference): Promise<void> {
    const keep = preference.selection.kind !== "none" ? preference.selection.assetId : undefined;
    for (const name of await readdir(this.root)) {
      if ((keep && name.startsWith(`${keep}.`)) || !(/^\.stage-[a-f0-9-]{36}$/u.test(name) || /^[a-f0-9]{64}\.(?:png|mp4|webm|json)$/u.test(name))) continue;
      const path = join(this.root, name), info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) await unlink(path);
    }
  }
}
