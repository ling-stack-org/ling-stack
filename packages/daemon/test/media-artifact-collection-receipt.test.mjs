import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, digestHarnessToolValue } from "../../core/dist/index.js";

const collector = await import(process.env.LING_MEDIA_COLLECTOR_MODULE
  ? pathToFileURL(process.env.LING_MEDIA_COLLECTOR_MODULE).href : new URL("../dist/features/media/artifact-collector.js", import.meta.url).href);
const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const candidate = (index = 0) => ({ type: "image", title: `Image ${index + 1}`, pathHint: "same.png",
  contentBytes: Uint8Array.from([1, 2, 3, index + 4]), contentType: "image/png", bytesSha256: "f".repeat(64), safe: true });

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-collection-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const at = now();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "parent-runtime", runnerId: "pi", status: "started", now: at });
  const source = { runId: "run", ...toRuntimeAttemptFence(attempt) };
  const thread = store.createLingThread({ kind: "conversation", title: "Collection", objective: "Exact bytes" }, at);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Generate", userInstruction: "Generate",
    idempotencyKey: "turn", payload: { body: "Generate", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
  store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId,
    taskId: "task", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit("run", unit.id, at); store.markRunStarted("run", at);
  const target = { kind: "normal", conversationId: "conversation" }, intentDigest = "a".repeat(64);
  const created = store.createOrReuseConversationMediaJob({ runId: "run", toolCallId: "media-call", target,
    idempotencyKey: "job", mediaJob: { providerPresetId: "image", operation: "image_generate", prompt: "Test" },
    executionAdmission: { schemaVersion: 1, source, requestDigest: intentDigest } }, now());
  const parent = store.admitHostOperation({ operationId: "parent", source, kind: "media", toolCallId: "media-call" });
  const transport = store.admitHostOperation({ operationId: "transport", source, kind: "media", toolCallId: "media-call",
    parentOperationId: "parent", producerId: "media-http-chain" });
  const prepared = { schemaVersion: 1, executionId: "execution", mediaJobId: created.mediaJob.id,
    mediaChildWorkUnitId: created.workUnit.id, executionGenerationId: "generation", source, toolCallId: "media-call",
    protocol: "image_response_v1", adapterId: "adapter", toolName: "image_generate", operation: "image_generate",
    intentDigest, targetDigest: digestHarnessToolValue(target), namespaceDigest: "b".repeat(64) };
  const sealed = store.createArtifact({ runId: "run", type: "json", path: "media/prepared.json", createdAt: now(), sealedPayload: prepared });
  const { schemaVersion: _s, source: _source, toolCallId: _call, ...input } = prepared;
  const ticket = store.prepareHostMediaExecution(parent, transport, { ...input, preparedRequestArtifactId: sealed.id,
    preparedRequestDigest: sealed.contentSha256, preparedAt: now() });
  const childAttempt = store.createWorkUnitAttempt({ workUnitId: created.workUnit.id, attemptNumber: 1,
    runtimeInstanceId: "child-runtime", runnerId: "media", status: "started", now: now() });
  const childFence = toRuntimeAttemptFence(childAttempt);
  store.transitionWorkUnitStatus({ ...childFence, event: "claim", actor: "system", now: now() });
  store.transitionWorkUnitStatus({ ...childFence, event: "runner_started", actor: "runner", now: now() });
  store.bindHostMediaChildExecution(ticket, childFence);
  const execution = store.getHostMediaExecution(ticket.executionId);
  const descriptor = index => Object.freeze({ schemaVersion: 1, routeDigest: "c".repeat(64), responseBodySha256: hash("actual response"),
    candidateIndex: index, descriptorKind: "response_item", pathHint: "same.png" });
  const context = { executionId: execution.executionId, executionGenerationId: execution.executionGenerationId,
    source, childFence, getRemoteDescriptor: (_candidate, index) => descriptor(index) };
  const base = { schemaVersion: 1, executionId: execution.executionId, executionIdentityDigest: execution.identityDigest,
    mediaJobId: execution.mediaJobId, executionGenerationId: execution.executionGenerationId, source, childFence,
    namespaceDigest: execution.namespaceDigest, protocol: execution.protocol };
  return { cwd, store, other, job: created.mediaJob, ticket, context, base, descriptor };
}

function collect(f, candidates = [candidate()], context = f.context) {
  return collector.collectMediaJobArtifacts(f.store, f.job, candidates, now(), [], context);
}
function collectionError(action) {
  let caught;
  try { action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof collector.MediaArtifactCollectionError, "must throw the structured partial collection error");
  return caught;
}
function patchWrite(t, implementation) {
  const mutableFs = fs.default;
  const original = mutableFs.writeFileSync;
  mutableFs.writeFileSync = (...args) => implementation(original, ...args);
  syncBuiltinESMExports();
  t.after(() => { mutableFs.writeFileSync = original; syncBuiltinESMExports(); });
}

test("receipt collector hashes persisted bytes, separates metadata seal, and binds the exact generation", async t => {
  const f = await fixture(t), input = candidate(), result = collect(f, [input]);
  assert.equal(result.artifacts.length, 1); assert.equal(result.manifestItems.length, 1);
  const artifact = f.other.getArtifact(result.artifacts[0].id), item = result.manifestItems[0];
  const persisted = fs.readFileSync(join(f.store.paths.artifactsDir, artifact.path));
  assert.deepEqual(persisted, Buffer.from(input.contentBytes));
  assert.equal(item.bytesSha256, hash(persisted)); assert.notEqual(item.bytesSha256, input.bytesSha256);
  assert.equal(item.remoteDescriptorDigest, hash(JSON.stringify(f.descriptor(0))));
  assert.notEqual(artifact.contentSha256, item.bytesSha256);
  assert.equal(artifact.contentSha256, hash(JSON.stringify(artifact.sealedPayload)));
  assert.deepEqual(artifact.sealedPayload, { schemaVersion: 1, kind: "media_bytes_v1", executionId: "execution", mediaJobId: f.job.id,
    path: artifact.path, type: "image", contentType: "image/png", sizeBytes: persisted.length,
    bytesSha256: item.bytesSha256, remoteDescriptorDigest: item.remoteDescriptorDigest, collectedAt: artifact.createdAt });
  assert.ok(artifact.path.includes(`generation-${hash("generation")}`));
  assert.ok(artifact.path.includes(`execution-${hash("execution")}`));
  // Completion must precede persistence even when the clock advances between reads.
  const completedAt = now();
  const manifest = f.store.createArtifact({ runId: "run", type: "json", path: "media/manifest.json", createdAt: now(),
    sealedPayload: { ...f.base, kind: "media_manifest_v1", outcome: "collected", items: result.manifestItems, completedAt } });
  f.store.recordHostMediaArtifactManifest(f.ticket, manifest.id);
  assert.equal(f.other.getHostMediaExecution("execution").manifestArtifactId, manifest.id);
  assert.equal(f.other.getHostOperation("parent").phase, "admitted", "collection must not mint a launch or settlement");
});

for (const [label, change] of [
  ["job", f => ({ job: { ...f.job, id: "foreign-job" } })],
  ["workspace", f => ({ job: { ...f.job, workspaceId: "foreign-workspace" } })],
  ["operation", f => ({ job: { ...f.job, operation: "video_generate" } })],
  ["source", f => ({ context: { ...f.context, source: { ...f.context.source, attemptId: "foreign-attempt" } } })],
  ["child", f => ({ context: { ...f.context, childFence: { ...f.context.childFence, attemptId: "foreign-child" } } })],
  ["generation", f => ({ context: { ...f.context, executionGenerationId: "foreign-generation" } })],
  ["execution", f => ({ context: { ...f.context, executionId: "foreign-execution" } })],
]) test(`receipt collector rejects mismatched ${label} before any media write`, async t => {
  const f = await fixture(t), altered = change(f);
  const error = collectionError(() => collector.collectMediaJobArtifacts(f.store, altered.job ?? f.job, [candidate()], now(), [], altered.context ?? f.context));
  assert.equal(error.unconfirmedWrite, false); assert.equal(error.artifacts.length, 0);
  assert.equal(f.other.listMediaJobArtifacts(f.job.id).length, 0);
});

test("second descriptor failure preserves the first SQLite artifact without claiming an unknown write", async t => {
  const f = await fixture(t);
  const error = collectionError(() => collect(f, [candidate(), candidate(1)], { ...f.context,
    getRemoteDescriptor: (_candidate, index) => index === 0 ? f.descriptor(0) : undefined }));
  assert.equal(error.failedIndex, 1); assert.equal(error.artifacts.length, 1); assert.equal(error.manifestItems.length, 1);
  assert.equal(error.unconfirmedWrite, false);
  assert.deepEqual(error.artifacts, f.other.listMediaJobArtifacts(f.job.id));
  assert.ok(Object.isFrozen(error.artifacts)); assert.ok(Object.isFrozen(error.manifestItems));
});

test("receipt collector snapshots candidate getters once before matching and writing", async t => {
  const f = await fixture(t), expected = Buffer.from([1, 2, 3, 4]);
  let reads = 0;
  const input = { type: "image", title: "Pinned candidate", contentType: "image/png",
    get contentBytes() { return ++reads === 1 ? expected : Buffer.from("changed getter bytes"); } };
  const result = collect(f, [input], { ...f.context, getRemoteDescriptor: (snapshot, index) => {
    assert.deepEqual(Buffer.from(snapshot.contentBytes), expected);
    return f.descriptor(index);
  } });
  assert.equal(reads, 1);
  assert.deepEqual(fs.readFileSync(join(f.store.paths.artifactsDir, result.artifacts[0].path)), expected);
});

test("receipt collector descriptor callback cannot mutate the exact matched bytes used for write", async t => {
  const f = await fixture(t), input = candidate(), expected = Buffer.from(input.contentBytes);
  const result = collect(f, [input], { ...f.context, getRemoteDescriptor: (snapshot, index) => {
    assert.deepEqual(Buffer.from(snapshot.contentBytes), expected);
    input.contentBytes.fill(9);
    snapshot.contentBytes.fill(8);
    return f.descriptor(index);
  } });
  const persisted = fs.readFileSync(join(f.store.paths.artifactsDir, result.artifacts[0].path));
  assert.deepEqual(persisted, expected);
  assert.equal(result.manifestItems[0].bytesSha256, hash(expected));
});

for (const [label, descriptor] of [
  ["missing", () => undefined],
  ["wrong index", () => ({ schemaVersion: 1, routeDigest: "c".repeat(64), responseBodySha256: "d".repeat(64), candidateIndex: 9, descriptorKind: "download" })],
  ["caller hash", () => ({ schemaVersion: 1, routeDigest: "c".repeat(64), responseBodySha256: "bad", candidateIndex: 0, descriptorKind: "download" })],
  ["private extras", () => ({ schemaVersion: 1, routeDigest: "c".repeat(64), responseBodySha256: "d".repeat(64), candidateIndex: 0, descriptorKind: "download", apiKey: "private-test-value" })],
]) test(`receipt collector rejects ${label} descriptor before writing`, async t => {
  const f = await fixture(t), error = collectionError(() => collect(f, [candidate()], { ...f.context, getRemoteDescriptor: descriptor }));
  assert.equal(error.unconfirmedWrite, false); assert.equal(f.other.listMediaJobArtifacts(f.job.id).length, 0);
});

test("second physical write failure retains confirmed partial artifacts and unknown-write state", async t => {
  const f = await fixture(t); let writes = 0;
  patchWrite(t, (original, ...args) => { writes++; if (writes === 2) throw new Error("actual fs failure"); return original(...args); });
  const error = collectionError(() => collect(f, [candidate(), candidate(1)]));
  assert.equal(error.failedIndex, 1); assert.equal(error.artifacts.length, 1); assert.equal(error.manifestItems.length, 1);
  assert.equal(error.unconfirmedWrite, true); assert.equal(f.other.listMediaJobArtifacts(f.job.id).length, 1);
});

test("write-then-throw never discards the actual file or reports a safe empty collection", async t => {
  const f = await fixture(t);
  patchWrite(t, (original, ...args) => { original(...args); throw new Error("postwrite error"); });
  const error = collectionError(() => collect(f));
  assert.equal(error.artifacts.length, 0); assert.equal(error.unconfirmedWrite, true);
  assert.equal(fs.readFileSync(join(f.store.paths.artifactsDir, error.unconfirmedPath)).length, 4);
});

test("createArtifact precommit failure preserves first row and flags the unconfirmed second write", async t => {
  const f = await fixture(t), original = f.store.createArtifact.bind(f.store); let calls = 0;
  f.store.createArtifact = input => { if (++calls === 2) throw new Error("COMMIT failure before row"); return original(input); };
  const error = collectionError(() => collect(f, [candidate(), candidate(1)]));
  assert.equal(error.artifacts.length, 1); assert.equal(error.unconfirmedWrite, true);
  assert.ok(error.unconfirmedArtifactId); assert.equal(f.other.getArtifact(error.unconfirmedArtifactId), undefined);
  assert.equal(fs.readFileSync(join(f.store.paths.artifactsDir, error.unconfirmedPath)).length, 4);
});

test("postcommit createArtifact throw reads the exact preassigned id and includes its committed row", async t => {
  const f = await fixture(t), original = f.store.createArtifact.bind(f.store); let calls = 0, exactId;
  f.store.createArtifact = input => { const result = original(input); if (++calls === 2) { exactId = input.id; throw new Error("after SQLite commit"); } return result; };
  const error = collectionError(() => collect(f, [candidate(), candidate(1)]));
  assert.ok(exactId); assert.equal(error.artifacts.length, 2); assert.equal(error.manifestItems.length, 2);
  assert.equal(error.artifacts[1].id, exactId); assert.equal(error.unconfirmedWrite, false);
  assert.deepEqual(new Set(error.artifacts.map(row => row.id)), new Set(f.other.listMediaJobArtifacts(f.job.id).map(row => row.id)));
});

test("failed readback after a committed row stays unknown and exposes exact id, never guesses latest", async t => {
  const f = await fixture(t), create = f.store.createArtifact.bind(f.store); let exactId;
  f.store.createArtifact = input => { exactId = input.id; create(input); throw new Error("postcommit exception"); };
  f.store.getArtifact = () => { throw new Error("readback unavailable"); };
  const error = collectionError(() => collect(f));
  assert.equal(error.artifacts.length, 0); assert.equal(error.unconfirmedWrite, true);
  assert.equal(error.unconfirmedArtifactId, exactId); assert.ok(f.other.getArtifact(exactId));
});

test("old job artifacts cannot be adopted into a new exact manifest or overwritten", async t => {
  const f = await fixture(t), old = f.store.createArtifact({ mediaJobId: f.job.id, type: "image", path: "old/result.png", createdAt: now() });
  const error = collectionError(() => collect(f));
  assert.equal(error.unconfirmedWrite, false); assert.equal(error.artifacts.length, 0);
  assert.deepEqual(f.other.listMediaJobArtifacts(f.job.id).map(row => row.id), [old.id]);
});

test("a partial collection manifest includes every confirmed artifact and passes the actual Core validator", async t => {
  const f = await fixture(t), create = f.store.createArtifact.bind(f.store); let calls = 0;
  f.store.createArtifact = input => { const row = create(input); if (++calls === 2) throw new Error("postcommit collection failed"); return row; };
  const error = collectionError(() => collect(f, [candidate(), candidate(1)]));
  assert.equal(error.unconfirmedWrite, false); assert.equal(error.manifestItems.length, 2);
  const completedAt = now();
  const manifest = create({ runId: "run", type: "json", path: "media/partial-manifest.json", createdAt: now(),
    sealedPayload: { ...f.base, kind: "media_manifest_v1", outcome: "collection_failed", items: error.manifestItems, completedAt } });
  f.store.recordHostMediaArtifactManifest(f.ticket, manifest.id);
  assert.equal(f.other.getHostMediaExecution("execution").manifestArtifactId, manifest.id);
});

test("actual file bytes changed during the write cannot be sealed using the candidate or caller hash", async t => {
  const f = await fixture(t);
  patchWrite(t, (original, path, content, options) => { original(path, Buffer.from("different disk bytes"), options); });
  const error = collectionError(() => collect(f));
  assert.equal(error.unconfirmedWrite, true); assert.equal(error.artifacts.length, 0);
  assert.equal(f.other.listMediaJobArtifacts(f.job.id).length, 0);
  assert.equal(fs.readFileSync(join(f.store.paths.artifactsDir, error.unconfirmedPath), "utf8"), "different disk bytes");
});

test("receipt path uses exclusive create and never follows a pre-existing output symlink", async t => {
  const f = await fixture(t), outside = join(f.cwd, "untouched.txt");
  fs.writeFileSync(outside, "outside original");
  const path = join(f.store.paths.artifactsDir, "media_jobs", f.job.id, `generation-${hash("generation")}`,
    `execution-${hash("execution")}`, "001-same.png");
  fs.mkdirSync(dirname(path), { recursive: true }); fs.symlinkSync(outside, path);
  const error = collectionError(() => collect(f));
  assert.equal(error.unconfirmedWrite, true); assert.equal(error.artifacts.length, 0);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside original");
});

test("receipt collection rejects a symlinked generation directory before a media write", async t => {
  const f = await fixture(t), outside = join(f.cwd, "outside");
  const parent = join(f.store.paths.artifactsDir, "media_jobs", f.job.id);
  fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(parent, `generation-${hash("generation")}`));
  const error = collectionError(() => collect(f));
  assert.equal(error.unconfirmedWrite, false); assert.equal(error.artifacts.length, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("descriptor callback cannot mutate the generation between identity readback and physical write", async t => {
  const f = await fixture(t), context = { ...f.context };
  context.getRemoteDescriptor = (_candidate, index) => { context.executionGenerationId = "mutated"; return f.descriptor(index); };
  const error = collectionError(() => collect(f, [candidate()], context));
  assert.equal(error.unconfirmedWrite, false); assert.equal(f.other.listMediaJobArtifacts(f.job.id).length, 0);
});

test("receipt collection rejects a future timestamp and cannot invent getHostMediaExecution from caller IDs", async t => {
  const f = await fixture(t), future = new Date(Date.now() + 86_400_000).toISOString();
  const error = collectionError(() => collector.collectMediaJobArtifacts(f.store, f.job, [candidate()], future, [], f.context));
  assert.equal(error.unconfirmedWrite, false);
  const read = f.store.getHostMediaExecution; f.store.getHostMediaExecution = undefined;
  const missing = collectionError(() => collect(f));
  assert.equal(missing.unconfirmedWrite, false); assert.equal(missing.artifacts.length, 0);
  f.store.getHostMediaExecution = read;
});

test("metadata row mismatch cannot be replaced with a latest artifact or confirmed as partial", async t => {
  const f = await fixture(t), get = f.store.getArtifact.bind(f.store);
  f.store.getArtifact = id => { const row = get(id); return row ? { ...row, path: `other/${basename(row.path)}` } : undefined; };
  const error = collectionError(() => collect(f));
  assert.equal(error.unconfirmedWrite, true); assert.equal(error.artifacts.length, 0);
  assert.ok(f.other.getArtifact(error.unconfirmedArtifactId));
});

test("receipt text fact hashes the actual redacted UTF-8 file, not the model's source string", async t => {
  const f = await fixture(t), content = '{"中文":"fixture-secret"}';
  const result = collector.collectMediaJobArtifacts(f.store, f.job, [{ type: "json", title: "metadata", content }], now(), ["fixture-secret"], f.context);
  const item = result.manifestItems[0], bytes = fs.readFileSync(join(f.store.paths.artifactsDir, item.path));
  assert.ok(!bytes.toString("utf8").includes("fixture-secret"));
  assert.equal(item.bytesSha256, hash(bytes)); assert.notEqual(item.bytesSha256, hash(content));
  assert.equal(item.sizeBytes, bytes.length);
});

test("five-argument legacy collector remains unsealed and text secret redaction remains byte-exact", async t => {
  const f = await fixture(t), at = now();
  const artifacts = collector.createMediaJobArtifacts(f.store, f.job, [{ type: "json", title: "metadata", content: '{"key":"fixture-secret"}' }], at, ["fixture-secret"]);
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0].sealedPayload, undefined);
  assert.equal(artifacts[0].contentSha256, undefined);
  assert.ok(!artifacts[0].path.includes("generation-"));
  assert.ok(!fs.readFileSync(join(f.store.paths.artifactsDir, artifacts[0].path), "utf8").includes("fixture-secret"));
});

test("legacy second-row failure also keeps the first actual SQLite artifact in a structured error", async t => {
  const f = await fixture(t), create = f.store.createArtifact.bind(f.store); let calls = 0, caught;
  f.store.createArtifact = input => { if (++calls === 2) throw new Error("second real row failed"); return create(input); };
  try { collector.createMediaJobArtifacts(f.store, f.job, [candidate(), candidate(1)], now()); } catch (error) { caught = error; }
  assert.equal(f.other.listMediaJobArtifacts(f.job.id).length, 1, "the first write really exists even if the second metadata write fails");
  assert.ok(caught instanceof collector.MediaArtifactCollectionError);
  assert.equal(caught.artifacts.length, 1); assert.equal(caught.unconfirmedWrite, true);
});

test("a second candidate's throwing content getter retains committed partial in both collection paths", async t => {
  const cases = [];
  for (const receipt of [false, true]) {
    const f = await fixture(t), second = { type: "image", title: "Explosive getter" }; let caught;
    Object.defineProperty(second, "content", { get() { throw new Error("candidate content getter failed"); } });
    try {
      if (receipt) collect(f, [candidate(), second]);
      else collector.createMediaJobArtifacts(f.store, f.job, [candidate(), second], now());
    } catch (error) { caught = error; }
    assert.equal(f.other.listMediaJobArtifacts(f.job.id).length, 1, "the first row is actually committed before the getter fails");
    t.diagnostic(`receipt=${receipt}, first committed=1, error=${caught?.name}, partial=${caught?.artifacts?.length ?? "missing"}`);
    cases.push({ f, receipt, caught });
  }
  for (const { f, receipt, caught } of cases) {
    assert.ok(caught instanceof collector.MediaArtifactCollectionError);
    assert.equal(caught.failedIndex, 1); assert.equal(caught.unconfirmedWrite, false);
    assert.equal(caught.artifacts.length, 1); assert.equal(caught.manifestItems.length, receipt ? 1 : 0);
    assert.equal(caught.artifacts[0].id, f.other.listMediaJobArtifacts(f.job.id)[0].id);
    assert.equal(caught.cause.message, "candidate content getter failed");
  }
});

test("null, undefined and sparse second candidates retain committed partial in both collection paths", async t => {
  const cases = [];
  for (const receipt of [false, true]) {
    for (const malformed of [null, undefined, "sparse", 42, {}, []]) {
      const f = await fixture(t), inputs = [candidate(), malformed]; let caught;
      if (malformed === "sparse") delete inputs[1];
      try {
        if (receipt) collect(f, inputs);
        else collector.createMediaJobArtifacts(f.store, f.job, inputs, now());
      } catch (error) { caught = error; }
      assert.equal(f.other.listMediaJobArtifacts(f.job.id).length, 1);
      t.diagnostic(`receipt=${receipt}, second=${JSON.stringify(malformed)}, first committed=1, error=${caught?.name ?? "missing"}`);
      cases.push({ f, receipt, malformed, caught });
    }
  }
  for (const { f, receipt, malformed, caught } of cases) {
    assert.ok(caught instanceof collector.MediaArtifactCollectionError, `receipt=${receipt}, second=${JSON.stringify(malformed)}`);
    assert.equal(caught.failedIndex, 1); assert.equal(caught.unconfirmedWrite, false);
    assert.equal(caught.artifacts.length, 1); assert.equal(caught.manifestItems.length, receipt ? 1 : 0);
    assert.equal(caught.artifacts[0].id, f.other.listMediaJobArtifacts(f.job.id)[0].id);
  }
});
