import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";

// Preload for existing neighbor tests that construct default Daemons. The tests
// keep their production composition; this explicitly refuses system Keychain
// access and confines home discovery to this run's owned directory. It is not
// evidence of native Keychain, browser Host installation, or packaged custody.
for (const name of ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"]) {
  const path = process.env[name];
  assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
  assert.ok(statSync(path).isDirectory());
}
const actualExec = childProcess.execFileSync;
childProcess.execFileSync = function (file, ...args) {
  if (file === "/usr/bin/security") throw new Error("A01 isolated neighbors refuse system Keychain access");
  return actualExec.call(this, file, ...args);
};
os.homedir = () => process.env.LING_STACK_HOME;
syncBuiltinESMExports();
