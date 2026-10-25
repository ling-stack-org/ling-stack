/** Freeze exact independently reviewed inputs. This never grants approval. */
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
assert.equal(head, "b3c1937cd8fb5dac8515ca0d2249a23ff959a876");
assert.equal(git(["branch", "--show-current"]), "codex/e6-safe-continuation");
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
const previousPath = "native/office-local/reviewed-packaged-source-v1.json";
const previousBytes = bytes(previousPath), previous = JSON.parse(previousBytes);
assert.equal(sha(previousBytes), "3d2224115472769f1287e1f1f533776677ee11527224ae87a8a2f2bd4c674ecb");
const baselinePath = "output/e6-20260928/office-human-qa-p3-c01-delta-frozen-20261024.json";
const baselineBytes = bytes(baselinePath), baseline = JSON.parse(baselineBytes);
assert.equal(sha(baselineBytes), "afe6e7fad9056f1794ae67d6dd5624fd8839c6e6b8ca28185b156fe8179d102d");
assert.deepEqual(previous.sourceSha256, baseline.sourceSha256);
assert.deepEqual(previous.packagingSha256, baseline.packagingSha256);
assert.equal(paths.length, 1605); assert.equal(nativePaths.length, 15);
const sourceSha256 = snapshot(nativePaths, "native/office-local/"), packagingSha256 = snapshot(paths);
assert.deepEqual(sourceSha256, previous.sourceSha256);
const expected = {
  "apps/desktop/scripts/packaged-office-native-review-inputs.mjs": "f6d771f4ca9877380a5fcbac27b9a2c2aaeda7eaa18902c5ffe742b52074cbce",
  "packages/contracts/src/channel-operation-bindings.ts": "c6361443925a06119570d28c0f95903615a6600f2bb74e10046318f987f003ee",
  "packages/contracts/src/conversation-continuity-validation.ts": "702b5e752bb7b54baf1114fca96ddf7a3fdd290dcce56449184fe37ec7820635",
  "packages/core/src/storage/sqlite/memory-retrieval-store.ts": "f0011531ec37b3b496cd067fcfa99a96800d7669fd787509c3db15831d0d3efd",
  "packages/daemon/src/features/automations/routes.ts": "62f1f835f60e5e36cdcf06239c8d5ffea742e7874f10d27eb7ec6213da8f361b",
  "packages/daemon/src/features/channels/channel-conversation-api.ts": "fd474cd8803129e0a4f9cb6500523d1b9cc6fa6b3ffa5b9344c5085c292b2f40",
  "packages/daemon/src/features/channels/channel-operation-bindings.ts": "ef1f4f9aa0143abdcc13888e1f2e66baefea93b2e38903e2c079fb11f81d5da1",
  "packages/daemon/src/features/channels/context-packs.ts": "cf8dbd4f7b5562be89591595ae493d135c1ca190a6e6ec687454dcbd3f806d01",
  "packages/daemon/src/features/channels/workflows.ts": "57dfbec8e072c739da0f7421056340a91a72a09f553a88ca1434b8a2d1902f7f",
  "packages/daemon/src/features/conversations/routes.ts": "df6d0553fda2d46b0b32b7a81bb004323284e3650b85444ad53acc5a4e924cb7",
  "packages/daemon/src/features/memory/prompt.ts": "014f27a3b2e82908ad7c500beccb56820210132692e8f90f9d61daf2bb2b976d",
  "packages/daemon/src/features/runs/interventions.ts": "22bffec1e1a75c2b9ecc44a6170744e6725e4a7891a7ffc53d2feaf9d066f703",
  "packages/daemon/src/features/runs/orchestrator.ts": "3f2e093ad1242961244799051486537f7dcd961d29fef6e5e996cf03cadcbb6e",
  "packages/daemon/src/features/runs/public-execution-snapshots.ts": "f4314b661c39b34facbbd2370260cade0924b2b495a5a2a9492ba77e5f9165a9",
  "packages/daemon/src/features/runs/restricted-command-dispatch.ts": "391661f65fda0e1a4d6c0383fe43d35ebeb7fdfb32f885e5dbcb11461daa7211",
  "packages/daemon/src/features/runs/routes.ts": "38c241ca54434d96281a1b5f7b2b140046a01cfe2f7fa5615f2691d9cfcb31ff",
  "packages/daemon/src/features/runs/schemas.ts": "2f7fe96a1e84c8cad26d4e7ac68d3ce171180f5024a8e98cdea07e389174a089",
  "packages/daemon/src/features/runs/thread-routes.ts": "a7940c96974f66922df88f66f798e34d5c12141c7614e6db035bd249d0db3d34",
  "packages/daemon/src/features/teammates/direct-controls.ts": "4fb1ba3b596155b8293d375f56c844293fe6e1b9481d8ab9da37d202c0ac340a",
  "packages/daemon/src/runtime/routes.ts": "601734db7d14264dce7f0ed9a6d834e22ff42918ebc3fa97cd8ca99ecca02c7b",
  "packages/daemon/src/runtime/sandbox/node-command-inputs.ts": "33b4f5acf317b04b232fdeb7194ee0ef3f878a8bc8f50cb6ea8afaf9243ce30b",
  "packages/daemon/src/runtime/sandbox/restricted-command-runtime.ts": "f23547fadf00274e5fed881bb1af510c7da8030e02f906891f0e435f4feb4dff",
  "packages/daemon/src/server/rpc.ts": "01af43f6466e4c68b994fecfb82b0ccaeba34336ec57f5529c08826f7d971b2b",
  "packages/daemon/src/features/runs/native-run-dispatcher.ts": "644cd6bcc3cc7b1fb18dee1ba3b196fd99f3ac818e9dd4c1617ae8ac48ca03b5",
  "pnpm-lock.yaml": "610f7dec99ae3da4f04c1d0914641aaaae5b77a7c3c76dc62a09758216a1a4d1",
  "packages/daemon/package.json": "ec6dd5d6e4264184ce27943d206befda3ea79be812f743978501fc9a5fe2087e"
};
const delta = paths.filter(path => packagingSha256[path] !== previous.packagingSha256[path]);
assert.deepEqual(Object.fromEntries(delta.map(path => [path, packagingSha256[path]])), expected);
assert.deepEqual(Object.keys(previous.packagingSha256).filter(path => !Object.hasOwn(packagingSha256, path)), []);
const independentReviews = ["p3-project-inputs-independent-review-20261025.md",
  "p3-memory-source-independent-review-20261024.md", "p3-public-workflow-history-independent-review-20261024.md"]
  .map(name => { const path = `output/e6-20260928/${name}`; return { path, sha256: sha(bytes(path)) }; });
// Require an exact source row in an independent report, not just a loose mention.
const reviewLines = independentReviews.flatMap(row => bytes(row.path).toString("utf8").split("\n"));
for (const [path, hash] of Object.entries(expected))
  assert.ok(reviewLines.some(line => line === `${hash}  ${path}`
    || line === `| ${path} | ${hash} |`), `missing exact reviewed row: ${path}`);
const uiPaths = ["apps/web/src/api/run-request-builders.ts", "apps/web/src/features/runs/RunDetailHeader.tsx",
  "apps/web/src/features/runs/RuntimeRunRepairPanel.tsx", "apps/web/src/features/providers/ProviderWorkbenchFeedback.tsx"];
const uiRows = uiPaths.map(path => ({ path, sha256: sha(bytes(path)) }));
for (const row of uiRows) assert.ok(reviewLines.includes(`${row.sha256}  ${row.path}`));
const logCases = [["p3-pi-memory-source-binding-final-20261024.log", 17],
  ["p3-public-workflow-search-final-20261024.log", 13], ["p3-channel-public-fixture-repair-20261024.log", 3],
  ["p3-protected-stage-async-green-20261024.log", 24], ["p3-office-source-closure-green-20261024.log", 1347]];
const regressions = logCases.map(([name, count]) => {
  const path = `output/e6-20260928/${name}`, value = bytes(path), text = value.toString("utf8");
  for (const expected of [`tests ${count}`, `pass ${count}`, "fail 0", "cancelled 0", "skipped 0"])
    assert.ok(text.includes(`ℹ ${expected}\n`), `${name}: ${expected}`);
  return { path, sha256: sha(value), pass: count, fail: 0, skip: 0,
    kind: "isolated regression, not real model or GUI" };
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
const body = { schemaVersion: 1, kind: "office-human-qa-p3-memory-delta", approved: false, approval: null,
  scope: baseline.scope, git: { head, trackedWorkingTreeClean: true },
  previousApprovedRecord: { path: previousPath, sha256: sha(previousBytes) },
  baseline: { path: baselinePath, sha256: sha(baselineBytes) }, independentReviews, uiRows, regressions,
  sourceInputCount: nativePaths.length, packagingInputCount: paths.length, sourceSha256, packagingSha256,
  delta: { nativeChanged: [],
    changed: delta.filter(path => Object.hasOwn(previous.packagingSha256, path))
      .map(path => ({ path, before: previous.packagingSha256[path], after: packagingSha256[path] })),
    added: delta.filter(path => !Object.hasOwn(previous.packagingSha256, path))
      .map(path => ({ path, after: packagingSha256[path] })), removed: [] },
  compiler: previous.compiler, sdk: previous.sdk, headers: previous.headers, runtime, signing: previous.signing,
  limits: ["Unchanged inputs inherit the frozen full-content review; no new human authentication is claimed",
    "Standing user authorization is applied separately only for reviewed isolated QA, not release",
    "No historical Run/Task/database repair, relaxed authority guard, or automatic tool replay",
    "Final full regression, GUI, recovery, delegation, Office and H09 gates are separate evidence"] };
assert.deepEqual(snapshot(nativePaths, "native/office-local/"), sourceSha256);
assert.deepEqual(snapshot(paths), packagingSha256);
for (const row of [...uiRows, ...independentReviews, ...regressions]) assert.equal(sha(bytes(row.path)), row.sha256);
assert.equal(sha(bytes(previousPath)), sha(previousBytes));
assert.equal(git(["rev-parse", "HEAD"]), head);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
const path = new URL("./office-human-qa-p3-memory-delta-frozen-20261025.json", import.meta.url);
const serialized = JSON.stringify(body, null, 2) + "\n";
writeFileSync(path, serialized, { flag: "wx", mode: 0o600 });
assert.equal(readFileSync(path, "utf8"), serialized);
console.log(JSON.stringify({ path: fileURLToPath(path), sha256: sha(serialized), head,
  nativeInputs: nativePaths.length, packagingInputs: paths.length, changed: body.delta.changed.length,
  added: body.delta.added.length, approved: false }, null, 2));
