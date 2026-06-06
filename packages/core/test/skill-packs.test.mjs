import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GSTACK_DEFAULT_SKILL_PACK_ID,
  buildEffectiveTeammateSkills,
  getBuiltinSkillPack,
  listBuiltinSkillPacks,
  listDefaultSkills,
  listDefaultTeammateTemplates,
  providerCapabilities,
  readOnlyRunTools,
  riskyRunTools,
} from "../dist/index.js";

const validTools = new Set([...readOnlyRunTools, ...riskyRunTools]);
const validProviderCapabilities = new Set(providerCapabilities);

test("gstack default skill pack is exposed as a builtin template", () => {
  const packs = listBuiltinSkillPacks();
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);

  assert.ok(pack);
  assert.equal(pack.id, "gstack-default");
  assert.equal(pack.source, "gstack");
  assert.equal(pack.version, "0.2.0");
  assert.equal(packs.some((item) => item.id === pack.id), true);
  assert.equal(listDefaultSkills(pack.id).length, pack.skills.length);
  assert.equal(listDefaultTeammateTemplates(pack.id).length, pack.teammateTemplates.length);
});

test("gstack default skill pack mirrors the adapted generic gstack workflow surface", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);
  const skillIds = new Set(pack.skills.map((skill) => skill.id));

  for (const skillId of [
    "autoplan",
    "plan-devex-review",
    "design-consultation",
    "design-shotgun",
    "design-html",
    "design-review",
    "devex-review",
    "qa-only",
    "benchmark",
    "health",
    "landing-report",
    "setup-deploy",
    "land-and-deploy",
    "canary",
    "document-generate",
    "spec",
    "retro",
    "learn",
  ]) {
    assert.equal(skillIds.has(skillId), true, `${skillId} should be adapted into the Ling-native pack`);
  }

  for (const excludedRuntimeSkill of ["gstack-upgrade", "browse", "setup-browser-cookies", "ios-qa", "sync-gbrain"]) {
    assert.equal(skillIds.has(excludedRuntimeSkill), false, `${excludedRuntimeSkill} should remain outside the static Ling pack`);
  }
});

test("gstack default skills use supported tools and provider capabilities", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);

  for (const skill of pack.skills) {
    for (const tool of skill.requiredTools) {
      assert.equal(validTools.has(tool), true, `${skill.id} references unsupported tool ${tool}`);
    }
    for (const capability of skill.requiredProviderCapabilities) {
      assert.equal(
        validProviderCapabilities.has(capability),
        true,
        `${skill.id} references unsupported provider capability ${capability}`,
      );
    }
  }
});

test("gstack default teammate templates bind only existing skills", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);
  const skillIds = new Set(pack.skills.map((skill) => skill.id));

  for (const teammate of pack.teammateTemplates) {
    assert.ok(teammate.defaultSkillIds.length > 0, `${teammate.id} should have at least one default skill`);
    for (const skillId of teammate.defaultSkillIds) {
      assert.equal(skillIds.has(skillId), true, `${teammate.id} references missing skill ${skillId}`);
    }
  }

  const engineer = pack.teammateTemplates.find((teammate) => teammate.id === "engineer");
  assert.ok(engineer);
  assert.equal(engineer.defaultSkillIds.includes("ship"), false);
  assert.equal(engineer.defaultSkillIds.includes("cso"), false);
});

test("gstack default teammate templates can execute their default skills", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);

  for (const teammate of pack.teammateTemplates) {
    const effectiveSkills = buildEffectiveTeammateSkills({
      teammate: {
        id: teammate.id,
        allowedTools: teammate.allowedTools,
        approvalProfile: teammate.approvalProfile,
      },
      bindings: teammate.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
      skills: pack.skills,
      channelAllowedTools: [...validTools],
      providerCapabilities: [...validProviderCapabilities],
    });
    const blocked = effectiveSkills.filter((skill) => !skill.executable);
    assert.deepEqual(
      blocked.map((skill) => [skill.skillId, skill.blockedReasons.map((reason) => reason.code)]),
      [],
      `${teammate.id} default skills should not be blocked by its own profile`,
    );
  }
});

test("gstack default workflows reference existing teammates, skills, and steps", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);
  const skillIds = new Set(pack.skills.map((skill) => skill.id));
  const teammateIds = new Set(pack.teammateTemplates.map((teammate) => teammate.id));

  for (const workflow of pack.workflowTemplates) {
    const stepIds = new Set(workflow.steps.map((step) => step.id));
    assert.ok(workflow.steps.length > 0, `${workflow.id} should define steps`);
    for (const step of workflow.steps) {
      assert.equal(teammateIds.has(step.teammateTemplateId), true, `${step.id} references missing teammate`);
      assert.equal(skillIds.has(step.skillId), true, `${step.id} references missing skill`);
      for (const dependency of step.dependsOn ?? []) {
        assert.equal(stepIds.has(dependency), true, `${step.id} references missing dependency ${dependency}`);
      }
    }
  }
});

test("risky skills require approval and helper lookups fail closed", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);
  const riskyTools = new Set(riskyRunTools);
  const riskySkills = pack.skills.filter((skill) =>
    skill.requiredTools.some((tool) => riskyTools.has(tool)) || skill.id === "cso",
  );

  assert.ok(riskySkills.length > 0);
  for (const skill of riskySkills) {
    assert.notEqual(skill.approvalProfile.mode, "none", `${skill.id} must not bypass approval`);
  }

  assert.equal(getBuiltinSkillPack("missing-pack"), undefined);
  assert.deepEqual(listDefaultSkills("missing-pack"), []);
  assert.deepEqual(listDefaultTeammateTemplates("missing-pack"), []);
});
