import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient, LingDaemonError } from "../dist/index.js";

test("assessment requests encode workspace/identities and preserve snapshot-bound triage", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    computerUseRouteToken: "TOKEN_SENTINEL",
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json({});
    },
  });
  const cwd = "/workspace/中文 project";
  const id = "assessment / 1";
  await client.listCodeAssessments(cwd, "security", 25);
  await client.getCodeAssessment(cwd, id);
  const create = { kind: "security" as const, target: { type: "branch" as const, baseRef: "origin/main" }, providerPresetId: "provider" };
  await client.createCodeAssessment(cwd, create);
  await client.cancelCodeAssessment(cwd, id);
  await client.checkCodeAssessmentFreshness(cwd, id);
  const triage = { snapshotDigest: "digest", disposition: "dismissed" as const, reason: "Expected change" };
  await client.setCodeFindingDisposition(cwd, id, "finding / 1", triage);
  assert.deepEqual(calls.map(call => call.init?.method), ["GET", "GET", "POST", "POST", "POST", "POST"]);
  assert.ok(calls.every(call => call.url.searchParams.get("cwd") === cwd));
  assert.equal(calls[0]!.url.searchParams.get("kind"), "security");
  assert.equal(calls[0]!.url.searchParams.get("offset"), "25");
  const path = `/workspace/code-assessments/${encodeURIComponent(id)}`;
  assert.deepEqual(calls.map(call => call.url.pathname), [
    "/workspace/code-assessments", path, "/workspace/code-assessments", `${path}/cancel`, `${path}/freshness`, `${path}/findings/finding%20%2F%201`,
  ]);
  assert.deepEqual(JSON.parse(String(calls[2]!.init?.body)), create);
  assert.deepEqual(JSON.parse(String(calls[5]!.init?.body)), triage);
  assert.ok(!JSON.stringify(calls).includes("TOKEN_SENTINEL"));
});

test("assessment conflicts remain structured client errors", async () => {
  const client = new LingDaemonClient({ fetch: async () => Response.json({ error: "snapshot_changed", message: "Snapshot does not match" }, { status: 409 }) });
  await assert.rejects(client.setCodeFindingDisposition("/repo", "assessment", "finding", { snapshotDigest: "old", disposition: "open" }),
    error => error instanceof LingDaemonError && error.status === 409 && error.code === "snapshot_changed");
});

test("assessment history transports combined filters without losing pagination", async () => {
  let requested: URL | undefined;
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async input => {
    requested = new URL(String(input)); return Response.json({ assessments: [], total: 0 });
  } });
  const filters = { kind: "review" as const, targetType: "commit" as const, snapshotDigest: "a".repeat(64), status: "partial" as const,
    severity: "info" as const, confidence: "low" as const, updatedAfter: "2026-11-16T00:00:00.000Z", updatedBefore: "2026-11-17T00:00:00.000Z", limit: 10, offset: 20 };
  assert.deepEqual(await client.listCodeAssessments("/project", filters), { assessments: [], total: 0 });
  assert.ok(requested);
  for (const [key, value] of Object.entries(filters)) assert.equal(requested.searchParams.get(key), String(value));
  assert.equal(requested.searchParams.get("cwd"), "/project");
});
