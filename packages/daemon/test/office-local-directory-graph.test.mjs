import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureOfficeLocalSnapshot } from "../dist/features/office-documents/office-local-snapshot.js";
import { projectOfficeLocalDirectoryGraph } from "../dist/features/office-documents/office-local-directory-graph.js";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-v2-graph-")));
  t.after(() => rmSync(root, { recursive: true, force: true })); // Owned test fixture only.
  const workspace = join(root, "workspace"), stage = join(root, "host-stage");
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(stage, { mode: 0o700 });
  const source = { runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "fence" };
  return { root, workspace, stage, snapshot: path => captureOfficeLocalSnapshot(workspace, path, "docx", source) };
}

test("missing subtree starts at the first absent directory and maps a distinct staging basename", t => {
  const f = fixture(t); mkdirSync(join(f.workspace, "existing"));
  const snapshot = f.snapshot("existing/new-a/new-b/report.docx"), graph = projectOfficeLocalDirectoryGraph(snapshot, f.stage, "host-owned-tree");
  assert.equal(graph.destination.parentPath, join(f.workspace, "existing"));
  assert.equal(graph.destination.firstMissingComponent, "new-a");
  assert.deepEqual(graph.members.map(member => [member.kind, member.basename]),
    [["created_directory", "host-owned-tree"], ["created_directory", "new-b"], ["created_file", "report.docx"]]);
  assert.deepEqual(graph.members.map(member => member.canonicalPath),
    [join(f.workspace, "existing/new-a"), join(f.workspace, "existing/new-a/new-b"), snapshot.targetPath]);
  assert.equal(graph.members[0].stagePath, join(f.stage, "host-owned-tree"));
  assert.equal(graph.members[2].stagePath, join(f.stage, "host-owned-tree/new-b/report.docx"));
  assert.equal(graph.members[0].parentResourceSlotId, graph.stage.parentResourceSlotId);
  assert.equal(graph.members[1].parentResourceSlotId, graph.members[0].resourceSlotId);
  assert.equal(graph.members[2].parentResourceSlotId, graph.members[1].resourceSlotId);
  assert.equal(new Set(graph.members.flatMap(member => [member.resourceSlotId, member.publicationResourceSlotId])).size, 6);
  assert.equal(existsSync(graph.members[0].stagePath), false); assert.equal(existsSync(snapshot.targetPath), false);
});

test("both ancestor chains retain separate logical slots even when they share existing nodes", t => {
  const f = fixture(t), graph = projectOfficeLocalDirectoryGraph(f.snapshot("new/report.docx"), f.stage, "tree");
  assert.equal(graph.stage.ancestors[0].path, "/"); assert.equal(graph.destination.ancestors[0].path, "/");
  assert.equal(graph.stage.ancestors[0].identity.inode, graph.destination.ancestors[0].identity.inode);
  assert.notEqual(graph.stage.ancestors[0].resourceSlotId, graph.destination.ancestors[0].resourceSlotId);
  assert.equal(graph.workspaceIdentity.isDirectory, true); assert.equal(typeof graph.workspaceIdentity.sizeBytes, "string");
  assert.ok(Object.isFrozen(graph.members[0]));
  assert.equal("scopeRef" in graph, false); assert.equal("ticket" in graph, false);
});

test("existing-parent leaf and overwrite are not mistaken for the missing-subtree graph", t => {
  const f = fixture(t);
  assert.throws(() => projectOfficeLocalDirectoryGraph(f.snapshot("report.docx"), f.stage, "tree"), /graph_unsupported/);
  mkdirSync(join(f.workspace, "existing"));
  writeFileSync(join(f.workspace, "existing/report.docx"), "existing snapshot bytes");
  assert.throws(() => projectOfficeLocalDirectoryGraph(f.snapshot("existing/report.docx"), f.stage, "tree"), /graph_unsupported/);
});

test("owned snapshot is required and namespace changes are rejected without native mutation", t => {
  const f = fixture(t), snapshot = f.snapshot("new/report.docx");
  assert.throws(() => projectOfficeLocalDirectoryGraph({ ...snapshot }, f.stage, "tree"), /snapshot_invalid/);
  mkdirSync(join(f.workspace, "new"));
  assert.throws(() => projectOfficeLocalDirectoryGraph(snapshot, f.stage, "tree"), /snapshot_changed/);
  assert.equal(existsSync(join(f.stage, "tree")), false);
});

test("unsafe basenames and stage/workspace overlap are rejected before any native effect", t => {
  const f = fixture(t), snapshot = f.snapshot("new/report.docx");
  for (const name of ["", ".", "..", "../foreign", "a\0b", "界".repeat(86)]) {
    assert.throws(() => projectOfficeLocalDirectoryGraph(snapshot, f.stage, name), /graph_unsupported/);
  }
  assert.throws(() => projectOfficeLocalDirectoryGraph(snapshot, f.workspace, "tree"), /graph_unsupported/);
  assert.throws(() => projectOfficeLocalDirectoryGraph(snapshot, f.root, "tree"), /graph_unsupported/);
  assert.throws(() => projectOfficeLocalDirectoryGraph(snapshot, join(f.workspace, "private-stage"), "tree"), /graph_unsupported/);
  assert.equal(existsSync(join(f.workspace, "private-stage")), false);
});
