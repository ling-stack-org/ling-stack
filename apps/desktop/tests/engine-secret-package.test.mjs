import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("desktop includes the bounded secret worker and pins the OS binding separately from the daemon", async () => {
  assert.equal(packageJson.dependencies["@napi-rs/keyring"], "2.1.2");
  assert.ok(packageJson.scripts.build.includes("pnpm build:engine-secret-worker"));
  assert.ok(packageJson.scripts["build:engine-secret-worker"].includes("--external:@napi-rs/keyring"));
  const worker = await readFile(new URL("../dist/daemon/engine-secret-worker.js", import.meta.url), "utf8");
  assert.match(worker, /import\("@napi-rs\/keyring"\)/);
  assert.doesNotMatch(worker, /node:child_process/);
});

test("native keyring bindings are explicitly unpacked for platform loading", () => {
  assert.ok(packageJson.build.asarUnpack?.includes("**/node_modules/@napi-rs/keyring*/**/*.node"));
});
