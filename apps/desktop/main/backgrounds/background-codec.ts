import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BACKGROUND_LIMITS, BackgroundError } from "@ling-stack/ui-react/theme";

/** The host supplies the existing product codec path; renderer input never selects an executable. */
export async function sanitizeBackground(bytes: Uint8Array, helperPath: string, signal: AbortSignal): Promise<Uint8Array> {
  if (!isAbsolute(helperPath)) throw new BackgroundError("unavailable");
  const info = await lstat(helperPath);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 32 * 1024 * 1024) throw new BackgroundError("unavailable");
  if (signal.aborted) throw new BackgroundError("aborted");
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [String(BACKGROUND_LIMITS.pixels), "--background"], { shell: false, windowsHide: true,
      env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, stderr = 0, failure: BackgroundError | undefined, finished = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: BackgroundError) => {
      if (finished) return;
      finished = true; clearTimeout(deadline); clearTimeout(closeTimer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(new Uint8Array(Buffer.concat(chunks, size)));
    };
    const stop = (error: BackgroundError) => {
      failure ??= error;
      if (finished || closeTimer) return;
      child.kill("SIGKILL"); child.stdin.destroy();
      closeTimer = setTimeout(() => finish(failure), 2000);
    };
    const abort = () => stop(new BackgroundError("aborted"));
    const deadline = setTimeout(() => stop(new BackgroundError("unavailable")), 5000);
    signal.addEventListener("abort", abort, { once: true });
    for (const stream of [child, child.stdin, child.stdout, child.stderr]) stream.on("error", () => stop(new BackgroundError("invalid-image")));
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      size += chunk.length;
      if (size > BACKGROUND_LIMITS.bytes) { stop(new BackgroundError("capacity")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.length; if (stderr > 4096) stop(new BackgroundError("invalid-image")); });
    child.once("close", (code, exitSignal) => {
      if (signal.aborted) finish(new BackgroundError("aborted"));
      else if (failure) finish(failure);
      else if (exitSignal || code !== 0) finish(new BackgroundError(code === 4 ? "capacity" : "invalid-image"));
      else finish();
    });
    if (signal.aborted) abort(); else child.stdin.end(bytes);
  });
}
