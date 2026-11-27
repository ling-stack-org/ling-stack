import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { classifySkillSourceWarnings, parseSkillFrontMatter, resolveUserConfigPaths } from "@ling-stack/core";
import JSZip from "jszip";
import { HttpError } from "../../errors.js";
import { downloadPluginBytes } from "../plugins/plugin-download.js";

const upstream = {
  revision: "22f0b463e7a5e579904dd6211a520321035526f7",
  version: "7.0.2",
  archiveBytes: 700239,
  archiveChecksum: "211294b8df6ce0362068fd9e783fb9e8418721124fd7855ffe4067c9e802cb9b",
};
export const superpowersDownloadBytes = upstream.archiveBytes;
const skillName = /^[a-z][a-z0-9-]{0,63}$/u;
const referenceName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.md$/u;
const maxMarkdownBytes = 256 * 1024;
const maxPackBytes = 8 * 1024 * 1024;

export interface InstructionSkill {
  readonly name: string;
  readonly markdown: string;
  readonly references: readonly { readonly path: string; readonly markdown: string }[];
}
export interface InstructionPack {
  readonly kind: "instructions";
  readonly version: string;
  readonly checksum: string;
  readonly skillCount: number;
}

export function inspectInstructionSkill(skill: InstructionSkill) {
  const { frontMatter, warnings: metadataWarnings } = parseSkillFrontMatter(skill.markdown);
  const warnings = [...metadataWarnings, ...classifySkillSourceWarnings(
    skill.markdown, Buffer.byteLength(skill.markdown), maxMarkdownBytes,
  )];
  for (const { path, markdown } of skill.references) {
    for (const warning of classifySkillSourceWarnings(markdown, Buffer.byteLength(markdown), maxMarkdownBytes)) {
      warnings.push({ ...warning, location: path });
    }
  }
  if (warnings.some(warning => warning.severity === "error")) {
    throw new HttpError(409, "skill_pack_source_risky", "A skill or reference contains a blocked source pattern.");
  }
  if (!frontMatter.name || !frontMatter.description) {
    throw new HttpError(409, "skill_pack_missing_metadata", "A skill in the pack is missing its name or description.");
  }
  return { frontMatter, warnings };
}

export function packDigest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readSkillPackFile(path: string, maximum = maxMarkdownBytes): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== path || before.size > maximum) {
    throw invalidSource();
  }
  const file = await open(path, "r");
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw invalidSource();
    const buffer = Buffer.alloc(opened.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (bytesRead !== buffer.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw invalidSource();
    }
    return buffer;
  } finally {
    await file.close();
  }
}

const invalidSource = () => new HttpError(400, "skill_pack_source_invalid", "Choose a compatible skill pack directory with complete, regular files.");

export async function selectedSkillPackDirectory(value: string): Promise<string> {
  if (!isAbsolute(value) || value.includes("\0")) throw invalidSource();
  const path = await realpath(resolve(value));
  if (!(await lstat(path)).isDirectory()) throw invalidSource();
  return path;
}

/** Normalize Agent Skills directories to an immutable, text-only snapshot. */
export async function readInstructionSkills(directory: string): Promise<InstructionSkill[]> {
  const root = await selectedSkillPackDirectory(directory);
  const nested = join(root, "skills");
  const nestedInfo = await lstat(nested).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (nestedInfo?.isSymbolicLink()) throw invalidSource();
  const skillsRoot = nestedInfo?.isDirectory() ? nested : root;
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  if (entries.length > 512) throw invalidSource();
  const skills: InstructionSkill[] = [];
  let bytes = 0;
  const read = async (path: string): Promise<string> => {
    const content = await readSkillPackFile(path);
    bytes += content.length;
    if (bytes > maxPackBytes) throw invalidSource();
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  };
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!entry.isDirectory() || !skillName.test(entry.name)) continue;
    const path = join(skillsRoot, entry.name);
    const files = await readdir(path, { withFileTypes: true });
    const main = files.find(file => file.name === "SKILL.md");
    if (!main) continue;
    if (!main.isFile() || skills.length >= 100 || files.length > 128) throw invalidSource();
    const markdown = await read(join(path, main.name));
    const references: InstructionSkill["references"][number][] = [];
    const addReferences = async (directory: string, prefix: string, files: typeof entries) => {
      for (const file of files.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        if (!referenceName.test(file.name) || file.name === "SKILL.md") continue;
        if (!file.isFile() || references.length >= 32) throw invalidSource();
        references.push({ path: prefix + file.name, markdown: await read(join(directory, file.name)) });
      }
    };
    await addReferences(path, "", files);
    const refDir = files.find(file => file.name === "references");
    if (refDir?.isSymbolicLink()) throw invalidSource();
    if (refDir?.isDirectory()) await addReferences(join(path, "references"), "references/", await readdir(join(path, "references"), { withFileTypes: true }));
    skills.push({ name: entry.name, markdown, references });
  }
  if (!skills.length) throw invalidSource();
  return skills;
}

export async function downloadSuperpowersSkills(): Promise<{ version: string; skills: InstructionSkill[] }> {
  const archive = await downloadPluginBytes({ url: `https://codeload.github.com/obra/superpowers/zip/${upstream.revision}`,
    maxBytes: upstream.archiveBytes, timeoutMs: 30_000, label: "Superpowers" });
  if (archive.length !== upstream.archiveBytes || packDigest(archive) !== upstream.archiveChecksum) {
    throw new HttpError(409, "skill_pack_digest_mismatch", "The downloaded Superpowers release failed verification.");
  }
  const zip = await JSZip.loadAsync(archive);
  const files = new Map<string, InstructionSkill>();
  const prefix = `superpowers-${upstream.revision}/skills/`;
  for (const entry of Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.dir || !entry.name.startsWith(prefix)) continue;
    const relative = entry.name.slice(prefix.length);
    const [name, ...parts] = relative.split("/");
    if (!skillName.test(name!) || !referenceName.test(basename(relative)) || parts.length > 2
      || (parts.length === 2 && parts[0] !== "references")) continue;
    if (entry.name !== entry.unsafeOriginalName) throw invalidSource();
    const skill = files.get(name!) ?? { name: name!, markdown: "", references: [] };
    const text = await entry.async("string");
    files.set(name!, parts[0] === "SKILL.md" ? { ...skill, markdown: text }
      : { ...skill, references: [...skill.references, { path: parts.join("/"), markdown: text }] });
  }
  return { version: upstream.version, skills: [...files.values()].filter(skill => skill.markdown) };
}

function sourcePath(checksum: string): string {
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw invalidSource();
  return join(resolveUserConfigPaths().sourcesDir, "skill-packs", "superpowers", checksum);
}

export async function retainInstructionPack(skills: readonly InstructionSkill[], version?: string): Promise<InstructionPack> {
  for (const skill of skills) inspectInstructionSkill(skill);
  const raw = JSON.stringify(skills);
  if (Buffer.byteLength(raw) > maxPackBytes || !skills.length) throw invalidSource();
  const checksum = packDigest(raw);
  const path = sourcePath(checksum), parent = resolve(path, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw invalidSource();
  const staging = await mkdtemp(join(parent, ".prepare-"));
  try {
    await writeFile(join(staging, "skills.json"), raw, { flag: "wx", mode: 0o600 });
    try { await rename(staging, path); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await readRetainedInstructionPack(checksum);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { kind: "instructions", checksum, skillCount: skills.length, version: version ?? `local-${checksum.slice(0, 12)}` };
}

export async function readRetainedInstructionPack(checksum: string): Promise<readonly InstructionSkill[]> {
  const bytes = await readSkillPackFile(join(sourcePath(checksum), "skills.json"), maxPackBytes);
  if (packDigest(bytes) !== checksum) throw new HttpError(409, "skill_pack_digest_mismatch", "The saved skill pack failed verification.");
  return JSON.parse(bytes.toString("utf8")) as InstructionSkill[];
}
