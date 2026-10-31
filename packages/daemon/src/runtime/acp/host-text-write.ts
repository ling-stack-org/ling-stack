import { spawn } from "node:child_process";
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import type { HostTextRead } from "./host-text-read.js";
import { executeHostTextWriteWorker } from "./host-text-write-worker.js";

interface Identity { readonly dev: string; readonly ino: string; readonly size: string; readonly mtime: string; readonly ctime: string }
export interface HostTextWrite { assertUnchanged(): void }
export class HostTextWriteError extends Error {
  constructor(readonly outcome: "not_started" | "unknown") { super("host_file_write_failed"); }
}
const maxBytes = 4 * 1024 * 1024;
const identity = (info: BigIntStats): Identity => ({ dev: String(info.dev), ino: String(info.ino), size: String(info.size),
  mtime: String(info.mtimeNs), ctime: String(info.ctimeNs) });

/** Capture before claim; the OS-contained worker performs the mutation only after claim. */
export function prepareBoundedHostWrite(path: string, signal: AbortSignal, baseline?: HostTextRead): { write(content: string): Promise<HostTextWrite> } {
  signal.throwIfAborted();
  if (process.platform !== "darwin") throw new HostTextWriteError("not_started");
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) throw new HostTextWriteError("not_started");
  const directory = lstatSync(parent, { bigint: true });
  if (!directory.isDirectory()) throw new HostTextWriteError("not_started");
  const expected = target(path);
  // Validate the captured destination against the retained read, never adopt a newer baseline.
  baseline?.assertUnchanged();
  const executable = realpathSync(process.execPath);
  // Serialize only this authored, closure-free function; stdin carries the bounded request.
  // A bundled daemon has no adjacent worker file, so its reviewed CLI pins the worker too.
  const worker = `(${executeHostTextWriteWorker.toString()})()`;
  const literal = (value: string): string => `(literal ${JSON.stringify(value)})`;
  const ancestors = [parent];
  while (dirname(ancestors.at(-1)!) !== ancestors.at(-1)) ancestors.push(dirname(ancestors.at(-1)!));
  const electronFrameworks = process.versions.electron
    ? realpathSync(join(dirname(executable), "../Frameworks")) : undefined;
  const profile = ["(version 1)", "(deny default)", "(allow process-exec)", "(allow sysctl-read)",
    "(allow file-read-metadata)", "(deny network*)", `(allow file-read-data ${ancestors.map(literal).join(" ")})`,
    ...(electronFrameworks ? [`(allow file-read* (subpath ${JSON.stringify(electronFrameworks)}))`] : []),
    `(allow file-read* ${[executable, "/dev/null", "/dev/urandom", "/dev/random"].map(literal).join(" ")}
      (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System"))`,
    `(allow file-write* ${literal(path)} (literal "/dev/null"))`,
  ].join("\n");
  return { async write(content) {
    signal.throwIfAborted();
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > maxBytes || content.includes("\0") || bytes.toString("utf8") !== content) throw new HostTextWriteError("not_started");
    const output = await writeWorker(["-p", profile, executable, "--input-type=module", "--eval", worker], parent,
      JSON.stringify({ path, parent: { dev: String(directory.dev), ino: String(directory.ino) }, expected, content }), signal);
    let value;
    try { value = JSON.parse(output); } catch { throw new HostTextWriteError("unknown"); }
    if (value?.outcome !== "succeeded") throw new HostTextWriteError(value?.outcome === "not_started" ? "not_started" : "unknown");
    const receipt = value.identity;
    if (!receipt || Object.keys(identity(directory)).some(key => typeof receipt[key] !== "string")) throw new HostTextWriteError("unknown");
    return { assertUnchanged() {
      signal.throwIfAborted();
      if (JSON.stringify(target(path)) !== JSON.stringify(receipt)) throw new HostTextWriteError("unknown");
    } };
  } };
}

async function writeWorker(args: readonly string[], cwd: string, input: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const child = spawn("/usr/bin/sandbox-exec", args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent",
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let failed = false, bytes = 0;
    const stop = (): void => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, 5000);
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    const consume = (chunk: Buffer, keep: boolean): void => {
      bytes += chunk.length;
      if (bytes > 65536) stop();
      else if (keep) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.once("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || code !== 0) reject(new HostTextWriteError("unknown"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal.aborted) stop();
    else child.stdin.end(input);
  });
}

function target(path: string): Identity | null {
  let info;
  try { info = lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (realpathSync(path) !== path || !info.isFile() || info.nlink !== 1n || info.size > BigInt(maxBytes)) throw new HostTextWriteError("not_started");
  return identity(info);
}
