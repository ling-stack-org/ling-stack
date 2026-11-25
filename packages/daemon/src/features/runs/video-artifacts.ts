import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import { resolveWorkspaceFileTarget, WorkspaceFileTargetError } from "../previews/workspace-file-preview.js";
import { toPublicArtifactMetadata } from "./public-artifacts.js";

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
    const { artifact, created } = await publishMp4(store, run.id, target.contentPath, basename(path), abort.signal);
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

async function publishMp4(store: RunStore, runId: string, source: string, title: string, signal: AbortSignal) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat();
    if (!before.isFile()) throw new HttpError(415, "unsupported_video", "The selected file is not a usable MP4.");
    const header = Buffer.alloc(12);
    const { bytesRead } = await input.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("ascii", 4, 8) !== "ftyp") {
      throw new HttpError(415, "unsupported_video", "The selected file is not a usable MP4.");
    }
    // Bind retries to the same source revision while retaining published bytes independently.
    const id = `artifact_${createHash("sha256").update(JSON.stringify([
      runId, source, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs,
    ])).digest("hex")}`;
    const existing = store.getArtifact(id);
    if (existing) return { artifact: existing, created: false };

    const dir = await mkdtemp(join(store.paths.artifactsDir, "video-"));
    let retained = false;
    try {
      const destination = join(dir, "video.mp4");
      await pipeline(
        input.createReadStream({ start: 0, autoClose: false }),
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      const after = await input.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new HttpError(409, "video_source_changed", "The MP4 changed while being published. Retry when the export has finished.");
      }
      signal.throwIfAborted();
      const artifactPath = relative(store.paths.artifactsDir, destination).split(sep).join("/");
      const prior = store.getArtifact(id);
      if (prior) return { artifact: prior, created: false };
      try {
        const artifact = store.createArtifact({ id, runId, type: "video", path: artifactPath, title,
          contentType: "video/mp4", sizeBytes: before.size, createdAt: new Date().toISOString() });
        retained = true;
        return { artifact, created: true };
      } catch (error) {
        // A concurrent publisher can win the insert. A committed row always retains its file.
        const committed = store.getArtifact(id);
        if (!committed) throw error;
        retained = committed.path === artifactPath;
        return { artifact: committed, created: retained };
      }
    } finally {
      if (!retained) await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await input.close();
  }
}
