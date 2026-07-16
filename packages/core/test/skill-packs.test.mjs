import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GSTACK_DEFAULT_SKILL_PACK_ID,
  GSTACK_DEFAULT_UPSTREAM_VERSION,
  LING_AGENT_DEFAULT_SKILL_IDS,
  buildEffectiveTeammateSkills,
  getBuiltinSkillPack,
  listBuiltinSkillPacks,
  listDefaultSkills,
  listDefaultTeammateTemplates,
  providerCapabilities,
  readOnlyRunTools,
  riskyRunTools,
  suggestSkillInvocations,
} from "../dist/index.js";

const validTools = new Set([...readOnlyRunTools, ...riskyRunTools]);
const validProviderCapabilities = new Set(providerCapabilities);

test("gstack default skill pack is exposed as a builtin template", () => {
  const packs = listBuiltinSkillPacks();
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);

  assert.ok(pack);
  assert.equal(pack.id, "gstack-default");
  assert.equal(pack.source, "gstack");
  assert.equal(pack.version, GSTACK_DEFAULT_UPSTREAM_VERSION);
  assert.equal(packs.some((item) => item.id === pack.id), true);
  assert.equal(listDefaultSkills(pack.id).length, pack.skills.length);
  assert.equal(listDefaultTeammateTemplates(pack.id).length, pack.teammateTemplates.length);
});

test("gstack default skill pack mirrors the adapted current gstack workflow surface", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);
  const skillIds = new Set(pack.skills.map((skill) => skill.id));

  for (const skillId of [
    "autoplan",
    "benchmark",
    "benchmark-models",
    "browse",
    "canary",
    "careful",
    "checkpoint",
    "claude",
    "context-restore",
    "context-save",
    "cso",
    "plan-devex-review",
    "design-consultation",
    "design-shotgun",
    "design-html",
    "design-review",
    "diagram",
    "document-generate",
    "document-release",
    "devex-review",
    "freeze",
    "guard",
    "qa-only",
    "health",
    "investigate",
    "ios-clean",
    "ios-design-review",
    "ios-fix",
    "ios-qa",
    "ios-sync",
    "land-and-deploy",
    "landing-report",
    "learn",
    "make-pdf",
    "office-hours",
    "open-gstack-browser",
    "pair-agent",
    "plan-ceo-review",
    "plan-design-review",
    "plan-eng-review",
    "plan-tune",
    "qa",
    "review",
    "retro",
    "scrape",
    "setup-browser-cookies",
    "setup-deploy",
    "setup-gbrain",
    "ship",
    "skillify",
    "spec",
    "sync-gbrain",
    "unfreeze",
    "gstack-upgrade",
  ]) {
    assert.equal(skillIds.has(skillId), true, `${skillId} should be adapted into the Ling-native pack`);
  }

  assert.equal(skillIds.has("gstack"), false, "The gstack meta/root skill should remain outside the static Ling pack");
  assert.equal(skillIds.has("implement"), true, "Ling keeps its native implementation skill alongside adapted gstack skills");
  assert.equal(pack.skills.length, 55);
});

test("Ling Agent default skill list references executable non-strict skills", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);
  const skillsById = new Map(pack.skills.map((skill) => [skill.id, skill]));

  for (const skillId of LING_AGENT_DEFAULT_SKILL_IDS) {
    const skill = skillsById.get(skillId);
    assert.ok(skill, `${skillId} should exist in the built-in pack`);
    assert.notEqual(skill.approvalProfile.mode, "strict", `${skillId} should not require strict approval by default`);
  }
});

test("gstack default skills use supported tools and provider capabilities", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);

  for (const skill of pack.skills) {
    assert.equal("workflowPhase" in skill, false, `${skill.id} should not carry workflow stage metadata`);
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

test("skill invocation suggestions are read-only and respect effective skill gates", () => {
  const pack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  assert.ok(pack);
  const engineer = pack.teammateTemplates.find((teammate) => teammate.id === "engineer");
  assert.ok(engineer);
  const effectiveSkills = buildEffectiveTeammateSkills({
    teammate: {
      id: engineer.id,
      allowedTools: engineer.allowedTools,
      approvalProfile: engineer.approvalProfile,
    },
    bindings: engineer.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
    skills: pack.skills,
    channelAllowedTools: [...validTools],
    providerCapabilities: [...validProviderCapabilities],
  });

  const suggestions = suggestSkillInvocations({
    context: {
      title: "Review this pull request",
      prompt: "Find behavioral bugs, missing tests, and risky assumptions.",
    },
    effectiveSkills,
  });

  assert.equal(suggestions[0].skillId, "review");
  assert.equal(suggestions[0].sourceRefs[0].type, "skill");
  assert.equal(suggestions.length > 0, true);

  const afterExplicitSelection = suggestSkillInvocations({
    context: {
      title: "Review this pull request",
      prompt: "Find behavioral bugs, missing tests, and risky assumptions.",
      requestedSkillId: "review",
    },
    effectiveSkills,
  });
  assert.equal(afterExplicitSelection.some((suggestion) => suggestion.skillId === "review"), false);

  const blockedEffectiveSkills = buildEffectiveTeammateSkills({
    teammate: {
      id: engineer.id,
      allowedTools: engineer.allowedTools,
      approvalProfile: engineer.approvalProfile,
    },
    bindings: engineer.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
    skills: pack.skills,
    channelAllowedTools: ["read"],
    providerCapabilities: ["chat"],
  });
  const blockedSuggestions = suggestSkillInvocations({
    context: { title: "Implement a code fix", prompt: "Build and test the approved slice." },
    effectiveSkills: blockedEffectiveSkills,
  });
  assert.equal(blockedSuggestions.some((suggestion) => suggestion.skillId === "implement"), false);

  const healthBlocked = suggestSkillInvocations({
    context: { title: "Review this pull request", prompt: "Find behavioral bugs and missing tests." },
    effectiveSkills,
    healthFindings: [{
      id: "finding_review_failure",
      kind: "high_failure_rate_skill",
      severity: "warning",
      skillIds: ["review"],
      candidateIds: [],
      title: "Review failures",
      message: "Review has a high recent failure rate.",
      recommendation: "Review before relying on this skill.",
      recommendedAction: "review",
    }],
  });
  assert.equal(healthBlocked[0].skillId, "review");
  assert.deepEqual(healthBlocked[0].blockers, ["high_failure_rate_skill"]);
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
