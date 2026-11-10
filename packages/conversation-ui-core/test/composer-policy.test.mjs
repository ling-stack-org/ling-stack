import assert from "node:assert/strict";
import test from "node:test";
import {
  composerSlashCommandParts,
  composerWorkspaceFileParts,
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
    cwd: "/Users/example/ling-stack",
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

test("composer parser keeps adjacent natural-language text outside URL tokens", () => {
  const parts = parseComposerInputParts("https://github.com/QuantConnect/Lean这段文字应该继续显示");

  assert.deepEqual(parts.map((part) => part.type), ["url_ref", "text"]);
  assert.equal(parts[0].raw, "https://github.com/QuantConnect/Lean");
  assert.equal(parts[1].text, "这段文字应该继续显示");
});

test("composer parser keeps adjacent natural-language text outside workspace file tokens", () => {
  const parts = parseComposerInputParts("请查看 /private/tmp/ling-v391-qa-20260902-cdp/workspace/demo.ts。然后继续说明", {
    cwd: "/private/tmp/ling-v391-qa-20260902-cdp/workspace",
  });

  assert.deepEqual(parts.map((part) => part.type), ["text", "workspace_file", "text"]);
  assert.equal(parts[1].type, "workspace_file");
  assert.equal(parts[1].raw, "/private/tmp/ling-v391-qa-20260902-cdp/workspace/demo.ts");
  assert.equal(parts[2].text, "。然后继续说明");
});

test("composer workspace file refs deduplicate repeated path and line identities", () => {
  const parts = parseComposerInputParts("修改 src/index.js，然后运行 node src/index.js，再检查 src/index.js:12", {
    cwd: "/Users/example/ling-stack",
  });

  assert.deepEqual(
    composerWorkspaceFileParts(parts).map((part) => ({ path: part.path, line: part.line })),
    [
      { path: "src/index.js", line: undefined },
      { path: "src/index.js", line: 12 },
    ],
  );
});

test("composer defers trailing atomic tokens while the draft is still being typed", () => {
  assert.deepEqual(
    parseComposerInputParts("请查看 src/index.js", {
      cwd: "/Users/example/ling-stack",
      deferTrailingAtomicTokens: true,
    }),
    [{ type: "text", text: "请查看 src/index.js" }],
  );
  assert.deepEqual(
    parseComposerInputParts("请打开 https://example.com", {
      deferTrailingAtomicTokens: true,
    }),
    [{ type: "text", text: "请打开 https://example.com" }],
  );
  assert.equal(
    parseComposerInputParts("请查看 src/index.js。", {
      cwd: "/Users/example/ling-stack",
      deferTrailingAtomicTokens: true,
    })[1]?.type,
    "workspace_file",
  );
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

test("composer parsing handles long boundary runs without changing tokens", () => {
  const punctuation = "!".repeat(100_000);
  const parts = parseComposerInputParts(`https://example.com/docs${punctuation}`);
  assert.equal(parts[0]?.type, "url_ref");
  assert.equal(parts[0]?.raw, "https://example.com/docs");

  const paddedId = `${"-".repeat(100_000)}review${"-".repeat(100_000)}`;
  const command = parseComposerInputParts("/review", { slashCommands: [{ id: paddedId, label: "Review" }] });
  assert.equal(command[0]?.type, "slash_command");
  assert.equal(command[0]?.commandId, paddedId);
});

test("permission confirmation is derived from explicit option metadata", () => {
  assert.equal(conversationPermissionPresetRequiresConfirmation("full_access"), true);
  assert.equal(conversationPermissionPresetRequiresConfirmation("read_only"), false);
  assert.equal(conversationPermissionPresetRequiresConfirmation("full_access", [
    { preset: "full_access", label: "Full", description: "No confirmation in this test" },
  ]), false);
});
