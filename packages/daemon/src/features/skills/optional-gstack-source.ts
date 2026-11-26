import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { OptionalSkillPackView } from "@ling-stack/contracts";
import { resolveUserConfigPaths, type RunStore } from "@ling-stack/core";
import { verifyBundledSkillSource, type BundledSkillManifest } from "@ling-stack/core/bundled-skill-source";
import { verifyPackagedBrowser } from "@ling-stack/core/bundled-skill-browser";
import { HttpError } from "../../errors.js";
import { loadRetainedPackagedSkillGeneration, retainPackagedSkillGeneration } from "./packaged-history.js";
import { registerPackagedSkillGeneration } from "./packaged-runtime.js";
import { readSkillPackFile, selectedSkillPackDirectory } from "./optional-pack-source.js";

export interface GstackPack {
  readonly kind: "gstack";
  readonly version: string;
  readonly checksum: string;
  readonly skillCount: number;
}

const cache = () => join(resolveUserConfigPaths().sourcesDir, "bundled-gstack");
const missing = () => new HttpError(409, "skill_pack_runtime_required", "Prepare or connect a Ling-compatible gstack runtime for this platform.");
const targetMatches = (target: BundledSkillManifest["target"]) =>
  target?.platform === process.platform && target?.arch === process.arch;
const platformMismatch = () => new HttpError(409, "skill_pack_platform_incompatible", "The gstack runtime does not match this platform.");
const suffix = process.platform === "win32" ? ".exe" : "";
const requiredTools = [`tools/node${suffix}`, `tools/bun${suffix}`, `browse/dist/browse${suffix}`];

async function hasRuntimeTools(root: string): Promise<boolean> {
  const tools = await Promise.all(requiredTools.map(async file => {
    try {
      const info = await lstat(join(root, "runtime", file));
      return info.isFile() && (process.platform !== "darwin" || Boolean(info.mode & 0o100));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }));
  return tools.every(Boolean);
}

export async function inspectGstackPack(checksum: string): Promise<OptionalSkillPackView["issue"]> {
  const root = join(cache(), checksum.slice(7));
  const bytes = await readSkillPackFile(join(root, "gstack/manifest.json"), 16 * 1024 * 1024);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== checksum) return "invalid_resources";
  const manifest = JSON.parse(bytes.toString("utf8")) as BundledSkillManifest;
  if (!targetMatches(manifest.target)) return "incompatible_platform";
  if (!await hasRuntimeTools(join(root, "gstack"))) return "missing_dependencies";
  if (!(await lstat(join(root, "gstack-browser"))).isDirectory()) return "invalid_resources";
}

export async function findRetainedGstackChecksum(store: RunStore): Promise<string | undefined> {
  const entries = await readdir(cache(), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const keys = new Set(entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name)).map(entry => `sha256:${entry.name}`));
  for (const snapshot of store.listSkillSourceSnapshots({ reviewStatus: "published" })) {
    if (snapshot.sourceKind !== "gstack-skill-directory") continue;
    const hash = snapshot.referencedFiles.find(file => file.path === "manifest.json")?.checksum;
    if (hash && keys.has(hash)) return hash;
  }
  return keys.size === 1 ? keys.values().next().value : undefined;
}

export async function openGstackPack(checksum: string) {
  const runtime = await loadRetainedPackagedSkillGeneration(cache(), checksum);
  const { manifest } = runtime.source;
  if (!targetMatches(manifest.target)) throw platformMismatch();
  return runtime;
}

export async function prepareGstackPack(store: RunStore, path?: string): Promise<GstackPack> {
  if (!path) {
    const checksum = await findRetainedGstackChecksum(store);
    if (!checksum) throw missing();
    const runtime = await openGstackPack(checksum);
    return { kind: "gstack", checksum, version: runtime.source.manifest.upstream.version, skillCount: runtime.source.manifest.skills.length };
  }
  const selected = await selectedSkillPackDirectory(path);
  const rootPath = basename(selected) === "gstack" ? selected : join(selected, "gstack");
  const browserRoot = join(dirname(rootPath), "gstack-browser");
  const bytes = await readSkillPackFile(join(rootPath, "manifest.json"), 16 * 1024 * 1024);
  const manifest = JSON.parse(bytes.toString("utf8")) as BundledSkillManifest;
  if (manifest.upstream?.repository !== "https://github.com/garrytan/gstack" || manifest.skills?.length !== 57) throw missing();
  if (!targetMatches(manifest.target)) throw platformMismatch();
  if (!await hasRuntimeTools(rootPath)) throw new HttpError(409, "skill_pack_dependency_missing", "The gstack runtime is missing Node, Bun or browse.");
  const selection = { rootPath, expectedManifestChecksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    expectedAdaptationRevision: manifest.adaptationRevision, expectedUpstreamRevision: manifest.upstream.revision,
    expectedTarget: manifest.target, expectedSkillIds: manifest.skills.map(skill => skill.id) };
  const source = await verifyBundledSkillSource({ ...selection, requireExecutable: true });
  const launch = JSON.parse(await source.readResource("executable-build.json"));
  if (launch.scope !== "isolated-local-client" || launch.upstreamRevision !== source.manifest.upstream.revision || !launch.browser) throw missing();
  verifyPackagedBrowser(browserRoot, launch.browser, manifest.target!);
  const { current } = await retainPackagedSkillGeneration(cache(), selection, browserRoot);
  if (!current) throw missing();
  registerPackagedSkillGeneration(current);
  return { kind: "gstack", checksum: current.manifestChecksum, version: source.manifest.upstream.version, skillCount: source.manifest.skills.length };
}
