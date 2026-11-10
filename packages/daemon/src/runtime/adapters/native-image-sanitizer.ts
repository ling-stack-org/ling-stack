import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_ARTIFACT_MAX_BYTES } from "@ling-stack/core";
import { inspectSupportedImage } from "../../features/media/image-inspection.js";
import { NativeArtifactError } from "./native-artifact-files.js";

const executableName = process.platform === "win32" ? "ling-image-sanitizer.exe" : "ling-image-sanitizer";
const invalid = () => new NativeArtifactError("invalid_artifact");

/** A product-owned codec, never an executable selected by a model or engine profile. */
async function helperPath(): Promise<string> {
  const path = process.env.LING_IMAGE_SANITIZER_PATH
    ?? fileURLToPath(new URL(`../../native/image-sanitizer/${executableName}`, import.meta.url));
  if (!isAbsolute(path) || basename(path) !== executableName || path.includes("\0")) throw invalid();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 32 * 1024 * 1024) throw invalid();
  await access(path, constants.X_OK);
  return realpath(path);
}

/** Only returned image bytes and a pixel budget reach the product codec. */
export async function sanitizeNativeImage(bytes: Buffer, maxPixels: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 32_000_000
    || bytes.length > NATIVE_ARTIFACT_MAX_BYTES) throw new NativeArtifactError("capacity_exceeded");
  let path: string;
  try { path = await helperPath(); }
  catch { signal.throwIfAborted(); throw invalid(); }
  signal.throwIfAborted();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(path, [String(maxPixels)], { shell: false, windowsHide: true,
      env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
      stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, stderrSize = 0, failure: Error | undefined, settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(result!);
    };
    const stop = (error: Error) => {
      failure ??= error;
      if (settled || cleanupTimer) return;
      child.kill("SIGKILL");
      child.stdin.destroy();
      // A missing close receipt is a failure, never successful publication.
      cleanupTimer = setTimeout(() => finish(failure), 2000);
    };
    const aborted = () => {
      try { signal.throwIfAborted(); } catch (error) { stop(error instanceof Error ? error : invalid()); }
    };
    const timer = setTimeout(() => stop(invalid()), 5000);
    signal.addEventListener("abort", aborted, { once: true });
    child.once("error", () => stop(invalid()));
    child.stdin.on("error", () => stop(invalid()));
    child.stdout.on("error", () => stop(invalid()));
    child.stderr.on("error", () => stop(invalid()));
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      size += chunk.length;
      if (size > NATIVE_ARTIFACT_MAX_BYTES) { stop(new NativeArtifactError("capacity_exceeded")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 4096) stop(invalid());
    });
    child.once("close", (code, exitSignal) => {
      if (signal.aborted) { aborted(); finish(failure ?? invalid()); return; }
      if (failure) { finish(failure); return; }
      if (exitSignal || code !== 0) {
        finish(code === 3 ? new NativeArtifactError("unsupported_artifact")
          : code === 4 ? new NativeArtifactError("capacity_exceeded") : invalid());
        return;
      }
      const result = Buffer.concat(chunks, size);
      const image = inspectSupportedImage(result);
      if (!image || image.contentType !== "image/png" || image.width * image.height > maxPixels) {
        finish(invalid()); return;
      }
      finish(undefined, result);
    });
    if (signal.aborted) aborted();
    else child.stdin.end(bytes);
  }).catch(error => { signal.throwIfAborted(); throw error; });
}
