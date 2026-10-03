import assert from "node:assert/strict";
import test from "node:test";
import { isWorkspaceDeliverableArtifact, projectConversationArtifacts } from "../dist/features/runs/public-artifacts.js";

test("public conversation artifacts exclude internal storage without hiding deliverables", () => {
  const createdAt = "2026-09-26T00:00:00.000Z";
  const internalPaths = [
    ".ling-stack/provenance/run-1/forward-plan.json",
    "./.ling-stack/evaluations/rule-grade.json",
    "harness/continuations/run-1/replay.json",
    "workflows/workflow-1/fan-in.md",
    "run-1/actions/approval-1/preview.txt",
    "run-1\\shell-snapshots\\tool-1\\000001.txt",
    "automation-context/run-1-automation-1.md",
    "external-work/work-1/rendered-prompt.md",
  ];
  for (const path of internalPaths) {
    assert.equal(isWorkspaceDeliverableArtifact({ path, runId: "run-1" }), false, path);
  }
  const artifacts = [
    ...internalPaths.map((path, index) => ({ id: `internal-${index}`, runId: "run-1", path, type: "json", createdAt, sealedPayload: { secret: "SECRET_SENTINEL" } })),
    { id: "result", runId: "run-1", path: "reports/result.json", type: "json", createdAt,
      sealedPayload: { result: "public" }, contentSha256: "a".repeat(64) },
    { id: "image", path: "media_jobs/job-1/output.png", type: "image", createdAt },
  ];
  const projected = projectConversationArtifacts(artifacts);
  assert.deepEqual(projected.map((artifact) => artifact.id), ["result", "image"]);
  assert.equal(projected.some((artifact) => "sealedPayload" in artifact), false);
  assert.equal(projected.some((artifact) => "contentSha256" in artifact), false);
  assert.equal(artifacts[0].sealedPayload.secret, "SECRET_SENTINEL", "projection must not mutate Host evidence");
});

test("only a uniquely owned edit result diff may leave Run storage as public metadata", () => {
  const createdAt = "2026-09-28T00:00:00.000Z";
  const artifacts = [
    { id: "owned", runId: "run-1", path: "run-1/008-generated-edit-diff-todo.py.diff", type: "diff", contentType: "text/x-diff; charset=utf-8", createdAt, sealedPayload: { secret: "SECRET_SENTINEL" } },
    { id: "unowned", runId: "run-1", path: "run-1/009-other.diff", type: "diff", contentType: "text/x-diff", createdAt },
    { id: "foreign", runId: "run-2", path: "run-2/010-foreign.diff", type: "diff", contentType: "text/x-diff", createdAt },
    { id: "internal", runId: "run-1", path: "run-1/011-private.json", type: "json", createdAt },
  ];
  const edit = { actionType: "edit", runId: "run-1", resultArtifactIds: ["owned", "foreign", "internal"] };
  assert.deepEqual(projectConversationArtifacts(artifacts, [edit]).map((artifact) => artifact.id), ["owned"]);
  assert.equal(JSON.stringify(projectConversationArtifacts(artifacts, [edit])).includes("SECRET_SENTINEL"), false);
  assert.deepEqual(projectConversationArtifacts(artifacts, [edit, { ...edit }]).map((artifact) => artifact.id), []);
  assert.deepEqual(projectConversationArtifacts(artifacts, [{ ...edit, actionType: "read" }]).map((artifact) => artifact.id), []);
});
