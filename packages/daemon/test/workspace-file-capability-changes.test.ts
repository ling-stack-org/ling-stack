import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { inspectWorkspaceChanges } from "../dist/features/previews/workspace-changes.js";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceFileCapabilityRegistry } from "../dist/features/previews/workspace-file-capabilities.js";
import { handlePostWorkspaceFileCapabilityChanges } from "../dist/features/previews/workspace-file-capability-routes.js";
import { handleWorkspaceReviewPreview } from "../dist/features/previews/workspace-review-preview.js";
import { buildWorkspaceChangeReview } from "../dist/features/runs/workspace-change-review.js";
import { hashReviewContent } from "../dist/features/runs/workspace-review-snapshot.js";
import type { RunStoreRegistry } from "../dist/runtime/store-registry.js";

test("capability change endpoint returns only the authorized file and rejects scope changes", async t => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "ling-file-changes-cap-")));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "one.ts"), "after\n");
  const runId = "run-cap-change", threadId = "thread-cap-change", actionId = `tool:${runId}:edit-1`;
  const scope = { workspaceId: "workspace_default", threadId, runId, actionId, participantId: "engineer" };
  const run = { id: runId, cwd, threadId, teammateId: "engineer", status: "succeeded", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const events = [
    { seq: 1, runId, type: "tool_start", ts: run.createdAt, data: { toolCallId: "edit-1", toolName: "edit", args: { path: join(cwd, "src", "one.ts") } } },
    { seq: 2, runId, type: "tool_end", ts: run.updatedAt, data: { toolCallId: "edit-1", toolName: "edit", isError: false, result: { touchedPaths: [join(cwd, "src", "one.ts")] } } },
  ];
  const records = ["src/one.ts", "src/secret.ts"].map((path, index) => ({
    id: `record-${index}`, workspaceId: scope.workspaceId, cwd, threadId, runId, path,
    forwardPatchArtifactId: `artifact-${index}`, provenanceSeq: index + 1, effectState: "applied",
    beforeSha256: hashReviewContent("before\n"), afterSha256: hashReviewContent("after\n"),
  }));
  const store = {
    paths: { cwd, artifactsDir: join(cwd, ".ling-stack", "artifacts"), identity: { workspaceId: scope.workspaceId } },
    getLingThread: (id: string) => id === threadId ? { id, workspaceId: scope.workspaceId } : undefined,
    getRun: (id: string) => id === runId ? run : undefined,
    listRuns: () => [run], listApprovalRequests: () => [], getConversationItem: () => undefined,
    listEvents: (id: string, options: { afterSeq?: number; limit?: number } = {}) => id === runId ? events.filter(event => event.seq > (options.afterSeq ?? 0)).slice(0, options.limit ?? 1000) : [],
    listWorkspaceMutationRecords: () => records,
    getArtifact: (id: string) => {
      const index = Number(id.split("-").at(-1)); const record = records[index];
      return record ? { runId, sealedPayload: { workspaceReviewSnapshot: { schemaVersion: 1, state: "exact", files: [{ path: record.path, before: "before\n", after: "after\n" }] } } } : undefined;
    },
  };
  const stores = { getStore: () => store, findStoreForRun: (id: string) => id === runId ? store : undefined, isTrustedWorkspaceRoot: (root: string) => root === cwd } as unknown as RunStoreRegistry;
  const capabilities = new WorkspaceFileCapabilityRegistry();
  const capability = capabilities.issue({ cwd, capabilityTarget: "open_file", refId: join(cwd, "src", "one.ts"), scope }, stores);
  const server = createServer((req, res) => { if (req.url === "/review") void handleWorkspaceReviewPreview(req, res, 8192, stores); else void handlePostWorkspaceFileCapabilityChanges(req, res, 8192, stores, capabilities); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const send = (body: unknown) => fetch(`http://127.0.0.1:${address.port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await send({ cwd, capabilityId: capability.capabilityId, scope });
  assert.equal(response.status, 200);
  const body = await response.json() as { state: string; file: { path: string; diff: string } };
  assert.equal(body.state, "exact"); assert.equal(body.file.path, "src/one.ts");
  assert.match(body.file.diff, /\+after/u); assert.doesNotMatch(JSON.stringify(body), /secret\.ts/u);
  const forbidden = await send({ cwd, capabilityId: capability.capabilityId, scope: { ...scope, participantId: "other" } });
  assert.equal(forbidden.status, 403);
  const invalid = await send({ cwd, capabilityId: "invalid", scope });
  assert.equal(invalid.status, 403);

  const review = buildWorkspaceChangeReview(store as never, { scope: { kind: "run", id: runId }, runs: [run as never], threadId });
  const reviewFile = review.files.find(file => file.path === "src/one.ts");
  assert.ok(reviewFile);
  const reviewRequest = { cwd, scope: review.scope, revision: review.revision, fileId: reviewFile.id };
  const sendReview = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const current = await sendReview(reviewRequest);
  assert.equal(current.status, 200);
  assert.match(JSON.stringify(await current.json()), /after/u);
  assert.equal((await sendReview({ ...reviewRequest, revision: "old" })).status, 409);
  assert.equal((await sendReview({ ...reviewRequest, fileId: "unknown" })).status, 404);
  assert.equal((await sendReview({ ...reviewRequest, cwd: join(cwd, "src") })).status, 403);
  await rm(join(cwd, "src", "one.ts"));
  assert.equal((await sendReview(reviewRequest)).status, 404);
  await symlink("/etc/passwd", join(cwd, "src", "one.ts"));
  assert.equal((await sendReview(reviewRequest)).status, 404);

});


test("separates staged and unstaged diff layers for the same file", async t => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "ling-change-layers-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(join(cwd, "file.txt"), "original\n"); git("add", "file.txt"); git("commit", "-qm", "initial");
  await writeFile(join(cwd, "file.txt"), "staged\n"); git("add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "unstaged\n");
  const response = await inspectWorkspaceChanges(cwd, new Date().toISOString());
  const file = response.files.find(item => item.path === "file.txt");
  assert.ok(file?.staged && file.unstaged && file.layers);
  assert.deepEqual(file.layers.map(layer => layer.kind), ["staged", "unstaged"]);
  assert.match(file.layers[0]!.diff, /-original[\s\S]*\+staged/u);
  assert.match(file.layers[1]!.diff, /-staged[\s\S]*\+unstaged/u);
});
