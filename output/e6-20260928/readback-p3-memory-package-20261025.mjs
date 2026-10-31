// Read-only verification of the new isolated QA package, not GUI acceptance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReviewedPackagedOfficeSource } from "../../apps/desktop/scripts/packaged-office-native-review.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const release = join(root, "apps/desktop/release/human-qa");
const app = join(release, "mac-arm64/Ling Stack Human QA.app");
const resources = join(app, "Contents/Resources"), archive = join(resources, "app.asar");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fileSha(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
const require = createRequire(join(root, "apps/desktop/package.json"));
const { extractFile } = require("@electron/asar");
const metadata = JSON.parse(extractFile(archive, "package.json"));
assert.deepEqual(metadata.lingHumanQaPackage,
  { schemaVersion: 1, purpose: "synthetic-human-evaluation", release: false });
const { sourceReviewSha256 } = readReviewedPackagedOfficeSource();
assert.equal(sourceReviewSha256, "e29a856fa977ab065936b2a621e063cd71d306319743193ae66e8601046fddd8");
const daemon = extractFile(archive, "dist/daemon/cli.mjs");
assert.ok(daemon.toString("utf8").includes(sourceReviewSha256), "missing exact embedded Office review");
const modules = [];
for (const path of ["dist/daemon/cli.mjs", "dist/main/entry.js", "dist/main/daemon-lifecycle.js"]) {
  const packed = sha(extractFile(archive, path)), built = await fileSha(join(root, "apps/desktop", path));
  assert.equal(packed, built, path);
  modules.push({ path, sha256: packed, distMatches: true });
}
const gstackManifestSha256 = await fileSha(join(resources, "gstack/manifest.json"));
assert.equal(gstackManifestSha256, "42e8edca5d7f7ba275d462756fc8ab85e1c9638b69f9811994bafb895b034d00");
const selection = JSON.parse(await readFile(join(root, ".ling-stack/build/gstack-desktop-selection.json")));
assert.deepEqual(metadata.lingPackagedGstack, selection.identity);
const verification = execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app],
  { encoding: "utf8", timeout: 60000 });
const identity = execFileSync("/usr/bin/codesign", ["-dv", "--verbose=4", app],
  { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
const artifacts = [];
for (const name of ["Ling-Stack-0.1.2-alpha.1-macos-arm64.zip", "Ling-Stack-0.1.2-alpha.1-macos-arm64.dmg"])
  artifacts.push({ name, sha256: await fileSha(join(release, name)) });
const record = { capturedAt: new Date().toISOString(), kind: "real-packaged-readback-not-GUI", app,
  implementationCheckpoint: "b3c1937cd8fb5dac8515ca0d2249a23ff959a876",
  sourceReviewSha256, qaMarker: metadata.lingHumanQaPackage, asarSha256: await fileSha(archive),
  modules, gstackManifestSha256, gstackIdentity: metadata.lingPackagedGstack, strictCodesignExit: 0,
  verification, identity, artifacts,
  buildLogSha256: await fileSha(join(root, "output/e6-20260928/human-qa-package-memory-reviewed-20261025.log")),
  limits: ["Original package command exit is recorded separately; readback does not replace it",
    "No GUI/model/recovery acceptance, fresh human authentication or publication is implied"] };
const text = JSON.stringify(record, null, 2) + "\n";
const path = new URL("./p3-memory-package-readback-20261025.json", import.meta.url);
await writeFile(path, text, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ path: fileURLToPath(path), sha256: sha(text), asarSha256: record.asarSha256,
  modules, artifacts }, null, 2));
