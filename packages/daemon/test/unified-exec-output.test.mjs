import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStreamCapture, createSyntheticStreamCapture, toStreamSummary } from "../dist/features/runs/unified-exec-output.js";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

function capture(chunks, { stream = "stdout", toolCallId = "fixture_tool", secrets = [] } = {}) {
  const events = [];
  const output = createStreamCapture(stream, toolCallId, (type, data) => events.push({ type, data }), secrets);
  for (const chunk of chunks) output.ingest(chunk);
  output.flush();
  return { output, snapshot: output.snapshot(), chunks: events.map(event => event.data.partialResult) };
}

function assertWholeEventText(chunks, expected) {
  assert.equal(chunks.map(chunk => chunk.text).join(""), expected);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.text.isWellFormed(), true, "each independently serialized event is valid Unicode");
    assert.equal(JSON.parse(JSON.stringify(chunk)).text, chunk.text);
    assert.ok(chunk.byteCount <= 4096);
    assert.equal(chunk.byteCount, Buffer.byteLength(chunk.text));
    assert.equal(chunk.sequence, index + 1);
  }
}

test("output capture decodes every possible split of UTF-8 text without corrupting evidence", () => {
  const text = "中文😀é\nSecond 行";
  const bytes = Buffer.from(text);
  for (let split = 0; split <= bytes.length; split += 1) {
    const f = capture([bytes.subarray(0, split), bytes.subarray(split)]);
    assert.equal(f.snapshot.byteCount, bytes.length);
    assert.equal(f.snapshot.preview, text);
    assert.equal(f.snapshot.artifactContent, text);
    assertWholeEventText(f.chunks, text);
  }
  const singleBytes = capture([...bytes].map(byte => Buffer.from([byte])));
  assert.equal(singleBytes.snapshot.artifactContent, text);
});

test("output capture does not split surrogate pairs at the redaction carry boundary", () => {
  const text = "abc😀" + "z".repeat(255);
  const f = capture([Buffer.from(text)]);
  assert.equal(f.snapshot.artifactContent, text);
  assertWholeEventText(f.chunks, text);
});

test("output event chunking preserves emoji at the 4 KiB boundary", () => {
  const text = "a".repeat(4093) + "😀" + "z".repeat(1000);
  const f = capture([Buffer.from(text)]);
  assertWholeEventText(f.chunks, text);
});

for (const [name, limit, field, truncated] of [
  ["preview", 8192, "preview", "previewTruncated"],
  ["artifact", 2 * 1024 * 1024, "artifactContent", "artifactTruncated"],
]) {
  for (const scalar of ["😀", "中", "é"]) {
    test(`${name} uses a whole-character UTF-8 prefix for ${scalar}`, () => {
      const prefix = "a".repeat(limit - Buffer.byteLength(scalar) + 1);
      const first = prefix + scalar + "z".repeat(256);
      const f = capture([Buffer.from(first), Buffer.from("Later ASCII must not fill a truncated gap.".repeat(16))]);
      assert.equal(f.snapshot[field].isWellFormed(), true);
      assert.ok(f.snapshot[field] === prefix, "the bounded value is the exact whole-character prefix");
      assert.equal(f.snapshot[truncated], true);
      assert.ok(Buffer.byteLength(f.snapshot[field]) <= limit);
      assert.ok((first + "Later ASCII").startsWith(f.snapshot[field]));
    });
  }
}

test("exact byte limits retain complete characters and do not claim truncation", () => {
  const text = "😀".repeat(2048);
  const f = capture([Buffer.from(text)]);
  assert.equal(f.snapshot.preview, text);
  assert.equal(f.snapshot.previewBytes, 8192);
  assert.equal(f.snapshot.previewTruncated, false);
  assert.equal(f.snapshot.artifactTruncated, false);
  assertWholeEventText(f.chunks, text);
});

test("stdout/stderr decoders are isolated even with interleaved incomplete characters", () => {
  const events = [];
  const out = createStreamCapture("stdout", "call_out", (type, data) => events.push({ type, data }), []);
  const err = createStreamCapture("stderr", "call_err", (type, data) => events.push({ type, data }), []);
  const left = Buffer.from("😀"), right = Buffer.from("中");
  out.ingest(left.subarray(0, 2));
  err.ingest(right.subarray(0, 1));
  out.ingest(left.subarray(2));
  err.ingest(right.subarray(1));
  err.flush();
  out.flush();
  assert.equal(out.snapshot().preview, "😀");
  assert.equal(err.snapshot().preview, "中");
  assert.equal(events.find(event => event.data.toolCallId === "call_out").data.partialResult.stream, "stdout");
  assert.equal(events.find(event => event.data.toolCallId === "call_err").data.partialResult.stream, "stderr");
});

test("an incomplete final UTF-8 sequence is finalized once with accurate raw byte count", () => {
  const f = capture([Buffer.from([0xe4, 0xb8])]);
  assert.equal(f.snapshot.byteCount, 2);
  assert.equal(f.snapshot.preview, "�");
  assert.equal(f.snapshot.previewBytes, 3);
  const before = f.output.snapshot();
  f.output.flush();
  assert.deepEqual(f.output.snapshot(), before);
  assert.equal(f.chunks.length, 1);
});

test("empty output stays empty and stream summary keeps the existing contract", () => {
  const f = capture([]);
  assert.deepEqual(toStreamSummary(f.snapshot), { byteCount: 0, lineCount: 0, preview: "", truncated: false });
  assert.equal(f.chunks.length, 0);
});

test("existing complete-secret redaction still precedes stored and emitted previews", () => {
  const secret = "fixture-secret-never-a-real-key";
  const text = "说明 " + secret + " 😀";
  const f = capture([Buffer.from(text)], { secrets: [secret] });
  assert.equal(f.snapshot.byteCount, Buffer.byteLength(text));
  assert.equal(f.snapshot.redacted, true);
  assert.equal(f.snapshot.preview.includes(secret), false);
  assert.equal(f.snapshot.artifactContent.includes(secret), false);
  assert.ok(f.chunks.every(chunk => !chunk.text.includes(secret)));
  assert.equal(f.snapshot.preview.isWellFormed(), true);
});

test("synthetic failures use the same Unicode-safe bounded prefix", () => {
  const prefix = "a".repeat(8189);
  const f = createSyntheticStreamCapture(prefix + "😀" + "z", []);
  assert.equal(f.preview, prefix);
  assert.equal(f.previewTruncated, true);
  assert.equal(f.byteCount, Buffer.byteLength(prefix + "😀z"));
});

/** Real command, SQLite Host journal and artifact files, isolated in mkdtemp. */
async function runCommand(t, source, exitCode = 0) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-unicode-output-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const events = [];
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const task = { id: "fixture_task", title: "Unicode output", prompt: "Isolated output fixture" };
  const { store, run, sourceFence } = createUnifiedExecFixture(t, cwd, task, "fixture_run");
  const handled = await executeUnifiedBashTool({
    store, run, sourceFence,
    request: { toolCallId: "fixture_call", toolName: "bash", cwd, task,
      input: { command: `${quote(process.execPath)} -e ${quote(source)}`, timeoutMs: 5000 } },
    appendAndMaybeStream: (type, data) => events.push({ type, data }),
  });
  const result = handled.details.unifiedExec;
  assert.equal(result.exitCode, exitCode);
  assert.equal(handled.isError, exitCode !== 0);
  assert.equal(result.status, exitCode === 0 ? "succeeded" : "failed");
  for (const summary of result.artifacts) {
    const artifact = store.getArtifact(summary.artifactId);
    assert.ok(artifact);
    assert.equal(artifact.runId, "fixture_run");
    const data = await readFile(join(store.paths.artifactsDir, artifact.path));
    assert.equal(data.byteLength, summary.sizeBytes);
  }
  return {
    handled, result, events,
    async text(stream) {
      const artifact = store.getArtifact(result[stream].artifactId);
      return artifact ? readFile(join(store.paths.artifactsDir, artifact.path), "utf8") : "";
    },
  };
}

test("real command output and persisted artifact survive separated UTF-8 OS writes", async t => {
  const f = await runCommand(t, 'const b = Buffer.from("中😀"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 40);');
  assert.equal(f.result.stdout.preview, "中😀");
  assert.equal(f.result.stdout.byteCount, Buffer.byteLength("中😀"));
  assert.equal(await f.text("stdout"), "中😀");
});

test("real failed command preserves exit and artifact refs while bounding Unicode output", async t => {
  const prefix = "a".repeat(8189);
  const f = await runCommand(t, 'process.stdout.write("a".repeat(8189) + "😀" + "z".repeat(1000)); process.stderr.write("失败😀"); process.exitCode = 9;', 9);
  assert.equal(f.result.stdout.preview, prefix);
  assert.equal(f.result.stderr.preview, "失败😀");
  assert.equal(await f.text("stdout"), prefix + "😀" + "z".repeat(1000));
  assert.equal(await f.text("stderr"), "失败😀");
  assert.ok(f.handled.content[0].text.includes("Command exited 9"));
  assert.ok(f.handled.content[0].text.includes(f.result.stdout.artifactId));
  assert.ok(f.handled.content[0].text.includes(f.result.stderr.artifactId));
  assert.ok(f.events.filter(event => event.type === "tool_update").every(event => event.data.partialResult.text.isWellFormed()));
});
