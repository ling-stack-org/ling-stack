import assert from "node:assert/strict";
import { test } from "node:test";
import { runBrowserHostTests, supportsNativeHostBuild } from "../scripts/test.mjs";

test("Native Host products build only on supported release platforms", () => {
  assert.equal(supportsNativeHostBuild("darwin", "arm64"), true);
  assert.equal(supportsNativeHostBuild("win32", "x64"), true);
  assert.equal(supportsNativeHostBuild("darwin", "x64"), false);
  assert.equal(supportsNativeHostBuild("linux", "x64"), false);
});

test("generic CI keeps platform-neutral Host tests without building a Linux product", async () => {
  const commands = [];
  await runBrowserHostTests({
    platform: "linux",
    arch: "x64",
    run: (command, args) => { commands.push([command, ...args]); },
  });

  assert.equal(commands.some(([, script]) => script === "scripts/build-native.mjs"), false);
  assert.equal(commands.some(([, mode]) => mode === "--test"), true);
  assert.equal(commands.some(([command]) => command === (process.env.CARGO ?? "cargo")), true);
});
