import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseMarketplaceIndex } from "@ling-stack/contracts";
import { verifyMarketplacePackIntegrity } from "../dist/features/skills/marketplace-route.js";
import { createA11PublicHttpNetworkFixture } from "./support/a11-public-http-network-fixture.mjs";

const validIndex = {
  indexVersion: 1,
  generatedAt: "2026-10-26T00:00:00.000Z",
  skills: [{
    id: "daily-brief",
    name: "Daily brief",
    description: "Morning summary skill",
    versions: [{ version: "1.0.0", url: "https://cdn.example.com/packs/daily-brief-1.0.0.lingpack", integrity: `sha256-${"a".repeat(64)}` }],
  }],
};

test("marketplace index parser validates version, ids, https urls and sha256 integrity", () => {
  const parsed = parseMarketplaceIndex(validIndex);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.index.skills.length, 1);
  assert.equal(parsed.index.skills[0].latestVersion ?? parsed.index.skills[0].versions[0].version, "1.0.0");

  assert.equal(parseMarketplaceIndex({ ...validIndex, indexVersion: 2 }).ok, false);
  assert.equal(parseMarketplaceIndex({ ...validIndex, skills: "nope" }).ok, false);
  const badIntegrity = parseMarketplaceIndex({
    indexVersion: 1,
    skills: [{ id: "x", name: "x", versions: [{ version: "1", url: "https://x/y.lingpack", integrity: "md5-abc" }] }],
  });
  assert.equal(badIntegrity.ok, false);
  const httpUrl = parseMarketplaceIndex({
    indexVersion: 1,
    skills: [{ id: "x", name: "x", versions: [{ version: "1", url: "http://x/y.lingpack", integrity: `sha256-${"a".repeat(64)}` }] }],
  });
  assert.equal(httpUrl.ok, false);
});

test("pack integrity verifies sha256-<hex> against actual bytes", () => {
  const bytes = new TextEncoder().encode("pack bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(verifyMarketplacePackIntegrity(bytes, `sha256-${digest}`), true);
  assert.equal(verifyMarketplacePackIntegrity(bytes, `sha256-${"b".repeat(64)}`), false);
  assert.equal(verifyMarketplacePackIntegrity(bytes, "md5-abc"), false);
});

test("marketplace inspect fetches, bounds and validates indexes over https", async t => {
  if (process.env.LING_MARKETPLACE_ISOLATED_ENDPOINT !== "1") {
    const root = await mkdtemp(join(tmpdir(), "ling-marketplace-endpoint-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "user"), workspace = join(root, "workspace");
    await mkdir(home, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
    try {
      const child = await promisify(execFile)(process.execPath,
        ["--test", "--test-name-pattern=^marketplace inspect fetches, bounds and validates indexes over https$", fileURLToPath(import.meta.url)],
        { cwd: root, env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
          LING_STACK_DEFAULT_WORKSPACE_CWD: workspace, LING_MARKETPLACE_ISOLATED_ENDPOINT: "1" }, timeout: 25_000, maxBuffer: 1024 * 1024 });
      process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
    } finally { await rm(root, { recursive: true, force: true }); }
    return;
  }
  for (const key of ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"]) {
    const value = process.env[key];
    assert.ok(value && isAbsolute(value) && resolve(value) === value && value !== "/" && value !== process.cwd(), `${key} must be explicitly isolated`);
  }
  console.log(`Marketplace endpoint isolated config: ${JSON.stringify({ home: process.env.LING_STACK_HOME,
    defaultWorkspaceCwd: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, cwd: process.cwd() })}`);
  const { createDaemonServer } = await import("../dist/index.js");
  const cwd = await mkdtemp(join(tmpdir(), "ling-marketplace-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  console.log(`Marketplace endpoint configured workspace: ${cwd}`);
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true,
    onRequest(_request, response) { response.end(JSON.stringify(validIndex)); } });
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { webFetch: globalThis.fetch },
  );
  try {
    await daemon.start();
    const port = daemon.server.address().port;
    fixture.allowApiPort(port);
    const ok = await (await fetch(`http://127.0.0.1:${port}/skills/marketplace/inspect?url=${encodeURIComponent(`${fixture.baseUrl}/index.json`)}`)).json();
    assert.equal(ok.schemaVersion, 1);
    assert.equal(ok.skills.length, 1);
    assert.equal(ok.skills[0].integrityAlgorithm, "sha256");
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.connects.filter(item => item.kind === "upstream")[0].address, "203.0.113.10");
    assert.equal(fixture.tlsConnections[0].authorized, true);

    const rejected = await fetch(`http://127.0.0.1:${port}/skills/marketplace/inspect?url=${encodeURIComponent("http://cdn.example.com/index.json")}`);
    assert.equal(rejected.status, 400);

    for (const internal of ["https://127.0.0.1/index.json", "https://192.168.1.10/index.json", "https://printer.internal/index.json", "https://localhost/index.json"]) {
      const blocked = await fetch(`http://127.0.0.1:${port}/skills/marketplace/inspect?url=${encodeURIComponent(internal)}`);
      assert.equal(blocked.status, 400, internal);
    }

    const missing = await fetch(`http://127.0.0.1:${port}/skills/marketplace/inspect`);
    assert.equal(missing.status, 400);

    const post = await fetch(`http://127.0.0.1:${port}/skills/marketplace/inspect`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await daemon.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
});
