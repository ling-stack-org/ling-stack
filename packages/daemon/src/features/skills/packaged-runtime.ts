import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { SkillSourceRuntimeContext } from "@ling-stack/core";
import type { VerifiedBundledSkillSource } from "@ling-stack/core/bundled-skill-source";
import type { VerifiedBundledBrowser } from "@ling-stack/core/bundled-skill-browser";
import { HttpError } from "../../errors.js";

type Binding = NonNullable<SkillSourceRuntimeContext["resourceBinding"]>;
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs", "nlink"].every(key => Reflect.get(a, key) === Reflect.get(b, key));
let activeRuntime: PackagedSkillRuntimeCatalog | undefined;

/** Constructed only after full package admission, never from task text or environment. */
export class PackagedSkillRuntime {
  readonly #root: string;
  readonly #source: VerifiedBundledSkillSource;
  readonly #facts: readonly { path: string; stat: BigIntStats }[];
  readonly #directories: readonly { path: string; stat: BigIntStats }[];
  get manifestChecksum(): string { return this.#source.manifestChecksum; }
  constructor(root: string, source: VerifiedBundledSkillSource, readonly browser?: VerifiedBundledBrowser) {
    this.#root = resolve(root); this.#source = source;
    if (realpathSync(this.#root) !== this.#root || source.manifest.deliveryStage !== "executable") throw new Error("packaged_skill_runtime_not_admitted");
    this.#facts = [...source.manifest.files, { path: "manifest.json", checksum: source.manifestChecksum }].map(({ path, checksum }) => {
      const absolute = join(this.#root, path), stat = lstatSync(absolute, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) throw new Error("packaged_skill_runtime_path_invalid");
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash("sha256"), buffer = Buffer.alloc(128 * 1024);
        if (!sameFile(stat, fstatSync(fd, { bigint: true }))) throw new Error("packaged_skill_runtime_changed");
        for (;;) {
          const count = readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          hash.update(buffer.subarray(0, count));
        }
        if (`sha256:${hash.digest("hex")}` !== checksum || !sameFile(stat, fstatSync(fd, { bigint: true }))
          || !sameFile(stat, lstatSync(absolute, { bigint: true }))) throw new Error("packaged_skill_runtime_changed");
      } finally { closeSync(fd); }
      return { path: absolute, stat };
    });
    const files = new Map(this.#facts.map(fact => [fact.path, fact.stat]));
    const directories: { path: string; stat: BigIntStats }[] = [];
    let count = 0;
    const walk = (path: string): void => {
      if (++count > 150000) throw new Error("packaged_skill_runtime_path_invalid");
      const stat = lstatSync(path, { bigint: true });
      if (realpathSync(path) !== path || stat.isSymbolicLink()) throw new Error("packaged_skill_runtime_path_invalid");
      if (stat.isDirectory()) {
        directories.push({ path, stat });
        for (const name of readdirSync(path)) walk(join(path, name));
        if (!sameFile(stat, lstatSync(path, { bigint: true }))) throw new Error("packaged_skill_runtime_changed");
      } else {
        const admitted = files.get(path);
        if (!admitted || !sameFile(stat, admitted)) throw new Error("packaged_skill_runtime_changed");
        files.delete(path);
      }
    };
    // Enumerate after file hashing so additions between source admission and
    // runtime construction cannot become an unauthenticated baseline.
    walk(this.#root);
    if (files.size) throw new Error("packaged_skill_runtime_changed");
    this.#directories = directories;
    this.assertCurrent();
  }
  restore(context: SkillSourceRuntimeContext | undefined, skillId?: string): SkillSourceRuntimeContext | undefined {
    if (context && skillId && context.skillId !== skillId) throw new Error("packaged_skill_source_resource_mismatch");
    if (skillId && this.#source.manifest.skills.some(skill => skill.id === skillId)
      && (!context || context.skillId !== skillId || context.sourceKind !== "gstack-skill-directory")) {
      throw new Error("packaged_skill_resource_binding_missing");
    }
    if (context?.sourceKind === "gstack-skill-directory" && !context.resourceBinding) throw new Error("packaged_skill_resource_binding_missing");
    return context && this.bind(context);
  }
  assertCurrent(): void {
    this.browser?.assertCurrent();
    for (const { path, stat } of this.#directories) if (realpathSync(path) !== path || !sameFile(lstatSync(path, { bigint: true }), stat)) {
      throw new Error("packaged_skill_runtime_path_changed");
    }
    for (const fact of this.#facts) {
      const stat = lstatSync(fact.path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || !sameFile(stat, fact.stat)) throw new Error("packaged_skill_runtime_changed");
    }
    if (`sha256:${createHash("sha256").update(readFileSync(join(this.#root, "manifest.json"))).digest("hex")}` !== this.#source.manifestChecksum) {
      throw new Error("packaged_skill_runtime_changed");
    }
  }
  bind(context: SkillSourceRuntimeContext): SkillSourceRuntimeContext {
    if (context.sourceKind !== "gstack-skill-directory") {
      if (context.resourceBinding) throw new Error("packaged_skill_source_resource_mismatch");
      return context;
    }
    const entry = this.#source.manifest.skills.find(skill => skill.id === context.skillId);
    const checksum = entry && this.#source.manifest.files.find(file => file.path === entry.entryPath)?.checksum;
    if (!context.loaded || context.truncated || context.sourceChecksum !== checksum || !entry) throw new Error("packaged_skill_source_resource_mismatch");
    if (!context.referencedFiles?.some(file => file.path === "manifest.json" && file.checksum === this.#source.manifestChecksum)) {
      throw new Error("packaged_skill_source_resource_identity_missing");
    }
    const resourceBinding: Binding = { manifestChecksum: this.#source.manifestChecksum,
      upstreamRevision: this.#source.manifest.upstream.revision, adaptationRevision: this.#source.manifest.adaptationRevision,
      sourceChecksum: checksum! };
    if (context.resourceBinding && !sameBinding(context.resourceBinding, resourceBinding)) throw new Error("packaged_skill_resource_version_unavailable");
    this.assertCurrent();
    return { ...context, resourceBinding };
  }
  environment(context: SkillSourceRuntimeContext, stateRoot: string, inheritedPath = ""): NodeJS.ProcessEnv {
    if (!context.resourceBinding) throw new Error("packaged_skill_resource_binding_missing");
    this.bind(context);
    if (realpathSync(stateRoot) !== stateRoot || !lstatSync(stateRoot).isDirectory()) throw new Error("packaged_skill_state_path_invalid");
    const runtime = join(this.#root, "runtime");
    const pathPrefix = [join(runtime, "tools"), join(runtime, "node_modules/.bin")].join(delimiter);
    return { GSTACK_ROOT: runtime, GSTACK_BIN: join(runtime, "bin"), LING_GSTACK_PATH_PREFIX: pathPrefix,
      GSTACK_HOME: stateRoot, GSTACK_STATE_ROOT: stateRoot, GSTACK_PLAN_DIR: join(stateRoot, "plans"),
      BROWSE_STATE_FILE: join(stateRoot, "browse.json"), CHROMIUM_PROFILE: join(stateRoot, "chromium-profile"),
      PATH: [pathPrefix, inheritedPath].filter(Boolean).join(delimiter) };
  }
}

/** Only fully admitted generations enter the catalog; task text never supplies paths. */
export class PackagedSkillRuntimeCatalog {
  readonly #generations: ReadonlyMap<string, PackagedSkillRuntime>;
  constructor(readonly current: PackagedSkillRuntime, retained: readonly PackagedSkillRuntime[] = []) {
    this.#generations = new Map([...retained, current].map(runtime => [runtime.manifestChecksum, runtime]));
  }
  #resolve(context: SkillSourceRuntimeContext): PackagedSkillRuntime {
    const key = context.resourceBinding?.manifestChecksum
      ?? context.referencedFiles?.find(file => file.path === "manifest.json")?.checksum;
    const runtime = key && this.#generations.get(key);
    if (!runtime) throw new Error("packaged_skill_resource_version_unavailable");
    return runtime;
  }
  bind(context: SkillSourceRuntimeContext): SkillSourceRuntimeContext {
    if (context.sourceKind !== "gstack-skill-directory") return this.current.bind(context);
    return this.#resolve(context).bind(context);
  }
  restore(context: SkillSourceRuntimeContext | undefined, skillId?: string): SkillSourceRuntimeContext | undefined {
    if (!context || context.sourceKind !== "gstack-skill-directory") return this.current.restore(context, skillId);
    if (!context.resourceBinding) throw new Error("packaged_skill_resource_binding_missing");
    return this.#resolve(context).restore(context, skillId);
  }
  environment(context: SkillSourceRuntimeContext, stateRoot: string, path?: string): NodeJS.ProcessEnv {
    return this.#resolve(context).environment(context, stateRoot, path);
  }
}
export function preparePackagedSkillState(workspaceRoot: string, key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key) || realpathSync(workspaceRoot) !== workspaceRoot || !lstatSync(workspaceRoot).isDirectory()) {
    throw new Error("packaged_skill_state_path_invalid");
  }
  // Check each ancestor before creating its child; recursive mkdir could follow
  // a pre-existing alias and write outside the workspace before rejection.
  let path = workspaceRoot;
  for (const name of ["gstack-runs", key]) {
    path = join(path, name);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error("packaged_skill_state_path_invalid");
  }
  return path;
}
function sameBinding(a: Binding, b: Binding) {
  return a.manifestChecksum === b.manifestChecksum && a.upstreamRevision === b.upstreamRevision
    && a.adaptationRevision === b.adaptationRevision && a.sourceChecksum === b.sourceChecksum;
}
export function installPackagedSkillRuntime(runtime: PackagedSkillRuntime, retained: readonly PackagedSkillRuntime[] = []): void {
  if (activeRuntime) throw new Error("packaged_skill_runtime_already_installed");
  activeRuntime = new PackagedSkillRuntimeCatalog(runtime, retained);
}
export function bindPackagedSkillContext(context: SkillSourceRuntimeContext): SkillSourceRuntimeContext {
  if (!activeRuntime) {
    if (context.resourceBinding) throw new Error("packaged_skill_resource_version_unavailable");
    return context;
  }
  return activeRuntime.bind(context);
}
export function restorePackagedSkillContext(context: SkillSourceRuntimeContext | undefined, skillId?: string): SkillSourceRuntimeContext | undefined {
  try {
    if (activeRuntime) return activeRuntime.restore(context, skillId);
    return context && bindPackagedSkillContext(context);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("packaged_skill_") || error.message.startsWith("bundled_browser_")
      || ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))) {
      const code = error.message.startsWith("packaged_skill_") ? error.message : "packaged_skill_resource_version_unavailable";
      throw new HttpError(409, code, "The task's authenticated skill resources are unavailable or changed; restore the matching generation before retrying.");
    }
    throw error;
  }
}
export function packagedSkillEnvironment(context: SkillSourceRuntimeContext | undefined, stateRoot: string, path?: string): NodeJS.ProcessEnv {
  if (!context) return {};
  if (!activeRuntime) {
    if (context.resourceBinding) throw new Error("packaged_skill_resource_version_unavailable");
    return {};
  }
  if (context.sourceKind !== "gstack-skill-directory") return {};
  return activeRuntime.environment(context, stateRoot, path);
}
