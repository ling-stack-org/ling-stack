/** Freeze a pending QA-only delta. This script never writes an approved record. */
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
assert.equal(git(["branch", "--show-current"]), "codex/e6-safe-continuation");
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "", "save tracked WIP before freezing");
const previousPath = "native/office-local/reviewed-packaged-source-v1.json";
const previousBytes = bytes(previousPath), previous = JSON.parse(previousBytes);
assert.equal(sha(previousBytes), "67d5e91eb3aad2fa4188edc656c9be927532e604803d51297ba0ff29fd72e872");
const baselinePath = "output/e6-20260928/office-human-qa-cold-bootstrap-delta-pending-20261023.json";
const baselineBytes = bytes(baselinePath), baseline = JSON.parse(baselineBytes);
assert.equal(sha(baselineBytes), "5927e6e5e05e9062e285cbfd12ca6c3274bdaca889b38eeb581816a39d77c94f");
assert.deepEqual(previous.sourceSha256, baseline.sourceSha256);
assert.deepEqual(previous.packagingSha256, baseline.packagingSha256);
const reviewPaths = ["p3-private-host-delta-independent-review-20261023.md",
  "p3-budget-clarification-independent-review-20261023.md",
  "p3-office-closure-independent-review-20261023.md",
  "p3-runtime-projection-content-independent-review-20261023.md"];
const independentReviews = reviewPaths.map(name => ({ path: `output/e6-20260928/${name}`,
  sha256: sha(bytes(`output/e6-20260928/${name}`)) }));
const sourceSha256 = snapshot(nativePaths, "native/office-local/"), packagingSha256 = snapshot(paths);
assert.deepEqual(sourceSha256, previous.sourceSha256, "native source changes need separate review");
const rows = paths.map(path => ({ path, sha256: packagingSha256[path] }));
const deltaRows = rows.filter(row => row.sha256 !== previous.packagingSha256[row.path]);
assert.equal(sha(JSON.stringify(rows)), "f23a4b9a68eaf3026a9a7fcc745fb13dacf56a2908a5e5e72cfbc19bfe00021b",
  "current bytes must match independent closure inventory");
assert.equal(sha(JSON.stringify(deltaRows)), "529f4fe856aa4030155f6427a1c66b3d0ec42ff3cdd407b7d7b5db4b4965c841");
const changed = paths.filter(path => Object.hasOwn(previous.packagingSha256, path)
  && previous.packagingSha256[path] !== packagingSha256[path]).sort();
const added = paths.filter(path => !Object.hasOwn(previous.packagingSha256, path)).sort();
const removed = Object.keys(previous.packagingSha256).filter(path => !Object.hasOwn(packagingSha256, path));
assert.equal(paths.length, 1594);
assert.equal(changed.length, 74);
assert.deepEqual(added, ["packages/daemon/src/features/conversations/context-compaction-projection.ts"]);
assert.deepEqual(removed, []);
// Original toolchain facts are reused only after independent current readback.
const compilerPath = realpathSync(command("/usr/bin/xcrun", ["--find", "clang++"]));
assert.equal(compilerPath, previous.compiler.path);
assert.equal(sha(readFileSync(compilerPath)), previous.compiler.sha256);
assert.equal(command(compilerPath, ["--version"]), previous.compiler.version);
assert.equal(realpathSync(command("/usr/bin/xcrun", ["--show-sdk-path"])), previous.sdk.root);
assert.equal(sha(readFileSync(join(previous.sdk.root, "SDKSettings.json"))), previous.sdk.settingsSha256);
for (const [name, digest] of Object.entries(previous.headers.sha256)) {
  assert.equal(sha(readFileSync(join(previous.headers.root, name))), digest);
}
const require = createRequire(join(root, "apps/desktop/package.json"));
const electronRoot = realpathSync(dirname(require.resolve("electron/package.json")));
const runtime = JSON.parse(command(join(electronRoot, "dist/Electron.app/Contents/MacOS/Electron"), ["-e",
  "process.stdout.write(JSON.stringify({platform:process.platform,architecture:process.arch,electron:process.versions.electron,node:process.versions.node,uv:process.versions.uv}))"],
{ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" }));
assert.deepEqual(runtime, previous.runtime);
const logCases = [
  ["p3-budget-review-green-20261023.log", 28],
  ["p3-selector-neighbor-regression-20261023.log", 68],
  ["p3-budget-summary-neighbors-20261023.log", 73],
  ["p3-clarification-http-canonical-20261023.log", 10],
  ["p3-office-closure-regression-20261023.log", 1345],
  ["p3-combined-web-tests-20261023.log", 780],
];
const regressions = logCases.map(([name, count]) => {
  const path = `output/e6-20260928/${name}`, value = bytes(path), text = value.toString("utf8");
  for (const expected of [`tests ${count}`, `pass ${count}`, "fail 0", "cancelled 0", "skipped 0"]) {
    assert.ok(text.includes(`ℹ ${expected}\n`), `${name}: ${expected}`);
  }
  return { path, sha256: sha(value), pass: count, fail: 0, skip: 0, kind: "isolated automated regression; not real model/GUI" };
});
const body = { schemaVersion: 1, kind: "office-human-qa-p3-delta",
  status: "reviewed_pending_qa_authorization_application", approved: false, approval: null,
  scope: baseline.scope, git: { head, trackedWorkingTreeClean: true },
  baseline: { path: baselinePath, sha256: sha(baselineBytes) },
  previousApprovedRecord: { path: previousPath, sha256: sha(previousBytes) },
  independentReviews, sourceInputCount: nativePaths.length, packagingInputCount: paths.length,
  sourceSha256, packagingSha256,
  delta: { nativeChanged: [], changed: changed.map(path => ({ path, before: previous.packagingSha256[path], after: packagingSha256[path] })),
    added: added.map(path => ({ path, sha256: packagingSha256[path] })), removed },
  regressions, compiler: previous.compiler, sdk: previous.sdk, headers: previous.headers,
  runtime, signing: previous.signing,
  limits: ["Only changed inputs receive new content/delta review; unchanged coverage is inherited",
    "No human identity authentication is claimed; old specific packet does not approve new bytes",
    "User standing authorization covers necessary internal isolated QA after applicable independent review",
    "No publication, production deployment, main CI enablement or Windows acceptance",
    "H09 hard output cap and remaining real-client matrix are not proven by this packet"] };
assert.deepEqual(snapshot(nativePaths, "native/office-local/"), sourceSha256);
assert.deepEqual(snapshot(paths), packagingSha256);
for (const record of [...independentReviews, ...regressions]) assert.equal(sha(bytes(record.path)), record.sha256);
assert.equal(sha(bytes(previousPath)), sha(previousBytes));
assert.equal(git(["rev-parse", "HEAD"]), head);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
const path = new URL("./office-human-qa-p3-delta-frozen-20261023.json", import.meta.url);
const serialized = JSON.stringify(body, null, 2) + "\n";
writeFileSync(path, serialized, { flag: "wx", mode: 0o600 });
assert.equal(readFileSync(path, "utf8"), serialized);
console.log(JSON.stringify({ path: fileURLToPath(path), sha256: sha(serialized), head,
  nativeInputs: nativePaths.length, packagingInputs: paths.length, changed: changed.length,
  added: added.length, removed: removed.length, approved: false }, null, 2));
