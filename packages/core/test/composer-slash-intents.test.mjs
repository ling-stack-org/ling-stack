import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildComposerSlashCommandOptions,
  parseComposerSlashIntent,
} from "../dist/index.js";

const commands = [
  { id: "review", label: "Code Review" },
  { id: "design-review", label: "Design Review" },
  { id: "qa", label: "QA" },
];

const teammateMentions = [
  { id: "engineer", label: "Engineer" },
  { id: "design-lead", label: "Design Lead" },
];

test("parses a registered global slash command", () => {
  assert.deepEqual(parseComposerSlashIntent("/review apps/web", { commands, teammateMentions }), {
    kind: "global_command",
    commandId: "review",
    commandLabel: "Code Review",
    args: "apps/web",
    raw: "/review apps/web",
  });
});

test("parses a registered agent-scoped slash command", () => {
  assert.deepEqual(parseComposerSlashIntent("@Engineer /design-review mobile layout", { commands, teammateMentions }), {
    kind: "agent_command",
    teammateId: "engineer",
    teammateLabel: "Engineer",
    commandId: "design-review",
    commandLabel: "Design Review",
    args: "mobile layout",
    raw: "@Engineer /design-review mobile layout",
  });
});

test("matches command labels and normalized teammate labels", () => {
  assert.deepEqual(parseComposerSlashIntent("@Design-Lead /Code-Review docs", { commands, teammateMentions }), {
    kind: "agent_command",
    teammateId: "design-lead",
    teammateLabel: "Design Lead",
    commandId: "review",
    commandLabel: "Code Review",
    args: "docs",
    raw: "@Design-Lead /Code-Review docs",
  });
});

test("does not parse unknown commands or unresolved teammates", () => {
  assert.deepEqual(parseComposerSlashIntent("/unknown arg", { commands, teammateMentions }), { kind: "none" });
  assert.deepEqual(parseComposerSlashIntent("@Unknown /review arg", { commands, teammateMentions }), { kind: "none" });
});

test("does not parse local paths or slash-like prose as commands", () => {
  for (const input of [
    "/Users/tianxiao/ling-stack",
    "/tmp/file",
    "./src/index.ts",
    "../docs/design.md",
    "/review/apps/web",
    "please run /review apps/web",
  ]) {
    assert.deepEqual(parseComposerSlashIntent(input, { commands, teammateMentions }), { kind: "none" }, input);
  }
});

test("parses a registered multi-agent slash command", () => {
  assert.deepEqual(parseComposerSlashIntent("@Engineer @Design-Lead /review apps/web", { commands, teammateMentions }), {
    kind: "multi_agent_command",
    teammates: [
      { id: "engineer", label: "Engineer" },
      { id: "design-lead", label: "Design Lead" },
    ],
    commandId: "review",
    commandLabel: "Code Review",
    args: "apps/web",
    raw: "@Engineer @Design-Lead /review apps/web",
  });
});

test("builds command options from registry entries with builtin fallback", () => {
  assert.deepEqual(buildComposerSlashCommandOptions({
    fallbackSkills: [
      { id: "review", name: "Code Review" },
      { id: "qa", name: "QA" },
      { id: "ship", name: "Ship" },
    ],
    registryEntries: [
      {
        id: "qa",
        definition: { name: "Workspace QA" },
        reviewStatus: "published",
        visibility: { workspaceVisible: true },
      },
      {
        id: "ship",
        definition: { name: "Ship" },
        reviewStatus: "disabled",
        visibility: { workspaceVisible: true },
      },
      {
        id: "custom-audit",
        definition: { name: "Custom Audit" },
        reviewStatus: "published",
        visibility: { workspaceVisible: true },
      },
      {
        id: "private-skill",
        definition: { name: "Private Skill" },
        reviewStatus: "published",
        visibility: { workspaceVisible: false },
      },
    ],
  }), [
    { id: "review", label: "Code Review" },
    { id: "qa", label: "Workspace QA" },
    { id: "custom-audit", label: "Custom Audit" },
  ]);
});
