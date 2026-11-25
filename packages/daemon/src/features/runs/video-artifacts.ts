import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";
import { constants, lstatSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, statfsSync, unlinkSync, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import { resolveWorkspaceFileTarget, WorkspaceFileTargetError,
  type ResolvedWorkspaceFileTarget } from "../previews/workspace-file-preview.js";
import { toPublicArtifactMetadata } from "./public-artifacts.js";

const MAX_VIDEO_BYTES = 512n * 1024n * 1024n;
const MIN_ARTIFACT_FREE_BYTES = 64n * 1024n * 1024n;
const reservedBytesByVolume = new Map<bigint, bigint>();
const pendingPublications = new Map<string, Promise<void>>();

export async function handlePublishRunVideo(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  stores: RunStoreRegistry,
  runId: string,
  maxBodyBytes: number,
): Promise<void> {
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd || !stores.isTrustedWorkspaceRoot(cwd)) {
    writeJson(response, cwd ? 403 : 400, { error: cwd ? "workspace_not_trusted" : "bad_request",
      message: cwd ? "Video publishing requires a daemon-known workspace." : "cwd is required." });
    return;
  }
  const store = stores.getStore(cwd);
  const run = store.getRun(runId);
  if (!run) {
    writeJson(response, 404, { error: "run_not_found", message: "Run was not found in this workspace." });
    return;
  }
  if (run.status !== "succeeded") {
    writeJson(response, 409, { error: "run_not_succeeded", message: "Video publishing requires a successful run." });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, maxBodyBytes);
  } catch (error) {
    if (!response.destroyed) writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (response.destroyed) return;
  const abort = new AbortController();
  response.once("close", () => abort.abort());
  try {
    const path = isRecord(body) && typeof body.path === "string" ? body.path.trim() : "";
    if (!path || path.includes("\0") || extname(path).toLowerCase() !== ".mp4") {
      throw new HttpError(400, "invalid_video_path", "An MP4 file path is required.");
    }
    const target = resolveWorkspaceFileTarget(run.cwd, path);
    const segments = target.displayPath.split(sep);
    if (segments.some(segment => [".git", ".ling-stack"].includes(segment.toLowerCase()))) {
      throw new HttpError(403, "video_path_forbidden", "Select an MP4 from the workspace files.");
    }
    const { artifact, created } = await publishMp4(store, run.id, target, basename(path), abort.signal);
    if (!response.destroyed) writeJson(response, created ? 201 : 200, { artifact: toPublicArtifactMetadata(artifact) });
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof HttpError || error instanceof WorkspaceFileTargetError) {
      writeJson(response, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    writeJson(response, 500, { error: "video_publish_failed", message: "The MP4 could not be saved as a run artifact." });
  }
}

async function publishMp4(store: RunStore, runId: string, target: ResolvedWorkspaceFileTarget, title: string, signal: AbortSignal) {
  const source = target.contentPath;
  const inspect = (path: string) => lstatSync(path, { bigint: true });
  let parent = target.workspaceRoot;
  const ancestors = ["", ...target.displayPath.split(sep).slice(0, -1)].map(segment => {
    parent = join(parent, segment);
    const revision = inspect(parent);
    if (!revision.isDirectory()) throw videoSourceChanged();
    return { path: parent, revision };
  });
  const expected = inspect(source);
  if (!expected.isFile() || realpathSync(source) !== source) throw videoSourceChanged();
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // The existing artifact ID uses Node's numeric stat representation.
    const { dev, ino, size, mtimeMs, ctimeMs } = await input.stat();
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || !sameFileRevision(expected, before) || !sameFileRevision(before, inspect(source))
      || realpathSync(source) !== source || !ancestors.every(({ path, revision }) => sameFileRevision(revision, inspect(path)))) {
      throw videoSourceChanged();
    }
    const header = Buffer.alloc(12);
    const { bytesRead } = await input.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("ascii", 4, 8) !== "ftyp") {
      throw new HttpError(415, "unsupported_video", "The selected file is not a usable MP4.");
    }
    // Bind retries to the same source revision while retaining published bytes independently.
    const id = `artifact_${createHash("sha256").update(JSON.stringify([
      runId, source, dev, ino, size, mtimeMs, ctimeMs,
    ])).digest("hex")}`;
    const key = JSON.stringify([store.paths.databasePath, id]);
    let pending = pendingPublications.get(key);
    while (pending) {
      await waitForVideoPublication(pending, signal);
      pending = pendingPublications.get(key);
    }
    const existing = store.getArtifact(id);
    if (existing) return { artifact: existing, created: false };
    if (before.size > MAX_VIDEO_BYTES) {
      throw new HttpError(413, "video_size_exceeded", "The MP4 exceeds the 512 MiB publication limit.");
    }
    const publication = copyVideo(store, runId, id, title, input, before, signal);
    pendingPublications.set(key, publication.then(() => undefined, () => undefined));
    try {
      return await publication;
    } finally {
      pendingPublications.delete(key);
    }
  } finally {
    await input.close();
  }
}

async function waitForVideoPublication(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let listener: ReturnType<typeof addAbortListener> | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    listener = addAbortListener(signal, () => reject(signal.reason));
  });
  try { await Promise.race([pending, cancelled]); }
  finally { listener?.[Symbol.dispose](); }
  signal.throwIfAborted();
}

async function copyVideo(store: RunStore, runId: string, id: string, title: string,
  input: FileHandle, before: BigIntStats, signal: AbortSignal) {
  const storeRoot = store.paths.artifactsDir;
  const artifactRoot = realpathSync(storeRoot);
  const rootIdentity = lstatSync(artifactRoot, { bigint: true });
  if (!rootIdentity.isDirectory()) throw videoStorageChanged();
  const release = reserveVideoBytes(artifactRoot, rootIdentity.dev, before.size);
  let staging: { path: string; identity: BigIntStats } | undefined;
  let destinationIdentity: BigIntStats | undefined;
  let retained = false;
  try {
    signal.throwIfAborted();
    const dir = mkdtempSync(join(artifactRoot, "video-"), { encoding: "utf8" });
    const identity = lstatSync(dir, { bigint: true });
    if (!identity.isDirectory() || identity.dev !== rootIdentity.dev || realpathSync(dir) !== dir) throw videoStorageChanged();
    staging = { path: dir, identity };
    const destination = join(dir, "video.mp4");
    const sizeBytes = Number(before.size);
    const assertStorage = () => {
      if (realpathSync(storeRoot) !== artifactRoot || !ownsNode(artifactRoot, rootIdentity) || !ownsNode(dir, identity)) {
        throw videoStorageChanged();
      }
    };
    assertStorage();
    const handle = await open(destination, "wx", 0o600);
    let output: ReturnType<FileHandle["createWriteStream"]> | undefined;
    try {
      destinationIdentity = await handle.stat({ bigint: true });
      assertStorage();
      if (!destinationIdentity.isFile() || destinationIdentity.dev !== identity.dev || !ownsNode(destination, destinationIdentity)) {
        throw videoStorageChanged();
      }
      output = handle.createWriteStream({ autoClose: false });
      await pipeline(input.createReadStream({ start: 0, end: sizeBytes - 1, autoClose: false }), output, { signal });
      if (output.bytesWritten !== sizeBytes || !sameFileRevision(before, await input.stat({ bigint: true }))) {
        throw videoSourceChanged();
      }
      destinationIdentity = await handle.stat({ bigint: true });
    } finally {
      output?.destroy();
      await handle.close();
    }
    signal.throwIfAborted();
    assertStorage();
    const stored = lstatSync(destination, { bigint: true, throwIfNoEntry: false });
    if (!stored?.isFile() || stored.size !== before.size || !sameFileRevision(stored, destinationIdentity)) throw videoStorageChanged();
    const artifactPath = relative(artifactRoot, destination).split(sep).join("/");
    const prior = store.getArtifact(id);
    if (prior) return { artifact: prior, created: false };
    try {
      const artifact = store.createArtifact({ id, runId, type: "video", path: artifactPath, title,
        contentType: "video/mp4", sizeBytes, createdAt: new Date().toISOString() });
      retained = true;
      return { artifact, created: true };
    } catch (error) {
      const committed = store.getArtifact(id);
      if (!committed) throw error;
      retained = committed.path === artifactPath;
      return { artifact: committed, created: retained };
    }
  } finally {
    try {
      if (!retained && staging && ownsNode(artifactRoot, rootIdentity) && ownsNode(staging.path, staging.identity)) {
        const destination = join(staging.path, "video.mp4");
        if (destinationIdentity && ownsNode(destination, destinationIdentity)) unlinkSync(destination);
        if (readdirSync(staging.path).length === 0) rmdirSync(staging.path);
      }
    } finally { release(); }
  }
}

function reserveVideoBytes(artifactRoot: string, volume: bigint, size: bigint): () => void {
  const { bavail, bsize } = statfsSync(artifactRoot, { bigint: true });
  const reserved = (reservedBytesByVolume.get(volume) ?? 0n) + size;
  if (bavail * bsize < reserved + MIN_ARTIFACT_FREE_BYTES) {
    throw new HttpError(507, "video_storage_insufficient", "There is insufficient free space to publish the MP4.");
  }
  reservedBytesByVolume.set(volume, reserved);
  return () => {
    const remaining = reservedBytesByVolume.get(volume)! - size;
    if (remaining > 0n) reservedBytesByVolume.set(volume, remaining);
    else reservedBytesByVolume.delete(volume);
  };
}

function ownsNode(path: string, expected: BigIntStats): boolean {
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return current !== undefined && current.dev === expected.dev && current.ino === expected.ino && !current.isSymbolicLink();
}

function sameFileRevision(expected: BigIntStats, actual: BigIntStats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.mode === actual.mode
    && expected.size === actual.size && expected.mtimeNs === actual.mtimeNs && expected.ctimeNs === actual.ctimeNs;
}

function videoSourceChanged() {
  return new HttpError(409, "video_source_changed", "The MP4 changed while being published. Retry when the export has finished.");
}

function videoStorageChanged() {
  return new HttpError(409, "video_storage_changed", "The artifact directory changed while publishing the MP4.");
}
