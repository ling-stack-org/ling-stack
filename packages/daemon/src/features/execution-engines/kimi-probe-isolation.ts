import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import type { ExecutionEngineProfile } from "@ling-stack/contracts";
import type { ExecutionEngineProfileStore } from "@ling-stack/core";
import { readNativeAuthFile } from "./native-auth-file.js";
import { EngineCredentialError } from "./native-secrets.js";
import { NativeConnectionError } from "./codex-connection.js";

interface Identity { readonly path: string; readonly directory: boolean; readonly info?: Stats }
interface Options {
  readonly store: ExecutionEngineProfileStore;
  readonly profile: ExecutionEngineProfile;
  readonly operationRoot: string;
  readonly executable: string;
  readonly signal: AbortSignal;
  readonly launch?: typeof spawn;
}
const invalid = (): EngineCredentialError => new EngineCredentialError("engine_native_auth_invalid");
const dataDirectories = ["sessions", "store", "cache", "logs", "blobs", "oauth"];

/** Connection diagnostics never lend a native process write access to an adopted account. */
export async function prepareKimiConnectionProbe(options: Options) {
  if (process.platform !== "darwin") throw new Error("native_process_boundary_unsupported");
  const profile = structuredClone(options.profile);
  if (profile.configuration.engineId !== "kimi-acp") throw invalid();
  const sourceHome = options.store.getAuthProfileDirectory(profile);
  const operationRoot = identity(options.operationRoot, true);
  const sources: Identity[] = [];
  let ancestor = sourceHome;
  for (let i = 0; i < 6; i++, ancestor = dirname(ancestor)) sources.push(identity(ancestor, true));
  let home: string | undefined;
  try {
    options.signal.throwIfAborted();
    home = await realpath(await mkdtemp(join(tmpdir(), "ling-kimi-probe-auth-")));
    const snapshotRoot = identity(home, true), snapshots: Identity[] = [snapshotRoot];
    const assertSourceCurrent = (): void => {
      options.signal.throwIfAborted();
      options.store.assertCurrentAuthProfile(profile);
      for (const target of sources) assertIdentity(target);
    };
    const assertCurrent = (): void => {
      assertSourceCurrent();
      for (const target of snapshots) assertIdentity(target);
    };
    const copy = async (relativePath: string): Promise<string | undefined> => {
      assertCurrent();
      const source = identity(join(sourceHome, relativePath), false, true);
      sources.push(source);
      const contents = source.info ? await readNativeAuthFile(source.path) : undefined;
      assertCurrent();
      const destination = join(home!, relativePath);
      if (contents !== undefined) await writeFile(destination, contents, { mode: 0o400, flag: "wx" });
      snapshots.push(identity(destination, false, true));
      assertCurrent();
      return contents;
    };
    const configuration = await copy("config.toml");
    const slots = configuration === undefined ? [] : credentialSlots(configuration);
    if (slots.length) {
      sources.push(identity(join(sourceHome, "credentials"), true, true));
      await mkdir(join(home, "credentials"), { mode: 0o700 });
      snapshots.push(identity(join(home, "credentials"), true));
      for (const slot of slots) await copy(join("credentials", `${slot}.json`));
    }
    for (const name of dataDirectories) {
      await mkdir(join(home, name), { mode: 0o700 });
      snapshots.push(identity(join(home, name), true));
    }
    assertCurrent();
    const children = new Set<ChildProcess>();
    let cleanupRequested = false;
    let disposal: Promise<void> | undefined;
    const remove = () => disposal ??= (async () => {
      try { await removeOwnedProbeDirectory(snapshotRoot); }
      finally { await removeOwnedProbeDirectory(operationRoot); }
    })();
    const ownedLaunch = ((file: string, args: readonly string[], settings: SpawnOptions) => {
      if (cleanupRequested) throw invalid();
      const child = (options.launch ?? spawn)(file, args, settings);
      children.add(child);
      child.once("close", () => {
        children.delete(child);
        if (cleanupRequested && children.size === 0) void remove().catch(() => {
          process.emitWarning("Deferred Kimi probe cleanup failed", { code: "LING_ENGINE_PROBE_CLEANUP_FAILED" });
        });
      });
      return child;
    }) as typeof spawn;
    const launch = probeLaunch({ ...options, home, assertCurrent, launch: ownedLaunch });
    return { home, launch, assertCurrent, assertSourceCurrent, dispose: () => {
      cleanupRequested = true;
      if (children.size) throw new NativeConnectionError("cleanup_failed");
      return remove();
    } };
  } catch (error) {
    if (home) await rm(home, { recursive: true, force: true });
    throw error;
  }
}

/** Call only after the owned process tree has stopped; native scratch may have mode 000. */
async function removeOwnedProbeDirectory(root: Identity): Promise<void> {
  const named = lstatSync(root.path);
  if (!root.info || !named.isDirectory() || named.uid !== root.info.uid || named.dev !== root.info.dev
    || named.ino !== root.info.ino || realpathSync(root.path) !== root.path) throw invalid();
  const remove = async (path: string): Promise<void> => {
    const before = await lstat(path);
    if (before.uid !== process.getuid?.()) throw invalid();
    if (!before.isDirectory()) { await unlink(path); return; }
    // Node's lchmod opens directories for writing and fails with EISDIR on macOS.
    if ((before.mode & 0o700) !== 0o700) await promisify(execFile)("/bin/chmod", ["-h", "700", path],
      { env: {}, timeout: 1000, maxBuffer: 1024 });
    const current = await lstat(path);
    if (!current.isDirectory() || current.dev !== before.dev || current.ino !== before.ino) throw invalid();
    for (const name of await readdir(path)) await remove(join(path, name));
    await rmdir(path);
  };
  await remove(root.path);
}

function credentialSlots(configuration: string): string[] {
  const slots = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32) throw invalid();
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "oauth") { visit(child, depth + 1); continue; }
      if (!child || typeof child !== "object" || Array.isArray(child)) throw invalid();
      const reference = child as Record<string, unknown>;
      if (reference.storage !== "file" || typeof reference.key !== "string") throw invalid();
      const name = reference.key.replace(/^oauth\//, "");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) throw invalid();
      slots.add(name);
      if (slots.size > 64) throw invalid();
    }
  };
  try { visit(parse(configuration), 0); } catch { throw invalid(); }
  return [...slots];
}

function identity(path: string, directory: boolean, missing = false): Identity {
  let info: Stats;
  try { info = lstatSync(path); }
  catch (error) {
    if (missing && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { path, directory };
    throw invalid();
  }
  if (realpathSync(path) !== path || (directory ? !info.isDirectory() : !info.isFile())
    || (!directory && info.nlink !== 1) || info.uid !== process.getuid?.() || (info.mode & 0o022)) throw invalid();
  return { path, directory, info };
}
function assertIdentity(target: Identity): void {
  const next = identity(target.path, target.directory, target.info === undefined).info, before = target.info;
  if (!before || !next) { if (before !== next) throw invalid(); return; }
  if (next.dev !== before.dev || next.ino !== before.ino || (!target.directory
    && (next.size !== before.size || next.mtimeMs !== before.mtimeMs || next.ctimeMs !== before.ctimeMs))) throw invalid();
}

function probeLaunch(options: Options & { readonly home: string; readonly assertCurrent: () => void }): typeof spawn {
  const executable = identity(options.executable, false), operation = identity(realpathSync(options.operationRoot), true);
  const systems = ["/bin", "/sbin", "/usr/bin", "/usr/lib", "/usr/share", "/System/Library"];
  const readable = [operation.path, options.home, ...systems];
  const parents = new Set<string>();
  for (const root of readable) for (let path = dirname(root); ; path = dirname(path)) {
    parents.add(path); if (dirname(path) === path) break;
  }
  const subpaths = (paths: readonly string[]) => paths.map(path => `(subpath ${JSON.stringify(path)})`).join(" ");
  const literals = (paths: readonly string[]) => paths.map(path => `(literal ${JSON.stringify(path)})`).join(" ");
  const profile = ["(version 1)", "(deny default)", "(deny network*)", "(allow process-exec)", "(allow process-fork)",
    "(allow signal (target self))", "(allow sysctl-read)",
    `(allow file-read-metadata ${literals([...parents])})`,
    '(allow file-read-data (literal "/"))',
    `(allow file-read* ${subpaths(readable)} ${literals([executable.path, "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"])})`,
    `(allow file-write* ${subpaths([operation.path, ...dataDirectories.map(name => join(options.home, name))])} (literal "/dev/null"))`,
  ].join("\n");
  return ((file: string, args: readonly string[], settings: SpawnOptions) => {
    options.assertCurrent(); assertIdentity(executable); assertIdentity(operation);
    if (file !== options.executable || args.length !== 1 || args[0] !== "acp" || settings.shell
      || typeof settings.cwd !== "string" || realpathSync(settings.cwd) !== operation.path) throw invalid();
    return (options.launch ?? spawn)("/usr/bin/sandbox-exec", ["-p", profile, executable.path, ...args], { ...settings, shell: false });
  }) as typeof spawn;
}
