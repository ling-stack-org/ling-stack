import assert from "node:assert/strict";
import test from "node:test";
import { commandLogEvidence } from "../src/shared/conversation/timeline/command-log-evidence.ts";

test("command logs require a matching durable artifact reference", () => {
  const stdout = { kind: "artifact", id: "stdout-1" };
  const stderr = { kind: "artifact", id: "stderr-1" };
  assert.deepEqual(commandLogEvidence({
    stdoutArtifactId: stdout.id, stderrArtifactId: stderr.id, resultArtifactId: "missing-result",
    sourceRefs: [stdout, stderr, { kind: "artifact", id: "unrelated", path: "/tmp/log" }],
  }), [{ stream: "stdout", ref: stdout }, { stream: "stderr", ref: stderr }]);
});

test("a bare artifact id or a model-supplied path never becomes a log link", () => {
  assert.deepEqual(commandLogEvidence({ stdoutArtifactId: "stdout-1", sourceRefs: [
    { kind: "path", id: "stdout-1", path: "/tmp/output.log" },
    { kind: "artifact", id: "another-id", label: "stdout" },
  ] }), []);
});

test("shared output ids render once and missing logs render none", () => {
  const ref = { kind: "artifact", id: "joined" };
  assert.deepEqual(commandLogEvidence({ stdoutArtifactId: ref.id, stderrArtifactId: ref.id,
    resultArtifactId: ref.id, sourceRefs: [ref] }), [{ stream: "stdout", ref }]);
  assert.deepEqual(commandLogEvidence({ sourceRefs: [] }), []);
});
