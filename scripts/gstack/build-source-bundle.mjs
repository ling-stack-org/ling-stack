import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundledSkillSource } from "../../packages/core/dist/bundled-skill-source.js";
import { managedResourceWrite, resourceCheckpoint, resourceTreeBytes } from "./resource-workspace.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(scriptRoot, "upstream-lock.json"), "utf8"));
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function buildGstackSourceBundle({ sourcePath, outputPath, bunCommand = "bun" }) {
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== lock.revision || git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error("gstack_source_revision_or_worktree_mismatch");
  }
  if ((await readFile(join(source, "VERSION"), "utf8")).trim() !== lock.version ||
    JSON.parse(await readFile(join(source, "package.json"), "utf8")).version !== lock.packageVersion) {
    throw new Error("gstack_source_version_mismatch");
  }
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: source, encoding: "utf8" }).split("\0").filter(Boolean);
  const ids = tracked.filter((path) => /^[^/]+\/SKILL\.md\.tmpl$/.test(path)).map((path) => path.split("/")[0]).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...lock.skillIds].sort())) throw new Error("gstack_template_inventory_mismatch");
  const bunVersion = execFileSync(bunCommand, ["--version"], { encoding: "utf8" }).trim();
  const numbers = (value) => value.split(".").slice(0, 3).reduce((result, part) => result * 1000 + Number(part), 0);
  if (!/^\d+\.\d+\.\d+$/.test(bunVersion) || numbers(bunVersion) < numbers(lock.minimumBunVersion)) {
    throw new Error(`gstack_build_requires_bun_${lock.minimumBunVersion}`);
  }
  if (await lstat(output).then(() => true, () => false)) throw new Error("gstack_output_already_exists");
  const lease = await managedResourceWrite(output, { kind: "source", additionalBytes: (await resourceTreeBytes(source)) * 3 + 256 * 1024 ** 2 });
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), ".gstack-source-stage-"));
  try {
    const env = sourceBuildEnvironment({ staging, cachePath: join(lease.root, "cache/bun") });
    for (const path of [env.HOME, env.TMPDIR, env.GSTACK_HOME, env.GSTACK_PLAN_DIR, env.BUN_INSTALL_CACHE_DIR]) {
      await mkdir(path, { recursive: true });
    }
    const renderRoot = join(staging, "render");
    const generation = JSON.parse(execFileSync(bunCommand, ["--no-env-file", "--no-install", join(scriptRoot, "render-upstream.ts"), source, renderRoot], {
      cwd: staging, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, env,
    }));
    const bundleRoot = join(staging, "bundle");
    await mkdir(bundleRoot);
    const sourceAliases = [];
    // Include complete tracked source: bin/gstack-model-benchmark imports test/helpers.
    // Do not infer runtime exclusion from a directory's name; only exclude host/CI metadata.
    for (const path of tracked) {
      if (/^(?:\.github|\.claude-plugin|\.cursor-plugin)\//.test(path) ||
        /^\.(?:gitignore|gitattributes|env)(?:\.|$)/.test(path)) continue;
      const stat = await lstat(join(source, path));
      if (stat.isSymbolicLink()) {
        const target = relative(await realpath(source), await realpath(join(source, path)));
        if (!target || isAbsolute(target) || target.startsWith("..")) throw new Error(`gstack_source_alias_escape:${path}`);
        sourceAliases.push({ path, target });
        continue;
      }
      if (!stat.isFile()) throw new Error(`gstack_source_unsupported_file:${path}`);
      await mkdir(dirname(join(bundleRoot, "runtime", path)), { recursive: true });
      await copyFile(join(source, path), join(bundleRoot, "runtime", path));
    }
    const renderedSkills = new Set();
    for (const artifact of generation.artifacts) {
      if (artifact.host === "ling" && artifact.relativePath.startsWith(".ling/skills/")) {
        const [installedName, ...suffix] = artifact.relativePath.slice(".ling/skills/".length).split("/");
        const skillId = ids.find((id) => installedName === (id.startsWith("gstack-") ? id : `gstack-${id}`));
        // The root gstack router is infrastructure, in addition to the 57 specialist templates.
        if ((!skillId && installedName !== "gstack") || !suffix.length) throw new Error(`gstack_unknown_generated_identity:${artifact.relativePath}`);
        const path = skillId ? [skillId, ...suffix].join("/") : suffix.join("/");
        await mkdir(dirname(join(bundleRoot, "runtime", path)), { recursive: true });
        await copyFile(join(renderRoot, artifact.relativePath), join(bundleRoot, "runtime", path));
        if (skillId && suffix.join("/") === "SKILL.md") renderedSkills.add(skillId);
      } else if (!artifact.host) {
        await mkdir(dirname(join(bundleRoot, "runtime", artifact.relativePath)), { recursive: true });
        await copyFile(join(renderRoot, artifact.relativePath), join(bundleRoot, "runtime", artifact.relativePath));
      }
    }
    if (renderedSkills.size !== ids.length || ids.some((id) => !renderedSkills.has(id))) {
      throw new Error("gstack_rendered_inventory_mismatch");
    }
    // Materialize upstream aliases after rendering so aliases cannot retain old host content.
    for (const alias of sourceAliases) {
      await cp(join(bundleRoot, "runtime", alias.target), join(bundleRoot, "runtime", alias.path), { recursive: true, errorOnExist: true, force: false });
    }
    await copyFile(join(source, "LICENSE"), join(bundleRoot, "LICENSE"));
    const files = [];
    for (const path of await listFiles(bundleRoot)) {
      const bytes = await readFile(join(bundleRoot, path));
      files.push({ path, checksum: sha(bytes), sizeBytes: bytes.length });
    }
    const adaptationInput = Buffer.concat(await Promise.all(["render-upstream.ts", "build-source-bundle.mjs", "upstream-lock.json"].map((path) => readFile(join(scriptRoot, path)))));
    const manifest = {
      schemaVersion: 1, packId: "gstack-default", deliveryStage: "source",
      upstream: { repository: lock.repository, revision: lock.revision, version: lock.version },
      adaptationRevision: `ling-${createHash("sha256").update(adaptationInput).digest("hex")}`,
      licensePath: "LICENSE",
      skills: ids.map((id) => ({ id, entryPath: `runtime/${id}/SKILL.md`, resourcePaths: files.map((file) => file.path).filter((path) => path.startsWith(`runtime/${id}/`) && path !== `runtime/${id}/SKILL.md`) })),
      files,
    };
    await writeFile(join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const verified = await verifyBundledSkillSource({ rootPath: bundleRoot, expectedUpstreamRevision: lock.revision, expectedSkillIds: ids });
    for (const id of ids) {
      const { markdown } = await verified.readSkill(id);
      if (!markdown.length || /\{\{[A-Z_]+(?::[^}]*)?\}\}/.test(markdown)) throw new Error(`gstack_unrendered_skill:${id}`);
    }
    await resourceCheckpoint(lease.root);
    await rename(bundleRoot, output);
    return { manifestChecksum: verified.manifestChecksum, skillCount: ids.length, fileCount: files.length, deliveryStage: "source", upstreamRevision: lock.revision };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function sourceBuildEnvironment({ staging, cachePath, inherited = process.env }) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) {
    if (inherited[key]) env[key] = inherited[key];
  }
  const home = join(staging, "home");
  const temporary = join(staging, "tmp");
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    GSTACK_HOME: join(staging, "state"), GSTACK_PLAN_DIR: join(staging, "plans"),
    BUN_INSTALL_CACHE_DIR: cachePath ?? join(staging, "bun-cache"), CI: "1" };
}

async function listFiles(root, prefix = "") {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await listFiles(root, path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`gstack_bundle_unsupported_file:${relative(root, path)}`);
  }
  return paths.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourcePath, outputPath, bunCommand] = process.argv.slice(2);
  if (!sourcePath || !outputPath) throw new Error("Usage: build-source-bundle.mjs <pinned-source> <new-output> [bun]");
  process.stdout.write(`${JSON.stringify(await buildGstackSourceBundle({ sourcePath, outputPath, bunCommand }), null, 2)}\n`);
}
