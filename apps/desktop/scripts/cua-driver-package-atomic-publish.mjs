import {
  execFile as execFileCallback,
  spawn,
} from "node:child_process";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, TextDecoder } from "node:util";

const execFile = promisify(execFileCallback);
const NATIVE_SOURCE_PATH = fileURLToPath(
  new URL("./native/cua-driver-package-atomic-publish.cc", import.meta.url),
);
const NATIVE_OUTPUT_NAME = process.platform === "win32"
  ? "cua-driver-package-atomic-publish.exe"
  : "cua-driver-package-atomic-publish";
const NATIVE_OUTPUT_MAX_BYTES = 16 * 1024;
const NATIVE_BUILD_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const NATIVE_BUILD_TIMEOUT_MS = 120_000;
const NATIVE_PUBLISH_TIMEOUT_MS = 30_000;
const NATIVE_PARENT_LEASE_MAX_TIMEOUT_MS = 120_000;
const NATIVE_PARENT_LEASE_PROTOCOL_GRACE_MS = 5_000;
const NATIVE_PARENT_LEASE_RELEASE_TIMEOUT_MS = 5_000;
const NATIVE_PARENT_LEASE_RPC_PROTOCOL = "LCRPC1";
const NATIVE_PARENT_LEASE_RPC_MAX_BYTES = 16 * 1024;
const PRIVATE_BUILD_PREFIX = "ling-cua-package-publish-";
const NATIVE_REMOVAL_MAX_ENTRIES = 64;
const NATIVE_REMOVAL_MAX_BYTES = 558_891_008;
const NATIVE_ARTIFACT_REMOVAL_MAX_ENTRIES = 100_000;
const NATIVE_ARTIFACT_REMOVAL_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const ARTIFACT_REMOVAL_POLICY = "artifact";
const DARWIN_ARTIFACT_SYMLINK_REMOVAL_POLICY = "darwin-artifact-symlinks";
const SUCCESS_OUTCOMES = new Set([
  "committed",
  "inspected",
  "locked",
  "removed",
  "released",
  "secured",
  "verified",
]);
const NATIVE_OUTCOMES = new Set([
  ...SUCCESS_OUTCOMES,
  "not_committed",
  "ambiguous",
]);
const NATIVE_RECEIPT_BASE_FIELDS = new Set([
  "nativeCode",
  "outcome",
  "platform",
  "reason",
  "schemaVersion",
]);
const NATIVE_PARENT_LEASE_OPERATIONS = new Set([
  "inspect",
  "publish",
  "remove-artifact-tree",
  "remove-tree",
  "remove-unsecured-empty",
  "secure-private",
  "verify-private",
]);
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

let nativePublisherPromise;
const nativeParentLeaseCapabilities = new WeakMap();

export class CuaDriverAtomicPublishError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "CuaDriverAtomicPublishError";
    this.code = code;
    this.outcome = details.outcome ?? "not_committed";
    this.nativeReason = details.nativeReason;
    this.nativeCode = details.nativeCode;
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

/** Build and identity-check the fixed native helper before package bytes exist. */
export async function preflightAtomicPublishDirectoryNoReplace() {
  const nativePublisher = await getNativePublisher();
  await assertNativePublisherIdentity(nativePublisher);
  const receipt = await invokeNativeOperation(nativePublisher, ["probe"]);
  if (receipt.outcome !== "inspected" || receipt.reason !== "inspected") {
    throw nativeProtocolError("native publisher feature probe failed");
  }
  return Object.freeze({
    schemaVersion: 1,
    platform: process.platform === "darwin" ? "darwin" : "win32",
  });
}

/**
 * Serialize every staging or cleanup mutation for one canonical output parent
 * across Node processes. The native helper owns both the OS lock and every
 * lease-scoped mutation; holder exit releases the lock only after its current
 * synchronous RPC operation has stopped.
 */
export async function withAtomicPublishParentLease(input, operation) {
  requireParentLeaseOperation(operation);
  const parentRoot = await requireCanonicalParent(input?.parentRoot);
  const timeoutMs = requireParentLeaseTimeout(input?.timeoutMs);
  const nativePublisher = await getNativePublisher();
  await assertNativePublisherIdentity(nativePublisher);
  const lease = await acquireAtomicPublishParentLease({
    nativePublisher,
    parentRoot,
    timeoutMs,
  });

  return runAtomicPublishParentLeaseOperation(lease, operation);
}

/**
 * Test-only holder seam for exercising the production LCRPC1 client against a
 * deterministic child process. The supplied command must emit a valid locked
 * receipt before accepting RPC frames on stdin.
 */
export async function withAtomicPublishParentLeaseForTest(input, operation) {
  requireParentLeaseOperation(operation);
  const parentRoot = await requireCanonicalParent(input?.parentRoot);
  const timeoutMs = requireParentLeaseTimeout(input?.timeoutMs);
  const operationTimeoutMs = requireParentLeaseOperationTimeout(
    input?.operationTimeoutMs,
  );
  const holderCommand = requireParentLeaseTestHolderCommand(input?.holderCommand);
  const holderArgs = requireParentLeaseTestHolderArgs(input?.holderArgs);
  const nativePublisher = Object.freeze({ path: holderCommand });
  const lease = await acquireAtomicPublishParentLease({
    assertPublisherIdentity: async () => {},
    nativePublisher,
    operationTimeoutMs,
    parentRoot,
    spawnProcess: (_publisher, _args, options) => (
      spawnAndWaitForStart(holderCommand, holderArgs, options)
    ),
    timeoutMs,
  });

  return runAtomicPublishParentLeaseOperation(lease, operation);
}

export function encodeNativeParentLeaseCallFrameForTest(
  requestId,
  operation,
  args,
) {
  return encodeNativeParentLeaseCallFrame(requestId, operation, args);
}

async function runAtomicPublishParentLeaseOperation(lease, operation) {
  let operationError;
  let result;
  try {
    result = await lease.guard(() => operation(lease.public));
    lease.assertHeld();
  } catch (error) {
    operationError = error;
  }

  try {
    await lease.release();
  } catch (releaseError) {
    if (operationError !== undefined) {
      attachParentLeaseOperationError(releaseError, operationError);
    }
    throw releaseError;
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return result;
}

/**
 * Atomically publish one sibling directory without replacing an existing
 * destination. The native helper is build-only and is compiled from the fixed
 * checked-in source into a private temporary directory.
 */
export async function atomicPublishDirectoryNoReplace(input, parentLease) {
  const parentRoot = await requireCanonicalParent(input?.parentRoot);
  const sourceName = requireLeafName(input?.sourceName);
  const destinationName = requireLeafName(input?.destinationName);
  if (sameLeafName(sourceName, destinationName)) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_name_invalid",
      "source and destination names must be distinct",
    );
  }
  const expectedParentIdentity = requireNativeIdentity(
    input?.expectedParentIdentity,
    "expectedParentIdentity",
  );
  const expectedSourceIdentity = requireNativeIdentity(
    input?.expectedSourceIdentity,
    "expectedSourceIdentity",
  );

  const capability = requireNativeParentLeaseCapability(parentLease, parentRoot);
  const receipt = await invokeNativeParentLeaseOperation(
    capability,
    "publish",
    [
      sourceName,
      destinationName,
      expectedParentIdentity,
      expectedSourceIdentity,
    ],
  );
  if (receipt.outcome === "committed") {
    return Object.freeze({
      schemaVersion: 1,
      outcome: "committed",
      operationOwnerPid: receipt.operationOwnerPid,
      platform: receipt.platform,
    });
  }
  throw nativeReceiptError(receipt);
}

export async function readAtomicPublishDirectoryIdentities(input, parentLease) {
  const parentRoot = await requireCanonicalParent(input?.parentRoot);
  const sourceName = requireLeafName(input?.sourceName);
  const receipt = parentLease === undefined
    ? await invokeStandaloneNativeOperation(["inspect", parentRoot, sourceName])
    : await invokeNativeParentLeaseOperation(
        requireNativeParentLeaseCapability(parentLease, parentRoot),
        "inspect",
        [sourceName],
      );
  if (receipt.outcome !== "inspected"
    || receipt.parentIdentity === undefined
    || receipt.sourceIdentity === undefined) {
    throw nativeReceiptError(receipt);
  }
  return Object.freeze({
    schemaVersion: 1,
    platform: receipt.platform,
    parentIdentity: receipt.parentIdentity,
    ...(receipt.operationOwnerPid === undefined
      ? {}
      : { operationOwnerPid: receipt.operationOwnerPid }),
    sourceIdentity: receipt.sourceIdentity,
  });
}

/**
 * Apply the platform-private security profile to one existing staging
 * directory through a no-reparse, handle-relative native operation.
 */
export async function securePrivateStagingDirectory(input, parentLease) {
  const parentRoot = await requireCanonicalParent(input?.parentRoot);
  const directoryName = requireLeafName(input?.directoryName);
  const expectedIdentities = optionalExpectedDirectoryIdentities(input);
  const capability = requireNativeParentLeaseCapability(parentLease, parentRoot);
  const receipt = await invokeNativeParentLeaseOperation(
    capability,
    "secure-private",
    [
      directoryName,
      ...(expectedIdentities === undefined
        ? []
        : [
            expectedIdentities.parentIdentity,
            expectedIdentities.directoryIdentity,
          ]),
    ],
  );
  return privateDirectoryReceipt(receipt, "secured", expectedIdentities);
}

/**
 * Reopen and verify the exact directory secured by
 * securePrivateStagingDirectory. Both identities are mandatory so replacing
 * either the parent or directory fails closed.
 */
export async function verifyPrivateStagingDirectorySecurity(input, parentLease) {
  const parentRoot = await requireCanonicalParent(input?.parentRoot);
  const directoryName = requireLeafName(input?.directoryName);
  const expectedParentIdentity = requireNativeIdentity(
    input?.expectedParentIdentity,
    "expectedParentIdentity",
  );
  const expectedDirectoryIdentity = requireNativeIdentity(
    input?.expectedDirectoryIdentity,
    "expectedDirectoryIdentity",
  );
  const args = [
    directoryName,
    expectedParentIdentity,
    expectedDirectoryIdentity,
  ];
  const receipt = parentLease === undefined
    ? await invokeStandaloneNativeOperation(["verify-private", parentRoot, ...args])
    : await invokeNativeParentLeaseOperation(
        requireNativeParentLeaseCapability(parentLease, parentRoot),
        "verify-private",
        args,
      );
  return privateDirectoryReceipt(receipt, "verified");
}

/**
 * Remove one exact private directory tree relative to a pinned parent. The
 * native helper reopens and binds the root identity, preflights the complete
 * bounded inventory, and performs handle-relative deletion.
 */
export async function removeAtomicPublishDirectoryTree(input, parentLease) {
  const parentRoot = await requireCanonicalParent(input?.parentRoot);
  const sourceName = requireLeafName(input?.sourceName);
  const expectedParentIdentity = requireNativeIdentity(
    input?.expectedParentIdentity,
    "expectedParentIdentity",
  );
  const expectedSourceIdentity = requireNativeIdentity(
    input?.expectedSourceIdentity,
    "expectedSourceIdentity",
  );
  const entryPolicy = requireRemovalEntryPolicy(input?.entryPolicy);
  const artifactRemoval = entryPolicy !== undefined;
  const expectedEntries = requireBoundedRemovalValue(
    input?.expectedEntries,
    "expectedEntries",
    artifactRemoval
      ? NATIVE_ARTIFACT_REMOVAL_MAX_ENTRIES
      : NATIVE_REMOVAL_MAX_ENTRIES,
  );
  const expectedTotalBytes = requireBoundedRemovalValue(
    input?.expectedTotalBytes,
    "expectedTotalBytes",
    artifactRemoval
      ? NATIVE_ARTIFACT_REMOVAL_MAX_BYTES
      : NATIVE_REMOVAL_MAX_BYTES,
  );
  const capability = requireNativeParentLeaseCapability(parentLease, parentRoot);
  const receipt = await invokeNativeParentLeaseOperation(
    capability,
    artifactRemoval ? "remove-artifact-tree" : "remove-tree",
    [
      sourceName,
      expectedParentIdentity,
      expectedSourceIdentity,
      String(expectedEntries),
      String(expectedTotalBytes),
      ...(entryPolicy === DARWIN_ARTIFACT_SYMLINK_REMOVAL_POLICY
        ? [entryPolicy]
        : []),
    ],
  );
  if (receipt.outcome !== "removed") {
    throw nativeReceiptError(receipt);
  }
  if (receipt.reason !== "removed"
    || receipt.parentIdentity !== expectedParentIdentity
    || receipt.sourceIdentity !== expectedSourceIdentity
    || receipt.removedEntries !== expectedEntries
    || receipt.removedBytes !== expectedTotalBytes) {
    throw nativeProtocolError("native remover returned an inconsistent receipt");
  }
  return Object.freeze({
    schemaVersion: 1,
    outcome: "removed",
    platform: receipt.platform,
    parentIdentity: receipt.parentIdentity,
    operationOwnerPid: receipt.operationOwnerPid,
    sourceIdentity: receipt.sourceIdentity,
    removedEntries: receipt.removedEntries,
    removedBytes: receipt.removedBytes,
  });
}

function requireRemovalEntryPolicy(value) {
  if (value === undefined) return undefined;
  if (value === ARTIFACT_REMOVAL_POLICY) return value;
  if (value !== DARWIN_ARTIFACT_SYMLINK_REMOVAL_POLICY
      || process.platform !== "darwin") {
    throw new CuaDriverAtomicPublishError(
      "staging_remove_entry_policy_invalid",
      "entryPolicy must select bounded artifact cleanup for the current platform",
    );
  }
  return value;
}

/**
 * Remove one exact current-user-owned empty directory that could not receive
 * the private security profile. This is the only cleanup path allowed before
 * secure-private succeeds: the native helper rechecks the parent/root
 * identities, owner, no-reparse boundary and empty inventory before deletion.
 */
export async function removeAtomicPublishUnsecuredEmptyDirectory(input, parentLease) {
  const parentRoot = await requireCanonicalParent(input?.parentRoot);
  const sourceName = requireLeafName(input?.sourceName);
  const expectedParentIdentity = requireNativeIdentity(
    input?.expectedParentIdentity,
    "expectedParentIdentity",
  );
  const expectedSourceIdentity = requireNativeIdentity(
    input?.expectedSourceIdentity,
    "expectedSourceIdentity",
  );
  const capability = requireNativeParentLeaseCapability(parentLease, parentRoot);
  const receipt = await invokeNativeParentLeaseOperation(
    capability,
    "remove-unsecured-empty",
    [
      sourceName,
      expectedParentIdentity,
      expectedSourceIdentity,
    ],
  );
  if (receipt.outcome !== "removed") {
    throw nativeReceiptError(receipt);
  }
  if (receipt.reason !== "removed"
    || receipt.parentIdentity !== expectedParentIdentity
    || receipt.sourceIdentity !== expectedSourceIdentity
    || receipt.removedEntries !== 0
    || receipt.removedBytes !== 0) {
    throw nativeProtocolError(
      "native empty-directory remover returned an inconsistent receipt",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    outcome: "removed",
    platform: receipt.platform,
    parentIdentity: receipt.parentIdentity,
    operationOwnerPid: receipt.operationOwnerPid,
    sourceIdentity: receipt.sourceIdentity,
    removedEntries: 0,
    removedBytes: 0,
  });
}

/**
 * Run one Windows process inside a helper-owned KILL_ON_JOB_CLOSE Job Object.
 * Killing the helper for timeout or output overflow closes the Job and removes
 * every descendant, while stdout/stderr remain ordinary execFile streams.
 */
export async function runOwnedWindowsProcess(command, args, options = {}) {
  if (process.platform !== "win32") {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_unsupported",
      `owned process execution is unsupported on ${process.platform}`,
    );
  }
  if (typeof command !== "string"
    || !isAbsolute(command)
    || command.includes("\0")) {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_command_invalid",
      "owned process command must be an absolute path",
    );
  }
  if (!Array.isArray(args)
    || args.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_arguments_invalid",
      "owned process arguments must be an array of strings",
    );
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_options_invalid",
      "owned process options must be an object",
    );
  }
  const allowedOptions = new Set([
    "cwd",
    "encoding",
    "env",
    "maxBuffer",
    "signal",
    "timeout",
    "windowsHide",
  ]);
  const unexpected = Object.keys(options).find((key) => !allowedOptions.has(key));
  if (unexpected !== undefined) {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_options_invalid",
      `unsupported owned process option: ${unexpected}`,
    );
  }
  const execOptions = { ...options };
  delete execOptions.windowsHide;
  const nativePublisher = await getNativePublisher();
  await assertNativePublisherIdentity(nativePublisher);
  try {
    try {
      return await execFile(
        nativePublisher.path,
        ["run-owned", command, ...args],
        {
          ...execOptions,
          windowsHide: true,
        },
      );
    } catch (error) {
      throw normalizeOwnedWindowsProcessError(error, execOptions);
    }
  } finally {
    try {
      await assertNativePublisherIdentity(nativePublisher);
    } catch (cause) {
      throw new CuaDriverAtomicPublishError(
        "staging_owned_process_ambiguous",
        "owned-process helper identity changed during invocation",
        { outcome: "ambiguous", cause },
      );
    }
  }
}

function normalizeOwnedWindowsProcessError(error, options) {
  if (!(error instanceof Error)) return error;
  if (options.signal?.aborted && error.code === "ABORT_ERR") {
    error.killed = true;
    return error;
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    error.killed = true;
    if (error.stream === undefined) {
      if (/stdout maxBuffer/u.test(error.message)) error.stream = "stdout";
      if (/stderr maxBuffer/u.test(error.message)) error.stream = "stderr";
    }
    return error;
  }
  if (options.timeout > 0 && error.code === null && error.signal !== null) {
    error.code = "ETIMEDOUT";
    error.killed = true;
  }
  return error;
}

/** Spawn an interactive Windows root under the same native Job Object owner. */
export async function spawnOwnedWindowsProcess(command, args, options = {}) {
  if (process.platform !== "win32") {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_unsupported",
      `owned process execution is unsupported on ${process.platform}`,
    );
  }
  if (typeof command !== "string" || !isAbsolute(command) || command.includes("\0")) {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_command_invalid",
      "owned process command must be an absolute path",
    );
  }
  if (!Array.isArray(args)
    || args.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_arguments_invalid",
      "owned process arguments must be an array of strings",
    );
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_options_invalid",
      "owned process options must be an object",
    );
  }
  const allowedOptions = new Set(["cwd", "env", "signal", "stdio", "windowsHide"]);
  const unexpected = Object.keys(options).find((key) => !allowedOptions.has(key));
  if (unexpected !== undefined) {
    throw new CuaDriverAtomicPublishError(
      "staging_owned_process_options_invalid",
      `unsupported owned process option: ${unexpected}`,
    );
  }
  const nativePublisher = await getNativePublisher();
  await assertNativePublisherIdentity(nativePublisher);
  return spawn(
    nativePublisher.path,
    ["run-owned", command, ...args],
    { ...options, windowsHide: true },
  );
}

async function acquireAtomicPublishParentLease({
  assertPublisherIdentity = assertNativePublisherIdentity,
  nativePublisher,
  operationTimeoutMs = NATIVE_PUBLISH_TIMEOUT_MS,
  parentRoot,
  spawnProcess = spawnNativePublisherProcess,
  timeoutMs,
}) {
  const child = await spawnProcess(
    nativePublisher,
    ["hold-parent-lock", parentRoot, String(timeoutMs)],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const stderr = collectBoundedChildStderr(child.stderr);
  const lineReader = createBoundedProtocolLineReader(child.stdout);
  const termination = childTermination(child);
  let rejectLost;
  const abortController = new AbortController();
  const lost = new Promise((_, reject) => {
    rejectLost = reject;
  });
  void lost.catch(() => {});
  const capability = {
    abortController,
    acceptingCalls: false,
    assertPublisherIdentity,
    child,
    lineReader,
    lost,
    lostError: undefined,
    nativePublisher,
    nextRequestId: 1,
    operationTimeoutMs,
    parentRoot,
    publicLease: undefined,
    queue: Promise.resolve(),
    recoveredAbandonedLock: false,
    rejectLost,
    releaseRequested: false,
    state: "acquiring",
    stderr,
    termination,
  };
  void termination.then((state) => {
    if (!capability.releaseRequested && capability.state !== "released") {
      markNativeParentLeaseLost(
        capability,
        parentLeaseLostError(state, stderr()),
      );
    }
  });

  let lockedReceipt;
  try {
    const line = await readParentLeaseProtocolLine({
      lineReader,
      timeoutMs: timeoutMs + NATIVE_PARENT_LEASE_PROTOCOL_GRACE_MS,
    });
    lockedReceipt = parseNativeParentLeaseReceipt(line, "locked");
    assertParentLeaseReceipt(lockedReceipt, "locked");
  } catch (error) {
    await invalidateNativeParentLeaseCapability(capability, error);
    try {
      await lineReader.close();
    } catch (closeError) {
      attachParentLeaseInvalidationError(error, closeError);
    }
    await assertNativePublisherIdentityAfterLease(capability, error);
    throw error;
  }

  const assertHeld = () => {
    if (capability.lostError !== undefined) throw capability.lostError;
  };
  const guard = async (operationFactory) => {
    if (typeof operationFactory !== "function") {
      throw new CuaDriverAtomicPublishError(
        "staging_parent_lock_callback_invalid",
        "parent lease guarded operation must be callable",
      );
    }
    assertHeld();
    const operation = Promise.resolve().then(() => {
      assertHeld();
      return operationFactory(abortController.signal);
    });
    try {
      const value = await Promise.race([operation, lost]);
      assertHeld();
      return value;
    } catch (error) {
      if (capability.lostError === undefined) throw error;
      let drainedError;
      try {
        await operation;
      } catch (operationError) {
        drainedError = operationError;
      }
      if (drainedError !== undefined) {
        attachParentLeaseOperationError(capability.lostError, drainedError);
      }
      // The lease-loss classification remains authoritative after draining,
      // while any identity-bound cleanup metadata from the drained operation
      // remains attached for explicit recovery.
      throw capability.lostError;
    }
  };
  const publicLease = Object.freeze({
    assertHeld,
    guard,
    helperPid: child.pid,
    lost,
    parentIdentity: lockedReceipt.parentIdentity,
    parentRoot,
    recoveredAbandonedLock: lockedReceipt.recoveredAbandonedLock ?? false,
    signal: abortController.signal,
  });
  capability.acceptingCalls = true;
  capability.publicLease = publicLease;
  capability.recoveredAbandonedLock = lockedReceipt.recoveredAbandonedLock ?? false;
  capability.state = "held";
  nativeParentLeaseCapabilities.set(publicLease, capability);

  return Object.freeze({
    assertHeld,
    guard,
    public: publicLease,
    release: async () => {
      assertHeld();
      capability.acceptingCalls = false;
      nativeParentLeaseCapabilities.delete(publicLease);
      await capability.queue;
      assertHeld();
      capability.releaseRequested = true;
      capability.state = "releasing";
      const requestId = capability.nextRequestId;
      capability.nextRequestId += 1;
      let releaseFailure;
      try {
        await writeNativeParentLeaseFrame(
          child,
          encodeNativeParentLeaseReleaseFrame(requestId),
          { end: true },
        );
        const line = await readParentLeaseProtocolLine({
          lineReader,
          timeoutMs: NATIVE_PARENT_LEASE_RELEASE_TIMEOUT_MS,
        });
        const releasedReceipt = parseNativeParentLeaseReceipt(line, "released");
        assertParentLeaseReceipt(
          releasedReceipt,
          "released",
          lockedReceipt.parentIdentity,
          lockedReceipt.recoveredAbandonedLock,
        );
        assertNativeParentLeaseRpcReceipt(
          releasedReceipt,
          requestId,
          "release",
          child.pid,
        );
        const state = await waitForPromiseWithTimeout(
          termination,
          NATIVE_PARENT_LEASE_RELEASE_TIMEOUT_MS,
          "staging_parent_lock_release_failed",
          "native parent lease helper did not exit after release",
        );
        if (state.error !== undefined || state.code !== 0 || state.signal !== null) {
          throw parentLeaseReleaseError(state, stderr());
        }
        capability.state = "released";
      } catch (error) {
        await invalidateNativeParentLeaseCapability(capability, error);
        releaseFailure = normalizeParentLeaseReleaseError(error, stderr());
        throw releaseFailure;
      } finally {
        let closeFailure;
        try {
          await lineReader.close();
        } catch (closeError) {
          if (releaseFailure !== undefined) {
            attachParentLeaseInvalidationError(releaseFailure, closeError);
          } else {
            closeFailure = normalizeParentLeaseReleaseError(closeError, stderr());
          }
        }
        await assertNativePublisherIdentityAfterLease(capability);
        if (closeFailure !== undefined) throw closeFailure;
      }
    },
  });
}

function requireNativeParentLeaseCapability(parentLease, parentRoot) {
  const capability = nativeParentLeaseCapabilities.get(parentLease);
  if (capability === undefined
    || capability.state !== "held"
    || !capability.acceptingCalls
    || canonicalPathKey(capability.parentRoot) !== canonicalPathKey(parentRoot)) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_capability_required",
      "native staging mutation requires the active lease for its canonical parent",
    );
  }
  return capability;
}

function invokeNativeParentLeaseOperation(capability, operation, args) {
  if (!NATIVE_PARENT_LEASE_OPERATIONS.has(operation)) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_protocol_invalid",
      `unsupported native parent lease operation: ${operation}`,
      { outcome: "ambiguous" },
    );
  }
  if (!capability.acceptingCalls || capability.state !== "held") {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_capability_required",
      "native staging operation requires an active parent lease",
    );
  }
  const requestId = capability.nextRequestId;
  capability.nextRequestId += 1;
  const operationPromise = capability.queue.then(() => (
    executeNativeParentLeaseOperation(
      capability,
      requestId,
      operation,
      args,
    )
  ));
  capability.queue = operationPromise.then(
    () => undefined,
    () => undefined,
  );
  return operationPromise;
}

async function executeNativeParentLeaseOperation(
  capability,
  requestId,
  operation,
  args,
) {
  if (capability.lostError !== undefined) throw capability.lostError;
  if (capability.state !== "held") {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_capability_required",
      "native staging operation requires an active parent lease",
    );
  }
  try {
    await writeNativeParentLeaseFrame(
      capability.child,
      encodeNativeParentLeaseCallFrame(requestId, operation, args),
    );
    const line = await readParentLeaseProtocolLine({
      lineReader: capability.lineReader,
      timeoutMs: capability.operationTimeoutMs,
      timeoutCode: "staging_parent_lock_operation_timeout",
      timeoutMessage: `timed out waiting for native parent lease operation ${operation}`,
    });
    const receipt = parseNativeParentLeaseReceipt(line, operation);
    assertNativeParentLeaseRpcReceipt(
      receipt,
      requestId,
      operation,
      capability.child.pid,
    );
    assertNativeParentLeaseOperationReceipt(receipt, operation, args);
    return receipt;
  } catch (error) {
    await invalidateNativeParentLeaseCapability(capability, error);
    throw error;
  }
}

function markNativeParentLeaseLost(capability, error) {
  if (capability.lostError !== undefined) return capability.lostError;
  capability.acceptingCalls = false;
  capability.lostError = error;
  capability.state = "lost";
  if (capability.publicLease !== undefined) {
    nativeParentLeaseCapabilities.delete(capability.publicLease);
  }
  capability.abortController.abort(error);
  capability.rejectLost(error);
  return error;
}

async function invalidateNativeParentLeaseCapability(capability, error) {
  markNativeParentLeaseLost(capability, error);
  if (capability.child.exitCode === null && capability.child.signalCode === null) {
    try {
      capability.child.kill("SIGKILL");
    } catch (invalidationError) {
      attachParentLeaseInvalidationError(error, invalidationError);
    }
  }
  // Safety boundary: never return control while an invalidated holder could
  // still own the OS lease or finish a native mutation. The holder's own
  // operation watchdog is bounded, but this await intentionally is not.
  const state = await capability.termination;
  if (state.error !== undefined) {
    attachParentLeaseInvalidationError(error, state.error);
  }
}

async function spawnNativePublisherProcess(nativePublisher, args, options) {
  if (process.platform !== "darwin") {
    return spawnAndWaitForStart(nativePublisher.path, args, options);
  }
  const handle = await open(
    nativePublisher.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()
      || metadata.nlink !== 1n
      || !sameFileIdentity(fileIdentityFromMetadata(metadata), nativePublisher.identity)) {
      throw new CuaDriverAtomicPublishError(
        "staging_publish_helper_changed",
        "native publisher no longer matches its open executable identity",
      );
    }
    return await spawnAndWaitForStart(
      `/.vol/${metadata.dev}/${metadata.ino}`,
      args,
      options,
    );
  } finally {
    await handle.close();
  }
}

function spawnAndWaitForStart(command, args, options) {
  const child = spawn(command, args, options);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      child.off("spawn", onSpawn);
      reject(new CuaDriverAtomicPublishError(
        "staging_parent_lock_start_failed",
        boundedDiagnostic(error),
        { cause: error },
      ));
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolve(child);
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

function childTermination(child) {
  return new Promise((resolve) => {
    let childError;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({
        code,
        ...(childError === undefined ? {} : { error: childError }),
        signal,
      }));
    };
    child.on("error", (error) => {
      childError ??= error;
    });
    child.once("exit", finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(child.exitCode, child.signalCode);
    }
  });
}

function collectBoundedChildStderr(stream) {
  let value = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    if (value.length < NATIVE_OUTPUT_MAX_BYTES) {
      value = `${value}${chunk}`.slice(0, NATIVE_OUTPUT_MAX_BYTES);
    }
  });
  return () => value.trim().slice(0, 2_000);
}

function createBoundedProtocolLineReader(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  let closed = false;
  let reading = false;
  return Object.freeze({
    close: async () => {
      if (closed) return;
      closed = true;
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
    nextLine: async () => {
      if (closed || reading) {
        throw new CuaDriverAtomicPublishError(
          "staging_parent_lock_protocol_invalid",
          "native parent lease protocol reader is unavailable",
          { outcome: "ambiguous" },
        );
      }
      reading = true;
      try {
        while (true) {
          const newlineIndex = buffer.indexOf(0x0a);
          if (newlineIndex !== -1) {
            if (newlineIndex + 1 > NATIVE_PARENT_LEASE_RPC_MAX_BYTES) {
              throw parentLeaseProtocolError(
                "native parent lease helper exceeded the protocol frame limit",
              );
            }
            const line = buffer.subarray(0, newlineIndex);
            buffer = buffer.subarray(newlineIndex + 1);
            try {
              return STRICT_UTF8_DECODER.decode(line);
            } catch (cause) {
              throw parentLeaseProtocolError(
                "native parent lease helper returned invalid UTF-8",
                cause,
              );
            }
          }
          if (buffer.length >= NATIVE_PARENT_LEASE_RPC_MAX_BYTES) {
            throw parentLeaseProtocolError(
              "native parent lease helper exceeded the protocol frame limit",
            );
          }
          const next = await iterator.next();
          if (next.done) {
            throw parentLeaseProtocolError(
              "native parent lease helper ended without a complete protocol frame",
            );
          }
          const chunk = Buffer.isBuffer(next.value)
            ? next.value
            : Buffer.from(next.value);
          const newlineInChunk = chunk.indexOf(0x0a);
          if (newlineInChunk === -1
            ? buffer.length + chunk.length >= NATIVE_PARENT_LEASE_RPC_MAX_BYTES
            : buffer.length + newlineInChunk + 1 > NATIVE_PARENT_LEASE_RPC_MAX_BYTES) {
            throw parentLeaseProtocolError(
              "native parent lease helper exceeded the protocol frame limit",
            );
          }
          buffer = Buffer.concat([buffer, chunk]);
        }
      } finally {
        reading = false;
      }
    },
  });
}

async function readParentLeaseProtocolLine({
  lineReader,
  timeoutMs,
  timeoutCode = "staging_parent_lock_timeout",
  timeoutMessage = "timed out waiting for the native parent lease helper",
}) {
  return waitForPromiseWithTimeout(
    lineReader.nextLine(),
    timeoutMs,
    timeoutCode,
    timeoutMessage,
  );
}

function encodeNativeParentLeaseCallFrame(requestId, operation, args) {
  const encodedArgs = args.map(encodeNativeParentLeaseArgument);
  return boundedNativeParentLeaseFrame([
    NATIVE_PARENT_LEASE_RPC_PROTOCOL,
    "call",
    String(requestId),
    operation,
    String(encodedArgs.length),
    ...encodedArgs,
  ]);
}

function encodeNativeParentLeaseReleaseFrame(requestId) {
  return boundedNativeParentLeaseFrame([
    NATIVE_PARENT_LEASE_RPC_PROTOCOL,
    "release",
    String(requestId),
  ]);
}

function boundedNativeParentLeaseFrame(fields) {
  const frame = `${fields.join("\t")}\n`;
  if (Buffer.byteLength(frame, "utf8") > NATIVE_PARENT_LEASE_RPC_MAX_BYTES) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_protocol_invalid",
      "native parent lease request exceeded the protocol frame limit",
      { outcome: "ambiguous" },
    );
  }
  return frame;
}

function encodeNativeParentLeaseArgument(value) {
  if (typeof value !== "string" || containsLoneSurrogate(value)) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_protocol_invalid",
      "native parent lease arguments must be valid Unicode strings",
      { outcome: "ambiguous" },
    );
  }
  const encoded = Buffer.from(value, "utf8");
  let decoded;
  try {
    decoded = STRICT_UTF8_DECODER.decode(encoded);
  } catch (cause) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_protocol_invalid",
      "native parent lease argument could not be encoded as strict UTF-8",
      { cause, outcome: "ambiguous" },
    );
  }
  if (decoded !== value) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_protocol_invalid",
      "native parent lease argument failed UTF-8 round-trip validation",
      { outcome: "ambiguous" },
    );
  }
  return encoded.toString("hex");
}

function containsLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function writeNativeParentLeaseFrame(child, frame, { end = false } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (cause) => {
      child.stdin.off("error", onError);
      reject(new CuaDriverAtomicPublishError(
        "staging_parent_lock_protocol_invalid",
        "failed to write a native parent lease protocol frame",
        { cause, outcome: "ambiguous" },
      ));
    };
    child.stdin.once("error", onError);
    const onComplete = () => {
      child.stdin.off("error", onError);
      resolve();
    };
    if (end) {
      child.stdin.end(frame, onComplete);
    } else {
      child.stdin.write(frame, onComplete);
    }
  });
}

function parentLeaseProtocolError(message, cause) {
  return new CuaDriverAtomicPublishError(
    "staging_parent_lock_protocol_invalid",
    message,
    { cause, outcome: "ambiguous" },
  );
}

function parseNativeParentLeaseReceipt(line, operation) {
  try {
    return parseNativeReceipt(line);
  } catch (cause) {
    throw parentLeaseProtocolError(
      `native parent lease returned an invalid ${operation} receipt`,
      cause,
    );
  }
}

function waitForPromiseWithTimeout(promise, timeoutMs, code, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new CuaDriverAtomicPublishError(
        code,
        message,
        { outcome: "ambiguous" },
      ));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function assertParentLeaseReceipt(
  receipt,
  outcome,
  expectedParentIdentity,
  expectedRecoveredAbandonedLock,
) {
  if (receipt.outcome !== outcome) {
    if (outcome === "locked"
      && receipt.outcome === "not_committed"
      && Object.keys(receipt).every((field) => (
        NATIVE_RECEIPT_BASE_FIELDS.has(field)
      ))) {
      throw nativeReceiptError(receipt);
    }
    throw parentLeaseProtocolError(
      `native parent lease returned ${receipt.outcome} while ${outcome} was required`,
    );
  }
  if (receipt.reason !== outcome
    || receipt.parentIdentity === undefined
    || receipt.lockScope !== "parent"
    || typeof receipt.recoveredAbandonedLock !== "boolean"
    || (expectedParentIdentity !== undefined
      && receipt.parentIdentity !== expectedParentIdentity)
    || (expectedRecoveredAbandonedLock !== undefined
      && receipt.recoveredAbandonedLock !== expectedRecoveredAbandonedLock)
    || (outcome === "locked"
      && (receipt.requestId !== undefined
        || receipt.operation !== undefined
        || receipt.operationOwnerPid !== undefined))) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_protocol_invalid",
      `native parent lease returned an inconsistent ${outcome} receipt`,
      { outcome: "ambiguous" },
    );
  }
}

function assertNativeParentLeaseRpcReceipt(
  receipt,
  requestId,
  operation,
  helperPid,
) {
  if (receipt.requestId !== requestId
    || receipt.operation !== operation
    || receipt.operationOwnerPid !== helperPid) {
    throw parentLeaseProtocolError(
      `native parent lease returned inconsistent context for ${operation}`,
    );
  }
}

function assertNativeParentLeaseOperationReceipt(receipt, operation, args) {
  const expectedOutcome = {
    inspect: "inspected",
    publish: "committed",
    "remove-artifact-tree": "removed",
    "remove-tree": "removed",
    "remove-unsecured-empty": "removed",
    "secure-private": "secured",
    "verify-private": "verified",
  }[operation];
  if (receipt.outcome !== expectedOutcome) {
    if (receipt.outcome === "not_committed" || receipt.outcome === "ambiguous") {
      return;
    }
    throw parentLeaseProtocolError(
      `native parent lease returned an invalid outcome for ${operation}`,
    );
  }

  if (operation === "publish") {
    if (receipt.reason !== "committed") {
      throw parentLeaseProtocolError(
        "native parent lease returned an inconsistent publish receipt",
      );
    }
    return;
  }
  if (operation === "inspect") {
    if (receipt.reason !== "inspected"
      || receipt.parentIdentity === undefined
      || receipt.sourceIdentity === undefined) {
      throw parentLeaseProtocolError(
        "native parent lease inspect receipt omitted directory identities",
      );
    }
    return;
  }
  if (operation === "secure-private" || operation === "verify-private") {
    const expectedIdentities = args.length === 3
      ? Object.freeze({
          directoryIdentity: args[2],
          parentIdentity: args[1],
        })
      : undefined;
    try {
      privateDirectoryReceipt(
        receipt,
        operation === "secure-private" ? "secured" : "verified",
        expectedIdentities,
      );
    } catch (cause) {
      throw parentLeaseProtocolError(
        `native parent lease returned an invalid ${operation} receipt`,
        cause,
      );
    }
    return;
  }
  if (operation === "remove-tree" || operation === "remove-artifact-tree") {
    if (receipt.reason !== "removed"
      || receipt.parentIdentity !== args[1]
      || receipt.sourceIdentity !== args[2]
      || receipt.removedEntries !== Number(args[3])
      || receipt.removedBytes !== Number(args[4])) {
      throw parentLeaseProtocolError(
        "native parent lease returned an inconsistent remove-tree receipt",
      );
    }
    return;
  }
  if (operation === "remove-unsecured-empty") {
    if (receipt.reason !== "removed"
      || receipt.parentIdentity !== args[1]
      || receipt.sourceIdentity !== args[2]
      || receipt.removedEntries !== 0
      || receipt.removedBytes !== 0) {
      throw parentLeaseProtocolError(
        "native parent lease returned an inconsistent remove-unsecured-empty receipt",
      );
    }
  }
}

function parentLeaseLostError(state, stderr = "") {
  return new CuaDriverAtomicPublishError(
    "staging_parent_lock_lost",
    `native parent lease helper exited unexpectedly${boundedLeaseExitDetail(state, stderr)}`,
    { cause: state.error, outcome: "ambiguous" },
  );
}

function parentLeaseReleaseError(state, stderr) {
  return new CuaDriverAtomicPublishError(
    "staging_parent_lock_release_failed",
    `native parent lease helper exited with an invalid release status${boundedLeaseExitDetail(state, stderr)}`,
    { cause: state.error, outcome: "ambiguous" },
  );
}

function normalizeParentLeaseReleaseError(error, stderr) {
  if (error instanceof CuaDriverAtomicPublishError) return error;
  return new CuaDriverAtomicPublishError(
    "staging_parent_lock_release_failed",
    `native parent lease release failed${stderr ? `: ${stderr}` : ""}`,
    { cause: error, outcome: "ambiguous" },
  );
}

function boundedLeaseExitDetail(state, stderr) {
  const parts = [];
  if (state.code !== null && state.code !== undefined) parts.push(`code=${state.code}`);
  if (state.signal !== null && state.signal !== undefined) parts.push(`signal=${state.signal}`);
  if (stderr) parts.push(`stderr=${stderr}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

async function assertNativePublisherIdentityAfterLease(capability, priorError) {
  try {
    await capability.assertPublisherIdentity(capability.nativePublisher);
  } catch (cause) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_lost",
      "native parent lease helper identity changed during the lease",
      { cause, outcome: "ambiguous" },
    );
  }
  if (priorError !== undefined) throw priorError;
}

function attachParentLeaseOperationError(releaseError, operationError) {
  if (!(releaseError instanceof Error) || !Object.isExtensible(releaseError)) return;
  try {
    Object.defineProperty(releaseError, "operationError", {
      configurable: true,
      enumerable: false,
      value: operationError,
      writable: false,
    });
  } catch {
    // Preserve the parent-lock failure if the error object is immutable.
  }
  if (operationError?.cleanup !== undefined && releaseError.cleanup === undefined) {
    try {
      Object.defineProperty(releaseError, "cleanup", {
        configurable: true,
        enumerable: true,
        value: operationError.cleanup,
        writable: false,
      });
    } catch {
      // Preserve the parent-lock failure if cleanup metadata cannot be attached.
    }
  }
}

function attachParentLeaseInvalidationError(error, invalidationError) {
  if (!(error instanceof Error) || !Object.isExtensible(error)) return;
  try {
    Object.defineProperty(error, "invalidationError", {
      configurable: true,
      enumerable: false,
      value: invalidationError,
      writable: false,
    });
  } catch {
    // Preserve the original operation/protocol failure if attachment fails.
  }
}

async function getNativePublisher() {
  nativePublisherPromise ??= buildNativePublisher();
  try {
    return await nativePublisherPromise;
  } catch (error) {
    nativePublisherPromise = undefined;
    throw error;
  }
}

async function buildNativePublisher() {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new CuaDriverAtomicPublishError(
      "staging_atomic_publish_unsupported",
      `native no-replace publication is unsupported on ${process.platform}`,
    );
  }

  const buildRoot = await mkdtemp(join(tmpdir(), PRIVATE_BUILD_PREFIX));
  const outputPath = join(buildRoot, NATIVE_OUTPUT_NAME);
  const command = process.platform === "darwin" ? "/usr/bin/clang++" : "cl.exe";
  const args = process.platform === "darwin"
    ? [
        "-std=c++17",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        NATIVE_SOURCE_PATH,
        "-o",
        outputPath,
      ]
    : [
        "/nologo",
        "/std:c++17",
        "/O2",
        "/EHsc",
        "/W4",
        "/WX",
        `/Fe:${outputPath}`,
        NATIVE_SOURCE_PATH,
        "Advapi32.lib",
      ];

  try {
    await execFile(command, args, {
      cwd: buildRoot,
      maxBuffer: NATIVE_BUILD_OUTPUT_MAX_BYTES,
      timeout: NATIVE_BUILD_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_helper_build_failed",
      boundedDiagnostic(error),
      { cause: error },
    );
  }

  const identity = await readRegularSingleLinkIdentity(
    outputPath,
    "staging_publish_helper_invalid",
  );
  return Object.freeze({ path: outputPath, identity });
}

async function invokeStandaloneNativeOperation(args) {
  const nativePublisher = await getNativePublisher();
  await assertNativePublisherIdentity(nativePublisher);
  return invokeNativeOperation(nativePublisher, args);
}

async function invokeNativeOperation(nativePublisher, args) {
  let stdout;
  let exitCode = 0;
  try {
    ({ stdout } = await invokeNativePublisher(
      nativePublisher,
      args,
      {
        encoding: "utf8",
        maxBuffer: NATIVE_OUTPUT_MAX_BYTES,
        timeout: NATIVE_PUBLISH_TIMEOUT_MS,
        windowsHide: true,
      },
    ));
  } catch (error) {
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    exitCode = typeof error?.code === "number" ? error.code : undefined;
    if (stdout.length === 0) {
      throw new CuaDriverAtomicPublishError(
        "staging_publish_ambiguous",
        "native publisher exited without a classification receipt",
        {
          outcome: "ambiguous",
          cause: error,
        },
      );
    }
  } finally {
    try {
      await assertNativePublisherIdentity(nativePublisher);
    } catch (cause) {
      throw new CuaDriverAtomicPublishError(
        "staging_publish_ambiguous",
        "native publisher identity changed during invocation",
        { outcome: "ambiguous", cause },
      );
    }
  }

  const receipt = parseNativeReceipt(stdout);
  if ((SUCCESS_OUTCOMES.has(receipt.outcome) && exitCode !== 0)
    || (!SUCCESS_OUTCOMES.has(receipt.outcome) && exitCode === 0)) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_ambiguous",
      "native publisher exit status disagrees with its receipt",
      {
        outcome: "ambiguous",
        nativeReason: receipt.reason,
        nativeCode: receipt.nativeCode,
      },
    );
  }
  return receipt;
}

async function invokeNativePublisher(nativePublisher, args, options) {
  if (process.platform !== "darwin") {
    return execFile(nativePublisher.path, args, options);
  }
  return invokeDarwinIdentityBoundExecutable(
    nativePublisher.path,
    nativePublisher.identity,
    args,
    options,
  );
}

async function invokeDarwinIdentityBoundExecutable(
  executablePath,
  expectedIdentity,
  args,
  options,
  afterPinned = async () => {},
) {
  const handle = await open(
    executablePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()
      || metadata.nlink !== 1n
      || !sameFileIdentity(fileIdentityFromMetadata(metadata), expectedIdentity)) {
      throw new CuaDriverAtomicPublishError(
        "staging_publish_helper_changed",
        "native publisher no longer matches its open executable identity",
      );
    }
    const identityPath = `/.vol/${metadata.dev}/${metadata.ino}`;
    await afterPinned();
    return await execFile(identityPath, args, options);
  } finally {
    await handle.close();
  }
}

/** Test-only seam proving Darwin executes the held vnode rather than a replaced path. */
export async function runDarwinIdentityBoundExecutableForTest(
  executablePath,
  args,
  afterPinned,
) {
  if (process.platform !== "darwin" || typeof afterPinned !== "function") {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_helper_test_invalid",
      "Darwin identity-bound execution test requires a barrier callback",
    );
  }
  const identity = await readRegularSingleLinkIdentity(
    executablePath,
    "staging_publish_helper_test_invalid",
  );
  return invokeDarwinIdentityBoundExecutable(
    executablePath,
    identity,
    args,
    {
      encoding: "utf8",
      maxBuffer: NATIVE_OUTPUT_MAX_BYTES,
      timeout: NATIVE_PUBLISH_TIMEOUT_MS,
      windowsHide: true,
    },
    afterPinned,
  );
}

function parseNativeReceipt(stdout) {
  if (Buffer.byteLength(stdout, "utf8") > NATIVE_OUTPUT_MAX_BYTES) {
    throw nativeProtocolError("native publisher receipt exceeded its size limit");
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw nativeProtocolError("native publisher returned invalid JSON", error);
  }
  if (!value
    || typeof value !== "object"
    || value.schemaVersion !== 1
    || !NATIVE_OUTCOMES.has(value.outcome)
    || value.platform !== (process.platform === "darwin" ? "darwin" : "win32")
    || typeof value.reason !== "string"
    || value.reason.length === 0
    || value.reason.length > 128
    || !Number.isSafeInteger(value.nativeCode)
    || value.nativeCode < 0
    || !isOptionalNativeIdentity(value.parentIdentity)
    || !isOptionalNativeIdentity(value.sourceIdentity)
    || !isOptionalNativeIdentity(value.directoryIdentity)
    || !isOptionalOwnerIdentity(value.ownerIdentity)
    || !isOptionalSecurityProfile(value.securityProfile)
    || !isOptionalRemovalValue(value.removedEntries)
    || !isOptionalRemovalValue(value.removedBytes)
    || (value.lockScope !== undefined && value.lockScope !== "parent")
    || (value.recoveredAbandonedLock !== undefined
      && typeof value.recoveredAbandonedLock !== "boolean")
    || ((value.removedEntries === undefined)
      !== (value.removedBytes === undefined))
    || ((value.outcome === "removed")
      !== (value.removedEntries !== undefined))
    || (value.childrenInheritProtection !== undefined
      && typeof value.childrenInheritProtection !== "boolean")
    || !isOptionalNativeParentLeaseRequestId(value.requestId)
    || !isOptionalNativeParentLeaseOperation(value.operation)
    || !isOptionalNativeParentLeaseOwnerPid(value.operationOwnerPid)
    || !hasCompleteNativeParentLeaseReceiptContext(value)) {
    throw nativeProtocolError("native publisher returned an invalid receipt shape");
  }
  return Object.freeze({
    schemaVersion: 1,
    outcome: value.outcome,
    platform: value.platform,
    reason: value.reason,
    nativeCode: value.nativeCode,
    ...(value.parentIdentity === undefined
      ? {}
      : { parentIdentity: value.parentIdentity }),
    ...(value.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: value.sourceIdentity }),
    ...(value.directoryIdentity === undefined
      ? {}
      : { directoryIdentity: value.directoryIdentity }),
    ...(value.ownerIdentity === undefined
      ? {}
      : { ownerIdentity: value.ownerIdentity }),
    ...(value.securityProfile === undefined
      ? {}
      : { securityProfile: value.securityProfile }),
    ...(value.childrenInheritProtection === undefined
      ? {}
      : { childrenInheritProtection: value.childrenInheritProtection }),
    ...(value.removedEntries === undefined
      ? {}
      : {
          removedEntries: value.removedEntries,
          removedBytes: value.removedBytes,
        }),
    ...(value.lockScope === undefined ? {} : { lockScope: value.lockScope }),
    ...(value.recoveredAbandonedLock === undefined
      ? {}
      : { recoveredAbandonedLock: value.recoveredAbandonedLock }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    ...(value.operation === undefined ? {} : { operation: value.operation }),
    ...(value.operationOwnerPid === undefined
      ? {}
      : { operationOwnerPid: value.operationOwnerPid }),
  });
}

function isOptionalNativeParentLeaseRequestId(value) {
  return value === undefined
    || (Number.isSafeInteger(value) && value >= 1);
}

function isOptionalNativeParentLeaseOperation(value) {
  return value === undefined
    || value === "release"
    || NATIVE_PARENT_LEASE_OPERATIONS.has(value);
}

function isOptionalNativeParentLeaseOwnerPid(value) {
  return value === undefined
    || (Number.isSafeInteger(value) && value >= 1);
}

function hasCompleteNativeParentLeaseReceiptContext(value) {
  const context = [value.requestId, value.operation, value.operationOwnerPid];
  return context.every((entry) => entry === undefined)
    || context.every((entry) => entry !== undefined);
}

function privateDirectoryReceipt(receipt, expectedOutcome, expectedIdentities) {
  if (receipt.outcome !== expectedOutcome) {
    throw nativeReceiptError(receipt);
  }
  const expectedProfile = process.platform === "darwin"
    ? "current-euid-mode-0700"
    : "protected-dacl-current-user-system-administrators";
  const expectedInheritance = process.platform === "win32";
  if (receipt.reason !== expectedOutcome
    || receipt.parentIdentity === undefined
    || receipt.directoryIdentity === undefined
    || receipt.ownerIdentity === undefined
    || receipt.securityProfile !== expectedProfile
    || receipt.childrenInheritProtection !== expectedInheritance
    || (expectedIdentities !== undefined
      && (receipt.parentIdentity !== expectedIdentities.parentIdentity
        || receipt.directoryIdentity !== expectedIdentities.directoryIdentity))) {
    throw nativeProtocolError(
      "native publisher returned an incomplete private-directory receipt",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    outcome: expectedOutcome,
    platform: receipt.platform,
    parentIdentity: receipt.parentIdentity,
    ...(receipt.operationOwnerPid === undefined
      ? {}
      : { operationOwnerPid: receipt.operationOwnerPid }),
    directoryIdentity: receipt.directoryIdentity,
    ownerIdentity: receipt.ownerIdentity,
    securityProfile: receipt.securityProfile,
    childrenInheritProtection: receipt.childrenInheritProtection,
  });
}

function optionalExpectedDirectoryIdentities(input) {
  const hasParent = input?.expectedParentIdentity !== undefined;
  const hasDirectory = input?.expectedDirectoryIdentity !== undefined;
  if (hasParent !== hasDirectory) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_identity_invalid",
      "expected parent and directory identities must be supplied together",
    );
  }
  if (!hasParent) return undefined;
  return Object.freeze({
    parentIdentity: requireNativeIdentity(
      input.expectedParentIdentity,
      "expectedParentIdentity",
    ),
    directoryIdentity: requireNativeIdentity(
      input.expectedDirectoryIdentity,
      "expectedDirectoryIdentity",
    ),
  });
}

function nativeReceiptError(receipt) {
  let code = "staging_publish_not_committed";
  if (receipt.outcome === "ambiguous") {
    code = "staging_publish_ambiguous";
  } else if (receipt.reason === "destination_exists") {
    code = "output_root_exists";
  } else if ([
    "parent_reparse_forbidden",
    "source_reparse_forbidden",
    "directory_reparse_forbidden",
  ].includes(receipt.reason)) {
    code = "staging_publish_reparse_forbidden";
  } else if (receipt.reason === "directory_missing") {
    code = "staging_private_directory_missing";
  } else if (receipt.reason === "parent_lock_timeout") {
    code = "staging_parent_lock_timeout";
  } else if (receipt.reason === "parent_lock_invalid") {
    code = "staging_parent_lock_invalid";
  } else if ([
    "directory_security_set_failed",
    "directory_security_unavailable",
  ].includes(receipt.reason)) {
    code = "staging_private_directory_security_failed";
  } else if ([
    "directory_security_invalid",
    "directory_owner_mismatch",
    "directory_identity_mismatch",
  ].includes(receipt.reason)) {
    code = "staging_private_directory_invalid";
  } else if (receipt.reason === "atomic_no_replace_unsupported") {
    code = "staging_atomic_publish_unsupported";
  }
  return new CuaDriverAtomicPublishError(
    code,
    `native publisher classified the operation as ${receipt.outcome}: ${receipt.reason} (nativeCode=${receipt.nativeCode})`,
    {
      outcome: receipt.outcome,
      nativeReason: receipt.reason,
      nativeCode: receipt.nativeCode,
    },
  );
}

function nativeProtocolError(message, cause) {
  return new CuaDriverAtomicPublishError(
    "staging_publish_ambiguous",
    message,
    { outcome: "ambiguous", cause },
  );
}

async function requireCanonicalParent(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_parent_invalid",
      "parentRoot must be an absolute path",
    );
  }
  const resolved = resolve(value);
  let metadata;
  let canonical;
  try {
    [metadata, canonical] = await Promise.all([
      lstat(resolved),
      realpath(resolved),
    ]);
  } catch (error) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_parent_invalid",
      "parentRoot must name an existing directory",
      { cause: error },
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_reparse_forbidden",
      "parentRoot must be a real directory",
    );
  }
  if (canonicalPathKey(canonical) !== canonicalPathKey(resolved)) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_reparse_forbidden",
      "parentRoot must not resolve through a symlink, junction or reparse point",
    );
  }
  return canonical;
}

function requireLeafName(value) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 240
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes(":")
    || value.includes("\0")) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_name_invalid",
      "sourceName and destinationName must be safe single path components",
    );
  }
  return value;
}

function requireNativeIdentity(value, fieldName) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || !/^[0-9a-f]+:[0-9a-f]+$/u.test(value)) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_identity_invalid",
      `${fieldName} must be a native directory identity receipt`,
    );
  }
  return value;
}

function isOptionalNativeIdentity(value) {
  return value === undefined
    || (typeof value === "string"
      && value.length <= 128
      && /^[0-9a-f]+:[0-9a-f]+$/u.test(value));
}

function isOptionalOwnerIdentity(value) {
  return value === undefined
    || (typeof value === "string"
      && value.length <= 256
      && (/^euid:[0-9]+$/u.test(value)
        || /^S-(?:[0-9]+-)+[0-9]+$/u.test(value)));
}

function isOptionalSecurityProfile(value) {
  return value === undefined
    || value === "current-euid-mode-0700"
    || value === "protected-dacl-current-user-system-administrators";
}

function isOptionalRemovalValue(value) {
  return value === undefined
    || (Number.isSafeInteger(value) && value >= 0);
}

function requireBoundedRemovalValue(value, fieldName, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new CuaDriverAtomicPublishError(
      "staging_remove_inventory_invalid",
      `${fieldName} must be a bounded non-negative integer`,
    );
  }
  return value;
}

function requireParentLeaseTimeout(value) {
  const timeoutMs = value ?? NATIVE_PUBLISH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > NATIVE_PARENT_LEASE_MAX_TIMEOUT_MS) {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_timeout_invalid",
      "parent lease timeoutMs must be a bounded positive integer",
    );
  }
  return timeoutMs;
}

function requireParentLeaseOperation(operation) {
  if (typeof operation !== "function") {
    throw new CuaDriverAtomicPublishError(
      "staging_parent_lock_callback_invalid",
      "parent lease operation must be callable",
    );
  }
  return operation;
}

function requireParentLeaseOperationTimeout(value) {
  const timeoutMs = value ?? NATIVE_PUBLISH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > NATIVE_PARENT_LEASE_MAX_TIMEOUT_MS) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_helper_test_invalid",
      "test parent lease operationTimeoutMs must be a bounded positive integer",
    );
  }
  return timeoutMs;
}

function requireParentLeaseTestHolderCommand(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_helper_test_invalid",
      "test parent lease holderCommand must be a non-empty string",
    );
  }
  return value;
}

function requireParentLeaseTestHolderArgs(value) {
  const args = value ?? [];
  if (!Array.isArray(args)
    || args.some((argument) => typeof argument !== "string")) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_helper_test_invalid",
      "test parent lease holderArgs must contain only strings",
    );
  }
  return Object.freeze([...args]);
}

function sameLeafName(left, right) {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function assertNativePublisherIdentity(nativePublisher) {
  const actual = await readRegularSingleLinkIdentity(
    nativePublisher.path,
    "staging_publish_helper_changed",
  );
  if (actual.dev !== nativePublisher.identity.dev
    || actual.ino !== nativePublisher.identity.ino
    || actual.size !== nativePublisher.identity.size
    || actual.mtimeNs !== nativePublisher.identity.mtimeNs
    || actual.ctimeNs !== nativePublisher.identity.ctimeNs) {
    throw new CuaDriverAtomicPublishError(
      "staging_publish_helper_changed",
      "native publisher changed after compilation",
    );
  }
}

async function readRegularSingleLinkIdentity(path, code) {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    throw new CuaDriverAtomicPublishError(
      code,
      "native publisher is missing",
      { cause: error },
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new CuaDriverAtomicPublishError(
      code,
      "native publisher must be one non-hardlinked regular file",
    );
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function fileIdentityFromMetadata(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function canonicalPathKey(path) {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function boundedDiagnostic(error) {
  return String(error?.stderr || error?.stdout || error?.message || error)
    .trim()
    .slice(0, 2_000) || "native publisher compilation failed without diagnostics";
}
