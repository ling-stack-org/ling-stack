import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseMarketplaceIndex } from "@ling-stack/contracts";
import { createDaemonServer } from "../dist/index.js";
import { verifyMarketplacePackIntegrity } from "../dist/features/skills/marketplace-route.js";

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

test("marketplace inspect fetches, bounds and validates indexes over https", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-marketplace-"));
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { webFetch: (async () => ({ text: async () => JSON.stringify(validIndex) })) },
  );
  try {
    await daemon.start();
    const port = daemon.server.address().port;
    const ok = await (await fetch(`http://127.0.0.1:${port}/skills/marketplace/inspect?url=${encodeURIComponent("https://cdn.example.com/index.json")}`)).json();
    assert.equal(ok.schemaVersion, 1);
    assert.equal(ok.skills.length, 1);
    assert.equal(ok.skills[0].integrityAlgorithm, "sha256");

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
