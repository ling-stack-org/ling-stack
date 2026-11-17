import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSqliteRunStore, type RunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

test("real daemon/Pi/Host execution freezes capabilities, queries code, approves a Hook command and persists nested evidence", { timeout: 30_000 }, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ling-agent-capability-integration-")));
  const cwd = join(base, "workspace"), userRoot = join(base, "user");
  await mkdir(cwd); await mkdir(userRoot);
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  let daemon: ReturnType<typeof createDaemonServer> | undefined;
  const source = 'import { greet } from "./a.js";\nexport const result = greet("test");\n';
  await writeFile(join(cwd, "a.ts"), "export function greet(value: string) { return value; }\n");
  await writeFile(join(cwd, "b.ts"), source);
  await writeFile(join(userRoot, "hooks.json"), JSON.stringify({ schemaVersion: 1, hooks: [
    { id: "semantic-policy", event: "before_tool", tools: ["code_intelligence"], kind: "script", code: 'return {decision:"allow"};' },
    { id: "completion-check", event: "run_end", kind: "command", timeoutMs: 20_000, failurePolicy: "block", command: "printf hook_ok > hook-result.txt" },
  ] }));
  const code = 'const r = await tools.code_intelligence({operation:"definition",path:"b.ts",line:2,column:23}); text(JSON.parse(r.content[0].text).items.map(x=>({path:x.path,name:x.name})));';
  const provider = await startLoopbackPiProvider((_body: unknown, index: number) => index === 1
    ? { tool: "code_mode", input: { code } } : { text: "Completed with verified code evidence." });
  t.after(async () => {
    try { await daemon?.stop(); await provider.close(); }
    finally { if (previousHome === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = previousHome;
      await rm(base, { force: true, recursive: true }); }
  });
  let store: RunStore | undefined;
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    harness: { toolBroker: { mode: "enforce" } },
    channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
  }, { storeFactory: root => { store = createSqliteRunStore(root); return store; },
    chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null });
  await daemon.start();
  const address = daemon.server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${url}/runs`, { method: "POST", headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(25_000), body: JSON.stringify({ cwd, workspaceCwd: cwd,
      task: { id: "capability-integration", title: "Code capabilities", prompt: "Find the greet definition and complete the task." },
      provider: { provider: "capability-local-transport", model: "static-tools", api: "openai-completions", baseUrl: provider.baseUrl,
        authHeader: false, reasoning: false },
      tools: ["read", "bash"], authorizationMode: "ask", workspaceAccessMode: "workspace_write", thinkingLevel: "off",
      createdByActor: "local-user", idempotencyKey: "capability-integration" }) });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  const stream = response.text();
  void stream.catch(() => undefined);
  const deadline = Date.now() + 15_000;
  let pending;
  while (Date.now() < deadline) {
    pending = store?.listApprovalRequests({ status: "pending", limit: 20 }).find(approval => approval.payload.type === "bash");
    if (pending) break;
    const run = store?.listRuns({ limit: 1 })[0];
    if (run && ["failed", "cancelled", "succeeded"].includes(run.status)) assert.fail(`Run settled before Hook approval: ${JSON.stringify(run)}\n${await stream}`);
    await delay(20);
  }
  assert.ok(pending, `Hook approval was not created: ${JSON.stringify(store?.listRuns({ limit: 2 }))}`);
  assert.equal(pending.payload.type, "bash");
  if (pending.payload.type === "bash") assert.match(pending.payload.command, /LING_HOOK_EVENT=.*run_end/s);
  const approved = await fetch(`${url}/approvals/${encodeURIComponent(pending.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Approve temporary integration fixture command" }),
  });
  assert.equal(approved.status, 200, await approved.text());
  const text = await stream;
  assert.ok(store);
  const run = store.listRuns({ limit: 1 })[0]; assert.equal(run.status, "succeeded", text);
  const events = store.listEvents(run.id);
  const nested = events.find(event => event.type === "tool_end" && event.data.toolName === "code_intelligence");
  assert.ok(nested?.type === "tool_end" && typeof nested.data.parentToolCallId === "string");
  assert.equal(nested.data.isError, false);
  assert.ok(events.some(event => event.type === "hook_execution" && event.data.hookId === "semantic-policy" && event.data.status === "succeeded"));
  assert.ok(events.some(event => event.type === "hook_execution" && event.data.hookId === "completion-check" && event.data.status === "succeeded"));
  assert.ok(events.some(event => event.type === "host_command_settled"), "Hook command uses the journaled Host executor");
  assert.equal(await readFile(join(cwd, "hook-result.txt"), "utf8"), "hook_ok");
  const snapshot = run.requestSnapshot as { runnerExecutionInput?: { input?: { initialToolSurface?: { codeMode?: boolean; codeIntelligence?: boolean }; hooks?: { digest: string } } } };
  assert.equal(snapshot.runnerExecutionInput?.input?.initialToolSurface?.codeMode, true);
  assert.equal(snapshot.runnerExecutionInput?.input?.initialToolSurface?.codeIntelligence, true);
  assert.match(snapshot.runnerExecutionInput?.input?.hooks?.digest ?? "", /^sha256:/);
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /greet/);
});
