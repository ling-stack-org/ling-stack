import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultApprovalToolDecisions,
  getBuiltinSkillPack,
  listBuiltinSkillPackExtensions,
  listBuiltinToolExtensions,
  readOnlyRunTools,
  riskyRunTools,
} from "../dist/index.js";

test("built-in tool extension metadata matches approval policy defaults", () => {
  const extensions = listBuiltinToolExtensions();
  const byTool = new Map(extensions.map((extension) => [extension.toolName, extension]));

  assert.deepEqual([...byTool.keys()], [...readOnlyRunTools, ...riskyRunTools]);
  for (const tool of readOnlyRunTools) {
    assert.equal(byTool.get(tool)?.defaultApproval, "allow");
    assert.equal(byTool.get(tool)?.sideEffectLevel, "read");
    assert.equal(byTool.get(tool)?.manifest.requiredApprovals, undefined);
  }
  for (const tool of riskyRunTools) {
    assert.equal(byTool.get(tool)?.defaultApproval, defaultApprovalToolDecisions[tool]);
    assert.ok(byTool.get(tool)?.manifest.requiredApprovals?.length ?? 0);
  }
});

test("gstack-default skill pack is exposed as an extension", () => {
  const extension = listBuiltinSkillPackExtensions().find((item) => item.manifest.id === "skill-pack:gstack-default");
  const pack = getBuiltinSkillPack("gstack-default");

  assert.ok(extension);
  assert.ok(pack);
  assert.deepEqual(extension.skillIds, pack.skills.map((skill) => skill.id));
  assert.deepEqual(extension.teammateTemplateIds, pack.teammateTemplates.map((template) => template.id));
  assert.deepEqual(extension.workflowTemplateIds, pack.workflowTemplates.map((workflow) => workflow.id));
  assert.ok(extension.manifest.capabilities.includes("skill-pack:gstack-default"));
});
