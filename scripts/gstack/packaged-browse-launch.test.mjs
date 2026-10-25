import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadPackagedBrowserZipParser, packagedBrowseCommandMatches, packagedBrowseEnvironment } from "./packaged-browse-launch.mjs";

test("the pinned ZIP parser cannot load optional dependencies from NODE_PATH or its parent", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-parser-closure-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const playwright = createRequire(require.resolve("@playwright/test/package.json"));
  const core = createRequire(playwright.resolve("playwright/package.json"));
  const original = join(dirname(core.resolve("playwright-core/package.json")), "lib/utilsBundle.js");
  const bytes = await readFile(original), parser = join(root, "utilsBundle.cjs");
  const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await writeFile(parser, bytes);
  for (const modules of [join(root, "injected"), join(root, "node_modules")]) {
    for (const name of ["bufferutil", "fsevents", "utf-8-validate"]) {
      await mkdir(join(modules, name), { recursive: true });
      await writeFile(join(modules, name, "index.js"), 'require("node:fs").writeFileSync(process.env.PARSER_INJECTION_MARKER,"executed");module.exports={};');
    }
  }
  const marker = join(root, "external-code-ran");
  const script = `import {loadPackagedBrowserZipParser} from ${JSON.stringify(new URL("./packaged-browse-launch.mjs", import.meta.url).href)};
    const parser=loadPackagedBrowserZipParser(process.argv[1],process.argv[2]);console.log(typeof parser.openPromise);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, parser, checksum], {
    env: { ...process.env, NODE_PATH: join(root, "injected"), PARSER_INJECTION_MARKER: marker }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "function");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.throws(() => loadPackagedBrowserZipParser(parser, `sha256:${"0".repeat(64)}`), /resource_mismatch/);
});

test("process ownership recognizes exact Mac/Windows argv with spaces, never extra arguments or JSON escapes", () => {
  for (const server of [
    { node: "/test root/tools/node", script: "/test root/browse/dist/server-node.mjs" },
    { node: "C:\\Program Files\\Ling\\tools\\node.exe", script: "C:\\Program Files\\Ling\\browse\\dist\\server-node.mjs" },
  ]) {
    assert.equal(packagedBrowseCommandMatches(`${server.node} ${server.script}`, server), true);
    assert.equal(packagedBrowseCommandMatches(`"${server.node}" "${server.script}"`, server), true);
    assert.equal(packagedBrowseCommandMatches(`"${server.node}" ${server.script}`, server), true);
    assert.equal(packagedBrowseCommandMatches(`${server.node} "${server.script}"`, server), true);
    assert.equal(packagedBrowseCommandMatches(`${server.node} ${server.script} --other`, server), false);
    assert.equal(packagedBrowseCommandMatches(`other ${server.node} ${server.script}`, server), false);
    assert.equal(packagedBrowseCommandMatches(null, server), false);
  }
  const win = { node: "C:\\Program Files\\node.exe", script: "C:\\Program Files\\server.mjs" };
  assert.equal(packagedBrowseCommandMatches(`${JSON.stringify(win.node)} ${JSON.stringify(win.script)}`, win), false);
});

test("both launcher and inherited server environment exclude preload and loader injection", () => {
  assert.deepEqual(packagedBrowseEnvironment({
    HOME: "/empty", SystemRoot: "C:\\Windows", PATH: "/tools", BROWSE_STATE_FILE: "/state",
    NODE_OPTIONS: "--import evil", NODE_PATH: "/evil", BUN_OPTIONS: "--preload evil",
    DYLD_INSERT_LIBRARIES: "/evil.dylib", LD_PRELOAD: "/evil.so", ELECTRON_RUN_AS_NODE: "1",
    API_KEY: "fixture", BASH_ENV: "/evil.sh", ENV: "/evil.sh",
  }, { NODE_OPTIONS: "--require evil", BROWSE_PARENT_PID: "0" }), {
    HOME: "/empty", SystemRoot: "C:\\Windows", PATH: "/tools", BROWSE_STATE_FILE: "/state", BROWSE_PARENT_PID: "0",
  });
});

test("healthy and unhealthy responses must identify the selected admitted component", async () => {
  const source = await readFile(new URL("./packaged-browse-launch.mjs", import.meta.url), "utf8");
  const component = `sha256:${"3".repeat(64)}`;
  const marker = 'const packagedBrowsePins = "NO_PACKAGED_BROWSE_PINS";';
  assert.equal(source.split(marker).length, 2);
  const code = source.replace(marker, `const packagedBrowsePins = ${JSON.stringify(JSON.stringify({ component }))};`)
    .replace('"../../packages/core/src/bundled-skill-browser.ts"', JSON.stringify(new URL("../../packages/core/src/bundled-skill-browser.ts", import.meta.url).href))
    .replace('"./browser-acquisition.mjs"', JSON.stringify(new URL("./browser-acquisition.mjs", import.meta.url).href));
  const { packagedBrowseHealth, packagedBrowseAssertExisting } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  assert.equal(packagedBrowseHealth({ status: "healthy", lingComponent: component }), true);
  assert.equal(packagedBrowseHealth({ status: "unhealthy", lingComponent: component }), false);
  for (const health of [null, {}, { status: "healthy" }, { status: "unhealthy" }, { status: "healthy", lingComponent: "old" }]) {
    assert.throws(() => packagedBrowseHealth(health), /existing_server_mismatch/);
  }
  for (const state of [{ pid: 1, port: "123@external.invalid" }, { pid: -1, port: 123 }, { pid: 1, port: 65536 }]) {
    await assert.rejects(packagedBrowseAssertExisting(state, true), /existing_server_mismatch/);
  }
});
