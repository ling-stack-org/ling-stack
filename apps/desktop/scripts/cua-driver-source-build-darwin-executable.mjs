import {
  constants as fsConstants,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { cuaDriverArtifactLayoutFor } from "../shared/cua-driver-artifact-layout.mjs";
import { fail } from "./cua-driver-source-build-promotion-records.mjs";

/**
 * GitHub Artifact archives preserve file bytes but not Darwin execute bits.
 * Restore only owner-execute on the fixed provider path, through an already
 * opened regular-file handle, before the committed verifier launches it.
 */
const NO_TEST_HOOKS = Object.freeze({});

export async function restoreDarwinCandidateExecutable(candidateRoot) {
  return restoreDarwinCandidateExecutableInternal(candidateRoot, NO_TEST_HOOKS);
}

export function createDarwinCandidateExecutableRestorerForTest(hooks = {}) {
  for (const key of ["afterRootLstat", "afterOpen", "afterModeRepair"]) {
    if (hooks[key] !== undefined && typeof hooks[key] !== "function") {
      throw new TypeError(`Darwin candidate executable test hook ${key} must be callable`);
    }
  }
  return (candidateRoot) => restoreDarwinCandidateExecutableInternal(candidateRoot, hooks);
}

async function restoreDarwinCandidateExecutableInternal(candidateRoot, hooks) {
  const candidateRootPath = resolve(candidateRoot);
  const rootBefore = await lstat(candidateRootPath, { bigint: true });
  assertSafeCandidateRoot(rootBefore);
  await hooks.afterRootLstat?.({ candidateRootPath });
  const rootCanonicalPath = await realpath(candidateRootPath);
  await assertBoundCandidateRoot(candidateRootPath, rootCanonicalPath, rootBefore);
  const executableName = cuaDriverArtifactLayoutFor("darwin").packagedExecutableName;
  const executablePath = join(candidateRootPath, "darwin", executableName);
  const namedBefore = await lstatCandidateExecutable(executablePath);
  assertSafeCandidateExecutable(namedBefore);
  const expectedCanonicalPath = join(rootCanonicalPath, "darwin", executableName);
  await assertCanonicalExecutablePath(executablePath, expectedCanonicalPath);

  let handle;
  try {
    handle = await open(
      executablePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      fail(
        "promotion_candidate_executable_symlink_forbidden",
        "Darwin candidate executable cannot be a symlink",
      );
    }
    throw error;
  }

  try {
    const opened = await handle.stat({ bigint: true });
    assertSafeCandidateExecutable(opened);
    await hooks.afterOpen?.({ executablePath });
    await assertNamedExecutableIdentity({
      executablePath,
      expectedCanonicalPath,
      identity: opened,
      prior: namedBefore,
    });
    await assertBoundCandidateRoot(candidateRootPath, rootCanonicalPath, rootBefore);

    const currentMode = Number(opened.mode) & 0o7777;
    if ((currentMode & 0o7022) !== 0) {
      fail(
        "promotion_candidate_executable_mode_unsafe",
        "Darwin candidate executable cannot be group/world-writable or use special mode bits",
      );
    }
    const expectedMode = currentMode | 0o100;
    if (currentMode !== expectedMode) {
      await handle.chmod(expectedMode);
    }
    await hooks.afterModeRepair?.({ executablePath });

    const repaired = await handle.stat({ bigint: true });
    assertSafeCandidateExecutable(repaired);
    if (!sameFileIdentity(opened, repaired)
      || (Number(repaired.mode) & 0o7777) !== expectedMode) {
      failChangedExecutable();
    }
    await assertNamedExecutableIdentity({
      executablePath,
      expectedCanonicalPath,
      identity: repaired,
      prior: repaired,
    });
    await assertBoundCandidateRoot(candidateRootPath, rootCanonicalPath, rootBefore);
  } finally {
    await handle.close();
  }
}

function assertSafeCandidateRoot(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(
      "promotion_candidate_root_symlink_forbidden",
      "Darwin candidate root must be a real directory",
    );
  }
}

async function assertBoundCandidateRoot(candidateRootPath, rootCanonicalPath, identity) {
  const named = await lstat(candidateRootPath, { bigint: true });
  assertSafeCandidateRoot(named);
  if (!sameFileIdentity(named, identity)
    || await realpath(candidateRootPath) !== rootCanonicalPath) {
    fail(
      "promotion_candidate_root_changed",
      "Darwin candidate root changed during permission repair",
    );
  }
}

async function lstatCandidateExecutable(executablePath) {
  try {
    return await lstat(executablePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(
        "promotion_candidate_executable_missing",
        "Darwin candidate executable is missing",
      );
    }
    throw error;
  }
}

function assertSafeCandidateExecutable(metadata) {
  if (metadata.isSymbolicLink()) {
    fail(
      "promotion_candidate_executable_symlink_forbidden",
      "Darwin candidate executable cannot be a symlink",
    );
  }
  if (!metadata.isFile()) {
    fail(
      "promotion_candidate_executable_non_regular",
      "Darwin candidate executable must be a regular file",
    );
  }
  if (metadata.nlink !== 1n) {
    fail(
      "promotion_candidate_executable_hardlink_forbidden",
      "Darwin candidate executable cannot be a hard link",
    );
  }
}

async function assertNamedExecutableIdentity({
  executablePath,
  expectedCanonicalPath,
  identity,
  prior,
}) {
  const named = await lstatCandidateExecutable(executablePath);
  assertSafeCandidateExecutable(named);
  if (!sameFileIdentity(prior, identity)
    || !sameFileIdentity(named, identity)) {
    failChangedExecutable();
  }
  await assertCanonicalExecutablePath(executablePath, expectedCanonicalPath);
}

async function assertCanonicalExecutablePath(executablePath, expectedCanonicalPath) {
  if (await realpath(executablePath) !== expectedCanonicalPath) {
    fail(
      "promotion_candidate_executable_symlink_forbidden",
      "Darwin candidate executable resolves through a symlinked path",
    );
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function failChangedExecutable() {
  fail(
    "promotion_candidate_executable_changed",
    "Darwin candidate executable changed during permission repair",
  );
}
