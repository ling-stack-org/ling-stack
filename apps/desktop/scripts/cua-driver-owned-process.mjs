import { execFileSync, spawn } from "node:child_process";

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const OWNED_PROCESS_KILL_SIGNAL = "SIGKILL";
const OWNED_PROCESS_REAP_TIMEOUT_MS = 5_000;
const OWNED_PROCESS_REAP_POLL_MS = 10;
const OWNED_UNIX_GROUP_ENV = "LING_CUA_OWNED_GROUP_LEADER";
const OWNED_UNIX_GROUP_LEADER = "leader";
const OWNED_UNIX_GROUP_MEMBER = "member";

/**
 * Run one command under an OS-owned process-tree boundary.
 *
 * Unix children lead a detached process group. Windows children are delegated
 * to the native Job Object implementation kept beside the atomic publisher.
 * A top-level owner never settles until its tree has terminated and the root
 * child's stdio handles have closed. A nested Unix call joins that boundary;
 * its outer owner provides the final zero-residue settlement guarantee.
 */
export async function runOwnedProcess(command, args = [], options = {}) {
  if (process.platform === "win32") {
    const { runOwnedWindowsProcess } = await import(
      "./cua-driver-package-atomic-publish.mjs"
    );
    return runOwnedWindowsProcess(command, args, options);
  }
  return runOwnedUnixProcess(command, args, options);
}

async function runOwnedUnixProcess(command, args, options) {
  const normalized = normalizeInvocation(command, args, options);
  if (normalized.signal?.aborted) {
    throw abortError(normalized.signal.reason);
  }
  const inheritedGroupId = currentOwnedUnixGroupId();
  const ownsProcessGroup = inheritedGroupId === undefined;

  let child;
  try {
    child = spawn(normalized.command, normalized.args, {
      ...normalized.spawnOptions,
      detached: ownsProcessGroup,
      env: ownedChildEnvironment(
        normalized.spawnOptions.env,
        ownsProcessGroup ? undefined : inheritedGroupId,
      ),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw error;
  }

  return new Promise((resolve, reject) => {
    const stdout = createBoundedCollector("stdout", normalized.maxBuffer);
    const stderr = createBoundedCollector("stderr", normalized.maxBuffer);
    let exitCode = null;
    let exitSignal = null;
    let forcedError;
    let groupKillError;
    let groupAlreadyMissing = false;
    let terminationRequested = false;
    let closed = false;
    let nestedPipeClose;

    const killOwnedGroup = () => {
      const groupId = ownsProcessGroup ? child.pid : inheritedGroupId;
      if (!Number.isSafeInteger(groupId) || groupId <= 0) return;
      try {
        process.kill(-groupId, OWNED_PROCESS_KILL_SIGNAL);
        terminationRequested = true;
      } catch (error) {
        if (error?.code === "ESRCH") {
          groupAlreadyMissing = true;
        } else {
          groupKillError ??= error;
        }
      }
    };

    const terminate = (error) => {
      forcedError ??= error;
      // A nested timeout/output/abort kills the verifier group itself. The
      // outer owner therefore reports SIGKILL while preserving fail-closed
      // tree cleanup rather than the nested diagnostic code.
      killOwnedGroup();
    };

    const onStdout = (chunk) => {
      const error = stdout.append(chunk);
      if (error) terminate(error);
    };
    const onStderr = (chunk) => {
      const error = stderr.append(chunk);
      if (error) terminate(error);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);

    child.once("error", (error) => {
      forcedError ??= error;
      if (ownsProcessGroup) killOwnedGroup();
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (ownsProcessGroup) {
        // The root may exit successfully while a grandchild retains inherited
        // stdio. Kill the still-owned group before waiting for `close`.
        killOwnedGroup();
      } else {
        // Killing here would kill the outer verifier which owns this group.
        // Give already-written pipe data one poll turn, then close our reads so
        // a lingering descendant cannot hold this nested call open. The outer
        // owner fences remaining descendants when it exits.
        nestedPipeClose = setImmediate(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        });
      }
    });

    let timeout;
    if (normalized.timeout > 0) {
      timeout = setTimeout(() => {
        terminate(timeoutError(normalized.commandLine, normalized.timeout));
      }, normalized.timeout);
      timeout.unref?.();
    }

    const onAbort = () => terminate(abortError(normalized.signal.reason));
    normalized.signal?.addEventListener("abort", onAbort, { once: true });
    if (normalized.signal?.aborted) onAbort();

    child.once("close", async () => {
      if (closed) return;
      closed = true;
      if (timeout) clearTimeout(timeout);
      if (nestedPipeClose) clearImmediate(nestedPipeClose);
      normalized.signal?.removeEventListener("abort", onAbort);

      if (ownsProcessGroup
        && terminationRequested
        && !groupAlreadyMissing
        && !groupKillError) {
        try {
          await waitForUnixProcessGroupExit(child.pid);
        } catch (error) {
          groupKillError = error;
        }
      }

      const stdoutValue = stdout.value(normalized.encoding);
      const stderrValue = stderr.value(normalized.encoding);
      if (groupKillError) {
        reject(decorateError(
          ownershipCleanupError(groupKillError),
          normalized.commandLine,
          stdoutValue,
          stderrValue,
          true,
          exitSignal,
        ));
        return;
      }
      if (forcedError) {
        reject(decorateError(
          forcedError,
          normalized.commandLine,
          stdoutValue,
          stderrValue,
          terminationRequested,
          exitSignal ?? (terminationRequested ? OWNED_PROCESS_KILL_SIGNAL : null),
        ));
        return;
      }
      if (exitCode !== 0 || exitSignal !== null) {
        const error = commandFailureError(
          normalized.commandLine,
          exitCode,
          exitSignal,
          stderrValue,
        );
        if (exitCode !== null) error.code = exitCode;
        reject(decorateError(
          error,
          normalized.commandLine,
          stdoutValue,
          stderrValue,
          terminationRequested,
          exitSignal,
        ));
        return;
      }
      resolve({ stdout: stdoutValue, stderr: stderrValue });
    });
  });
}

async function waitForUnixProcessGroupExit(groupId) {
  const deadline = Date.now() + OWNED_PROCESS_REAP_TIMEOUT_MS;
  while (true) {
    try {
      process.kill(-groupId, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      // Darwin may transiently report EPERM while a killed, reparented group
      // member is still being reaped. It is evidence that cleanup is not yet
      // proven, so keep polling rather than treating it as success.
      if (error?.code !== "EPERM") throw error;
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        `owned Unix process group ${groupId} did not exit after SIGKILL`,
      );
      error.code = "ERR_OWNED_PROCESS_REAP_TIMEOUT";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, OWNED_PROCESS_REAP_POLL_MS));
  }
}

function currentOwnedUnixGroupId() {
  const marker = process.env[OWNED_UNIX_GROUP_ENV];
  if (marker === undefined) return undefined;
  if (marker !== OWNED_UNIX_GROUP_LEADER) {
    throw invalidOwnedGroupMarker();
  }
  const groupId = process.pid;
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return undefined;
  if (readCurrentUnixProcessGroupId() !== groupId) {
    throw invalidOwnedGroupMarker();
  }
  try {
    process.kill(-groupId, 0);
    return groupId;
  } catch (cause) {
    throw invalidOwnedGroupMarker(cause);
  }
}

function readCurrentUnixProcessGroupId() {
  try {
    const output = execFileSync(
      "/bin/ps",
      ["-o", "pgid=", "-p", String(process.pid)],
      {
        encoding: "utf8",
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
        maxBuffer: 1_024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      },
    ).trim();
    if (!/^[1-9][0-9]*$/u.test(output)) return undefined;
    const groupId = Number(output);
    return Number.isSafeInteger(groupId) ? groupId : undefined;
  } catch {
    // A missing or untrustworthy membership probe must never authorize a
    // caller-supplied group id as a kill target.
    return undefined;
  }
}

function ownedChildEnvironment(environment, inheritedGroupId) {
  return {
    ...(environment ?? process.env),
    [OWNED_UNIX_GROUP_ENV]: inheritedGroupId === undefined
      ? OWNED_UNIX_GROUP_LEADER
      : OWNED_UNIX_GROUP_MEMBER,
  };
}

function normalizeInvocation(command, args, options) {
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("owned process command must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("owned process args must be an array of strings");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("owned process options must be an object");
  }

  const {
    encoding = "utf8",
    killSignal: _killSignal,
    maxBuffer = DEFAULT_MAX_BUFFER,
    signal,
    stdio: _stdio,
    timeout = 0,
    detached: _detached,
    ...spawnOptions
  } = options;
  if (maxBuffer !== Infinity
    && (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0)) {
    throw new RangeError("owned process maxBuffer must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    throw new RangeError("owned process timeout must be a non-negative safe integer");
  }
  if (signal !== undefined
    && (typeof signal !== "object"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function")) {
    throw new TypeError("owned process signal must be an AbortSignal");
  }
  if (encoding !== null
    && encoding !== "buffer"
    && (typeof encoding !== "string" || !Buffer.isEncoding(encoding))) {
    throw new TypeError(`unknown owned process encoding: ${String(encoding)}`);
  }
  return Object.freeze({
    args: [...args],
    command,
    commandLine: [command, ...args].join(" "),
    encoding,
    maxBuffer,
    signal,
    spawnOptions,
    timeout,
  });
}

function createBoundedCollector(streamName, maxBuffer) {
  const chunks = [];
  let length = 0;
  let overflowed = false;
  return {
    append(chunk) {
      if (overflowed) return undefined;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBuffer === Infinity ? bytes.length : Math.max(0, maxBuffer - length);
      if (remaining > 0) {
        const accepted = remaining >= bytes.length ? bytes : bytes.subarray(0, remaining);
        chunks.push(accepted);
        length += accepted.length;
      }
      if (bytes.length > remaining) {
        overflowed = true;
        const error = new RangeError(`${streamName} maxBuffer length exceeded`);
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        error.stream = streamName;
        return error;
      }
      return undefined;
    },
    value(encoding) {
      const value = Buffer.concat(chunks, length);
      return encoding === null || encoding === "buffer"
        ? value
        : value.toString(encoding);
    },
  };
}

function timeoutError(commandLine, timeout) {
  const error = new Error(`Command timed out after ${timeout}ms: ${commandLine}`);
  error.code = "ETIMEDOUT";
  return error;
}

function abortError(reason) {
  const error = new Error("The owned process was aborted", { cause: reason });
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function ownershipCleanupError(cause) {
  const error = new Error("failed to terminate the owned Unix process group", { cause });
  error.code = "ERR_OWNED_PROCESS_CLEANUP";
  return error;
}

function invalidOwnedGroupMarker(cause) {
  const error = new Error(
    "owned Unix process-group marker does not match the current process group",
    { cause },
  );
  error.code = "ERR_OWNED_PROCESS_GROUP_MARKER";
  return error;
}

function commandFailureError(commandLine, exitCode, signal, stderr) {
  const suffix = signal === null
    ? `code ${String(exitCode)}`
    : `signal ${signal}`;
  const diagnostic = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
  return new Error(
    `Command failed with ${suffix}: ${commandLine}${diagnostic ? `\n${diagnostic}` : ""}`,
  );
}

function decorateError(error, commandLine, stdout, stderr, killed, signal) {
  error.cmd = commandLine;
  error.killed = killed;
  error.signal = signal;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}
