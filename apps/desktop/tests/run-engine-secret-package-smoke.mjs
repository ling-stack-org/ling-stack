import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions, statFile } from "@electron/asar";
import { build } from "esbuild";
import electron from "electron";

// Explicit-only smoke: real Electron/OS store, a disposable ASAR, and one new synthetic credential.
assert.ok(["darwin", "win32"].includes(process.platform), "Run on an actual supported host");
const root = await mkdtemp(join(tmpdir(), "ling-engine-secret-package-"));
const stage = join(root, "stage");
const asar = join(root, "app.asar");
const ref = `keychain:ling-engine-${randomUUID()}`;
const secret = `synthetic-package-${randomUUID()}`;
const require = createRequire(import.meta.url);
const keyringRoot = dirname(require.resolve("@napi-rs/keyring"));
const bindingName = `@napi-rs/keyring-${process.platform}-${process.arch}${process.platform === "win32" ? "-msvc" : ""}`;
const bindingRoot = dirname(createRequire(join(keyringRoot, "package.json")).resolve(bindingName));
const desktopPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const unpack = desktopPackage.build.asarUnpack.find((pattern) => pattern.includes("@napi-rs/keyring"));
assert.ok(unpack, "Use the production native binding unpack rule");
let attempted = false;
try {
  await mkdir(join(stage, "dist", "daemon"), { recursive: true });
  await mkdir(join(stage, "node_modules", "@napi-rs"), { recursive: true });
  await writeFile(join(stage, "package.json"), JSON.stringify({ type: "module" }));
  await cp(keyringRoot, join(stage, "node_modules", "@napi-rs", "keyring"), { recursive: true, dereference: true });
  await cp(bindingRoot, join(stage, "node_modules", ...bindingName.split("/")), { recursive: true, dereference: true });
  await build({ entryPoints: [fileURLToPath(new URL("../../../packages/daemon/dist/features/execution-engines/engine-secret-store.js", import.meta.url))],
    bundle: true, platform: "node", format: "esm", outfile: join(stage, "dist", "daemon", "cli.mjs") });
  const worker = await readFile(new URL("../dist/daemon/engine-secret-worker.js", import.meta.url));
  await writeFile(join(stage, "dist", "daemon", "engine-secret-worker.js"), worker);
  await writeFile(join(stage, "driver.mjs"), `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { createEngineSecretStore } from './dist/daemon/cli.mjs';
    const store = createEngineSecretStore();
    const [ref, operation] = process.argv.slice(2);
    if (operation === 'remove') {
      store.remove(ref);
      assert.equal(store.status(ref).configured, false);
    } else {
      assert.equal(store.status(ref).configured, false);
      const secret = readFileSync(0, 'utf8');
      store.write(ref, secret);
      assert.equal(store.status(ref).configured, true);
      assert.equal(store.resolve(ref).value === secret, true);
      assert.equal(createEngineSecretStore().resolve(ref).value === secret, true);
    }
    console.log(JSON.stringify({operation, pass:true}));
  `);
  await createPackageWithOptions(stage, asar, { unpack });
  const bindingPackage = JSON.parse(await readFile(join(bindingRoot, "package.json"), "utf8"));
  assert.equal(statFile(asar, `node_modules/${bindingName}/${bindingPackage.main}`).unpacked, true);
  const invoke = async (operation, input = "") => {
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(electron, [join(asar, "driver.mjs"), ref, operation], {
        env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        timeout: 15_000, maxBuffer: 8192, windowsHide: true,
      }, (error, output) => error ? reject(error) : resolve(output));
      child.stdin.end(input);
    });
    assert.deepEqual(JSON.parse(stdout), { operation, pass: true });
  };
  attempted = true;
  try { await invoke("write", secret); }
  finally { await invoke("remove"); attempted = false; }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, electronAsarWorker: "pass",
    nativeBindingUnpacked: true, createdReadReopenedRemoved: true, realAccountUsed: false, signedInstallerVerified: false,
    asarSha256: createHash("sha256").update(await readFile(asar)).digest("hex"),
    workerSha256: createHash("sha256").update(worker).digest("hex"),
    nativeBindingSha256: createHash("sha256").update(await readFile(join(bindingRoot, bindingPackage.main))).digest("hex") }));
} finally {
  if (attempted) console.error(`Synthetic entry cleanup needs attention: ${ref}`);
  await rm(root, { recursive: true, force: true });
}
