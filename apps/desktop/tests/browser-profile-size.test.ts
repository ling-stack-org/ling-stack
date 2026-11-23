import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { measureBrowserProfileSize } from "../dist/main/browser/profile-size.js";

test("browser profile size counts only its persistent storage and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-browser-size-"));
  try {
    const profile = join(root, "profile"), outside = join(root, "outside"), metadata = join(root, "metadata.json");
    await mkdir(join(profile, "Cache"), { recursive: true });
    await writeFile(join(profile, "Cache", "entry"), Buffer.alloc(9));
    await writeFile(outside, Buffer.alloc(50));
    await writeFile(metadata, Buffer.alloc(4));
    await symlink(outside, join(profile, "linked"));
    const result = await measureBrowserProfileSize(profile, metadata);
    assert.equal(result.status, "complete");
    assert.equal(result.knownBytes, 13);
  } finally { await rm(root, { recursive: true, force: true }); }
});
