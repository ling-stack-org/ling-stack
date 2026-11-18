import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ManagedWorktreeListResponse, WorktreeInitializationChallenge } from "@ling-stack/contracts";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { createManagedWorktreeBinding } from "../dist/features/channels/workspace.js";
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
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, ".ling-stack", "test-home");
  let daemon: ReturnType<typeof createDaemonServer> | undefined;
  t.after(async () => {
    try { await daemon?.stop(); }
    finally {
      if (previousHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousHome;
      await rm(cwd, { recursive: true, force: true });
    }
  });
  await ensureGitRepo(cwd);
  const store = createSqliteRunStore(cwd);
  const bridgeToken = randomUUID();
  store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false, environment: {
    enabled: true, setupScript: "printf initialized > setup-ran.txt", variables: { LING_FIXTURE_TOKEN: "fixture-value-private" }, timeoutSeconds: 10,
  } } }, new Date().toISOString());
  let storeOpens = 0;
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    desktopBridgeToken: bridgeToken,
    storeFactory: (selected) => { assert.equal(selected, cwd); storeOpens++; return store; },
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return { cwd, store, base, bridgeToken, storeOpens: () => storeOpens,
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
    const localText = await local.text();
    assert.equal(localText.includes("fixture-value-private"), false);
    assert.match(localText, /\[configured\]/u);
    assert.equal((await fetch(f.url(path))).status, 200, "Native requests may omit Origin");
  }
  assert.equal(f.storeOpens(), opens);
  assert.deepEqual(f.store.getWorkspaceSettings(), original);
});

test("redacted worktree settings preserve existing values on a browser round trip", async t => {
  const f = await fixture(t);
  const response = await fetch(f.url("/workspace-settings"));
  assert.equal(response.status, 200);
  const payload = await response.json() as { settings: { worktreePolicy: { environment: { variables: Record<string, string> } } } };
  assert.deepEqual(payload.settings.worktreePolicy.environment.variables, { LING_FIXTURE_TOKEN: "[configured]" });
  const update = await fetch(f.url("/workspace-settings"), { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worktreePolicy: { fetchBeforeCreate: false, environment: {
      enabled: true, setupScript: "printf initialized > setup-ran.txt", variables: { LING_FIXTURE_TOKEN: "[configured]" }, timeoutSeconds: 10,
    } } }) });
  assert.equal(update.status, 200);
  assert.equal(f.store.getWorkspaceSettings().worktreePolicy?.environment?.variables.LING_FIXTURE_TOKEN, "fixture-value-private");
});

test("setup requires the Desktop bridge and a single confirmed challenge", async t => {
  const f = await fixture(t);
  const now = new Date().toISOString();
  const channel = f.store.createChannel({ name: "Setup fixture", boundPath: f.cwd }, now);
  const managed = await createManagedWorktreeBinding(channel, f.cwd, f.store.paths, undefined, f.store.getWorkspaceSettings().worktreePolicy, f.store);
  assert.ok(managed.ok);
  f.store.updateChannel(channel.id, { workspaceBinding: managed.binding }, now);
  const outputFile = join(managed.binding.worktreePath!, "setup-ran.txt");
  const owner = { ownerKind: "channel", ownerId: channel.id };
  const desktop = { "x-ling-desktop-bridge-token": f.bridgeToken };
  const post = (path: string, body: object, headers: Record<string, string> = {}) => fetch(f.url(path), {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const prepare = "/worktrees/initialization/prepare";
  const complete = "/worktrees/initialization/complete";
  assert.equal((await post(prepare, owner)).status, 403);
  assert.equal((await post(prepare, owner, { ...desktop, Origin: "http://localhost:4310" })).status, 403);
  const publicAction = await post("/worktrees/actions", { ...owner, action: "initialize", confirmed: true });
  assert.equal(publicAction.status, 409);
  assert.equal((await publicAction.json() as { error: string }).error, "worktree_desktop_confirmation_required");
  await assert.rejects(access(outputFile));

  async function requestChallenge() {
    const response = await post(prepare, owner, desktop);
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assert.equal(serialized.includes("fixture-value-private"), false);
    const challenge = JSON.parse(serialized) as WorktreeInitializationChallenge;
    assert.equal(challenge.environment?.setupScript, "printf initialized > setup-ran.txt");
    assert.deepEqual(challenge.environment?.variableNames, ["LING_FIXTURE_TOKEN"]);
    return challenge.challengeId;
  }
  const cancelled = await requestChallenge();
  assert.equal((await post(complete, { challengeId: cancelled, confirmed: false }, desktop)).status, 204);
  assert.equal((await post(complete, { challengeId: cancelled, confirmed: true }, desktop)).status, 409);
  await assert.rejects(access(outputFile));

  const approved = await requestChallenge();
  const result = await post(complete, { challengeId: approved, confirmed: true }, desktop);
  assert.equal(result.status, 200);
  const data = await result.json() as ManagedWorktreeListResponse;
  const initialization = data.entries[0]?.initialization;
  assert.equal(initialization?.status, "succeeded");
  assert.ok(initialization.completedAt);
  assert.deepEqual(Object.keys(initialization).sort(), ["completedAt", "output", "status"]);
  assert.equal(await readFile(outputFile, "utf8"), "initialized");
  assert.equal((await post(complete, { challengeId: approved, confirmed: true }, desktop)).status, 409);
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

  const untrustedCwd = join(tmpdir(), "ling-untrusted-workspace");
  for (const [path, method, body] of [
    ["/companions", "POST", {}],
    ["/companions/unknown/messages", "POST", { body: "should be rejected" }],
    ["/teammates/teammate_builtin_engineer/direct-workspace/refresh", "POST", {}],
  ] as const) {
    const response = await browserRequest(f.url(path, untrustedCwd), {
      method,
      headers: { Origin: "http://localhost:4310", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal(f.storeOpens(), opens);
});
