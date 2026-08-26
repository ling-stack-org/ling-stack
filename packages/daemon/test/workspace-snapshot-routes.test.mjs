import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";
import { parseWorkspaceSnapshotRoute } from "../dist/features/runs/workspace-snapshot-routes.js";

test("workspace snapshot routes keep capture, confirmation, restore, and status paths distinct", () => {
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshots"), { kind: "collection" });
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshots/capture"), { kind: "capture" });
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshots/snap_1"), { kind: "detail", snapshotId: "snap_1" });
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshots/snap_1/confirmations"), { kind: "confirmation", snapshotId: "snap_1" });
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshot-confirmations/confirmation_1"), { kind: "confirmation", confirmationId: "confirmation_1" });
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshot-confirmations/confirmation_1/confirm"), { kind: "confirmation-resolve", confirmationId: "confirmation_1" });
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshots/snap_1/restore"), { kind: "restore", snapshotId: "snap_1" });
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshot-restores/restore_1"), { kind: "restore-detail", restoreRequestId: "restore_1" });
  assert.deepEqual(parseWorkspaceSnapshotRoute("/workspace/snapshots/restore/restore_1"), { kind: "restore-detail", restoreRequestId: "restore_1" });
  assert.equal(parseWorkspaceSnapshotRoute("/workspace/snapshots/snap_1/unknown"), undefined);
});

test("workspace snapshot HTTP routes expose gated capture, detail, and restore errors", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-snapshot-routes-"));
  await writeFile(resolve(cwd, "route.txt"), "route\n", "utf8");
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    workspaceSnapshots: {
      captureEnabled: true,
      restoreEnabled: true,
      restoreUiEnabled: true,
    },
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const query = `?cwd=${encodeURIComponent(cwd)}`;
  try {
    const capture = await fetch(`${baseUrl}/workspace/snapshots${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const captureBody = await capture.text();
    assert.equal(capture.status, 201, captureBody);
    const captured = JSON.parse(captureBody);
    assert.equal(captured.manifest.state, "committed");

    const collection = await fetch(`${baseUrl}/workspace/snapshots${query}`);
    assert.equal(collection.status, 200);
    const listed = await collection.json();
    assert.equal(listed.restoreUiEnabled, true);
    assert.ok(listed.snapshots.some((snapshot) => snapshot.id === captured.manifest.id));

    const detail = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(captured.manifest.id)}${query}`);
    assert.equal(detail.status, 200);
    const detailed = await detail.json();
    assert.equal(detailed.manifest.id, captured.manifest.id);
    assert.ok(detailed.entries.some((entry) => entry.relativePath === "route.txt"));

    await writeFile(resolve(cwd, "route.txt"), "changed\n", "utf8");
    const anchorResponse = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(captured.manifest.id)}/anchors${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(anchorResponse.status, 201);
    const anchor = await anchorResponse.json();
    assert.equal(anchor.threadId, undefined);

    const confirmationResponse = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(captured.manifest.id)}/confirmations${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchorId: anchor.id }),
    });
    assert.equal(confirmationResponse.status, 201);
    const pendingConfirmation = await confirmationResponse.json();
    const confirmedResponse = await fetch(`${baseUrl}/workspace/snapshot-confirmations/${encodeURIComponent(pendingConfirmation.id)}/confirm${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "confirmed" }),
    });
    assert.equal(confirmedResponse.status, 200);
    const confirmed = await confirmedResponse.json();

    const queuedRestore = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(captured.manifest.id)}/restore${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "route-restore-success", anchorId: anchor.id, confirmationId: confirmed.id }),
    });
    assert.equal(queuedRestore.status, 202);
    const queued = await queuedRestore.json();
    assert.ok(["requested", "validating", "fenced", "staged", "committing", "verifying", "committed"].includes(queued.state));
    let settled = queued;
    for (let attempt = 0; attempt < 30 && settled.state !== "committed"; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      const statusResponse = await fetch(`${baseUrl}/workspace/snapshot-restores/${encodeURIComponent(queued.id)}${query}`);
      assert.equal(statusResponse.status, 200);
      settled = await statusResponse.json();
    }
    assert.equal(settled.state, "committed");
    assert.equal(await readFile(resolve(cwd, "route.txt"), "utf8"), "route\n");

    const replay = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(captured.manifest.id)}/restore${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "route-restore-success", anchorId: anchor.id, confirmationId: confirmed.id }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).id, queued.id);

    const restore = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(captured.manifest.id)}/restore${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "route-restore", anchorId: "missing-anchor" }),
    });
    assert.equal(restore.status, 409);
    assert.equal((await restore.json()).error, "confirmation_required");

    const missing = await fetch(`${baseUrl}/workspace/snapshots/missing${query}`);
    assert.equal(missing.status, 404);

    const expiringCapture = await fetch(`${baseUrl}/workspace/snapshots${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlMs: 1 }),
    });
    assert.equal(expiringCapture.status, 201);
    const expiring = await expiringCapture.json();
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    const expiredAnchorResponse = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(expiring.manifest.id)}/anchors${query}`, { method: "POST" });
    assert.equal(expiredAnchorResponse.status, 201);
    const expiredAnchor = await expiredAnchorResponse.json();
    const expiredConfirmationResponse = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(expiring.manifest.id)}/confirmations${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchorId: expiredAnchor.id }),
    });
    const expiredConfirmation = await expiredConfirmationResponse.json();
    await fetch(`${baseUrl}/workspace/snapshot-confirmations/${encodeURIComponent(expiredConfirmation.id)}/confirm${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "confirmed" }),
    });
    const expiredRestore = await fetch(`${baseUrl}/workspace/snapshots/${encodeURIComponent(expiring.manifest.id)}/restore${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "expired-restore", anchorId: expiredAnchor.id, confirmationId: expiredConfirmation.id }),
    });
    assert.equal(expiredRestore.status, 410);

    const malformedConfirmation = await fetch(`${baseUrl}/workspace/snapshot-confirmations/missing/confirm${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "not-a-confirmation-state" }),
    });
    assert.equal(malformedConfirmation.status, 422);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace snapshot HTTP capture returns 413 before committing an over-quota manifest", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-snapshot-routes-quota-"));
  await writeFile(resolve(cwd, "too-large.txt"), "1234567890", "utf8");
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    workspaceSnapshots: { captureEnabled: true, restoreEnabled: true, restoreUiEnabled: true, maxBytes: 1 },
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/workspace/snapshots?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, "quota_exceeded");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
