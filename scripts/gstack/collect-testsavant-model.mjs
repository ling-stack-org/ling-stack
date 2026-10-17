import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedResourceWrite, requireResourceLease, resourceCheckpoint } from "./resource-workspace.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

export const testsavantArtifactName = "testsavant-small-5bfc06f0";
export const testsavantPin = Object.freeze(JSON.parse(await readFile(new URL("./testsavant-model-pin.json", import.meta.url))));
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = code => { throw new Error(`testsavant_${code}`); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const expectedPaths = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt", "onnx/model.onnx", "README.md"];

export function validateTestsavantPin(pin) {
  if (pin?.schemaVersion !== 1 || pin.repository !== "testsavantai/prompt-injection-defender-small-v0-onnx" ||
    pin.revision !== "5bfc06f0b54950e6653f253eb7df1e3c9811b5cb" || pin.releaseEligible !== false ||
    pin.redistributionReview !== "unresolved" || !Array.isArray(pin.files) || pin.files.length !== expectedPaths.length) fail("pin_invalid");
  let total = 0;
  for (const [i, file] of pin.files.entries()) {
    if (file.path !== expectedPaths[i] || file.remotePath !== (file.path === "onnx/model.onnx" ? "model.onnx" : file.path) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > 128 * 1024 ** 2 ||
      !/^sha256:[a-f0-9]{64}$/.test(file.checksum ?? "")) fail("pin_invalid");
    total += file.sizeBytes;
  }
  if (total > 128 * 1024 ** 2) fail("pin_invalid");
  return total;
}

function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
    !["huggingface.co", "cas-bridge.xethub.hf.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "us.aws.cdn.hf.co"].includes(url.hostname)) fail("endpoint_invalid");
  return url;
}

export async function downloadTestsavantFile(file, destination, request = fetch) {
  if (!testsavantPin.files.some(expected => JSON.stringify(expected) === JSON.stringify(file))) fail("file_unpinned");
  let url = endpoint(`https://huggingface.co/${testsavantPin.repository}/resolve/${testsavantPin.revision}/${file.remotePath}`), response;
  const signal = AbortSignal.timeout(180_000);
  for (let i = 0; i < 5; i++) {
    try { response = await request(url.href, { redirect: "manual", signal, credentials: "omit", headers: { "accept-encoding": "identity" } }); }
    catch { fail("network_failed"); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (i === 4) fail("redirect_limit");
    if (!location) fail("endpoint_invalid");
    url = endpoint(new URL(location, url));
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); fail(`http_${response.status}`); }
  const length = response.headers.get("content-length");
  if (length !== null && length !== String(file.sizeBytes) || response.headers.get("content-encoding") !== null) {
    await response.body.cancel(); fail("size_invalid");
  }
  let handle, owned = false, complete = false;
  try {
    handle = await open(destination, "wx", 0o600); owned = true;
    const digest = createHash("sha256"); let count = 0;
    for await (const part of response.body) {
      count += part.length;
      if (count > file.sizeBytes) fail("size_invalid");
      digest.update(part); await handle.writeFile(part);
    }
    if (count !== file.sizeBytes || `sha256:${digest.digest("hex")}` !== file.checksum) fail("content_mismatch");
    complete = true;
  } finally {
    await handle?.close();
    if (owned && !complete) await rm(destination, { force: true });
    if (!owned) await response.body.cancel().catch(() => {});
  }
}

export async function verifyTestsavantModel(root) {
  root = resolve(root);
  validateTestsavantPin(testsavantPin);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) fail("root_invalid");
  const files = [];
  async function walk(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name, full = join(path, entry.name);
      if (entry.isSymbolicLink() || await realpath(full) !== full) fail("file_invalid");
      if (entry.isDirectory() && name === "onnx") await walk(full, `${name}/`);
      else if (entry.isFile()) files.push(name);
      else fail("file_invalid");
    }
  }
  await walk(root);
  if (JSON.stringify(files.sort()) !== JSON.stringify([...expectedPaths, "testsavant-resource.json"].sort())) fail("inventory_mismatch");
  const receiptFile = await readGstackClosureFileRecord(join(root, "testsavant-resource.json"), { retain: true, maximumBytes: 16 * 1024 });
  const receipt = JSON.parse(receiptFile.bytes);
  if (receipt.schemaVersion !== 1 || receipt.pinChecksum !== hash(Buffer.from(JSON.stringify(testsavantPin))) || receipt.releaseEligible !== false) fail("receipt_mismatch");
  for (const file of testsavantPin.files) {
    const actual = await readGstackClosureFileRecord(join(root, file.path));
    if (actual.sizeBytes !== file.sizeBytes || actual.checksum !== file.checksum) fail("content_mismatch");
  }
  return { pin: testsavantPin, receipt };
}

export async function collectTestsavantModel({ onProgress = () => {} } = {}) {
  const lease = await requireResourceLease(), output = join(lease.root, "artifacts/resource", testsavantArtifactName);
  if (await exists(output)) { await verifyTestsavantModel(output); return { output, reused: true }; }
  const totalBytes = validateTestsavantPin(testsavantPin);
  await managedResourceWrite(output, { kind: "resource", additionalBytes: totalBytes + 1024 ** 2 });
  await mkdir(dirname(output), { recursive: true });
  const temporary = await realpath(await mkdtemp(join(lease.scratchPath, "testsavant-")));
  try {
    for (const file of testsavantPin.files) {
      await resourceCheckpoint(lease.root, file.sizeBytes);
      const destination = join(temporary, file.path);
      await mkdir(dirname(destination), { recursive: true });
      onProgress(`acquire immutable ${file.path} (${file.sizeBytes} bytes)`);
      await downloadTestsavantFile(file, destination);
    }
    const receipt = { schemaVersion: 1, releaseEligible: false, repository: testsavantPin.repository,
      revision: testsavantPin.revision, pinChecksum: hash(Buffer.from(JSON.stringify(testsavantPin))), totalBytes,
      pendingGates: ["redistribution-authorization", "installed-mac-windows-acceptance"] };
    const handle = await open(join(temporary, "testsavant-resource.json"), "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); } finally { await handle.close(); }
    await verifyTestsavantModel(temporary);
    await resourceCheckpoint(lease.root);
    await rename(temporary, output);
    return { output, reused: false, totalBytes };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) fail("arguments_invalid");
  console.log(JSON.stringify(await collectTestsavantModel({ onProgress: value => process.stderr.write(`${value}\n`) })));
}
