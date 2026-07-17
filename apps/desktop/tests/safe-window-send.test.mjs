import assert from "node:assert/strict";
import test from "node:test";
import { sendToLiveDesktopWindow } from "../dist/main/safe-window-send.js";

test("safe Desktop window send rejects destroyed targets and isolates send failures", () => {
  assert.equal(sendToLiveDesktopWindow(undefined, "channel", "value"), false);
  assert.equal(sendToLiveDesktopWindow(fakeWindow({ windowDestroyed: true }), "channel"), false);
  assert.equal(sendToLiveDesktopWindow(fakeWindow({ webContentsDestroyed: true }), "channel"), false);
  assert.equal(sendToLiveDesktopWindow(fakeWindow({ sendThrows: true }), "channel"), false);
});

test("safe Desktop window send forwards values to a live renderer", () => {
  const messages = [];
  const window = fakeWindow({ messages });
  assert.equal(sendToLiveDesktopWindow(window, "channel", { status: "ready" }), true);
  assert.deepEqual(messages, [{ channel: "channel", args: [{ status: "ready" }] }]);
});

function fakeWindow(options = {}) {
  return {
    isDestroyed: () => options.windowDestroyed === true,
    webContents: {
      isDestroyed: () => options.webContentsDestroyed === true,
      send: (channel, ...args) => {
        if (options.sendThrows) {
          throw new Error("renderer_destroyed");
        }
        options.messages?.push({ channel, args });
      },
    },
  };
}
