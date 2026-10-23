import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { createInitializedPiSession } from "../dist/session-factory.js";
import { capturePreparedPiInput } from "../dist/prepared-input.js";
import { createCompactionRecoveryCheckpointProjector, installCompactionRecoveryView, readCompactionRecoveryView } from "../dist/compaction-recovery.js";

const testOptions = { timeout: 15_000 };
const conversation = session => session.state.messages.filter(message => message.role !== "system");
const activeCompaction = session => session.sessionManager.buildSessionProjection().entries.find(entry =>
  entry.sourceEntry.type === "compaction" && entry.messages.some(message => message.role === "compactionSummary"));

for (const reason of ["aborted", "error", "length", "toolUse", "unknown", undefined]) {
  test(`Runner rejects ${String(reason)} final assistant before installing a recovery view`, () => {
    const final = { role: "assistant", content: [{ type: "text", text: "Not proof of completion." }] };
    if (reason !== undefined) final.stopReason = reason;
    assert.throws(() => readCompactionRecoveryView({ schemaVersion: 1, modelView: [
      { role: "compactionSummary", summary: "Task progress." }, final,
    ] }), /Invalid Pi compaction recovery model view/u);
  });
}

for (const content of [undefined, "not SDK content", [{ type: "toolCall", id: "unfinished", name: "read", arguments: {} }]]) {
  test(`Runner rejects malformed or unfinished final content: ${JSON.stringify(content)}`, () => {
    assert.throws(() => readCompactionRecoveryView({ schemaVersion: 1, modelView: [
      { role: "compactionSummary", summary: "Task progress." }, { role: "assistant", stopReason: "stop", content },
    ] }), /Invalid Pi compaction recovery model view/u);
  });
}

/** Actual SDK Session and canonical projection; provider execution is forbidden. */
async function fixture(t, summaryMetadata = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-recovery-projection-"));
  let session, providerRequests = 0;
  t.after(async () => { session?.dispose(); await rm(cwd, { recursive: true, force: true }); });
  const options = { cwd, agentDir: join(cwd, "agent"), tools: ["read"],
    provider: { provider: "recovery-projection-fixture", model: "fixture", api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-no-network", reasoning: false },
    task: { id: "recovery-projection", title: "Continue a sealed task", prompt: "Preserve durable read evidence." } };
  const runner = new PiRunnerAdapter();
  session = await createInitializedPiSession(options, runtime => {
    runner.registerCustomProviderIfNeeded(runtime, options.provider);
    runtime.streamSimple = runtime.stream = () => {
      providerRequests += 1;
      throw new Error("Checkpoint projection must never execute a provider request.");
    };
  });
  const preparedInput = capturePreparedPiInput(session, options);
  const recovery = { schemaVersion: 1, modelView: [
    { role: "compactionSummary", summary: "Host-sealed recovery summary.", ...summaryMetadata },
    { role: "user", content: [{ type: "text", text: preparedInput.userPrompt }], timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "old-read", name: "read", arguments: { path: "old-read.txt" } }], timestamp: 1 },
    { role: "toolResult", toolCallId: "old-read", toolName: "read", isError: false, timestamp: 2,
      content: [{ type: "text", text: "Durable old read already completed." }], details: { evidence: "sealed-old-read" } },
  ] };
  const originalRecovery = structuredClone(recovery);
  assert.equal(installCompactionRecoveryView(session, recovery, preparedInput.userPrompt), "continue");
  const sourceEntryId = activeCompaction(session).sourceEntry.id;
  const project = createCompactionRecoveryCheckpointProjector(session, recovery);
  return { session, recovery, originalRecovery, sourceEntryId, project, providerRequests: () => providerRequests };
}

for (const [label, metadata] of [
  ["legacy summary without generated metadata", {}],
  ["sealed summary with its original timestamp and token metadata", { timestamp: 1, tokensBefore: 1_200 }],
]) {
  test(`recovery checkpoint projection preserves the exact ${label}`, testOptions, async t => {
    const f = await fixture(t, metadata);
    const sdkView = conversation(f.session), originalSdkView = structuredClone(sdkView);
    assert.notDeepEqual(sdkView[0], f.recovery.modelView[0], "the SDK creates its own restored summary metadata");
    const projected = f.project(sdkView);
    assert.deepEqual(projected, f.recovery.modelView, "Host checkpoint prefix remains byte-exact to its original seal");
    for (let index = 1; index < sdkView.length; index += 1) assert.equal(projected[index], sdkView[index]);
    assert.deepEqual(conversation(f.session), originalSdkView, "projection must not alter canonical SDK history");
    assert.deepEqual(f.recovery, f.originalRecovery);
    projected[0].summary = "Consumer-local mutation must not edit the seal.";
    assert.deepEqual(f.project(conversation(f.session)), f.originalRecovery.modelView);
    f.session.sessionManager.appendMessage({ role: "assistant", timestamp: 3,
      content: [{ type: "toolCall", id: "new-read", name: "read", arguments: { path: "new-read.txt" } }] });
    f.session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "new-read", toolName: "read", timestamp: 4,
      content: [{ type: "text", text: "New settled read evidence." }], isError: false });
    f.session.refreshContext();
    const advancedSdkView = conversation(f.session), advanced = f.project(advancedSdkView);
    assert.equal(activeCompaction(f.session).sourceEntry.id, f.sourceEntryId);
    assert.deepEqual(advanced.slice(0, f.recovery.modelView.length), f.recovery.modelView,
      "a later settled tool round extends, rather than recreates, the sealed prefix");
    assert.deepEqual(advanced.slice(f.recovery.modelView.length), advancedSdkView.slice(f.recovery.modelView.length));
    assert.equal(advanced.at(-1).toolCallId, "new-read");
    assert.deepEqual(f.recovery, f.originalRecovery);
    assert.equal(f.providerRequests(), 0);
  });
}

test("recovery projection never repairs a drifted sealed tail by reinserting old evidence", testOptions, async t => {
  const f = await fixture(t, { timestamp: 1, tokensBefore: 1_200 });
  const sdkView = conversation(f.session);
  const drifted = structuredClone(sdkView);
  drifted.at(-1).content[0].text = "A changed result must remain visible to Host validation.";
  drifted.at(-1).details = { evidence: "different-current-evidence" };
  const originalDrifted = structuredClone(drifted);
  const projected = f.project(drifted);
  assert.deepEqual(projected[0], f.recovery.modelView[0]);
  assert.deepEqual(projected.slice(1), drifted.slice(1));
  assert.equal(projected.at(-1), drifted.at(-1));
  assert.notDeepEqual(projected.slice(0, f.recovery.modelView.length), f.recovery.modelView,
    "Host's exact-prefix guard must still see genuine tail corruption");
  assert.deepEqual(drifted, originalDrifted);
  assert.deepEqual(conversation(f.session), sdkView);
  assert.deepEqual(f.recovery, f.originalRecovery);
  assert.equal(f.providerRequests(), 0);
});

test("a later genuine compaction uses its own SDK view instead of the restored seal", testOptions, async t => {
  const f = await fixture(t, { timestamp: 1, tokensBefore: 1_200 });
  const nextId = f.session.sessionManager.appendCompaction("A later independent summary.", null, 900);
  f.session.refreshContext();
  assert.notEqual(nextId, f.sourceEntryId);
  assert.equal(activeCompaction(f.session).sourceEntry.id, nextId);
  const sdkView = conversation(f.session);
  const projected = f.project(sdkView);
  assert.equal(projected, sdkView, "a new source entry must bypass the restored-summary mapping entirely");
  assert.equal(projected[0].summary, "A later independent summary.");
  assert.equal(projected[0].tokensBefore, 900);
  assert.notDeepEqual(projected[0], f.recovery.modelView[0]);
  assert.deepEqual(f.recovery, f.originalRecovery);
  assert.equal(f.providerRequests(), 0);
});

test("a new compaction ID is authoritative even with identical summary text and SDK metadata", testOptions, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T00:00:00.000Z") });
  const f = await fixture(t, { timestamp: 1, tokensBefore: 1_200 });
  const restoredSdkSummary = structuredClone(conversation(f.session)[0]);
  const nextId = f.session.sessionManager.appendCompaction(f.recovery.modelView[0].summary, null, 1_200);
  f.session.refreshContext();
  const sdkView = conversation(f.session);
  assert.notEqual(nextId, f.sourceEntryId);
  assert.deepEqual(sdkView[0], restoredSdkSummary,
    "identical text and a same-millisecond timestamp cannot establish restored source identity");
  const projected = f.project(sdkView);
  assert.equal(projected, sdkView);
  assert.notDeepEqual(projected[0], f.recovery.modelView[0], "the old seal must not overwrite a newer source entry");
  assert.deepEqual(f.recovery, f.originalRecovery);
  assert.equal(f.providerRequests(), 0);
});

for (const [field, change] of [
  ["summary", value => value + " Changed."],
  ["timestamp", value => value + 1],
  ["tokensBefore", value => value + 1],
]) {
  test(`same-source ${field} drift in the input summary fails closed instead of being masked`, testOptions, async t => {
    const f = await fixture(t, { timestamp: 1, tokensBefore: 1_200 });
    const sdkView = conversation(f.session), originalSdkView = structuredClone(sdkView);
    const drifted = structuredClone(sdkView);
    drifted[0][field] = change(drifted[0][field]);
    assert.equal(activeCompaction(f.session).sourceEntry.id, f.sourceEntryId);
    assert.throws(() => f.project(drifted), /changed its canonical compaction summary/u);
    assert.deepEqual(conversation(f.session), originalSdkView);
    assert.deepEqual(f.recovery, f.originalRecovery);
    assert.equal(f.providerRequests(), 0);
  });
}

for (const [field, change] of [
  ["summary", value => value + " Corrupted source."],
  ["tokensBefore", value => value + 1],
]) {
  test(`same-source canonical ${field} corruption cannot be hidden by passing an old summary copy`, testOptions, async t => {
    const f = await fixture(t, { timestamp: 1, tokensBefore: 1_200 });
    const staleView = structuredClone(conversation(f.session));
    // Deliberately corrupt this isolated in-memory journal through its public entry
    // accessor; even an unchanged caller copy cannot override canonical provenance.
    const source = f.session.sessionManager.getEntry(f.sourceEntryId);
    source[field] = change(source[field]);
    f.session.refreshContext();
    assert.equal(activeCompaction(f.session).sourceEntry.id, f.sourceEntryId);
    assert.throws(() => f.project(staleView), /changed its canonical compaction summary/u);
    assert.deepEqual(f.recovery, f.originalRecovery);
    assert.equal(f.providerRequests(), 0);
  });
}
