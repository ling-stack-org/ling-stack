import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyBundledBrowser } from "../dist/bundled-skill-browser.js";

const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-browser-verifier-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entryPath = "Chromium.app/Contents/MacOS/Chromium", framework = "Chromium.app/Contents/Frameworks/Chromium Framework.framework";
  await mkdir(dirname(join(root, entryPath)), { recursive: true });
  await mkdir(join(root, framework, "Versions/A"), { recursive: true });
  const bytes = Buffer.from("fixture data; never executed");
  await writeFile(join(root, entryPath), bytes);
  const links = [];
  for (let i = 0; i < 5; i++) {
    const path = `${framework}/alias-${i}`;
    await symlink("Versions/A", join(root, path));
    links.push({ path, linkTarget: "Versions/A", resolvedTarget: `${framework}/Versions/A` });
  }
  const target = { platform: "darwin", arch: "arm64" };
  const manifest = { schemaVersion: 1, target, entryPath, files: [{ path: entryPath, sizeBytes: bytes.length, checksum: digest(bytes) }], links };
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(join(root, "browser-component.json"), manifestBytes);
  const checksum = digest(manifestBytes);
  return { root, entryPath, target, manifest, checksum, verify: () => verifyBundledBrowser(root, checksum, target) };
}
test("authenticated framework aliases are admitted; file and manifest mutations reject", async t => {
  const f = await fixture(t), admitted = f.verify();
  admitted.assertCurrent();
  await writeFile(join(f.root, f.entryPath), Buffer.alloc((await readFile(join(f.root, f.entryPath))).length));
  assert.throws(() => admitted.assertCurrent(), /component_invalid/);
  assert.throws(f.verify, /component_invalid/);
});
test("unlisted files, escaping or retargeted aliases and modified manifests reject", async t => {
  for (const mutation of ["extra-file", "escape-alias", "retarget-alias", "manifest"]) await t.test(mutation, async t => {
    const f = await fixture(t), admitted = f.verify();
    const link = join(f.root, f.manifest.links[0].path);
    if (mutation === "extra-file") await writeFile(join(f.root, "unlisted"), "not authenticated");
    if (mutation.endsWith("alias")) {
      await unlink(link);
      await symlink(mutation === "escape-alias" ? tmpdir() : "Versions", link);
    }
    if (mutation === "manifest") await writeFile(join(f.root, "browser-component.json"), "{}");
    assert.throws(f.verify, /component_invalid/);
    assert.throws(() => admitted.assertCurrent(), /component_invalid/);
  });
});
