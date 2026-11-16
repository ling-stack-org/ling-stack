import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient, LingDaemonError } from "../dist/index.js";
import { readHarnessDiagnosticsReportFromClient } from "../../../scripts/framework-assurance/diagnostics.mjs";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
type CapturedRequest = { url: URL; init: FetchInit };
type AssociationInput = Parameters<LingDaemonClient["projectRunAssuranceEvaluationAssociation"]>[2];
type NodeRerunIntent = Parameters<LingDaemonClient["admitNodeRerun"]>[2];

const cursor = { runId: "run:a", workUnitId: "unit / 中文", createdAt: "2026-10-09T00:00:00.000Z", kind: "tool_execution", id: "tool \"1\"" } as const;

test("diagnostic transport uses a GET with encoded scope and lossless JSON keyset cursor", async () => {
  const calls: Array<readonly [URL, FetchInit]> = [];
  const body = { schemaVersion: 1, cwd: "/workspace 中文", workUnitId: cursor.workUnitId, runId: cursor.runId, status: "available", items: [], observedAt: "now" };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input: FetchInput, init: FetchInit) => {
    calls.push([new URL(String(input)), init]);
    return Response.json(body);
  } });
  assert.deepEqual(await client.getWorkUnitHarnessDiagnostics(body.cwd, cursor.workUnitId, { limit: 100, cursor }), body);
  const [url, init] = calls[0];
  assert.ok(init);
  assert.equal(url.pathname, "/work-units/unit%20%2F%20%E4%B8%AD%E6%96%87/harness");
  assert.equal(url.searchParams.get("cwd"), body.cwd);
  assert.equal(url.searchParams.get("limit"), "100");
  const encodedCursor = url.searchParams.get("cursor");
  assert.ok(encodedCursor);
  assert.deepEqual(JSON.parse(encodedCursor), cursor);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.headers, undefined);
});

test("initial read and explicit refresh omit cursor and let the Host own the default page size", async () => {
  const calls: URL[] = [];
  const client = new LingDaemonClient({ fetch: async (input: FetchInput) => { calls.push(new URL(String(input))); return Response.json({ items: [] }); } });
  await client.getWorkUnitHarnessDiagnostics("/repo", "unit");
  await client.getWorkUnitHarnessDiagnostics("/repo", "unit", { limit: 500 });
  assert.equal(calls[0].searchParams.get("cursor"), null);
  assert.equal(calls[0].searchParams.get("limit"), null);
  assert.equal(calls[1].searchParams.get("cursor"), null);
  assert.equal(calls[1].searchParams.get("limit"), "500");
});

test("live assurance evidence uses a read-only encoded Run endpoint", async () => {
  const calls: CapturedRequest[] = [];
  const body = {
    schemaVersion: 1,
    kind: "live_execution_evidence",
    comparison: { model: "fixture-model", reasoning: "none", executionStrategy: "pi", node: "22.22.1", platform: "darwin", arch: "arm64" },
    execution: {
      runId: "run/live",
      workUnitId: "unit-live",
      attemptId: "attempt-live",
      runtimeInstanceId: "runtime-live",
      fencingToken: "fence-live",
      runStatus: "succeeded",
      workUnitStatus: "succeeded",
      attemptStatus: "succeeded",
      claimStatus: "terminal_retained",
      effectStatus: "confirmed",
    },
    snapshots: {
      run: { revision: 1, sha256: "a".repeat(64) },
      workUnit: { revision: 2, sha256: "b".repeat(64) },
      attempt: { revision: 3, sha256: "c".repeat(64) },
    },
    artifacts: [{ role: "json-0", artifactId: "artifact-live", contentSha256: "d".repeat(64) }],
    observedAt: "2026-11-10T08:00:00.000Z",
    limitations: ["read_only_host_projection"],
  };
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    computerUseRouteToken: "TOKEN_SENTINEL",
    fetch: async (input: FetchInput, init: FetchInit) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json(body);
    },
  });
  assert.deepEqual(await client.getRunAssuranceEvidence("run/live", "/workspace/assurance"), body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/runs/run%2Flive/assurance-evidence");
  assert.equal(calls[0].url.searchParams.get("cwd"), "/workspace/assurance");
  assert.equal(calls[0].init?.method, "GET");
  assert.ok(!JSON.stringify(calls).includes("TOKEN_SENTINEL"));
});

test("evaluation association uses a read-only POST with encoded Run scope", async () => {
  const calls: CapturedRequest[] = [];
  const body = {
    schemaVersion: 1,
    kind: "assurance_evaluation_association",
    authority: "report-only",
    assessment: "not_assessed",
    enforcementAuthorized: false,
    status: "unavailable",
    observationId: null,
    mappingDigest: null,
    evaluation: null,
    binding: { run: "unavailable", frozenInputs: "unavailable", candidateArtifact: "unavailable" },
    attemptBinding: { status: "unavailable", code: "association.attempt_binding_unavailable" },
    grades: [],
    diagnostics: [{ code: "association.workspace_uninitialized" }],
    limitations: ["read_only"],
  };
  const input = {
    request: { schemaVersion: 1, source: { execution: { runId: "run/association" } } },
    frozenInputs: {
      suiteBytes: "",
      taskBytes: "",
      ruleBytes: "",
      expectedBytes: "",
      profileBytes: "",
      lockBytes: "",
    },
  } as unknown as AssociationInput;
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    computerUseRouteToken: "TOKEN_SENTINEL",
    fetch: async (request: FetchInput, init: FetchInit) => {
      calls.push({ url: new URL(String(request)), init });
      return Response.json(body);
    },
  });
  assert.deepEqual(await client.projectRunAssuranceEvaluationAssociation("run/association", "/workspace/assurance", input), body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/runs/run%2Fassociation/assurance-evaluation-association");
  assert.equal(calls[0].url.searchParams.get("cwd"), "/workspace/assurance");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), input);
  assert.ok(!JSON.stringify(calls).includes("TOKEN_SENTINEL"));
});

test("node rerun admission uses the encoded Run scope and returns the Host plan", async () => {
  const calls: CapturedRequest[] = [];
  const body = {
    schemaVersion: 1,
    kind: "node_rerun_host_admission_response",
    runId: "run/rerun",
    evaluationInvoked: true,
    admission: {
      schemaVersion: 1,
      kind: "node_rerun_admission",
      decision: "eligible_for_host_admission",
      executionAuthorized: false,
      intentId: "intent-rerun",
      source: { runId: "run/rerun", attemptId: "attempt-rerun", nodeId: "node-target" },
      blockers: [],
      nextStep: "host_must_revalidate_and_mint_identity",
    },
    plan: {
      schemaVersion: 1,
      kind: "node_rerun_host_admission_plan",
      planId: "node_rerun_plan_nrhpv1_fixture",
      planFingerprint: "nrhpv1_fixture",
      intentId: "intent-rerun",
      idempotencyKey: "rerun-key",
      source: { runId: "run/rerun", attemptId: "attempt-rerun", nodeId: "node-target" },
      actions: {
        workUnit: "host_minted", run: "host_minted", attempt: "host_minted", fence: "host_minted",
        approval: "fresh_current_policy", graphMutation: "none", providerDispatch: "disabled",
      },
    },
  };
  const intent = { schemaVersion: 1, kind: "node_rerun_intent", intentId: "intent-rerun" } as unknown as NodeRerunIntent;
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input: FetchInput, init: FetchInit) => {
    calls.push({ url: new URL(String(input)), init });
    return Response.json(body);
  } });
  assert.deepEqual(await client.admitNodeRerun("run/rerun", "/workspace/rerun", intent), body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/runs/run%2Frerun/node-rerun/admission");
  assert.equal(calls[0].url.searchParams.get("cwd"), "/workspace/rerun");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), intent);
});

test("structured cold-workspace and invalid-cursor failures stay visible to the safe UI adapter", async () => {
  for (const [status, code] of [[503, "harness_workspace_uninitialized"], [400, "harness_diagnostics_invalid_query"], [500, "harness_diagnostics_unavailable"]] as const) {
    const client = new LingDaemonClient({ fetch: async () => Response.json({ error: code, message: "SECRET_SENTINEL" }, { status }) });
    await assert.rejects(client.getWorkUnitHarnessDiagnostics("/repo", "unit"), error => error instanceof LingDaemonError && error.status === status && error.code === code);
  }
});

test("read-only diagnostic transport does not attach the computer-use authorization token", async () => {
  let request: { input: string; init: FetchInit } | undefined;
  const client = new LingDaemonClient({ computerUseRouteToken: "TOKEN_SENTINEL", fetch: async (input: FetchInput, init: FetchInit) => {
    request = { input: String(input), init };
    return Response.json({ items: [] });
  } });
  await client.getWorkUnitHarnessDiagnostics("/repo", "unit", { cursor });
  assert.ok(request);
  assert.ok(!JSON.stringify(request).includes("TOKEN_SENTINEL"));
  assert.equal(request.init?.method, "GET");
});

test("framework-assurance read-only report composes with the real LingDaemonClient endpoint", async () => {
  const cwd = "/workspace/assurance";
  const workUnitId = "work-unit-assurance-001";
  const runId = "run-assurance-001";
  const observedAt = "2026-11-10T08:00:00.000Z";
  const calls: CapturedRequest[] = [];
  const body = {
    schemaVersion: 1,
    cwd,
    workUnitId,
    runId,
    status: "available",
    observedAt,
    items: [],
    projectionCheckpoints: ["continuation", "tool_execution", "evaluation", "delegation"].map(domain => ({
      domain,
      generation: 1,
      sourceEpoch: 1,
      builtEpoch: 1,
      state: "ready",
      rowCount: 0,
      isCurrent: true,
      updatedAt: observedAt,
    })),
  };
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    computerUseRouteToken: "TOKEN_SENTINEL",
    fetch: async (input: FetchInput, init: FetchInit) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json(body);
    },
  });

  const report = await readHarnessDiagnosticsReportFromClient({
    client,
    cwd,
    workUnitId,
    runId,
    limit: 100,
  });

  assert.equal(report.status, "available");
  assert.equal(report.pageCount, 1);
  assert.equal(report.items.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, `/work-units/${workUnitId}/harness`);
  assert.equal(calls[0].url.searchParams.get("cwd"), cwd);
  assert.equal(calls[0].url.searchParams.get("limit"), "100");
  assert.equal(calls[0].url.searchParams.get("cursor"), null);
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.body, undefined);
  assert.ok(!JSON.stringify(calls).includes("TOKEN_SENTINEL"));
  assert.ok(!JSON.stringify(report).includes(cwd));
});
