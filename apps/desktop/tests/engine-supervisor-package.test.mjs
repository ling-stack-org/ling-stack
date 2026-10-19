import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sealEngineSupervisorPackage } from "../scripts/engine-supervisor-package.mjs";

test("packaged supervisor hashes the final signed bytes while preserving build provenance", async (t) => {
  const appOutDir = await mkdtemp(join(tmpdir(), "ling-supervisor-package-"));
  t.after(() => rm(appOutDir, { recursive: true, force: true }));
  const root = join(appOutDir, "resources", "engine-supervisor");
  await mkdir(root, { recursive: true });
  const metadata = { schema: "ling.engine-supervisor.build.v1", version: "0.1.0", protocol: "ling.engine-supervisor.v1",
    platform: "win32-x64", executable: "ling-engine-supervisor.exe", sha256: "a".repeat(64), sourceCommit: "fixture-commit" };
  await writeFile(join(root, "build-metadata.json"), JSON.stringify(metadata));
  await writeFile(join(root, metadata.executable), "fixture signed bytes");
  await sealEngineSupervisorPackage({ electronPlatformName: "win32", appOutDir });
  const actual = JSON.parse(await readFile(join(root, "build-metadata.json"), "utf8"));
  assert.equal(actual.unsignedSha256, metadata.sha256);
  assert.equal(actual.sha256, createHash("sha256").update("fixture signed bytes").digest("hex"));
  assert.equal(actual.sourceCommit, "fixture-commit");
  await sealEngineSupervisorPackage({ electronPlatformName: "win32", appOutDir });
  assert.deepEqual(JSON.parse(await readFile(join(root, "build-metadata.json"), "utf8")), actual);
});

test("macOS never expects the Windows-only helper", async () => {
  await sealEngineSupervisorPackage({ electronPlatformName: "darwin", appOutDir: "/missing" });
});

test("Windows packaging cannot silently omit the supervisor", async () => {
  await assert.rejects(sealEngineSupervisorPackage({ electronPlatformName: "win32", appOutDir: "/missing" }));
});

test("Windows build and signing config keep supervisor outside asar and update final hashes", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["package:win"], /build:engine-supervisor/);
  assert.equal(pkg.build.win.extraResources.some(entry => entry.to === "engine-supervisor"), true);
  assert.equal(pkg.build.afterSign, "./scripts/after-sign.mjs");
});
