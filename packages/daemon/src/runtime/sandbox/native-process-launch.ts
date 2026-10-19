import { spawn, type SpawnOptions } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PlatformNativeProcessInput {
  readonly executable: string;
  readonly workspaceRoot: string;
  readonly operationRoot: string;
  readonly nativeHome: string;
  /** Only Kimi's fixed data directories, never the mutable account configuration. */
  readonly persistentKimiHome?: string;
  /** Trusted delegated command cwd; ordinary agent processes still start in operationRoot. */
  readonly terminalCwd?: string;
  /** One host-owned inference endpoint; never available to a delegated terminal. */
  readonly modelRelayPort?: number;
  readonly policyProfileId: "read_only" | "workspace_write";
  readonly allowedWritePaths: readonly string[];
}
const invalid = (): Error => new Error("native_process_boundary_invalid");
const enforcer = "/usr/bin/sandbox-exec";

/** An enforced launch wrapper; the optional model endpoint does not grant tool networking. */
export async function preparePlatformNativeProcessLaunch(input: PlatformNativeProcessInput, launch: typeof spawn = spawn): Promise<typeof spawn> {
  if (process.platform !== "darwin") throw new Error("native_process_boundary_unsupported");
  if (!["read_only", "workspace_write"].includes(input.policyProfileId) || !Array.isArray(input.allowedWritePaths)
    || input.allowedWritePaths.length > 64) throw invalid();
  const requested = structuredClone(input);
  if (requested.modelRelayPort !== undefined && (!Number.isSafeInteger(requested.modelRelayPort)
    || requested.modelRelayPort < 1 || requested.modelRelayPort > 65535 || requested.terminalCwd !== undefined)) throw invalid();
  const executable = existing(requested.executable, false);
  const workspace = existing(requested.workspaceRoot, true);
  const operation = existing(requested.operationRoot, true);
  const home = existing(requested.nativeHome, true);
  const persistent = requested.persistentKimiHome ? existing(requested.persistentKimiHome, true) : undefined;
  const terminalCwd = requested.terminalCwd ? existing(requested.terminalCwd, true) : undefined;
  if (terminalCwd && (!inside(workspace.path, terminalCwd.path)
    || relative(workspace.path, terminalCwd.path).split(sep).includes(".ling-stack") || persistent)) throw invalid();
  const launchCwd = terminalCwd?.path ?? operation.path;
  const roots = [workspace, operation, home, ...(persistent ? [persistent] : [])];
  if (roots.some((a, index) => roots.slice(index + 1).some(b => inside(a.path, b.path) || inside(b.path, a.path)))) throw invalid();
  const names = ["sessions", "store", "cache", "logs", "blobs"];
  const bindings = persistent ? names.map(name => {
    const path = join(persistent.path, name), target = existing(path, true);
    if (target.path !== path || !lstatSync(join(home.path, name)).isSymbolicLink()
      || realpathSync(join(home.path, name)) !== path) throw invalid();
    return target;
  }) : [];
  const dataPaths = names.map(name => join(persistent?.path ?? home.path, name));
  // Keep Kimi 2.2's cwd catalog and legacy append index in this projection.
  // Explicit session/load recreates the requested cwd catalog and scans shared
  // sessions by ID; discarding these views does not preserve workspace discovery.
  const workspaceIndex = join(home.path, "workspaces.json");
  const legacySessionIndex = join(home.path, "session_index.jsonl");
  // Seatbelt lacks bounded repetition; constrain the filename to the home's
  // exact path depth, and bind the dynamic root with a literal subpath filter.
  const temporaryIndex = `^${"/[^/]+".repeat(home.path.split(sep).length - 1)}/workspaces[.]json[.]tmp[.][1-9][0-9]*[.]${"[a-f0-9]".repeat(8)}$`;
  const metadata = `(require-any (literal ${quoted(workspaceIndex)}) (literal ${quoted(legacySessionIndex)}) (require-all (subpath ${quoted(home.path)}) (regex #${quoted(temporaryIndex)})))`;
  const writes = requested.allowedWritePaths.map(path => resolveWriteRoot(path, workspace.path));
  const profile = [
    "(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)",
    "(allow signal (target self))", "(allow sysctl-read)", "(deny network*)",
    ...(requested.modelRelayPort === undefined ? [] : [
      // tcp4 excludes another service bound to ::1 on the same port.
      `(allow network-outbound (remote tcp4 ${quoted(`localhost:${requested.modelRelayPort}`)}))`,
    ]),
    "(allow file-read-metadata)",
    // dyld inspects the root directory; this literal does not allow reading its descendants.
    '(allow file-read-data (literal "/"))',
    rule("allow", "file-read*", [workspace.path, operation.path, home.path, ...bindings.map(target => target.path),
      "/bin", "/sbin", "/usr/bin", "/usr/lib", "/usr/share", "/System"]),
    `(allow file-read* (literal ${quoted(executable.path)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))`,
    '(allow file-write* (literal "/dev/null"))',
    rule("allow", "file-write*", [operation.path, ...dataPaths,
      ...(requested.policyProfileId === "workspace_write" ? writes : [])]),
    ...(persistent ? [`(allow file-write* ${metadata})`] : []),
    `(deny file-read* file-write* (regex #${quoted(`^${escapePattern(workspace.path)}(/[^/]+)*/[.]ling-stack(/|$)`)}))`,
    rule("deny", "file-write*", [join(home.path, "config.toml")]),
    rule("deny", "file-read* file-write*", [join(home.path, "credentials"), ...(persistent ? [join(persistent.path, "credentials")] : [])]),
    ...(persistent ? [
      `(deny file-write* (require-all (subpath ${quoted(home.path)}) (require-not ${metadata})))`,
      `(deny file-write* (require-all (subpath ${quoted(persistent.path)}) (require-not (require-any ${
        dataPaths.map(path => `(subpath ${quoted(path)})`).join(" ")}))))`,
      rule("deny", "file-write*", [join(persistent.path, "config.toml")]),
    ] : []),
  ].join("\n");
  return ((file: string, args: readonly string[], options: SpawnOptions) => {
    if (file !== requested.executable || !Array.isArray(args) || args.length > 256
      || args.some(arg => typeof arg !== "string" || arg.includes("\0")) || options.shell
      || typeof options.cwd !== "string" || realpathSync(options.cwd) !== launchCwd) throw invalid();
    for (const target of [executable, ...roots, ...bindings, ...(terminalCwd ? [terminalCwd] : [])]) assertUnchanged(target);
    if (persistent && names.some((name, index) => !lstatSync(join(home.path, name)).isSymbolicLink()
      || realpathSync(join(home.path, name)) !== bindings[index]!.path)) throw invalid();
    if (requested.allowedWritePaths.some((path, index) => resolveWriteRoot(path, workspace.path) !== writes[index])) throw invalid();
    return launch(enforcer, ["-p", profile, executable.path, ...args], { ...options, cwd: launchCwd, shell: false });
  }) as typeof spawn;
}

interface Target { readonly requested: string; readonly path: string; readonly dev: number; readonly ino: number; readonly directory: boolean }
function existing(value: string, directory: boolean): Target {
  if (!localPath(value)) throw invalid();
  const path = realpathSync(value);
  const info = statSync(path);
  if (directory ? !info.isDirectory() : !info.isFile()) throw invalid();
  return { requested: value, path, dev: info.dev, ino: info.ino, directory };
}
function assertUnchanged(target: Target): void {
  const next = existing(target.requested, target.directory);
  if (next.path !== target.path || next.dev !== target.dev || next.ino !== target.ino) throw invalid();
}
function resolveWriteRoot(value: string, cwd: string): string {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("~")) throw invalid();
  const absolute = resolve(cwd, value);
  let ancestor = absolute;
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw invalid();
      ancestor = dirname(ancestor);
    }
  }
  const path = resolve(realpathSync(ancestor), relative(ancestor, absolute));
  if (path === sep) throw invalid();
  return path;
}
function localPath(value: string): boolean { return typeof value === "string" && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value); }
function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function quoted(value: string): string { return JSON.stringify(value); }
function escapePattern(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function rule(effect: "allow" | "deny", operations: string, paths: readonly string[]): string {
  return `(${effect} ${operations} ${paths.map(path => `(subpath ${quoted(path)})`).join(" ")})`;
}
