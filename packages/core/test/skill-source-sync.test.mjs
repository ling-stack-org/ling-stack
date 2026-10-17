import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  GSTACK_DEFAULT_SKILL_PACK_ID,
  GSTACK_DEFAULT_UPSTREAM_VERSION,
  buildSkillSourceSemanticProfile,
  diffSkillSourceSemanticProfiles,
  getBuiltinSkillPack,
  ManagedOfficialSkillSourceError,
  normalizeOfficialGstackOrigin,
  officialGstackSourceScanRoot,
  previewGstackSkillSourceSync,
  refreshManagedOfficialGstackSource,
  resolveLocalGstackSkillSourceRoots,
  resolveSkillSourceRoots,
} from "../dist/index.js";

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(root, directory, skillMarkdown, options = {}) {
  const skillDir = resolve(root, directory);
  await mkdir(skillDir, { recursive: true });
  await writeFile(resolve(skillDir, "SKILL.md"), skillMarkdown);
  if (options.agentYaml) {
    await mkdir(resolve(skillDir, "agents"), { recursive: true });
    await writeFile(resolve(skillDir, "agents", "openai.yaml"), options.agentYaml);
  }
  if (options.reference) {
    await mkdir(resolve(skillDir, "references"), { recursive: true });
    await writeFile(resolve(skillDir, "references", "checklist.md"), options.reference);
  }
  if (options.script) {
    await mkdir(resolve(skillDir, "scripts"), { recursive: true });
    await writeFile(resolve(skillDir, "scripts", "run.sh"), options.script);
  }
  return skillDir;
}

function builtinRegistryEntries() {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);
  return pack.skills.map((definition) => ({
    id: definition.id,
    workspaceId: "workspace_default",
    packId: pack.id,
    source: pack.source,
    version: pack.version,
    definition,
    visibility: {
      workspaceVisible: true,
      promotableToWorkspace: true,
    },
    reviewStatus: "builtin",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  }));
}

test("official source previews refresh routing metadata without changing approved authority", async () => {
  await withTempDir("ling-stack-skill-source-metadata-", async (root) => {
    await writeSkill(root, "gstack-review", "---\nname: review\ndescription: |\n  Review with the new complete workflow.\n  Keep the complete second routing line.\n---\n# Review\nUse bash and write for this workflow.\n");
    const existing = builtinRegistryEntries().find((entry) => entry.id === "review");
    const before = structuredClone(existing);
    const report = await previewGstackSkillSourceSync({
      roots: [{ rootPath: root, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: "1.91.100.0" }],
      registrySkills: [existing],
      includeSkillIds: ["review"],
    });
    const definition = report.records[0].definitionPreview;
    assert.equal(definition.name, "review");
    assert.equal(definition.summary, "Review with the new complete workflow.");
    assert.deepEqual(definition.promptFragments, ["Review with the new complete workflow.\nKeep the complete second routing line."]);
    for (const key of ["id", "roleAffinity", "requiredTools", "requiredProviderCapabilities", "approvalProfile", "stateEffects"]) {
      assert.deepEqual(definition[key], existing.definition[key], key);
    }
    assert.deepEqual(existing, before, "preview must not mutate registry state");
    assert.match(report.records[0].snapshotPreview.rawSkillMarkdown, /Use bash and write/);
  });
});

test("source previews do not overwrite custom metadata or treat non-gstack roots as official", async () => {
  await withTempDir("ling-stack-skill-source-custom-metadata-", async (root) => {
    await writeSkill(root, "gstack-review", "---\nname: review\ndescription: Upstream routing replacement.\n---\n# Review\n");
    const builtin = builtinRegistryEntries().find((entry) => entry.id === "review");
    for (const [entry, kind] of [
      [{ ...builtin, source: "custom", packId: "user-pack", reviewStatus: "published" }, "gstack-skill-directory"],
      [builtin, "workspace-skill-directory"],
      [builtin, "codex-skill-directory"],
    ]) {
      const report = await previewGstackSkillSourceSync({
        roots: [{ rootPath: root, sourceKind: kind }], registrySkills: [entry], includeSkillIds: ["review"],
      });
      assert.deepEqual(report.records[0].definitionPreview, entry.definition);
    }
  });
});

test("source preview consistently selects the active published snapshot and does not repeat updates", async () => {
  await withTempDir("ling-stack-skill-source-active-snapshot-", async (root) => {
    await writeSkill(root, "gstack-review", "---\nname: review\ndescription: Current review workflow.\n---\n# Current review\n");
    const roots = [{ rootPath: root, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: "1.91.100.0" }];
    const input = { roots, registrySkills: builtinRegistryEntries(), includeSkillIds: ["review"] };
    const discovered = (await previewGstackSkillSourceSync(input)).records[0];
    const current = {
      ...discovered.snapshotPreview, id: "current-source", workspaceId: "workspace_default", reviewStatus: "published",
      createdAt: "2026-10-14T01:00:00.000Z", updatedAt: "2026-10-14T02:00:00.000Z",
    };
    const previous = { ...current, id: "previous-source", sourceChecksum: "sha256:previous", updatedAt: "2026-10-14T01:00:00.000Z" };
    for (const snapshots of [[current, previous], [previous, current]]) {
      const record = (await previewGstackSkillSourceSync({ ...input, snapshots })).records[0];
      assert.equal(record.existingSnapshotId, current.id);
      assert.equal(record.state, "unchanged");
    }
  });
});

test("gstack source preview maps prefixed upstream skills to existing builtin ids", async () => {
  await withTempDir("ling-stack-skill-source-sync-", async (root) => {
    await writeSkill(root, "gstack-review", [
      "---",
      "name: review",
      "description: |",
      "  Review the current PR before landing.",
      "---",
      "# Review",
      "Use AskUserQuestion when a destructive decision is required.",
      "Never bypass approval policy.",
    ].join("\n"), {
      agentYaml: [
        "interface:",
        "  display_name: gstack-review",
        "  short_description: Pre-landing PR review.",
        "  default_prompt: Use gstack-review for this task.",
        "policy:",
        "  allow_implicit_invocation: true",
      ].join("\n"),
      reference: "# Checklist\n",
      script: "echo review\n",
    });

    const report = await previewGstackSkillSourceSync({
      roots: [{
        rootPath: root,
        sourceKind: "gstack-skill-directory",
        upstreamName: "gstack",
        upstreamVersion: GSTACK_DEFAULT_UPSTREAM_VERSION,
      }],
      registrySkills: builtinRegistryEntries(),
      snapshots: [],
      generatedAt: "2026-06-22T00:00:00.000Z",
    });

    assert.equal(report.summary.attachable, 1);
    assert.equal(report.upstreamVersions[0], GSTACK_DEFAULT_UPSTREAM_VERSION);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].skillId, "review");
    assert.equal(report.records[0].state, "attachable");
    assert.equal(report.records[0].upstreamSkillPath, "gstack-review/SKILL.md");
    assert.equal(report.records[0].agentMetadata.displayName, "gstack-review");
    assert.equal(report.records[0].referencedFiles.some((file) => file.path === "agents/openai.yaml" && file.kind === "agent-metadata"), true);
    assert.equal(report.records[0].referencedFiles.some((file) => file.path === "references/checklist.md" && file.kind === "reference"), true);
    assert.equal(report.records[0].snapshotPreview.rawSkillMarkdown.includes("# Review"), true);
    assert.equal(report.records[0].warnings.some((warning) => warning.code === "host_specific_tool"), true);
    assert.equal(report.records[0].warnings.some((warning) => warning.code === "permission_like_instruction"), true);
  });
});

test("gstack source preview classifies unchanged, drifted, missing, and orphaned snapshots", async () => {
  await withTempDir("ling-stack-skill-source-drift-", async (root) => {
    await writeSkill(root, "gstack-qa", [
      "---",
      "name: qa",
      "description: Run QA checks.",
      "---",
      "# QA",
    ].join("\n"));

    const initial = await previewGstackSkillSourceSync({
      roots: [{ rootPath: root, sourceKind: "gstack-skill-directory", upstreamName: "gstack" }],
      registrySkills: builtinRegistryEntries(),
      generatedAt: "2026-06-22T00:00:00.000Z",
    });
    const qaRecord = initial.records[0];
    const baseSnapshot = {
      id: "skill_source_qa",
      workspaceId: "workspace_default",
      skillId: "qa",
      sourceKind: "gstack-skill-directory",
      sourcePath: qaRecord.sourcePath,
      upstreamName: "gstack",
      upstreamVersion: GSTACK_DEFAULT_UPSTREAM_VERSION,
      upstreamSkillPath: qaRecord.upstreamSkillPath,
      sourceChecksum: qaRecord.sourceChecksum,
      rawSkillMarkdown: qaRecord.snapshotPreview.rawSkillMarkdown,
      referencedFiles: qaRecord.referencedFiles,
      warnings: qaRecord.warnings,
      reviewStatus: "published",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    };

    const unchanged = await previewGstackSkillSourceSync({
      roots: [{ rootPath: root, sourceKind: "gstack-skill-directory", upstreamName: "gstack" }],
      registrySkills: builtinRegistryEntries(),
      snapshots: [baseSnapshot],
      generatedAt: "2026-06-22T00:01:00.000Z",
    });
    assert.equal(unchanged.records.find((record) => record.skillId === "qa").state, "unchanged");

    const drifted = await previewGstackSkillSourceSync({
      roots: [{ rootPath: root, sourceKind: "gstack-skill-directory", upstreamName: "gstack" }],
      registrySkills: builtinRegistryEntries(),
      snapshots: [{ ...baseSnapshot, sourceChecksum: "sha256:old", rawSkillMarkdown: "---\nname: qa\n---\n# Old QA" }],
      generatedAt: "2026-06-22T00:02:00.000Z",
    });
    const driftedRecord = drifted.records.find((record) => record.skillId === "qa");
    assert.equal(driftedRecord.state, "drifted");
    assert.equal(driftedRecord.diff.some((item) => item.field === "sourceChecksum" && item.before === "sha256:old" && item.after === qaRecord.sourceChecksum), true);
    assert.equal(driftedRecord.diff.some((item) => item.field === "sourceLengthChars"), true);

    const missing = await previewGstackSkillSourceSync({
      roots: [{ rootPath: resolve(root, "empty"), sourceKind: "gstack-skill-directory", upstreamName: "gstack" }],
      registrySkills: builtinRegistryEntries(),
      snapshots: [baseSnapshot],
      generatedAt: "2026-06-22T00:03:00.000Z",
    });
    assert.equal(missing.records.find((record) => record.skillId === "qa").state, "missing");

    const orphaned = await previewGstackSkillSourceSync({
      roots: [{ rootPath: resolve(root, "empty"), sourceKind: "gstack-skill-directory", upstreamName: "gstack" }],
      registrySkills: builtinRegistryEntries(),
      snapshots: [{ ...baseSnapshot, skillId: "removed-skill" }],
      generatedAt: "2026-06-22T00:04:00.000Z",
    });
    assert.equal(orphaned.records.find((record) => record.skillId === "removed-skill").state, "orphaned");
  });
});

test("gstack source preview blocks raw secret-like and over-cap source previews", async () => {
  await withTempDir("ling-stack-skill-source-blocked-", async (root) => {
    await writeSkill(root, "gstack-danger", [
      "---",
      "name: danger",
      "description: Secret fixture.",
      "---",
      `Use ${"sk-" + "abcdefghijklmnopqrstuvwxyz1234567890"} during setup.`,
    ].join("\n"));

    const report = await previewGstackSkillSourceSync({
      roots: [{ rootPath: root, sourceKind: "gstack-skill-directory", upstreamName: "gstack" }],
      registrySkills: builtinRegistryEntries(),
      snapshots: [],
      generatedAt: "2026-06-22T00:00:00.000Z",
      maxSourceBytes: 64,
    });

    assert.equal(report.records[0].state, "blocked");
    assert.equal(report.records[0].warnings.some((warning) => warning.code === "secret_reference" && warning.severity === "error"), true);
    assert.equal(report.records[0].warnings.some((warning) => warning.code === "large_source" && warning.severity === "warning"), true);
    assert.equal(report.records[0].contextFindings.some((finding) => finding.kind === "optimization_unsafe"), true);
    assert.equal(report.records[0].contextFindings.some((finding) => finding.kind === "missing_or_weak_routing_description"), true);
    assert.equal(report.records[0].snapshotPreview, undefined);
  });
});

test("gstack source preview returns context findings for third-party source sync rows", async () => {
  await withTempDir("ling-stack-skill-source-context-", async (root) => {
    await writeSkill(root, "gstack-context-risk", [
      "---",
      "name: context-risk",
      "description: Use this skill.",
      "---",
      "# Context Risk",
      "Core instruction.",
      "## Background",
      "Background details.",
      "## Examples",
      "Example output must include the exact checklist.",
    ].join("\n"));

    const report = await previewGstackSkillSourceSync({
      roots: [{ rootPath: root, sourceKind: "gstack-skill-directory", upstreamName: "gstack" }],
      registrySkills: builtinRegistryEntries(),
      snapshots: [],
      generatedAt: "2026-07-03T00:00:00.000Z",
    });

    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].skillId, "context-risk");
    assert.equal(report.records[0].contextFindings.some((finding) => finding.kind === "missing_or_weak_routing_description"), true);
    assert.equal(report.records[0].contextFindings.some((finding) => finding.kind === "body_taxonomy_risk"), true);
    assert.equal(report.records[0].contextFindings.some((finding) => finding.kind === "optimization_unsafe"), true);
  });
});

test("configured gstack repositories resolve to local skill roots with upstream version", async () => {
  await withTempDir("ling-stack-skill-source-roots-", async (repoRoot) => {
    await mkdir(resolve(repoRoot, ".agents", "skills"), { recursive: true });
    await writeFile(resolve(repoRoot, "package.json"), JSON.stringify({ name: "gstack", version: "9.8.7" }));
    const roots = await resolveSkillSourceRoots({
      homeDir: resolve(repoRoot, "missing-home"),
      gstackRepoRoots: [repoRoot],
    });

    assert.equal(roots.length, 1);
    assert.match(roots[0].id, /^configured-gstack-root:[a-f0-9]{12}$/);
    assert.equal(roots[0].rootPath, resolve(repoRoot, ".agents", "skills"));
    assert.equal(roots[0].sourceKind, "gstack-skill-directory");
    assert.equal(roots[0].upstreamVersion, "9.8.7");
  });
});

test("local gstack resolver excludes Codex, Agents, and workspace skill roots", async () => {
  await withTempDir("ling-stack-local-gstack-roots-", async (homeDir) => {
    const repoRoot = resolve(homeDir, ".gstack", "repos", "gstack");
    await mkdir(resolve(repoRoot, ".agents", "skills"), { recursive: true });
    await mkdir(resolve(homeDir, ".codex", "skills"), { recursive: true });
    await mkdir(resolve(homeDir, ".agents", "skills"), { recursive: true });
    await writeFile(resolve(repoRoot, "package.json"), JSON.stringify({ name: "gstack", version: "9.8.7" }));

    const roots = await resolveLocalGstackSkillSourceRoots({ homeDir, volumeRoot: resolve(homeDir, "missing-volumes") });

    assert.equal(roots.length, 1);
    assert.equal(roots[0].id, "local-gstack");
    assert.equal(roots[0].rootPath.endsWith("/.gstack/repos/gstack/.agents/skills"), true);
    assert.equal(roots[0].sourceKind, "gstack-skill-directory");
  });
});

test("managed official source refreshes a Ling-owned cache without inspecting local skill roots", async () => {
  await withTempDir("ling-stack-managed-source-", async (root) => {
    const sourcesDir = resolve(root, "ling-user-data", "sources");
    const cacheRoot = resolve(sourcesDir, "official-gstack");
    const calls = [];
    const git = {
      async run(args, options) {
        calls.push({ args: [...args], cwd: options.cwd });
        if (args[0] === "clone") {
          await mkdir(resolve(cacheRoot, ".agents", "skills"), { recursive: true });
          await writeFile(resolve(cacheRoot, "package.json"), JSON.stringify({ name: "gstack", version: "9.8.7" }));
          return "";
        }
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return cacheRoot;
        }
        if (args[0] === "config") {
          return "https://github.com/garrytan/gstack.git";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "0123456789abcdef";
        }
        return "";
      },
    };

    const source = await refreshManagedOfficialGstackSource({ sourcesDir, git });

    const canonicalCacheRoot = await realpath(cacheRoot);
    assert.equal(source.repoRoot, canonicalCacheRoot);
    assert.equal(source.skillsRoot, resolve(canonicalCacheRoot, ".agents", "skills"));
    assert.equal(source.revision, "0123456789abcdef");
    assert.equal(source.version, "9.8.7");
    assert.equal(calls.some((call) => call.args[0] === "clone"), true);
    assert.equal(calls.some((call) => call.args[0] === "fetch"), true);
    assert.equal(calls.some((call) => call.args[0] === "checkout"), true);
    assert.equal(officialGstackSourceScanRoot(source).rootPath, source.skillsRoot);
    assert.equal(normalizeOfficialGstackOrigin("git@github.com:garrytan/gstack.git"), "github.com/garrytan/gstack");
    assert.equal(normalizeOfficialGstackOrigin("https://github.com/example/gstack.git"), "github.com/example/gstack");
  });
});

test("managed official source rejects a cache whose origin is not the official repository", async () => {
  await withTempDir("ling-stack-managed-source-invalid-", async (root) => {
    const sourcesDir = resolve(root, "ling-user-data", "sources");
    const cacheRoot = resolve(sourcesDir, "official-gstack");
    await mkdir(resolve(cacheRoot, ".agents", "skills"), { recursive: true });
    const git = {
      async run(args) {
        if (args[0] === "rev-parse") {
          return cacheRoot;
        }
        if (args[0] === "config") {
          return "https://github.com/example/gstack.git";
        }
        return "";
      },
    };

    await assert.rejects(
      refreshManagedOfficialGstackSource({ sourcesDir, git }),
      (error) => error instanceof ManagedOfficialSkillSourceError && error.code === "invalid_repository",
    );
  });
});

test("semantic profile flags gate, tool, external, destructive, secret, and referenced-file drift", () => {
  const before = buildSkillSourceSemanticProfile({
    sourceChecksum: "sha256:before",
    markdown: [
      "---",
      "name: review",
      "description: Review code.",
      "---",
      "# Review",
      "Plan and review the diff.",
    ].join("\n"),
    referencedFiles: [],
  });
  const after = buildSkillSourceSemanticProfile({
    sourceChecksum: "sha256:after",
    markdown: [
      "---",
      "name: review",
      "description: Review and publish code.",
      "---",
      "# Review",
      "STOP and ask the user before using bash.",
      "Create a PR, deploy, and never run git reset --hard.",
      "Read token from .env.",
    ].join("\n"),
    referencedFiles: [
      { path: "scripts/run.sh", kind: "script", checksum: "sha256:script", sizeBytes: 10, includedInSnapshot: false },
    ],
  });

  const diff = diffSkillSourceSemanticProfiles(before, after);

  assert.equal(diff.some((item) => item.kind === "gate_change" && item.severity === "warning"), true);
  assert.equal(diff.some((item) => item.kind === "tool_claim_change" && item.severity === "warning"), true);
  assert.equal(diff.some((item) => item.kind === "external_action_change" && item.severity === "warning"), true);
  assert.equal(diff.some((item) => item.kind === "destructive_claim_change" && item.severity === "error"), true);
  assert.equal(diff.some((item) => item.kind === "secret_claim_change" && item.severity === "error"), true);
  assert.equal(diff.some((item) => item.kind === "referenced_file_change" && item.severity === "warning"), true);
});
