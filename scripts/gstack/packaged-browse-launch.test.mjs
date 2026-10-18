import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { packagedBrowseCommandMatches, packagedBrowseEnvironment } from "./packaged-browse-launch.mjs";

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
    .replace('"../../packages/core/src/bundled-skill-browser.ts"', JSON.stringify(new URL("../../packages/core/src/bundled-skill-browser.ts", import.meta.url).href));
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
