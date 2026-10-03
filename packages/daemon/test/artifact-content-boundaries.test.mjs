import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistExtractedArtifacts } from "../dist/features/runs/artifacts.js";

test("extracted artifact preview stops at a UTF-8 boundary and discloses truncation", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-artifact-utf8-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const artifactsDir = join(cwd, "artifacts");
  const created = [];
  const store = {
    paths: { artifactsDir },
    createArtifact(input) {
      const artifact = { ...input, id: `artifact-${created.length}` };
      created.push(artifact);
      return artifact;
    },
  };
  const result = persistExtractedArtifacts({
    store,
    run: { id: "run-utf8", cwd },
    event: { type: "tool_end", toolName: "fixture", toolCallId: "call-utf8",
      result: { text: "x".repeat(256 * 1024 - 1) + "🙂" } },
    sourceArgs: {},
    nextIndex: () => 0,
  });
  assert.equal(result.length, 1);
  const body = await readFile(join(artifactsDir, result[0].path), "utf8");
  assert.doesNotMatch(body, /�/);
  assert.ok(body.startsWith("x".repeat(256 * 1024 - 1)));
  assert.match(body, /\[truncated from 262147 bytes\]$/);
  assert.equal(created[0].sizeBytes, Buffer.byteLength(body, "utf8"));
});

test("generated multiline edit diff marks every physical changed line", async t => {
  const artifacts = await extractEditArtifacts(t, {
    edits: [{ oldText: "old first\nold second\n", newText: "new first\nnew second\nnew third\n" }],
  });
  const diff = artifacts.find(artifact => artifact.type === "diff").body;
  assert.equal(diff.split("\n").filter(line => line.startsWith("- ")).length, 2);
  assert.equal(diff.split("\n").filter(line => line.startsWith("+ ")).length, 3);
  assert.match(diff, /- old first\n- old second\n\+ new first\n\+ new second\n\+ new third/);
});

test("generated result diff is not silently clipped to the approval text budget", async t => {
  const newText = Array.from({ length: 45 }, (_, index) => `new line ${index + 1}`).join("\n");
  const artifacts = await extractEditArtifacts(t, { edits: [{ oldText: "old", newText }] });
  const diff = artifacts.find(artifact => artifact.type === "diff").body;
  assert.equal(diff.split("\n").filter(line => line.startsWith("+ ")).length, 45);
  assert.match(diff, /\+ new line 45$/);
  assert.doesNotMatch(diff, /\.\.\./);
});

test("generated edit diff normalizes CRLF without inventing an empty deletion", async t => {
  const artifacts = await extractEditArtifacts(t, { edits: [{ oldText: "", newText: "one\r\n\r\nthree\r\n" }] });
  const diff = artifacts.find(artifact => artifact.type === "diff").body;
  assert.doesNotMatch(diff, /\r/);
  assert.equal(diff.split("\n").filter(line => line.startsWith("- ")).length, 0);
  assert.equal(diff.split("\n").filter(line => line.startsWith("+ ")).length, 3);
  assert.match(diff, /\+ one\n\+ \n\+ three$/);
});

test("failed edit does not synthesize a result diff from requested changes", async t => {
  const artifacts = await extractEditArtifacts(t, { edits: [{ oldText: "old", newText: "not applied" }] }, true);
  assert.equal(artifacts.filter(artifact => artifact.type === "diff").length, 0);
});

test("generated multiline result diff retains artifact secret redaction", async t => {
  const secret = "synthetic-private-edit-value";
  const artifacts = await extractEditArtifacts(t, {
    edits: [{ oldText: "before", newText: `first\n${secret}\nlast` }],
  }, false, [secret]);
  const diff = artifacts.find(artifact => artifact.type === "diff").body;
  assert.doesNotMatch(diff, /synthetic-private-edit-value/);
  assert.match(diff, /\+ first\n\+ \[REDACTED\]\n\+ last$/);
});

async function extractEditArtifacts(t, sourceArgs, isError = false, extraSecrets = []) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-edit-artifact-lines-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const artifactsDir = join(cwd, "artifacts");
  const store = {
    paths: { artifactsDir },
    createArtifact(input) { return { ...input, id: `artifact-${input.path}` }; },
  };
  let index = 0;
  const artifacts = persistExtractedArtifacts({
    store,
    run: { id: "run-edit-lines", cwd },
    event: { type: "tool_end", toolName: "edit", toolCallId: "call-edit-lines",
      result: { text: isError ? "Edit failed before mutation." : "Applied edit." }, isError },
    sourceArgs: { path: "changed.mjs", ...sourceArgs },
    nextIndex: () => ++index,
    extraSecrets,
  });
  return Promise.all(artifacts.map(async artifact => ({ ...artifact,
    body: await readFile(join(artifactsDir, artifact.path), "utf8") })));
}
