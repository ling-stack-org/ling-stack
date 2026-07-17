import assert from "node:assert/strict";
import test from "node:test";
import { openDesktopOwnerWindow } from "../dist/main/owner-window.js";

test("Open task recreates a missing main window before showing and focusing it", async () => {
  const calls = [];
  let window;
  const opened = await openDesktopOwnerWindow({
    openMainWindow: async () => {
      calls.push("open");
      window = {
        isDestroyed: () => false,
        show: () => calls.push("show"),
        focus: () => calls.push("focus"),
      };
      return true;
    },
    getMainWindow: () => window,
  });

  assert.equal(opened, true);
  assert.deepEqual(calls, ["open", "show", "focus"]);
});

test("Open task fails safe when main-window recovery cannot produce a live window", async () => {
  assert.equal(await openDesktopOwnerWindow({
    openMainWindow: async () => false,
    getMainWindow: () => undefined,
  }), false);
  assert.equal(await openDesktopOwnerWindow({
    openMainWindow: async () => true,
    getMainWindow: () => ({
      isDestroyed: () => true,
      show: () => undefined,
      focus: () => undefined,
    }),
  }), false);
});
