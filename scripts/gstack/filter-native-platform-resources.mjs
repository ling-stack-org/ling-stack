import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { matchesNativeDependency } from "./runtime-dependency-audit.mjs";

const packagePath = "node_modules/onnxruntime-node";
const nativePath = `${packagePath}/bin/napi-v6`;
const bindingChecksum = "sha256:65be03f9a10c7ad773c22185a94f0b80835cd40ddcdc2acd63c1fbe96f94cbb8";
const checksum = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const nativeName = /^(?:onnxruntime_binding\.node|libonnxruntime(?:[._-][A-Za-z0-9.-]+)?\.(?:dylib|so(?:\.\d+)*)|onnxruntime\.dll|DirectML\.dll|dxcompiler\.dll|dxil\.dll)$/;

// Unpublished, exclusively owned staging only. A failed mutation discards staging;
// this is not an in-place updater for an installed or running client.
export async function filterGstackNativePlatformResources({ runtimeRoot, target }) {
  if (!["darwin", "win32"].includes(target.platform) || !["arm64", "x64"].includes(target.arch)) {
    throw new Error("gstack_platform_target_invalid");
  }
  const requested = resolve(runtimeRoot);
  const rootStat = await lstat(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("gstack_platform_root_invalid");
  const root = await realpath(requested);
  const directory = async (path) => {
    const stat = await lstat(join(root, path));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`gstack_platform_directory_invalid:${path}`);
  };
  for (const path of ["node_modules", packagePath, `${packagePath}/dist`, `${packagePath}/bin`, nativePath]) await directory(path);
  const plainFile = async (path) => {
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`gstack_platform_file_invalid:${path}`);
    return stat;
  };
  await plainFile(`${packagePath}/package.json`);
  await plainFile(`${packagePath}/dist/binding.js`);
  const metadataBytes = await readFile(join(root, packagePath, "package.json"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  if (metadata.name !== "onnxruntime-node" || metadata.version !== "1.24.3" ||
    metadata.main !== "dist/index.js" || JSON.stringify(metadata.binary?.napi_versions) !== "[6]") {
    throw new Error("gstack_onnx_package_not_reviewed");
  }
  const loaderBytes = await readFile(join(root, packagePath, "dist/binding.js"));
  if (checksum(loaderBytes) !== bindingChecksum) throw new Error("gstack_onnx_loader_not_reviewed");

  const fileRecord = async (path) => {
    const stat = await plainFile(path);
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(join(root, path))) hash.update(bytes);
    return { path, sizeBytes: stat.size, checksum: `sha256:${hash.digest("hex")}` };
  };
  const inventory = async () => {
    const directories = [];
    const files = [];
    for (const platform of await readdir(join(root, nativePath))) {
      if (!["darwin", "linux", "win32"].includes(platform)) throw new Error("gstack_onnx_platform_not_reviewed");
      await directory(`${nativePath}/${platform}`);
      for (const arch of await readdir(join(root, nativePath, platform))) {
        if (!["arm64", "x64"].includes(arch)) throw new Error("gstack_onnx_arch_not_reviewed");
        const path = `${nativePath}/${platform}/${arch}`;
        await directory(path);
        directories.push(path);
        for (const name of await readdir(join(root, path))) {
          if (!nativeName.test(name)) throw new Error(`gstack_onnx_resource_not_reviewed:${path}/${name}`);
          files.push(await fileRecord(`${path}/${name}`));
        }
      }
    }
    return { directories: directories.sort(), files: files.sort((a, b) => a.path.localeCompare(b.path, "en")) };
  };
  const before = await inventory();
  const retainedDirectory = `${nativePath}/${target.platform}/${target.arch}`;
  const retainedResources = before.files.filter(file => file.path.startsWith(`${retainedDirectory}/`));
  const library = target.platform === "darwin" ? "libonnxruntime.1.24.3.dylib" : "onnxruntime.dll";
  for (const name of ["onnxruntime_binding.node", library]) {
    if (!retainedResources.some(file => file.path === `${retainedDirectory}/${name}`)) throw new Error("gstack_onnx_target_resource_missing");
  }
  for (const file of retainedResources) {
    if (!await matchesNativeDependency(join(root, file.path), target)) throw new Error(`gstack_onnx_target_binary_invalid:${file.path}`);
  }
  const removedResources = before.files.filter(file => !file.path.startsWith(`${retainedDirectory}/`));
  // Validate the entire input again before the first deletion, including directories.
  if (JSON.stringify(before) !== JSON.stringify(await inventory()) ||
    !metadataBytes.equals(await readFile(join(root, packagePath, "package.json"))) ||
    !loaderBytes.equals(await readFile(join(root, packagePath, "dist/binding.js")))) {
    throw new Error("gstack_onnx_input_changed");
  }
  for (const file of removedResources) await unlink(join(root, file.path));
  for (const path of before.directories.filter(path => path !== retainedDirectory)) await rmdir(join(root, path));
  for (const platform of await readdir(join(root, nativePath))) {
    const path = `${nativePath}/${platform}`;
    if (!(await readdir(join(root, path))).length) await rmdir(join(root, path));
  }
  return { schemaVersion: 1, target, package: { name: metadata.name, version: metadata.version, path: packagePath,
    metadataChecksum: checksum(metadataBytes), bindingChecksum }, retainedResources, removedResources,
    removedSizeBytes: removedResources.reduce((total, file) => total + file.sizeBytes, 0) };
}
