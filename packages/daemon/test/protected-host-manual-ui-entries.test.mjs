import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workspaceDirectoryPickerActorEntry } from "../dist/features/workspace-directory/directory-picker.js";
import { runWorkspaceTerminalCommand, workspaceTerminalActorEntry } from "../dist/features/workspace-directory/terminal-runner.js";
import { PROTECTED_HOST_ACTOR_ENTRIES, readProtectedHostActorEntry } from "../dist/runtime/sandbox/protected-host-actor-inventory.js";

test("original manual UI producers are explicit raw/external entries, not sandbox or human-gesture proof", () => {
  for (const [entry, id] of [[workspaceDirectoryPickerActorEntry, "workspace_directory_picker"],
    [workspaceTerminalActorEntry, "workspace_terminal"]]) {
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(readProtectedHostActorEntry(entry), { entryId: id, kind: "user_external" });
    assert.equal(PROTECTED_HOST_ACTOR_ENTRIES[id], "user_external");
    assert.throws(() => readProtectedHostActorEntry({ ...entry }), /protected_host_actor_entry_invalid/u);
    assert.throws(() => { entry.invoke = () => {}; }, TypeError);
  }
  // No dialog is opened and no protection/human gesture is inferred from this identity test.
});

test("the default manual terminal still executes a real raw shell command without a run/attempt or sandbox claim", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-manual-entry-")));
  t.after(() => rmSync(root, { recursive: true })); // This exact disposable fixture only.
  const result = await runWorkspaceTerminalCommand({ cwd: root, command: "echo manual-raw-entry-ok" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "manual-raw-entry-ok");
  assert.equal(result.cwd, root);
  for (const key of ["runId", "attemptId", "protectedStageVerified", "scopeRef", "isolationEvidence"])
    assert.equal(Object.hasOwn(result, key), false);
});
