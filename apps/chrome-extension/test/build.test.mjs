import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const bootstrapDist = resolve(root, "dist-store-bootstrap");
const bootstrapZip = resolve(root, "ling-for-chrome-store-bootstrap.zip");

test("store bootstrap build omits the production key and identity", async () => {
  try {
    await execFileAsync(process.execPath, [resolve(root, "scripts/build.mjs"), "--store-bootstrap"]);
    const manifest = JSON.parse(await readFile(resolve(bootstrapDist, "manifest.json"), "utf8"));
    const metadata = JSON.parse(await readFile(resolve(bootstrapDist, "build-metadata.json"), "utf8"));
    assert.equal("key" in manifest, false);
    assert.equal(metadata.identityMode, "store-bootstrap");
    assert.equal(metadata.extensionId, null);
    assert.equal(metadata.version, "0.1.1");
    assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/u);
    for (const iconPath of Object.values(manifest.icons)) {
      assert.equal((await stat(resolve(bootstrapDist, iconPath))).size > 0, true);
    }
    assert.equal((await stat(bootstrapZip)).size > 0, true);
  } finally {
    await rm(bootstrapDist, { recursive: true, force: true });
    await rm(bootstrapZip, { force: true });
  }
});
