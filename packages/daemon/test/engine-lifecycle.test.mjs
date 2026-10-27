import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { discoverEngines } from "../dist/features/execution-engines/engine-scanner.js";
import { installManagedEngine, ManagedInstallError } from "../dist/features/execution-engines/managed-engine-installer.js";

const baseOptions = { resolveExecutable: async () => undefined };

test("discovery reports not_found for every engine when nothing is installed", async () => {
  const report = await discoverEngines({ ...baseOptions, platform: "darwin" });
  assert.equal(report.candidates.length, 4);
  for (const candidate of report.candidates) {
    assert.equal(candidate.status, "not_found");
    assert.equal(typeof candidate.installable, "boolean");
  }
  const codex = report.candidates.find((candidate) => candidate.engineId === "codex-app-server");
  assert.equal(codex?.installable, true);
  const kimi = report.candidates.find((candidate) => candidate.engineId === "kimi-acp");
  assert.equal(kimi?.installable, false);
  assert.ok(kimi?.manualGuidance);
});

test("discovery probes a found executable without inventing success", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ling-engine-scan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "codex");
  await writeFile(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const report = await discoverEngines({
    platform: "darwin", probeTimeoutMs: 3000,
    resolveExecutable: async (command) => (command === "codex" ? fake : undefined),
  });
  const codex = report.candidates.find((candidate) => candidate.engineId === "codex-app-server");
  assert.equal(codex?.status, "detected");
  assert.equal(codex?.executablePath, fake);
  assert.equal(codex?.version, undefined, "failing probe must not invent a version");
});

async function packTarball(files) {
  const dir = await mkdtemp(join(tmpdir(), "ling-pack-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      await import("node:fs/promises").then((fs) => fs.mkdir(join(target, ".."), { recursive: true }));
      await writeFile(target, content, name.endsWith("/bin/codex") || name === "package/claude" ? { mode: 0o755 } : undefined);
    }
    const out = join(dir, "pkg.tgz");
    await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-czf", out, "-C", dir, ...Object.keys(files)], { stdio: ["ignore", "ignore", "inherit"] });
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
      child.once("error", reject);
    });
    const bytes = await readFile(out);
    return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  } finally {
    // Keep the directory: callers read the tarball from it; cleanup happens with tmpdir churn.
  }
}

function registryFetch(metadata, tarball) {
  return async (url) => {
    if (new URL(String(url)).hostname === "registry.npmjs.org" && String(url).endsWith(".tgz")) {
      return new Response(tarball.bytes, { status: 200 });
    }
    return new Response(JSON.stringify(metadata), { status: 200 });
  };
}

test("discovery classifies out-of-range versions as unsupported", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ling-engine-range-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "codex");
  await writeFile(fake, "#!/bin/sh\necho \"codex-cli 0.100.0\"\n", { mode: 0o755 });
  const report = await discoverEngines({
    platform: "darwin", probeTimeoutMs: 3000,
    resolveExecutable: async (command) => (command === "codex" ? fake : undefined),
  });
  const codex = report.candidates.find((candidate) => candidate.engineId === "codex-app-server");
  assert.equal(codex?.status, "unsupported");
  assert.equal(codex?.version, "0.100.0");
});

test("managed install downloads, verifies and probes the pinned platform binary", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "ling-engine-root-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const binary = String.raw`#!/bin/sh
echo "2.1.311 (Claude Code)"
`;
  const tarball = await packTarball({ "package/claude": binary });
  const metadata = { dist: { tarball: "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.311.tgz", integrity: tarball.integrity } };
  const result = await installManagedEngine("claude-agent-sdk", { rootDir }, {
    platform: "darwin", arch: "arm64", fetchImpl: registryFetch(metadata, tarball),
  });
  assert.equal(result.version, "2.1.311");
  assert.equal(result.integrity, tarball.integrity);
  assert.ok(result.executablePath.endsWith(join("engines", "claude-agent-sdk", "2.1.311", "package", "claude")));
  const info = await stat(result.executablePath);
  assert.ok(info.isFile());
  const probe = spawn(result.executablePath, [], { stdio: ["ignore", "pipe", "ignore"] });
  probe.stdout.once("data", () => undefined);
  const output = [];
  probe.stdout.on("data", (chunk) => output.push(chunk));
  const [code] = await once(probe, "exit");
  assert.equal(code, 0);
  assert.match(Buffer.concat(output).toString("utf8"), /2\.1\.311/u);
  const marker = JSON.parse(await readFile(join(rootDir, "engines", "claude-agent-sdk", "2.1.311", ".ling-managed.json"), "utf8"));
  assert.equal(marker.integrity, tarball.integrity);
});

test("managed install refuses an integrity mismatch and leaves no partial install", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "ling-engine-root-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const tarball = await packTarball({ "package/claude": "#!/bin/sh\ntrue\n" });
  const metadata = { dist: { tarball: "https://registry.npmjs.org/x.tgz", integrity: "sha512-AAAA" } };
  await assert.rejects(
    installManagedEngine("claude-agent-sdk", { rootDir }, { platform: "darwin", arch: "arm64", fetchImpl: registryFetch(metadata, tarball) }),
    (error) => error instanceof ManagedInstallError && error.message === "managed_install_integrity_mismatch",
  );
  await assert.rejects(stat(join(rootDir, "engines")), { code: "ENOENT" });
});

test("managed install refuses engines without a managed layout", async () => {
  await assert.rejects(
    installManagedEngine("kimi-acp", { rootDir: "/tmp/ling-nowhere" }, {}),
    /managed_install_unsupported_engine/u,
  );
});
