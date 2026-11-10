import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
    run: (command, args, options) => { commands.push({ command, args, options }); },
  });

  assert.equal(commands.some(({ args }) => args[0] === "scripts/build-native.mjs"), false);
  assert.equal(commands.some(({ args }) => args[0] === "--test"), true);
  assert.equal(commands.some(({ command }) => command === (process.env.CARGO ?? "cargo")), true);
  for (const { options } of commands) {
    const home = options.env.LING_STACK_HOME;
    const workspace = options.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    for (const path of [home, workspace]) {
      assert.ok(isAbsolute(path));
      assert.notEqual(resolve(path), process.cwd());
      await assert.rejects(access(path), { code: "ENOENT" });
    }
    assert.notEqual(home, workspace);
  }
});

test("the Host test runner removes isolated state after a command failure", async () => {
  let paths;
  await assert.rejects(runBrowserHostTests({
    platform: "linux",
    arch: "x64",
    run: (_command, _args, options) => {
      paths = [options.env.LING_STACK_HOME, options.env.LING_STACK_DEFAULT_WORKSPACE_CWD];
      throw new Error("owned fixture failure");
    },
  }), /owned fixture failure/u);

  assert.equal(paths.length, 2);
  for (const path of paths) await assert.rejects(access(path), { code: "ENOENT" });
});
