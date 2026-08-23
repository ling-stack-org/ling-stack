import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { auditIgnoredRunnerCompletion } from "../dist/features/runs/stale-completion.js";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

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

test("runtime runner settings api seeds Pi defaults and explicit runner requests fail closed", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runner-settings-"));
  const runner = new ThreadResumeRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const runners = await getJson(`${daemon.url}/runners?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runners.cwd, cwd);
    assert.equal(runners.runners.some((item) => item.id === "pi" && item.status === "enabled"), true);

    const seeded = await getJson(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(seeded.settings, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      defaultRunnerId: "pi",
      allowedRunnerIds: ["pi"],
      explicitRunnerFallback: "disabled",
      implicitRunnerFallback: "allow_to_default",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });

    const patched = await patchJson(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`, {
      explicitRunnerFallback: "allow_to_default",
    });
    assert.equal(patched.settings.explicitRunnerFallback, "allow_to_default");
    assert.ok(Date.parse(patched.settings.updatedAt));

    const invalid = await patchJsonExpectError(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`, {
      defaultRunnerId: "codex-app-server",
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "bad_request");

    await patchJson(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`, {
      explicitRunnerFallback: "disabled",
    });
    const explicit = await postRunExpectError(daemon.url, {
      ...runBody(cwd, "task_explicit_unknown_runner"),
      runnerId: "codex-app-server",
    });
    assert.equal(explicit.status, 400);
    assert.equal(explicit.body.error, "unsupported_runner");

    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_workspace_default_runner"));
    assert.ok(runId);
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.requestSnapshot.runnerResolution.requestSource, "workspace_default");
    assert.equal(run.requestSnapshot.runnerResolution.fallbackAllowed, true);
    assert.equal(run.requestSnapshot.runnerResolution.effectiveRunnerId, "pi");
    assert.equal(run.requestSnapshot.runtimeSettings.defaultRunnerId, "pi");
    assert.equal(run.taskSnapshot.id, "task_workspace_default_runner");
    assert.equal(run.requestSnapshot.task.id, "task_workspace_default_runner");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
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

test("risk review upgrades allowed force push into an explicit approval request", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-risk-review-force-push-"));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://example.com/ling-stack.git"], { cwd, stdio: "ignore" });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd, stdio: "ignore" });
  execFileSync("git", ["branch", "--set-upstream-to", "origin/main", "main"], { cwd, stdio: "ignore" });
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_risk_review_force_push",
    toolName: "bash",
    input: { command: "git push origin main --force-with-lease" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_risk_review_force_push"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    assert.equal(runner.decisions.length, 0);
    assert.equal(requested.data.data.risk, "critical");
    assert.match(requested.data.data.title, /Risk review required/);
    assert.match(requested.data.data.description, /Risk review/);
    assert.deepEqual(requested.data.data.payload.riskFlags, ["git_force_push"]);

    const approvals = await listApprovals(daemon.url, cwd, runId);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, approvalId);
    assert.equal(approvals[0].status, "pending");
    assert.equal(approvals[0].risk, "critical");

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/deny?cwd=${encodeURIComponent(cwd)}`, {
      reason: "risk review denied",
    });
    await sse.collectRemaining();
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /risk review denied/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtimeTools.unifiedExec config is authoritative over run request feature flags", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-gate-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_request_gate",
    toolName: "bash",
    input: { command: "echo request-only" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_unified_exec_request_gate"),
      runtimeToolFeatures: { unifiedExec: true },
    });

    assert.equal(runner.runs[0].runtimeToolFeatures?.unifiedExec, false);
    assert.deepEqual(runner.decisions[0], {
      approved: true,
      reason: "Ling Stack policy allowed bash.",
    });
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified exec bash=allow runs through daemon and records redacted artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-allow-"));
  const secretValue = "unified-exec-secret-value";
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_unified_exec_allow",
    toolName: "bash",
    input: { command: `printf 'hello ${secretValue}\\n'` },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_unified_exec_allow"),
      provider: {
        provider: "test-provider",
        model: "test-model",
        apiKey: secretValue,
      },
    });

    assert.equal(runner.runs[0].runtimeToolFeatures?.unifiedExec, true);
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, true);
    assert.equal(runner.decisions[0].handledResult.isError, false);
    const result = runner.decisions[0].handledResult.details.unifiedExec;
    assert.equal(result.status, "succeeded");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.preview, /hello \[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify({ events, result }), new RegExp(secretValue));
    assert.deepEqual(await listApprovals(daemon.url, cwd, runId), []);

    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    const execArtifacts = artifacts.artifacts.filter((artifact) => artifact.path.includes(`/unified-exec/${runner.request.toolCallId}/`));
    assert.deepEqual(execArtifacts.map((artifact) => artifact.path.split("/").at(-1)).sort(), ["result.json", "stdout.txt"]);
    for (const artifact of execArtifacts) {
      const response = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(artifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(response.status, 200);
      const content = await response.text();
      assert.doesNotMatch(content, new RegExp(secretValue));
      assert.match(content, /\[REDACTED\]/);
    }
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shell snapshots stay disabled when only the run request asks for them", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-shell-snapshot-gate-"));
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_shell_snapshot_request_gate",
    toolName: "bash",
    input: { command: "printf 'request-gated\\n'" },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_shell_snapshot_request_gate"),
      runtimeToolFeatures: { unifiedExec: true, shellSnapshot: true },
    });

    assert.equal(runner.runs[0].runtimeToolFeatures?.unifiedExec, true);
    assert.equal(runner.runs[0].runtimeToolFeatures?.shellSnapshot, false);
    assert.equal(runner.decisions[0].handledResult.details.unifiedExec.status, "succeeded");

    const snapshots = await listShellSnapshots(daemon.url, cwd, runId);
    assert.deepEqual(snapshots.snapshots, []);
    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(artifacts.artifacts.some((artifact) => artifact.path.includes("/shell-snapshots/")), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shell snapshots record unified exec start and end artifacts with redaction", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-shell-snapshot-allow-"));
  const secretValue = "shell-snapshot-secret-value";
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_shell_snapshot_allow",
    toolName: "bash",
    input: { command: `printf 'snapshot ${secretValue}\\n'` },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true, shellSnapshot: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_shell_snapshot_allow"),
      provider: {
        provider: "test-provider",
        model: "test-model",
        apiKey: secretValue,
      },
    });

    assert.equal(runner.runs[0].runtimeToolFeatures?.shellSnapshot, true);
    assert.equal(runner.decisions[0].handledResult.details.unifiedExec.status, "succeeded");

    const listed = await listShellSnapshots(daemon.url, cwd, runId);
    assert.equal(listed.runId, runId);
    assert.deepEqual(listed.snapshots.map((snapshot) => snapshot.source), ["exec_start", "exec_end"]);
    assert.deepEqual(listed.snapshots.map((snapshot) => snapshot.status), ["starting", "exited"]);
    assert.equal(listed.snapshots.every((snapshot) => snapshot.artifactId && snapshot.textArtifactId), true);
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(secretValue));

    const filtered = await listShellSnapshots(daemon.url, cwd, runId, "tool_shell_snapshot_allow");
    assert.equal(filtered.snapshots.length, 2);
    const emptyFiltered = await listShellSnapshots(daemon.url, cwd, runId, "tool_other");
    assert.equal(emptyFiltered.snapshots.length, 0);

    const detail = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/shell-snapshots/${encodeURIComponent(listed.snapshots[1].id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.snapshot.id, listed.snapshots[1].id);
    assert.equal(detail.snapshot.source, "exec_end");
    assert.equal(detail.snapshot.status, "exited");
    assert.equal(detail.snapshot.redaction.redacted, true);
    assert.equal(detail.snapshot.redaction.commandRedacted, true);
    assert.equal(detail.snapshot.redaction.stdoutRedacted, true);
    assert.match(detail.snapshot.command.commandPreview, /\[REDACTED\]/);
    assert.match(detail.snapshot.output.stdoutHead, /snapshot \[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(detail), new RegExp(secretValue));

    for (const artifactId of [listed.snapshots[0].artifactId, listed.snapshots[0].textArtifactId, listed.snapshots[1].artifactId, listed.snapshots[1].textArtifactId]) {
      const response = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(artifactId)}/content?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(response.status, 200);
      const content = await response.text();
      assert.doesNotMatch(content, new RegExp(secretValue));
    }
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified exec bash=deny returns handled denial and never spawns", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-deny-"));
  const markerPath = resolve(cwd, "should-not-exist.txt");
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_unified_exec_deny",
    toolName: "bash",
    input: { command: "touch should-not-exist.txt" },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true, shellSnapshot: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "deny" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_unified_exec_deny"));

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.equal(runner.decisions[0].handledResult.isError, true);
    assert.match(runner.decisions[0].handledResult.content[0].text, /policy denied bash/);
    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);

    const approvals = await listApprovals(daemon.url, cwd, runId);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(artifacts.artifacts.some((artifact) => artifact.path.includes("/unified-exec/")), false);
    assert.equal(artifacts.artifacts.some((artifact) => artifact.path.includes("/shell-snapshots/")), false);
    assert.deepEqual((await listShellSnapshots(daemon.url, cwd, runId)).snapshots, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified exec bash=ask waits for approval before running", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-ask-"));
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_unified_exec_ask",
    toolName: "bash",
    input: { command: "printf 'approved\\n'" },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true, shellSnapshot: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_unified_exec_ask"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    assert.equal(runner.decisions.length, 0);
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "run unified exec",
    });
    const remaining = await sse.collectRemaining();

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, true);
    assert.equal(runner.decisions[0].approvalId, approvalId);
    const result = runner.decisions[0].handledResult.details.unifiedExec;
    assert.equal(result.status, "succeeded");
    assert.equal(result.approvalId, approvalId);
    assert.match(result.stdout.preview, /approved/);
    assert.equal(remaining.some((event) => event.event === "approval_approved"), true);
    assert.equal(remaining.some((event) => event.event === "artifact_created"), true);

    const snapshots = await listShellSnapshots(daemon.url, cwd, runId);
    assert.deepEqual(snapshots.snapshots.map((snapshot) => snapshot.status), ["starting", "exited"]);
    const detail = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/shell-snapshots/${encodeURIComponent(snapshots.snapshots[1].id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.snapshot.approvalId, approvalId);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified exec nonzero exit returns a handled failed result", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-nonzero-"));
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_unified_exec_nonzero",
    toolName: "bash",
    input: { command: "printf 'bad stderr\\n' >&2; exit 7" },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true, shellSnapshot: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_unified_exec_nonzero"));

    const handled = runner.decisions[0].handledResult;
    assert.equal(handled.isError, true);
    const result = handled.details.unifiedExec;
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 7);
    assert.match(result.stderr.preview, /bad stderr/);
    assert.match(handled.content[0].text, /Command exited 7/);

    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(artifacts.artifacts.some((artifact) => artifact.path.endsWith("/stderr.txt")), true);
    const snapshots = await listShellSnapshots(daemon.url, cwd, runId);
    assert.deepEqual(snapshots.snapshots.map((snapshot) => snapshot.status), ["starting", "failed"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified exec command timeout returns timed_out and does not create approvals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-timeout-"));
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_unified_exec_timeout",
    toolName: "bash",
    input: { command: "sleep 2", timeoutMs: 50 },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true, shellSnapshot: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_unified_exec_timeout"));

    const handled = runner.decisions[0].handledResult;
    assert.equal(handled.isError, true);
    const result = handled.details.unifiedExec;
    assert.equal(result.status, "timed_out");
    assert.equal(result.timedOut, true);
    assert.match(handled.content[0].text, /timed out/);
    assert.deepEqual(await listApprovals(daemon.url, cwd, runId), []);
    const snapshots = await listShellSnapshots(daemon.url, cwd, runId);
    assert.deepEqual(snapshots.snapshots.map((snapshot) => snapshot.status), ["starting", "timed_out"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified exec rejects PTY requests as handled failures without spawning", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-pty-"));
  const markerPath = resolve(cwd, "pty-should-not-run.txt");
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_unified_exec_pty",
    toolName: "bash",
    input: { command: "touch pty-should-not-run.txt", pty: true },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true, shellSnapshot: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_unified_exec_pty"));

    const handled = runner.decisions[0].handledResult;
    assert.equal(handled.isError, true);
    const result = handled.details.unifiedExec;
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, undefined);
    assert.match(result.stderr.preview, /does not support PTY/);
    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);

    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(artifacts.artifacts.filter((artifact) => artifact.path.includes("/unified-exec/")).map((artifact) => artifact.path.split("/").at(-1)).sort(), ["result.json", "stderr.txt"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified exec bounds long output chunks and stream previews", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-long-output-"));
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_unified_exec_long_output",
    toolName: "bash",
    input: { command: "node -e \"process.stdout.write('x'.repeat(9000)); process.stderr.write('y'.repeat(5000));\"" },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_unified_exec_long_output"));

    const result = runner.decisions[0].handledResult.details.unifiedExec;
    assert.equal(result.status, "succeeded");
    assert.equal(Buffer.byteLength(result.stdout.preview, "utf8") <= 8 * 1024, true);
    assert.equal(Buffer.byteLength(result.stderr.preview, "utf8") <= 8 * 1024, true);
    assert.equal(result.stdout.truncated, true);
    assert.equal(result.stderr.truncated, false);

    const chunks = events
      .filter((event) => event.event === "tool_update")
      .map((event) => event.data.data.partialResult);
    assert.equal(chunks.length > 2, true);
    for (const chunk of chunks) {
      assert.equal(chunk.toolCallId, "tool_unified_exec_long_output");
      assert.equal(Buffer.byteLength(chunk.text, "utf8") <= 4 * 1024, true);
    }

    const actions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(typeof actions.revision, "string");
    assert.equal(actions.actions.length, 1);
    const action = actions.actions[0];
    assert.equal(action.status, "succeeded");
    assert.equal(action.risk, "low");
    assert.equal(action.commandEvidence.command, runner.request.input.command);
    assert.equal(action.commandEvidence.exitCode, 0);
    assert.equal(action.commandEvidence.durationMs >= 0, true);
    assert.equal(action.commandEvidence.outputByteCount, 14_000);
    assert.equal(action.commandEvidence.outputTail.length <= 64, true);
    assert.equal(Buffer.byteLength(action.commandEvidence.outputTail.map((chunk) => chunk.text).join(""), "utf8") <= 8 * 1024, true);
    assert.equal(action.commandEvidence.outputTruncated, true);
    assert.ok(action.commandEvidence.stdoutArtifactId);
    assert.ok(action.commandEvidence.stderrArtifactId);
    assert.ok(action.commandEvidence.resultArtifactId);

    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    const execArtifacts = artifacts.artifacts.filter((artifact) => artifact.path.includes(`/unified-exec/${runner.request.toolCallId}/`));
    assert.deepEqual(execArtifacts.map((artifact) => artifact.path.split("/").at(-1)).sort(), ["result.json", "stderr.txt", "stdout.txt"]);
    assert.equal(result.artifacts.find((artifact) => artifact.role === "stdout")?.truncated, false);
    assert.equal(result.artifacts.find((artifact) => artifact.role === "stderr")?.truncated, false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified exec run cancellation kills command and leaves the run cancelled", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-unified-exec-cancel-"));
  const markerPath = resolve(cwd, "after-cancel.txt");
  const runner = new UnifiedExecProbeRunner({
    toolCallId: "tool_unified_exec_cancel",
    toolName: "bash",
    input: { command: "sleep 5; printf done > after-cancel.txt" },
  });
  const daemon = await startDaemonForTest(runner, {}, { runtimeTools: { unifiedExec: true, shellSnapshot: true } });
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_unified_exec_cancel"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    await waitForSseEvent(sse, "tool_start");

    const cancelled = await postJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {
      reason: "test cancellation",
    });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.run.status, "cancelled");
    await sse.collectRemaining();

    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "cancelled");
    const actions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(actions.actions.length, 1);
    assert.equal(actions.actions[0].status, "cancelled");
    assert.equal(actions.actions[0].commandEvidence.command, runner.request.input.command);
    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);
    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(artifacts.artifacts.some((artifact) => artifact.path.endsWith("/unified-exec/tool_unified_exec_cancel/result.json")), true);
    const snapshots = await listShellSnapshots(daemon.url, cwd, runId);
    assert.deepEqual(snapshots.snapshots.map((snapshot) => snapshot.status), ["starting", "cancelled"]);
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

test("session permission mode snapshots the effective run policy without relaxing deny rules", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-session-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_session_policy",
    toolName: "write",
    input: { path: "notes/session.md", content: "mode snapshot" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, {
      toolDecisions: {
        bash: "deny",
        write: "deny",
      },
      allowedWritePaths: ["docs"],
    });
    const { runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_session_policy_snapshot"),
      permissionMode: "full_access",
      permissionConfirmation: {
        mode: "full_access",
        confirmed: true,
        confirmedAt: "2026-06-04T00:00:00.000Z",
        reason: "test_confirmed_full_access",
      },
    });

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.requestSnapshot.permissionMode, "full_access");
    assert.equal(run.requestSnapshot.permissionConfirmation.reason, "test_confirmed_full_access");
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.mode, "full_access");
    assert.equal(typeof run.requestSnapshot.effectivePolicySnapshot.workspacePolicyUpdatedAt, "string");
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.toolDecisions.bash, "deny");
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.toolDecisions.write, "deny");
    assert.deepEqual(run.requestSnapshot.effectivePolicySnapshot.allowedWritePaths, ["/"]);
    assert.ok(run.requestSnapshot.effectivePolicySnapshot.riskNotes.some((note) =>
      note.code === "session_mode_denied_by_workspace_policy" && /workspace policy denied/.test(note.message)
    ));
    assert.equal(runner.decisions[0].approved, false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("full access permission mode requires explicit confirmation before creating a run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-session-policy-confirm-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_full_access_confirm",
    toolName: "write",
    input: { path: "notes/session.md", content: "mode snapshot" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const rejected = await postRunExpectError(daemon.url, {
      ...runBody(cwd, "task_full_access_missing_confirmation"),
      permissionMode: "full_access",
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "full_access_confirmation_required");

    const runs = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runs.runs.length, 0);
    assert.equal(runner.decisions.length, 0);
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
    assert.ok(waitingRun.threadId);

    const waitingThread = await getJson(`${daemon.url}/threads/${encodeURIComponent(waitingRun.threadId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(waitingThread.thread.kind, "task");
    assert.equal(waitingThread.thread.taskId, "task_bash_ask");
    assert.equal(waitingThread.thread.status, "waiting_for_approval");
    assert.equal(waitingThread.thread.activeRunId, runId);

    const pendingActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(pendingActions.actions.length, 1);
    assert.equal(pendingActions.actions[0].approvalId, approvalId);
    assert.equal(pendingActions.actions[0].threadId, waitingRun.threadId);
    assert.equal(pendingActions.actions[0].workUnitId, waitingRun.workUnitId);
    assert.equal(pendingActions.actions[0].actionType, "bash");
    assert.equal(pendingActions.actions[0].status, "waiting_for_approval");
    assert.equal(pendingActions.actions[0].targetRefs.some((ref) => ref.type === "command" && ref.label === "echo approve-me"), true);
    assert.equal(pendingActions.actions[0].policySnapshot.toolDecisions.bash, "ask");

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
    const finalThread = await getJson(`${daemon.url}/threads/${encodeURIComponent(waitingRun.threadId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalThread.thread.status, "succeeded");
    assert.equal(finalThread.thread.activeRunId, undefined);
    assert.equal(finalThread.thread.lastRunId, runId);

    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const second = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_bash_ask"));
    const secondRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(second.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(secondRun.threadId, waitingRun.threadId);
    const runsForThread = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}&threadId=${encodeURIComponent(waitingRun.threadId)}`);
    assert.deepEqual(runsForThread.runs.map((run) => run.id), [second.runId, runId]);
    const actionsForThread = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&threadId=${encodeURIComponent(waitingRun.threadId)}`);
    assert.equal(actionsForThread.actions.length, 2);
    assert.deepEqual(new Set(actionsForThread.actions.map((action) => action.runId)), new Set([runId, second.runId]));
    assert.equal(actionsForThread.actions.every((action) => action.toolCallId === "tool_bash_ask"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon shutdown preserves a pending approval instead of recording user cancellation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-approval-shutdown-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_shutdown",
    toolName: "bash",
    input: { command: "echo resume-after-restart" },
  });
  const daemon = await startDaemonForTest(runner);
  let stopped = false;
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_bash_shutdown"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;

    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    await daemon.close();
    stopped = true;
    await sse.collectRemaining().catch(() => {});

    const store = createSqliteRunStore(cwd);
    try {
      const run = store.getRun(runId);
      const approval = store.getApprovalRequest(approvalId);
      const checkpoint = store.getApprovalCheckpointForApproval(approvalId);
      const events = store.listEvents(runId, { limit: 1_000 });

      assert.equal(run?.status, "waiting_for_approval");
      assert.equal(approval?.status, "pending");
      assert.equal(approval?.resolvedBy, undefined);
      assert.equal(checkpoint?.status, "pending");
      assert.equal(checkpoint?.revision, 2);
      assert.equal(checkpoint?.resumeBasis?.approvalId, approvalId);
      assert.equal(checkpoint?.resumeBasis?.runId, runId);
      assert.equal(checkpoint?.resumeBasis?.toolCallId, "tool_bash_shutdown");
      assert.equal(checkpoint?.resumeBasis?.sideEffectFingerprint.length, 64);
      assert.equal(checkpoint?.resumeBasis?.fingerprint.length, 64);
      const workUnit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
      const attempt = workUnit?.activeAttemptId ? store.getWorkUnitAttempt(workUnit.activeAttemptId) : undefined;
      assert.equal(workUnit?.status, "waiting_for_approval");
      assert.ok(attempt);
      assert.equal(attempt?.status, "lost");
      assert.equal(attempt?.errorCode, "runtime_suspend");
      assert.equal(store.listResourceLeases({ ownerType: "run", ownerId: runId, status: "active" }).length, 0);
      assert.equal(store.listRuntimeSemaphoreSlots({ ownerId: attempt.id, status: "active" }).length, 0);
      assert.deepEqual(
        store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 1_000 })
          .filter((event) => event.entityId === runId || event.entityId === workUnit?.id || event.entityId === approvalId)
          .filter((event) => event.action.includes("approval_resume_suspended"))
          .map((event) => event.domain),
        ["runs", "work_units"],
      );
      assert.equal(
        store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 1_000 })
          .some((event) => event.domain === "approvals"
            && event.entityId === approvalId
            && event.action === "approval.resume_suspended"),
        true,
      );
      assert.equal(events.some((event) => event.type === "run_cancelled"), false);
      assert.equal(events.some((event) => event.type === "approval_cancelled"), false);
    } finally {
      store.close();
    }
  } finally {
    if (!stopped) {
      await daemon.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a real orchestrator hard timeout fails the Run instead of recording cancellation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-hard-timeout-"));
  const runner = new AbortAwareBlockingRunner();
  const stores = new Map();
  const storeFactory = (workspaceCwd) => {
    const store = createSqliteRunStore(workspaceCwd);
    const createWorkUnit = store.createWorkUnit.bind(store);
    store.createWorkUnit = (input) => createWorkUnit({
      ...input,
      timeoutPolicy: {
        heartbeatIntervalMs: 10,
        heartbeatTimeoutMs: 50,
        idleTimeoutMs: 5_000,
        hardTimeoutMs: 40,
        cancelGraceMs: 20,
      },
    });
    stores.set(workspaceCwd, store);
    return store;
  };
  const daemon = await startDaemonForTest(runner, { storeFactory }, { defaultWorkspaceCwd: cwd });
  try {
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_hard_timeout"));
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.status, "failed");
    assert.equal(run.errorMessage, "hard_timeout");

    const store = stores.get(cwd);
    const workUnit = store.getWorkUnit(run.workUnitId);
    const attempt = store.getWorkUnitAttempt(workUnit.activeAttemptId);
    assert.equal(workUnit.status, "failed");
    assert.equal(workUnit.errorCode, "hard_timeout");
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.errorCode, "hard_timeout");
    assert.equal(store.listEvents(runId, { limit: 1_000 }).some((event) => event.type === "run_cancelled"), false);
    assert.equal(store.listEvents(runId, { limit: 1_000 }).some((event) => event.type === "approval_cancelled"), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approved checkpoint resumes the same Run with one fenced replacement attempt after daemon restart", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-approval-restart-resume-"));
  const command = "printf 'resumed-ok\\n' > resumed-after-restart.txt";
  const firstRunner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_restart_resume",
    toolName: "bash",
    input: { command },
  });
  let daemon = await startDaemonForTest(firstRunner);
  let daemonOpen = true;
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_bash_restart_resume"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    await daemon.close();
    daemonOpen = false;
    await sse.collectRemaining().catch(() => {});

    const secondRunner = new ApprovalProbeRunner({
      toolCallId: "tool_unused_after_restart",
      toolName: "bash",
      input: { command: "echo must-not-run" },
    });
    daemon = await startDaemonForTest(secondRunner, {}, { defaultWorkspaceCwd: cwd });
    daemonOpen = true;
    const approved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "resume exact approved command",
    });
    assert.equal(approved.approval.status, "approved");

    await waitForCondition(async () => {
      const current = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
      return current.status === "succeeded";
    }, "Timed out waiting for resumed Run to succeed.");

    assert.equal(await readFile(resolve(cwd, "resumed-after-restart.txt"), "utf8"), "resumed-ok\n");
    assert.equal(secondRunner.runs.length, 0);
    const actions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    const resumedAction = actions.actions.find((action) => action.toolCallId === "tool_bash_restart_resume");
    assert.equal(resumedAction?.status, "succeeded");
    assert.equal(resumedAction?.commandEvidence?.exitCode, 0);

    const store = createSqliteRunStore(cwd);
    try {
      const run = store.getRun(runId);
      assert.equal(run?.status, "succeeded");
      const workUnit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
      const attempts = workUnit ? store.listWorkUnitAttempts(workUnit.id) : [];
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0]?.status, "lost");
      assert.equal(attempts[1]?.status, "succeeded");
      assert.equal(workUnit?.activeAttemptId, attempts[1]?.id);
      const checkpoint = store.getApprovalCheckpointForApproval(approvalId);
      assert.equal(checkpoint?.status, "resumed");
      assert.equal(checkpoint?.runnerResumeHandle?.attemptId, attempts[1]?.id);
      assert.equal(checkpoint?.resumeBasis?.priorAttemptId, attempts[0]?.id);
      assert.equal(store.listEvents(runId, { limit: 1_000 }).filter((event) => event.type === "run_cancelled").length, 0);
      const stale = auditIgnoredRunnerCompletion({
        store,
        run,
        workUnit,
        attempt: attempts[0],
        reportedStatus: "succeeded",
        now: "2026-08-15T02:30:00.000Z",
      });
      assert.equal(stale?.type, "stale_runner_completion_ignored");
      assert.equal(stale?.data.reason, "attempt_not_current");
      assert.equal(store.getRun(runId)?.status, "succeeded");
      assert.equal(store.listWorkUnitAttempts(workUnit.id).filter((entry) => entry.status === "succeeded").length, 1);
    } finally {
      store.close();
    }
  } finally {
    if (daemonOpen) await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restart resume fails closed when the exact approved side effect has no safe continuation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-approval-resume-unsupported-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_resume_unsupported",
    toolName: "write",
    input: { path: "unsupported-after-restart.txt", content: "must not be written" },
  });
  let daemon = await startDaemonForTest(runner);
  let daemonOpen = true;
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { write: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_write_resume_unsupported"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;
    await daemon.close();
    daemonOpen = false;
    await sse.collectRemaining().catch(() => {});

    daemon = await startDaemonForTest(new ApprovalProbeRunner({
      toolCallId: "tool_unused_resume_unsupported",
      toolName: "bash",
      input: { command: "echo unused" },
    }), {}, { defaultWorkspaceCwd: cwd });
    daemonOpen = true;
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "approve exact write",
    });
    try {
      await waitForCondition(async () => {
        const current = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
        return current.status === "failed";
      }, "Timed out waiting for unsupported resume to fail closed.");
    } catch (error) {
      const diagnosticStore = createSqliteRunStore(cwd);
      try {
        const diagnosticRun = diagnosticStore.getRun(runId);
        const diagnosticCheckpoint = diagnosticStore.getApprovalCheckpointForApproval(approvalId);
        const diagnosticWorkUnit = diagnosticRun?.workUnitId ? diagnosticStore.getWorkUnit(diagnosticRun.workUnitId) : undefined;
        const diagnosticAttempt = diagnosticWorkUnit?.activeAttemptId
          ? diagnosticStore.getWorkUnitAttempt(diagnosticWorkUnit.activeAttemptId)
          : undefined;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} `
          + `run=${diagnosticRun?.status ?? "missing"} `
          + `workUnit=${diagnosticWorkUnit?.status ?? "missing"} `
          + `attempt=${diagnosticAttempt?.status ?? "missing"} `
          + `checkpoint=${diagnosticCheckpoint?.status ?? "missing"}`,
        );
      } finally {
        diagnosticStore.close();
      }
    }

    const store = createSqliteRunStore(cwd);
    try {
      const run = store.getRun(runId);
      const checkpoint = store.getApprovalCheckpointForApproval(approvalId);
      assert.equal(run?.status, "failed");
      assert.match(run?.errorMessage ?? "", /^approval_resume_unsupported:file_write/u);
      assert.equal(checkpoint?.status, "resume_failed");
      assert.match(checkpoint?.resumeFailureReason ?? "", /^approval_resume_unsupported:file_write/u);
      await assert.rejects(() => readFile(resolve(cwd, "unsupported-after-restart.txt"), "utf8"), /ENOENT/u);
    } finally {
      store.close();
    }
  } finally {
    if (daemonOpen) await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval execution actions expose preview and result artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-action-artifacts-"));
  const runner = new ApprovalArtifactRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, {
      ...runBody(cwd, "task_action_artifacts"),
      tools: ["bash"],
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;
    assert.equal(requested.data.data.previewArtifactIds.length, 1);

    const waitingActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(waitingActions.actions.length, 1);
    assert.deepEqual(waitingActions.actions[0].previewArtifactIds, requested.data.data.previewArtifactIds);
    assert.deepEqual(waitingActions.actions[0].resultArtifactIds, []);
    assert.equal(waitingActions.actions[0].status, "waiting_for_approval");
    assert.equal(waitingActions.actions[0].executedAt, undefined);

    const previewContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(waitingActions.actions[0].previewArtifactIds[0])}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(previewContent.status, 200);
    const previewText = await previewContent.text();
    assert.match(previewText, /\[REDACTED\]/);
    assert.doesNotMatch(previewText, /sk-test_action_preview_secret/);

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "artifact approval",
    });
    await sse.collectRemaining();

    const completedActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(completedActions.actions.length, 1);
    assert.equal(completedActions.actions[0].status, "succeeded");
    assert.equal(completedActions.actions[0].approvalId, approvalId);
    assert.equal(completedActions.actions[0].toolCallId, "tool_action_artifacts");
    assert.ok(completedActions.actions[0].executedAt);
    assert.ok(completedActions.actions[0].completedAt);
    assert.equal(completedActions.actions[0].resultArtifactIds.length, 1);
    const resultContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(completedActions.actions[0].resultArtifactIds[0])}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(resultContent.status, 200);
    assert.match(await resultContent.text(), /approved stdout artifact/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("non-approval tool events are exposed as action lifecycle records", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-non-approval-actions-"));
  const runner = new NonApprovalToolLifecycleRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, {
      ...runBody(cwd, "task_non_approval_actions"),
      tools: ["read", "grep"],
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    await runner.waitUntilToolStarted();

    const executingActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(executingActions.actions.length, 1);
    assert.equal(executingActions.actions[0].toolCallId, "tool_read_lifecycle");
    assert.equal(executingActions.actions[0].actionType, "read");
    assert.equal(executingActions.actions[0].status, "executing");
    assert.deepEqual(executingActions.actions[0].scopes, ["read_only"]);

    runner.finish("release lifecycle");
    await sse.collectRemaining();

    const completedActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    const byToolCall = new Map(completedActions.actions.map((action) => [action.toolCallId, action]));
    assert.equal(byToolCall.get("tool_read_lifecycle")?.status, "succeeded");
    assert.equal(byToolCall.get("tool_grep_lifecycle")?.status, "failed");
    assert.equal(byToolCall.get("tool_grep_lifecycle")?.actionType, "grep");
  } finally {
    runner.finish("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("git commit approval actions include scope analysis and git preview artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-git-action-preview-"));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ling-test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Ling Test"], { cwd });
  await writeFile(resolve(cwd, "README.md"), "baseline\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd, stdio: "ignore" });
  await writeFile(resolve(cwd, "README.md"), "git preview\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd });

  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_git_commit_preview",
    toolName: "bash",
    input: { command: "git commit -m \"Ling preview\"" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, {
      ...runBody(cwd, "task_git_commit_preview"),
      tools: ["bash"],
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    const actions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(actions.actions.length, 1);
    assert.equal(actions.actions[0].approvalId, approvalId);
    assert.equal(actions.actions[0].actionType, "git_commit");
    assert.equal(actions.actions[0].risk, "medium");
    assert.ok(actions.actions[0].scopes.includes("git_history"));
    assert.match(actions.actions[0].scopeSummary, /git_history/);
    assert.equal(actions.actions[0].previewArtifactIds.length, 1);

    const previewContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(actions.actions[0].previewArtifactIds[0])}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(previewContent.status, 200);
    const preview = JSON.parse(await previewContent.text());
    assert.equal(preview.actionType, "git_commit");
    assert.equal(preview.gitPreview.kind, "git_commit");
    assert.equal(preview.gitPreview.previewStatus, "ready");
    assert.deepEqual(preview.gitPreview.stagedPaths, ["README.md"]);
    assert.equal(preview.gitPreview.commitMessage, "Ling preview");

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "git preview approved",
    });
    await sse.collectRemaining();
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread evidence and manual resume preserve Ling-owned lineage", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-thread-resume-"));
  const runner = new ThreadResumeRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const first = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_thread_resume"));
    assert.ok(first.runId);

    const threads = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&taskId=task_thread_resume`);
    assert.equal(threads.threads.length, 1);
    const thread = threads.threads[0];
    assert.equal(thread.lastRunId, first.runId);
    assert.equal(thread.status, "succeeded");

    const evidence = await getJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(evidence.thread.id, thread.id);
    assert.equal(evidence.runs.length, 1);
    assert.equal(evidence.runs[0].run.id, first.runId);
    assert.equal(evidence.runs[0].events.some((event) => event.type === "run_created"), true);
    assert.equal(evidence.runs[0].runtimeEvents.some((event) => event.type === "work_unit_started"), true);

    const preview = await postJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/resume-preview?cwd=${encodeURIComponent(cwd)}`, {
      sourceRunId: first.runId,
      instruction: "Continue after manual resume.",
      includeArtifacts: true,
    });
    assert.equal(preview.sourceRun.id, first.runId);
    assert.equal(preview.context.sourceRunId, first.runId);
    assert.deepEqual(preview.context.priorRunIds, [first.runId]);
    assert.equal(preview.context.includedEventCount > 0, true);
    assert.match(preview.context.contextText, /Continue after manual resume/);

    const resumed = await postJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/resume?cwd=${encodeURIComponent(cwd)}`, {
      instruction: "Continue after manual resume.",
      idempotencyKey: "thread-resume-test",
    });
    assert.equal(resumed.continuationReason, "manual_resume");
    assert.equal(resumed.sourceRun.id, first.runId);
    assert.ok(resumed.runId);
    assert.notEqual(resumed.runId, first.runId);

    await waitForCondition(async () => {
      const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(resumed.runId)}?cwd=${encodeURIComponent(cwd)}`);
      return run.status === "succeeded";
    }, "manual resume run should finish");

    const continuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(resumed.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(continuation.threadId, thread.id);
    assert.equal(continuation.parentRunId, first.runId);
    assert.equal(continuation.continuationReason, "manual_resume");
    assert.match(continuation.taskSnapshot.prompt, /not a native runner session resume/);

    const updatedThread = await getJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(updatedThread.thread.lastRunId, resumed.runId);
    assert.equal(updatedThread.thread.status, "succeeded");

    const resumedEvidence = await getJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(resumedEvidence.runs.map((entry) => entry.run.id), [first.runId, resumed.runId]);
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

test("plan mode denies file writes without offering a pending approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-plan-mode-write-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_plan_write",
    toolName: "write",
    input: { path: "docs/plan-mode.txt", content: "blocked" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const { thread } = await createPlanModeThread(daemon.url, cwd);
    await patchPolicy(daemon.url, cwd, { toolDecisions: { write: "allow" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_plan_mode_write"),
      threadId: thread.id,
    });
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    const approvals = await listApprovals(daemon.url, cwd, runId);
    const pending = await listApprovals(daemon.url, cwd, { runId, status: "pending" });

    assert.equal(run.requestSnapshot.effectivePolicySnapshot.conversationMode, "plan");
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.planModeMutationPolicy, "deny_repo_tracked_mutation");
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /Plan Mode denied file mutation/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].actionType, "write");
    assert.deepEqual(pending, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("plan mode denies mutating shell commands without offering a pending approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-plan-mode-bash-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_plan_bash",
    toolName: "bash",
    input: { command: "git commit -m plan-mode-should-not-commit" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const { thread } = await createPlanModeThread(daemon.url, cwd);
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_plan_mode_bash"),
      threadId: thread.id,
    });
    const approvals = await listApprovals(daemon.url, cwd, runId);
    const pending = await listApprovals(daemon.url, cwd, { runId, status: "pending" });

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /Plan Mode denied a mutating shell command/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].actionType, "git_commit");
    assert.deepEqual(pending, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("patch-shaped write creates approval preview and applies only after approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-patch-approval-"));
  await writeFile(resolve(cwd, "src.txt"), "old\nkeep\n", "utf8");
  const patchText = `*** Begin Patch
*** Update File: src.txt
@@
-old
+new
 keep
*** End Patch`;
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_patch_approve",
    toolName: "write",
    input: { patchText },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, runBody(cwd, "task_patch_approve"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    assert.equal(await readFile(resolve(cwd, "src.txt"), "utf8"), "old\nkeep\n");
    assert.equal(requested.data.data.payload.patchFormat, "ling-apply-patch-v1");
    assert.deepEqual(requested.data.data.payload.touchedPaths, ["src.txt"]);
    assert.equal(requested.data.data.payload.summary.updateCount, 1);
    assert.equal(requested.data.data.previewArtifactIds.length, 2);

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "patch approved",
    });
    await sse.collectRemaining();

    assert.equal(await readFile(resolve(cwd, "src.txt"), "utf8"), "new\nkeep\n");
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, true);
    assert.equal(runner.decisions[0].handledResult.details.status, "applied");

    const actions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(actions.actions.length, 1);
    assert.equal(actions.actions[0].previewArtifactIds.length, 2);
    assert.equal(actions.actions[0].resultArtifactIds.length, 1);
    const previewContents = await Promise.all(actions.actions[0].previewArtifactIds.map(async (artifactId) => {
      const response = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(artifactId)}/content?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(response.status, 200);
      return response.text();
    }));
    const previewJson = JSON.parse(previewContents.find((content) => content.includes("\"patchFormat\"")) ?? "{}");
    assert.equal(previewJson.patchFormat, "ling-apply-patch-v1");
    assert.equal(previewJson.plan.format, "ling-apply-patch-v1");
    assert.deepEqual(previewJson.pathPolicy.allowedPaths, ["src.txt"]);
    const resultContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(actions.actions[0].resultArtifactIds[0])}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(resultContent.status, 200);
    const result = JSON.parse(await resultContent.text());
    assert.equal(result.status, "applied");
    assert.deepEqual(result.touchedPaths, ["src.txt"]);
    assert.deepEqual([...result.previewArtifactIds].sort(), [...actions.actions[0].previewArtifactIds].sort());
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("patch approval redacts resolved provider secrets from approvals and artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-patch-secret-redaction-"));
  await writeFile(resolve(cwd, "src.txt"), "old\n", "utf8");
  const secretValue = "resolved-patch-provider-secret";
  const patchText = `*** Begin Patch
*** Update File: src.txt
@@
-old
+${secretValue}
*** End Patch`;
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_patch_secret_redaction",
    toolName: "write",
    input: { patchText },
  });
  const daemon = await startDaemonForTest(runner, {
    secretResolver: createTestSecretResolver("keychain:patch_provider", secretValue),
  });
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      displayName: "Patch Secret Provider",
      providerId: "patch-secret-provider",
      authHeader: true,
      apiKeyRef: "keychain:patch_provider",
    });
    const response = await postRunStream(
      daemon.url,
      providerRunBody(cwd, "task_patch_secret_redaction", created.provider.id, {
        skipProviderPreflight: true,
        tools: ["write"],
      }),
    );
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    const requestedText = JSON.stringify(requested.data);
    assert.doesNotMatch(requestedText, new RegExp(secretValue));
    assert.match(requestedText, /\[REDACTED\]/);

    const approvals = await listApprovals(daemon.url, cwd, runId);
    assert.equal(approvals.length, 1);
    const storedApprovalText = JSON.stringify(approvals[0]);
    assert.doesNotMatch(storedApprovalText, new RegExp(secretValue));
    assert.match(storedApprovalText, /\[REDACTED\]/);

    const waitingActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(waitingActions.actions.length, 1);
    assert.equal(waitingActions.actions[0].previewArtifactIds.length, 2);
    const previewContents = await Promise.all(waitingActions.actions[0].previewArtifactIds.map(async (artifactId) => {
      const artifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(artifactId)}/content?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(artifact.status, 200);
      return artifact.text();
    }));
    for (const content of previewContents) {
      assert.doesNotMatch(content, new RegExp(secretValue));
    }
    assert.equal(previewContents.some((content) => /\[REDACTED\]/.test(content)), true);

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "patch secret redaction approved",
    });
    await sse.collectRemaining();

    assert.equal(await readFile(resolve(cwd, "src.txt"), "utf8"), `${secretValue}\n`);
    const completedActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(completedActions.actions[0].resultArtifactIds.length, 1);
    const resultArtifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(completedActions.actions[0].resultArtifactIds[0])}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(resultArtifact.status, 200);
    assert.doesNotMatch(await resultArtifact.text(), new RegExp(secretValue));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("patch-shaped edit creates approval preview and applies through the daemon", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-patch-edit-"));
  await writeFile(resolve(cwd, "src.txt"), "old\n", "utf8");
  const patchText = `*** Begin Patch
*** Update File: src.txt
@@
-old
+edited
*** End Patch`;
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_patch_edit",
    toolName: "edit",
    input: { patchText },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, runBody(cwd, "task_patch_edit"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    assert.equal(await readFile(resolve(cwd, "src.txt"), "utf8"), "old\n");
    assert.equal(requested.data.data.payload.type, "file_edit");
    assert.equal(requested.data.data.payload.patchFormat, "ling-apply-patch-v1");

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "patch edit approved",
    });
    await sse.collectRemaining();

    assert.equal(await readFile(resolve(cwd, "src.txt"), "utf8"), "edited\n");
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].handledResult.details.status, "applied");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("denied patch approval leaves files unchanged", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-patch-deny-"));
  await writeFile(resolve(cwd, "src.txt"), "old\n", "utf8");
  const patchText = `*** Begin Patch
*** Update File: src.txt
@@
-old
+new
*** End Patch`;
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_patch_deny",
    toolName: "write",
    input: { patchText },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, runBody(cwd, "task_patch_deny"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/deny?cwd=${encodeURIComponent(cwd)}`, {
      reason: "patch denied",
    });
    await sse.collectRemaining();

    assert.equal(await readFile(resolve(cwd, "src.txt"), "utf8"), "old\n");
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approved patch fails closed when target changes after preview", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-patch-conflict-"));
  await writeFile(resolve(cwd, "src.txt"), "old\nkeep\n", "utf8");
  const patchText = `*** Begin Patch
*** Update File: src.txt
@@
-old
+new
 keep
*** End Patch`;
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_patch_conflict",
    toolName: "write",
    input: { patchText },
  }, true);
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, runBody(cwd, "task_patch_conflict"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    await writeFile(resolve(cwd, "src.txt"), "changed\nkeep\n", "utf8");
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "patch approved after conflict",
    });
    await sse.collectRemaining();

    assert.equal(await readFile(resolve(cwd, "src.txt"), "utf8"), "changed\nkeep\n");
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].handledResult.isError, true);
    assert.equal(runner.decisions[0].handledResult.details.status, "conflict");

    const actions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(actions.actions.length, 1);
    assert.equal(actions.actions[0].approvalId, approvalId);
    assert.equal(actions.actions[0].toolCallId, "tool_patch_conflict");
    assert.equal(actions.actions[0].status, "failed");
    assert.equal(actions.actions[0].resultArtifactIds.length, 1);
    const resultContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(actions.actions[0].resultArtifactIds[0])}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(resultContent.status, 200);
    const result = JSON.parse(await resultContent.text());
    assert.equal(result.status, "conflict");
    assert.match(result.error, /changed after preview/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("patch touched paths outside allowed write paths are denied without mutation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-patch-policy-"));
  const patchText = `*** Begin Patch
*** Add File: src/out.txt
+outside
*** End Patch`;
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_patch_outside",
    toolName: "write",
    input: { patchText },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, {
      toolDecisions: { write: "allow" },
      allowedWritePaths: ["docs"],
    });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_patch_outside"));
    const approvals = await listApprovals(daemon.url, cwd, runId);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /outside allowed write paths/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.deepEqual(approvals[0].payload.touchedPaths, ["src/out.txt"]);
    await assert.rejects(() => readFile(resolve(cwd, "src/out.txt"), "utf8"), /ENOENT/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("patches cannot modify .ling-stack internal state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-patch-internal-"));
  const patchText = `*** Begin Patch
*** Add File: .ling-stack/owned.txt
+blocked
*** End Patch`;
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_patch_internal",
    toolName: "write",
    input: { patchText },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_patch_internal"));
    const approvals = await listApprovals(daemon.url, cwd, runId);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /may not modify \.ling-stack internal state/);
    assert.deepEqual(approvals, []);
    await assert.rejects(() => readFile(resolve(cwd, ".ling-stack/owned.txt"), "utf8"), /ENOENT/);
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
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "jimeng",
      displayName: "Jimeng Image",
      providerId: "jimeng",
      model: "jimeng-image",
      api: "media-job",
      baseUrl: "https://visual.volcengineapi.com",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      capabilities: ["image_generate"],
      input: ["text", "image"],
      authHeader: false,
      enabled: true,
    });
    const providerId = created.provider.id;

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, false);
    assert.equal(checkResult.code, "unsupported_live_probe");
    assert.match(checkResult.message, /not connected a real generation adapter/);

    const fetched = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(fetched.provider.lastCheck.ok, false);
    assert.equal(fetched.provider.lastCheck.code, "unsupported_live_probe");
    assert.equal(fetched.provider.lastCheck.checkedAt, checkResult.checkedAt);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
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
      skipInitialCheck: true,
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

  test("provider draft check allows provider-exposed model ids with chat protocols", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-draft-media-mismatch-"));
    const openai = await startMockOpenAICompatibleServer();
    const daemon = await startDaemonForTest(new ApprovalProbeRunner({
      toolCallId: "tool_unused_media_mismatch",
      toolName: "bash",
      input: { command: "echo unused" },
    }));
    try {
      const mediaNamedModel = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
        kind: "doubao",
        displayName: "Doubao Ark",
        providerId: "doubao",
        model: "doubao-seedream-5-0-260128",
        api: "openai-completions",
        baseUrl: `${openai.url}/v1`,
        authHeader: false,
        capabilities: ["chat", "tool_call"],
        enabled: true,
      });

      assert.equal(mediaNamedModel.ok, true);
      assert.equal(openai.requests.length, 1);

      const chatModel = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
        kind: "doubao",
        displayName: "Doubao Ark",
        providerId: "doubao",
        model: "doubao-1-5-pro-32k-250115",
        api: "openai-completions",
        baseUrl: `${openai.url}/v1`,
        authHeader: false,
        capabilities: ["chat", "tool_call"],
        enabled: true,
      });

      assert.equal(chatModel.ok, true);
      assert.equal(openai.requests.length, 2);
    } finally {
      await daemon.close();
      await openai.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

test("provider model listing probes the endpoint with the provided API key", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-models-"));
  const openai = await startMockOpenAICompatibleServer({
    models: [
      { id: "cliproxy-gpt-4o", object: "model", owned_by: "cliproxy" },
      {
        id: "gpt-5.5-codex",
        object: "model",
        owned_by: "openai",
        context_length: 256000,
        max_completion_tokens: 64000,
        supported_parameters: ["reasoning_effort", "tools"],
        thinking: {
          levels: ["low", "medium", "high", "max"],
          min: 1024,
          max: 64000,
          zero_allowed: true,
          dynamic_allowed: false,
        },
        input_modalities: ["text", "image"],
      },
      { id: "gpt-image-2", object: "model", owned_by: "openai" },
      { id: "black-forest-labs/flux-2-pro", object: "model", owned_by: "black-forest-labs" },
      { id: "plain-image-output", object: "model", output_modalities: ["image"] },
    ],
  });
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
    assert.deepEqual(result.models.map((model) => model.id), [
      "cliproxy-gpt-4o",
      "gpt-5.5-codex",
      "gpt-image-2",
      "black-forest-labs/flux-2-pro",
      "plain-image-output",
    ], JSON.stringify({ result, requests: openai.requests }));
    const codexModel = result.models.find((model) => model.id === "gpt-5.5-codex");
    assert.deepEqual(codexModel.thinkingModes, ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(codexModel.thinkingSupport.levels, ["low", "medium", "high", "xhigh"]);
    assert.equal(codexModel.thinkingSupport.maxTokens, 64000);
    assert.equal(codexModel.contextWindow, 256000);
    assert.equal(codexModel.maxTokens, 64000);
    assert.deepEqual(codexModel.supportedParameters, ["reasoning_effort", "tools", "response_format"]);
    assert.deepEqual(codexModel.input, ["text", "image"]);
    const imageModel = result.models.find((model) => model.id === "gpt-image-2");
    assert.equal(imageModel.api, "media-job");
    assert.deepEqual(imageModel.input, ["text", "image"]);
    assert.deepEqual(imageModel.capabilities, ["image_generate"]);
    assert.deepEqual(imageModel.thinkingModes, []);
    assert.equal(imageModel.capabilitySource, "model_catalog");
    const fluxModel = result.models.find((model) => model.id === "black-forest-labs/flux-2-pro");
    assert.equal(fluxModel.api, "media-job");
    assert.deepEqual(fluxModel.capabilities, ["image_generate"]);
    assert.equal(fluxModel.capabilitySource, "model_catalog");
    const upstreamImageModel = result.models.find((model) => model.id === "plain-image-output");
    assert.equal(upstreamImageModel.api, "media-job");
    assert.deepEqual(upstreamImageModel.capabilities, ["image_generate"]);
    assert.equal(upstreamImageModel.capabilitySource, "upstream");
    assert.equal(result.source, `${openai.url}/v1/models`);
    assert.doesNotMatch(JSON.stringify(result), /model-list-secret/);
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider model listing normalizes OpenAI-compatible endpoint paths", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-models-normalize-"));
  const openai = await startMockOpenAICompatibleServer();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_model_list_normalize",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const result = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "doubao",
      providerId: "doubao",
      api: "openai-completions",
      baseUrl: `${openai.url}/api/v3/chat/completions`,
      authHeader: true,
      apiKey: "ark-secret",
    });

    assert.equal(openai.requests[0].method, "GET");
    assert.equal(openai.requests[0].path, "/api/v3/models");
    assert.equal(openai.requests[0].authorization, "Bearer ark-secret");
    assert.equal(result.source, `${openai.url}/api/v3/models`);
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider model import creates and updates supplier model presets", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-model-import-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_model_import",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const imported = await postJson(`${daemon.url}/providers/import-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "中转站",
      providerId: "relay",
      api: "openai-completions",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "import-secret",
      authHeader: true,
      reasoning: true,
      capabilities: ["chat", "tool_call", "reasoning"],
      input: ["text", "image"],
      models: [
        {
          id: "relay-gpt",
          displayName: "Relay GPT",
          thinkingModes: ["off", "low", "medium", "high", "xhigh"],
          contextWindow: 64000,
          maxTokens: 8192,
          supportedParameters: ["reasoning_effort"],
          thinkingSupport: {
            levels: ["off", "low", "medium", "high", "xhigh"],
            maxTokens: 8192,
          },
          capabilitySource: "model_catalog",
          capabilityConfidence: "known",
        },
        { id: "relay-image", capabilities: ["image_generate"], input: ["text", "image"], api: "media-job" },
        { id: "gpt-image-2", capabilities: ["image_generate"], input: ["text", "image"], api: "media-job" },
        { id: "black-forest-labs/flux-2-pro" },
      ],
    });

    assert.equal(imported.createdCount, 4);
    assert.equal(imported.updatedCount, 0);
    assert.equal(imported.providers.length, 4);
    assert.ok(imported.providers.every((provider) => provider.apiKeyConfigured));
    const relayGpt = imported.providers.find((provider) => provider.model === "relay-gpt");
    assert.equal(relayGpt.reasoning, true);
    assert.deepEqual(relayGpt.thinkingModes, ["off", "low", "medium", "high", "xhigh"]);
    assert.equal(relayGpt.contextWindow, 64000);
    assert.equal(relayGpt.maxTokens, 8192);
    assert.deepEqual(relayGpt.compat.modelMetadata.supportedParameters, ["reasoning_effort"]);
    assert.equal(relayGpt.compat.modelMetadata.thinkingSupport.maxTokens, 8192);
    const gptImage = imported.providers.find((provider) => provider.model === "gpt-image-2");
    assert.equal(gptImage.api, "media-job");
    assert.equal(gptImage.reasoning, false);
    assert.deepEqual(gptImage.thinkingModes, []);
    assert.deepEqual(gptImage.capabilities, ["image_generate"]);
    assert.deepEqual(gptImage.compat.mediaVendorTransport, { mode: "live" });
    const fluxImage = imported.providers.find((provider) => provider.model === "black-forest-labs/flux-2-pro");
    assert.equal(fluxImage.api, "media-job");
    assert.deepEqual(fluxImage.capabilities, ["image_generate"]);
    assert.equal(fluxImage.compat.mediaVendorTransport, undefined);
    assert.equal(fluxImage.compat.modelMetadata.capabilitySource, "model_catalog");
    assert.doesNotMatch(JSON.stringify(imported), /import-secret/);

    const updated = await postJson(`${daemon.url}/providers/import-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "中转站",
      providerId: "relay",
      api: "openai-completions",
      baseUrl: "https://relay.example.com/v1",
      authHeader: true,
      reasoning: true,
      capabilities: ["chat", "tool_call", "reasoning"],
      input: ["text"],
      models: [
        { id: "relay-gpt", displayName: "Relay GPT Updated" },
      ],
    });

    assert.equal(updated.createdCount, 0);
    assert.equal(updated.updatedCount, 1);
    assert.equal(updated.providers[0].displayName, "中转站 · Relay GPT Updated");

    const listed = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.providers.length, 4);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider manual create and update auto-enable live transport for OpenAI Images", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-manual-openai-image-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_manual_openai_image",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Relay Image",
      providerId: "relay",
      model: "gpt-image-2",
      api: "media-job",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "manual-secret",
      authHeader: true,
      capabilities: ["image_generate"],
      input: ["text", "image"],
      compat: {},
      enabled: true,
    });

    assert.deepEqual(created.provider.compat.mediaVendorTransport, { mode: "live" });
    assert.doesNotMatch(JSON.stringify(created), /manual-secret/);

    const patched = await patchJson(`${daemon.url}/providers/${encodeURIComponent(created.provider.id)}?cwd=${encodeURIComponent(cwd)}`, {
      model: "dall-e-3",
      api: "media-job",
      capabilities: ["image_generate"],
      input: ["text", "image"],
      compat: {},
    });

    assert.equal(patched.provider.model, "dall-e-3");
    assert.deepEqual(patched.provider.compat.mediaVendorTransport, { mode: "live" });
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("legacy OpenAI Images media providers are normalized for listing, checks, and runs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-legacy-openai-image-"));
  const openai = await startMockOpenAICompatibleServer();
  process.env.LING_STACK_TEST_OPENAI_IMAGE_KEY = "test-openai-image-key";
  const now = "2026-06-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const legacyProvider = store.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Legacy Image Relay",
    providerId: "relay",
    model: "gpt-image-2",
    api: "media-job",
    baseUrl: `${openai.url}/v1`,
    apiKeyRef: "env:LING_STACK_TEST_OPENAI_IMAGE_KEY",
    authHeader: true,
    input: ["text", "image"],
    compat: {},
    capabilities: ["image_generate"],
    enabled: true,
  }, now);
  store.close();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_legacy_openai_image",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const listed = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    const listedProvider = listed.providers.find((provider) => provider.id === legacyProvider.id);
    assert.deepEqual(listedProvider.compat.mediaVendorTransport, { mode: "live" });
    assert.equal(listedProvider.apiKeyConfigured, true);

    const check = await postJson(`${daemon.url}/providers/${encodeURIComponent(legacyProvider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(check.ok, true);
    assert.equal(check.code, "static_check");
    assert.match(check.message, /does not create an image/);
    assert.equal(openai.requests.length, 0);

    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: legacyProvider.id,
      operation: "image_generate",
      prompt: "Create an OpenAI Images artifact from a legacy provider.",
      input: { size: "1024x1024" },
    });
    const firstRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstRun.mediaJob.status, "succeeded");
    assert.equal(firstRun.approval, undefined);
    const pendingApprovals = await listApprovals(daemon.url, cwd, { mediaJobId: createdJob.mediaJob.id, status: "pending" });
    assert.equal(pendingApprovals.length, 0);
    const executed = firstRun;
    assert.equal(executed.mediaJob.status, "succeeded");
    assert.equal(openai.requests.length, 1);
    assert.equal(openai.requests[0].path, "/v1/images/generations");
    assert.equal(openai.requests[0].authorization, "Bearer test-openai-image-key");
    assert.equal(openai.requests[0].body.model, "gpt-image-2");
  } finally {
    delete process.env.LING_STACK_TEST_OPENAI_IMAGE_KEY;
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media provider model listing returns provider-exposed candidates without category filtering", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-media-models-"));
  const openai = await startMockOpenAICompatibleServer({
    models: [
      { id: "doubao-seed-2-0-lite-260215", object: "model", owned_by: "volcengine" },
      { id: "doubao-seedream-5-0-260128", object: "model", owned_by: "volcengine" },
      { id: "doubao-seedance-1-0-pro-250528", object: "model", owned_by: "volcengine" },
    ],
  });
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_model_list",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const seedreamResult = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "seedream",
      providerId: "seedream",
      api: "media-job",
      baseUrl: `${openai.url}/api/v3/models`,
      authHeader: true,
      apiKey: "ark-media-secret",
    });

    assert.equal(openai.requests[0].method, "GET");
    assert.equal(openai.requests[0].path, "/api/v3/models");
    assert.deepEqual(seedreamResult.models.map((model) => model.id), [
      "doubao-seed-2-0-lite-260215",
      "doubao-seedream-5-0-260128",
      "doubao-seedance-1-0-pro-250528",
    ]);
    const seedreamModel = seedreamResult.models.find((model) => model.id === "doubao-seedream-5-0-260128");
    assert.equal(seedreamModel.api, "media-job");
    assert.deepEqual(seedreamModel.capabilities, ["image_generate", "image_edit"]);

    const seedanceResult = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "seedance",
      providerId: "seedance",
      api: "media-job",
      baseUrl: `${openai.url}/api/v3/models`,
      authHeader: true,
      apiKey: "ark-media-secret",
    });
    assert.deepEqual(seedanceResult.models.map((model) => model.id), [
      "doubao-seed-2-0-lite-260215",
      "doubao-seedream-5-0-260128",
      "doubao-seedance-1-0-pro-250528",
    ]);

    const jimengResult = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "jimeng",
      providerId: "jimeng",
      api: "media-job",
      baseUrl: "https://visual.volcengineapi.com",
      authHeader: false,
    });
    assert.deepEqual(jimengResult.models.map((model) => model.id), ["jimeng-image"]);
    assert.equal(jimengResult.source, "builtin:generation-models");
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media provider check runs a real Seedream image probe", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-media-check-"));
  const seedream = await startMockSeedreamServer();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_check",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const draftCheck = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
      kind: "seedream",
      displayName: "Seedream Draft",
      providerId: "seedream",
      model: "seedream",
      api: "media-job",
      capabilities: ["image_generate"],
      input: ["text", "image"],
      baseUrl: `${seedream.url}/api/v3/images/generations`,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
    });
    assert.equal(draftCheck.ok, true);
    assert.equal(draftCheck.code, "live_image_probe_ready");
    assert.equal(seedream.requests.length, 2);

    const live = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Check",
      capabilities: ["image_generate"],
      baseUrl: `${seedream.url}/api/v3/images/generations`,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const liveCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(live.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(liveCheck.ok, true);
    assert.equal(liveCheck.code, "live_image_probe_ready");
    assert.equal(liveCheck.message, "生成真实图片成功");
    assert.equal(seedream.requests.length, 4);
    assert.equal(seedream.requests[2].method, "POST");
    assert.equal(seedream.requests[2].path, "/api/v3/images/generations");
    assert.equal(seedream.requests[2].authorization, "Bearer test-key");
    assert.equal(seedream.requests[2].body.model, "seedream");
    assert.equal(seedream.requests[2].body.response_format, "url");
    assert.equal(seedream.requests[3].method, "GET");
    assert.equal(seedream.requests[3].path, "/generated/image-1.png");

    const missingSecret = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Missing Secret",
      capabilities: ["image_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY_MISSING",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const missingSecretCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(missingSecret.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(missingSecretCheck.ok, false);
    assert.equal(missingSecretCheck.code, "secret_missing");
    assert.match(missingSecretCheck.message, /env:LING_STACK_TEST_MEDIA_KEY_MISSING/);

    const seedance = await createMediaProvider(daemon.url, cwd, {
      kind: "seedance",
      displayName: "Seedance Live Check",
      providerId: "seedance",
      model: "seedance",
      capabilities: ["video_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const seedanceCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(seedance.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(seedanceCheck.ok, true);
    assert.equal(seedanceCheck.code, "static_check");
    assert.match(seedanceCheck.message, /does not create a video/);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedream.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("startup provider refresh does not run live media probes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-startup-media-skip-"));
  const seedream = await startMockSeedreamServer();
  let daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_startup_media_skip",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const live = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Startup Skip",
      capabilities: ["image_generate"],
      baseUrl: `${seedream.url}/api/v3/images/generations`,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    await daemon.close();

    const store = createSqliteRunStore(cwd);
    try {
      store.recordProviderCheckResult(live.provider.id, {
        ok: false,
        code: "network_failed",
        message: "Provider network check failed: timeout",
        checkedAt: "2026-05-01T00:00:00.000Z",
      });
    } finally {
      store.close();
    }

    daemon = await startDaemonForTest(new ApprovalProbeRunner({
      toolCallId: "tool_unused_startup_media_skip_restart",
      toolName: "bash",
      input: { command: "echo unused" },
    }));
    const listed = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    const provider = listed.providers.find((item) => item.id === live.provider.id);
    assert.equal(provider.lastCheck.ok, false);
    assert.equal(provider.lastCheck.code, "network_failed");
    assert.equal(seedream.requests.length, 0);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await daemon.close();
    await seedream.close();
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
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      capabilities: ["image_generate", "image_edit"],
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
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
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media production API persists storyboard order independently from canvas placement", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-production-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_production",
    toolName: "bash",
  }));
  try {
    const createdProject = await postJson(`${daemon.url}/media-projects?cwd=${encodeURIComponent(cwd)}`, {
      name: "Product launch film",
      canvasViewport: { x: 12, y: -8, zoom: 1.1 },
    });
    assert.equal(createdProject.mediaProject.name, "Product launch film");
    assert.deepEqual(createdProject.mediaProject.canvasViewport, { x: 12, y: -8, zoom: 1.1 });

    const firstScene = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(createdProject.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Opening frame",
      prompt: "",
      canvasPosition: { x: 640, y: 240 },
    });
    const secondScene = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(createdProject.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Detail frame",
      prompt: "A close up of the product material.",
      canvasPosition: { x: 80, y: 60 },
    });
    assert.equal(firstScene.mediaScene.sortOrder, 0);
    assert.equal(secondScene.mediaScene.sortOrder, 1);

    const reordered = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(createdProject.mediaProject.id)}/reorder?cwd=${encodeURIComponent(cwd)}`, {
      sceneIds: [secondScene.mediaScene.id, firstScene.mediaScene.id],
    });
    assert.deepEqual(reordered.scenes.map((scene) => scene.id), [secondScene.mediaScene.id, firstScene.mediaScene.id]);
    assert.deepEqual(reordered.scenes.map((scene) => scene.canvasPosition), [{ x: 80, y: 60 }, { x: 640, y: 240 }]);

    const detail = await getJson(`${daemon.url}/media-projects/${encodeURIComponent(createdProject.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(detail.scenes.map((scene) => scene.id), [secondScene.mediaScene.id, firstScene.mediaScene.id]);
    assert.equal(detail.sceneRuns.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media production project assets validate, persist, serve and protect scene references", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-project-assets-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_project_assets",
    toolName: "bash",
  }));
  try {
    const project = await postJson(`${daemon.url}/media-projects?cwd=${encodeURIComponent(cwd)}`, {
      name: "Image input project",
    });
    assert.deepEqual(project.assets, []);
    const imageBytes = createPngDimensionFixture(1280, 720);
    const uploadUrl = `${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/assets?cwd=${encodeURIComponent(cwd)}`;
    const uploaded = await postJson(uploadUrl, {
      kind: "upload",
      fileName: "opening.png",
      contentType: "image/png",
      contentBase64: imageBytes.toString("base64"),
    });
    assert.equal(uploaded.asset.contentType, "image/png");
    assert.equal(uploaded.asset.width, 1280);
    assert.equal(uploaded.asset.height, 720);
    assert.match(uploaded.asset.checksum, /^sha256:[a-f0-9]{64}$/);
    assert.equal("path" in uploaded.asset, false);
    const assetStore = createSqliteRunStore(cwd);
    const uploadedAssetPath = (() => {
      try {
        const persisted = assetStore.getMediaProjectAsset(uploaded.asset.id);
        assert.ok(persisted);
        return resolve(assetStore.paths.attachmentsDir, persisted.path);
      } finally {
        assetStore.close();
      }
    })();
    await access(uploadedAssetPath);

    const duplicate = await postJson(uploadUrl, {
      kind: "upload",
      fileName: "same-content.png",
      contentType: "image/png",
      contentBase64: imageBytes.toString("base64"),
    });
    assert.equal(duplicate.asset.id, uploaded.asset.id);
    const assets = await getJson(uploadUrl);
    assert.deepEqual(assets.assets.map((asset) => asset.id), [uploaded.asset.id]);
    assert.equal(assets.assets.some((asset) => "path" in asset), false);
    const projectDetail = await getJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(projectDetail.assets.some((asset) => "path" in asset), false);

    const contentResponse = await fetch(`${daemon.url}/media-project-assets/${encodeURIComponent(uploaded.asset.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(contentResponse.status, 200);
    assert.equal(contentResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await contentResponse.arrayBuffer()), imageBytes);

    const mismatch = await postJsonExpectError(uploadUrl, {
      kind: "upload",
      fileName: "mismatch.jpg",
      contentType: "image/jpeg",
      contentBase64: imageBytes.toString("base64"),
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, "invalid_media_asset");

    const truncated = await postJsonExpectError(uploadUrl, {
      kind: "upload",
      fileName: "truncated.png",
      contentType: "image/png",
      contentBase64: imageBytes.subarray(0, 24).toString("base64"),
    });
    assert.equal(truncated.status, 400);
    assert.equal(truncated.body.error, "invalid_media_asset");

    const oversized = await postJsonExpectError(uploadUrl, {
      kind: "upload",
      fileName: "oversized.png",
      contentType: "image/png",
      contentBase64: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64"),
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.error, "invalid_media_asset");
    assert.match(oversized.body.message, /1 字节到 25 MiB/);

    const scene = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Opening",
      prompt: "Camera moves forward.",
      videoImageInputs: [{ assetId: uploaded.asset.id, role: "reference_image" }],
    });
    assert.deepEqual(scene.mediaScene.videoImageInputs, [{ assetId: uploaded.asset.id, role: "reference_image" }]);
    const blockedDelete = await fetch(`${daemon.url}/media-project-assets/${encodeURIComponent(uploaded.asset.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
    });
    assert.equal(blockedDelete.status, 409);
    assert.equal((await blockedDelete.json()).error, "media_project_asset_in_use");

    await patchJson(`${daemon.url}/media-scenes/${encodeURIComponent(scene.mediaScene.id)}?cwd=${encodeURIComponent(cwd)}`, {
      videoImageInputs: [],
    });
    const deleted = await fetch(`${daemon.url}/media-project-assets/${encodeURIComponent(uploaded.asset.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).deleted, true);
    await assert.rejects(access(uploadedAssetPath), (error) => error?.code === "ENOENT");

    const projectAsset = await postJson(uploadUrl, {
      kind: "upload",
      fileName: "project-cleanup.png",
      contentType: "image/png",
      contentBase64: createPngDimensionFixture(1024, 1024).toString("base64"),
    });
    const projectAssetStore = createSqliteRunStore(cwd);
    const projectAssetPath = (() => {
      try {
        const persisted = projectAssetStore.getMediaProjectAsset(projectAsset.asset.id);
        assert.ok(persisted);
        return resolve(projectAssetStore.paths.attachmentsDir, persisted.path);
      } finally {
        projectAssetStore.close();
      }
    })();
    await access(projectAssetPath);
    const deletedProject = await fetch(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
    });
    assert.equal(deletedProject.status, 200);
    await assert.rejects(access(projectAssetPath), (error) => error?.code === "ENOENT");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media production project asset upload rejects a symlinked project directory", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-project-asset-symlink-"));
  const outside = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-project-asset-outside-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_project_asset_symlink",
    toolName: "bash",
  }));
  try {
    const project = await postJson(`${daemon.url}/media-projects?cwd=${encodeURIComponent(cwd)}`, {
      name: "Symlink boundary project",
    });
    const store = createSqliteRunStore(cwd);
    const mediaProjectsRoot = resolve(store.paths.attachmentsDir, "media-projects");
    store.close();
    await mkdir(mediaProjectsRoot, { recursive: true });
    await symlink(outside, resolve(mediaProjectsRoot, project.mediaProject.id), process.platform === "win32" ? "junction" : "dir");

    const rejected = await postJsonExpectError(
      `${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/assets?cwd=${encodeURIComponent(cwd)}`,
      {
        kind: "upload",
        fileName: "outside.png",
        contentType: "image/png",
        contentBase64: createPngDimensionFixture(1280, 720).toString("base64"),
      },
    );
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error, "media_project_asset_outside_root");
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("media production materializes project images only for the Seedance submission call", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-project-i2v-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_project_i2v",
    toolName: "bash",
  }));
  const seedance = await startMockSeedreamServer();
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-media-i2v-key";
  try {
    const provider = await createMediaProvider(daemon.url, cwd, {
      kind: "seedance",
      displayName: "Seedance 2.0",
      providerId: "seedance",
      model: "doubao-seedance-2-0-260128",
      capabilities: ["video_generate"],
      input: ["text", "image"],
      baseUrl: seedance.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const project = await postJson(`${daemon.url}/media-projects?cwd=${encodeURIComponent(cwd)}`, {
      name: "Image-to-video project",
      defaultProviderPresetId: provider.provider.id,
    });
    const imageBytes = createPngDimensionFixture(1280, 720);
    const uploaded = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/assets?cwd=${encodeURIComponent(cwd)}`, {
      kind: "upload",
      fileName: "reference.png",
      contentType: "image/png",
      contentBase64: imageBytes.toString("base64"),
    });
    const scene = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Reference scene",
      prompt: "Move the camera around the subject.",
      videoImageInputs: [{ assetId: uploaded.asset.id, role: "reference_image" }],
    });

    const run = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      sceneIds: [scene.mediaScene.id],
    });
    const stableInputs = [{
      assetId: uploaded.asset.id,
      role: "reference_image",
      checksum: uploaded.asset.checksum,
    }];
    assert.deepEqual(run.mediaJobs[0].input.videoImageInputs, stableInputs);
    assert.deepEqual(run.mediaSceneRuns[0].inputSnapshot.videoImageInputs, stableInputs);
    assert.doesNotMatch(JSON.stringify(run), /data:image|;base64,/);

    await waitForMediaJobStatus(daemon.url, cwd, run.mediaJobs[0].id, "succeeded");
    const request = seedance.requests.find((item) => item.method === "POST" && item.path.endsWith("/contents/generations/tasks"));
    assert.ok(request);
    assert.deepEqual(request.body.content, [
      { type: "text", text: "Move the camera around the subject." },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${imageBytes.toString("base64")}` },
        role: "reference_image",
      },
    ]);

    const store = createSqliteRunStore(cwd);
    let assetPath = "";
    try {
      const persistedJob = store.getMediaJob(run.mediaJobs[0].id);
      const persistedSceneRun = store.getMediaSceneRun(run.mediaSceneRuns[0].id);
      const persistedAsset = store.getMediaProjectAsset(uploaded.asset.id);
      assert.ok(persistedJob);
      assert.ok(persistedSceneRun);
      assert.ok(persistedAsset);
      assert.equal(store.getMediaJobExecutionHandle(run.mediaJobs[0].id), undefined);
      assert.doesNotMatch(JSON.stringify({ persistedJob, persistedSceneRun }), /data:image|;base64,/);
      assetPath = resolve(store.paths.attachmentsDir, persistedAsset.path);
    } finally {
      store.close();
    }
    const artifacts = await getJson(`${daemon.url}/media-jobs/${encodeURIComponent(run.mediaJobs[0].id)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.doesNotMatch(JSON.stringify(artifacts), /data:image|;base64,/);

    const providerPostCount = seedance.requests.filter((item) => item.method === "POST" && item.path.endsWith("/contents/generations/tasks")).length;
    await writeFile(assetPath, Buffer.from("tampered-image"));
    const tamperedRun = await postJson(`${daemon.url}/media-scenes/${encodeURIComponent(scene.mediaScene.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    const failed = await waitForMediaJobStatus(daemon.url, cwd, tamperedRun.mediaJob.id, "failed");
    assert.match(failed.mediaJob.errorMessage, /大小已发生变化|校验失败/);
    assert.equal(
      seedance.requests.filter((item) => item.method === "POST" && item.path.endsWith("/contents/generations/tasks")).length,
      providerPostCount,
    );
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedance.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media production rejects corrupt persisted image inputs before creating a paid job", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-corrupt-media-inputs-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_corrupt_media_inputs",
    toolName: "bash",
  }));
  const seedance = await startMockSeedreamServer();
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-corrupt-media-inputs-key";
  try {
    const provider = await createMediaProvider(daemon.url, cwd, {
      kind: "seedance",
      displayName: "Seedance 2.0",
      providerId: "seedance",
      model: "doubao-seedance-2-0-260128",
      capabilities: ["video_generate"],
      input: ["text", "image"],
      baseUrl: seedance.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const project = await postJson(`${daemon.url}/media-projects?cwd=${encodeURIComponent(cwd)}`, {
      name: "Corrupt persistence boundary",
      defaultProviderPresetId: provider.provider.id,
    });
    const uploaded = await postJson(
      `${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/assets?cwd=${encodeURIComponent(cwd)}`,
      {
        kind: "upload",
        fileName: "reference.png",
        contentType: "image/png",
        contentBase64: createPngDimensionFixture(1280, 720).toString("base64"),
      },
    );
    const scene = await postJson(
      `${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`,
      {
        title: "Must not fall back",
        prompt: "Animate this reference image.",
        videoImageInputs: [{ assetId: uploaded.asset.id, role: "reference_image" }],
      },
    );

    const store = createSqliteRunStore(cwd);
    const databasePath = store.paths.databasePath;
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare("UPDATE media_scenes SET video_image_inputs_json = ? WHERE id = ?")
        .run("{", scene.mediaScene.id);
    } finally {
      database.close();
    }

    const providerPostsBefore = seedance.requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/contents/generations/tasks"),
    ).length;
    const rejected = await postJsonExpectError(
      `${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/run?cwd=${encodeURIComponent(cwd)}`,
      { sceneIds: [scene.mediaScene.id] },
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "bad_request");
    assert.match(rejected.body.message, /Invalid SQLite media scene video_image_inputs_json/);
    assert.equal(await mediaJobCount(daemon.url, cwd), 0);
    assert.equal(
      seedance.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/contents/generations/tasks"),
      ).length,
      providerPostsBefore,
    );
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedance.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media production project run validates every legacy target before creating any scene run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-project-run-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_project_run",
    toolName: "bash",
  }));
  const seedream = await startMockSeedreamServer();
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-media-project-key";
  try {
    const provider = await createMediaProvider(daemon.url, cwd, {
      kind: "seedance",
      displayName: "Seedance Video",
      providerId: "seedance",
      model: "doubao-seedance-1-0-pro-250528",
      capabilities: ["video_generate"],
      input: ["text"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const project = await postJson(`${daemon.url}/media-projects?cwd=${encodeURIComponent(cwd)}`, {
      name: "Launch sequence",
      defaultProviderPresetId: provider.provider.id,
    });
    const readyScene = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Opening",
      prompt: "A slow cinematic product reveal.",
    });
    await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Missing prompt",
      prompt: "",
    });
    const referenceImage = createPngDimensionFixture(1280, 720);
    const uploaded = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/assets?cwd=${encodeURIComponent(cwd)}`, {
      kind: "upload",
      fileName: "unsupported-reference.png",
      contentType: "image/png",
      contentBase64: referenceImage.toString("base64"),
    });
    const unsupportedReferenceScene = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Unsupported reference",
      prompt: "Animate the reference image.",
      videoImageInputs: [{ assetId: uploaded.asset.id, role: "reference_image" }],
    });

    const legacyFailure = await postJsonExpectError(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(legacyFailure.status, 400);
    assert.match(legacyFailure.body.message, /填写分镜提示词/);
    assert.equal(await mediaJobCount(daemon.url, cwd), 0);
    const noPartialRuns = await getJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(noPartialRuns.sceneRuns.length, 0);

    const selectedRun = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      sceneIds: [readyScene.mediaScene.id],
    });
    assert.equal(selectedRun.mediaJobs.length, 1);
    assert.equal(selectedRun.mediaSceneRuns.length, 1);
    assert.equal(selectedRun.mediaSceneRuns[0].sceneId, readyScene.mediaScene.id);
    assert.equal(selectedRun.mediaJobs[0].status, "queued");
    assert.equal(selectedRun.approvals, undefined);
    assert.equal((await listApprovals(daemon.url, cwd, { mediaJobId: selectedRun.mediaJobs[0].id })).length, 0);
    const duplicateWhileActive = await postJsonExpectError(`${daemon.url}/media-scenes/${encodeURIComponent(readyScene.mediaScene.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(duplicateWhileActive.status, 409);
    assert.equal(duplicateWhileActive.body.error, "media_scene_run_active");
    await waitForMediaJobStatus(daemon.url, cwd, selectedRun.mediaJobs[0].id, "succeeded");

    const firstCompletedDetail = await getJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(
      firstCompletedDetail.scenes.find((scene) => scene.id === readyScene.mediaScene.id)?.selectedMediaSceneRunId,
      selectedRun.mediaSceneRuns[0].id,
    );

    const incompatibleBatch = await postJsonExpectError(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      sceneIds: [readyScene.mediaScene.id, unsupportedReferenceScene.mediaScene.id],
    });
    assert.equal(incompatibleBatch.status, 400);
    assert.equal(incompatibleBatch.body.error, "unsupported_capability");
    assert.match(incompatibleBatch.body.message, /不支持参考图片/);
    assert.equal(await mediaJobCount(daemon.url, cwd), 1);
    const afterIncompatibleBatch = await getJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(afterIncompatibleBatch.sceneRuns.length, 1);

    const regeneration = await postJson(`${daemon.url}/media-scenes/${encodeURIComponent(readyScene.mediaScene.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(regeneration.approval, undefined);
    await waitForMediaJobStatus(daemon.url, cwd, regeneration.mediaJob.id, "succeeded");
    const regeneratedDetail = await getJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(
      regeneratedDetail.scenes.find((scene) => scene.id === readyScene.mediaScene.id)?.selectedMediaSceneRunId,
      selectedRun.mediaSceneRuns[0].id,
    );

    const cancellable = await postJson(`${daemon.url}/media-scenes/${encodeURIComponent(readyScene.mediaScene.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancellable.mediaJob.status, "queued");
    const cancelledRun = await postJson(`${daemon.url}/media-scene-runs/${encodeURIComponent(cancellable.mediaSceneRun.id)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelledRun.mediaJob.status, "cancelled");
    assert.equal((await listApprovals(daemon.url, cwd, { mediaJobId: cancellable.mediaJob.id })).length, 0);
    const cancelledDetail = await getJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(
      cancelledDetail.scenes.find((scene) => scene.id === readyScene.mediaScene.id)?.selectedMediaSceneRunId,
      selectedRun.mediaSceneRuns[0].id,
    );
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedream.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media production keeps direct Seedance scenes and ComfyUI workflow scenes in one project", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-mixed-sources-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_mixed_sources",
    toolName: "bash",
  }));
  const seedance = await startMockSeedreamServer();
  const comfy = await startMockComfyUiServer();
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-media-mixed-key";
  try {
    const provider = await createMediaProvider(daemon.url, cwd, {
      kind: "seedance",
      displayName: "Seedance Video",
      providerId: "seedance",
      model: "doubao-seedance-1-0-pro-250528",
      capabilities: ["video_generate"],
      input: ["text"],
      baseUrl: seedance.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const connection = await postJson(`${daemon.url}/media-workflow-connections?cwd=${encodeURIComponent(cwd)}`, {
      name: "Test ComfyUI",
      baseUrl: comfy.url,
      authMode: "none",
      networkPolicy: "trusted_private_network",
      protocolVariant: "auto",
    });
    const checked = await postJson(`${daemon.url}/media-workflow-connections/${encodeURIComponent(connection.connection.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checked.connection.status, "ready");

    const graph = {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "Default prompt" } },
      "9": { class_type: "SaveVideo", inputs: { filename_prefix: "Ling" } },
    };
    const imported = await postJson(`${daemon.url}/media-workflows/import?cwd=${encodeURIComponent(cwd)}`, {
      connectionId: connection.connection.id,
      name: "Comfy storyboard",
      fileName: "workflow.json",
      graph,
    });
    assert.equal(imported.analysis.validation.ok, true);
    const promptField = imported.importedVersion.inputFields.find((field) => field.semantic === "prompt");
    assert.ok(promptField);
    const tested = await postJson(`${daemon.url}/media-workflows/${encodeURIComponent(imported.definition.id)}/test?cwd=${encodeURIComponent(cwd)}`, {
      versionId: imported.importedVersion.id,
      inputValues: { [promptField.id]: "Workflow smoke" },
    });
    assert.equal(tested.mediaJob.status, "queued");
    assert.equal(tested.approval, undefined);
    await waitForMediaJobStatus(daemon.url, cwd, tested.mediaJob.id, "succeeded");
    const activated = await postJson(`${daemon.url}/media-workflows/${encodeURIComponent(imported.definition.id)}/activate?cwd=${encodeURIComponent(cwd)}`, {
      versionId: imported.importedVersion.id,
    });
    assert.equal(activated.definition.status, "ready");

    const project = await postJson(`${daemon.url}/media-projects?cwd=${encodeURIComponent(cwd)}`, {
      name: "Mixed source storyboard",
      defaultProviderPresetId: provider.provider.id,
      defaultExecutionMode: "direct",
    });
    const directScene = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Direct scene",
      prompt: "Seedance direct scene",
      executionMode: "direct",
    });
    const workflowScene = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/scenes?cwd=${encodeURIComponent(cwd)}`, {
      title: "Workflow scene",
      prompt: "ComfyUI scene",
      executionMode: "workflow",
      workflowDefinitionId: imported.definition.id,
    });
    const run = await postJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      sceneIds: [directScene.mediaScene.id, workflowScene.mediaScene.id],
    });
    assert.equal(run.mediaJobs.length, 2);
    assert.equal(run.approvals, undefined);
    assert.equal(run.mediaJobs.every((job) => job.status === "queued"), true);
    assert.deepEqual(new Set(run.mediaJobs.map((job) => job.executionSource.kind)), new Set(["provider", "workflow"]));
    assert.deepEqual(new Set(run.mediaSceneRuns.map((sceneRun) => sceneRun.executionSnapshot.kind)), new Set(["provider", "workflow"]));
    assert.equal(run.mediaSceneRuns.find((sceneRun) => sceneRun.sceneId === workflowScene.mediaScene.id).executionSnapshot.workflowName, "Comfy storyboard");
    for (const job of run.mediaJobs) {
      await waitForMediaJobStatus(daemon.url, cwd, job.id, "succeeded");
    }
    const completedProject = await getJson(`${daemon.url}/media-projects/${encodeURIComponent(project.mediaProject.id)}?cwd=${encodeURIComponent(cwd)}`);
    const selectedRunsByScene = new Map(completedProject.scenes.map((scene) => [scene.id, scene.selectedMediaSceneRunId]));
    assert.equal(selectedRunsByScene.get(directScene.mediaScene.id), run.mediaSceneRuns.find((sceneRun) => sceneRun.sceneId === directScene.mediaScene.id)?.id);
    assert.equal(selectedRunsByScene.get(workflowScene.mediaScene.id), run.mediaSceneRuns.find((sceneRun) => sceneRun.sceneId === workflowScene.mediaScene.id)?.id);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await comfy.close();
    await seedance.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ComfyUI workflow polling resumes from the persisted execution handle after daemon restart", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-workflow-resume-"));
  const comfy = await startMockComfyUiServer({ completeImmediately: false });
  const runner = () => new ApprovalProbeRunner({ toolCallId: "tool_unused_media_workflow_resume", toolName: "bash" });
  let daemon = await startDaemonForTest(runner(), {}, { defaultWorkspaceCwd: cwd });
  try {
    const connection = await postJson(`${daemon.url}/media-workflow-connections?cwd=${encodeURIComponent(cwd)}`, {
      name: "Restart ComfyUI",
      baseUrl: comfy.url,
      authMode: "none",
      networkPolicy: "trusted_private_network",
      protocolVariant: "prompt_legacy",
    });
    await postJson(`${daemon.url}/media-workflow-connections/${encodeURIComponent(connection.connection.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    const imported = await postJson(`${daemon.url}/media-workflows/import?cwd=${encodeURIComponent(cwd)}`, {
      connectionId: connection.connection.id,
      name: "Restart workflow",
      fileName: "workflow.json",
      graph: {
        "1": { class_type: "CLIPTextEncode", inputs: { text: "Default prompt" } },
        "9": { class_type: "SaveVideo", inputs: { filename_prefix: "Ling" } },
      },
    });
    const promptField = imported.importedVersion.inputFields.find((field) => field.semantic === "prompt");
    assert.ok(promptField);
    const tested = await postJson(`${daemon.url}/media-workflows/${encodeURIComponent(imported.definition.id)}/test?cwd=${encodeURIComponent(cwd)}`, {
      versionId: imported.importedVersion.id,
      inputValues: { [promptField.id]: "Resume after restart" },
    });
    assert.equal(tested.approval, undefined);
    await waitForMediaJobStatus(daemon.url, cwd, tested.mediaJob.id, "running");
    await daemon.close();

    comfy.complete();
    daemon = await startDaemonForTest(runner(), {}, { defaultWorkspaceCwd: cwd });
    const resumed = await waitForMediaJobStatus(daemon.url, cwd, tested.mediaJob.id, "succeeded", 8_000);
    assert.equal(resumed.mediaJob.executionSource.kind, "workflow");
    const artifacts = await getJson(`${daemon.url}/media-jobs/${encodeURIComponent(tested.mediaJob.id)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(artifacts.artifacts.some((artifact) => artifact.type === "video"), true);
  } finally {
    await daemon.close().catch(() => undefined);
    await comfy.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job API blocks static media providers from reporting fake success", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-run-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_run",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      kind: "jimeng",
      displayName: "Jimeng Static",
      providerId: "jimeng",
      model: "jimeng-image",
      capabilities: ["image_generate"],
    });
    const providerId = createdProvider.provider.id;
    const createdJob = await postJsonExpectError(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: providerId,
      operation: "image_generate",
      prompt: "Create a local static artifact.",
      input: { size: "1024x1024", apiKey: "sk-test_123456789" },
    });

    assert.equal(createdJob.status, 400);
    assert.equal(createdJob.body.error, "live_media_transport_required");
    assert.match(createdJob.body.message, /当前没有可真实生成的模型/);
    assert.equal(await mediaJobCount(daemon.url, cwd), 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job live transport fails when the vendor response has no media artifact", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-run-failure-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_run_failure",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  const seedream = await startMockSeedreamServer({ imageUrls: [] });
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live No Artifact",
      capabilities: ["image_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a live artifact with a malformed vendor response.",
      input: { size: "1024x1024" },
    });

    const executed = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(executed.mediaJob.status, "failed");
    assert.match(executed.mediaJob.errorMessage, /did not include image URL data/);
    assert.deepEqual(executed.mediaJob.artifactIds, []);
    const pendingApprovals = await listApprovals(daemon.url, cwd, { mediaJobId: createdJob.mediaJob.id, status: "pending" });
    assert.equal(pendingApprovals.length, 0);

    const rerun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(rerun.mediaJob.status, "failed");
    assert.match(rerun.mediaJob.errorMessage, /did not include image URL data/);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedream.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job live transport calls Seedream image_generate directly and links artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-live-direct-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_live_direct",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  const seedream = await startMockSeedreamServer();
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Direct",
      capabilities: ["image_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a live artifact.",
      input: { size: "2K" },
    });

    const firstRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstRun.mediaJob.status, "succeeded");
    assert.equal(firstRun.approval, undefined);
    const pendingApprovals = await listApprovals(daemon.url, cwd, { mediaJobId: createdJob.mediaJob.id, status: "pending" });
    assert.equal(pendingApprovals.length, 0);

    const executed = firstRun;
    const executedArtifacts = await getJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(executed.mediaJob.status, "succeeded");
    assert.equal(executedArtifacts.artifacts.length, 3);
    assert.equal(seedream.requests.length, 2);
    assert.equal(seedream.requests[0].path, "/images/generations");
    assert.equal(seedream.requests[0].authorization, "Bearer test-key");
    assert.deepEqual(seedream.requests[0].body, {
      model: "seedream",
      prompt: "Create a live artifact.",
      response_format: "url",
      size: "2K",
    });
    assert.equal(seedream.requests[1].method, "GET");
    assert.equal(seedream.requests[1].path, "/generated/image-1.png");
    assert.equal(seedream.requests[1].authorization, undefined);
    assert.deepEqual(new Set(executed.mediaJob.artifactIds), new Set(executedArtifacts.artifacts.map((artifact) => artifact.id)));
    const markdownArtifact = executedArtifacts.artifacts.find((artifact) => artifact.type === "markdown");
    const jsonArtifact = executedArtifacts.artifacts.find((artifact) => artifact.type === "json");
    const imageArtifactRecord = executedArtifacts.artifacts.find((artifact) => artifact.type === "image");
    assert.ok(markdownArtifact);
    assert.ok(jsonArtifact);
    assert.ok(imageArtifactRecord);
    assert.equal(imageArtifactRecord.contentType, "image/png");
    assert.equal(imageArtifactRecord.sizeBytes, 8);

    const liveArtifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(jsonArtifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(liveArtifact.status, 200);
    const text = await liveArtifact.text();
    assert.match(text, /live_seedream_image_generate/);
    assert.match(text, /image-1\.png/);
    assert.doesNotMatch(text, /test-key/);

    const imageArtifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(imageArtifactRecord.id)}/content?cwd=${encodeURIComponent(cwd)}`);
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

test("legacy media cost approvals do not block direct media job execution", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-legacy-approval-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_legacy_approval",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  const seedream = await startMockSeedreamServer();
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Legacy Approval",
      capabilities: ["image_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });

    const legacyJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a legacy waiting artifact.",
      input: { size: "1024x1024" },
    });

    const store = createSqliteRunStore(cwd);
    let legacyApprovalId = "";
    try {
      const waitingJob = store.updateMediaJobStatus(
        legacyJob.mediaJob.id,
        { status: "waiting_for_approval", errorMessage: null },
        "2026-05-24T00:01:00.000Z",
      );
      assert.ok(waitingJob);
      assert.equal(waitingJob.status, "waiting_for_approval");
      const approval = store.createApprovalRequest(
        {
          mediaJobId: legacyJob.mediaJob.id,
          actionType: "media_cost",
          risk: "high",
          title: "Approve generation cost",
          description: "Legacy media cost approval.",
          payload: {
            type: "media_cost",
            providerPresetId: createdProvider.provider.id,
            model: "seedream",
            operation: "image_generate",
            promptPreview: "Create a legacy waiting artifact.",
          },
          expiresAt: "2099-01-01T00:01:00.000Z",
        },
        "2026-05-24T00:01:00.000Z",
      );
      legacyApprovalId = approval.id;
    } finally {
      store.close();
    }

    const executed = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(legacyJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(executed.mediaJob.status, "succeeded");
    assert.equal(executed.approval, undefined);
    const pendingApprovals = await listApprovals(daemon.url, cwd, { mediaJobId: legacyJob.mediaJob.id, status: "pending" });
    assert.equal(pendingApprovals.length, 1);
    assert.equal(pendingApprovals[0].id, legacyApprovalId);
    assert.equal(seedream.requests[0].path, "/images/generations");
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedream.close();
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
    assert.match(blocked.body.message, /Generation-only model presets cannot run coding tasks/);
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
      skipInitialCheck: true,
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
      skipInitialCheck: true,
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

test("write runs in newly created channels use isolated worktrees and do not conflict", async () => {
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
      runtimePolicy: { queueOnConflict: false },
    });
    const secondChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering B",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
      runtimePolicy: { queueOnConflict: false },
    });
    const firstTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: firstChannel.channel.id,
      title: "First writer",
      prompt: "Hold the path lock.",
    });
    const secondTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: secondChannel.channel.id,
      title: "Second writer",
      prompt: "Write in the second channel worktree.",
    });

    const firstResponse = await postTaskRunStream(daemon.url, cwd, firstTask.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["write"],
      idempotencyKey: "first-writer",
    });
    const firstSse = createSseReader(firstResponse);
    const firstReady = await firstSse.nextEvent();
    const firstRunId = firstReady.data.runId;
    await runner.waitUntilStarted();

    const activeLeases = await getJson(`${daemon.url}/runtime/leases?cwd=${encodeURIComponent(cwd)}&status=active`);
    assert.equal(activeLeases.leases.some((lease) => lease.ownerId === firstRunId && lease.resourceType === "bound_path"), true);
    assert.equal(activeLeases.leases.some((lease) => lease.ownerId === firstRunId && lease.resourceType === "task"), true);
    const firstRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(firstRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(firstRun.requestSnapshot.workspaceCwd, cwd);
    assert.equal(firstRun.requestSnapshot.executionCwd, firstRun.cwd);
    assert.equal(firstRun.requestSnapshot.channelWorkspaceBinding.mode, "managed_worktree");
    assert.equal(firstRun.requestSnapshot.channelWorkspaceBinding.executionCwd, firstRun.cwd);

    const secondResponse = await postTaskRunStream(daemon.url, cwd, secondTask.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["write"],
      idempotencyKey: "second-writer",
    });
    const secondSse = createSseReader(secondResponse);
    const secondReady = await secondSse.nextEvent();
    assert.equal(secondReady.event, "ready");
    assert.equal(secondReady.data.queued, undefined);
    await runner.waitUntilStarted(2);
    assert.equal(runner.runs.length, 2);
    assert.notEqual(runner.runs[0].cwd, runner.runs[1].cwd);
    assert.match(runner.runs[0].cwd, /\.ling-stack\/worktrees\/channels\//);
    assert.match(runner.runs[1].cwd, /\.ling-stack\/worktrees\/channels\//);

    const transitions = await getJson(
      `${daemon.url}/state-transitions?cwd=${encodeURIComponent(cwd)}&entityType=task&entityId=${encodeURIComponent(firstTask.task.id)}`,
    );
    assert.equal(transitions.transitions.some((event) => event.event === "claim" && event.toStatus === "claimed"), true);
    assert.equal(transitions.transitions.some((event) => event.event === "start_run" && event.toStatus === "running"), true);

    runner.release();
    await Promise.all([firstSse.collectRemaining(), secondSse.collectRemaining()]);

    const remainingLeases = await getJson(`${daemon.url}/runtime/leases?cwd=${encodeURIComponent(cwd)}&status=active`);
    assert.equal(remainingLeases.leases.some((lease) => lease.ownerId === firstRunId), false);
    assert.equal(remainingLeases.leases.some((lease) => lease.ownerId === secondReady.data.runId), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queueOnConflict persists a queued run for channels explicitly handed off to Local", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-bound-path-queue-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const firstChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering A",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
      runtimePolicy: { queueOnConflict: true },
    });
    const secondChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering B",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
      runtimePolicy: { queueOnConflict: true },
    });
    await postJson(`${daemon.url}/channels/${encodeURIComponent(firstChannel.channel.id)}/workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "local",
    });
    await postJson(`${daemon.url}/channels/${encodeURIComponent(secondChannel.channel.id)}/workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "local",
    });
    const firstTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: firstChannel.channel.id,
      title: "First writer",
      prompt: "Hold the path lock.",
    });
    const secondTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: secondChannel.channel.id,
      title: "Second writer",
      prompt: "Queue for the path lock.",
    });

    const firstResponse = await postTaskRunStream(daemon.url, cwd, firstTask.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["write"],
      idempotencyKey: "first-queued-writer",
    });
    const firstSse = createSseReader(firstResponse);
    const firstReady = await firstSse.nextEvent();
    assert.equal(firstReady.event, "ready");
    await runner.waitUntilStarted();

    const queuedResponse = await postTaskRunStream(daemon.url, cwd, secondTask.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["write"],
      idempotencyKey: "second-queued-writer",
    });
    const queuedEvents = parseSseText(await queuedResponse.text());
    assert.equal(queuedEvents[0].event, "ready");
    assert.equal(queuedEvents[0].data.queued, true);
    assert.equal(queuedEvents[0].data.queueReason, "resource_conflict");
    assert.equal(runner.runs.length, 1);

    const queuedRunId = queuedEvents[0].data.runId;
    const queuedWorkUnitId = queuedEvents[0].data.workUnitId;
    const queuedRuns = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}&status=queued&limit=20`);
    assert.equal(queuedRuns.runs.some((run) => run.id === queuedRunId && run.workUnitId === queuedWorkUnitId), true);

    const supervisor = await getJson(`${daemon.url}/runtime/supervisor?cwd=${encodeURIComponent(cwd)}`);
    const queuedWorkUnit = supervisor.queued.find((workUnit) => workUnit.id === queuedWorkUnitId);
    assert.ok(queuedWorkUnit);
    assert.equal(queuedWorkUnit.linkedRunId, queuedRunId);
    assert.equal(queuedWorkUnit.status, "queued");

    const detail = await getJson(`${daemon.url}/work-units/${encodeURIComponent(queuedWorkUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.run.status, "queued");
    assert.equal(detail.events.some((event) => event.type === "work_unit_queued"), true);
    assert.equal(detail.leases.some((lease) => lease.status === "active"), false);
    assert.equal(detail.semaphoreSlots.some((slot) => slot.status === "active"), false);

    runner.release();
    await firstSse.collectRemaining();
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime diagnostics expose the same daemon-owned work unit to web and desktop-style clients", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-runtime-diagnostics-"));
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
      title: "Shared runtime task",
      prompt: "Hold active runtime state.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "shared-runtime-client-key",
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const runId = ready.data.runId;
    await runner.waitUntilStarted();

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(run.workUnitId);
    const webRuntime = await getJson(`${daemon.url}/runtime?cwd=${encodeURIComponent(cwd)}`);
    const desktopRuntime = await getJson(`${daemon.url}/runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(webRuntime.runtime.runtimeInstanceId, desktopRuntime.runtime.runtimeInstanceId);

    const listed = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&linkedRunId=${encodeURIComponent(runId)}`);
    assert.equal(listed.workUnits.length, 1);
    assert.equal(listed.workUnits[0].id, run.workUnitId);
    assert.equal(listed.workUnits[0].status, "running");

    const detail = await getJson(`${daemon.url}/work-units/${encodeURIComponent(run.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.run.id, runId);
    assert.equal(detail.workUnit.linkedRunId, runId);
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.events.some((event) => event.type === "work_unit_started"), true);
    assert.equal(detail.leases.some((lease) => lease.workUnitId === run.workUnitId), true);

    const eventReplay = await getJson(`${daemon.url}/work-units/${encodeURIComponent(run.workUnitId)}/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0`);
    assert.equal(eventReplay.workUnitId, run.workUnitId);
    assert.ok(eventReplay.events.length >= 1);

    const diagnostics = await getJson(`${daemon.url}/runtime/supervisor?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(diagnostics.runtime.runtimeInstanceId, webRuntime.runtime.runtimeInstanceId);
    assert.equal(diagnostics.active.some((unit) => unit.id === run.workUnitId), true);
    assert.equal(diagnostics.leases.some((lease) => lease.workUnitId === run.workUnitId), true);

    const active = await getJson(`${daemon.url}/runtime/active?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(active.workUnits.some((unit) => unit.id === run.workUnitId), true);
    const leases = await getJson(`${daemon.url}/runtime/leases?cwd=${encodeURIComponent(cwd)}&status=active&workUnitId=${encodeURIComponent(run.workUnitId)}`);
    assert.equal(leases.leases.every((lease) => lease.workUnitId === run.workUnitId), true);
    const semaphores = await getJson(`${daemon.url}/runtime/semaphores?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(Array.isArray(semaphores.semaphoreSlots));

    runner.release();
    await sse.collectRemaining();
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("work unit cancel cancels a linked active run without late success overwrite", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-work-unit-cancel-"));
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
      title: "Cancel by work unit",
      prompt: "Cancel through the runtime supervisor.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "work-unit-cancel-key",
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const runId = ready.data.runId;
    await runner.waitUntilStarted();
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(run.workUnitId);

    const cancelled = await postJson(`${daemon.url}/work-units/${encodeURIComponent(run.workUnitId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.workUnit.status, "cancelled");
    const cancelledRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(cancelledRun.status, "cancelled");

    runner.release();
    await sse.collectRemaining();
    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "cancelled");
    const detail = await getJson(`${daemon.url}/work-units/${encodeURIComponent(run.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.events.some((event) => event.type === "work_unit_cancelled"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run cancel cancels pending approvals for a waiting run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-run-cancel-approval-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_cancel_waiting_approval",
    toolName: "bash",
    input: { command: "echo waiting" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_cancel_waiting_approval"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    const cancelled = await postJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.run.status, "cancelled");

    const approvals = await listApprovals(daemon.url, cwd, runId);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, approvalId);
    assert.equal(approvals[0].status, "cancelled");
    assert.match(approvals[0].decisionReason, /cancelled/i);

    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&runId=${encodeURIComponent(runId)}`);
    assert.deepEqual(pending.approvals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queued run guidance starts FIFO continuation after the source run finishes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-run-guidance-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  let sse;
  let sseDrained = false;
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
      title: "Guided task",
      prompt: "Build the initial result.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      permissionMode: "balanced",
      idempotencyKey: "guidance-source",
    });
    sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const sourceRunId = ready.data.runId;
    await runner.waitUntilStarted();

    const rejectedChannelLineage = await fetch(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "queue_followup",
        instruction: "Attempt to inject channel lineage.",
        messagePayload: {
          sourceMessageId: "msg_untrusted_channel_source",
          targetTeammateId: "teammate_untrusted",
          body: "Attempt to inject channel lineage.",
          attachmentIds: [],
          linkPreviewIds: [],
        },
        idempotencyKey: "reject-channel-lineage",
      }),
    });
    assert.equal(rejectedChannelLineage.status, 400);
    assert.match((await rejectedChannelLineage.json()).message, /daemon-managed channel lineage fields/);

    const first = await postJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "After that, verify the memory audit UI.",
      messagePayload: {
        body: "After that, verify the memory audit UI.",
        attachmentIds: [],
        linkPreviewIds: [],
      },
      idempotencyKey: "guidance-1",
    });
    const second = await postJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "Then summarize remaining risk.",
      idempotencyKey: "guidance-2",
    });
    assert.equal(first.intervention.status, "queued");
    assert.deepEqual(first.intervention.messagePayload, {
      body: "After that, verify the memory audit UI.",
      attachmentIds: [],
      linkPreviewIds: [],
    });
    assert.equal(second.intervention.status, "queued");

    const listed = await getJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listed.interventions.map((item) => item.id), [first.intervention.id, second.intervention.id]);
    assert.deepEqual(listed.interventions[0].messagePayload, first.intervention.messagePayload);
    assert.equal(runner.runs.length, 1);

    runner.release();
    await sse.collectRemaining();
    sseDrained = true;
    await runner.waitUntilStarted(3);

    const updatedFirst = await getJson(`${daemon.url}/run-interventions/${encodeURIComponent(first.intervention.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(updatedFirst.intervention.status, "started");
    assert.ok(updatedFirst.intervention.continuationRunId);

    const continuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(updatedFirst.intervention.continuationRunId)}?cwd=${encodeURIComponent(cwd)}`);
    const source = await getJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(source.threadId);
    assert.equal(continuation.parentRunId, sourceRunId);
    assert.equal(continuation.interventionId, first.intervention.id);
    assert.equal(continuation.threadId, source.threadId);
    assert.equal(continuation.requestSnapshot.permissionMode, "balanced");
    assert.match(continuation.requestSnapshot.task.prompt, /After that, verify the memory audit UI/);

    const updatedSecond = await getJson(`${daemon.url}/run-interventions/${encodeURIComponent(second.intervention.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(updatedSecond.intervention.status, "started");
    assert.ok(updatedSecond.intervention.continuationRunId);
    const secondContinuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(updatedSecond.intervention.continuationRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(secondContinuation.parentRunId, sourceRunId);
    assert.equal(secondContinuation.interventionId, second.intervention.id);
    assert.equal(secondContinuation.threadId, source.threadId);
    assert.match(secondContinuation.requestSnapshot.task.prompt, /Then summarize remaining risk/);
  } finally {
    runner.release();
    if (sse && !sseDrained) {
      await sse.collectRemaining().catch(() => {});
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interrupt redirect cancels the source run and starts a linked continuation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-run-redirect-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  let sse;
  let sseDrained = false;
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
      title: "Redirect task",
      prompt: "Start in the wrong direction.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "redirect-source",
    });
    sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const sourceRunId = ready.data.runId;
    await runner.waitUntilStarted();

    const redirect = await postJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "interrupt_redirect",
      instruction: "Stop and use the daemon API path instead.",
      idempotencyKey: "redirect-1",
    });
    assert.equal(redirect.intervention.mode, "interrupt_redirect");
    assert.equal(redirect.run.status, "cancelled");
    assert.equal(redirect.intervention.status, "cancelling_source");

    runner.release();
    await sse.collectRemaining();
    sseDrained = true;
    await runner.waitUntilStarted(2);

    const source = await getJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(source.status, "cancelled");
    assert.ok(source.threadId);
    const intervention = await getJson(`${daemon.url}/run-interventions/${encodeURIComponent(redirect.intervention.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(intervention.intervention.status, "started");
    assert.ok(intervention.intervention.continuationRunId);

    const continuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(intervention.intervention.continuationRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(continuation.parentRunId, sourceRunId);
    assert.equal(continuation.interventionId, redirect.intervention.id);
    assert.equal(continuation.continuationReason, "interrupt_redirect");
    assert.equal(continuation.threadId, source.threadId);
    assert.match(continuation.requestSnapshot.task.prompt, /Stop and use the daemon API path instead/);
  } finally {
    runner.release();
    if (sse && !sseDrained) {
      await sse.collectRemaining().catch(() => {});
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queued run guidance promote cancels the active run without duplicating the intervention", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-run-promote-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  let sse;
  let sseDrained = false;
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
      title: "Promote guidance task",
      prompt: "Keep thinking until redirected.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "promote-source",
    });
    sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const sourceRunId = ready.data.runId;
    await runner.waitUntilStarted();

    const queued = await postJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "Stop the current direction and inspect the shared guidance component.",
      idempotencyKey: "promote-guidance-1",
    });
    assert.equal(queued.intervention.status, "queued");

    const promoted = await postJson(`${daemon.url}/run-interventions/${encodeURIComponent(queued.intervention.id)}/promote?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(promoted.intervention.id, queued.intervention.id);
    assert.ok(["cancelling_source", "starting_continuation", "started"].includes(promoted.intervention.status));
    assert.equal(promoted.run.status, "cancelled");

    runner.release();
    await sse.collectRemaining();
    sseDrained = true;
    await runner.waitUntilStarted(2);

    const listed = await getJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.interventions.filter((item) => item.id === queued.intervention.id).length, 1);

    const intervention = await getJson(`${daemon.url}/run-interventions/${encodeURIComponent(queued.intervention.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(intervention.intervention.status, "started");
    assert.ok(intervention.intervention.continuationRunId);
    const continuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(intervention.intervention.continuationRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(continuation.parentRunId, sourceRunId);
    assert.equal(continuation.interventionId, queued.intervention.id);
    assert.match(continuation.requestSnapshot.task.prompt, /inspect the shared guidance component/);
  } finally {
    runner.release();
    if (sse && !sseDrained) {
      await sse.collectRemaining().catch(() => {});
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("work unit retry and reconcile APIs operate on durable supervisor state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-work-unit-controls-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused",
    toolName: "read",
    input: { path: "README.md" },
  }));
  try {
    await getJson(`${daemon.url}/runtime?cwd=${encodeURIComponent(cwd)}`);

    let store = createSqliteRunStore(cwd);
    try {
      store.createWorkUnit({
        id: "wu_failed_retry",
        workspaceId: DEFAULT_WORKSPACE_ID,
        kind: "task_run",
        ownerType: "task",
        ownerId: "task_failed_retry",
        idempotencyKey: "failed-retry-key",
        status: "failed",
        createdByActor: "system",
        request: { prompt: "retry" },
        now: "2026-06-04T01:00:00.000Z",
      });
      const running = store.createWorkUnit({
        id: "wu_running_reconcile",
        workspaceId: DEFAULT_WORKSPACE_ID,
        kind: "task_run",
        ownerType: "task",
        ownerId: "task_running_reconcile",
        idempotencyKey: "running-reconcile-key",
        status: "running",
        createdByActor: "system",
        request: { prompt: "reconcile" },
        now: "2026-06-04T01:01:00.000Z",
      });
      const attempt = store.createWorkUnitAttempt({
        id: "attempt_running_reconcile",
        workUnitId: running.id,
        attemptNumber: 1,
        runtimeInstanceId: "runtime_test",
        runnerId: "runner_pi_embedded",
        now: "2026-06-04T01:01:01.000Z",
      });
      store.acquireResourceLease({
        workspaceId: DEFAULT_WORKSPACE_ID,
        resourceType: "provider",
        resourceKey: "provider_reconcile",
        ownerType: "work_unit_attempt",
        ownerId: attempt.id,
        workUnitId: running.id,
        attemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        acquiredAt: "2026-06-04T01:01:02.000Z",
        expiresAt: "2026-06-04T01:11:02.000Z",
      });
      store.acquireRuntimeSemaphoreSlot({
        workspaceId: DEFAULT_WORKSPACE_ID,
        resourceType: "provider",
        resourceKey: "provider_reconcile",
        limit: 1,
        ownerType: "work_unit_attempt",
        ownerId: attempt.id,
        workUnitId: running.id,
        attemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        acquiredAt: "2026-06-04T01:01:03.000Z",
        expiresAt: "2026-06-04T01:11:03.000Z",
      });
    } finally {
      store.close();
    }

    const retried = await postJson(`${daemon.url}/work-units/wu_failed_retry/retry?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(retried.workUnit.status, "queued");
    assert.equal(retried.event.type, "work_unit_queued");

    const reconciled = await postJson(`${daemon.url}/work-units/wu_running_reconcile/reconcile?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(reconciled.workUnit.status, "stale");
    const detail = await getJson(`${daemon.url}/work-units/wu_running_reconcile?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.attempts[0].status, "lost");
    assert.equal(detail.leases.some((lease) => lease.status === "active"), false);
    assert.equal(detail.semaphoreSlots.some((slot) => slot.status === "active"), false);
    assert.equal(detail.events.some((event) => event.type === "work_unit_stale"), true);
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
    const activeRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(activeRun.workUnitId);

    const cancel = await postJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancel.cancelled, true);
    assert.equal(cancel.run.status, "cancelled");

    runner.release();
    await sse.collectRemaining();

    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "cancelled");
    assert.equal(runner.runs.length, 1);

    const events = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/events?cwd=${encodeURIComponent(cwd)}&limit=1000`);
    const ignoredCompletions = events.events.filter((event) => event.type === "stale_runner_completion_ignored");
    assert.equal(ignoredCompletions.length, 1);
    assert.equal(ignoredCompletions[0].data.reportedStatus, "succeeded");
    assert.equal(ignoredCompletions[0].data.currentRunStatus, "cancelled");
    assert.equal(ignoredCompletions[0].data.currentWorkUnitStatus, "cancelled");
    assert.equal(ignoredCompletions[0].data.reason, "run_cancelled");

    const detail = await getJson(`${daemon.url}/work-units/${encodeURIComponent(activeRun.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    const runtimeIgnoredCompletions = detail.events.filter((event) => event.type === "stale_runner_completion_ignored");
    assert.equal(runtimeIgnoredCompletions.length, 1);
    assert.equal(runtimeIgnoredCompletions[0].data.runEventId, ignoredCompletions[0].id);
    assert.equal(runtimeIgnoredCompletions[0].data.reportedStatus, "succeeded");
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

class ThreadResumeRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      taskId: options.task.id,
      title: options.task.title,
      prompt: options.task.prompt,
      parentRunId: options.task.parentRunId,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
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

class ApprovalArtifactRunner {
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
      toolCallId: "tool_action_artifacts",
      toolName: "bash",
      args: { command: "echo sk-test_action_preview_secret" },
    });
    const decision = await options.onApprovalRequired?.({
      toolCallId: "tool_action_artifacts",
      toolName: "bash",
      input: { command: "echo sk-test_action_preview_secret" },
      task: options.task,
      cwd: options.cwd,
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_action_artifacts",
      toolName: "bash",
      result: {
        stdout: `approved stdout artifact: ${decision?.approved ? "yes" : "no"}`,
      },
      isError: !decision?.approved,
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

class NonApprovalToolLifecycleRunner {
  constructor() {
    this.started = false;
    this.startedResolvers = [];
    this.finishResolver = undefined;
    this.finished = false;
  }

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
      toolCallId: "tool_read_lifecycle",
      toolName: "read",
      args: { path: "README.md" },
    });
    this.started = true;
    this.startedResolvers.splice(0).forEach((resolveStarted) => resolveStarted());
    await new Promise((resolve) => {
      this.finishResolver = resolve;
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_read_lifecycle",
      toolName: "read",
      result: { path: "README.md", content: "ok" },
      isError: false,
    });
    options.onEvent?.({
      type: "tool_start",
      toolCallId: "tool_grep_lifecycle",
      toolName: "grep",
      args: { pattern: "missing", path: "." },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_grep_lifecycle",
      toolName: "grep",
      result: { error: "no matches" },
      isError: true,
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

  async waitUntilToolStarted() {
    if (this.started) {
      return;
    }
    await withTimeout(
      new Promise((resolveStarted) => this.startedResolvers.push(resolveStarted)),
      2_000,
      "Timed out waiting for non-approval tool start.",
    );
  }

  finish() {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.finishResolver?.();
  }
}

class ApprovalProbeRunner {
  constructor(request, emitHandledToolLifecycle = false) {
    this.request = request;
    this.emitHandledToolLifecycle = emitHandledToolLifecycle;
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
      runtimeToolFeatures: options.runtimeToolFeatures,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    if (this.emitHandledToolLifecycle) {
      options.onEvent?.({
        type: "tool_start",
        toolCallId: this.request.toolCallId,
        toolName: this.request.toolName,
        args: this.request.input,
      });
    }
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
        result: this.emitHandledToolLifecycle
          ? { error: decision.handledResult?.content?.[0]?.text }
          : { approved: decision.approved, reason: decision.reason },
        isError: decision.handledResult?.isError ?? !decision.approved,
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

class UnifiedExecProbeRunner {
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
      runtimeToolFeatures: options.runtimeToolFeatures,
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
      toolCallId: this.request.toolCallId,
      toolName: this.request.toolName,
      args: this.request.input,
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
        result: decision.handledResult ?? { approved: decision.approved, reason: decision.reason },
        isError: decision.handledResult?.isError ?? !decision.approved,
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
    await withTimeout((async () => {
      while (this._startedCount < count) {
        await new Promise((resolveStarted) => {
          this._startedResolvers.push(resolveStarted);
        });
      }
    })(), 5_000, "Timed out waiting for blocking runner to start.");
  }

  release() {
    this._release?.();
  }
}

class AbortAwareBlockingRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    await new Promise((resolveWait, rejectWait) => {
      if (options.signal?.aborted) {
        rejectWait(options.signal.reason ?? new Error("aborted"));
        return;
      }
      options.signal?.addEventListener("abort", () => {
        rejectWait(options.signal.reason ?? new Error("aborted"));
      }, { once: true });
      if (!options.signal) resolveWait();
    });
    return { taskId: options.task.id, events: [], messages: [] };
  }
}

async function startDaemonForTest(runner, dependencies = {}, config = {}) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, ...config }, { runner, ...dependencies });
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
  const { skipInitialCheck = false, ...providerOverrides } = overrides;
  const created = await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...providerOverrides,
  });
  if (!skipInitialCheck) {
    await postJson(`${baseUrl}/providers/${encodeURIComponent(created.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
  }
  return created;
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

async function startMockSeedreamServer(options = {}) {
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
    if (request.method === "GET" && request.url === "/generated/video-1.mp4") {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: {},
      });
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(Buffer.from("mock-seedance-video"));
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
    if (request.method === "POST" && request.url?.endsWith("/contents/generations/tasks")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "seedance-task-1",
        status: "queued",
        debug: { echo: request.headers.authorization },
      }));
      return;
    }
    if (request.method === "GET" && request.url?.endsWith("/contents/generations/tasks/seedance-task-1")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "seedance-task-1",
        status: "succeeded",
        content: { video_url: `http://${request.headers.host}/generated/video-1.mp4` },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    const imageUrls = options.imageUrls ?? [`http://${request.headers.host}/generated/image-1.png`];
    response.end(JSON.stringify({
      created: 1779537600,
      data: imageUrls.map((url) => ({ url })),
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

async function startMockComfyUiServer(options = {}) {
  const requests = [];
  let completed = options.completeImmediately !== false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText && request.headers["content-type"]?.includes("application/json") ? JSON.parse(bodyText) : {};
    requests.push({ method: request.method, path: url.pathname, body });
    if (request.method === "GET" && url.pathname === "/api/object_info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ CLIPTextEncode: {}, SaveVideo: {} }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/prompt") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt_id: `prompt_${requests.filter((item) => item.path === "/api/prompt").length}` }));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/history_v2/")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/history/")) {
      const operationId = decodeURIComponent(url.pathname.slice("/api/history/".length));
      response.writeHead(200, { "content-type": "application/json" });
      if (!completed) {
        response.end(JSON.stringify({}));
        return;
      }
      response.end(JSON.stringify({
        [operationId]: {
          status: { status_str: "success" },
          outputs: { "9": { videos: [{ filename: `${operationId}.mp4`, type: "output" }] } },
        },
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/view") {
      response.writeHead(200, { "content-type": "video/mp4", "content-length": "12" });
      response.end(Buffer.from("mock-video-1"));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    complete: () => { completed = true; },
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function startMockOpenAICompatibleServer(options = {}) {
  const requests = [];
  const models = options.models ?? [
    { id: "cliproxy-gpt-4o", object: "model", owned_by: "cliproxy" },
    { id: "cliproxy-claude-sonnet", object: "model", owned_by: "cliproxy" },
  ];
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
        data: models,
      }));
      return;
    }
    if (request.method === "POST" && new URL(request.url ?? "/", "http://127.0.0.1").pathname.endsWith("/images/generations")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        created: 1,
        data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }],
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

async function createPlanModeThread(baseUrl, cwd) {
  const provider = await createStaticChatProvider(baseUrl, cwd);
  const channel = await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Plan Mode Test",
    boundPath: cwd,
    defaultProviderPresetId: provider.provider.id,
  });
  const created = await postJson(`${baseUrl}/threads?cwd=${encodeURIComponent(cwd)}`, {
    kind: "channel_discussion",
    channelId: channel.channel.id,
  });
  await patchJson(`${baseUrl}/threads/${encodeURIComponent(created.thread.id)}/mode?cwd=${encodeURIComponent(cwd)}`, {
    mode: "plan",
  });
  return { channel: channel.channel, thread: created.thread };
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

async function listShellSnapshots(baseUrl, cwd, runId, toolCallId) {
  const url = new URL(`${baseUrl}/runs/${encodeURIComponent(runId)}/shell-snapshots`);
  url.searchParams.set("cwd", cwd);
  if (toolCallId) {
    url.searchParams.set("toolCallId", toolCallId);
  }
  return await getJson(url.toString());
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

async function patchJsonExpectError(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
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

async function postJson(url, body) {
  await ensureGitRepoForChannelPost(url, body);
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

async function waitForMediaJobStatus(baseUrl, cwd, mediaJobId, expectedStatus, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  for (;;) {
    latest = await getJson(`${baseUrl}/media-jobs/${encodeURIComponent(mediaJobId)}?cwd=${encodeURIComponent(cwd)}`);
    if (latest.mediaJob.status === expectedStatus) {
      return latest;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for media job ${mediaJobId} to become ${expectedStatus}; latest=${latest.mediaJob.status}; error=${latest.mediaJob.errorMessage ?? "none"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
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

function createPngDimensionFixture(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", deflateSync(scanlines)),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createPngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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

async function waitForCondition(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw lastError ?? new Error(message);
}
