import assert from "node:assert/strict";
import test from "node:test";
import {
  actionableSharedSkillCount,
  canIgnoreSharedSkill,
  canPublishSharedSkill,
  readIgnoredSharedSkills,
  visibleSharedSkillSourceRecords,
  sharedSkillIgnoreStorageKey,
  sharedSkillSourceKey,
  sharedSkillSourceLocation,
  sharedSkillSourceRootLabel,
  sharedSkillSourceStatus,
} from "../src/features/settings/shared-skill-sources-model.ts";

const roots = [
  { id: "shared-agents-workspace", rootPath: "/secret/project/.agents/skills", label: "/secret/project", sourceKind: "workspace-skill-directory" },
  { id: "shared-agents-user", rootPath: "/secret/home/.agents/skills", label: "/secret/home", sourceKind: "workspace-skill-directory" },
];
const candidate = (state, skillId = "my-skill", extra = {}) => ({
  state, skillId, sourceRootId: roots[0].id,
  sourcePath: `/secret/project/.agents/skills/${skillId}/SKILL.md`,
  semanticDiff: [], ...extra,
});

test("shared skill badge counts new and drifted only; ignored and semantic errors do not count", () => {
  const records = [candidate("new"), candidate("drifted", "update"), candidate("attachable", "attach"),
    candidate("unchanged", "same"), candidate("blocked", "blocked"),
    candidate("drifted", "bad", { semanticDiff: [{ severity: "error" }] })];
  assert.equal(actionableSharedSkillCount(records, new Set()), 2);
  assert.equal(actionableSharedSkillCount(records, new Set([sharedSkillSourceKey(records[0])])), 1);
  assert.equal(canPublishSharedSkill(records[2]), true);
  assert.equal(canPublishSharedSkill(records[4]), false);
  assert.equal(canPublishSharedSkill(records[5]), false);
  assert.equal(sharedSkillSourceStatus(records[0], new Set([sharedSkillSourceKey(records[0])])), "ignored");
});

test("orphaned sources stay hidden and only unadopted candidates can be ignored", () => {
  const orphaned = candidate("orphaned", "old-skill");
  const adopted = candidate("drifted", "update");
  const unadopted = candidate("new", "new-skill");
  const attachable = candidate("attachable", "attachable-skill");
  assert.equal(canIgnoreSharedSkill(unadopted), true);
  assert.equal(canIgnoreSharedSkill(attachable), true);
  assert.equal(canIgnoreSharedSkill(adopted), false);
  assert.equal(canIgnoreSharedSkill(orphaned), false);
  assert.deepEqual(visibleSharedSkillSourceRecords([orphaned, adopted, unadopted], new Set()), [adopted, unadopted]);
  assert.deepEqual(visibleSharedSkillSourceRecords([orphaned, adopted, unadopted], new Set([sharedSkillSourceKey(unadopted)])), [adopted]);
  assert.deepEqual(visibleSharedSkillSourceRecords([orphaned], new Set(), { showOrphaned: true }), [orphaned]);
  assert.deepEqual(visibleSharedSkillSourceRecords([orphaned, unadopted], new Set([sharedSkillSourceKey(unadopted)]), { showIgnored: true }), [unadopted]);
});

test("shared skill source location never exposes absolute root paths", () => {
  assert.equal(sharedSkillSourceLocation(candidate("new"), roots), "my-skill/SKILL.md");
  assert.equal(sharedSkillSourceLocation(candidate("new", "my-skill", { sourcePath: "/unrelated/private/SKILL.md", upstreamSkillPath: "/private/file" }), roots), "my-skill/SKILL.md");
  assert.equal(sharedSkillSourceLocation(candidate("new", "my-skill", { sourcePath: "C:\\private\\SKILL.md", upstreamSkillPath: "../private" }), roots), "my-skill/SKILL.md");
  assert.equal(sharedSkillSourceRootLabel(roots[0]), "Workspace · .agents/skills");
  assert.equal(sharedSkillSourceRootLabel(roots[1]), "Home · .agents/skills");
  assert.equal(sharedSkillSourceRootLabel(), ".agents/skills");
});

test("ignored candidates persist by workspace and recover from damaged storage", () => {
  const key = sharedSkillIgnoreStorageKey("/project/a");
  assert.notEqual(key, sharedSkillIgnoreStorageKey("/project/b"));
  const stored = readIgnoredSharedSkills({ getItem: (requested) => requested === key ? '["shared-agents-workspace:my-skill",9]' : null }, "/project/a");
  assert.deepEqual([...stored], ["shared-agents-workspace:my-skill"]);
  assert.deepEqual([...readIgnoredSharedSkills({ getItem: () => "{" }, "/project/a")], []);
});
