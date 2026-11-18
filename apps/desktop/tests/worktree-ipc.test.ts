import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from "electron";
import type { ManagedWorktreeListResponse, WorktreeInitializationChallenge } from "@ling-stack/contracts";
import { registerWorktreeIpc } from "../dist/main/worktrees/ipc.js";
import { DESKTOP_IPC_CHANNELS } from "../dist/shared/ipc-channels.js";

const request = { cwd: resolve("worktree-fixture"), ownerKind: "channel", ownerId: "channel_engineering", locale: "en-US" } as const;
const challenge: WorktreeInitializationChallenge = {
  challengeId: "fixture-challenge", expiresAt: "2026-11-18T00:02:00.000Z", ownerName: "Engineering",
  path: resolve(request.cwd, "tree"), environment: {
    enabled: true, setupScript: "printf ready > setup.txt", timeoutSeconds: 20, variableNames: ["BUILD_MODE"],
  },
};
const inventory: ManagedWorktreeListResponse = {
  cwd: request.cwd, policy: { fetchBeforeCreate: false }, defaultRootDir: request.cwd, effectiveRootDir: request.cwd, entries: [], limitReached: false,
};

function fixture(choose: (frame: { url: string }, options: MessageBoxOptions) => Promise<number>) {
  const trustedDocumentUrl = "file:///fixture/Ling/web/index.html";
  const frame = { url: trustedDocumentUrl, detached: false };
  const sender = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
  const calls: unknown[][] = [];
  const dispose = registerWorktreeIpc({
    ipcMain: { handle: (id, handler) => { handlers.set(id, handler); }, removeHandler: (id) => { handlers.delete(id); } },
    getMainWindow: () => window, trustedDocumentUrl,
    client: {
      async prepare(input) { calls.push(["prepare", input]); return challenge; },
      async complete(cwd, id, confirmed) { calls.push(["complete", cwd, id, confirmed]); return confirmed ? inventory : undefined; },
    },
    async showConfirmation(parent, options) {
      assert.equal(parent, window);
      calls.push(["dialog"]);
      return { response: await choose(frame, options) };
    },
  });
  return { calls, frame, event, dispose, handlers,
    invoke: (input: unknown = request, senderEvent = event) => handlers.get(DESKTOP_IPC_CHANNELS.worktreeInitialize)!(senderEvent, input) as Promise<unknown> };
}

test("setup displays the prepared script and cancels by default", async () => {
  const f = fixture(async (_frame, dialog) => {
    assert.equal(dialog.message, "Run the setup script for Engineering?");
    assert.ok(dialog.detail?.includes(challenge.path));
    assert.match(dialog.detail ?? "", /printf ready > setup\.txt/);
    assert.match(dialog.detail ?? "", /Environment variables: BUILD_MODE/);
    assert.match(dialog.detail ?? "", /Timeout: 20s/);
    assert.deepEqual(dialog.buttons, ["Cancel", "Run script"]);
    assert.equal(dialog.defaultId, 0);
    assert.equal(dialog.cancelId, 0);
    return dialog.defaultId;
  });
  assert.equal(await f.invoke(), undefined);
  assert.deepEqual(f.calls, [["prepare", request], ["dialog"], ["complete", request.cwd, challenge.challengeId, false]]);
  f.dispose();
  assert.equal(f.handlers.size, 0);
});

test("only a confirmation in the trusted window completes setup", async () => {
  const f = fixture(async () => 1);
  await assert.rejects(f.invoke(request, { ...f.event, senderFrame: null }), /worktree_ipc_forbidden/);
  f.frame.url = "file:///fixture/untrusted/index.html";
  await assert.rejects(f.invoke(), /worktree_ipc_forbidden/);
  f.frame.url = "file:///fixture/Ling/web/index.html";
  await assert.rejects(f.invoke({ ...request, confirmed: true }), /worktree_request_invalid/);
  assert.deepEqual(f.calls, []);

  assert.deepEqual(await f.invoke(), inventory);
  assert.deepEqual(f.calls, [["prepare", request], ["dialog"], ["complete", request.cwd, challenge.challengeId, true]]);
});

test("navigation during the confirmation cancels the challenge", async () => {
  const f = fixture(async (frame) => {
    frame.url = "file:///fixture/other/index.html";
    return 1;
  });
  await assert.rejects(f.invoke(), /worktree_ipc_forbidden/);
  assert.deepEqual(f.calls, [["prepare", request], ["dialog"], ["complete", request.cwd, challenge.challengeId, false]]);
});
