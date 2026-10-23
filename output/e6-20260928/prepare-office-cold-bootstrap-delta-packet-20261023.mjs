/** Create a pending-only review snapshot. Never update an approved record or old packet. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS as packagingPaths } from "../../apps/desktop/scripts/packaged-office-native-review-inputs.mjs";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS as nativePaths } from "../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
assert.equal(root, "/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack");
assert.equal(realpathSync(process.cwd()), root);
const args = process.argv.slice(2);
assert.equal(args.length, 2, "provide the two independently read-back report hashes");
assert.ok(args.every(value => /^[a-f0-9]{64}$/.test(value)));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function bytes(path, maximum = 512 * 1024 * 1024) {
  const absolute = join(root, path), before = lstatSync(absolute, { bigint: true });
  assert.equal(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= BigInt(maximum), true);
  assert.equal(realpathSync(absolute), absolute);
  const value = readFileSync(absolute), after = lstatSync(absolute, { bigint: true });
  for (const key of ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"]) assert.equal(before[key], after[key]);
  assert.equal(BigInt(value.length), before.size);
  return value;
}
function command(executable, argv, env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }) {
  return execFileSync(executable, argv, { cwd: root, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }).trim();
}
const git = argv => command("/usr/bin/git", argv);
const head = git(["rev-parse", "HEAD"]);
assert.equal(git(["branch", "--show-current"]), "codex/e6-safe-continuation");
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "", "freeze requires clean tracked inputs");
const baselinePath = "output/e6-20260928/office-human-qa-builder-copy-delta-pending-20261023.json";
const baselineBytes = bytes(baselinePath);
assert.equal(sha(baselineBytes), "f10eabcf132ee09dadc4f2653e8f87e636566b011e9cbb522fba6d63d37532a8");
const baseline = JSON.parse(baselineBytes);
const approvedPath = "native/office-local/reviewed-packaged-source-v1.json";
const approvedBytes = bytes(approvedPath), approved = JSON.parse(approvedBytes);
assert.equal(sha(approvedBytes), "8a82816417944d97c14a228f45e679e3f17be38425ff646d9c9ae3f18bf6c6fe");
assert.deepEqual(approved.sourceSha256, baseline.sourceSha256);
assert.deepEqual(approved.packagingSha256, baseline.packagingSha256);
const independentReviews = ["p2-cold-preflight-independent-review-20261023.md", "p2-bootstrap-independent-review-20261023.md"]
  .map((name, index) => {
    const path = `output/e6-20260928/${name}`;
    assert.equal(sha(bytes(path)), args[index]);
    return { path, sha256: args[index] };
  });
const snapshot = (paths, prefix = "") => {
  assert.equal(new Set(paths).size, paths.length);
  return Object.fromEntries(paths.map(path => [path, sha(bytes(prefix + path))]));
};
const sourceSha256 = snapshot(nativePaths, "native/office-local/");
const packagingSha256 = snapshot(packagingPaths);
assert.deepEqual(sourceSha256, baseline.sourceSha256);
const changed = packagingPaths.filter(path => Object.hasOwn(baseline.packagingSha256, path)
  && packagingSha256[path] !== baseline.packagingSha256[path]).sort();
const added = packagingPaths.filter(path => !Object.hasOwn(baseline.packagingSha256, path)).sort();
const removed = Object.keys(baseline.packagingSha256).filter(path => !Object.hasOwn(packagingSha256, path));
assert.deepEqual(changed, ["apps/desktop/scripts/packaged-office-native-review-inputs.mjs", "packages/core/package.json",
  "packages/core/src/bundled-skill-source.ts", "packages/core/src/execution-engine-host-authority.ts", "packages/daemon/src/cli.ts"]);
assert.deepEqual(added, ["apps/desktop/main/daemon-lifecycle.ts", "packages/core/src/daemon-resource-bootstrap.ts"]);
assert.deepEqual(removed, []);
// Re-read actual tools; inherited metadata is reused only if current bytes/facts match.
const compilerPath = realpathSync(command("/usr/bin/xcrun", ["--find", "clang++"]));
assert.equal(compilerPath, baseline.compiler.path);
assert.equal(sha(readFileSync(compilerPath)), baseline.compiler.sha256);
assert.equal(command(compilerPath, ["--version"]), baseline.compiler.version);
assert.equal(realpathSync(command("/usr/bin/xcrun", ["--show-sdk-path"])), baseline.sdk.root);
assert.equal(sha(readFileSync(join(baseline.sdk.root, "SDKSettings.json"))), baseline.sdk.settingsSha256);
for (const [name, digest] of Object.entries(baseline.headers.sha256)) {
  assert.equal(sha(readFileSync(join(baseline.headers.root, name))), digest);
}
const require = createRequire(join(root, "apps/desktop/package.json"));
const electronRoot = realpathSync(dirname(require.resolve("electron/package.json")));
const runtime = JSON.parse(command(join(electronRoot, "dist/Electron.app/Contents/MacOS/Electron"), ["-e",
  "process.stdout.write(JSON.stringify({platform:process.platform,architecture:process.arch,electron:process.versions.electron,node:process.versions.node,uv:process.versions.uv}))"],
{ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" }));
assert.deepEqual(runtime, baseline.runtime);
const testPaths = ["packages/core/test/bundled-skill-source.test.mjs", "packages/core/test/daemon-resource-bootstrap.test.mjs",
  "packages/daemon/test/daemon-resource-bootstrap.test.mjs", "apps/desktop/tests/daemon-lifecycle.test.mjs",
  "apps/desktop/tests/packaged-office-daemon-source-inputs.test.mjs"];
const testSha256 = snapshot(testPaths);
const regressionPath = "output/e6-20260928/p2-cold-bootstrap-final-regression-20261023.tap";
const regressionBytes = bytes(regressionPath);
const regression = regressionBytes.toString("utf8");
for (const expected of ["tests 1497", "pass 1497", "fail 0", "cancelled 0", "skipped 0"]) assert.ok(regression.includes(`ℹ ${expected}\n`));
const realProbePath = "output/e6-20260928/p2-resource-bootstrap-real-probe-20261023.json";
const realProbeBytes = bytes(realProbePath);
const realProbe = JSON.parse(realProbeBytes);
assert.equal(realProbe.initializerPrepared, true);
assert.equal(realProbe.externalProviderCalls, 0);
assert.equal(realProbe.originalQaProfileChanged, false);
const body = { schemaVersion: 1, kind: "office-human-qa-cold-bootstrap-delta",
  status: "pending_user_source_and_packaging_review_approval", approval: null, approved: false,
  scope: baseline.scope, git: { head, trackedWorkingTreeClean: true },
  baseline: { path: baselinePath, sha256: sha(baselineBytes), userApproval: "office-qa-builder-copy-user-approval-receipt-20261023.md" },
  previousApprovedRecord: { path: approvedPath, sha256: sha(approvedBytes) },
  independentReviews, sourceInputCount: nativePaths.length, packagingInputCount: packagingPaths.length,
  sourceSha256, packagingSha256, testSha256,
  aggregates: { sourceSha256: sha(`${JSON.stringify(Object.entries(sourceSha256))}\n`),
    packagingSha256: sha(`${JSON.stringify(Object.entries(packagingSha256))}\n`) },
  delta: { nativeChanged: [], packagingChanged: changed.map(path => ({ path,
    before: baseline.packagingSha256[path], after: packagingSha256[path] })),
  added: added.map(path => ({ path, sha256: packagingSha256[path] })), removed },
  contract: { resourceBootstrapTimeoutMs: 60000, serviceReadinessTimeoutMs: 20000,
    resourcePipeFd: 4, engineAuthorityPipeFd: 3, noHeartbeatRenewal: true, ordinaryLaunchUnchanged: true },
  evidence: { regression: { path: regressionPath, sha256: sha(regressionBytes), tests: 1497, pass: 1497, fail: 0, skip: 0 },
    realResourceProbe: { path: realProbePath, sha256: sha(realProbeBytes), elapsedMs: realProbe.elapsedMs,
      kind: realProbe.kind, packagedGui: false },
    existingPackage: "actual_exit0_identity_verified_then_gui_start_timeout",
    newPackage: "not_run", gui: "not_run", realModel: "not_run" },
  compiler: baseline.compiler, sdk: baseline.sdk, headers: baseline.headers, runtime, signing: baseline.signing,
  limits: ["prior full/delta review coverage and limitations remain inherited, not repeated",
    "new source digest and independent review are not user approval", "isolated QA only, no release",
    "real resource probe and real pipe composition are not packaged GUI acceptance", "H09 output hard cap remains unproven"] };
assert.deepEqual(snapshot(nativePaths, "native/office-local/"), sourceSha256);
assert.deepEqual(snapshot(packagingPaths), packagingSha256);
assert.deepEqual(snapshot(testPaths), testSha256);
for (const review of independentReviews) assert.equal(sha(bytes(review.path)), review.sha256);
assert.equal(sha(bytes(approvedPath)), sha(approvedBytes));
assert.equal(git(["rev-parse", "HEAD"]), head);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
const outputPath = join(dirname(fileURLToPath(import.meta.url)), "office-human-qa-cold-bootstrap-delta-pending-20261023.json");
const serialized = `${JSON.stringify(body, null, 2)}\n`;
writeFileSync(outputPath, serialized, { flag: "wx", mode: 0o600 });
assert.equal(readFileSync(outputPath, "utf8"), serialized);
console.log(JSON.stringify({ outputPath, sha256: sha(serialized), head, sourceInputCount: nativePaths.length,
  packagingInputCount: packagingPaths.length, delta: body.delta, approval: null, approved: false }, null, 2));
