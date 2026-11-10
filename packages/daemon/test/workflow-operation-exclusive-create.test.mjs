import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createLingStackFileMutationToolExtension } from "../../runner-pi/dist/extensions/file-mutation.js";
import { createRunApprovalHandler } from "../dist/features/runs/approvals.js";
import { createTypedWorkflowBasis, gateOwner, typedOperation } from "./support/workflow-operation-gate-fixture.mjs";

async function fixture(t, path = "output.txt", afterApproval, signal) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-exclusive-create-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const basis = createTypedWorkflowBasis(store, cwd, [typedOperation("file_create", path)], now);
  const task = store.createTask({ channelId: basis.channel.id, title: "Exclusive create", prompt: "Create once", assigneeTeammateId: gateOwner }, now);
  const createdRun = store.createRun({ id: "exclusive-create-run", cwd, taskId: task.id, channelId: basis.channel.id,
    teammateId: gateOwner, workflowStepId: basis.step.id, providerName: "static", providerModel: "static",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: { cwd, delegatedRequirement: basis.requirement, workflowOperationExecution: basis.snapshot }, createdAt: now });
  store.markRunStarted(createdRun.id, now);
  store.updateChannelWorkflowStep(basis.step.id, { runId: createdRun.id, taskId: task.id }, now);
  const run = store.getRun(createdRun.id);
  const handler = createRunApprovalHandler({ store, run, signal,
    approvalPolicy: { toolDecisions: { write: "allow" }, allowedWritePaths: [cwd] },
    appendAndMaybeStream: (type, data) => store.appendEvent(run.id, type, data),
  });
  const tools = new Map();
  let resultHook;
  createLingStackFileMutationToolExtension({ cwd, task, onApprovalRequired: async (request) => {
    const decision = await handler(request);
    await afterApproval?.({ cwd, decision });
    return decision;
  } })({ on(_name, handler) { resultHook = handler; }, registerTool: (tool) => tools.set(tool.name, tool) });
  return { cwd, store, run, handler, task,
    async write(id, input = { path, content: "authorized" }) {
      const result = await tools.get("write").execute(id, input, signal);
      const status = resultHook({ type: "tool_result", toolCallId: id, toolName: "write", ...result, isError: false });
      return { ...result, isError: status?.isError ?? false };
    },
  };
}

test("a competitor created after approval cannot be overwritten by a native Pi file_create", async (t) => {
  let competitorCreated = false;
  const f = await fixture(t, "output.txt", async ({ cwd, decision }) => {
    assert.equal(decision.approved, true);
    try {
      await writeFile(join(cwd, "output.txt"), "competitor", { flag: "wx" });
      competitorCreated = true;
    } catch (error) {
      assert.equal(error.code, "EEXIST");
    }
  });
  await f.write("race-after-approval");
  assert.equal(await readFile(join(f.cwd, "output.txt"), "utf8"), competitorCreated ? "competitor" : "authorized");
});

test("two concurrent typed creates have exactly one successful native tool effect", async (t) => {
  const f = await fixture(t);
  const contents = ["first authorized writer", "second authorized writer"];
  const results = await Promise.allSettled(contents.map((content, index) =>
    f.write(`create-${index}`, { path: "output.txt", content })));
  await assertSingleCreateWinner(f, results, contents);
});

async function assertSingleCreateWinner(f, results, contents) {
  const winners = results.flatMap((result, index) => result.status === "fulfilled" && result.value.isError === false ? [index] : []);
  assert.equal(winners.length, 1, "exactly one writer may report success");
  const loser = results[1 - winners[0]];
  // Before open, the existing-target gate throws; after both are admitted,
  // O_EXCL returns a handled failure. Neither path may overwrite the winner.
  if (loser.status === "rejected") assert.match(loser.reason.message, /operation_binding_create_target_exists/);
  else {
    assert.equal(loser.value.isError, true);
    assert.equal(loser.value.details.code, "operation_binding_create_target_exists");
    assert.match(loser.value.content[0].text, /operation_binding_create_target_exists/);
  }
  assert.equal(await readFile(join(f.cwd, "output.txt"), "utf8"), contents[winners[0]], "only the successful writer's bytes may remain");
}

test("typed create handles the effect in Host and preserves an existing destination", async (t) => {
  const f = await fixture(t);
  const decision = await f.handler({ toolName: "write", toolCallId: "host-create", cwd: f.cwd, task: f.task,
    input: { path: "output.txt", content: "authorized" } });
  assert.equal(decision.approved, true);
  assert.ok(decision.handledResult, "typed write must not fall through to Pi's overwriting native write");
  assert.equal(await readFile(join(f.cwd, "output.txt"), "utf8"), "authorized");
  const duplicate = await f.write("duplicate-create");
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.details.code, "operation_binding_create_target_exists");
  assert.equal(await readFile(join(f.cwd, "output.txt"), "utf8"), "authorized");
});

test("typed create does not implicitly create missing parent directories", async (t) => {
  const f = await fixture(t, "missing/output.txt");
  const failed = await f.write("missing-parent");
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /parent_missing|ENOENT/);
  await assert.rejects(readFile(join(f.cwd, "missing/output.txt")), /ENOENT/);
});

test("typed generated patch create cannot fall through to the ordinary replacing patch writer", async (t) => {
  const f = await fixture(t);
  const failed = await f.write("patch-create", { patchText: "*** Begin Patch\n*** Add File: output.txt\n+authorized\n*** End Patch" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /content_form_unsupported/);
  await assert.rejects(readFile(join(f.cwd, "output.txt")), /ENOENT/);
});

test("cancelled typed create cannot publish success or create a destination", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, "output.txt", undefined, controller.signal);
  controller.abort(new Error("cancel-before-create"));
  await assert.rejects(f.write("cancelled-create"), /cancel-before-create/);
  await assert.rejects(readFile(join(f.cwd, "output.txt")), /ENOENT/);
});
