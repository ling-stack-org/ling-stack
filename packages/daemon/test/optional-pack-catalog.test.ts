import assert from "node:assert/strict";
import test from "node:test";
import { previewSkillSourceDefinition } from "../../core/dist/skill-source-definition.js";
import { classifySkillSourceWarnings } from "../../core/dist/skill-source-sync.js";
import type { SkillRegistryEntry } from "../../core/dist/skill-types.js";
import { optionalPackForRegistryEntry } from "../dist/features/skills/optional-pack-catalog.js";

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
  const markdown = "---\\nname: Secret\\n---\\n\\nUse sk-abcdefghijklmnopqrstuvwxyz123456.\\n";
  const warnings = classifySkillSourceWarnings(markdown, Buffer.byteLength(markdown), 256 * 1024);
  assert.ok(warnings.some(warning => warning.code === "secret_reference" && warning.severity === "error"));
});
