import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeGstackCommandLinks } from "./materialize-command-links.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-command-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime/node_modules/.bin"), { recursive: true });
  await mkdir(join(root, "runtime/tools"));
  await copyFile(process.execPath, join(root, "runtime/tools/node"));
  await chmod(join(root, "runtime/tools/node"), 0o755);
  return root;
}

test("command links become relocatable launchers using bundled Node and original module context", {
  skip: process.platform === "win32" && "Unix launchers are executed on their actual target platform",
}, async (t) => {
  const root = await fixture(t);
  const runtime = join(root, "runtime");
  await mkdir(join(runtime, "node_modules/tool/lib"), { recursive: true });
  await writeFile(join(runtime, "node_modules/tool/lib/value.cjs"), 'module.exports = "own module context";');
  await writeFile(join(runtime, "node_modules/tool/cli.cjs"), '#!/usr/bin/env node\nconsole.log(JSON.stringify({value: require("./lib/value.cjs"),args: process.argv.slice(2),node: process.execPath}));');
  await symlink("../tool/cli.cjs", join(runtime, "node_modules/.bin/tool"));
  const records = await materializeGstackCommandLinks({ runtimeRoot: runtime, target: { platform: "darwin", arch: "arm64" } });
  assert.equal(records.length, 1);
  assert.equal((await lstat(join(runtime, "node_modules/.bin/tool"))).isSymbolicLink(), false);
  const relocated = join(root, "new application resources");
  await cp(runtime, relocated, { recursive: true });
  await rm(runtime, { recursive: true });
  const result = JSON.parse(execFileSync(join(relocated, "node_modules/.bin/tool"), ["space value", "--flag"], {
    cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000,
  }));
  assert.equal(result.value, "own module context");
  assert.deepEqual(result.args, ["space value", "--flag"]);
  assert.equal(result.node, await realpath(join(relocated, "tools/node")));
  assert.deepEqual(await materializeGstackCommandLinks({ runtimeRoot: relocated, target: { platform: "darwin", arch: "arm64" } }), []);
});

test("escaping and non-command symlinks are rejected before any link is replaced", async (t) => {
  const root = await fixture(t);
  const runtime = join(root, "runtime");
  await mkdir(join(runtime, "node_modules/tool"));
  await writeFile(join(runtime, "node_modules/tool/cli.js"), "#!/usr/bin/env node\nconsole.log('fixture');");
  await symlink("../tool/cli.js", join(runtime, "node_modules/.bin/tool"));
  await symlink("../tools", join(runtime, "unexpected"), "junction");
  await assert.rejects(materializeGstackCommandLinks({ runtimeRoot: runtime, target: { platform: "darwin", arch: "arm64" } }), /gstack_non_command_link/);
  assert.equal((await lstat(join(runtime, "node_modules/.bin/tool"))).isSymbolicLink(), true);
  await rm(join(runtime, "unexpected"));
  await symlink(join(root, "runtime/tools/node"), join(runtime, "node_modules/.bin/not-a-node-script"));
  await assert.rejects(materializeGstackCommandLinks({ runtimeRoot: runtime, target: { platform: "darwin", arch: "arm64" } }), /gstack_command_target_not_node_script/);
  assert.equal((await lstat(join(runtime, "node_modules/.bin/tool"))).isSymbolicLink(), true);
  await rm(join(runtime, "node_modules/.bin/not-a-node-script"));
  await writeFile(join(root, "outside.js"), "#!/usr/bin/env node\n");
  await symlink(join(root, "outside.js"), join(runtime, "node_modules/.bin/escape"));
  await assert.rejects(materializeGstackCommandLinks({ runtimeRoot: runtime, target: { platform: "darwin", arch: "arm64" } }), /gstack_command_link_escape/);
});
