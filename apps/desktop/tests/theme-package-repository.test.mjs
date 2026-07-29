import assert from "node:assert/strict";
import { access, cp, link, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import {
  archiveFor,
  archiveRequest,
  createRepositoryFixture,
  errno,
  IMAGE_BYTES,
  rewriteInstallation,
  sha256,
} from "./theme-package-repository-fixtures.mjs";
import { DesktopThemePackageRepository } from "../dist/main/theme-packages/theme-package-repository.js";

test("repository initializes an empty injected root and installs with a verified final re-read", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const bootstrap = await fixture.repository.initialize();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.value.repositoryRevision, 1);
  assert.deepEqual(bootstrap.value.packages, []);
  assert.equal(bootstrap.value.activeGuardReady, false);

  const bytes = archiveFor("quiet-focus", { license: "MIT" });
  const installed = await fixture.repository.install(archiveRequest(bytes));
  assert.equal(installed.ok, true);
  assert.equal(installed.value.themeId, "quiet-focus");
  assert.equal(installed.value.health, "ready");
  assert.equal(installed.value.recordRevision, 2);
  assert.equal(installed.value.packageChecksumSha256, sha256(bytes));
  assert.deepEqual(installed.warnings, []);
  assert.equal(await readFile(join(fixture.themesRoot, "quiet-focus", "theme.json"), "utf8").then((value) => value.endsWith("\n")), true);

  const read = await fixture.repository.read({ themeId: "quiet-focus", includePreviewBytes: false });
  assert.equal(read.ok, true);
  assert.equal(read.value.licenseText, "MIT");
  const duplicate = await fixture.repository.install(archiveRequest(bytes, { requestId: "duplicate-install" }));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, "theme_already_installed");
});

test("same-id reimport preserves installedAt while identity, checksum and revision guards fail closed", async (t) => {
  let tick = 0;
  const times = [
    "2026-07-26T00:00:00.000Z",
    "2026-07-26T00:00:01.000Z",
    "2026-07-26T00:00:02.000Z",
    "2026-07-26T00:00:03.000Z",
    "2026-07-26T00:00:04.000Z",
    "2026-07-26T00:00:05.000Z",
    "2026-07-26T00:00:06.000Z",
    "2026-07-26T00:00:07.000Z",
  ];
  const fixture = await createRepositoryFixture({ now: () => times[Math.min(tick++, times.length - 1)] });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const initialBytes = archiveFor("quiet-focus", { name: "Initial" });
  const initial = await fixture.repository.install(archiveRequest(initialBytes));
  assert.equal(initial.ok, true);

  const updatedBytes = archiveFor("quiet-focus", { name: "Updated" });
  const updated = await fixture.repository.reimport({
    ...archiveRequest(updatedBytes, { requestId: "reimport-1" }),
    themeId: "quiet-focus",
    expectedCurrentChecksumSha256: initial.value.packageChecksumSha256,
    expectedRecordRevision: initial.value.recordRevision,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.value.installedAt, initial.value.installedAt);
  assert.notEqual(updated.value.updatedAt, initial.value.updatedAt);
  assert.equal(updated.value.manifest.name, "Updated");

  const differentId = await fixture.repository.reimport({
    ...archiveRequest(archiveFor("another-theme"), { requestId: "wrong-id" }),
    themeId: "quiet-focus",
    expectedCurrentChecksumSha256: updated.value.packageChecksumSha256,
    expectedRecordRevision: updated.value.recordRevision,
  });
  assert.equal(differentId.ok, false);
  assert.equal(differentId.error.code, "theme_id_mismatch");

  const staleRevision = await fixture.repository.reimport({
    ...archiveRequest(updatedBytes, { requestId: "stale-revision" }),
    themeId: "quiet-focus",
    expectedCurrentChecksumSha256: updated.value.packageChecksumSha256,
    expectedRecordRevision: initial.value.recordRevision,
  });
  assert.equal(staleRevision.ok, false);
  assert.equal(staleRevision.error.code, "stale_repository_revision");

  const staleChecksum = await fixture.repository.reimport({
    ...archiveRequest(updatedBytes, { requestId: "stale-checksum" }),
    themeId: "quiet-focus",
    expectedCurrentChecksumSha256: "a".repeat(64),
    expectedRecordRevision: updated.value.recordRevision,
  });
  assert.equal(staleChecksum.ok, false);
  assert.equal(staleChecksum.error.code, "checksum_mismatch");
});

test("delete enforces unknown, active and built-in guards then commits through trash", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const installed = await fixture.repository.install(archiveRequest(archiveFor("quiet-focus")));
  assert.equal(installed.ok, true);
  const request = {
    requestId: "delete-1",
    themeId: "quiet-focus",
    expectedCurrentChecksumSha256: installed.value.packageChecksumSha256,
    expectedRecordRevision: installed.value.recordRevision,
  };
  const unknown = await fixture.repository.delete(request);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "active_theme_unknown");

  assert.equal((await fixture.repository.setActive({ themeId: "quiet-focus" })).ok, true);
  const active = await fixture.repository.delete({ ...request, requestId: "delete-2" });
  assert.equal(active.ok, false);
  assert.equal(active.error.code, "active_theme_protected");
  assert.equal((await fixture.repository.setActive({ themeId: "ling-light" })).ok, true);

  const builtIn = await fixture.repository.delete({
    requestId: "delete-built-in",
    themeId: "ling-light",
    expectedRecordRevision: 1,
  });
  assert.equal(builtIn.ok, false);
  assert.equal(builtIn.error.code, "built_in_theme_protected");

  const deleted = await fixture.repository.delete({ ...request, requestId: "delete-3" });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.value.repositoryRevision, 3);
  await assert.rejects(access(join(fixture.themesRoot, "quiet-focus")));
  assert.deepEqual(await readFileList(join(fixture.themesRoot, ".trash")), []);
});

test("setActive accepts built-in and ready themes but rejects unknown and corrupt themes", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  assert.equal((await fixture.repository.install(archiveRequest(archiveFor("ready-theme")))).ok, true);
  assert.equal((await fixture.repository.install(archiveRequest(
    archiveFor("corrupt-theme"),
    { requestId: "install-corrupt-theme" },
  ))).ok, true);

  const builtIn = await fixture.repository.setActive({ themeId: "ling-light" });
  assert.deepEqual(builtIn, {
    ok: true,
    value: { activeThemeId: "ling-light" },
    warnings: [],
  });
  const ready = await fixture.repository.setActive({ themeId: "ready-theme" });
  assert.deepEqual(ready, {
    ok: true,
    value: { activeThemeId: "ready-theme" },
    warnings: [],
  });
  const unknown = await fixture.repository.setActive({ themeId: "unknown-theme" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "theme_not_found");

  await writeFile(join(fixture.themesRoot, "corrupt-theme", "theme.json"), "{}\n");
  const restarted = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1280, height: 800 }),
  });
  assert.equal((await restarted.initialize()).ok, true);
  const corrupt = await restarted.setActive({ themeId: "corrupt-theme" });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.error.code, "theme_not_found");
});

test("corrupt installations remain visible and can be reimported or deleted by record revision", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const installed = await fixture.repository.install(archiveRequest(archiveFor("quiet-focus")));
  assert.equal(installed.ok, true);
  await writeFile(join(fixture.themesRoot, "quiet-focus", "theme.json"), "{}\n");

  const restarted = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1280, height: 800 }),
  });
  const bootstrap = await restarted.initialize();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.value.packages[0].health, "corrupt");
  assert.equal(bootstrap.value.packages[0].recordRevision, 1);

  const repaired = await restarted.reimport({
    ...archiveRequest(archiveFor("quiet-focus", { name: "Repaired" }), { requestId: "repair-corrupt" }),
    themeId: "quiet-focus",
    expectedRecordRevision: 1,
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.value.health, "ready");

  await writeFile(join(fixture.themesRoot, "quiet-focus", "theme.json"), "{}\n");
  const corruptAgain = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1280, height: 800 }),
  });
  assert.equal((await corruptAgain.initialize()).ok, true);
  assert.equal((await corruptAgain.setActive({ themeId: "ling-light" })).ok, true);
  const deleted = await corruptAgain.delete({ requestId: "delete-corrupt", themeId: "quiet-focus", expectedRecordRevision: 1 });
  assert.equal(deleted.ok, true);
});

test("mutations serialize and identical request IDs dedupe both in-flight and completed results", async (t) => {
  let activeWrites = 0;
  let maximumWrites = 0;
  let candidateManifestWrites = 0;
  const fixture = await createRepositoryFixture({
    hooks: {
      beforeWrite: async (path) => {
        if (!path.endsWith("candidate/theme.json")) return;
        candidateManifestWrites += 1;
        activeWrites += 1;
        maximumWrites = Math.max(maximumWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeWrites -= 1;
      },
    },
  });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const alpha = archiveRequest(archiveFor("alpha-theme"), { requestId: "same-request" });
  const [first, duplicate] = await Promise.all([
    fixture.repository.install(alpha),
    fixture.repository.install(structuredClone(alpha)),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal(candidateManifestWrites, 1);
  const replay = await fixture.repository.install(structuredClone(alpha));
  assert.deepEqual(replay, first);
  assert.equal(candidateManifestWrites, 1);

  const [beta, gamma] = await Promise.all([
    fixture.repository.install(archiveRequest(archiveFor("beta-theme"), { requestId: "beta" })),
    fixture.repository.install(archiveRequest(archiveFor("gamma-theme"), { requestId: "gamma" })),
  ]);
  assert.equal(beta.ok, true);
  assert.equal(gamma.ok, true);
  assert.equal(maximumWrites, 1);

  const mismatch = await fixture.repository.install(archiveRequest(archiveFor("delta-theme"), { requestId: "same-request" }));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "invalid_request");
});

test("install, reimport and delete share one mutation queue", async (t) => {
  let trackMutations = false;
  let activeRenames = 0;
  let maximumRenames = 0;
  const fixture = await createRepositoryFixture({
    hooks: {
      beforeRename: async () => {
        if (!trackMutations) return;
        activeRenames += 1;
        maximumRenames = Math.max(maximumRenames, activeRenames);
        await new Promise((resolve) => setTimeout(resolve, 8));
        activeRenames -= 1;
      },
    },
  });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const reimported = await fixture.repository.install(archiveRequest(
    archiveFor("queue-reimport", { name: "Before" }),
    { requestId: "seed-reimport" },
  ));
  const deleted = await fixture.repository.install(archiveRequest(
    archiveFor("queue-delete"),
    { requestId: "seed-delete" },
  ));
  assert.equal(reimported.ok, true);
  assert.equal(deleted.ok, true);
  assert.equal((await fixture.repository.setActive({ themeId: "ling-light" })).ok, true);

  trackMutations = true;
  const results = await Promise.all([
    fixture.repository.install(archiveRequest(
      archiveFor("queue-install"),
      { requestId: "queue-install" },
    )),
    fixture.repository.reimport({
      ...archiveRequest(
        archiveFor("queue-reimport", { name: "After" }),
        { requestId: "queue-reimport" },
      ),
      themeId: "queue-reimport",
      expectedCurrentChecksumSha256: reimported.value.packageChecksumSha256,
      expectedRecordRevision: reimported.value.recordRevision,
    }),
    fixture.repository.delete({
      requestId: "queue-delete",
      themeId: "queue-delete",
      expectedCurrentChecksumSha256: deleted.value.packageChecksumSha256,
      expectedRecordRevision: deleted.value.recordRevision,
    }),
  ]);

  assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
  assert.equal(maximumRenames, 1);
  const packages = await fixture.repository.list();
  assert.equal(packages.ok, true);
  assert.deepEqual(packages.value.map((entry) => entry.themeId), ["queue-install", "queue-reimport"]);
  assert.equal(packages.value.find((entry) => entry.themeId === "queue-reimport")?.manifest?.name, "After");
});

test("reimport and delete dedupe in-flight and completed request IDs", async (t) => {
  let reimportCandidateWrites = 0;
  let deleteRenames = 0;
  const fixture = await createRepositoryFixture({
    hooks: {
      beforeWrite: async (path) => {
        if (!path.endsWith("candidate/theme.json")) return;
        reimportCandidateWrites += 1;
        await new Promise((resolve) => setTimeout(resolve, 8));
      },
      beforeRename: async ({ destinationRelativePath }) => {
        if (!destinationRelativePath.startsWith(".trash/")) return;
        deleteRenames += 1;
        await new Promise((resolve) => setTimeout(resolve, 8));
      },
    },
  });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const reimported = await fixture.repository.install(archiveRequest(
    archiveFor("dedupe-reimport", { name: "Before" }),
    { requestId: "seed-dedupe-reimport" },
  ));
  const deleted = await fixture.repository.install(archiveRequest(
    archiveFor("dedupe-delete"),
    { requestId: "seed-dedupe-delete" },
  ));
  assert.equal(reimported.ok, true);
  assert.equal(deleted.ok, true);
  assert.equal((await fixture.repository.setActive({ themeId: "ling-dark" })).ok, true);
  reimportCandidateWrites = 0;

  const reimportRequest = {
    ...archiveRequest(
      archiveFor("dedupe-reimport", { name: "After" }),
      { requestId: "dedupe-reimport-request" },
    ),
    themeId: "dedupe-reimport",
    expectedCurrentChecksumSha256: reimported.value.packageChecksumSha256,
    expectedRecordRevision: reimported.value.recordRevision,
  };
  const [firstReimport, duplicateReimport] = await Promise.all([
    fixture.repository.reimport(reimportRequest),
    fixture.repository.reimport(structuredClone(reimportRequest)),
  ]);
  assert.deepEqual(duplicateReimport, firstReimport);
  assert.equal(firstReimport.ok, true);
  assert.equal(reimportCandidateWrites, 1);
  assert.deepEqual(await fixture.repository.reimport(structuredClone(reimportRequest)), firstReimport);
  assert.equal(reimportCandidateWrites, 1);

  const deleteRequest = {
    requestId: "dedupe-delete-request",
    themeId: "dedupe-delete",
    expectedCurrentChecksumSha256: deleted.value.packageChecksumSha256,
    expectedRecordRevision: deleted.value.recordRevision,
  };
  const [firstDelete, duplicateDelete] = await Promise.all([
    fixture.repository.delete(deleteRequest),
    fixture.repository.delete(structuredClone(deleteRequest)),
  ]);
  assert.deepEqual(duplicateDelete, firstDelete);
  assert.equal(firstDelete.ok, true);
  assert.equal(deleteRenames, 1);
  assert.deepEqual(await fixture.repository.delete(structuredClone(deleteRequest)), firstDelete);
  assert.equal(deleteRenames, 1);
});

test("mutex and request dedupe are shared by repository instances for the same injected root", async (t) => {
  let activeWrites = 0;
  let maximumWrites = 0;
  let candidateWrites = 0;
  const hooks = {
    beforeWrite: async (path) => {
      if (!path.endsWith("candidate/theme.json")) return;
      candidateWrites += 1;
      activeWrites += 1;
      maximumWrites = Math.max(maximumWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 8));
      activeWrites -= 1;
    },
  };
  const fixture = await createRepositoryFixture({ hooks });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const second = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1, height: 1 }),
    hooks,
  });
  assert.equal((await fixture.repository.initialize()).ok, true);
  assert.equal((await second.initialize()).ok, true);
  const [alpha, beta] = await Promise.all([
    fixture.repository.install(archiveRequest(archiveFor("root-alpha"), { requestId: "root-alpha" })),
    second.install(archiveRequest(archiveFor("root-beta"), { requestId: "root-beta" })),
  ]);
  assert.equal(alpha.ok, true);
  assert.equal(beta.ok, true);
  assert.equal(maximumWrites, 1);

  const shared = archiveRequest(archiveFor("root-shared"), { requestId: "root-shared" });
  const [sharedFirst, sharedSecond] = await Promise.all([
    fixture.repository.install(shared),
    second.install(structuredClone(shared)),
  ]);
  assert.deepEqual(sharedSecond, sharedFirst);
  assert.equal(candidateWrites, 3);
  const restarted = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1, height: 1 }),
  });
  const bootstrap = await restarted.initialize();
  assert.equal(bootstrap.ok, true);
  assert.deepEqual(bootstrap.value.packages.map((entry) => entry.themeId), ["root-alpha", "root-beta", "root-shared"]);
});

test("write, fsync, rename and cleanup faults map to typed outcomes without exposing a partial final", async (t) => {
  for (const scenario of [
    { name: "write", hook: "beforeWrite", code: "ENOSPC", expected: "disk_full" },
    { name: "fsync", hook: "beforeFsync", code: "EIO", expected: "unknown_io" },
    { name: "rename", hook: "beforeRename", code: "EACCES", expected: "permission_denied" },
    { name: "cross-volume", hook: "beforeRename", code: "EXDEV", expected: "storage_unavailable" },
  ]) {
    const fixture = await createRepositoryFixture({
      hooks: {
        [scenario.hook]: async (...args) => {
          const path = scenario.hook === "beforeRename" ? args[0].destinationRelativePath : args[0];
          if (String(path).includes("operation") && scenario.name !== "rename") return;
          throw errno(scenario.code);
        },
      },
    });
    t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
    await fixture.repository.initialize();
    const result = await fixture.repository.install(archiveRequest(archiveFor(`${scenario.name}-theme`), { requestId: scenario.name }));
    assert.equal(result.ok, false, scenario.name);
    assert.equal(result.error.code, scenario.expected, scenario.name);
    await assert.rejects(access(join(fixture.themesRoot, `${scenario.name}-theme`)));
  }

  let cleanupFailure = true;
  const cleanup = await createRepositoryFixture({
    hooks: {
      beforeRemove: async (path) => {
        if (cleanupFailure && path.startsWith(".staging/")) {
          cleanupFailure = false;
          throw errno("EACCES");
        }
      },
    },
  });
  t.after(() => rm(cleanup.temporaryRoot, { recursive: true, force: true }));
  await cleanup.repository.initialize();
  const installed = await cleanup.repository.install(archiveRequest(archiveFor("cleanup-theme")));
  assert.equal(installed.ok, true);
  assert.equal(installed.warnings[0].code, "cleanup_pending");
});

test("renderer checksum mismatch and post-publication journal failure never return an installed result", async (t) => {
  const checksumFixture = await createRepositoryFixture();
  t.after(() => rm(checksumFixture.temporaryRoot, { recursive: true, force: true }));
  await checksumFixture.repository.initialize();
  const bytes = archiveFor("checksum-theme");
  const mismatch = await checksumFixture.repository.install({
    ...archiveRequest(bytes),
    rendererPackageChecksumSha256: "d".repeat(64),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "checksum_mismatch");
  await assert.rejects(access(join(checksumFixture.themesRoot, "checksum-theme")));

  let journalPublications = 0;
  const publicationFixture = await createRepositoryFixture({
    hooks: {
      beforeRename: async ({ destinationRelativePath }) => {
        if (!destinationRelativePath.endsWith("/operation.json")) return;
        journalPublications += 1;
        if (journalPublications === 3) throw errno("EIO");
      },
    },
  });
  t.after(() => rm(publicationFixture.temporaryRoot, { recursive: true, force: true }));
  await publicationFixture.repository.initialize();
  const publishedFailure = await publicationFixture.repository.install(
    archiveRequest(archiveFor("publication-theme"), { requestId: "publication-failure" }),
  );
  assert.equal(publishedFailure.ok, false);
  assert.equal(publishedFailure.error.code, "publication_failed");
  await assert.rejects(access(join(publicationFixture.themesRoot, "publication-theme")));

  const restarted = new DesktopThemePackageRepository({
    themesRoot: publicationFixture.themesRoot,
    decodeImage: async () => ({ width: 1, height: 1 }),
  });
  const bootstrap = await restarted.initialize();
  assert.equal(bootstrap.ok, true);
  assert.deepEqual(bootstrap.value.packages, []);
});

test("Windows rename retries are bounded to 50, 150 and 450 milliseconds", async (t) => {
  const sleeps = [];
  let failures = 0;
  const fixture = await createRepositoryFixture({
    platform: "win32",
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    hooks: {
      beforeRename: async () => {
        if (failures < 3) {
          failures += 1;
          throw errno("EBUSY");
        }
      },
    },
  });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const result = await fixture.repository.install(archiveRequest(archiveFor("windows-theme")));
  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [50, 150, 450]);
});

test("reimport publication failure restores old final and rollback failure remains diagnosable", async (t) => {
  let failCandidatePublish = false;
  let failRollbackRestore = false;
  const fixture = await createRepositoryFixture({
    hooks: {
      beforeRename: async ({ sourceRelativePath, destinationRelativePath }) => {
        if (failCandidatePublish && sourceRelativePath.endsWith("/candidate") && destinationRelativePath === "quiet-focus") {
          throw errno("EACCES");
        }
        if (failRollbackRestore && sourceRelativePath.startsWith(".rollback/") && destinationRelativePath === "quiet-focus") {
          throw errno("EACCES");
        }
      },
    },
  });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const initial = await fixture.repository.install(archiveRequest(archiveFor("quiet-focus", { name: "Old" })));
  assert.equal(initial.ok, true);
  failCandidatePublish = true;
  const failed = await fixture.repository.reimport({
    ...archiveRequest(archiveFor("quiet-focus", { name: "New" }), { requestId: "restore-old" }),
    themeId: "quiet-focus",
    expectedCurrentChecksumSha256: initial.value.packageChecksumSha256,
    expectedRecordRevision: initial.value.recordRevision,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "permission_denied");
  const reread = await fixture.repository.read({ themeId: "quiet-focus", includePreviewBytes: false });
  assert.equal(reread.ok, true);
  assert.equal(reread.value.descriptor.manifest.name, "Old");

  failRollbackRestore = true;
  const rollbackFailed = await fixture.repository.reimport({
    ...archiveRequest(archiveFor("quiet-focus", { name: "Newest" }), { requestId: "rollback-fails" }),
    themeId: "quiet-focus",
    expectedCurrentChecksumSha256: initial.value.packageChecksumSha256,
    expectedRecordRevision: initial.value.recordRevision,
  });
  assert.equal(rollbackFailed.ok, false);
  assert.equal(rollbackFailed.error.code, "rollback_failed");
  assert.equal(typeof rollbackFailed.error.operationId, "string");
  assert.equal((await readFileList(join(fixture.themesRoot, ".staging"))).length > 0, true);
  assert.equal((await readFileList(join(fixture.themesRoot, ".rollback"))).length > 0, true);
});

test("root, final, child symlink and hardlink installations are rejected without following links", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await mkdir(fixture.temporaryRoot, { recursive: true });
  const external = join(fixture.temporaryRoot, "external");
  await mkdir(external);
  await symlink(external, fixture.themesRoot);
  const rootSymlink = await fixture.repository.initialize();
  assert.equal(rootSymlink.ok, false);
  assert.equal(rootSymlink.error.code, "storage_unavailable");
  await rm(fixture.themesRoot);

  const clean = new DesktopThemePackageRepository({ themesRoot: fixture.themesRoot, decodeImage: async () => ({ width: 1, height: 1 }) });
  await clean.initialize();
  await symlink(external, join(fixture.themesRoot, "linked-theme"));
  const linkedRestart = new DesktopThemePackageRepository({ themesRoot: fixture.themesRoot, decodeImage: async () => ({ width: 1, height: 1 }) });
  const linked = await linkedRestart.initialize();
  assert.equal(linked.ok, true);
  assert.equal(linked.value.packages[0].health, "corrupt");
  await rm(join(fixture.themesRoot, "linked-theme"));

  const installed = await clean.install(archiveRequest(archiveFor("quiet-focus")));
  assert.equal(installed.ok, true);
  await symlink(external, join(fixture.themesRoot, "quiet-focus", "assets"));
  const childRestart = new DesktopThemePackageRepository({ themesRoot: fixture.themesRoot, decodeImage: async () => ({ width: 1, height: 1 }) });
  assert.equal((await childRestart.initialize()).value.packages[0].health, "corrupt");
  await rm(join(fixture.themesRoot, "quiet-focus", "assets"));

  const outsideLink = join(fixture.temporaryRoot, "hardlink-theme.json");
  await link(join(fixture.themesRoot, "quiet-focus", "theme.json"), outsideLink);
  const hardlinkRestart = new DesktopThemePackageRepository({ themesRoot: fixture.themesRoot, decodeImage: async () => ({ width: 1, height: 1 }) });
  assert.equal((await hardlinkRestart.initialize()).value.packages[0].health, "corrupt");
});

test("special filesystem entries mark an installation corrupt", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  assert.equal((await fixture.repository.install(archiveRequest(archiveFor("socket-theme")))).ok, true);
  const socketPath = join(fixture.themesRoot, "socket-theme", "runtime.sock");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const restarted = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1, height: 1 }),
  });
  const bootstrap = await restarted.initialize();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.value.packages[0].health, "corrupt");
});

test("metadata path, size, checksum, MIME and manifest schema corruption are detected", async (t) => {
  const mutations = [
    ["path", async (root) => rewriteInstallation(root, (record) => ({
      ...record,
      files: record.files.map((file) => file.path === "theme.json" ? { ...file, path: "../theme.json" } : file),
    }))],
    ["extra-path", async (root) => writeFile(join(root, "extra.txt"), "unexpected")],
    ["size", async (root) => rewriteInstallation(root, (record) => ({ ...record, files: record.files.map((file) => file.path === "theme.json" ? { ...file, byteLength: file.byteLength + 1 } : file) }))],
    ["checksum", async (root) => rewriteInstallation(root, (record) => ({ ...record, files: record.files.map((file) => file.path === "theme.json" ? { ...file, checksumSha256: "0".repeat(64) } : file) }))],
    ["mime", async (root) => rewriteInstallation(root, (record) => ({ ...record, files: record.files.map((file) => file.path === "theme.json" ? { ...file, mimeType: "text/plain" } : file) }))],
    ["schema", async (root) => {
      const manifestPath = join(root, "theme.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const bytes = new TextEncoder().encode(`${JSON.stringify({ ...manifest, schemaVersion: 2 }, null, 2)}\n`);
      await writeFile(manifestPath, bytes);
      await rewriteInstallation(root, (record) => ({
        ...record,
        manifestChecksumSha256: sha256(bytes),
        files: record.files.map((file) => file.path === "theme.json" ? { ...file, byteLength: bytes.byteLength, checksumSha256: sha256(bytes) } : file),
      }));
    }],
  ];
  for (const [name, mutate] of mutations) {
    const fixture = await createRepositoryFixture();
    t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
    await fixture.repository.initialize();
    assert.equal((await fixture.repository.install(archiveRequest(archiveFor(`${name}-theme`), { requestId: name }))).ok, true);
    await mutate(join(fixture.themesRoot, `${name}-theme`));
    const restarted = new DesktopThemePackageRepository({ themesRoot: fixture.themesRoot, decodeImage: async () => ({ width: 1, height: 1 }) });
    const bootstrap = await restarted.initialize();
    assert.equal(bootstrap.ok, true, name);
    assert.equal(bootstrap.value.packages[0].health, "corrupt", name);
  }
});

test("preview MIME metadata corruption is rejected after native decode revalidation", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await fixture.repository.initialize();
  const bytes = archiveFor("preview-theme", {
    manifest: { preview: "assets/preview.png" },
    preview: { path: "assets/preview.png", bytes: IMAGE_BYTES.png },
  });
  const installed = await fixture.repository.install(archiveRequest(bytes));
  assert.equal(installed.ok, true);
  const packagePath = join(fixture.themesRoot, "preview-theme");
  await rewriteInstallation(packagePath, (record) => ({
    ...record,
    files: record.files.map((file) => file.path.startsWith("assets/") ? { ...file, mimeType: "text/plain" } : file),
  }));
  const restarted = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1280, height: 800 }),
  });
  const bootstrap = await restarted.initialize();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.value.packages[0].health, "corrupt");
});

async function readFileList(path) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}
