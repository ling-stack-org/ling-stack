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
  { id: "ling_agent", label: "Ling Agent" },
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

test("parses plan as a session slash command", () => {
  assert.deepEqual(parseComposerSlashIntent("/plan", { commands, teammateMentions }), {
    kind: "session_command",
    commandId: "plan",
    commandLabel: "Plan Mode",
    action: "on",
    args: "",
    raw: "/plan",
  });
  assert.deepEqual(parseComposerSlashIntent("/plan off", { commands, teammateMentions }), {
    kind: "session_command",
    commandId: "plan",
    commandLabel: "Plan Mode",
    action: "off",
    args: "off",
    raw: "/plan off",
  });
  assert.deepEqual(parseComposerSlashIntent("/plan status", { commands, teammateMentions }), {
    kind: "session_command",
    commandId: "plan",
    commandLabel: "Plan Mode",
    action: "status",
    args: "status",
    raw: "/plan status",
  });
});

test("parses goal as a session slash command", () => {
  assert.deepEqual(parseComposerSlashIntent("/goal finish PR4", { commands, teammateMentions }), {
    kind: "session_command",
    commandId: "goal",
    commandLabel: "Goal",
    action: "set",
    args: "finish PR4",
    raw: "/goal finish PR4",
  });
  assert.deepEqual(parseComposerSlashIntent("/goal", { commands, teammateMentions }), {
    kind: "session_command",
    commandId: "goal",
    commandLabel: "Goal",
    action: "status",
    args: "",
    raw: "/goal",
  });
  assert.deepEqual(parseComposerSlashIntent("/goal pause", { commands, teammateMentions }), {
    kind: "session_command",
    commandId: "goal",
    commandLabel: "Goal",
    action: "pause",
    args: "pause",
    raw: "/goal pause",
  });
  assert.deepEqual(parseComposerSlashIntent("/goal clear", { commands, teammateMentions }), {
    kind: "session_command",
    commandId: "goal",
    commandLabel: "Goal",
    action: "clear",
    args: "clear",
    raw: "/goal clear",
  });
});

test("does not scope plan or goal session commands to teammates", () => {
  assert.deepEqual(parseComposerSlashIntent("@Engineer /plan", {
    commands: [{ id: "plan", label: "Plan Mode" }, { id: "goal", label: "Goal" }, ...commands],
    teammateMentions,
  }), { kind: "none" });
  assert.deepEqual(parseComposerSlashIntent("@Engineer /goal finish PR4", {
    commands: [{ id: "plan", label: "Plan Mode" }, { id: "goal", label: "Goal" }, ...commands],
    teammateMentions,
  }), { kind: "none" });
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

test("parses agent-scoped slash commands for teammate labels with spaces", () => {
  assert.deepEqual(parseComposerSlashIntent("@Ling Agent /review docs", { commands, teammateMentions }), {
    kind: "agent_command",
    teammateId: "ling_agent",
    teammateLabel: "Ling Agent",
    commandId: "review",
    commandLabel: "Code Review",
    args: "docs",
    raw: "@Ling Agent /review docs",
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
  assert.deepEqual(parseComposerSlashIntent("@Engineer @Design Lead /review apps/web", { commands, teammateMentions }), {
    kind: "multi_agent_command",
    teammates: [
      { id: "engineer", label: "Engineer" },
      { id: "design-lead", label: "Design Lead" },
    ],
    commandId: "review",
    commandLabel: "Code Review",
    args: "apps/web",
    raw: "@Engineer @Design Lead /review apps/web",
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
    { id: "plan", label: "Plan Mode" },
    { id: "goal", label: "Goal" },
    { id: "review", label: "Code Review" },
    { id: "qa", label: "Workspace QA" },
    { id: "custom-audit", label: "Custom Audit" },
  ]);
});
