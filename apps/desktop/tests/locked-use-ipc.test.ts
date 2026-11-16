import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { registerLockedControlIpc } from "../dist/main/locked-computer-control/ipc.js";
import { DESKTOP_IPC_CHANNELS } from "../dist/shared/ipc-channels.js";
import { deferred } from "./locked-use-fixtures.ts";

function fixture() {
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
  const calls: string[] = [];
  const trustedDocumentUrl = "file:///Applications/Ling.app/Contents/Resources/web/index.html";
  const frame = { url: trustedDocumentUrl, detached: false };
  const owner = { id: 11, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const window = { webContents: owner, isDestroyed: () => false };
  const runtime = {
    async authorizeLockedComputerControl() { calls.push("authorize"); return { accepted: false, reason: "locked_control_disabled_by_build" }; },
    async revokeLockedComputerControl() { calls.push("revoke"); return { accepted: true }; },
  };
  const event = { sender: owner, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const unregister = registerLockedControlIpc({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    runtime, getMainWindow: () => window as unknown as BrowserWindow, trustedDocumentUrl,
  });
  return { runtime, calls, frame, event, handlers, unregister,
    async invoke(channel: string, input = event, ...args: unknown[]) { return handlers.get(channel)!(input, ...args); } };
}

test("locked IPC forwards explicit commands without promoting disabled capability", async () => {
  const fx = fixture();
  assert.deepEqual(await fx.invoke(DESKTOP_IPC_CHANNELS.computerControlLockedAuthorize), {
    accepted: false, reason: "locked_control_disabled_by_build",
  });
  assert.deepEqual(await fx.invoke(DESKTOP_IPC_CHANNELS.computerControlLockedRevoke), { accepted: true });
  assert.deepEqual(fx.calls, ["authorize", "revoke"]);
  fx.unregister();
  assert.equal(fx.handlers.size, 0);
});

test("locked IPC denies preview, subframe, detached, remote and argument-bearing requests", async () => {
  const fx = fixture();
  const preview = { ...fx.event, sender: { ...fx.event.sender } } as IpcMainInvokeEvent;
  const subframe = { ...fx.event, senderFrame: { ...fx.frame } } as unknown as IpcMainInvokeEvent;
  for (const channel of [DESKTOP_IPC_CHANNELS.computerControlLockedAuthorize, DESKTOP_IPC_CHANNELS.computerControlLockedRevoke]) {
    for (const event of [preview, subframe, { ...fx.event, senderFrame: null }]) {
      assert.deepEqual(await fx.invoke(channel, event), { accepted: false, reason: "unauthorized_sender" });
    }
    assert.deepEqual(await fx.invoke(channel, fx.event, { grantId: "forged" }), { accepted: false, reason: "unauthorized_sender" });
    fx.frame.detached = true;
    assert.equal((await fx.invoke(channel)).accepted, false);
    fx.frame.detached = false;
    fx.frame.url = "https://example.org/";
    assert.equal((await fx.invoke(channel)).accepted, false);
    fx.frame.url = "file:///tmp/index.html";
    assert.equal((await fx.invoke(channel)).accepted, false);
    fx.frame.url = "file:///Applications/Ling.app/Contents/Resources/web/index.html";
  }
  assert.deepEqual(fx.calls, []);
  fx.unregister();
});

test("navigation during local verification revokes before returning authorization", async () => {
  const fx = fixture();
  const verifying = deferred();
  const release = deferred();
  fx.runtime.authorizeLockedComputerControl = async () => {
    verifying.resolve(); await release.promise;
    return { accepted: true, reason: "" };
  };
  const result = fx.invoke(DESKTOP_IPC_CHANNELS.computerControlLockedAuthorize);
  await verifying.promise;
  fx.frame.url = "https://example.org/";
  release.resolve();
  assert.deepEqual(await result, { accepted: false, reason: "unauthorized_sender" });
  assert.deepEqual(fx.calls, ["revoke"]);
  fx.unregister();
});
