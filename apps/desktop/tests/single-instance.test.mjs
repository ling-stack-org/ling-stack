import assert from "node:assert/strict";
import test from "node:test";
import {
  establishDesktopSingleInstanceAuthority,
  focusExistingDesktopMainWindow,
} from "../dist/main/single-instance.js";

test("a secondary Desktop exits before primary startup can create services or windows", () => {
  let quitCount = 0;
  let startCount = 0;
  let handlerCount = 0;

  const authority = establishDesktopSingleInstanceAuthority({
    requestSingleInstanceLock: () => false,
    registerSecondInstanceHandler: () => {
      handlerCount += 1;
    },
    quitSecondaryInstance: () => {
      quitCount += 1;
    },
    startPrimaryInstance: () => {
      startCount += 1;
    },
    getMainWindow: () => undefined,
  });

  assert.equal(authority, "secondary");
  assert.equal(quitCount, 1);
  assert.equal(startCount, 0);
  assert.equal(handlerCount, 0);
});

test("the primary Desktop restores and focuses its existing window on a second launch", () => {
  const calls = [];
  const outcomes = [];
  let secondInstanceHandler;
  let startCount = 0;
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };

  const authority = establishDesktopSingleInstanceAuthority({
    requestSingleInstanceLock: () => true,
    registerSecondInstanceHandler: (listener) => {
      secondInstanceHandler = listener;
    },
    quitSecondaryInstance: () => {
      throw new Error("primary instance must not quit");
    },
    startPrimaryInstance: () => {
      startCount += 1;
    },
    getMainWindow: () => window,
    onSecondInstance: (focused) => outcomes.push(focused),
  });

  assert.equal(authority, "primary");
  assert.equal(startCount, 1);
  assert.equal(typeof secondInstanceHandler, "function");
  secondInstanceHandler();
  assert.deepEqual(calls, ["restore", "show", "focus"]);
  assert.deepEqual(outcomes, [true]);
});

test("a second launch never opens a replacement when the primary window is unavailable", () => {
  let secondInstanceHandler;
  let windowLookupCount = 0;
  const outcomes = [];
  establishDesktopSingleInstanceAuthority({
    requestSingleInstanceLock: () => true,
    registerSecondInstanceHandler: (listener) => {
      secondInstanceHandler = listener;
    },
    quitSecondaryInstance: () => undefined,
    startPrimaryInstance: () => undefined,
    getMainWindow: () => {
      windowLookupCount += 1;
      return undefined;
    },
    onSecondInstance: (focused) => outcomes.push(focused),
  });

  secondInstanceHandler();

  assert.equal(windowLookupCount, 1);
  assert.deepEqual(outcomes, [false]);
});

test("a second launch asks the primary process to recreate a closed main window", async () => {
  let secondInstanceHandler;
  let openCount = 0;
  const outcomes = [];
  establishDesktopSingleInstanceAuthority({
    requestSingleInstanceLock: () => true,
    registerSecondInstanceHandler: (listener) => {
      secondInstanceHandler = listener;
    },
    quitSecondaryInstance: () => undefined,
    startPrimaryInstance: () => undefined,
    getMainWindow: () => undefined,
    openMainWindow: async () => {
      openCount += 1;
      return true;
    },
    onSecondInstance: (focused) => outcomes.push(focused),
  });

  secondInstanceHandler();
  await Promise.resolve();

  assert.equal(openCount, 1);
  assert.deepEqual(outcomes, [true]);
});

test("second-instance focus is race-safe when the main window disappears", () => {
  const focused = focusExistingDesktopMainWindow({
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => undefined,
    show: () => {
      throw new Error("window destroyed");
    },
    focus: () => {
      throw new Error("must not be reached");
    },
  });

  assert.equal(focused, false);
});
