import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

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
    assert.equal(executed.artifacts.length, 2);
    assert.equal(seedream.requests.length, 1);
    assert.equal(seedream.requests[0].path, "/images/generations");
    assert.equal(seedream.requests[0].authorization, "Bearer test-key");
    assert.deepEqual(seedream.requests[0].body, {
      model: "seedream",
      prompt: "Create a live gated artifact.",
      response_format: "url",
      size: "2K",
    });
    assert.deepEqual(executed.mediaJob.artifactIds, executed.artifacts.map((artifact) => artifact.id));
    assert.equal(executed.artifacts[0].type, "markdown");
    assert.equal(executed.artifacts[1].type, "json");

    const liveArtifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(executed.artifacts[1].id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(liveArtifact.status, 200);
    const text = await liveArtifact.text();
    assert.match(text, /live_seedream_image_generate/);
    assert.match(text, /image-1\.png/);
    assert.doesNotMatch(text, /test-key/);
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

async function startDaemonForTest(runner) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, { runner });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
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
      data: [{ url: "https://media.example.invalid/generated/image-1.png" }],
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
