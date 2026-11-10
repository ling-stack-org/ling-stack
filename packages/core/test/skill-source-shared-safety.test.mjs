import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  SHARED_AGENT_SKILL_PACK_ID,
  SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS,
  previewGstackSkillSourceSync,
  resolveSharedAgentsSkillSourceRoots,
} from "../dist/index.js";

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const checksum = (markdown) => `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;

function skillMarkdown(name, description) {
  return ["---", `name: ${name}`, `description: ${description}`, "---", `# ${name}`, "Do the work."].join("\n");
}

async function writeSkill(root, directoryName, markdown) {
  const directory = join(root, directoryName);
  await mkdir(directory, { recursive: true });
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, markdown, "utf8");
  return skillPath;
}

function registryEntry(id, extra = {}) {
  return {
    id,
    workspaceId: "workspace_default",
    packId: SHARED_AGENT_SKILL_PACK_ID,
    source: "skill-directory",
    definition: {
      id, name: id, summary: `${id} summary`, promptFragments: [`${id} rules`], roleAffinity: ["engineer"],
      requiredTools: ["read"], requiredProviderCapabilities: ["chat"], approvalProfile: { mode: "none" }, stateEffects: [],
    },
    visibility: { workspaceVisible: true, promotableToWorkspace: true },
    reviewStatus: "published",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...extra,
  };
}

function publishedSnapshot({ id, skillId, sourcePath, markdown, sourceKind = "workspace-skill-directory", updatedAt = "2026-10-27T01:00:00.000Z" }) {
  return {
    id, workspaceId: "workspace_default", skillId, sourceKind, sourcePath,
    sourceChecksum: checksum(markdown), rawSkillMarkdown: markdown,
    referencedFiles: [], warnings: [], reviewStatus: "published",
    createdAt: "2026-10-27T01:00:00.000Z", updatedAt,
  };
}

function sharedPreviewInput(roots, registrySkills, snapshots) {
  return { roots, registrySkills, snapshots, snapshotSourceRoots: roots, allowManagedSkillIdMatching: false, generatedAt: "2026-10-27T02:00:00.000Z" };
}

test("a natural id offered by two shared roots is blocked for every contender", async () => {
  await withTempDir("ling-core-shared-duplicate-", async (root) => {
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const projectMarkdown = skillMarkdown("dup-skill", "Project copy.");
    const homeMarkdown = skillMarkdown("dup-skill", "Home copy.");
    await writeSkill(join(workspace, ".agents", "skills"), "dup-skill", projectMarkdown);
    await writeSkill(join(home, ".agents", "skills"), "dup-skill", homeMarkdown);
    await writeSkill(join(workspace, ".agents", "skills"), "unique-skill", skillMarkdown("unique-skill", "Only once."));

    const roots = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot: workspace, homeDir: home });
    assert.deepEqual(roots.map((entry) => entry.id), [
      SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.project,
      SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.user,
    ]);

    const preview = await previewGstackSkillSourceSync(sharedPreviewInput(roots, [], []));
    const contenders = preview.records.filter((record) => record.skillId === "dup-skill");
    assert.equal(contenders.length, 2);
    for (const record of contenders) {
      assert.equal(record.state, "blocked");
      assert.equal(record.warnings.some((warning) => warning.code === "duplicate_source" && warning.severity === "error"), true);
      assert.equal(record.definitionPreview, undefined);
      assert.equal(record.snapshotPreview, undefined);
    }
    assert.deepEqual(contenders.map((record) => record.sourceRootId), [
      SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.project,
      SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.user,
    ]);
    const unique = preview.records.find((record) => record.skillId === "unique-skill");
    assert.equal(unique.state, "new");
    assert.equal(unique.warnings.some((warning) => warning.code === "duplicate_source"), false);
  });
});

test("adopted snapshots stay visible as missing after their shared root is deleted", async () => {
  await withTempDir("ling-core-shared-deleted-root-", async (root) => {
    const workspace = join(root, "workspace");
    const skillsRoot = join(workspace, ".agents", "skills");
    const markdown = skillMarkdown("adopted-skill", "Adopted earlier.");
    const skillPath = await writeSkill(skillsRoot, "adopted-skill", markdown);
    const registrySkills = [registryEntry("adopted-skill")];
    const snapshots = [publishedSnapshot({ id: "snap-adopted", skillId: "adopted-skill", sourcePath: skillPath, markdown })];

    const before = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot: workspace, includeUserRoot: false });
    const beforePreview = await previewGstackSkillSourceSync(sharedPreviewInput(before, registrySkills, snapshots));
    assert.equal(beforePreview.records.find((record) => record.skillId === "adopted-skill").state, "unchanged");

    await rm(skillsRoot, { recursive: true, force: true });
    const after = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot: workspace, includeUserRoot: false });
    assert.deepEqual(after, []);

    const afterPreview = await previewGstackSkillSourceSync(sharedPreviewInput(after, registrySkills, snapshots));
    const missing = afterPreview.records.find((record) => record.skillId === "adopted-skill");
    assert.ok(missing, "a pack-owned snapshot must still be reported after the root disappears");
    assert.equal(missing.state, "missing");
    assert.equal(missing.warnings.some((warning) => warning.code === "missing_upstream"), true);
    assert.equal(missing.existingSnapshotId, "snap-adopted");
  });
});

test("shared preview scopes snapshot history by pack id and never leaks legacy gstack snapshots", async () => {
  await withTempDir("ling-core-shared-pack-scope-", async (root) => {
    const workspace = join(root, "workspace");
    const skillsRoot = join(workspace, ".agents", "skills");
    const sharedMarkdown = skillMarkdown("shared-skill", "Shared adoption.");
    const legacyMarkdown = skillMarkdown("legacy-skill", "Legacy gstack publish.");
    const sharedPath = await writeSkill(skillsRoot, "shared-skill", sharedMarkdown);
    // A legacy gstack publish used to scan `<cwd>/.agents/skills` and write a
    // workspace-skill-directory snapshot with the gstack pack.
    const legacyPath = join(skillsRoot, "legacy-gone", "SKILL.md");
    const registrySkills = [
      registryEntry("shared-skill"),
      registryEntry("legacy-skill", { packId: "gstack-source-sync", source: "gstack" }),
    ];
    const snapshots = [
      publishedSnapshot({ id: "snap-shared", skillId: "shared-skill", sourcePath: sharedPath, markdown: sharedMarkdown }),
      publishedSnapshot({ id: "snap-legacy", skillId: "legacy-skill", sourcePath: legacyPath, markdown: legacyMarkdown }),
    ];
    const roots = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot: workspace, includeUserRoot: false });

    const sharedSurface = await previewGstackSkillSourceSync(sharedPreviewInput(roots, registrySkills, snapshots));
    assert.deepEqual(sharedSurface.records.map((record) => [record.skillId, record.state]), [["shared-skill", "unchanged"]]);

    // Explicit pack scope works without the shared-surface marker and preserves shared history
    // even when the path scope is empty (deleted root).
    const explicitPackScope = await previewGstackSkillSourceSync({
      roots: [],
      registrySkills,
      snapshots,
      snapshotPackIds: [SHARED_AGENT_SKILL_PACK_ID],
      generatedAt: "2026-10-27T02:00:00.000Z",
    });
    assert.deepEqual(explicitPackScope.records.map((record) => [record.skillId, record.state]), [["shared-skill", "missing"]]);
  });
});

test("shared scanning rejects symbolic links and non-regular sources as blocked", async () => {
  await withTempDir("ling-core-shared-unsafe-", async (root) => {
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const skillsRoot = join(workspace, ".agents", "skills");
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const outsideSkill = join(outside, "SKILL.md");
    await writeFile(outsideSkill, skillMarkdown("linked-md", "Outside content."), "utf8");

    const linkedDirectory = join(skillsRoot, "linked-md");
    await mkdir(linkedDirectory, { recursive: true });
    await symlink(outsideSkill, join(linkedDirectory, "SKILL.md"));

    await mkdir(join(skillsRoot, "linked-dir"), { recursive: true });
    await rm(join(skillsRoot, "linked-dir"), { recursive: true });
    await symlink(outside, join(skillsRoot, "linked-dir"));

    const irregularDirectory = join(skillsRoot, "irregular-skill");
    await mkdir(join(irregularDirectory, "SKILL.md"), { recursive: true });

    const workspaceRootLink = join(root, "workspace-link");
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await mkdir(join(workspaceRootLink, ".agents"), { recursive: true });
    await symlink(skillsRoot, join(workspaceRootLink, ".agents", "skills"));

    const roots = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot: workspace, homeDir: home, includeUserRoot: false });
    assert.deepEqual(roots.map((entry) => entry.id), [SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.project]);

    const linkedRoots = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot: workspaceRootLink, homeDir: home, includeUserRoot: false });
    assert.deepEqual(linkedRoots, [], "a symlinked root is not a valid shared root");

    const preview = await previewGstackSkillSourceSync(sharedPreviewInput(roots, [], []));
    const byId = new Map(preview.records.map((record) => [record.skillId, record]));
    for (const skillId of ["linked-md", "linked-dir", "irregular-skill"]) {
      const record = byId.get(skillId);
      assert.ok(record, `expected a blocked record for ${skillId}`);
      assert.equal(record.state, "blocked");
      assert.equal(record.warnings.some((warning) => warning.code === "unsafe_path" && warning.severity === "error"), true);
      assert.equal(record.definitionPreview, undefined);
      assert.equal(record.snapshotPreview, undefined);
    }
    assert.equal(byId.get("linked-md").sourceSizeBytes, 0, "linked content must not be read");
  });
});

test("legacy preview surfaces keep their previous duplicate and symlink behavior", async () => {
  await withTempDir("ling-core-shared-legacy-compat-", async (root) => {
    const projectRoot = join(root, "project-skills");
    const homeRoot = join(root, "home-skills");
    const markdown = skillMarkdown("legacy-dup", "Legacy duplicate.");
    const projectPath = await writeSkill(projectRoot, "legacy-dup", markdown);
    await writeSkill(homeRoot, "legacy-dup", markdown);

    const outside = join(root, "outside.md");
    await writeFile(outside, skillMarkdown("legacy-link", "Legacy link."), "utf8");
    const linkDirectory = join(projectRoot, "legacy-link");
    await mkdir(linkDirectory, { recursive: true });
    await symlink(outside, join(linkDirectory, "SKILL.md"));

    const roots = [
      { id: "legacy-project", rootPath: projectRoot, sourceKind: "workspace-skill-directory" },
      { id: "legacy-home", rootPath: homeRoot, sourceKind: "workspace-skill-directory" },
    ];
    const preview = await previewGstackSkillSourceSync({ roots, registrySkills: [], snapshots: [] });
    const duplicates = preview.records.filter((record) => record.skillId === "legacy-dup");
    assert.equal(duplicates.length, 2);
    assert.deepEqual(duplicates.map((record) => record.state), ["new", "new"]);
    const linked = preview.records.find((record) => record.skillId === "legacy-link");
    assert.equal(linked.state, "new");
    assert.equal(linked.warnings.some((warning) => warning.code === "unsafe_path"), false);
    assert.equal(projectPath.endsWith("SKILL.md"), true);
    assert.equal((await lstat(join(linkDirectory, "SKILL.md"))).isSymbolicLink(), true);
  });
});
