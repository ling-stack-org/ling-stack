import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

if (process.argv.length !== 5 || process.argv[2] !== "--run-isolated-probe") {
  throw new Error("Disabled by default: run-probe.mjs --run-isolated-probe <Alpine-vmlinuz-virt> <Alpine-initramfs-virt>");
}
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const here = fileURLToPath(new URL(".", import.meta.url));
const sourcePins = {
  kernel: "d1876369b061ef3bc33314f490240efcd32b031393cb34c6f81134fa862fe472",
  initramfs: "a3519770a2210762adab97556b8e710db76e2d4d31ddf554a951801ca475f873",
};
const kernelBytes = await readFile(resolve(process.argv[3]));
const initramfsPath = resolve(process.argv[4]);
assert.equal(sha(kernelBytes), sourcePins.kernel, "only the recorded Alpine 6.18.58-0-virt kernel is accepted");
assert.equal(sha(await readFile(initramfsPath)), sourcePins.initramfs, "only the recorded matching initramfs is accepted");
const work = await mkdtemp(join(tmpdir(), "ling-vm-research-"));
const root = join(work, "root");
const input = join(work, "input");
const output = join(work, "output");
await Promise.all([root, input, output].map(path => mkdir(path)));
const canary = randomBytes(16).toString("hex");
await writeFile(join(work, "private-canary"), canary, { mode: 0o600 });
await writeFile(join(input, "allowed.txt"), "research input\n");
await symlink("../private-canary", join(input, "unshared-canary"));

// Linux EFI zboot image: documented header payload offset/length, then gzip.
assert.equal(kernelBytes.subarray(4, 8).toString(), "zimg");
const offset = kernelBytes.readUInt32LE(8), length = kernelBytes.readUInt32LE(12);
assert.ok(offset + length <= kernelBytes.length);
const image = gunzipSync(kernelBytes.subarray(offset, offset + length), { maxOutputLength: 64 * 1024 * 1024 });
assert.equal(image.subarray(56, 60).toString(), "ARMd");
const kernel = join(work, "Image");
await writeFile(kernel, image);
command("/usr/bin/bsdtar", ["-xf", initramfsPath, "-C", root]);
await copyFile(join(here, "ling-init.sh"), join(root, "ling-init"));
await chmod(join(root, "ling-init"), 0o755);
const names = [".", ...await collectNames(root)];
const archive = command("/usr/bin/cpio", ["-o", "-H", "newc"], { cwd: root, input: `${names.join("\n")}\n`, encoding: null });
const ramdisk = join(work, "research-initramfs.gz");
await writeFile(ramdisk, gzipSync(archive));
const executable = join(work, "probe");
command("/usr/bin/swiftc", [join(here, "probe.swift"), "-o", executable]);
command("/usr/bin/codesign", ["--force", "--sign", "-", "--entitlements", join(here, "entitlements.plist"), executable]);

const runs = [];
for (const mode of ["verify", "cancel"]) {
  const configPath = join(work, `${mode}.json`);
  await writeFile(configPath, JSON.stringify({ kernel, ramdisk, input, output, mode }));
  const result = spawnSync(executable, ["--run-isolated-probe", configPath], { encoding: "utf8", timeout: 40_000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(work, `${mode}.stdout.jsonl`), result.stdout ?? "");
  await writeFile(join(work, `${mode}.stderr.log`), result.stderr ?? "");
  if (result.error || result.status !== 0) throw new Error(`VM ${mode} failed; evidence retained at ${work}`, { cause: result.error });
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.event === "guest_ready"));
  if (mode === "verify") {
    const guest = JSON.parse(events.find(event => event.event === "guest_result").result);
    assert.deepEqual(guest, { readAllowed: true, readOnlyWriteDenied: true, unsharedCanaryAbsent: true, noNetworkDevice: true, outputWritten: true });
    assert.ok(events.some(event => event.event === "guest_stopped"));
    runs.push({ mode, guest, events });
  } else {
    assert.ok(events.some(event => event.event === "stopped" && event.reason === "cancelled"));
    assert.equal(events.some(event => event.event === "guest_result"), false);
    runs.push({ mode, events });
  }
}
assert.equal(await readFile(join(input, "allowed.txt"), "utf8"), "research input\n");
assert.equal(await readFile(join(work, "private-canary"), "utf8"), canary);
assert.equal(await lstat(join(input, "forbidden.txt")).then(() => true, () => false), false);
const exported = await readExport(output, "result.txt");
assert.equal(exported, "research artifact\n");
await assert.rejects(readExport(output, "symlink.txt"), /invalid_export/);
await assert.rejects(readExport(output, "../private-canary"), /invalid_export/);
const sourceSha256 = {};
for (const name of ["probe.swift", "ling-init.sh", "run-probe.mjs", "entitlements.plist"]) sourceSha256[name] = sha(await readFile(join(here, name)));
const report = { kind: "standalone-vm-research-only", timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  sourcePins, sourceSha256, guestKernelSha256: sha(image), ramdiskSha256: sha(await readFile(ramdisk)), runs,
  hostChecks: { inputUnchanged: true, canaryUnchanged: true, symlinkExportRejected: true, traversalExportRejected: true },
  configuration: { memoryMiB: 512, cpus: 1, networkDevices: 0, readonlyShares: 1, writableShares: 1 },
  limitations: ["No production Runner/Broker/RPC integration or recovery authority.", "No network allowlist implementation; only no-network-device mode is exercised.", "No crash/restart persistence, native tool compatibility or signed distribution acceptance.", "No measured guest RSS or comparison with the native process sandbox."] };
await writeFile(join(work, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, evidenceDirectory: work }, null, 2)}\n`);

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${binary} failed: ${result.stderr}`, { cause: result.error });
  return result.stdout;
}
async function collectNames(directory, prefix = "") {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!name.includes("\n"));
    names.push(name);
    if (entry.isDirectory()) names.push(...await collectNames(join(directory, entry.name), name));
  }
  return names;
}
async function readExport(directory, name) {
  if (!["result.txt", "symlink.txt"].includes(name)) throw new Error("invalid_export");
  if (!(await lstat(join(directory, name))).isFile()) throw new Error("invalid_export");
  const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("invalid_export");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
