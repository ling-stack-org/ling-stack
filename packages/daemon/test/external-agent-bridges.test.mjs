import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { bridgeExternalToolApproval } from "../dist/runtime/external-agent/approval-bridge.js";
import { importExternalAgentArtifact } from "../dist/runtime/external-agent/artifact-importer.js";
import { normalizeExternalAgentEvent } from "../dist/runtime/external-agent/event-normalizer.js";
import { createExternalAgentSessionHandle } from "../dist/runtime/external-agent/session-handles.js";
import {
  assertExternalToolAllowed,
  defaultExternalToolSurfacePolicy,
} from "../dist/runtime/external-agent/tool-surface.js";
import { resolveExternalWorkspacePath } from "../dist/runtime/external-agent/workspace-boundary.js";

test("external tool surface allows read-only proposals and rejects forbidden side effects", () => {
  const policy = defaultExternalToolSurfacePolicy();
  assert.doesNotThrow(() => assertExternalToolAllowed({
    backendToolCallId: "tool_1",
    toolName: "read",
    input: { path: "README.md" },
    sideEffect: "workspace_read",
  }, policy));
  assert.throws(() => assertExternalToolAllowed({
    backendToolCallId: "tool_2",
    toolName: "secret",
    input: {},
    sideEffect: "provider_or_secret",
  }, policy), /not enabled|provider secrets/i);
  assert.throws(() => assertExternalToolAllowed({
    backendToolCallId: "tool_3",
    toolName: "deliver",
    input: {},
    sideEffect: "external_delivery",
  }, policy), /not enabled|delivery/i);
});

test("external approval bridge fails closed for side-effectful proposals", async () => {
  const proposal = {
    backendToolCallId: "tool_write",
    toolName: "write",
    input: { path: "README.md" },
    sideEffect: "workspace_write",
  };
  await assert.rejects(
    () => bridgeExternalToolApproval(proposal, { approvalBridgeVerified: false }),
    /not verified/i,
  );
  await assert.rejects(
    () => bridgeExternalToolApproval(proposal, {
      approvalBridgeVerified: true,
      onApprovalRequired: async () => ({ approved: false, approvalId: "approval_denied" }),
    }),
    /not approved/i,
  );
  assert.deepEqual(await bridgeExternalToolApproval(proposal, {
    approvalBridgeVerified: true,
    onApprovalRequired: async (request) => {
      assert.equal(request.toolName, "write");
      return { approved: true, approvalId: "approval_ok" };
    },
  }), { approved: true, approvalId: "approval_ok" });
  assert.deepEqual(await bridgeExternalToolApproval({
    backendToolCallId: "tool_read",
    toolName: "read",
    input: { path: "README.md" },
    sideEffect: "workspace_read",
  }, { approvalBridgeVerified: false }), { approved: true });
});

test("external workspace boundary rejects paths outside allowed roots", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-stack-external-boundary-"));
  try {
    assert.equal(resolveExternalWorkspacePath({ cwd: root }, "nested/file.txt"), join(root, "nested/file.txt"));
    assert.throws(
      () => resolveExternalWorkspacePath({ cwd: root }, "../outside.txt"),
      /outside the allowed workspace boundary/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external artifact importer writes only under Ling artifact root and redacts content", async () => {
  const artifactRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-external-artifacts-"));
  try {
    const summary = importExternalAgentArtifact({
      artifactRoot,
      runId: "run_1",
      toolCallId: "tool_1",
      role: "artifact",
      filename: "../raw secret?.txt",
      content: "visible sk-test-secret-value and extra-secret-value",
      extraSecrets: ["extra-secret-value"],
    });
    assert.equal(summary.path, join(artifactRoot, "run_1", "external-agent", "tool_1", "raw_secret_.txt"));
    const content = await readFile(summary.path, "utf8");
    assert.equal(content.includes("sk-test-secret-value"), false);
    assert.equal(content.includes("extra-secret-value"), false);
    assert.equal(content.includes("[REDACTED]"), true);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("external event normalizer and session handles avoid raw secret leakage", () => {
  const delta = normalizeExternalAgentEvent({
    type: "text_delta",
    data: { text: "hello sk-test-secret-value extra-secret-value" },
  }, ["extra-secret-value"]);
  assert.equal(delta.type, "assistant_text_delta");
  assert.equal(delta.text.includes("sk-test-secret-value"), false);
  assert.equal(delta.text.includes("extra-secret-value"), false);

  const handle = createExternalAgentSessionHandle({
    runnerId: "openclaw-acp",
    backend: "openclaw-acp",
    backendSessionId: "session_1",
    now: "2026-06-14T00:00:00.000Z",
  });
  assert.equal(handle.runnerId, "openclaw-acp");
  assert.equal(handle.createdAt, "2026-06-14T00:00:00.000Z");
});
