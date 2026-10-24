/** Freeze reviewed C01/offline inputs for isolated QA; never creates approval. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS as paths } from "../../apps/desktop/scripts/packaged-office-native-review-inputs.mjs";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS as nativePaths } from "../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
assert.equal(root, "/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack");
assert.equal(realpathSync(process.cwd()), root);
const sha = value => createHash("sha256").update(value).digest("hex");
const command = (executable, args, env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }) =>
  execFileSync(executable, args, { cwd: root, env, encoding: "utf8", timeout: 30000,
    maxBuffer: 4 * 1024 * 1024 }).trim();
const git = args => command("/usr/bin/git", args);
function bytes(path) {
  const absolute = join(root, path), before = lstatSync(absolute, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= 16n * 1024n * 1024n);
  assert.equal(realpathSync(absolute), absolute);
  const value = readFileSync(absolute), after = lstatSync(absolute, { bigint: true });
  for (const key of ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"]) assert.equal(before[key], after[key]);
  assert.equal(BigInt(value.length), before.size);
  return value;
}
const snapshot = (list, prefix = "") => {
  assert.equal(new Set(list).size, list.length);
  return Object.fromEntries(list.map(path => [path, sha(bytes(prefix + path))]));
};
const head = git(["rev-parse", "HEAD"]);
assert.equal(head, "c9e3d5811866bd636cc69f6a32244ec1e09c0f35");
assert.equal(git(["branch", "--show-current"]), "codex/e6-safe-continuation");
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
const previousPath = "native/office-local/reviewed-packaged-source-v1.json";
const previousBytes = bytes(previousPath), previous = JSON.parse(previousBytes);
assert.equal(sha(previousBytes), "358fdf79b12bff5c0dbb96f07bac0fcd84435aa4dcd89a1704189836d69b82b8");
const baselinePath = "output/e6-20260928/office-human-qa-p3-main-delta-frozen-20261024.json";
const baselineBytes = bytes(baselinePath), baseline = JSON.parse(baselineBytes);
assert.equal(sha(baselineBytes), "3c5c7367f4d968bb229245b5b60d07bc166751e4010412a76154a1213d07e062");
assert.deepEqual(previous.sourceSha256, baseline.sourceSha256);
assert.deepEqual(previous.packagingSha256, baseline.packagingSha256);
assert.equal(paths.length, 1603); assert.equal(nativePaths.length, 15);
const sourceSha256 = snapshot(nativePaths, "native/office-local/"), packagingSha256 = snapshot(paths);
assert.deepEqual(sourceSha256, previous.sourceSha256);
const expected = {
  "packages/daemon/src/features/runs/orchestrator.ts": "acf265259df4489e8923d3278193d0198bee4d8e2f6874df21e3ae56076191d6",
  "packages/daemon/src/features/web/web-evidence-service.ts": "1b1bcf3edd1a9a5af522a6dcbe5b365c5b1b37d3ec2cc937f2d9951d769c2b62"
};
const changed = paths.filter(path => packagingSha256[path] !== previous.packagingSha256[path]);
assert.deepEqual(Object.fromEntries(changed.map(path => [path, packagingSha256[path]])), expected);
assert.deepEqual(Object.keys(previous.packagingSha256).filter(path => !Object.hasOwn(packagingSha256, path)), []);
const independentReviews = ["p3-channel-checkpoint-repair-20261024.md", "p3-child-status-independent-review-20261024.md",
  "p3-offline-prefetch-repair-20261024.md"].map(name => {
  const path = `output/e6-20260928/${name}`;
  return { path, sha256: sha(bytes(path)) };
});
assert.ok(bytes(independentReviews[0].path).toString().includes(expected[changed[0]]));
assert.ok(bytes(independentReviews[2].path).toString().includes(expected[changed[1]]));
const uiReview = bytes(independentReviews[1].path).toString();
const uiRows = [...uiReview.matchAll(/^\| ((?:packages|apps)\/[^ |]+) \| ([a-f0-9]{64}) \|$/gm)]
  .map(([, path, sha256]) => ({ path, sha256 }));
assert.equal(uiRows.length, 8);
for (const row of uiRows) assert.equal(sha(bytes(row.path)), row.sha256);
const logCases = [["p3-channel-checkpoint-green-20261024.log", 2],
  ["p3-channel-checkpoint-adjacent-20261024.log", 28], ["p3-child-status-core-green-20261024.log", 197],
  ["p3-child-status-web-final-20261024.log", 120]];
const regressions = logCases.map(([name, count]) => {
  const path = `output/e6-20260928/${name}`, value = bytes(path), text = value.toString("utf8");
  for (const expected of [`tests ${count}`, `pass ${count}`, "fail 0", "cancelled 0", "skipped 0"])
    assert.ok(text.includes(`ℹ ${expected}\n`), `${name}: ${expected}`);
  return { path, sha256: sha(value), pass: count, fail: 0, skip: 0, kind: "isolated regression; not real model/GUI" };
});
const compilerPath = realpathSync(command("/usr/bin/xcrun", ["--find", "clang++"]));
assert.equal(compilerPath, previous.compiler.path);
assert.equal(sha(readFileSync(compilerPath)), previous.compiler.sha256);
assert.equal(command(compilerPath, ["--version"]), previous.compiler.version);
assert.equal(realpathSync(command("/usr/bin/xcrun", ["--show-sdk-path"])), previous.sdk.root);
assert.equal(sha(readFileSync(join(previous.sdk.root, "SDKSettings.json"))), previous.sdk.settingsSha256);
for (const [name, digest] of Object.entries(previous.headers.sha256))
  assert.equal(sha(readFileSync(join(previous.headers.root, name))), digest);
const require = createRequire(join(root, "apps/desktop/package.json"));
const electronRoot = realpathSync(dirname(require.resolve("electron/package.json")));
const runtime = JSON.parse(command(join(electronRoot, "dist/Electron.app/Contents/MacOS/Electron"), ["-e",
  "process.stdout.write(JSON.stringify({platform:process.platform,architecture:process.arch,electron:process.versions.electron,node:process.versions.node,uv:process.versions.uv}))"],
{ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" }));
assert.deepEqual(runtime, previous.runtime);
const body = { schemaVersion: 1, kind: "office-human-qa-p3-c01-delta", approved: false, approval: null,
  scope: baseline.scope, git: { head, trackedWorkingTreeClean: true },
  previousApprovedRecord: { path: previousPath, sha256: sha(previousBytes) },
  baseline: { path: baselinePath, sha256: sha(baselineBytes) }, independentReviews, uiRows, regressions,
  sourceInputCount: nativePaths.length, packagingInputCount: paths.length, sourceSha256, packagingSha256,
  delta: { nativeChanged: [], changed: changed.map(path => ({ path, before: previous.packagingSha256[path], after: packagingSha256[path] })), added: [], removed: [] },
  compiler: previous.compiler, sdk: previous.sdk, headers: previous.headers, runtime, signing: previous.signing,
  limits: ["Unchanged inputs inherit the frozen full-content review; no new human authentication is claimed",
    "Standing user authorization covers only reviewed internal isolated QA, not release",
    "No historical Run/Task/database repair, relaxed lineage guard, or automatic replay",
    "Remaining GUI, recovery, delegation, Office and H09 gates stay open"] };
assert.deepEqual(snapshot(nativePaths, "native/office-local/"), sourceSha256);
assert.deepEqual(snapshot(paths), packagingSha256);
for (const row of [...uiRows, ...independentReviews, ...regressions]) assert.equal(sha(bytes(row.path)), row.sha256);
assert.equal(sha(bytes(previousPath)), sha(previousBytes));
assert.equal(git(["rev-parse", "HEAD"]), head);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
const path = new URL("./office-human-qa-p3-c01-delta-frozen-20261024.json", import.meta.url);
const serialized = JSON.stringify(body, null, 2) + "\n";
writeFileSync(path, serialized, { flag: "wx", mode: 0o600 });
assert.equal(readFileSync(path, "utf8"), serialized);
console.log(JSON.stringify({ path: fileURLToPath(path), sha256: sha(serialized), head,
  nativeInputs: nativePaths.length, packagingInputs: paths.length, changed: changed.length, uiInputs: uiRows.length, approved: false }, null, 2));
