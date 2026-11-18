import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createSqliteRunStore, type ExternalSourceKind, type ExternalWorkImportResponse,
  type ExternalWorkPollResponse, type ExternalWorkReconcileResponse, type SecretPurpose, type SecretResolver } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

const now = "2026-11-16T00:00:00.000Z";
const githubIssue = { id: 7, number: 7, title: "Review work", state: "open", updated_at: now };
const linearIssue = { id: "lin-7", identifier: "LIN-7", title: "Review work", state: "open", project: { slug: "project" }, updatedAt: now };

function markdown(kind: ExternalSourceKind): string {
  return `---
source:
  kind: ${kind}
  ${kind === "github" ? "repository: owner/repo" : "projectSlug: project"}
  events: [issue.${kind === "github" ? "opened" : "created"}]
  secretRef: env:FIXTURE_SOURCE_TOKEN
---
Review {{ item.identifier }}.
`;
}

async function fixture(t: TestContext) {
  const cwd = mkdtempSync(resolve(tmpdir(), "ling-daemon-registry-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "External", boundPath: cwd }, now);
  const secretCalls: { ref: string; purpose?: SecretPurpose; operation: string }[] = [];
  const fetchCalls: { url: string; method?: string }[] = [];
  const resolver: SecretResolver = {
    resolve(ref, purpose) {
      secretCalls.push({ ref, purpose, operation: "resolve" });
      return { ref, configured: true, value: "fixture-token" };
    },
    status(ref, purpose) {
      secretCalls.push({ ref, purpose, operation: "status" });
      return { ref, kind: "env", configured: true };
    },
  };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    runner: { async runTask() { assert.fail("external reads must not start a runner"); } },
    storeFactory: (requestedCwd) => { assert.equal(requestedCwd, cwd); return store; },
    secretResolver: resolver,
    externalWorkFetch: async (input, init) => {
      const url = String(input);
      fetchCalls.push({ url, method: init?.method });
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
      if (url === "https://api.linear.app/graphql") return Response.json({ data: { issues: { nodes: [linearIssue] } } });
      if (url.includes("/issues?")) return Response.json([githubIssue]);
      if (url.endsWith("/issues/7")) return Response.json({ ...githubIssue, state: "closed" });
      assert.fail(`unexpected source request: ${url}`);
    },
  });
  t.after(async () => { await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); });
  await daemon.start();
  secretCalls.length = 0;
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  function url(path: string) { return `${base}${path}?cwd=${encodeURIComponent(cwd)}`; }
  async function post<T>(path: string, body: unknown) {
    const response = await fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    assert.doesNotMatch(text, /fixture-token/);
    return { status: response.status, body: JSON.parse(text) as T };
  }
  return { cwd, store, channelId: channel.id, url, post, secretCalls, fetchCalls };
}

for (const kind of ["github", "linear"] as const) {
  test(`${kind} registered import preserves HTTP status, evidence and duplicate identity`, async (t) => {
    const f = await fixture(t);
    const input = { channelId: f.channelId, workflowMarkdown: markdown(kind),
      eventType: kind === "github" ? "issue.opened" : "issue.created", payload: kind === "github" ? githubIssue : linearIssue };
    const first = await f.post<ExternalWorkImportResponse>(`/external-work/${kind}/import`, input);
    assert.equal(first.status, 201);
    assert.equal(first.body.duplicate, false);
    assert.equal(first.body.workflow.status, "ready");
    assert.equal(first.body.workflowStep.status, "queued");
    assert.match(first.body.workflowStep.prompt, kind === "github" ? /owner\/repo#7/ : /LIN-7/);
    assert.equal(first.body.artifacts.length, 2);
    const duplicate = await f.post<ExternalWorkImportResponse>(`/external-work/${kind}/import`, input);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.workflow.id, first.body.workflow.id);
    assert.equal(duplicate.body.workflowStep.id, first.body.workflowStep.id);
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    assert.deepEqual([...duplicate.body.artifacts].sort(byId), [...first.body.artifacts].sort(byId));
    assert.equal(f.store.listExternalWorkRecords().length, 1);
    assert.deepEqual(f.secretCalls, []); assert.deepEqual(f.fetchCalls, []);

    const mismatch = await f.post<{ error: string; message: string }>(`/external-work/${kind}/import`, {
      ...input, workflowMarkdown: markdown(kind === "github" ? "linear" : "github"),
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, "unsupported_source");
    assert.match(mismatch.body.message, /Unsupported external source kind/);
    assert.equal(f.store.listExternalWorkRecords().length, 1);
  });

  test(`${kind} poll, status and reconcile use the registered token purpose and remote capability`, async (t) => {
    const f = await fixture(t);
    writeFileSync(resolve(f.cwd, "WORKFLOW.md"), markdown(kind));
    const polled = await f.post<ExternalWorkPollResponse>(`/external-work/${kind}/poll`, { channelId: f.channelId });
    assert.equal(polled.status, 200); assert.equal(polled.body.claimed, 1);
    assert.equal(polled.body.schedulerStates[0].sourceKey, kind === "github" ? "github:owner/repo" : "linear:project");
    assert.deepEqual(f.secretCalls, [{ ref: "env:FIXTURE_SOURCE_TOKEN", purpose: `${kind}_token`, operation: "resolve" }]);
    assert.equal(f.fetchCalls.length, 1);
    assert.equal(f.fetchCalls[0].method, kind === "github" ? "GET" : "POST");
    const status = await fetch(`${f.url("/external-work/status")}&channelId=${f.channelId}`);
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.secret.purpose, `${kind}_token`);
    assert.equal(f.fetchCalls.length, 1, "status remains read-only");
    f.secretCalls.length = 0; f.fetchCalls.length = 0;
    const reconciled = await f.post<ExternalWorkReconcileResponse>("/external-work/reconcile", {
      channelId: f.channelId, workflowPath: "WORKFLOW.md",
    });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.checked, 1);
    assert.equal(reconciled.body.terminal, kind === "github" ? 1 : 0);
    if (kind === "github") {
      assert.deepEqual(f.secretCalls, [{ ref: "env:FIXTURE_SOURCE_TOKEN", purpose: "github_token", operation: "resolve" }]);
      assert.deepEqual(f.fetchCalls, [{ url: "https://api.github.com/repos/owner/repo/issues/7", method: "GET" }]);
    } else {
      assert.deepEqual(f.secretCalls, []); assert.deepEqual(f.fetchCalls, []);
    }
  });
}
