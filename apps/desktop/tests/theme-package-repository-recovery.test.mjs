import assert from "node:assert/strict";
import { access, cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  archiveFor,
  archiveRequest,
  createRepositoryFixture,
  writeJournal,
} from "./theme-package-repository-fixtures.mjs";
import { DesktopThemePackageRepository } from "../dist/main/theme-packages/theme-package-repository.js";

test("startup removes abandoned staging for staging and candidate-ready phases", async (t) => {
  for (const phase of ["staging", "candidate-ready"]) {
    const fixture = await installedFixture(t, `phase-${phase}`);
    const operationId = `${phase}-operation`;
    const operationPath = await writeJournal(fixture.themesRoot, {
      operationId,
      kind: "install",
      themeId: `phase-${phase}`,
      phase,
      candidateChecksumSha256: fixture.descriptor.packageChecksumSha256,
    });
    await cp(join(fixture.themesRoot, `phase-${phase}`), join(operationPath, "candidate"), { recursive: true });

    const bootstrap = await restart(fixture.themesRoot);
    assert.equal(bootstrap.result.ok, true, phase);
    assert.equal(bootstrap.result.value.packages[0].health, "ready", phase);
    await assert.rejects(access(operationPath));
  }
});

test("candidate-ready recovery restores a backup when the journal update lagged the first rename", async (t) => {
  const fixture = await installedFixture(t, "lagged-backup");
  const operationId = "candidate-lagged";
  const finalPath = join(fixture.themesRoot, "lagged-backup");
  const rollbackPath = join(fixture.themesRoot, ".rollback", `lagged-backup.${operationId}`);
  await rename(finalPath, rollbackPath);
  await writeJournal(fixture.themesRoot, {
    operationId,
    kind: "reimport",
    themeId: "lagged-backup",
    phase: "candidate-ready",
    expectedPreviousChecksumSha256: fixture.descriptor.packageChecksumSha256,
    candidateChecksumSha256: "a".repeat(64),
  });

  const bootstrap = await restart(fixture.themesRoot);
  assert.equal(bootstrap.result.ok, true);
  assert.equal(bootstrap.result.value.packages[0].health, "ready");
  assert.equal(await readFile(join(finalPath, "theme.json"), "utf8").then(Boolean), true);
  await assert.rejects(access(rollbackPath));
});

test("backup-created and published recovery choose valid final or restore valid rollback", async (t) => {
  for (const phase of ["backup-created", "published"]) {
    const finalWins = await installedFixture(t, `${phase}-final`);
    const finalOperation = `${phase}-final-op`;
    const finalPath = join(finalWins.themesRoot, `${phase}-final`);
    const rollbackPath = join(finalWins.themesRoot, ".rollback", `${phase}-final.${finalOperation}`);
    await cp(finalPath, rollbackPath, { recursive: true });
    await writeJournal(finalWins.themesRoot, {
      operationId: finalOperation,
      kind: "reimport",
      themeId: `${phase}-final`,
      phase,
      expectedPreviousChecksumSha256: finalWins.descriptor.packageChecksumSha256,
      candidateChecksumSha256: finalWins.descriptor.packageChecksumSha256,
    });
    const finalBootstrap = await restart(finalWins.themesRoot);
    assert.equal(finalBootstrap.result.ok, true, `${phase} final`);
    assert.equal(finalBootstrap.result.value.packages[0].health, "ready");
    await assert.rejects(access(rollbackPath));

    const rollbackWins = await installedFixture(t, `${phase}-rollback`);
    const rollbackOperation = `${phase}-rollback-op`;
    const corruptFinal = join(rollbackWins.themesRoot, `${phase}-rollback`);
    const validRollback = join(rollbackWins.themesRoot, ".rollback", `${phase}-rollback.${rollbackOperation}`);
    await cp(corruptFinal, validRollback, { recursive: true });
    await writeFile(join(corruptFinal, "theme.json"), "{}\n");
    await writeJournal(rollbackWins.themesRoot, {
      operationId: rollbackOperation,
      kind: "reimport",
      themeId: `${phase}-rollback`,
      phase,
      expectedPreviousChecksumSha256: rollbackWins.descriptor.packageChecksumSha256,
      candidateChecksumSha256: "b".repeat(64),
    });
    const rollbackBootstrap = await restart(rollbackWins.themesRoot);
    assert.equal(rollbackBootstrap.result.ok, true, `${phase} rollback`);
    assert.equal(rollbackBootstrap.result.value.packages[0].health, "ready");
    assert.notEqual(await readFile(join(corruptFinal, "theme.json"), "utf8"), "{}\n");
    await assert.rejects(access(validRollback));
  }
});

test("published recovery retains diagnostics when both final and rollback are corrupt", async (t) => {
  const fixture = await installedFixture(t, "both-corrupt");
  const operationId = "both-corrupt-op";
  const finalPath = join(fixture.themesRoot, "both-corrupt");
  const rollbackPath = join(fixture.themesRoot, ".rollback", `both-corrupt.${operationId}`);
  await cp(finalPath, rollbackPath, { recursive: true });
  await writeFile(join(finalPath, "theme.json"), "{}\n");
  await writeFile(join(rollbackPath, "theme.json"), "{}\n");
  const operationPath = await writeJournal(fixture.themesRoot, {
    operationId,
    kind: "reimport",
    themeId: "both-corrupt",
    phase: "published",
    expectedPreviousChecksumSha256: fixture.descriptor.packageChecksumSha256,
    candidateChecksumSha256: "c".repeat(64),
  });

  const bootstrap = await restart(fixture.themesRoot);
  assert.equal(bootstrap.result.ok, true);
  assert.equal(bootstrap.result.value.packages[0].health, "corrupt");
  assert.equal(await access(operationPath).then(() => true), true);
  assert.equal(await access(rollbackPath).then(() => true), true);
});

test("delete-staged recovery completes logical deletion and bounded trash cleanup", async (t) => {
  const fixture = await installedFixture(t, "deleted-theme");
  const operationId = "delete-staged-op";
  const finalPath = join(fixture.themesRoot, "deleted-theme");
  const trashPath = join(fixture.themesRoot, ".trash", `deleted-theme.${operationId}`);
  await rename(finalPath, trashPath);
  const operationPath = await writeJournal(fixture.themesRoot, {
    operationId,
    kind: "delete",
    themeId: "deleted-theme",
    phase: "delete-staged",
    expectedPreviousChecksumSha256: fixture.descriptor.packageChecksumSha256,
  });

  const bootstrap = await restart(fixture.themesRoot);
  assert.equal(bootstrap.result.ok, true);
  assert.deepEqual(bootstrap.result.value.packages, []);
  await assert.rejects(access(operationPath));
  await assert.rejects(access(trashPath));
});

test("startup removes no-journal staging and trash but never touches unrelated external data", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  assert.equal((await fixture.repository.initialize()).ok, true);
  const abandoned = join(fixture.themesRoot, ".staging", "abandoned");
  const trash = join(fixture.themesRoot, ".trash", "abandoned-theme.operation");
  const external = join(fixture.temporaryRoot, "external.txt");
  const externalDirectory = join(fixture.temporaryRoot, "external-directory");
  await mkdir(abandoned, { recursive: true });
  await mkdir(trash, { recursive: true });
  await writeFile(join(abandoned, "partial"), "partial");
  await writeFile(join(trash, "partial"), "partial");
  await writeFile(external, "keep");
  await mkdir(externalDirectory);
  await writeFile(join(externalDirectory, "keep.txt"), "keep-link-target");
  const abandonedLink = join(fixture.themesRoot, ".staging", "abandoned-link");
  await symlink(externalDirectory, abandonedLink);

  const bootstrap = await restart(fixture.themesRoot);
  assert.equal(bootstrap.result.ok, true);
  await assert.rejects(access(abandoned));
  await assert.rejects(access(trash));
  await assert.rejects(access(abandonedLink));
  assert.equal(await readFile(external, "utf8"), "keep");
  assert.equal(await readFile(join(externalDirectory, "keep.txt"), "utf8"), "keep-link-target");
});

test("recovery cleanup failure is a typed success warning rather than bootstrap failure", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  assert.equal((await fixture.repository.initialize()).ok, true);
  const trash = join(fixture.themesRoot, ".trash", "cleanup-failure.operation");
  await mkdir(trash, { recursive: true });
  await writeFile(join(trash, "partial"), "partial");
  const repository = new DesktopThemePackageRepository({
    themesRoot: fixture.themesRoot,
    decodeImage: async () => ({ width: 1, height: 1 }),
    hooks: {
      beforeRemove: async (path) => {
        if (path.includes("cleanup-failure")) throw Object.assign(new Error("permission"), { code: "EACCES" });
      },
    },
  });
  const bootstrap = await repository.initialize();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.value.recoveryWarnings[0].code, "cleanup_pending");
});

async function installedFixture(t, themeId) {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  assert.equal((await fixture.repository.initialize()).ok, true);
  const installed = await fixture.repository.install(archiveRequest(archiveFor(themeId), { requestId: `install-${themeId}` }));
  assert.equal(installed.ok, true);
  return { ...fixture, descriptor: installed.value };
}

async function restart(themesRoot, options = {}) {
  const repository = new DesktopThemePackageRepository({
    themesRoot,
    decodeImage: async () => ({ width: 1280, height: 800 }),
    ...options,
  });
  return { repository, result: await repository.initialize() };
}
