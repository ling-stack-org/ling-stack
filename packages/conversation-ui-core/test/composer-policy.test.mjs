import assert from "node:assert/strict";
import test from "node:test";
import {
  composerSlashCommandParts,
  conversationPermissionPresetRequiresConfirmation,
  filterSlashCommandPickerOptions,
  findActiveSlashCommand,
  insertSlashCommandToken,
  parseComposerInputParts,
  removeComposerInputRawToken,
  serializeComposerInputParts,
} from "../dist/index.js";

const slashCommands = [
  { id: "review", label: "Review" },
  { id: "design-review", label: "Design Review" },
];

test("composer parser extracts attachments, teammate mentions, slash commands, urls, and workspace files", () => {
  const parts = parseComposerInputParts("@Designer /review ./apps/web https://example.com", {
    attachments: [{ attachmentId: "attachment-1" }],
    cwd: "/Users/tianxiao/ling-stack",
    teammateMentions: [{ id: "teammate-1", label: "Designer" }],
    slashCommands,
    linkPreviews: [{ url: "https://example.com", title: "Example", state: "ready" }],
  });

  assert.deepEqual(parts.map((part) => part.type), [
    "attachment",
    "teammate_mention",
    "text",
    "slash_command",
    "text",
    "workspace_file",
    "text",
    "url_ref",
  ]);
  assert.deepEqual(serializeComposerInputParts(parts), {
    attachmentIds: ["attachment-1"],
    body: "@Designer /review ./apps/web https://example.com",
  });
  assert.deepEqual(composerSlashCommandParts(parts).map((part) => part.commandId), ["review"]);
});

test("slash picker is pure and can insert command tokens", () => {
  const picker = findActiveSlashCommand("please /des", 11);

  assert.deepEqual(picker, { query: "des", start: 7, end: 11 });
  assert.deepEqual(filterSlashCommandPickerOptions(slashCommands, picker).map((option) => option.id), ["design-review"]);
  assert.deepEqual(insertSlashCommandToken("please /des now", picker, "design-review"), {
    value: "please /design-review now",
    caret: 22,
  });
});

test("raw token removal trims duplicate whitespace at removal boundary", () => {
  assert.equal(removeComposerInputRawToken("Run /review  now", "/review"), "Run now");
});

test("permission confirmation is derived from explicit option metadata", () => {
  assert.equal(conversationPermissionPresetRequiresConfirmation("full_access"), true);
  assert.equal(conversationPermissionPresetRequiresConfirmation("read_only"), false);
  assert.equal(conversationPermissionPresetRequiresConfirmation("full_access", [
    { preset: "full_access", label: "Full", description: "No confirmation in this test" },
  ]), false);
});
