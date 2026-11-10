import assert from "node:assert/strict";
import test from "node:test";
import { compilerInputPath, SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER } from "./verify-shared-command-closure.mjs";

test("Windows compiler inputs become canonical bundle paths without rejecting native separators", () => {
  const rootPath = "C:\\Ling resources\\runtime";
  for (const inputPath of ["C:\\Ling resources\\runtime\\test\\helpers\\benchmark-runner.ts",
    "test\\helpers\\benchmark-runner.ts", "test/helpers/benchmark-runner.ts"]) {
    assert.equal(compilerInputPath({ rootPath, inputPath, platform: "win32" }), "test/helpers/benchmark-runner.ts");
  }
  assert.equal(compilerInputPath({ rootPath, inputPath: "c:\\Ling resources\\runtime\\bin\\gstack-model-benchmark", platform: "win32" }), "bin/gstack-model-benchmark");
  assert.equal(compilerInputPath({ rootPath: "\\\\server\\share\\runtime", inputPath: "\\\\server\\share\\runtime\\lib\\helper.ts", platform: "win32" }), "lib/helper.ts");
});

test("compiler path normalization rejects escapes, foreign drives, drive-relative paths and streams", () => {
  const rootPath = "C:\\Ling resources\\runtime";
  for (const inputPath of ["C:\\private\\secret.ts", "D:\\runtime\\lib\\helper.ts", "C:helper.ts",
    "..\\secret.ts", "lib\\..\\secret.ts", "lib\\helper.ts:private", "", "lib\\\\helper.ts", "lib\\.\\helper.ts", "lib\0helper.ts"]) {
    assert.throws(() => compilerInputPath({ rootPath, inputPath, platform: "win32" }), /gstack_shared_command_graph_path_invalid/);
  }
});

test("POSIX compiler inputs retain their paths and reject Windows path syntax", () => {
  const rootPath = "/Ling resources/runtime";
  assert.equal(compilerInputPath({ rootPath, inputPath: "/Ling resources/runtime/lib/helper.ts", platform: "darwin" }), "lib/helper.ts");
  assert.equal(compilerInputPath({ rootPath, inputPath: "lib/helper.ts", platform: "darwin" }), "lib/helper.ts");
  for (const inputPath of ["/private/secret.ts", "../secret.ts", "lib/../secret.ts", "lib//helper.ts",
    "C:\\private\\secret.ts", "C:helper.ts", "lib\\helper.ts"]) {
    assert.throws(() => compilerInputPath({ rootPath, inputPath, platform: "darwin" }), /gstack_shared_command_graph_path_invalid/);
  }
});

test("the extensionless TypeScript loader matches both native platform path formats", () => {
  assert.ok(SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER.test("/Ling resources/runtime/bin/gstack-model-benchmark"));
  assert.ok(SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER.test("C:\\Ling resources\\runtime\\bin\\gstack-model-benchmark"));
  assert.ok(SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER.test("/Ling resources/runtime/bin/gstack-claude-code"));
  assert.ok(SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER.test("C:\\Ling resources\\runtime\\bin\\gstack-claude-code"));
  assert.ok(SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER.test("/Ling resources/runtime/bin/gstack-new-command"));
  assert.ok(SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER.test("C:\\Ling resources\\runtime\\bin\\gstack-new-command"));
  assert.equal(SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER.test("/Ling resources/runtime/bin/gstack-new-command.sh"), false);
  assert.equal(SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER.test("/Ling resources/runtime/lib/gstack-new-command"), false);
});
