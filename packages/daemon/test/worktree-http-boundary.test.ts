import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";
import { ensureGitRepo } from "./git-test-helpers.mjs";

const foreignHeaders: readonly Record<string, string>[] = [
  { Origin: "https://foreign.invalid" },
  { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" },
  { "Sec-Fetch-Mode": "navigate" },
];

function browserRequest(url: string, input: { method: string; headers: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; text: () => Promise<string> }>((resolve, reject) => {
    const request = requestHttp(url, { method: input.method, headers: input.headers, signal: AbortSignal.timeout(10000) }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(input.body);
  });
}

async function fixture(t: TestContext) {
  const cwd = await createSqliteWorkspaceFixture(join(tmpdir(), "ling-worktree-http-boundary-"));
  await ensureGitRepo(cwd);
  const store = createSqliteRunStore(cwd);
  store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false, environment: {
    enabled: true, setupScript: "printf initialized > setup-ran.txt", variables: { LING_FIXTURE_TOKEN: "fixture-value-private" }, timeoutSeconds: 10,
  } } }, new Date().toISOString());
  let storeOpens = 0;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    storeFactory: (selected) => { assert.equal(selected, cwd); storeOpens++; return store; },
  });
  await daemon.start();
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return { cwd, store, base, storeOpens: () => storeOpens,
    url: (path: string, selected = cwd) => `${base}${path}?cwd=${encodeURIComponent(selected)}` };
}

test("workspace settings protect environment values on reads and unrelated updates", async t => {
  const f = await fixture(t);
  const original = f.store.getWorkspaceSettings();
  const opens = f.storeOpens();
  for (const headers of foreignHeaders) for (const [path, method, body] of [
    ["/workspace-settings", "GET", undefined],
    ["/workspace-settings", "PATCH", { theme: "dark" }],
    ["/config/effective", "GET", undefined],
  ] as const) {
    const response = await browserRequest(f.url(path), { method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.text()).includes("fixture-value-private"), false);
  }
  for (const path of ["/workspace-settings", "/config/effective"]) {
    assert.equal((await fetch(f.url(path, join(tmpdir(), "ling-unselected-workspace")))).status, 403);
    const local = await fetch(f.url(path), { headers: { Origin: "http://localhost:4310" } });
    assert.equal(local.status, 200);
    assert.ok((await local.text()).includes("fixture-value-private"));
    assert.equal((await fetch(f.url(path))).status, 200, "Native requests may omit Origin");
  }
  assert.equal(f.storeOpens(), opens);
  assert.deepEqual(f.store.getWorkspaceSettings(), original);
});

test("foreign conversation requests cannot initialize worktrees or schedule continuations", async t => {
  const f = await fixture(t);
  const opens = f.storeOpens();
  const threads = f.store.listTeammateDirectThreads();
  const worktrees = await readdir(f.store.paths.worktreesDir);
  const privateBase = "/teammates/teammate_builtin_engineer";
  const routes: readonly (readonly [string, string, object | undefined])[] = [
    [`${privateBase}/direct-messages`, "POST", { body: "Initialize workspace", requestAiReply: true }],
    [`${privateBase}/direct-messages/stream`, "POST", { body: "Initialize workspace" }],
    [`${privateBase}/direct-runtime`, "GET", undefined],
    [`${privateBase}/direct-interventions`, "POST", {}],
    ["/teammate-direct-interventions/unknown/promote", "POST", {}],
    ["/conversation-message-edits", "POST", {}],
    ["/companions", "POST", {}],
    ["/companions/unknown/messages", "POST", { body: "Initialize workspace" }],
    ["/companions/unknown/messages/stream", "POST", { body: "Initialize workspace" }],
    ["/companions/unknown/proactive", "POST", {}],
  ];
  for (const headers of foreignHeaders) for (const [path, method, body] of routes) {
    const response = await browserRequest(f.url(path), { method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 403, `${method} ${path}: ${await response.text()}`);
  }
  assert.equal(f.storeOpens(), opens);
  assert.deepEqual(f.store.listTeammateDirectThreads(), threads);
  assert.deepEqual(await readdir(f.store.paths.worktreesDir), worktrees);
  const local = await fetch(f.url(`${privateBase}/direct-runtime`), { headers: { Origin: "http://localhost:4310" } });
  assert.equal(local.status, 200);
  assert.equal((await fetch(f.url(`${privateBase}/direct-runtime`))).status, 200, "Native continuation requests remain supported");
});
