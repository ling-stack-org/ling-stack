import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, toNamespacedPath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.argv[2];
if (!isAbsolute(root ?? "") || realpathSync(root) !== root) throw new Error("security_runtime_root_invalid");
const localPath = absolute => {
  const path = relative(root, absolute).split("\\").join("/");
  if (!path || isAbsolute(path) || path === ".." || path.startsWith("../") || realpathSync(absolute) !== absolute) {
    throw new Error("security_runtime_external_or_linked_input");
  }
  return path;
};
const inputs = new Map(), addons = new Set();
function record(absolute) {
  const path = localPath(absolute);
  const before = lstatSync(absolute);
  // The admitted macOS universal Node includes both native slices (currently
  // 231 MiB). Its bytes are independently bound by the caller before/after
  // this probe; keep the smaller limit for every dependency and module input.
  const maximumBytes = absolute === process.execPath && path === `tools/node${process.platform === "win32" ? ".exe" : ""}`
    ? 256 * 1024 ** 2 : 128 * 1024 ** 2;
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new Error("security_runtime_input_invalid");
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd), hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("security_runtime_input_changed");
    let sizeBytes = 0, size;
    while ((size = readSync(fd, buffer)) > 0) { sizeBytes += size; hash.update(buffer.subarray(0, size)); }
    const after = fstatSync(fd);
    if (sizeBytes !== before.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      realpathSync(absolute) !== absolute) throw new Error("security_runtime_input_changed");
    const file = { path, sizeBytes, checksum: `sha256:${hash.digest("hex")}` };
    if (inputs.has(path) && JSON.stringify(inputs.get(path)) !== JSON.stringify(file)) throw new Error("security_runtime_input_changed");
    inputs.set(path, file);
  } finally { closeSync(fd); }
}

let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error("security_runtime_network_forbidden"); };
globalThis.fetch = deny;
globalThis.WebSocket = deny;
const require = createRequire(join(root, "package.json"));
for (const [name, methods] of [["http", ["request", "get"]], ["https", ["request", "get"]],
  ["net", ["connect", "createConnection"]], ["tls", ["connect"]], ["dns", ["lookup", "resolve", "resolve4", "resolve6"]]]) {
  const module = require(`node:${name}`);
  for (const method of methods) module[method] = deny;
}
syncBuiltinESMExports();
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith("file:")) record(fileURLToPath(url));
  return nextLoad(url, context);
} });
const originalDlopen = process.dlopen;
process.dlopen = function(module, filename, ...args) {
  const canonical = realpathSync(filename);
  // Node's Windows .node loader passes exactly toNamespacedPath(filename).
  // Admit that spelling only; aliases and links must still fail closed.
  if (filename !== canonical && (process.platform !== "win32" || filename !== toNamespacedPath(canonical))) {
    throw new Error("security_runtime_external_or_linked_input");
  }
  record(canonical);
  const result = originalDlopen.call(this, module, filename, ...args);
  addons.add(localPath(canonical));
  return result;
};

const transformersEntry = join(root, "node_modules/@huggingface/transformers/dist/transformers.node.mjs");
const transformers = await import(pathToFileURL(transformersEntry));
if (typeof transformers.pipeline !== "function") throw new Error("security_runtime_transformers_invalid");
const dependencyRequire = createRequire(transformersEntry);
const ort = dependencyRequire("onnxruntime-node"), sharp = dependencyRequire("sharp");
// Reuse the existing platform test's ONNX IR 8 / opset 13 Identity fixture.
// This exercises the CPU kernel, not the downloaded prompt-injection classifier.
const model = Buffer.from("0808120c4c696e6720666978747572653a4b0a100a015812015922084964656e7469747912154c696e6720706c6174666f726d20666978747572655a0f0a0158120a0a08080112040a020802620f0a0159120a0a08080112040a0208024202100d", "hex");
const session = await ort.InferenceSession.create(model, { executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1 });
let inference;
try {
  const result = await session.run({ X: new ort.Tensor("float32", Float32Array.from([1.25, -3.5]), [2]) });
  inference = { Y: [...result.Y.data], type: result.Y.type, dims: result.Y.dims };
  if (JSON.stringify(inference) !== JSON.stringify({ Y: [1.25, -3.5], type: "float32", dims: [2] })) throw new Error("security_runtime_inference_failed");
} finally { await session.release(); }
const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } } }).png().toBuffer();
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
if (!data.equals(Buffer.from(Array.from({ length: 6 }, () => [12, 34, 56, 255]).flat()))) throw new Error("security_runtime_image_failed");
const runtimeSharedObjects = [];
for (const absolute of process.report.getReport().sharedObjects) {
  const path = relative(root, absolute);
  if (path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    record(absolute);
    runtimeSharedObjects.push(localPath(absolute));
  }
}
// Package metadata affects both ESM and CommonJS resolution, even where no load
// hook fires for package.json. Bind every package boundary of observed modules.
for (const path of [...inputs.keys()]) {
  const parts = path.split("/");
  while (parts.length > 1) {
    parts.pop();
    const metadata = join(root, ...parts, "package.json");
    try { lstatSync(metadata); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    record(metadata);
  }
}
record(join(root, "package.json"));
const permission = process.permission;
const permissions = { fileWrites: permission.has("fs.write"), childProcesses: permission.has("child"), addons: permission.has("addon") };
if (permissions.fileWrites || permissions.childProcesses || !permissions.addons || networkAttempts) throw new Error("security_runtime_policy_invalid");
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, nodeVersion: process.version,
  transformers: { pipeline: typeof transformers.pipeline }, inference,
  image: { format: "png", width: info.width, height: info.height, channels: info.channels },
  backends: ort.listSupportedBackends(), permissions, networkAttempts,
  addons: [...addons].sort(), runtimeSharedObjects: runtimeSharedObjects.sort(),
  peakRssKiB: process.resourceUsage().maxRSS, inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path, "en")) }));
