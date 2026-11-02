import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_FILES = 100_000;
const MAX_PREFLIGHT_FILES = 8;

export interface BundledSkillFile {
  readonly path: string;
  readonly checksum: string;
  readonly sizeBytes: number;
}

export interface BundledSkillEntry {
  readonly id: string;
  readonly entryPath: string;
  readonly resourcePaths: readonly string[];
}

export interface BundledSkillManifest {
  readonly schemaVersion: 1;
  readonly packId: "gstack-default";
  readonly deliveryStage: "source" | "executable";
  readonly upstream: {
    readonly repository: "https://github.com/garrytan/gstack";
    readonly revision: string;
    readonly version: string;
  };
  readonly adaptationRevision: string;
  readonly target?: { readonly platform: "darwin" | "win32"; readonly arch: "arm64" | "x64" };
  readonly licensePath: string;
  readonly skills: readonly BundledSkillEntry[];
  readonly files: readonly BundledSkillFile[];
}

export interface VerifiedBundledSkillSource {
  readonly manifest: BundledSkillManifest;
  readonly manifestChecksum: string;
  readonly readSkill: (skillId: string) => Promise<{ readonly markdown: string; readonly sourceChecksum: string }>;
  readonly readResource: (path: string) => Promise<string>;
}

export class BundledSkillSourceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "BundledSkillSourceError";
  }
}

export async function verifyBundledSkillSource(input: {
  readonly rootPath: string;
  readonly expectedUpstreamRevision: string;
  readonly expectedAdaptationRevision?: string;
  readonly expectedManifestChecksum?: string;
  readonly expectedTarget?: BundledSkillManifest["target"];
  readonly expectedSkillIds: readonly string[];
  readonly requireExecutable?: boolean;
}): Promise<VerifiedBundledSkillSource> {
  const requestedRoot = resolve(input.rootPath);
  const root = await lstat(requestedRoot).catch(() => fail("bundle_root_missing"));
  if (!root.isDirectory() || root.isSymbolicLink()) {
    fail("bundle_root_invalid");
  }
  const rootPath = await realpath(requestedRoot);
  const manifestStat = await lstat(join(rootPath, "manifest.json")).catch(() => fail("bundle_manifest_missing"));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
    fail("bundle_manifest_invalid");
  }
  const manifestBytes = await readFile(join(rootPath, "manifest.json"));
  if (manifestBytes.length !== manifestStat.size || manifestBytes.length > MAX_MANIFEST_BYTES) {
    fail("bundle_manifest_invalid");
  }
  const manifestChecksum = checksum(manifestBytes);
  if (input.expectedManifestChecksum && manifestChecksum !== input.expectedManifestChecksum) {
    fail("bundle_manifest_checksum_mismatch");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("bundle_manifest_invalid"); }
  const manifest = parseManifest(parsed);
  if (manifest.upstream.revision !== input.expectedUpstreamRevision) fail("bundle_revision_mismatch");
  if (input.expectedAdaptationRevision && manifest.adaptationRevision !== input.expectedAdaptationRevision) {
    fail("bundle_adaptation_mismatch");
  }
  if (input.requireExecutable && manifest.deliveryStage !== "executable") fail("bundle_not_executable");
  if (input.requireExecutable && (!input.expectedAdaptationRevision || !input.expectedManifestChecksum || !input.expectedTarget)) {
    fail("bundle_runtime_identity_unpinned");
  }
  if (input.expectedTarget && (manifest.target?.platform !== input.expectedTarget.platform || manifest.target?.arch !== input.expectedTarget.arch)) {
    fail("bundle_target_mismatch");
  }
  const expectedIds = new Set(input.expectedSkillIds);
  if (!expectedIds.size || expectedIds.size !== input.expectedSkillIds.length ||
    manifest.skills.length !== expectedIds.size || manifest.skills.some((skill) => !expectedIds.has(skill.id))) {
    fail("bundle_skill_inventory_mismatch");
  }

  const files = new Map(manifest.files.map((file) => [file.path, file]));
  const skills = new Map(manifest.skills.map((skill) => [skill.id, skill]));
  const portableFilePaths = new Set(manifest.files.map((file) => file.path.toLowerCase()));
  if (files.size !== manifest.files.length || portableFilePaths.size !== manifest.files.length ||
    skills.size !== manifest.skills.length) fail("bundle_duplicate_identity");
  if (!files.has(manifest.licensePath)) fail("bundle_license_missing");
  for (const skill of manifest.skills) {
    for (const path of [skill.entryPath, ...skill.resourcePaths]) {
      if (!files.has(path)) fail("bundle_resource_not_in_manifest");
    }
  }
  const actualFiles = await inventoryFiles(rootPath);
  if (actualFiles.length !== files.size || actualFiles.some((path) => !files.has(path))) {
    fail("bundle_file_inventory_mismatch");
  }
  const verifyFile = async (path: string, retainBytes: boolean): Promise<Buffer | undefined> => {
    const file = files.get(path);
    if (!file) fail("bundle_resource_not_in_manifest");
    const absolute = join(rootPath, file.path);
    const stat = await lstat(absolute).catch(() => fail("bundle_resource_missing"));
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) fail("bundle_resource_path_invalid");
    if (stat.size !== file.sizeBytes) fail("bundle_resource_checksum_mismatch");
    const handle = await open(absolute, "r").catch(() => fail("bundle_resource_missing"));
    let stream: ReturnType<typeof handle.createReadStream> | undefined;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
        await realpath(absolute) !== absolute) fail("bundle_resource_path_invalid");
      if (opened.size !== file.sizeBytes) fail("bundle_resource_checksum_mismatch");
      const hash = createHash("sha256");
      const chunks: Buffer[] | undefined = retainBytes ? [] : undefined;
      let size = 0;
      stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
      for await (const bytes of stream) {
        size += bytes.length;
        if (size > file.sizeBytes) fail("bundle_resource_checksum_mismatch");
        hash.update(bytes);
        chunks?.push(bytes);
      }
      const after = await handle.stat();
      if (size !== file.sizeBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs || `sha256:${hash.digest("hex")}` !== file.checksum) {
        fail("bundle_resource_checksum_mismatch");
      }
      return chunks ? Buffer.concat(chunks, size) : undefined;
    } finally {
      stream?.destroy();
      await handle.close();
    }
  };
  // Bound descriptors and streaming buffers while hashing the complete inventory.
  // On failure, stop admitting files and drain every in-flight handle before
  // rejecting; Promise.all over the entire manifest would be unbounded and
  // fail-fast publication could leave sibling reads running after rejection.
  let nextFile = 0;
  let failed = false;
  let failure: unknown;
  const preflight = async (): Promise<void> => {
    while (!failed) {
      const file = manifest.files[nextFile++];
      if (!file) return;
      try { await verifyFile(file.path, false); }
      catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PREFLIGHT_FILES, manifest.files.length) }, preflight));
  if (failed) throw failure;
  const readVerifiedFile = async (path: string): Promise<Buffer> => (await verifyFile(path, true))!;
  // Validate once before publishing, then revalidate lazy reads against the frozen manifest.
  return Object.freeze({
    manifest: freezeManifest(manifest),
    manifestChecksum,
    async readSkill(skillId: string) {
      const skill = skills.get(skillId);
      if (!skill) fail("bundle_skill_not_found");
      return { markdown: (await readVerifiedFile(skill.entryPath)).toString("utf8"), sourceChecksum: files.get(skill.entryPath)!.checksum };
    },
    async readResource(path: string) { return (await readVerifiedFile(path)).toString("utf8"); },
  });
}

function parseManifest(value: unknown): BundledSkillManifest {
  const raw = record(value);
  const upstream = record(raw.upstream);
  if (raw.schemaVersion !== 1 || raw.packId !== "gstack-default" ||
    !["source", "executable"].includes(String(raw.deliveryStage)) ||
    upstream.repository !== "https://github.com/garrytan/gstack" ||
    typeof upstream.revision !== "string" || !/^[a-f0-9]{40}$/.test(upstream.revision) ||
    typeof upstream.version !== "string" || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(upstream.version) ||
    typeof raw.adaptationRevision !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(raw.adaptationRevision) ||
    !Array.isArray(raw.files) || !raw.files.length || raw.files.length > MAX_MANIFEST_FILES ||
    !Array.isArray(raw.skills) || !raw.skills.length || raw.skills.length > MAX_MANIFEST_FILES) {
    fail("bundle_manifest_invalid");
  }
  const files = raw.files.map((value): BundledSkillFile => {
    const file = record(value);
    if (typeof file.checksum !== "string" || !/^sha256:[a-f0-9]{64}$/.test(file.checksum) ||
      !Number.isSafeInteger(file.sizeBytes) || (file.sizeBytes as number) < 0) fail("bundle_manifest_invalid");
    return { path: logicalPath(file.path), checksum: file.checksum, sizeBytes: file.sizeBytes as number };
  });
  const skills = raw.skills.map((value): BundledSkillEntry => {
    const skill = record(value);
    if (typeof skill.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(skill.id) || !Array.isArray(skill.resourcePaths)) {
      fail("bundle_manifest_invalid");
    }
    return { id: skill.id, entryPath: logicalPath(skill.entryPath), resourcePaths: skill.resourcePaths.map(logicalPath) };
  });
  let target: BundledSkillManifest["target"];
  if (raw.target !== undefined) {
    const value = record(raw.target);
    if (!["darwin", "win32"].includes(String(value.platform)) || !["arm64", "x64"].includes(String(value.arch))) {
      fail("bundle_manifest_invalid");
    }
    target = { platform: value.platform as "darwin" | "win32", arch: value.arch as "arm64" | "x64" };
  }
  if (raw.deliveryStage === "executable" && !target) fail("bundle_target_missing");
  return {
    schemaVersion: 1, packId: "gstack-default", deliveryStage: raw.deliveryStage as "source" | "executable",
    upstream: { repository: "https://github.com/garrytan/gstack", revision: upstream.revision, version: upstream.version },
    adaptationRevision: raw.adaptationRevision, target, licensePath: logicalPath(raw.licensePath), skills, files,
  };
}

async function inventoryFiles(root: string, prefix = ""): Promise<string[]> {
  const paths: string[] = [];
  async function walk(prefix: string): Promise<void> {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail("bundle_resource_path_invalid");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path !== "manifest.json") {
        paths.push(path);
        if (paths.length > MAX_MANIFEST_FILES) fail("bundle_file_inventory_mismatch");
      } else if (!entry.isFile()) fail("bundle_resource_path_invalid");
    }
  }
  await walk(prefix);
  return paths;
}

function logicalPath(value: unknown): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\") ||
    /[\x00-\x1f\x7f:]/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..") ||
    value.toLowerCase() === "manifest.json") fail("bundle_resource_path_invalid");
  if (value.split("/").some((part) => /[<>"|?*]/.test(part) || /[ .]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail("bundle_resource_path_invalid");
  return value;
}

function freezeManifest(manifest: BundledSkillManifest): BundledSkillManifest {
  Object.freeze(manifest.upstream);
  if (manifest.target) Object.freeze(manifest.target);
  for (const file of manifest.files) Object.freeze(file);
  for (const skill of manifest.skills) { Object.freeze(skill.resourcePaths); Object.freeze(skill); }
  Object.freeze(manifest.files);
  Object.freeze(manifest.skills);
  return Object.freeze(manifest);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("bundle_manifest_invalid");
  return value as Record<string, unknown>;
}

function checksum(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function fail(code: string): never { throw new BundledSkillSourceError(code); }
