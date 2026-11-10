import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPatchActionDraft, applyPatchActionDraft } from "../dist/features/runs/patch-actions.js";

async function fixture(t, patchText) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-host-file-effect-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const request = { toolName: "apply_patch", toolCallId: "file-effect-call", cwd,
    task: { id: "file-effect", title: "File effect", prompt: "Apply a bounded patch" }, input: { patch: patchText } };
  return { cwd, draft: () => createPatchActionDraft({ request, patchText, allowedWritePaths: [cwd] }) };
}
const add = "*** Begin Patch\n*** Add File: first.txt\n+first\n*** End Patch";
const twoAdds = "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch";

test("file mutation enters the guard at the real synchronous write, not at callback resolution", async t => {
  const f = await fixture(t, add), calls = [];
  const output = await applyPatchActionDraft({ draft: f.draft(), cwd: f.cwd, allowedWritePaths: [f.cwd],
    effectGuard: { launch(effect) {
      assert.equal(existsSync(join(f.cwd, "first.txt")), false);
      calls.push("launch");
      const result = effect();
      assert.equal(readFileSync(join(f.cwd, "first.txt"), "utf8"), "first\n");
      return result;
    }, cleanup() { assert.fail("successful mutation must not rollback"); } } });
  assert.equal(output.outcome, "applied");
  assert.deepEqual(calls, ["launch"]);
});

test("closed admission before the actual write produces no file effect", async t => {
  const f = await fixture(t, add);
  const output = await applyPatchActionDraft({ draft: f.draft(), cwd: f.cwd, allowedWritePaths: [f.cwd],
    effectGuard: { launch() { throw new Error("admission_closed"); }, cleanup() { assert.fail("nothing to rollback"); } } });
  assert.equal(output.outcome, "not_applied");
  assert.equal(existsSync(join(f.cwd, "first.txt")), false);
  assert.match(output.handledResult.content[0].text, /admission_closed/u);
});

test("each file effect rechecks admission and bounded rollback uses the cleanup guard", async t => {
  const f = await fixture(t, twoAdds), calls = [];
  const output = await applyPatchActionDraft({ draft: f.draft(), cwd: f.cwd, allowedWritePaths: [f.cwd],
    effectGuard: { launch(effect) {
      calls.push("launch");
      if (calls.length === 2) throw new Error("admission_closed");
      return effect();
    }, cleanup(effect) { calls.push("cleanup"); return effect(); } } });
  assert.equal(output.outcome, "rolled_back");
  assert.deepEqual(calls, ["launch", "launch", "cleanup"]);
  assert.equal(existsSync(join(f.cwd, "first.txt")), false);
  assert.equal(existsSync(join(f.cwd, "second.txt")), false);
});

test("a commit error after the synchronous write retains the path for guarded rollback", async t => {
  const f = await fixture(t, add), calls = [];
  const output = await applyPatchActionDraft({ draft: f.draft(), cwd: f.cwd, allowedWritePaths: [f.cwd],
    effectGuard: { launch(effect) { effect(); throw new Error("journal_commit_failed"); },
      cleanup(effect) { calls.push("cleanup"); return effect(); } } });
  assert.equal(output.outcome, "rolled_back");
  assert.deepEqual(calls, ["cleanup"]);
  assert.equal(existsSync(join(f.cwd, "first.txt")), false);
});

test("stale cleanup cannot rewrite the file and remains a diverged outcome", async t => {
  const f = await fixture(t, twoAdds);
  let launches = 0;
  const output = await applyPatchActionDraft({ draft: f.draft(), cwd: f.cwd, allowedWritePaths: [f.cwd],
    effectGuard: { launch(effect) { if (++launches === 2) throw new Error("admission_closed"); return effect(); },
      cleanup() { throw new Error("stale_owner"); } } });
  assert.equal(output.outcome, "diverged");
  assert.equal(output.handledResult.details.status, "unknown_outcome");
  assert.equal(readFileSync(join(f.cwd, "first.txt"), "utf8"), "first\n");
  assert.equal(existsSync(join(f.cwd, "second.txt")), false);
});

test("delete and update both pass through the same actual-effect guard", async t => {
  const f = await fixture(t, "*** Begin Patch\n*** Delete File: old.txt\n*** Update File: source.txt\n@@\n-before\n+after\n*** End Patch");
  writeFileSync(join(f.cwd, "old.txt"), "old\n");
  writeFileSync(join(f.cwd, "source.txt"), "before\n");
  let effects = 0;
  const output = await applyPatchActionDraft({ draft: f.draft(), cwd: f.cwd, allowedWritePaths: [f.cwd],
    effectGuard: { launch(effect) { effects++; return effect(); }, cleanup() { assert.fail("no rollback"); } } });
  assert.equal(output.outcome, "applied");
  assert.equal(effects, 2);
  assert.equal(existsSync(join(f.cwd, "old.txt")), false);
  assert.equal(readFileSync(join(f.cwd, "source.txt"), "utf8"), "after\n");
});

test("delete rollback restores the original file after a journal commit error", async t => {
  const f = await fixture(t, "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch");
  writeFileSync(join(f.cwd, "old.txt"), "original\n");
  let cleanups = 0;
  const output = await applyPatchActionDraft({ draft: f.draft(), cwd: f.cwd, allowedWritePaths: [f.cwd],
    effectGuard: { launch(effect) { effect(); throw new Error("journal_commit_failed"); },
      cleanup(effect) { cleanups++; return effect(); } } });
  assert.equal(output.outcome, "rolled_back");
  assert.equal(cleanups, 1);
  assert.equal(readFileSync(join(f.cwd, "old.txt"), "utf8"), "original\n");
});
