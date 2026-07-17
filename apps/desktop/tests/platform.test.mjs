import assert from "node:assert/strict";
import test from "node:test";
import { desktopPlatform } from "../dist/main/platform.js";

test("desktopPlatform normalizes supported operating systems", () => {
  assert.equal(desktopPlatform("darwin"), "macos");
  assert.equal(desktopPlatform("win32"), "windows");
  assert.equal(desktopPlatform("linux"), "linux");
});
