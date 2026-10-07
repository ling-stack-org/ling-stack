import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture, stagedTree, succeeded } from "./test-helpers.mjs";

const addon = createRequire(import.meta.url)(process.env.OFFICE_LOCAL_ADDON);
const identity = path => { const value = lstatSync(path, { bigint: true }); return { device: String(value.dev), inode: String(value.ino) }; };
const evidence = value => console.log(JSON.stringify({ kind: "office_native_test_evidence", ...value }));

test("synchronous original FD chain installs genuine nested OOXML once, then closes originals", t => {
  const f = fixture(t, addon), held = succeeded(f.open());
  const tree = stagedTree(addon, held);
  assert.equal(tree.file.calls[0].resourceLifetimeId, tree.file.resourceFact.lifetimeId);
  assert.equal(tree.file.calls[0].parentLifetimeId, tree.child.resourceFact.lifetimeId);
  assert.equal(existsSync(join(f.workspace, "published")), false);
  assert.deepEqual(identity(join(f.stage, "native-tree")), { device: tree.top.resourceFact.device, inode: tree.top.resourceFact.inode });
  const installed = succeeded(addon.installTree(held.session, tree.top.capability, "published", "install-once"));
  assert.equal(installed.calls.length, 1); assert.equal(installed.calls[0].syscall, "renameatx_np_RENAME_EXCL");
  assert.equal(installed.snapshot.phase, "published_native_only");
  assert.deepEqual(identity(join(f.workspace, "published")), { device: tree.top.resourceFact.device, inode: tree.top.resourceFact.inode });
  const path = join(f.workspace, "published/nested/report.docx");
  assert.deepEqual(readFileSync(path), tree.bytes);
  const unzip = spawnSync("/usr/bin/unzip", ["-t", path], { encoding: "utf8" });
  assert.equal(unzip.status, 0, unzip.stderr); assert.match(unzip.stdout, /No errors detected/);
  assert.throws(() => addon.createFile(held.session, tree.child.capability, "late", "late-effect"), /session_not_building/);
  assert.throws(() => addon.installTree(held.session, tree.top.capability, "again", "install-once"), /operation_already_consumed/);
  succeeded(addon.fsyncResource(held.session, held.destinationParent, "sync-destination"));
  succeeded(addon.fsyncResource(held.session, held.stageParent, "sync-stage"));
  const closed = succeeded(addon.closeSession(held.session));
  assert.ok(closed.snapshot.resources.every(resource => resource.state === "closed"));
  assert.throws(() => addon.closeSession(held.session), /session_already_closed/);
  assert.equal(addon.inspectSession(held.session).phase, "closed");
  assert.throws(() => addon.closeSession(held.session), /session_already_closed/);
  evidence({ case: "nested-docx", bytesSha256: createHash("sha256").update(tree.bytes).digest("hex"), install: installed.calls,
    sourceIdentity: tree.top.resourceFact, closedResources: closed.snapshot.resources.length, unzip: unzip.stdout.trim() });
});

test("RENAME_EXCL rejects real foreign subtree without overwrite, merge, cleanup, or retry", t => {
  const f = fixture(t, addon), held = succeeded(f.open()), tree = stagedTree(addon, held);
  const foreign = join(f.workspace, "occupied"); mkdirSync(foreign); writeFileSync(join(foreign, "sentinel"), "foreign");
  const before = identity(foreign);
  const result = addon.installTree(held.session, tree.top.capability, "occupied", "install-occupied");
  assert.equal(result.success, false); assert.equal(result.calls.length, 1); assert.equal(result.calls[0].errno, 17);
  assert.equal(result.snapshot.phase, "blocked"); assert.equal(result.snapshot.residualCreation, true);
  assert.deepEqual(identity(foreign), before); assert.equal(readFileSync(join(foreign, "sentinel"), "utf8"), "foreign");
  assert.equal(existsSync(join(foreign, "nested")), false); assert.equal(existsSync(join(f.stage, "native-tree/nested/report.docx")), true);
  assert.throws(() => addon.installTree(held.session, tree.top.capability, "other", "new-ticket"), /session_not_building/);
  evidence({ case: "foreign-target", calls: result.calls, foreignIdentityUnchanged: before, residueRetained: true });
});

test("destination ancestor replacement writes only the captured original inode", t => {
  const f = fixture(t, addon), parent = join(f.workspace, "parent"); mkdirSync(parent);
  const held = succeeded(f.open(f.stage, parent)), original = identity(parent), tree = stagedTree(addon, held);
  const moved = parent + "-original"; renameSync(parent, moved); mkdirSync(parent); writeFileSync(join(parent, "foreign"), "untouched");
  const foreign = identity(parent);
  succeeded(addon.installTree(held.session, tree.top.capability, "published", "install-original-parent"));
  assert.deepEqual(identity(moved), original); assert.notDeepEqual(foreign, original);
  assert.equal(existsSync(join(moved, "published/nested/report.docx")), true);
  assert.equal(existsSync(join(parent, "published")), false); assert.equal(readFileSync(join(parent, "foreign"), "utf8"), "untouched");
  evidence({ case: "destination-ancestor-replaced", original, foreign, wroteOriginalOnly: true, canonicalVisibilityProven: false });
});

test("held staging parent and created child survive canonical rename without foreign adoption", t => {
  const f = fixture(t, addon), held = succeeded(f.open());
  const top = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "create-tree"));
  const moved = f.stage + "-original"; renameSync(f.stage, moved); mkdirSync(f.stage);
  const topPath = join(moved, "native-tree"), displaced = join(moved, "held-original");
  renameSync(topPath, displaced); mkdirSync(topPath); writeFileSync(join(topPath, "foreign"), "untouched");
  const foreign = identity(topPath);
  const child = succeeded(addon.createDirectory(held.session, top.capability, "child", "create-via-held-child"));
  assert.equal(existsSync(join(displaced, "child")), true); assert.equal(existsSync(join(topPath, "child")), false);
  assert.equal(existsSync(join(f.stage, "native-tree")), false);
  const observed = succeeded(addon.observeResource(held.session, top.capability, "observe-original"));
  assert.equal(observed.resourceFact.inode, top.resourceFact.inode); assert.notEqual(observed.resourceFact.inode, foreign.inode);
  // This is an UNBOUND raw-actor demonstration, not protected creator proof.
  // Do not install a name-based source after hostile staging replacement.
  assert.equal(child.snapshot.protectedStageVerified, false); assert.equal(child.snapshot.coreSafe, false);
  evidence({ case: "original-staging-chain", heldIdentity: observed.resourceFact, foreign, foreignNeverOpenedOrMutated: true,
    installNotAttemptedBecauseStageUnbound: true });
});

test("opaque capabilities cannot be cloned, serialized, guessed, or used by a foreign session", t => {
  const f = fixture(t, addon), one = succeeded(f.open()), two = succeeded(f.open());
  assert.deepEqual(JSON.parse(JSON.stringify(one.stageParent)), {});
  for (const invalid of [{}, structuredClone(one.stageParent), JSON.parse(JSON.stringify(one.stageParent)), { fd: 3 }])
    assert.throws(() => addon.createDirectory(one.session, invalid, "bad", "bad-cap"), /invalid_capability/);
  assert.throws(() => addon.createDirectory(two.session, one.stageParent, "bad", "foreign-cap"), /foreign_session_capability/);
  assert.throws(() => addon.inspectSession(structuredClone(one.session)), /invalid_capability/);
  assert.equal(existsSync(join(f.stage, "bad")), false);
  assert.throws(() => addon.openSession(f.stage, f.workspace, { private: true, manifestDigest: "0".repeat(64) }), /invalid_argument_count/);
});

test("original effect operation remains consumed after Host acknowledgment is lost", t => {
  const f = fixture(t, addon), held = succeeded(f.open());
  let returned;
  assert.throws(() => {
    returned = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "original-op"));
    throw new Error("host_commit_failed_after_native_return");
  }, /host_commit_failed/);
  assert.equal(returned.hostAcknowledgment, "not_provided");
  assert.throws(() => addon.createDirectory(held.session, held.stageParent, "replacement", "original-op"), /operation_already_consumed/);
  assert.equal(existsSync(join(f.stage, "replacement")), false);
  assert.equal(addon.inspectSession(held.session).resources.find(resource => resource.lifetimeId === returned.resourceFact.lifetimeId).state, "retained");
  evidence({ case: "native-return-host-ack-lost", calls: returned.calls, originalLifetimeRetained: true, operationReplayRejected: true });
});

test("closed resources are never reused, inspected, or double-consumed", t => {
  const f = fixture(t, addon), held = succeeded(f.open());
  const top = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "create-tree"));
  const file = succeeded(addon.createFile(held.session, top.capability, "file", "create-file"));
  succeeded(addon.fsyncResource(held.session, file.capability, "fsync-file"));
  const closed = succeeded(addon.closeResource(held.session, file.capability, "original-close"));
  assert.equal(closed.calls.length, 1); assert.equal(closed.calls[0].syscall, "close");
  assert.throws(() => addon.closeResource(held.session, file.capability, "other-close"), /resource_not_retained/);
  assert.throws(() => addon.observeResource(held.session, file.capability, "post-close-stat"), /resource_not_retained/);
  assert.throws(() => addon.writeFile(held.session, file.capability, Buffer.from("foreign"), "post-close-write"), /resource_not_retained/);
});

test("cancel stops forward effects while original close remains available", t => {
  const f = fixture(t, addon), held = succeeded(f.open());
  const top = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "create-tree"));
  assert.equal(addon.cancelSession(held.session).phase, "cancelled");
  assert.throws(() => addon.createFile(held.session, top.capability, "file", "cancelled-effect"), /session_not_building/);
  assert.equal(existsSync(join(f.stage, "native-tree/file")), false);
  const closed = succeeded(addon.closeSession(held.session)); assert.equal(closed.snapshot.residualCreation, true);
});

test("all absolute parent components reject real symlinks; no fallback path adoption", t => {
  const f = fixture(t, addon); symlinkSync(f.host, join(f.root, "host-link"));
  const result = f.open(join(f.root, "host-link/stage"), f.workspace);
  assert.equal(result.success, false); assert.equal(result.snapshot.phase, "blocked");
  assert.equal(result.calls.at(-1).syscall, "openat"); assert.equal(result.calls.at(-1).returned, -1);
  assert.ok(result.calls.at(-1).errno > 0); assert.equal(result.stageParent, undefined);
  evidence({ case: "intermediate-symlink", lastNativeCall: result.calls.at(-1) });
});

test("directory/file creation is exclusive and rejects foreign preexisting entries", t => {
  const f = fixture(t, addon), held = succeeded(f.open());
  mkdirSync(join(f.stage, "occupied")); writeFileSync(join(f.stage, "occupied/sentinel"), "foreign");
  const before = identity(join(f.stage, "occupied"));
  const result = addon.createDirectory(held.session, held.stageParent, "occupied", "create-exclusive");
  assert.equal(result.success, false); assert.equal(result.calls.length, 1); assert.equal(result.calls[0].errno, 17);
  assert.equal(result.capability, undefined); assert.deepEqual(identity(join(f.stage, "occupied")), before);
  assert.equal(readFileSync(join(f.stage, "occupied/sentinel"), "utf8"), "foreign");
  assert.throws(() => addon.createDirectory(held.session, held.stageParent, "occupied", "create-exclusive"), /operation_already_consumed/);
});

test("file exclusive create never acquires a foreign existing file or changes its contents", t => {
  const f = fixture(t, addon), held = succeeded(f.open());
  const tree = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "mkdir-tree"));
  const foreignPath = join(f.stage, "native-tree/foreign"); writeFileSync(foreignPath, "foreign-owned");
  const original = identity(foreignPath);
  const result = addon.createFile(held.session, tree.capability, "foreign", "original-file-create");
  assert.equal(result.success, false); assert.equal(result.calls.length, 1); assert.equal(result.calls[0].errno, 17);
  assert.equal(result.calls[0].syscall, "openat_create_exclusive"); assert.equal(result.capability, undefined);
  const attempted = result.snapshot.resources.find(resource => resource.lifetimeId === result.calls[0].resourceLifetimeId);
  assert.equal(attempted.kind, "created_file"); assert.equal(attempted.state, "not_acquired");
  assert.equal(attempted.parentLifetimeId, tree.resourceFact.lifetimeId);
  assert.deepEqual(identity(foreignPath), original); assert.equal(readFileSync(foreignPath, "utf8"), "foreign-owned");
  evidence({ case: "foreign-file-not-acquired", calls: result.calls, originalForeignIdentity: original });
});

test("install requires closed/fsynced files and retained/fsynced original directory chain", t => {
  const f = fixture(t, addon), held = succeeded(f.open());
  const top = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "mkdir-top"));
  const file = succeeded(addon.createFile(held.session, top.capability, "file", "create-file"));
  assert.throws(() => addon.installTree(held.session, top.capability, "published", "invalid-install"), /file_not_synced_and_closed|directory_not_synced_and_retained/);
  assert.equal(addon.inspectSession(held.session).installationEntered, false);
  assert.throws(() => addon.installTree(held.session, top.capability, "published", "invalid-install"), /operation_already_consumed/);
  succeeded(addon.fsyncResource(held.session, file.capability, "sync-file"));
  succeeded(addon.closeResource(held.session, file.capability, "close-file"));
  succeeded(addon.fsyncResource(held.session, top.capability, "sync-top"));
  succeeded(addon.installTree(held.session, top.capability, "published", "valid-install"));
});

test("actual confined same UID actor can replace workspace parent but cannot mutate staging or ancestors", async t => {
  const f = fixture(t, addon), parent = join(f.workspace, "parent"); mkdirSync(parent);
  const held = succeeded(f.open(f.stage, parent)), original = identity(parent), tree = stagedTree(addon, held);
  const repository = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const { compileExecutionSandboxPolicy, createDefaultApprovalPolicy, permissionModeForPreset, resolveSessionRunPolicy } =
    await import(join(repository, "packages/core/dist/index.js"));
  const { MACOS_SYSTEM_READ_ROOTS, buildMacosSeatbeltProfile } =
    await import(join(repository, "packages/daemon/dist/runtime/sandbox/macos-seatbelt-profile.js"));
  const { macosSandboxCommandFingerprint, prepareMacosSandboxCommand, readMacosSandboxBackendIdentity } =
    await import(join(repository, "packages/daemon/dist/runtime/sandbox/macos-native-command.js"));
  const executable = process.execPath;
  const actor = String.raw`
    const fs = require("node:fs"), p = require("node:path"), facts = JSON.parse(process.argv[1]);
    const attempts = [];
    const attempt = (operation, action) => { try { action(); attempts.push({operation,success:true}); }
      catch(e) { attempts.push({operation,success:false,code:e.code,errno:e.errno}); } };
    attempt("workspace-write", () => fs.writeFileSync(p.join(facts.workspace,"actor-control"),"allowed"));
    attempt("scratch-write", () => fs.writeFileSync(p.join(facts.scratch,"actor-control"),"allowed"));
    attempt("stage-create", () => fs.writeFileSync(p.join(facts.stage,"foreign"),"forbidden"));
    attempt("stage-child-replace", () => fs.renameSync(p.join(facts.stage,"native-tree"),p.join(facts.stage,"foreign-tree")));
    attempt("stage-unlink", () => fs.unlinkSync(p.join(facts.stage,"native-tree/nested/report.docx")));
    attempt("stage-mkdir", () => fs.mkdirSync(p.join(facts.stage,"foreign-dir")));
    attempt("ancestor-rename", () => fs.renameSync(facts.host,facts.host+"-moved"));
    attempt("workspace-parent-replace", () => {fs.renameSync(facts.parent,facts.parent+"-original");fs.mkdirSync(facts.parent);
      fs.writeFileSync(p.join(facts.parent,"foreign"),"untouched");});
    console.log(JSON.stringify({uid:process.getuid(),pid:process.pid,attempts}));
  `;
  const facts = { ...f, open: undefined, parent };
  const command = { kind: "argv", argv: [executable, "-e", actor, JSON.stringify(facts)] };
  const now = new Date().toISOString(), backend = readMacosSandboxBackendIdentity();
  const policy = resolveSessionRunPolicy({ workspacePolicy: createDefaultApprovalPolicy("native-isolated-test", now),
    permissionPreset: "workspace_collaboration", permissionMode: permissionModeForPreset("workspace_collaboration") }).snapshot;
  const compiled = compileExecutionSandboxPolicy({ now, platform: "darwin", tool: "bash", workspaceRoot: f.workspace,
    cwd: f.workspace, temporaryRoot: f.scratch, runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS, dirname(executable)],
    deniedReadRoots: [f.host], protectedWriteRoots: [f.host], backend, grants: [], policy,
    binding: { workspaceId: "native-isolated-test", runId: "test-run", workUnitId: "test-unit", attemptId: "test-attempt",
      runtimeInstanceId: "test-runtime", fencingToken: "1", toolCallId: "test-call",
      operationHash: macosSandboxCommandFingerprint(command, f.workspace, f.scratch) } });
  const profile = buildMacosSeatbeltProfile(compiled), prepared = prepareMacosSandboxCommand({ policy: compiled, command });
  let stdout = "", stderr = "";
  try {
    const child = prepared.spawn(() => {});
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", text => { stdout += text; }); child.stderr.on("data", text => { stderr += text; });
    const result = await new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("actor_timeout")); }, 10000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timeout); resolveResult({ code, signal }); });
    });
    assert.equal(result.code, 0, stderr); assert.equal(result.signal, null);
    const actorResult = JSON.parse(stdout.trim()); assert.equal(actorResult.uid, process.getuid());
    for (const attempt of actorResult.attempts) {
      if (["workspace-write", "scratch-write", "workspace-parent-replace"].includes(attempt.operation)) assert.equal(attempt.success, true);
      else { assert.equal(attempt.success, false, JSON.stringify(attempt)); assert.equal(attempt.code, "EPERM"); }
    }
    const foreign = identity(parent); assert.notDeepEqual(foreign, original);
    succeeded(addon.installTree(held.session, tree.top.capability, "published", "install-original-parent"));
    assert.equal(existsSync(join(parent, "published")), false);
    assert.equal(readFileSync(join(parent, "foreign"), "utf8"), "untouched");
    assert.equal(existsSync(join(parent + "-original", "published/nested/report.docx")), true);
    evidence({ case: "real-controlled-actor-kernel-test", backend, policyDigest: compiled.policyDigest,
      policyHash: prepared.policyHash, profileSha256: createHash("sha256").update(profile).digest("hex"), actor: actorResult,
      originalParent: original, foreignParent: foreign, inheritedOfficeCapabilities: "none_passed",
      authorityScope: "test actor only; not full Host bootstrap/Core/packaged receipt", stderr });
  } finally {
    // This direct launcher owns no disposable namespace/FDs and has no dispose
    // method. The child close event was drained above; fixture cleanup is t.after.
  }
});

test("real close EBADF tombstones original lifetime before descriptor-number reuse", t => {
  const f = fixture(t, addon);
  const result = spawnSync(process.env.OFFICE_LOCAL_LIFETIME_TEST, [f.stage, f.workspace], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
  const native = JSON.parse(result.stdout.trim()); assert.equal(native.retryRejected, true);
  assert.equal(native.foreignDescriptorStillOpen, true); assert.equal(native.explicitCloseSuccess, false);
  evidence({ case: "real-native-close-unknown", native });
});
