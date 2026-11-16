import assert from "node:assert/strict";
import test from "node:test";
import { DESKTOP_BROWSER_PROTOCOL, type DesktopBrowserState, type DesktopBrowserOperation } from "@ling-stack/contracts";
import { BrowserExecutionError, DesktopBrowserController } from "../dist/features/desktop-browser/controller.js";

const scope = { surface: "normal_conversation" as const, ownerId: "conversation-a" };
const authority = { desktopInstanceId: "desktop-a", generation: 1 };
function state(overrides: Partial<DesktopBrowserState> = {}): DesktopBrowserState {
  return { protocol: DESKTOP_BROWSER_PROTOCOL, ...authority, revision: 1, workspaceCwd: "/workspace", tabs: [{
    id: "tab-a", scope, url: "http://localhost:3000/", title: "Preview", navigationRevision: 2,
    loading: false, canGoBack: false, canGoForward: false, control: "agent",
  }], ...overrides };
}
const click: DesktopBrowserOperation = { method: "browser_click", params: { tabId: "tab-a", navigationRevision: 2, snapshotRevision: "snapshot-a", ref: "e1" } };
const signal = (): AbortSignal => new AbortController().signal;

test("browser controller binds scope, page revision and runtime before queueing", async t => {
  const controller = new DesktopBrowserController("/workspace"); t.after(() => controller.close()); controller.publish(state());
  for (const input of [ { scope: { ...scope, ownerId: "other" }, operation: click },
    { scope, operation: { ...click, params: { ...click.params, navigationRevision: 1 } } } ]) {
    await assert.rejects(controller.execute({ ...input, runId: "r", toolCallId: "c" }), /browser_target_stale_or_forbidden/u);
  }
  assert.throws(() => controller.publish(state({ workspaceCwd: "/other" })), /browser_authority_invalid/u);
});

test("browser command is claimed once and cannot start after cancellation", async t => {
  const controller = new DesktopBrowserController("/workspace"); t.after(() => controller.close()); controller.publish(state());
  const abort = new AbortController();
  const execution = controller.execute({ operation: click, scope, runId: "r", toolCallId: "c", signal: abort.signal });
  const command = await controller.claim(authority, signal()); assert.ok(command);
  abort.abort();
  await assert.rejects(execution, error => error instanceof BrowserExecutionError && error.effect === "none");
  assert.throws(() => controller.start(authority, command.id), /browser_command_not_current/u);
  await assert.rejects(controller.execute({ operation: click, scope, runId: "r", toolCallId: "c" }), /browser_cancelled/u);
});

test("started side effects remain unknown on cancellation and late results are rejected", async t => {
  const controller = new DesktopBrowserController("/workspace"); t.after(() => controller.close()); controller.publish(state());
  const abort = new AbortController();
  const execution = controller.execute({ operation: click, scope, runId: "r", toolCallId: "c", signal: abort.signal });
  const command = await controller.claim(authority, signal()); assert.ok(command); controller.start(authority, command.id);
  const cancelled = controller.waitForCancellation(authority, command.id, signal()); abort.abort();
  assert.equal(await cancelled, true);
  await assert.rejects(execution, error => error instanceof BrowserExecutionError && error.effect === "unknown");
  assert.throws(() => controller.complete(authority, { protocol: DESKTOP_BROWSER_PROTOCOL, id: command.id, ok: true, effect: "completed", result: {} }), /browser_command_not_current/u);
});

test("completed and failed command identities are never automatically replayed", async t => {
  const controller = new DesktopBrowserController("/workspace"); t.after(() => controller.close()); controller.publish(state());
  const input = { operation: click, scope, runId: "r", toolCallId: "once" };
  const execution = controller.execute(input);
  const command = await controller.claim(authority, signal()); assert.ok(command); controller.start(authority, command.id);
  controller.complete(authority, { protocol: DESKTOP_BROWSER_PROTOCOL, id: command.id, ok: true, effect: "completed", result: { changed: 1 } });
  assert.deepEqual(await execution, { changed: 1 }); assert.deepEqual(await controller.execute(input), { changed: 1 });
  await assert.rejects(controller.execute({ ...input, operation: { method: "browser_tabs", params: {} } }), /browser_request_identity_mismatch/u);
});

test("out-of-order state cannot roll back navigation; authority replacement retires the old instance", async t => {
  const controller = new DesktopBrowserController("/workspace"); t.after(() => controller.close()); controller.publish(state());
  const execution = controller.execute({ operation: click, scope, runId: "r", toolCallId: "c" });
  controller.publish(state({ revision: 2, tabs: state().tabs.map(tab => ({ ...tab, navigationRevision: 3 })) }));
  await assert.rejects(execution, /browser_target_changed/u);
  controller.publish(state()); assert.equal(controller.snapshot().state?.tabs[0]?.navigationRevision, 3);
  controller.publish(state({ desktopInstanceId: "desktop-b" }));
  assert.throws(() => controller.publish(state({ generation: 100 })), /browser_authority_invalid/u);
});

test("runtime timeout after start reports unknown while an absent Desktop remains unavailable", async t => {
  const controller = new DesktopBrowserController("/workspace", { commandTimeoutMs: 20 }); t.after(() => controller.close());
  await assert.rejects(controller.execute({ operation: click, scope, runId: "r", toolCallId: "c" }), /browser_desktop_required/u);
  controller.publish(state());
  const execution = controller.execute({ operation: click, scope, runId: "r", toolCallId: "c" });
  const command = await controller.claim(authority, signal()); assert.ok(command); controller.start(authority, command.id);
  await assert.rejects(execution, error => error instanceof BrowserExecutionError && error.code === "browser_timeout" && error.effect === "unknown");
});
