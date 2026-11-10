import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createStreamCapture, createSyntheticStreamCapture, toStreamSummary } from "../dist/features/runs/unified-exec-output.js";
import { semanticToolResult } from "../dist/features/runs/execution-loop-semantic-evidence.js";
import { renderUnifiedExecModelOutput } from "../dist/features/runs/unified-exec-model-output.js";

// Pure capture/projection controls, not real-process, Store or sandbox evidence.
// execution-loop-full-output-progress owns the independent real-producer C3 case.
const digest = text => createHash("sha256").update(text, "utf8").digest("hex");
const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function capture(chunks, { stream = "stdout", secrets = [] } = {}) {
  const events = [];
  const output = createStreamCapture(stream, "identity_call", (type, data) => events.push({ type, data }), secrets);
  for (const chunk of chunks) output.ingest(chunk);
  output.flush();
  return { output, snapshot: output.snapshot(), text: events.map(event => event.data.partialResult.text).join("") };
}

function handled(call, stdoutText = "same\n", stderrText = "") {
  const stdout = createSyntheticStreamCapture(stdoutText, []);
  const stderr = createSyntheticStreamCapture(stderrText, []);
  const resultId = `artifact_identity_run_${call}_unified_exec_result`;
  const result = {
    status: "succeeded", runId: "identity_run", taskId: "identity_task", toolCallId: call,
    cwd: "/owned", command: { kind: "shell", command: "printf same", shell: "bash" },
    environmentSummary: { mode: "inherit_minimal", cwd: "/owned", keys: ["PATH"], redactedKeys: [] },
    startedAt: "2026-10-15T12:00:00.000Z", endedAt: "2026-10-15T12:00:01.000Z",
    durationMs: 10, exitCode: 0, timedOut: false, cancelled: false,
    stdout: toStreamSummary(stdout), stderr: toStreamSummary(stderr),
    artifacts: [{ artifactId: resultId, role: "result", contentType: "application/json",
      sizeBytes: 500, redacted: false, truncated: false }],
  };
  for (const [role, captured] of [["stdout", stdout], ["stderr", stderr]]) {
    if (!captured.artifactContent) continue;
    const artifactId = `artifact_random_${call}_${role}`;
    result[role].artifactId = artifactId;
    result.artifacts.push({ artifactId, role, contentType: "text/plain; charset=utf-8",
      sizeBytes: captured.artifactBytes, redacted: captured.redacted, truncated: captured.artifactTruncated });
  }
  return { content: [{ type: "text", text: renderUnifiedExecModelOutput(result) }],
    details: { unifiedExec: result }, isError: false };
}

const semantic = value => semanticToolResult("bash", value.details.unifiedExec.toolCallId, value);

test("A24 output identity is the standard empty SHA256 in both capture producers", () => {
  const streamed = capture([]).snapshot;
  const synthetic = createSyntheticStreamCapture("", []);
  assert.equal(streamed.contentSha256, emptyDigest);
  assert.equal(synthetic.contentSha256, emptyDigest);
  assert.equal(toStreamSummary(streamed).contentSha256, emptyDigest);
  assert.equal(Object.hasOwn(streamed, "contentHash"), false, "snapshot must not expose mutable Hash state");
});

test("A24 output identity covers UTF-8 scalars under every byte split and single-byte chunks", () => {
  const text = "中文😀é\nSecond 行\n";
  const bytes = Buffer.from(text);
  for (let split = 0; split <= bytes.length; split++) {
    const actual = capture([bytes.subarray(0, split), bytes.subarray(split)]);
    assert.equal(actual.snapshot.contentSha256, digest(text), `UTF-8 split ${split}`);
    assert.equal(actual.text, text);
  }
  assert.equal(capture([...bytes].map(byte => Buffer.from([byte]))).snapshot.contentSha256, digest(text));
});

test("A24 output identity hashes redacted text, never the original known secret", () => {
  const secret = "identity-fixture-secret-不是密钥";
  const prefix = "p".repeat(300);
  const text = `${prefix} ${secret} 😀 tail`;
  const bytes = Buffer.from(text);
  const synthetic = createSyntheticStreamCapture(text, [secret]);
  assert.equal(synthetic.redacted, true);
  assert.equal(synthetic.artifactContent.includes(secret), false);
  assert.notEqual(synthetic.contentSha256, digest(text));
  assert.equal(synthetic.contentSha256, digest(synthetic.artifactContent));
  for (let split = 0; split <= bytes.length; split++) {
    const actual = capture([bytes.subarray(0, split), bytes.subarray(split)], { secrets: [secret] });
    assert.equal(actual.text.includes(secret), false);
    assert.equal(actual.snapshot.contentSha256, synthetic.contentSha256, `redacted split ${split}`);
    assert.equal(actual.snapshot.contentSha256, digest(actual.text));
  }
});

test("A24 repeated snapshots do not finalize the live digest or mutate prior snapshots", () => {
  const output = createStreamCapture("stdout", "snapshot_call", () => {}, []);
  output.ingest(Buffer.from("first\n"));
  const first = output.snapshot();
  assert.equal(first.contentSha256, digest("first\n"));
  assert.deepEqual(output.snapshot(), first);
  output.ingest(Buffer.from("second\n"));
  assert.equal(output.snapshot().contentSha256, digest("first\nsecond\n"));
  assert.equal(first.contentSha256, digest("first\n"));
  output.flush();
  const complete = output.snapshot();
  assert.equal(complete.contentSha256, digest("first\nsecond\n"));
  output.flush();
  assert.deepEqual(output.snapshot(), complete, "a second flush cannot duplicate hashed bytes");
});

test("A24 incomplete final UTF-8 bytes hash the decoded replacement, with raw byte accounting intact", () => {
  const actual = capture([Buffer.from([0xe4, 0xb8])]);
  assert.equal(actual.snapshot.byteCount, 2);
  assert.equal(actual.snapshot.contentSha256, digest("�"));
  assert.equal(actual.text, "�");
});

test("A24 stdout and stderr hash states remain independent during interleaved byte fragments", () => {
  const out = createStreamCapture("stdout", "shared_call", () => {}, []);
  const err = createStreamCapture("stderr", "shared_call", () => {}, []);
  const stdout = Buffer.from("out😀\n"), stderr = Buffer.from("err中\n");
  out.ingest(stdout.subarray(0, 4));
  err.ingest(stderr.subarray(0, 4));
  out.ingest(stdout.subarray(4));
  err.ingest(stderr.subarray(4));
  err.flush(); out.flush();
  assert.equal(out.snapshot().contentSha256, digest("out😀\n"));
  assert.equal(err.snapshot().contentSha256, digest("err中\n"));
  assert.notEqual(out.snapshot().contentSha256, err.snapshot().contentSha256);
});

test("A24 digest covers equal-length tail changes beyond both preview and 2 MiB artifact caps", () => {
  const prefix = "x".repeat(2 * 1024 * 1024 + 512);
  const left = `${prefix}LEFT\n`, right = `${prefix}RITE\n`;
  const a = capture([Buffer.from(left)]).snapshot;
  const b = capture([Buffer.from(right)]).snapshot;
  assert.equal(a.byteCount, b.byteCount);
  assert.equal(a.preview, b.preview);
  assert.equal(a.artifactContent, b.artifactContent);
  assert.equal(a.previewTruncated, true);
  assert.equal(a.artifactTruncated, true);
  assert.equal(a.contentSha256, digest(left));
  assert.equal(b.contentSha256, digest(right));
  assert.notEqual(a.contentSha256, b.contentSha256);
  assert.equal(createSyntheticStreamCapture(left, []).contentSha256, a.contentSha256);
  assert.equal(createSyntheticStreamCapture(right, []).contentSha256, b.contentSha256);
});

test("A24 complete output identity is independent of chunking beyond the storage cap", () => {
  const text = "中😀line\n".repeat(180000);
  const bytes = Buffer.from(text);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 16381) chunks.push(bytes.subarray(offset, offset + 16381));
  const streamed = capture(chunks).snapshot;
  const synthetic = createSyntheticStreamCapture(text, []);
  assert.equal(streamed.artifactTruncated, true);
  assert.equal(streamed.contentSha256, digest(text));
  assert.equal(streamed.contentSha256, synthetic.contentSha256);
});

test("A24 semantic result keeps complete output identity when equal previews have different tails", () => {
  const prefix = "x".repeat(9000);
  const first = handled("first", `${prefix}LEFT\n`);
  const same = handled("same", `${prefix}LEFT\n`);
  const changed = handled("changed", `${prefix}RITE\n`);
  assert.equal(first.details.unifiedExec.stdout.preview, changed.details.unifiedExec.stdout.preview);
  assert.equal(first.details.unifiedExec.stdout.byteCount, changed.details.unifiedExec.stdout.byteCount);
  assert.deepEqual(semantic(first), semantic(same), "producer identities alone cannot mint progress");
  assert.notDeepEqual(semantic(first), semantic(changed), "complete redacted tail changes remain progress");
  assert.equal(semantic(first).details.unifiedExec.stdout.contentSha256, digest(`${prefix}LEFT\n`));
  for (const mutate of [
    value => { value.details.unifiedExec.status = "failed"; },
    value => { value.details.unifiedExec.exitCode = 7; },
    value => { value.details.unifiedExec.stdout.userMetadata = { id: "unknown-semantic" }; },
  ]) {
    const other = structuredClone(first); mutate(other);
    assert.notDeepEqual(semantic(first), semantic(other), "digest does not replace status or unknown fields");
  }
});

test("A24 truncated historical or malformed digest results conservatively preserve the whole payload", () => {
  const legacy = handled("legacy", "x".repeat(9000));
  delete legacy.details.unifiedExec.stdout.contentSha256;
  assert.equal(semantic(legacy), legacy, "legacy preview cannot prove full-output equality");
  for (const contentSha256 of ["", "not-a-digest", "f".repeat(63), "F".repeat(64), 1]) {
    const invalid = handled("invalid"); invalid.details.unifiedExec.stdout.contentSha256 = contentSha256;
    assert.equal(semantic(invalid), invalid, "unknown digest shape cannot enable metadata removal");
  }
  const untruncatedLegacy = handled("untruncated");
  delete untruncatedLegacy.details.unifiedExec.stdout.contentSha256;
  assert.notEqual(semantic(untruncatedLegacy), untruncatedLegacy, "complete historical preview remains supported");
});

test("A24 combined, duplicate or unbound artifact refs preserve unknown identity rather than dropping it", () => {
  for (const mutate of [
    value => { value.details.unifiedExec.artifacts.push({ artifactId: "combined-unknown", role: "combined",
      contentType: "text/plain", sizeBytes: 5, redacted: false, truncated: false }); },
    value => { value.details.unifiedExec.artifacts.push(structuredClone(value.details.unifiedExec.artifacts[1])); },
    value => { value.details.unifiedExec.artifacts[1].artifactId = "unbound-stdout"; },
    value => { delete value.details.unifiedExec.stdout.artifactId; },
  ]) {
    const value = handled("unknown"); mutate(value);
    assert.equal(semantic(value), value, "unknown artifact relation requires whole-payload fallback");
  }
});
