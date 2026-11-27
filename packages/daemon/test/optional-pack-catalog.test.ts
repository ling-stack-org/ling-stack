import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, readCurrentRunProgressPolicySnapshot, readOnlyRunTools } from "../../core/dist/index.js";
import { previewSkillSourceDefinition } from "../../core/dist/skill-source-definition.js";
import { classifySkillSourceWarnings } from "../../core/dist/skill-source-sync.js";
import type { SkillRegistryEntry } from "../../core/dist/skill-types.js";
import { optionalPackForRegistryEntry } from "../dist/features/skills/optional-pack-catalog.js";
import { resolveCurrentRunSkill } from "../dist/features/runs/skill-selection.js";
import { prepareRunSkillSource } from "../dist/features/runs/skill-source-context.js";
import { createDaemonServer } from "../dist/index.js";

test("Ling-owned gstack-inspired defaults remain available without the external pack", () => {
  const entry = (id: string, source: SkillRegistryEntry["source"]): SkillRegistryEntry => ({
    id, source, packId: "gstack-default", workspaceId: "default", version: "test",
    definition: {} as SkillRegistryEntry["definition"], visibility: { workspaceVisible: true, promotableToWorkspace: false },
    reviewStatus: "published", createdAt: "", updatedAt: "",
  });
  assert.equal(optionalPackForRegistryEntry(entry("plan-eng-review", "builtin")), undefined);
  assert.equal(optionalPackForRegistryEntry(entry("gstack-plan-eng-review", "gstack")), "gstack");
});

test("external skill warning classification feeds a strict approval profile", () => {
  const markdown = "---\\nname: Dangerous\\ndescription: Runs a command\\n---\\n\\nUse rm -rf on the target.\\n";
  const warnings = classifySkillSourceWarnings(markdown, Buffer.byteLength(markdown), 256 * 1024);
  assert.ok(warnings.some(warning => warning.code === "destructive_command"));
  const definition = previewSkillSourceDefinition("superpowers-dangerous", {
    markdown,
    skillDirectoryName: "dangerous",
    frontMatter: { name: "Dangerous", description: "Runs a command" },
    warnings,
    root: { sourceKind: "workspace-skill-directory" },
  });
  assert.equal(definition.approvalProfile.mode, "strict");
  assert.ok(definition.approvalProfile.requiredForActions?.includes("external_send"));
});

test("raw secret-like source patterns are errors", () => {
  const secret = `sk-${"a".repeat(20)}`;
  const markdown = `---\\nname: Secret\\n---\\n\\nUse ${secret}.\\n`;
  const warnings = classifySkillSourceWarnings(markdown, Buffer.byteLength(markdown), 256 * 1024);
  assert.ok(warnings.some(warning => warning.code === "secret_reference" && warning.severity === "error"));
});

async function isolatedHome(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-optional-pack-")));
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "home");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

const now = "2026-11-27T00:00:00Z";

test("Superpowers keeps reference approval attached to a saved version after HTTP updates", async t => {
  const root = await isolatedHome(t);
  const folder = join(root, "external", "skills", "using-superpowers");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(cwd), mkdir(join(folder, "references"), { recursive: true })]);
  await writeFile(join(folder, "SKILL.md"), "---\nname: using-superpowers\ndescription: Workflow fixture\n---\n\nRead the reference.\n");
  const reference = join(folder, "references", "workflow.md");
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, { storeFactory: () => store });
  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/plugins/skill-packs/`;
    const post = async (pack: "gstack" | "superpowers", action: string, path?: string, expected = 200) => {
      const response = await fetch(`${base}${pack}?cwd=${encodeURIComponent(cwd)}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ action, path }) });
      const body = await response.json();
      assert.equal(response.status, expected, JSON.stringify(body));
      return body;
    };
    const unverified = await post("gstack", "connect", root, 400);
    assert.equal(unverified.error, "skill_pack_checksum_required");
    await writeFile(reference, "Read the workflow.\n");
    await post("superpowers", "connect", join(root, "external"));
    await post("superpowers", "enable");
    const skillId = "superpowers-using-superpowers";
    const teammate = store.createAiTeammate({ roleKey: "engineer", displayName: "Workflow fixture",
      description: "Workspace skill permissions", allowedTools: [...readOnlyRunTools, "bash", "edit", "write"], approvalProfile: { mode: "strict" } }, now);
    store.replaceTeammateSkillBindings(teammate.id, [{ skillId, source: "user", enabled: true }], now);
    const request = { requestedSkillId: skillId, teammateId: teammate.id, task: {} };
    assert.equal(resolveCurrentRunSkill(store, request)?.skill.approvalProfile.mode, "none");
    await writeFile(reference, "Review before external_send.\n");
    await post("superpowers", "connect", join(root, "external"));
    const original = await prepareRunSkillSource(store, skillId, "no_operation");
    assert.match(original.promptFragment ?? "", /Review before external_send/u);
    assert.equal(resolveCurrentRunSkill(store, request)?.skill.approvalProfile.mode, "strict");
    await post("superpowers", "rollback");
    const updated = await prepareRunSkillSource(store, skillId, "no_operation");
    assert.notEqual(updated.context.snapshotId, original.context.snapshotId);
    assert.equal(resolveCurrentRunSkill(store, request, updated.context)?.skill.approvalProfile.mode, "none");
    assert.equal(resolveCurrentRunSkill(store, request, original.context)?.skill.approvalProfile.mode, "strict");
    const run = store.createRun({ id: "pack-fixture-run", cwd, taskId: "pack-fixture-task", taskSnapshot: {}, providerSnapshot: {},
      providerName: "fixture", providerModel: "fixture", teammateId: teammate.id, selectedSkillId: skillId, createdAt: now,
      requestSnapshot: { ...request, runnerExecutionInput: { skillSourceContext: original.context }, permissionMode: "workspace_write",
        effectivePolicySnapshot: {} } });
    assert.equal(readCurrentRunProgressPolicySnapshot(store, run).toolDecisions.write, "ask");
    assert.throws(() => resolveCurrentRunSkill(store, request, { ...original.context, snapshotId: "missing" }),
      { code: "skill_pack_version_unavailable" });
    await post("superpowers", "disable");
    assert.throws(() => resolveCurrentRunSkill(store, request, original.context), { code: "skill_pack_disabled" });
    assert.throws(() => readCurrentRunProgressPolicySnapshot(store, run), { code: "checkpoint.permission_drift" });
  } finally {
    await daemon.stop();
  }
});
