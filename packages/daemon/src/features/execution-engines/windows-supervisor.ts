import { spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

const protocol = "ling.engine-supervisor.v1";
const version = "0.1.0";
const executableName = "ling-engine-supervisor.exe";
const invalid = (): Error => new Error("engine_supervisor_spawn_invalid");

function localWindowsPath(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]:[\\/]/i.test(value) && !value.includes("\0") && !value.slice(2).includes(":");
}

export function buildSupervisorRequest(executable: string, digest: string, args: readonly string[], options: SpawnOptions): Buffer {
  if (!localWindowsPath(executable) || win32.extname(executable).toLowerCase() !== ".exe"
    || !/^[a-f0-9]{64}$/.test(digest) || !localWindowsPath(options.cwd) || options.shell
    || !options.env || args.length > 256 || args.some(arg => typeof arg !== "string" || arg.includes("\0"))
    || !Array.isArray(options.stdio) || options.stdio.length !== 3
    || options.stdio.some(value => value !== "pipe" && value !== "ignore")) throw invalid();
  const body = Buffer.from(JSON.stringify({ protocol, executable, digest, args, cwd: options.cwd }), "utf8");
  if (body.length > 64 * 1024) throw invalid();
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length);
  body.copy(frame, 4);
  return frame;
}

export async function readSupervisorArtifact(path: string): Promise<{ readonly path: string }> {
  try {
    if (!isAbsolute(path) || basename(path) !== executableName || (process.platform === "win32" && !localWindowsPath(path))) throw invalid();
    const manifestPath = join(dirname(path), "build-metadata.json");
    const metadata: unknown = JSON.parse((await readArtifactFile(manifestPath, 4096)).toString("utf8"));
    if (!metadata || typeof metadata !== "object" || !("schema" in metadata) || metadata.schema !== "ling.engine-supervisor.build.v1"
      || !("version" in metadata) || metadata.version !== version || !("protocol" in metadata) || metadata.protocol !== protocol
      || !("platform" in metadata) || metadata.platform !== "win32-x64" || !("executable" in metadata) || metadata.executable !== executableName
      || !("sha256" in metadata) || typeof metadata.sha256 !== "string") throw invalid();
    const bytes = await readArtifactFile(path, 32 * 1024 * 1024);
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
    if (bytes.toString("ascii", 0, 2) !== "MZ" || pe < 64 || pe + 4 > bytes.length
      || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0"
      || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw invalid();
    return { path: await realpath(path) };
  } catch { throw new Error("engine_supervisor_unavailable"); }
}

async function readArtifactFile(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw invalid();
  const file = await open(path, "r");
  const same = (info: Awaited<ReturnType<typeof lstat>>): boolean => info.isFile() && info.nlink === 1
    && info.dev === before.dev && info.ino === before.ino && info.size === before.size && info.mtimeMs === before.mtimeMs;
  try {
    if (!same(await file.stat())) throw invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== before.size || !same(await file.stat()) || !same(await lstat(path))) throw invalid();
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

/** Only trusted host launch input may choose the helper. Profiles never carry this path. */
export async function prepareOwnedNativeSpawn(executable: string, digest: string, injected?: typeof spawn): Promise<typeof spawn> {
  if (injected) return injected;
  if (process.platform !== "win32") return spawn;
  if (process.arch !== "x64") throw new Error("engine_supervisor_unavailable");
  const path = process.env.LING_ENGINE_SUPERVISOR_PATH
    ?? fileURLToPath(new URL(`../../native/engine-supervisor/${executableName}`, import.meta.url));
  return createSupervisorSpawn(await readSupervisorArtifact(path), executable, digest);
}

export function createSupervisorSpawn(artifact: { readonly path: string }, executable: string, digest: string,
  launch: typeof spawn = spawn): typeof spawn {
  return ((file: string, args: readonly string[], options: SpawnOptions) => {
    if (file !== executable) throw invalid();
    const frame = buildSupervisorRequest(file, digest, args, options);
    const child = launch(artifact.path, ["--owner-fd=3"], { ...options, stdio: [...options.stdio as ("pipe" | "ignore")[], "pipe"],
      shell: false, detached: false, windowsHide: true });
    const control = child.stdio[3];
    let acknowledged = false;
    let failed = false;
    let pending = Buffer.alloc(0);
    const fail = (): void => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      child.emit("error", new Error("engine_supervisor_protocol_error"));
    };
    if (!(control instanceof Duplex)) {
      queueMicrotask(fail);
      return child;
    }
    control.on("error", fail);
    control.on("data", (chunk: Buffer) => {
      if (failed) return;
      pending = Buffer.concat([pending, chunk]);
      if (acknowledged || pending.length > 512) { fail(); return; }
      const newline = pending.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(pending.subarray(0, newline).toString("utf8"));
        if (newline !== pending.length - 1 || response.protocol !== protocol || response.version !== version
          || response.started !== true || Object.keys(response).length !== 3) throw invalid();
        acknowledged = true;
        pending = Buffer.alloc(0);
      } catch { fail(); }
    });
    child.once("error", () => { failed = true; control.destroy(); child.kill("SIGKILL"); });
    child.once("close", () => {
      if (!acknowledged && !failed) fail();
      control.destroy();
    });
    control.write(frame, error => { if (error) fail(); });
    return child;
  }) as typeof spawn;
}
