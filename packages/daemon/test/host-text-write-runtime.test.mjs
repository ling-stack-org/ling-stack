import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ELECTRON_NODE_RESOURCE_PATHS, digestElectronNodeResource } from "../dist/runtime/sandbox/electron-node-resources.js";
import { prepareBoundedHostWrite } from "../dist/runtime/acp/host-text-write.js";

const native = { skip: process.platform !== "darwin", timeout: 30_000 };
const electronExecutable = process.env.LING_HOST_WRITE_TEST_ELECTRON;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-host-write-runtime-")));
  const data = join(root, "data");
  await mkdir(data, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(data, "note.txt") };
}

test("fixed inline worker runs in the real Node sandbox without a worker file or package lookup", native, async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const content = "Literal data: ` ${process.exit(9)} \\ and quoted text\n";
  const result = await prepareBoundedHostWrite(f.path, signal).write(content);
  result.assertUnchanged();
  assert.equal(await readFile(f.path, "utf8"), content);
  const nodePath = await realpath(process.execPath);
  assert.throws(() => prepareBoundedHostWrite(f.path, signal, undefined, {
    node: { path: nodePath, sha256: "0".repeat(64) },
  }), { outcome: "not_started" });
});

test("real Electron sandbox uses only supplied fixture runtime pins and rejects missing or changed pins", {
  ...native, skip: native.skip || !electronExecutable,
}, async t => {
  const f = await fixture(t), executable = await realpath(electronExecutable);
  const contents = dirname(dirname(executable));
  // Explicit opt-in mechanism fixture only. These observed pins are never
  // inserted into Daemon config, a review row, or a production Host issuer.
  const node = { path: executable, sha256: sha(readFileSync(executable)), runtime: {
    kind: "electron_node_v1", resources: ELECTRON_NODE_RESOURCE_PATHS.map(relativePath => ({ relativePath,
      sha256: digestElectronNodeResource(join(contents, relativePath)) })),
  } };
  const config = join(f.root, "fixture.json"), harness = join(f.root, "fixture.mjs");
  const module = new URL("../dist/runtime/acp/host-text-write.js", import.meta.url).href;
  const content = "Electron sandbox literal data: ${process.exit(9)}\n";
  await writeFile(config, JSON.stringify({ path: f.path, node, content }), { mode: 0o600 });
  await writeFile(harness, `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { prepareBoundedHostWrite } from ${JSON.stringify(module)};
const fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.ok(process.versions.electron);
const originalSpawn = childProcess.spawn, calls = [];
childProcess.spawn = (...args) => { calls.push(args); return originalSpawn(...args); };
syncBuiltinESMExports();
const signal = new AbortController().signal;
for (const node of [undefined, { ...fixture.node, sha256: "0".repeat(64) },
  { ...fixture.node, runtime: undefined }, { ...fixture.node, runtime: { ...fixture.node.runtime,
    resources: fixture.node.runtime.resources.map((item, index) => index === 0 ? { ...item, sha256: "0".repeat(64) } : item) } }]) {
  assert.throws(() => prepareBoundedHostWrite(fixture.path, signal, undefined, { node }), { outcome: "not_started" });
}
assert.equal(calls.length, 0, "invalid runtime pins must fail before spawning");
const result = await prepareBoundedHostWrite(fixture.path, signal, undefined, { node: fixture.node }).write(fixture.content);
result.assertUnchanged();
assert.equal(calls.length, 1);
const [command, args, options] = calls[0];
assert.equal(command, "/usr/bin/sandbox-exec");
assert.equal(args[2], fixture.node.path);
assert.deepEqual(args.slice(3, 5), ["--input-type=module", "--eval"]);
assert.equal(args.some(value => value.includes(fixture.content)), false);
assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
assert.equal(Object.keys(options.env).sort().join(","), "ELECTRON_RUN_AS_NODE,HOME,PATH");
const app = fixture.node.path.slice(0, fixture.node.path.lastIndexOf("/Contents/MacOS/"));
assert.equal(args[1].includes("(subpath " + JSON.stringify(app) + ")"), false);
assert.equal(readFileSync(fixture.path, "utf8"), fixture.content);
process.stdout.write(JSON.stringify({ runtime: "electron", worker: "inline", writes: calls.length, invalidPinsRejected: 4 }));
`, { mode: 0o600 });
  const child = spawnSync(executable, [harness, config], { encoding: "utf8", timeout: 25_000,
    env: { PATH: "/usr/bin:/bin", HOME: f.root, ELECTRON_RUN_AS_NODE: "1" }, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { runtime: "electron", worker: "inline", writes: 1, invalidPinsRejected: 4 });
  assert.equal(await readFile(f.path, "utf8"), content);
  t.diagnostic("Real Electron/Seatbelt mechanism using opt-in fixture pins; no signed package, production bootstrap or Host authority is certified.");
});
