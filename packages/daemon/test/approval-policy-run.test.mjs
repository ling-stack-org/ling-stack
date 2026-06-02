import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("health includes the configured default workspace cwd", async () => {
  const defaultWorkspaceCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-health-cwd-"));
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd,
  }, {
    runner: new ApprovalProbeRunner({
      toolCallId: "tool_health",
      toolName: "bash",
      input: { command: "echo unused" },
    }),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");

  try {
    const health = await getJson(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.ok, true);
    assert.equal(health.service, "ling-stack-daemon");
    assert.equal(health.defaultWorkspaceCwd, defaultWorkspaceCwd);
  } finally {
    await daemon.stop();
    await rm(defaultWorkspaceCwd, { recursive: true, force: true });
  }
});

test("bash=allow lets the runner continue without creating an approval request", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_allow",
    toolName: "bash",
    input: { command: "echo ok" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_bash_allow"));

    assert.equal(runner.decisions.length, 1);
    assert.deepEqual(runner.decisions[0], {
      approved: true,
      reason: "Ling Stack policy allowed bash.",
    });
    assert.equal(events.some((event) => event.event === "approval_requested"), false);
    assert.deepEqual(await listApprovals(daemon.url, cwd, runId), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("assignee approval profile tightens workspace approval policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-profile-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_profile",
    toolName: "bash",
    input: { command: "echo profile-gated" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const response = await postRunStream(daemon.url, {
      ...runBody(cwd, "task_bash_profile"),
      approvalProfile: {
        mode: "standard",
        risk: "medium",
        requiredForTools: ["bash"],
      },
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;

    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;
    const approval = await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "profile approval",
    });
    assert.equal(approval.approval.status, "approved");

    const remaining = await sse.collectRemaining();
    assert.deepEqual(runner.decisions, [{
      approved: true,
      approvalId,
      reason: "profile approval",
    }]);
    assert.equal(remaining.some((event) => event.event === "approval_approved"), true);
    assert.equal((await listApprovals(daemon.url, cwd, runId)).length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bash=deny records an immediately denied approval request", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_deny",
    toolName: "bash",
    input: { command: "echo blocked" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "deny" } });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_bash_deny"));
    const approvals = await listApprovals(daemon.url, cwd, runId);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /policy denied bash/);
    assert.deepEqual(events.filter((event) => event.event.startsWith("approval_")).map((event) => event.event), [
      "approval_requested",
      "approval_denied",
    ]);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].actionType, "bash");
    assert.match(approvals[0].decisionReason, /policy denied bash/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bash=ask pauses the run until the approval is resolved", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_ask",
    toolName: "bash",
    input: { command: "echo approve-me" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_bash_ask"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;

    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;
    const waitingRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(waitingRun.status, "waiting_for_approval");

    const resolved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "test approval",
    });
    assert.equal(resolved.approval.status, "approved");

    const remaining = await sse.collectRemaining();
    assert.equal(runner.decisions.length, 1);
    assert.deepEqual(runner.decisions[0], {
      approved: true,
      approvalId,
      reason: "test approval",
    });
    assert.equal(remaining.some((event) => event.event === "approval_approved"), true);
    assert.equal(remaining.some((event) => event.event === "result"), true);
    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "succeeded");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write=deny blocks file writes through the run approval chain", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_deny",
    toolName: "write",
    input: { path: "docs/out.txt", content: "blocked" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { write: "deny" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_write_deny"));
    const approvals = await listApprovals(daemon.url, cwd, runId);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /policy denied write/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].actionType, "write");
    assert.equal(approvals[0].payload.path, "docs/out.txt");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write outside allowed paths is denied even when write is allowed", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_outside",
    toolName: "write",
    input: { path: "src/out.txt", content: "outside" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, {
      toolDecisions: { write: "allow" },
      allowedWritePaths: ["docs"],
    });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_write_outside"));
    const approvals = await listApprovals(daemon.url, cwd, runId);
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&runId=${encodeURIComponent(runId)}`);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /outside allowed write paths/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].payload.path, "src/out.txt");
    assert.deepEqual(pending.approvals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval listing lazily expires stale pending requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-approval-expiry-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_expiry",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  const runId = "run_stale_approval";
  const approvalCreatedAt = "2000-01-01T00:00:00.000Z";
  let approvalId = "";
  try {
    const store = createSqliteRunStore(cwd);
    try {
      store.createRun({
        id: runId,
        cwd,
        taskId: "task_stale_approval",
        providerName: "test-provider",
        providerModel: "test-model",
        taskSnapshot: { id: "task_stale_approval", title: "Stale approval" },
        providerSnapshot: { provider: "test-provider", model: "test-model" },
        requestSnapshot: { cwd },
        createdAt: approvalCreatedAt,
      });
      const approval = store.createApprovalRequest(
        {
          runId,
          taskId: "task_stale_approval",
          actionType: "bash",
          risk: "medium",
          title: "Approve shell command",
          description: "echo stale",
          payload: { type: "bash", cwd, command: "echo stale", riskFlags: [] },
          expiresAt: "2000-01-01T00:01:00.000Z",
        },
        approvalCreatedAt,
      );
      approvalId = approval.id;
    } finally {
      store.close();
    }

    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&runId=${encodeURIComponent(runId)}`);
    assert.deepEqual(pending.approvals, []);

    const expired = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=expired&runId=${encodeURIComponent(runId)}`);
    assert.equal(expired.approvals.length, 1);
    assert.equal(expired.approvals[0].id, approvalId);
    assert.equal(expired.approvals[0].status, "expired");
    assert.equal(expired.approvals[0].resolvedBy, undefined);

    const events = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/events?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(events.events.some((event) => event.type === "approval_expired" && event.data.approvalId === approvalId), true);

    const lateApprove = await fetch(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "too late" }),
    });
    assert.equal(lateApprove.status, 400);
    assert.equal((await lateApprove.json()).error, "approval_not_pending");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider check persists last check result", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "jimeng",
      displayName: "Jimeng Image",
      providerId: "jimeng",
      model: "jimeng-image",
      api: "media-job",
      capabilities: ["image_generate"],
      input: ["text", "image"],
      authHeader: false,
      enabled: true,
    });
    const providerId = created.provider.id;

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, true);
    assert.equal(checkResult.code, "static_check");
    assert.match(checkResult.message, /transport is disabled/);

    const fetched = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(fetched.provider.lastCheck.ok, true);
    assert.equal(fetched.provider.lastCheck.code, "static_check");
    assert.equal(fetched.provider.lastCheck.checkedAt, checkResult.checkedAt);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("secret status reports configured, missing, unavailable, and invalid refs without values", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-secret-status-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_secret_status",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_SECRET_STATUS_KEY = "status-secret-value";
  try {
    const configured = await getJson(`${daemon.url}/secrets/status?ref=env%3ALING_STACK_SECRET_STATUS_KEY&purpose=provider_api_key`);
    assert.equal(configured.status.configured, true);
    assert.equal(configured.status.kind, "env");
    assert.doesNotMatch(JSON.stringify(configured), /status-secret-value/);
    assert.equal("value" in configured.status, false);

    const missing = await getJson(`${daemon.url}/secrets/status?ref=env%3ALING_STACK_SECRET_STATUS_MISSING`);
    assert.equal(missing.status.configured, false);
    assert.equal(missing.status.errorCode, "secret_missing");
    assert.equal("value" in missing.status, false);

    const unavailable = await getJson(`${daemon.url}/secrets/status?ref=keychain%3Aprovider_local&purpose=provider_api_key`);
    assert.equal(unavailable.status.configured, false);
    assert.equal(unavailable.status.kind, "keychain");
    assert.match(unavailable.status.errorCode, /^(secret_missing|secret_store_unavailable)$/);
    assert.equal("value" in unavailable.status, false);

    const invalid = await getJson(`${daemon.url}/secrets/status?ref=sk-test_123456789&purpose=provider_api_key`);
    assert.equal(invalid.status.configured, false);
    assert.equal(invalid.status.errorCode, "invalid_secret_ref");
    assert.equal("value" in invalid.status, false);

    const unsupportedPurpose = await fetch(`${daemon.url}/secrets/status?ref=env%3ALING_STACK_SECRET_STATUS_KEY&purpose=unknown`);
    assert.equal(unsupportedPurpose.status, 400);
  } finally {
    delete process.env.LING_STACK_SECRET_STATUS_KEY;
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider create and update accept keychain refs and reject raw or unknown secret schemes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-secret-ref-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_provider_secret_ref",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      authHeader: true,
      apiKeyRef: "keychain:provider_local",
    });
    assert.equal(created.provider.apiKeyRef, "keychain:provider_local");
    assert.equal(created.provider.apiKeyStatus.configured, false);
    assert.match(created.provider.apiKeyStatus.errorCode, /^(secret_missing|secret_store_unavailable)$/);
    assert.equal("value" in created.provider.apiKeyStatus, false);

    const updated = await patchJson(`${daemon.url}/providers/${encodeURIComponent(created.provider.id)}?cwd=${encodeURIComponent(cwd)}`, {
      apiKeyRef: "env:LING_STACK_TEST_PROVIDER_KEY",
    });
    assert.equal(updated.provider.apiKeyRef, "env:LING_STACK_TEST_PROVIDER_KEY");

    const rawRejected = await postJsonExpectError(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "glm",
      displayName: "Raw Secret",
      providerId: "raw-secret",
      model: "static-model",
      api: "google-generative-ai",
      capabilities: ["chat"],
      input: ["text"],
      authHeader: true,
      enabled: true,
      apiKeyRef: "sk-test_123456789",
    });
    assert.equal(rawRejected.status, 400);
    assert.match(rawRejected.body.message, /env:NAME or keychain:NAME/);

    const unknownRejected = await postJsonExpectError(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "glm",
      displayName: "Unknown Scheme",
      providerId: "unknown-secret",
      model: "static-model",
      api: "google-generative-ai",
      capabilities: ["chat"],
      input: ["text"],
      authHeader: true,
      enabled: true,
      apiKeyRef: "file:secret",
    });
    assert.equal(unknownRejected.status, 400);
    assert.match(unknownRejected.body.message, /env:NAME or keychain:NAME/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider check and run startup use the injected secret resolver without leaking resolved values", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-secret-resolver-"));
  const secretValue = "resolved-keychain-secret";
  const runner = new SecretEchoRunner(secretValue);
  const daemon = await startDaemonForTest(runner, {
    secretResolver: createTestSecretResolver("keychain:provider_ready", secretValue),
  });
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      displayName: "Keychain Ready",
      providerId: "keychain-ready",
      authHeader: true,
      apiKeyRef: "keychain:provider_ready",
    });
    const providerId = created.provider.id;

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, true);

    const { runId } = await postRunAndCollectEvents(daemon.url, providerRunBody(cwd, "task_provider_secret_resolver", providerId));
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.runs[0].apiKey, secretValue);

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    const events = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/events?cwd=${encodeURIComponent(cwd)}`);
    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.doesNotMatch(JSON.stringify({ run, events, artifacts }), new RegExp(secretValue));

    for (const artifact of artifacts.artifacts) {
      const content = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(artifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(content.status, 200);
      assert.doesNotMatch(await content.text(), new RegExp(secretValue));
    }
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider local API keys are edited from sqlite without leaking in provider responses", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-local-secret-"));
  const openai = await startMockOpenAICompatibleServer();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_local_secret",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "Local Secret Relay",
      providerId: "local-secret-relay",
      api: "openai-completions",
      baseUrl: `${openai.url}/v1`,
      authHeader: true,
      apiKey: "local-secret-one",
    });
    const providerId = created.provider.id;
    assert.equal(created.provider.apiKeyRef, `local:${providerId}`);
    assert.equal(created.provider.apiKeyConfigured, true);
    assert.equal(created.provider.apiKeyStatus.kind, "local");
    assert.doesNotMatch(JSON.stringify(created), /local-secret-one/);

    const firstSecret = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/secret?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(firstSecret.providerId, providerId);
    assert.equal(firstSecret.apiKey, "local-secret-one");
    assert.equal(firstSecret.apiKeyRef, `local:${providerId}`);
    assert.equal(firstSecret.configured, true);

    const firstCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstCheck.ok, true);
    assert.equal(openai.requests[0].authorization, "Bearer local-secret-one");
    assert.equal(openai.requests[0].body.model, "static-model");

    const updated = await patchJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`, {
      baseUrl: `${openai.url}/custom`,
      model: "updated-model",
      apiKey: "local-secret-two",
      enabled: true,
    });
    assert.equal(updated.provider.baseUrl, `${openai.url}/custom`);
    assert.equal(updated.provider.model, "updated-model");
    assert.equal(updated.provider.apiKeyRef, `local:${providerId}`);
    assert.doesNotMatch(JSON.stringify(updated), /local-secret-two/);
    const listedAfterUpdate = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    assert.doesNotMatch(JSON.stringify(listedAfterUpdate), /local-secret-two/);
    const updatedSecret = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/secret?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(updatedSecret.apiKey, "local-secret-two");

    const secondCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(secondCheck.ok, true);
    assert.equal(openai.requests[1].path, "/custom/chat/completions");
    assert.equal(openai.requests[1].authorization, "Bearer local-secret-two");
    assert.equal(openai.requests[1].body.model, "updated-model");

    const cleared = await patchJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`, {
      clearApiKey: true,
    });
    assert.equal(cleared.provider.apiKeyRef, undefined);
    assert.equal(cleared.provider.apiKeyConfigured, false);
    const clearedSecret = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/secret?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(clearedSecret.apiKey, "");
    assert.equal(clearedSecret.configured, false);

    const missingCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(missingCheck.ok, false);
    assert.equal(missingCheck.code, "secret_missing");
    assert.match(missingCheck.message, /API key missing/);

    const recreated = await patchJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`, {
      apiKey: "local-secret-three",
    });
    assert.equal(recreated.provider.apiKeyRef, `local:${providerId}`);
    const deleted = await fetch(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    await deleted.arrayBuffer();
    const store = createSqliteRunStore(cwd);
    try {
      assert.equal(store.hasProviderSecret(providerId), false);
    } finally {
      store.close();
    }
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
  });

  test("provider draft check validates direct API keys without persisting providers", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-draft-check-"));
    const openai = await startMockOpenAICompatibleServer();
    const daemon = await startDaemonForTest(new ApprovalProbeRunner({
      toolCallId: "tool_unused_draft_check",
      toolName: "bash",
      input: { command: "echo unused" },
    }));
    try {
      const missingCheck = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
        kind: "openai-compatible",
        displayName: "Draft Gateway",
        providerId: "draft-gateway",
        model: "draft-model",
        api: "openai-completions",
        baseUrl: `${openai.url}/v1`,
        authHeader: true,
        capabilities: ["chat", "tool_call"],
        enabled: true,
      });
      assert.equal(missingCheck.ok, false);
      assert.equal(missingCheck.code, "secret_missing");
      assert.match(missingCheck.message, /API key missing/);
      const listedAfterMissing = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(listedAfterMissing.providers.length, 0);

      const readyCheck = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
        kind: "openai-compatible",
        displayName: "Draft Gateway",
        providerId: "draft-gateway",
        model: "draft-model",
        api: "openai-completions",
        baseUrl: `${openai.url}/v1`,
        authHeader: true,
        apiKey: "draft-secret",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      });
      assert.equal(readyCheck.ok, true);
      assert.equal(openai.requests[0].path, "/v1/chat/completions");
      assert.equal(openai.requests[0].authorization, "Bearer draft-secret");
      assert.equal(openai.requests[0].body.model, "draft-model");
      assert.doesNotMatch(JSON.stringify(readyCheck), /draft-secret/);
      const listedAfterReady = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(listedAfterReady.providers.length, 0);
    } finally {
      await daemon.close();
      await openai.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("provider model listing probes the endpoint with the provided API key", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-models-"));
  const openai = await startMockOpenAICompatibleServer();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_model_list",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const result = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      providerId: "cliproxy",
      api: "openai-completions",
      baseUrl: `${openai.url}/v1`,
      authHeader: true,
      apiKey: "model-list-secret",
    });

    assert.equal(openai.requests[0].method, "GET");
    assert.equal(openai.requests[0].path, "/v1/models");
    assert.equal(openai.requests[0].authorization, "Bearer model-list-secret");
    assert.deepEqual(result.models.map((model) => model.id), ["cliproxy-gpt-4o", "cliproxy-claude-sonnet"], JSON.stringify({ result, requests: openai.requests }));
    assert.equal(result.source, `${openai.url}/v1/models`);
    assert.doesNotMatch(JSON.stringify(result), /model-list-secret/);
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media provider check distinguishes disabled, live-gated, and invalid transport config", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-media-gate-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_gate",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const disabled = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Disabled Gate",
      capabilities: ["image_generate"],
    });
    const disabledCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(disabled.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(disabledCheck.ok, true);
    assert.equal(disabledCheck.code, "static_check");
    assert.match(disabledCheck.message, /transport is disabled/);

    const live = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Gate",
      capabilities: ["image_generate"],
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const liveCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(live.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(liveCheck.ok, true);
    assert.equal(liveCheck.code, "static_check");
    assert.match(liveCheck.message, /Seedream image_generate live transport/);
    assert.match(liveCheck.message, /does not create media/);

    const missingSecret = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Missing Secret",
      capabilities: ["image_generate"],
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY_MISSING",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const missingSecretCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(missingSecret.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(missingSecretCheck.ok, false);
    assert.equal(missingSecretCheck.code, "secret_missing");
    assert.match(missingSecretCheck.message, /env:LING_STACK_TEST_MEDIA_KEY_MISSING/);

    const unsupported = await createMediaProvider(daemon.url, cwd, {
      kind: "seedance",
      displayName: "Seedance Live Gate",
      providerId: "seedance",
      model: "seedance",
      capabilities: ["video_generate"],
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const unsupportedCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(unsupported.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(unsupportedCheck.ok, false);
    assert.equal(unsupportedCheck.code, "unsupported_capability");
    assert.match(unsupportedCheck.message, /Seedream image_generate only/);

    const invalid = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Invalid Gate",
      capabilities: ["image_generate"],
      compat: { mediaVendorTransport: { mode: "fake" } },
    });
    const invalidCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(invalid.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(invalidCheck.ok, false);
    assert.equal(invalidCheck.code, "invalid_request");
    assert.match(invalidCheck.message, /reserved for test injection/);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job API creates, lists, and shows queued jobs without running on creation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-jobs-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      capabilities: ["image_generate", "image_edit"],
    });
    const providerId = createdProvider.provider.id;

    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: providerId,
      operation: "image_generate",
      prompt: "Create a launch card mockup.",
      input: { size: "1024x1024" },
    });

    assert.ok(createdJob.mediaJob.id.startsWith("media_job_"));
    assert.equal(createdJob.mediaJob.providerPresetId, providerId);
    assert.equal(createdJob.mediaJob.operation, "image_generate");
    assert.equal(createdJob.mediaJob.status, "queued");
    assert.deepEqual(createdJob.mediaJob.artifactIds, []);

    const listed = await getJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}&status=queued`);
    assert.equal(listed.mediaJobs.length, 1);
    assert.equal(listed.mediaJobs[0].id, createdJob.mediaJob.id);

    const fetched = await getJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(fetched.mediaJob.id, createdJob.mediaJob.id);
    assert.equal(fetched.mediaJob.prompt, "Create a launch card mockup.");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job run uses the media adapter contract and links artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-run-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_run",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Static",
      capabilities: ["image_generate"],
    });
    const providerId = createdProvider.provider.id;
    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: providerId,
      operation: "image_generate",
      prompt: "Create a local static artifact.",
      input: { size: "1024x1024", apiKey: "sk-test_123456789" },
    });

    const executed = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(executed.mediaJob.status, "succeeded");
    assert.equal(executed.artifacts.length, 1);
    assert.equal(executed.artifacts[0].mediaJobId, createdJob.mediaJob.id);
    assert.equal(executed.artifacts[0].type, "markdown");
    assert.deepEqual(executed.mediaJob.artifactIds, [executed.artifacts[0].id]);

    const listed = await getJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.mediaJobId, createdJob.mediaJob.id);
    assert.deepEqual(listed.artifacts, executed.artifacts);

    const content = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(executed.artifacts[0].id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(content.status, 200);
    assert.match(content.headers.get("content-type") ?? "", /text\/markdown/);
    const text = await content.text();
    assert.match(text, /Media job static result/);
    assert.match(text, /Vendor request plan/);
    assert.match(text, /"mode": "static_vendor_request_plan"/);
    assert.match(text, /"liveCall": false/);
    assert.match(text, /No vendor media API was called/);
    assert.doesNotMatch(text, /sk-test_123456789/);

    const rerun = await postJsonExpectError(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(rerun.status, 409);
    assert.equal(rerun.body.error, "media_job_not_runnable");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job run records media adapter failures", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-run-failure-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_run_failure",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      capabilities: ["image_generate"],
    });
    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a local static artifact failure.",
      input: { forceFailure: true },
    });

    const executed = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(executed.mediaJob.status, "failed");
    assert.match(executed.mediaJob.errorMessage, /forced failure/);
    assert.deepEqual(executed.mediaJob.artifactIds, []);
    assert.deepEqual(executed.artifacts, []);

    const errorJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a local static artifact error.",
      input: { forceErrorCode: "rate_limited" },
    });
    const errorExecuted = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(errorJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(errorExecuted.mediaJob.status, "failed");
    assert.match(errorExecuted.mediaJob.errorMessage, /rate_limited/);
    assert.deepEqual(errorExecuted.mediaJob.artifactIds, []);
    assert.deepEqual(errorExecuted.artifacts, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job live transport calls Seedream image_generate through HTTP and links artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-live-gate-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_live_gate",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  const seedream = await startMockSeedreamServer();
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Gate",
      capabilities: ["image_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a live gated artifact.",
      input: { size: "2K" },
    });

    const firstRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstRun.mediaJob.status, "waiting_for_approval");
    assert.equal(firstRun.approval.actionType, "media_cost");
    assert.equal(firstRun.approval.mediaJobId, createdJob.mediaJob.id);
    assert.equal(firstRun.approval.status, "pending");
    assert.equal(firstRun.approval.payload.type, "media_cost");
    assert.equal(firstRun.approval.payload.providerPresetId, createdProvider.provider.id);
    assert.equal(firstRun.approval.payload.operation, "image_generate");
    assert.equal(firstRun.approval.payload.promptPreview, "Create a live gated artifact.");
    assert.deepEqual(firstRun.artifacts, []);

    const repeatRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(repeatRun.mediaJob.status, "waiting_for_approval");
    assert.equal(repeatRun.approval.id, firstRun.approval.id);
    const pendingApprovals = await listApprovals(daemon.url, cwd, { mediaJobId: createdJob.mediaJob.id, status: "pending" });
    assert.equal(pendingApprovals.length, 1);

    const approved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(firstRun.approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "approved for live gate smoke",
    });
    assert.equal(approved.approval.status, "approved");

    const executed = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(executed.mediaJob.status, "succeeded");
    assert.equal(executed.artifacts.length, 3);
    assert.equal(seedream.requests.length, 2);
    assert.equal(seedream.requests[0].path, "/images/generations");
    assert.equal(seedream.requests[0].authorization, "Bearer test-key");
    assert.deepEqual(seedream.requests[0].body, {
      model: "seedream",
      prompt: "Create a live gated artifact.",
      response_format: "url",
      size: "2K",
    });
    assert.equal(seedream.requests[1].method, "GET");
    assert.equal(seedream.requests[1].path, "/generated/image-1.png");
    assert.equal(seedream.requests[1].authorization, undefined);
    assert.deepEqual(executed.mediaJob.artifactIds, executed.artifacts.map((artifact) => artifact.id));
    assert.equal(executed.artifacts[0].type, "markdown");
    assert.equal(executed.artifacts[1].type, "json");
    assert.equal(executed.artifacts[2].type, "image");
    assert.equal(executed.artifacts[2].contentType, "image/png");
    assert.equal(executed.artifacts[2].sizeBytes, 8);

    const liveArtifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(executed.artifacts[1].id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(liveArtifact.status, 200);
    const text = await liveArtifact.text();
    assert.match(text, /live_seedream_image_generate/);
    assert.match(text, /image-1\.png/);
    assert.doesNotMatch(text, /test-key/);

    const imageArtifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(executed.artifacts[2].id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(imageArtifact.status, 200);
    assert.equal(imageArtifact.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await imageArtifact.arrayBuffer()), Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedream.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job live transport gate fails denied or expired media approvals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-live-approval-fail-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_approval_fail",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Gate",
      capabilities: ["image_generate"],
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });

    const deniedJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a denied live artifact.",
    });
    const deniedGate = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(deniedJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(deniedGate.approval.id)}/deny?cwd=${encodeURIComponent(cwd)}`, {
      reason: "too expensive for this smoke",
    });
    const deniedRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(deniedJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(deniedRun.mediaJob.status, "failed");
    assert.match(deniedRun.mediaJob.errorMessage, /approval denied/);
    assert.equal(deniedRun.approval.id, deniedGate.approval.id);
    assert.deepEqual(deniedRun.artifacts, []);

    const expiredJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create an expired live artifact.",
    });
    const expiredGate = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(expiredJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    const store = createSqliteRunStore(cwd);
    try {
      const expired = store.expireApprovalRequest(
        expiredGate.approval.id,
        { reason: "Approval request expired before a decision was received." },
        "2026-05-24T00:30:00.000Z",
      );
      assert.ok(expired);
      assert.equal(expired.status, "expired");
    } finally {
      store.close();
    }
    const expiredRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(expiredJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(expiredRun.mediaJob.status, "failed");
    assert.match(expiredRun.mediaJob.errorMessage, /approval expired/);
    assert.equal(expiredRun.approval.id, expiredGate.approval.id);
    assert.deepEqual(expiredRun.artifacts, []);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job API rejects chat providers and unsupported media operations", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-jobs-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_reject",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const chatProvider = await createStaticChatProvider(daemon.url, cwd, {
      displayName: "Chat Only",
      providerId: "chat-only",
    });
    const mediaProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedance Video",
      providerId: "seedance",
      model: "seedance",
      capabilities: ["video_generate"],
    });

    const chatRejected = await postJsonExpectError(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: chatProvider.provider.id,
      operation: "image_generate",
      prompt: "Create an image.",
    });
    assert.equal(chatRejected.status, 400);
    assert.equal(chatRejected.body.error, "unsupported_capability");

    const operationRejected = await postJsonExpectError(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: mediaProvider.provider.id,
      operation: "image_generate",
      prompt: "Create an image.",
    });
    assert.equal(operationRejected.status, 400);
    assert.equal(operationRejected.body.error, "unsupported_capability");
    assert.equal(await mediaJobCount(daemon.url, cwd), 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media provider presets remain blocked from coding task runs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-run-block-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_media_run_block",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const created = await createMediaProvider(daemon.url, cwd);
    const blocked = await postRunExpectError(daemon.url, providerRunBody(cwd, "task_media_provider_run", created.provider.id));

    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, "unsupported_capability");
    assert.match(blocked.body.message, /Media provider presets cannot run pi coding tasks/);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider preset run requires successful daemon preflight", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-run-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_preflight_ready",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      displayName: "GLM Static",
      providerId: "glm-static",
    });
    const providerId = created.provider.id;

    const blocked = await postRunExpectError(daemon.url, providerRunBody(cwd, "task_provider_unchecked", providerId));
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, "provider_preflight_failed");
    assert.match(blocked.body.message, /provider has not been checked/);
    assert.equal(runner.runs.length, 0);

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, true);

    const { runId } = await postRunAndCollectEvents(daemon.url, providerRunBody(cwd, "task_provider_ready", providerId));
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed provider checks block daemon preset runs unless skipped", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-run-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_preflight_failed",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "Broken Relay",
      providerId: "broken-relay",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
    });
    const providerId = created.provider.id;
    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, false);

    const blocked = await postRunExpectError(daemon.url, providerRunBody(cwd, "task_provider_failed", providerId));
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, "provider_preflight_failed");
    assert.match(blocked.body.message, /provider check failed/);
    assert.equal(runner.runs.length, 0);

    const { runId } = await postRunAndCollectEvents(
      daemon.url,
      providerRunBody(cwd, "task_provider_skip_preflight", providerId, { skipProviderPreflight: true }),
    );
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run endpoint rejects paused channels before runner start", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-paused-channel-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_paused_channel",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Paused Engineering",
      status: "paused",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Paused task",
      prompt: "This task must not start while paused.",
    });

    const blocked = await postJsonExpectError(
      `${daemon.url}/tasks/${encodeURIComponent(task.task.id)}/run?cwd=${encodeURIComponent(cwd)}`,
      {
        providerPresetId: provider.provider.id,
        skipProviderPreflight: true,
        tools: ["read", "write"],
        idempotencyKey: "paused-channel-key",
      },
    );

    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "channel_paused");
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("same idempotency key returns the original task run without starting a duplicate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-idempotent-run-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Idempotent task",
      prompt: "Start once even if the browser retries.",
    });

    const body = {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "client-retry-key",
    };
    const firstResponse = await postTaskRunStream(daemon.url, cwd, task.task.id, body);
    const firstSse = createSseReader(firstResponse);
    const firstReady = await firstSse.nextEvent();
    assert.equal(firstReady.event, "ready");
    const runId = firstReady.data.runId;
    await runner.waitUntilStarted();

    const duplicateResponse = await postTaskRunStream(daemon.url, cwd, task.task.id, body);
    const duplicateEvents = parseSseText(await duplicateResponse.text());
    assert.equal(duplicateEvents[0].event, "ready");
    assert.equal(duplicateEvents[0].data.runId, runId);
    assert.equal(duplicateEvents[0].data.duplicate, true);
    assert.equal(runner.runs.length, 1);

    runner.release();
    await firstSse.collectRemaining();
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write runs in channels sharing a bound path conflict through resource leases", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-bound-path-lock-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const firstChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering A",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const secondChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering B",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const firstTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: firstChannel.channel.id,
      title: "First writer",
      prompt: "Hold the path lock.",
    });
    const secondTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: secondChannel.channel.id,
      title: "Second writer",
      prompt: "Wait for the path lock.",
    });

    const firstResponse = await postTaskRunStream(daemon.url, cwd, firstTask.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["write"],
      idempotencyKey: "first-writer",
    });
    const firstSse = createSseReader(firstResponse);
    const firstReady = await firstSse.nextEvent();
    const runId = firstReady.data.runId;
    await runner.waitUntilStarted();

    const activeLeases = await getJson(`${daemon.url}/runtime/leases?cwd=${encodeURIComponent(cwd)}&status=active`);
    assert.equal(activeLeases.leases.some((lease) => lease.ownerId === runId && lease.resourceType === "bound_path"), true);
    assert.equal(activeLeases.leases.some((lease) => lease.ownerId === runId && lease.resourceType === "task"), true);

    const blocked = await postJsonExpectError(
      `${daemon.url}/tasks/${encodeURIComponent(secondTask.task.id)}/run?cwd=${encodeURIComponent(cwd)}`,
      {
        providerPresetId: provider.provider.id,
        skipProviderPreflight: true,
        tools: ["write"],
        idempotencyKey: "second-writer",
      },
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "resource_conflict");
    assert.match(blocked.body.message, /bound_path/);

    const transitions = await getJson(
      `${daemon.url}/state-transitions?cwd=${encodeURIComponent(cwd)}&entityType=task&entityId=${encodeURIComponent(firstTask.task.id)}`,
    );
    assert.equal(transitions.transitions.some((event) => event.event === "claim" && event.toStatus === "claimed"), true);
    assert.equal(transitions.transitions.some((event) => event.event === "start_run" && event.toStatus === "running"), true);

    runner.release();
    await firstSse.collectRemaining();

    const remainingLeases = await getJson(`${daemon.url}/runtime/leases?cwd=${encodeURIComponent(cwd)}&status=active`);
    assert.equal(remainingLeases.leases.some((lease) => lease.ownerId === runId), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancelled runs are not overwritten when a late runner reports success", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-cancel-race-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Cancelable task",
      prompt: "Cancel while runner is still active.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "cancel-race",
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const runId = ready.data.runId;
    await runner.waitUntilStarted();

    const cancel = await postJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancel.cancelled, true);
    assert.equal(cancel.run.status, "cancelled");

    runner.release();
    await sse.collectRemaining();

    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "cancelled");
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("artifact APIs list metadata and serve content from the artifacts root", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-artifacts-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_artifact_read",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_artifact_api"));
    assert.ok(runId);

    const store = createSqliteRunStore(cwd);
    try {
      const artifactDir = resolve(store.paths.artifactsDir, runId);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(resolve(artifactDir, "evidence.md"), "# Evidence\n\nRun artifact content.\n", "utf8");
      store.createArtifact({
        id: "artifact_api_markdown",
        runId,
        type: "markdown",
        path: `${runId}/evidence.md`,
        title: "Evidence Markdown",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 33,
        createdAt: "2026-05-22T00:00:00.000Z",
      });
      store.createArtifact({
        id: "artifact_api_outside",
        runId,
        type: "log",
        path: resolve(cwd, "outside.log"),
        title: "Outside log",
        createdAt: "2026-05-22T00:00:01.000Z",
      });
    } finally {
      store.close();
    }

    const listed = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.runId, runId);
    assert.equal(listed.artifacts.length, 2);
    assert.equal(listed.artifacts[0].id, "artifact_api_markdown");
    assert.equal(listed.artifacts[0].title, "Evidence Markdown");

    const metadata = await getJson(`${daemon.url}/artifacts/artifact_api_markdown?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(metadata.artifact.runId, runId);
    assert.equal(metadata.artifact.type, "markdown");

    const content = await fetch(`${daemon.url}/artifacts/artifact_api_markdown/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await content.text(), "# Evidence\n\nRun artifact content.\n");

    const outside = await fetch(`${daemon.url}/artifacts/artifact_api_outside/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(outside.status, 403);
    assert.equal((await outside.json()).error, "artifact_outside_root");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon extracts artifacts from tool outputs and generated file paths", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-extract-artifacts-"));
  const runner = new ArtifactExtractionRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_artifact_extraction"));
    assert.ok(runId);

    const listed = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.runId, runId);
    assert.ok(listed.artifacts.length >= 4);
    assert.ok(events.some((event) => event.event === "artifact_created"));

    const generatedMarkdown = listed.artifacts.find((artifact) => artifact.title.startsWith("Generated file content:"));
    assert.ok(generatedMarkdown);
    assert.equal(generatedMarkdown.type, "markdown");
    assert.ok(generatedMarkdown.path.startsWith(`${runId}/`));
    const markdownContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(generatedMarkdown.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(markdownContent.status, 200);
    const markdownText = await markdownContent.text();
    assert.match(markdownText, /# Generated report/);
    assert.doesNotMatch(markdownText, /sk-test_123456789/);
    assert.match(markdownText, /\[REDACTED\]/);

    const diffArtifact = listed.artifacts.find((artifact) => artifact.type === "diff");
    assert.ok(diffArtifact);
    const diffContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(diffArtifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(diffContent.status, 200);
    assert.match(await diffContent.text(), /diff --git/);

    const fileMetadata = listed.artifacts.find((artifact) => artifact.type === "file" && artifact.title.includes("notes/result.md"));
    assert.ok(fileMetadata);
    const metadataContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(fileMetadata.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(metadataContent.status, 200);
    assert.match(await metadataContent.text(), /Content was not copied/);

    for (const artifact of listed.artifacts) {
      const content = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(artifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(content.status, 200, `${artifact.id} should be served from the artifact root`);
    }
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class ApprovalProbeRunner {
  constructor(request) {
    this.request = request;
    this.decisions = [];
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
      apiKey: options.provider.apiKey,
      taskId: options.task.id,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });

    const decision = await options.onApprovalRequired?.({
      ...this.request,
      task: options.task,
      cwd: options.cwd,
    });
    if (decision) {
      this.decisions.push(decision);
      options.onEvent?.({
        type: "tool_end",
        toolCallId: this.request.toolCallId,
        toolName: this.request.toolName,
        result: { approved: decision.approved, reason: decision.reason },
        isError: !decision.approved,
      });
    }

    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

class SecretEchoRunner {
  constructor(secretValue) {
    this.secretValue = secretValue;
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
      apiKey: options.provider.apiKey,
      taskId: options.task.id,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "tool_start",
      toolCallId: "tool_secret_echo",
      toolName: "write",
      args: {
        path: "secret-output.txt",
        content: `secret=${this.secretValue}`,
      },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_secret_echo",
      toolName: "write",
      result: {
        content: `runner observed ${this.secretValue}`,
        path: "secret-output.txt",
      },
      isError: false,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: `done ${this.secretValue}` }],
    };
  }
}

class ArtifactExtractionRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });

    options.onEvent?.({
      type: "tool_start",
      toolCallId: "tool_write_artifact",
      toolName: "write",
      args: {
        path: "notes/result.md",
        content: "# Generated report\n\nCreated with sk-test_123456789.\n",
      },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_write_artifact",
      toolName: "write",
      result: { path: "notes/result.md", content: [{ type: "text", text: "wrote notes/result.md\n" }] },
      isError: false,
    });

    options.onEvent?.({
      type: "tool_start",
      toolCallId: "tool_edit_artifact",
      toolName: "edit",
      args: { path: "src/app.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_edit_artifact",
      toolName: "edit",
      result: { diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-const value = 1;\n+const value = 2;\n" },
      isError: false,
    });

    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

class BlockingRunner {
  constructor() {
    this.runs = [];
    this._startedCount = 0;
    this._startedResolvers = [];
    this._releasePromise = new Promise((resolveRelease) => {
      this._release = resolveRelease;
    });
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
      taskId: options.task.id,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    this._startedCount += 1;
    for (const resolveStarted of this._startedResolvers.splice(0)) {
      resolveStarted();
    }

    await this._releasePromise;

    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }

  async waitUntilStarted(count = 1) {
    if (this._startedCount >= count) {
      return;
    }
    await withTimeout(
      new Promise((resolveStarted) => {
        this._startedResolvers.push(resolveStarted);
      }),
      5_000,
      "Timed out waiting for blocking runner to start.",
    );
  }

  release() {
    this._release?.();
  }
}

async function startDaemonForTest(runner, dependencies = {}) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, { runner, ...dependencies });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function createTestSecretResolver(expectedRef, value) {
  return {
    status(ref) {
      if (ref !== expectedRef) {
        return {
          ref,
          kind: ref.startsWith("keychain:") ? "keychain" : "env",
          configured: false,
          errorCode: "secret_missing",
          message: `Secret is not configured: ${ref}`,
        };
      }
      return {
        ref,
        kind: ref.startsWith("keychain:") ? "keychain" : "env",
        configured: true,
      };
    },
    resolve(ref) {
      const status = this.status(ref);
      return status.configured ? { ref, configured: true, value, status } : { ref, configured: false, status };
    },
  };
}

function runBody(cwd, taskId) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Trigger approval probe.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["bash", "write"],
    thinkingLevel: "off",
  };
}

function providerRunBody(cwd, taskId, providerPresetId, overrides = {}) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Trigger provider preset run.",
    },
    providerPresetId,
    tools: ["read"],
    thinkingLevel: "off",
    ...overrides,
  };
}

async function createStaticChatProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

async function createMediaProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "seedream",
    displayName: "Seedream Image",
    providerId: "seedream",
    model: "seedream",
    api: "media-job",
    capabilities: ["image_generate", "image_edit"],
    input: ["text", "image"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

async function startMockSeedreamServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/generated/image-1.png") {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: {},
      });
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      created: 1779537600,
      data: [{ url: `http://${request.headers.host}/generated/image-1.png` }],
      debug: { echo: request.headers.authorization },
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function startMockOpenAICompatibleServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    if (request.method === "GET" && new URL(request.url ?? "/", "http://127.0.0.1").pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [
          { id: "cliproxy-gpt-4o", object: "model", owned_by: "cliproxy" },
          { id: "cliproxy-claude-sonnet", object: "model", owned_by: "cliproxy" },
        ],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-local-secret-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function mediaJobCount(baseUrl, cwd) {
  const response = await getJson(`${baseUrl}/media-jobs?cwd=${encodeURIComponent(cwd)}`);
  return response.mediaJobs.length;
}

async function patchPolicy(baseUrl, cwd, body) {
  return await patchJson(`${baseUrl}/approval-policy?cwd=${encodeURIComponent(cwd)}`, body);
}

async function listApprovals(baseUrl, cwd, filters) {
  const url = new URL(`${baseUrl}/approvals`);
  url.searchParams.set("cwd", cwd);
  if (typeof filters === "string") {
    url.searchParams.set("runId", filters);
  } else {
    if (filters.runId) {
      url.searchParams.set("runId", filters.runId);
    }
    if (filters.mediaJobId) {
      url.searchParams.set("mediaJobId", filters.mediaJobId);
    }
    if (filters.status) {
      url.searchParams.set("status", filters.status);
    }
  }
  const response = await getJson(url.toString());
  return response.approvals;
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await postRunStream(baseUrl, body);
  const text = await response.text();
  const events = parseSseText(text);
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

async function postRunStream(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  assert.ok(response.body);
  return response;
}

async function postTaskRunStream(baseUrl, cwd, taskId, body) {
  const response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/run?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  assert.ok(response.body);
  return response;
}

async function postRunExpectError(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.notEqual(response.status, 200, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function postJsonExpectError(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, false, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  assert.ok(response.ok, text);
  return text.trim() ? JSON.parse(text) : {};
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextEvent() {
      for (;;) {
        const block = takeNextSseBlock();
        if (block !== undefined) {
          const event = parseSseBlock(block);
          if (event) {
            return event;
          }
          continue;
        }

        const { done, value } = await withTimeout(reader.read(), 5_000, "Timed out waiting for SSE event.");
        if (done) {
          buffer += decoder.decode();
          const finalBlock = buffer.trim() ? buffer : undefined;
          buffer = "";
          return finalBlock ? parseSseBlock(finalBlock) : undefined;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },

    async collectRemaining() {
      const events = [];
      for (;;) {
        const event = await this.nextEvent();
        if (!event) {
          return events;
        }
        events.push(event);
      }
    },
  };

  function takeNextSseBlock() {
    const match = /\r?\n\r?\n/.exec(buffer);
    if (!match) {
      return undefined;
    }
    const block = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    return block;
  }
}

async function waitForSseEvent(reader, eventName) {
  for (;;) {
    const event = await reader.nextEvent();
    assert.ok(event, `SSE stream ended before ${eventName}`);
    if (event.event === eventName) {
      return event;
    }
  }
}

function parseSseText(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(parseSseBlock)
    .filter(Boolean);
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith("event:")) {
      event = rawLine.slice("event:".length).trim();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  return {
    event,
    data: JSON.parse(dataLines.join("\n")),
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise.finally(() => {
      clearTimeout(timeout);
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}
