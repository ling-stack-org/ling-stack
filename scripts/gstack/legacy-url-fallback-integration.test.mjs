import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { applyLegacyNodeFetchURLPatch } from "./patch-legacy-url-fallback.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { resourceTreeBytes } from "./resource-workspace.mjs";

const input = process.env.LING_GSTACK_RESOURCE_STAGE;
const skip = !input && "Set the retained resource input and use managed supervision";

test("native preparation invokes and binds the reviewed native URL adaptation", async () => {
  assert.match(await readFile(new URL("./apply-runtime-security-patches.mjs", import.meta.url), "utf8"), /applyLegacyNodeFetchURLPatch\(\{ runtimeRoot: root \}\)/);
  assert.match(await readFile(new URL("./apply-runtime-security-patches.mjs", import.meta.url), "utf8"), /\.\.\.\(await applyLegacyNodeFetchURLPatch\(\{ runtimeRoot: root \}\)\)\.patches/);
  assert.match(await readFile(new URL("./build-native-runtime.mjs", import.meta.url), "utf8"), /"patch-legacy-url-fallback\.mjs"/);
});

test("a tiny private node-fetch mirror uses native URL without loading the old fallback, preserving Request and HTTP behavior", { skip }, async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "ling-native-url-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const packageRoot = join(work, "node_modules/node-fetch");
  await mkdir(join(work, "node_modules"));
  await cp(join(input, "runtime/node_modules/node-fetch"), packageRoot, { recursive: true, errorOnExist: true, force: false });
  const node = join(input, "runtime/tools/node"), before = await readFile(join(packageRoot, "LICENSE.md"));
  const unpatched = spawnSync(node, ["-e", "require(process.argv[1])", packageRoot], { encoding: "utf8" });
  assert.notEqual(unpatched.status, 0);
  assert.match(unpatched.stderr, /Cannot find module 'whatwg-url'/);
  const changed = join(packageRoot, "lib/index.es.js"), original = await readFile(changed);
  await writeFile(changed, Buffer.concat([original, Buffer.from("// unexpected input\n")]));
  const pristine = await readFile(join(packageRoot, "lib/index.js"));
  await assert.rejects(applyLegacyNodeFetchURLPatch({ runtimeRoot: work }), /input_changed/);
  assert.deepEqual(await readFile(join(packageRoot, "lib/index.js")), pristine);
  await writeFile(changed, original);
  const report = await applyLegacyNodeFetchURLPatch({ runtimeRoot: work });
  assert.equal(report.package, "node-fetch");
  assert.equal(report.version, "2.7.0");
  assert.equal(report.legacyPackageRemoval, "pending-complete-runtime-closure");
  assert.equal(report.patches?.length, 4);
  for (const patch of report.patches) {
    assert.equal((await readGstackClosureFileRecord(join(work, patch.path))).checksum, patch.afterChecksum);
    assert.equal((await readGstackClosureFileRecord(join(work, patch.patchPath))).checksum, patch.patchChecksum);
    assert.equal(patch.beforeChecksum, report.inputs.find(file => patch.path === `node_modules/node-fetch/${file.path}`).checksum);
  }
  assert.deepEqual(await readFile(join(packageRoot, "LICENSE.md")), before);
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"))).dependencies, undefined);
  for (const name of ["lib/index.js", "lib/index.mjs", "lib/index.es.js"]) {
    assert.doesNotMatch(await readFile(join(packageRoot, name), "utf8"), /whatwg-url|whatwgUrl/);
  }
  const source = `const assert = require('node:assert/strict');
    const http = require('node:http');
    const fetch = require(process.argv[1]);
    const { Request, Response, Headers } = fetch;
    assert.equal(new Request('https://b\\u00fccher.example/a%20b?q=\\u4e2d\\u6587').url,
      'https://xn--bcher-kva.example/a%20b?q=%E4%B8%AD%E6%96%87');
    assert.equal(new Request('https://[::1]:8443/a').url, 'https://[::1]:8443/a');
    assert.throws(() => new Request('https://example.test', { method:'GET', body:'no' }));
    assert.equal(new Headers({ Test: 'ok' }).get('test'), 'ok');
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/result' }); res.end(); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path:req.url })); }
    });
    (async () => {
      await assert.rejects(fetch('not a url'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const base = 'http://127.0.0.1:' + server.address().port;
        const result = await fetch(base + '/redirect');
        assert.equal(result.redirected, true); assert.deepEqual(await result.json(), { path:'/result' });
        assert.equal((await fetch(base + '/redirect', { redirect:'manual' })).status, 302);
        await assert.rejects(fetch(base + '/redirect', { redirect:'error' }));
        assert.equal(await new Response('body').text(), 'body');
        console.log(JSON.stringify({ nativeURL:true, requests:true, redirects:true, bodies:true }));
      } finally { await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const result = spawnSync(node, ["-e", source, packageRoot], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { nativeURL: true, requests: true, redirects: true, bodies: true });
  const bun = join(input, "runtime/tools/bun");
  const bunResult = spawnSync(bun, ["--no-env-file", "--no-install", "-e", source, packageRoot],
    { cwd: work, encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
  assert.equal(bunResult.status, 0, bunResult.stderr);
  assert.deepEqual(JSON.parse(bunResult.stdout), JSON.parse(result.stdout));
  const esm = await import(pathToFileURL(join(packageRoot, "lib/index.mjs")).href);
  assert.equal(new esm.Request("https://example.test/").url, "https://example.test/");
  await assert.rejects(applyLegacyNodeFetchURLPatch({ runtimeRoot: work }), /input_changed/);
  const alias = `${work}-alias`;
  await symlink(work, alias);
  try { await assert.rejects(applyLegacyNodeFetchURLPatch({ runtimeRoot: alias }), /root_invalid/); }
  finally { await rm(alias); }
  const toolInputs = [];
  for (const name of ["patch-legacy-url-fallback.mjs", "legacy-url-fallback-integration.test.mjs",
    "apply-runtime-security-patches.mjs", "build-native-runtime.mjs", "native-runtime-integration.test.mjs",
    "prepare-platform-resource-stage.mjs", "run-managed.mjs", "resource-workspace.mjs"]) {
    toolInputs.push({ path: `scripts/gstack/${name}`,
      ...await readGstackClosureFileRecord(fileURLToPath(new URL(name, import.meta.url))) });
  }
  for (const file of report.inputs) assert.equal((await readGstackClosureFileRecord(join(input, "runtime/node_modules/node-fetch", file.path))).checksum, file.checksum);
  const peakScratchBytes = await resourceTreeBytes(work);
  assert.ok(peakScratchBytes < 1024 ** 2);
  const proof = { schemaVersion: 1, releaseEligible: false, report, toolInputs,
    runtimes: { node: await readGstackClosureFileRecord(node), bun: await readGstackClosureFileRecord(bun) },
    observation: { node: JSON.parse(result.stdout), bun: JSON.parse(bunResult.stdout), esmRequest: true },
    copiedDependency: "node-fetch-only", peakScratchBytes, sourceUnchanged: true,
    pendingGates: ["complete-runtime-closure-and-package-pruning", "fresh-full-native-stage", "windows-client-acceptance"] };
  await rm(work, { recursive: true, force: true });
  if (process.env.LING_GSTACK_NATIVE_URL_PROOF_OUTPUT) {
    const output = process.env.LING_GSTACK_NATIVE_URL_PROOF_OUTPUT;
    assert.equal(output, join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/legacy-url-fallback-proof.json"));
    await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    t.diagnostic(JSON.stringify({ output, ...await readGstackClosureFileRecord(output), peakScratchBytes }));
  }
});
