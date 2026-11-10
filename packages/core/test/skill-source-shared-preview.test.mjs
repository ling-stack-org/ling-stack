import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SHARED_AGENT_SKILL_PACK_ID, previewGstackSkillSourceSync } from "../dist/index.js";

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
  await writeFile(join(directory, "SKILL.md"), markdown, "utf8");
  return join(directory, "SKILL.md");
}

function registryEntry(id, extra = {}) {
  return {
    id,
    workspaceId: "workspace_default",
    packId: "gstack-default",
    source: "builtin",
    version: "1.58.3.0",
    definition: {
      id,
      name: id,
      summary: `${id} summary`,
      promptFragments: [`${id} rules`],
      roleAffinity: ["engineer"],
      requiredTools: ["read"],
      requiredProviderCapabilities: ["chat"],
      approvalProfile: { mode: "none" },
      stateEffects: [],
    },
    visibility: { workspaceVisible: true, promotableToWorkspace: false },
    reviewStatus: "published",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...extra,
  };
}

function publishedSnapshot({ id, skillId, sourcePath, sourceKind = "workspace-skill-directory", markdown, updatedAt = "2026-10-27T01:00:00.000Z" }) {
  return {
    id,
    workspaceId: "workspace_default",
    skillId,
    sourceKind,
    sourcePath,
    sourceChecksum: checksum(markdown),
    rawSkillMarkdown: markdown,
    referencedFiles: [],
    warnings: [],
    reviewStatus: "published",
    createdAt: "2026-10-27T01:00:00.000Z",
    updatedAt,
  };
}

test("shared preview only compares snapshots owned by the scanned shared roots", async () => {
  await withTempDir("ling-core-shared-preview-roots-", async (root) => {
    const sharedRoot = join(root, "workspace", ".agents", "skills");
    const legacyRoot = join(root, "legacy-skills");
    const sharedMarkdown = skillMarkdown("shared-qa", "Run shared QA checks.");
    const sharedPath = await writeSkill(sharedRoot, "shared-qa", sharedMarkdown);
    const legacyMarkdown = skillMarkdown("legacy-skill", "Legacy source sync skill.");
    const legacyPath = await writeSkill(legacyRoot, "legacy-skill", legacyMarkdown);

    const roots = [{
      id: "shared-agents-workspace",
      rootPath: sharedRoot,
      sourceKind: "workspace-skill-directory",
      label: "Project shared .agents skill root",
    }];
    const registrySkills = [
      registryEntry("shared-qa", { source: "skill-directory", packId: SHARED_AGENT_SKILL_PACK_ID }),
      registryEntry("legacy-skill", { source: "gstack", packId: "gstack-source-sync" }),
    ];
    const snapshots = [
      publishedSnapshot({ id: "snap-shared", skillId: "shared-qa", sourcePath: sharedPath, markdown: sharedMarkdown }),
      publishedSnapshot({ id: "snap-legacy", skillId: "legacy-skill", sourcePath: legacyPath, markdown: legacyMarkdown }),
    ];

    const isolated = await previewGstackSkillSourceSync({
      roots,
      registrySkills,
      snapshots,
      snapshotSourceRoots: roots,
      allowManagedSkillIdMatching: false,
    });
    assert.deepEqual(isolated.records.map((record) => [record.skillId, record.state]), [["shared-qa", "unchanged"]]);

    // The shared surface scopes by pack ownership, so the legacy gstack snapshot never leaks
    // in even without a root filter. A non-shared (legacy) call still reports it as missing.
    const sharedWithoutRootScope = await previewGstackSkillSourceSync({ roots, registrySkills, snapshots, allowManagedSkillIdMatching: false });
    assert.equal(sharedWithoutRootScope.records.some((record) => record.skillId === "legacy-skill"), false);
    const legacySurface = await previewGstackSkillSourceSync({ roots, registrySkills, snapshots });
    assert.equal(legacySurface.records.some((record) => record.skillId === "legacy-skill" && record.state === "missing"), true);
  });
});

test("shared candidates are blocked when the natural id belongs to builtin, gstack, or workspace-managed skills", async () => {
  await withTempDir("ling-core-shared-preview-conflicts-", async (root) => {
    const sharedRoot = join(root, ".agents", "skills");
    await writeSkill(sharedRoot, "review", skillMarkdown("review", "Attempted builtin takeover."));
    await writeSkill(sharedRoot, "workspace-owned", skillMarkdown("workspace-owned", "Attempted workspace takeover."));
    const allowedMarkdown = skillMarkdown("shared-allowed", "Adopted through the shared source.");
    const allowedPath = await writeSkill(sharedRoot, "shared-allowed", allowedMarkdown);

    const registrySkills = [
      registryEntry("review"),
      registryEntry("workspace-owned", { source: "workspace", packId: "workspace-pack" }),
      registryEntry("shared-allowed", { source: "skill-directory", packId: SHARED_AGENT_SKILL_PACK_ID }),
    ];
    const snapshots = [
      publishedSnapshot({ id: "snap-allowed", skillId: "shared-allowed", sourcePath: allowedPath, markdown: allowedMarkdown }),
    ];
    const roots = [{ id: "shared-agents-workspace", rootPath: sharedRoot, sourceKind: "workspace-skill-directory" }];

    const preview = await previewGstackSkillSourceSync({
      roots,
      registrySkills,
      snapshots,
      snapshotSourceRoots: roots,
      allowManagedSkillIdMatching: false,
    });

    for (const skillId of ["review", "workspace-owned"]) {
      const record = preview.records.find((entry) => entry.skillId === skillId);
      assert.ok(record, `expected a record for ${skillId}`);
      assert.equal(record.state, "blocked");
      assert.equal(record.warnings.some((warning) => warning.code === "skill_id_conflict" && warning.severity === "error"), true);
      assert.equal(record.definitionPreview, undefined);
      assert.equal(record.snapshotPreview, undefined);
    }

    const allowed = preview.records.find((entry) => entry.skillId === "shared-allowed");
    assert.equal(allowed.state, "unchanged");
    assert.equal(allowed.warnings.some((warning) => warning.code === "skill_id_conflict"), false);

    // The conflict gate is opt-in for the shared surface; the legacy contract keeps attaching.
    const legacyPreview = await previewGstackSkillSourceSync({ roots, registrySkills, snapshots, snapshotSourceRoots: roots });
    assert.notEqual(legacyPreview.records.find((entry) => entry.skillId === "review")?.state, "blocked");
  });
});

test("gstack-style previews can exclude shared-source snapshots by pack id", async () => {
  await withTempDir("ling-core-shared-preview-exclude-", async (root) => {
    const gstackRoot = join(root, "gstack", ".agents", "skills");
    const sharedRoot = join(root, "home", ".agents", "skills");
    const gstackMarkdown = skillMarkdown("official-skill", "Official-style skill.");
    const gstackPath = await writeSkill(gstackRoot, "official-skill", gstackMarkdown);
    const sharedMarkdown = skillMarkdown("shared-qa", "Adopted shared skill.");
    const sharedPath = await writeSkill(sharedRoot, "shared-qa", sharedMarkdown);

    const registrySkills = [
      registryEntry("official-skill", { source: "gstack", packId: "gstack-source-sync" }),
      registryEntry("shared-qa", { source: "skill-directory", packId: SHARED_AGENT_SKILL_PACK_ID }),
    ];
    const snapshots = [
      publishedSnapshot({ id: "snap-gstack", skillId: "official-skill", sourcePath: gstackPath, markdown: gstackMarkdown, sourceKind: "gstack-skill-directory" }),
      publishedSnapshot({ id: "snap-shared", skillId: "shared-qa", sourcePath: sharedPath, markdown: sharedMarkdown }),
    ];
    const roots = [{ id: "official-root", rootPath: gstackRoot, sourceKind: "gstack-skill-directory" }];

    const withShared = await previewGstackSkillSourceSync({ roots, registrySkills, snapshots });
    assert.equal(withShared.records.some((record) => record.skillId === "shared-qa" && record.state === "missing"), true);

    const excluded = await previewGstackSkillSourceSync({
      roots,
      registrySkills,
      snapshots,
      excludedSnapshotPackIds: [SHARED_AGENT_SKILL_PACK_ID],
    });
    assert.deepEqual(excluded.records.map((record) => [record.skillId, record.state]), [["official-skill", "unchanged"]]);
  });
});
