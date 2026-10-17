import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filterGstackNativePlatformResources } from "./filter-native-platform-resources.mjs";

// Microsoft ONNX Runtime 1.24.3 dist/binding.js, including its MIT notice.
const bindingSource = [
  '"use strict";',
  "// Copyright (c) Microsoft Corporation. All rights reserved.",
  "// Licensed under the MIT License.",
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "exports.initOrt = exports.binding = void 0;",
  'const onnxruntime_common_1 = require("onnxruntime-common");',
  "// export native binding",
  "exports.binding = ",
  "// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires",
  "require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`);",
  "let ortInitialized = false;",
  "const initOrt = () => {",
  "    if (!ortInitialized) {",
  "        ortInitialized = true;",
  "        let logLevel = 2;",
  "        if (onnxruntime_common_1.env.logLevel) {",
  "            switch (onnxruntime_common_1.env.logLevel) {",
  "                case 'verbose':",
  "                    logLevel = 0;",
  "                    break;",
  "                case 'info':",
  "                    logLevel = 1;",
  "                    break;",
  "                case 'warning':",
  "                    logLevel = 2;",
  "                    break;",
  "                case 'error':",
  "                    logLevel = 3;",
  "                    break;",
  "                case 'fatal':",
  "                    logLevel = 4;",
  "                    break;",
  "                default:",
  "                    throw new Error(`Unsupported log level: ${onnxruntime_common_1.env.logLevel}`);",
  "            }",
  "        }",
  "        exports.binding.initOrtOnce(logLevel, onnxruntime_common_1.Tensor);",
  "    }",
  "};",
  "exports.initOrt = initOrt;",
  "//# sourceMappingURL=binding.js.map",
].join("\n");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-platform-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules/onnxruntime-node");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.24.3", main: "dist/index.js", binary: { napi_versions: [6] } }));
  await writeFile(join(packageRoot, "dist/binding.js"), bindingSource);
  const base = join(packageRoot, "bin/napi-v6");
  for (const [platform, arch, filename] of [
    ["darwin", "arm64", "onnxruntime_binding.node"],
    ["darwin", "arm64", "libonnxruntime.1.24.3.dylib"],
    ["win32", "x64", "onnxruntime_binding.node"],
    ["win32", "x64", "onnxruntime.dll"],
  ]) {
    const path = join(base, platform, arch);
    await mkdir(path, { recursive: true });
    const bytes = Buffer.alloc(128);
    if (platform === "darwin") {
      bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4);
    } else {
      bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c);
      bytes.writeUInt32LE(0x00004550, 64); bytes.writeUInt16LE(0x8664, 68);
    }
    await writeFile(join(path, filename), bytes);
  }
  await writeFile(join(root, "KEEP"), "unrelated resource");
  return { root, packageRoot, base };
}

test("platform staging removes only reviewed foreign ONNX directories and records original hashes", async (t) => {
  const { root, base } = await fixture(t);
  const original = await readFile(join(base, "darwin/arm64/onnxruntime_binding.node"));
  const report = await filterGstackNativePlatformResources({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } });
  assert.equal(report.package.name, "onnxruntime-node");
  assert.equal(report.package.version, "1.24.3");
  assert.equal(report.removedResources.length, 2);
  assert.equal(report.retainedResources.length, 2);
  assert.equal(report.removedSizeBytes, 256);
  assert.ok(report.removedResources.every(r => r.path.includes("/win32/x64/") && /^sha256:[a-f0-9]{64}$/.test(r.checksum)));
  assert.deepEqual(await readdir(base), ["darwin"]);
  assert.deepEqual(await readFile(join(base, "darwin/arm64/onnxruntime_binding.node")), original);
  assert.equal(await readFile(join(root, "KEEP"), "utf8"), "unrelated resource");
  const retry = await filterGstackNativePlatformResources({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } });
  assert.equal(retry.removedResources.length, 0);
  assert.equal(retry.retainedResources.length, 2);
});

test("Windows staging retains its PE binding and library without claiming Windows execution", async (t) => {
  const { root, base } = await fixture(t);
  const report = await filterGstackNativePlatformResources({ runtimeRoot: root, target: { platform: "win32", arch: "x64" } });
  assert.deepEqual(await readdir(base), ["win32"]);
  assert.equal(report.retainedResources.length, 2);
  assert.ok(report.retainedResources.every(file => file.path.includes("/win32/x64/")));
  assert.equal(report.removedResources.length, 2);
});

test("changed versions and loaders are rejected before any platform resource changes", async (t) => {
  for (const change of ["version", "loader"]) {
    const { root, packageRoot, base } = await fixture(t);
    if (change === "version") {
      const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      metadata.version = "1.24.4";
      await writeFile(join(packageRoot, "package.json"), JSON.stringify(metadata));
    } else await writeFile(join(packageRoot, "dist/binding.js"), `${bindingSource}\n`);
    await assert.rejects(filterGstackNativePlatformResources({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } }),
      new RegExp(change === "version" ? "gstack_onnx_package_not_reviewed" : "gstack_onnx_loader_not_reviewed"));
    assert.deepEqual((await readdir(base)).sort(), ["darwin", "win32"]);
    assert.equal((await readFile(join(base, "win32/x64/onnxruntime.dll"))).length, 128);
  }
});

test("missing or wrong-architecture target resources never cause foreign resource deletion", async (t) => {
  for (const change of ["missing", "wrong-arch"]) {
    const { root, base } = await fixture(t);
    const binding = join(base, "darwin/arm64/onnxruntime_binding.node");
    if (change === "missing") await rm(binding);
    else {
      const bytes = await readFile(binding);
      bytes.writeUInt32LE(0x01000007, 4);
      await writeFile(binding, bytes);
    }
    await assert.rejects(filterGstackNativePlatformResources({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } }),
      new RegExp(change === "missing" ? "gstack_onnx_target_resource_missing" : "gstack_onnx_target_binary_invalid"));
    assert.equal((await readFile(join(base, "win32/x64/onnxruntime.dll"))).length, 128);
  }
});

test("unreviewed resources and escaping directory links fail the complete preflight", async (t) => {
  for (const change of ["extra-resource", "directory-link", "file-link"]) {
    const { root, base } = await fixture(t);
    if (change === "extra-resource") await writeFile(join(base, "win32/x64/DO_NOT_REMOVE.txt"), "not a native dependency");
    else if (change === "directory-link") {
      await rm(join(base, "win32/x64"), { recursive: true });
      await symlink(tmpdir(), join(base, "win32/x64"), "junction");
    } else {
      await rm(join(base, "win32/x64/onnxruntime.dll"));
      await symlink(join(root, "KEEP"), join(base, "win32/x64/onnxruntime.dll"));
    }
    await assert.rejects(filterGstackNativePlatformResources({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } }), /gstack_(?:onnx_resource_not_reviewed|platform_directory_invalid|platform_file_invalid)/);
    assert.equal((await readFile(join(base, "darwin/arm64/onnxruntime_binding.node"))).length, 128);
    assert.equal(await readFile(join(root, "KEEP"), "utf8"), "unrelated resource");
  }
});

test("unknown targets and root links cannot operate on the original tree", async (t) => {
  const { root, base } = await fixture(t);
  await assert.rejects(filterGstackNativePlatformResources({ runtimeRoot: root, target: { platform: "linux", arch: "arm64" } }), /gstack_platform_target_invalid/);
  const link = `${root}-link`;
  await symlink(root, link, "junction");
  t.after(() => rm(link, { force: true }));
  await assert.rejects(filterGstackNativePlatformResources({ runtimeRoot: link, target: { platform: "darwin", arch: "arm64" } }), /gstack_platform_root_invalid/);
  assert.equal((await readFile(join(base, "win32/x64/onnxruntime.dll"))).length, 128);
});
