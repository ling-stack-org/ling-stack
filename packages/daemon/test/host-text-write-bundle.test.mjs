import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parse } from "acorn";
import { ELECTRON_NODE_RESOURCE_PATHS, digestElectronNodeResource } from "../dist/runtime/sandbox/electron-node-resources.js";

const desktopRoot = fileURLToPath(new URL("../../../apps/desktop/", import.meta.url));
const requireDesktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const { build } = requireDesktop("esbuild");
const electronExecutable = process.env.LING_HOST_WRITE_TEST_ELECTRON;

function descendants(node, predicate) {
  const matches = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (predicate(value)) matches.push(value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(node);
  return matches;
}

// Read the actual packaging option expression. A new esbuild transform must
// affect this test too; silently maintaining a second hand-written config would
// miss helpers inserted outside the function serialized by the product.
async function packagingOptions(sourceMode) {
  const code = await readFile(join(desktopRoot, "scripts/build-packaged-daemon.mjs"), "utf8");
  const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const owner = ast.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "buildOriginalDaemonBundle");
  assert.ok(owner);
  const calls = descendants(owner, node => node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "build");
  assert.equal(calls.length, 1);
  const argument = calls[0].arguments[0];
  assert.equal(argument.type, "ObjectExpression");
  const inputCode = await readFile(join(desktopRoot, "scripts/packaged-office-daemon-source-inputs.mjs"), "utf8");
  const inputAst = parse(inputCode, { ecmaVersion: "latest", sourceType: "module" });
  const configs = descendants(inputAst, node => node.type === "Property" && node.key.name === "tsconfigRaw");
  assert.equal(configs.length, 1);
  const config = configs[0].value;
  const tsconfigRaw = runInNewContext(`(${inputCode.slice(config.start, config.end)})`);
  const emptyPlugin = { name: "host-write-bundle-mechanism-only", setup() {} };
  return runInNewContext(`(${code.slice(argument.start, argument.end)})`, {
    desktopRoot, gstack: { plugin: emptyPlugin }, definitions: [],
    sourceInputs: sourceMode ? { entryPoint: "unused", tsconfigRaw, plugin: emptyPlugin } : undefined,
  });
}

for (const sourceMode of [false, true]) {
  test(`actual ${sourceMode ? "reviewed-source" : "dist-default"} esbuild transforms leave the Host write worker self-contained`, {
    skip: process.platform !== "darwin", timeout: 60_000,
  }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ling-host-write-bundle-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const data = join(root, "data");
    await mkdir(data, { mode: 0o700 });
    const entry = fileURLToPath(new URL(sourceMode ? "../src/runtime/acp/host-text-write.ts" : "../dist/runtime/acp/host-text-write.js", import.meta.url));
    const output = join(root, "host-write-bundle.mjs");
    const options = await packagingOptions(sourceMode);
    const result = await build({ ...options, entryPoints: [entry], outfile: output, write: false, metafile: true, logLevel: "silent" });
    assert.equal(result.outputFiles.length, 1, "the worker cannot require a second emitted file");
    assert.ok(Object.keys(result.metafile.inputs).some(path => path.endsWith(sourceMode ? "/host-text-write-worker.ts" : "/host-text-write-worker.js")));
    await writeFile(output, result.outputFiles[0].contents, { mode: 0o600 });
    // The parent bundle initializes PDF support too. Match the desktop's real
    // optional native dependency, without exposing it inside the worker sandbox.
    await mkdir(join(root, "node_modules/@napi-rs"), { recursive: true });
    await symlink(dirname(requireDesktop.resolve("@napi-rs/canvas")), join(root, "node_modules/@napi-rs/canvas"));
    const module = pathToFileURL(output).href;
    const { prepareBoundedHostWrite } = await import(module);
    const path = join(data, "node.txt"), content = "Bundled worker data: ` ${process.exit(9)} and quoted \\\"text\\\"\n";
    const receipt = await prepareBoundedHostWrite(path, new AbortController().signal).write(content);
    receipt.assertUnchanged();
    assert.equal(await readFile(path, "utf8"), content);
    if (electronExecutable) {
      const executable = await realpath(electronExecutable), contents = dirname(dirname(executable));
      // Opt-in observation fixture only, never a production authority issuer.
      const node = { path: executable, sha256: createHash("sha256").update(await readFile(executable)).digest("hex"), runtime: {
        kind: "electron_node_v1", resources: ELECTRON_NODE_RESOURCE_PATHS.map(relativePath => ({ relativePath,
          sha256: digestElectronNodeResource(join(contents, relativePath)) })),
      } };
      const electronPath = join(data, "electron.txt"), config = join(root, "runtime.json"), harness = join(root, "runtime.mjs");
      await writeFile(config, JSON.stringify({ path: electronPath, node, content }), { mode: 0o600 });
      await writeFile(harness, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareBoundedHostWrite } from ${JSON.stringify(module)};
assert.ok(process.versions.electron);
const fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
const receipt = await prepareBoundedHostWrite(fixture.path, new AbortController().signal, undefined, { node: fixture.node }).write(fixture.content);
receipt.assertUnchanged();
assert.equal(readFileSync(fixture.path, "utf8"), fixture.content);
process.stdout.write("BUNDLED_ELECTRON_HOST_WRITE_OK");
`, { mode: 0o600 });
      const child = spawnSync(executable, [harness, config], { encoding: "utf8", timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: root, ELECTRON_RUN_AS_NODE: "1" }, maxBuffer: 1024 * 1024 });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, "BUNDLED_ELECTRON_HOST_WRITE_OK");
      assert.equal(await readFile(electronPath, "utf8"), content);
    }
    t.diagnostic(`Actual packaging transforms, one ESM bundle and real ${electronExecutable ? "Node/Electron" : "Node"} Seatbelt writes; not full CLI, source-review, ASAR or signed-package acceptance.`);
  });
}
