import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import {
  readAtomicPublishDirectoryIdentities,
  removeAtomicPublishUnsecuredEmptyDirectory,
  secureManagedStateDirectory,
  verifyManagedStateDirectorySecurity,
  withAtomicPublishParentLease,
} from "./cua-driver-package-atomic-publish.mjs";

const execFile = promisify(execFileCallback);

const CLIENT_PROTOCOL_VERSION = "2025-11-25";
const SERVER_PROTOCOL_VERSION = "2025-06-18";
const HEALTH_SCHEMA_VERSION = "1";
const PROVIDER_VERSION = "0.8.3";
const MAX_MCP_LINE_BYTES = 4 * 1024 * 1024;
const MAX_MCP_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_DIAGNOSTIC_BYTES = 16 * 1024;
const WINDOWS_FULL_CONTROL_MASK = 2_032_127;

export const FROZEN_HEALTH_SKIP = Object.freeze([
  "ax_capability",
  "bundle_identity",
  "screen_capture_capability",
  "tcc_accessibility",
  "tcc_screen_recording",
]);

export const FROZEN_DENIED_TOOLS = Object.freeze(["check_for_update"]);

/**
 * Run the built provider through its real embedded stdio MCP boundary and
 * prove that Ling-managed state cannot escape into the caller's normal home.
 *
 * The returned object deliberately omits the child nonce, host/provider PIDs
 * and generation. Those values are runtime-only identity material and must
 * never enter a checked-in or uploaded attestation.
 */
export async function probeCuaDriverProvider({
  binaryPath,
  platform,
  stateHome,
  hostPid = process.pid,
  healthSkip = FROZEN_HEALTH_SKIP,
  deniedTools = FROZEN_DENIED_TOOLS,
  timeoutMs = 30_000,
  spawnProcess = spawn,
  performStateAcceptance = true,
  inspectWindowsAcl = inspectManagedWindowsAcl,
}) {
  if (!binaryPath || !stateHome) throw new TypeError("binaryPath and stateHome are required");
  if (platform !== "darwin" && platform !== "win32-x64") {
    throw new TypeError(`unsupported provider platform: ${platform}`);
  }
  if (typeof spawnProcess !== "function") throw new TypeError("spawnProcess must be a function");
  if (typeof inspectWindowsAcl !== "function") throw new TypeError("inspectWindowsAcl must be a function");
  const lockedHealthSkip = validateHealthSkip(healthSkip);
  const lockedDeniedTools = validateDeniedTools(deniedTools);

  if (!performStateAcceptance) {
    return runProviderSession({
      binaryPath,
      platform,
      stateHome,
      hostPid,
      healthSkip: lockedHealthSkip,
      deniedTools: lockedDeniedTools,
      timeoutMs,
      spawnProcess,
    });
  }

  const externalHome = `${stateHome}-external-home`;
  const rootLink = `${stateHome}-root-link`;
  const rootLinkTarget = `${stateHome}-root-link-target`;
  await prepareManagedProbeStateHome(stateHome);
  await mkdir(join(externalHome, ".cua-driver"), { recursive: true });
  await mkdir(join(externalHome, ".cua-driver-rs"), { recursive: true });
  await writeFile(join(externalHome, ".cua-driver", "sentinel.bin"), "external-cua-driver-state");
  await writeFile(join(externalHome, ".cua-driver-rs", "sentinel.bin"), "external-cua-driver-rs-state");
  const escapeTarget = await createConfigEscapeFixture({ externalHome, platform, stateHome });
  const externalBefore = await snapshotExternalProviderState(externalHome);

  const setConfigRequest = {
    name: "set_config",
    arguments: { capture_scope: "desktop", experimental_pip: true },
  };
  const negative = await runProviderSession({
    binaryPath,
    platform,
    stateHome,
    externalHome,
    hostPid,
    healthSkip: lockedHealthSkip,
    deniedTools: lockedDeniedTools,
    timeoutMs,
    spawnProcess,
    configRequest: setConfigRequest,
    expectConfigError: true,
  });
  if (negative.configResult?.isError !== true) {
    throw new Error("managed config link fixture did not return ToolResult.isError=true");
  }
  const externalAfterRejectedWrite = await snapshotExternalProviderState(externalHome);
  assertSnapshotsEqual(externalBefore, externalAfterRejectedWrite, "rejected managed config write");
  await verifyEscapeFixtureUnchanged(escapeTarget);
  await unlink(join(stateHome, "config.json"));

  const positive = await runProviderSession({
    binaryPath,
    platform,
    stateHome,
    externalHome,
    hostPid,
    healthSkip: lockedHealthSkip,
    deniedTools: lockedDeniedTools,
    timeoutMs,
    spawnProcess,
    configRequest: setConfigRequest,
    expectConfigError: false,
  });
  if (positive.configResult?.isError === true) {
    throw new Error("managed config positive write returned ToolResult.isError=true");
  }
  const permissions = await verifyManagedStatePermissions({
    platform,
    stateHome,
    inspectWindowsAcl,
  });

  const restarted = await runProviderSession({
    binaryPath,
    platform,
    stateHome,
    externalHome,
    hostPid,
    healthSkip: lockedHealthSkip,
    deniedTools: lockedDeniedTools,
    timeoutMs,
    spawnProcess,
    configRequest: { name: "get_config", arguments: {} },
    expectConfigError: false,
  });
  const persisted = restarted.configResult?.structuredContent;
  if (persisted?.capture_scope !== "desktop" || persisted?.experimental_pip !== true) {
    throw new Error("managed config did not survive a real provider restart");
  }

  await mkdir(rootLinkTarget, { recursive: true });
  await symlink(rootLinkTarget, rootLink, platform === "win32-x64" ? "junction" : "dir");
  const rootLinkValue = await readlink(rootLink);
  await expectRootLinkStartupFailure({
    binaryPath,
    platform,
    stateHome: rootLink,
    externalHome,
    hostPid,
    timeoutMs,
    spawnProcess,
  });
  await verifyLinkUnchanged(rootLink, rootLinkValue, "managed state root link");

  const externalAfter = await snapshotExternalProviderState(externalHome);
  assertSnapshotsEqual(externalBefore, externalAfter, "managed state acceptance");
  const { configResult: _configResult, ...stableProbe } = positive;
  return {
    ...stableProbe,
    managedState: {
      preexistingLinkRejected: true,
      rootLinkRejectedBeforeInitialize: true,
      externalHomeUnchanged: true,
      restartPersistence: true,
      accessControl: permissions,
      sameUserConcurrentReplacementBoundary: "out_of_scope_v1",
    },
  };
}

/**
 * Apply the same private root contract required from Desktop before the real
 * managed provider starts. The native helper supplies 0700/current-euid on
 * Darwin and a protected current-user ACL plus reparse fencing on Windows.
 */
export async function prepareManagedProbeStateHome(stateHome, dependencies = {}) {
  const parentRoot = dirname(stateHome);
  const directoryName = basename(stateHome);
  const acquireParentLease = dependencies.withAtomicPublishParentLease
    ?? withAtomicPublishParentLease;
  const readIdentities = dependencies.readAtomicPublishDirectoryIdentities
    ?? readAtomicPublishDirectoryIdentities;
  const secureDirectory = dependencies.secureManagedStateDirectory
    ?? secureManagedStateDirectory;
  const verifyDirectory = dependencies.verifyManagedStateDirectorySecurity
    ?? verifyManagedStateDirectorySecurity;
  const removeEmptyDirectory = dependencies.removeAtomicPublishUnsecuredEmptyDirectory
    ?? removeAtomicPublishUnsecuredEmptyDirectory;
  await mkdir(parentRoot, { recursive: true, mode: 0o700 });
  return acquireParentLease({ parentRoot }, async (lease) => {
    let created = false;
    let identities;
    try {
      await lease.guard(() => mkdir(stateHome, { mode: 0o700 }));
      created = true;
      lease.assertHeld();
      identities = await readIdentities({
        parentRoot,
        sourceName: directoryName,
      }, lease);
      lease.assertHeld();
      const secured = await secureDirectory({
        directoryName,
        expectedDirectoryIdentity: identities.sourceIdentity,
        expectedParentIdentity: identities.parentIdentity,
        parentRoot,
      }, lease);
      lease.assertHeld();
      await verifyDirectory({
        directoryName,
        expectedDirectoryIdentity: secured.directoryIdentity,
        expectedParentIdentity: secured.parentIdentity,
        parentRoot,
      }, lease);
      lease.assertHeld();
      return secured;
    } catch (error) {
      if (created && identities !== undefined) {
        try {
          await lease.guard(() => removeEmptyDirectory({
            expectedParentIdentity: identities.parentIdentity,
            expectedSourceIdentity: identities.sourceIdentity,
            parentRoot,
            sourceName: directoryName,
          }, lease));
        } catch (cleanupError) {
          attachManagedStatePreparationCleanupError(error, cleanupError, stateHome);
        }
      }
      throw error;
    }
  });
}

function attachManagedStatePreparationCleanupError(error, cleanupError, stateHome) {
  if (!(error instanceof Error) || !Object.isExtensible(error)) return;
  try {
    Object.defineProperties(error, {
      managedStateCleanupError: {
        configurable: true,
        enumerable: false,
        value: cleanupError,
      },
      managedStateResiduePath: {
        configurable: true,
        enumerable: false,
        value: stateHome,
      },
    });
  } catch {
    // Preserve the preparation failure if diagnostic metadata is immutable.
  }
}

async function runProviderSession({
  binaryPath,
  platform,
  stateHome,
  externalHome,
  hostPid,
  healthSkip,
  deniedTools,
  timeoutMs,
  spawnProcess,
  configRequest,
  expectConfigError,
}) {
  await mkdir(stateHome, { recursive: true });
  const nonce = randomBytes(24).toString("hex");
  const environment = {
    ...process.env,
    ...(externalHome ? { HOME: externalHome, USERPROFILE: externalHome } : {}),
    CUA_DRIVER_LING_MANAGED: "1",
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_STATE_HOME: stateHome,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    CUA_DRIVER_TELEMETRY_HOME: join(stateHome, "telemetry"),
    CUA_DRIVER_HOST_PID: String(hostPid),
    CUA_DRIVER_CHILD_INSTANCE_NONCE: nonce,
    CUA_DRIVER_LEASE_GENERATION: "1",
  };
  const child = spawnProcess(binaryPath, ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const responses = new Map();
  let stdoutBuffer = "";
  let stdoutBytes = 0;
  const stdoutDecoder = new StringDecoder("utf8");
  let stdoutDecoderFlushed = false;
  const stderrChunks = [];
  let stderrBytes = 0;
  let stderrTruncated = false;
  let stdinClosed = false;
  let settled = false;
  let timer;
  const expectedResponseIds = new Set([1, 2, 3]);
  if (platform === "win32-x64") expectedResponseIds.add(4);
  if (configRequest) expectedResponseIds.add(5);

  const result = await new Promise((resolve, reject) => {
    let toolRequestsSent = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* best effort */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const sendToolRequests = () => {
      if (toolRequestsSent) return;
      toolRequestsSent = true;
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      send(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "health_report", arguments: { skip: healthSkip } },
      });
      if (configRequest) {
        send(child, {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: configRequest,
        });
      }
    };
    const finishIfReady = () => {
      const required = platform === "win32-x64" ? [1, 2, 3, 4] : [1, 2, 3];
      if (configRequest) required.push(5);
      if (!required.every((id) => responses.has(id)) || stdinClosed) return;
      stdinClosed = true;
      child.stdin.end();
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (!settled && !stdinClosed) {
        fail(providerExitError({ code, signal, stderrChunks, stderrTruncated }));
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (!stdoutDecoderFlushed) {
        stdoutBuffer += stdoutDecoder.end();
        stdoutDecoderFlushed = true;
      }
      if (code !== 0 || signal !== null) {
        fail(new Error(`provider probe exited with code ${code} signal=${signal ?? "none"}`));
        return;
      }
      if (stdoutBuffer.trim()) {
        fail(new Error("provider MCP stdout ended with an unterminated response"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        const initialize = responses.get(1)?.result;
        const tools = responses.get(2)?.result;
        const health = responses.get(3)?.result;
        const readiness = responses.get(4)?.result;
        const configResult = responses.get(5)?.result;
        if (responses.get(1)?.error || responses.get(2)?.error || responses.get(3)?.error || responses.get(4)?.error) {
          throw new Error("provider probe returned a JSON-RPC error");
        }
        if (responses.get(5)?.error) {
          throw new Error("provider config probe returned a top-level JSON-RPC error");
        }
        if (configRequest && expectConfigError === true && configResult?.isError !== true) {
          throw new Error("provider config probe did not return ToolResult.isError=true");
        }
        if (configRequest && expectConfigError === false && configResult?.isError === true) {
          throw new Error("provider config probe unexpectedly returned ToolResult.isError=true");
        }
        if (initialize?.protocolVersion !== SERVER_PROTOCOL_VERSION) {
          throw new Error(`provider protocol version mismatch: ${initialize?.protocolVersion ?? "missing"}`);
        }
        if (
          !initialize.serverInfo
          || initialize.serverInfo.name !== "cua-driver"
          || initialize.serverInfo.version !== PROVIDER_VERSION
        ) {
          throw new Error("provider initialize server identity mismatch");
        }
        const healthReport = health?.structuredContent ?? parseHealthText(health);
        const healthSchema = healthReport?.schema_version;
        if (String(healthSchema) !== HEALTH_SCHEMA_VERSION) {
          throw new Error(`provider health schema mismatch: ${healthSchema ?? "missing"}`);
        }
        const healthCoreChecks = validateHealthReport(healthReport, healthSkip, platform);
        const toolsProjection = canonicalizeToolsList(tools);
        for (const deniedTool of deniedTools) {
          if (toolsProjection.some((tool) => tool.name === deniedTool)) {
            throw new Error(`managed provider exposed denied updater tool: ${deniedTool}`);
          }
        }
        const managedReadiness = platform === "win32-x64"
          ? validateManagedReadiness(readiness, {
              childPid: child.pid,
              hostPid,
              nonce,
            })
          : undefined;
        resolve({
          platform,
          clientInitializeProtocolVersion: CLIENT_PROTOCOL_VERSION,
          serverInitializeProtocolVersion: initialize.protocolVersion,
          serverInfo: initialize.serverInfo,
          toolsListCanonicalSha256: sha256Text(canonicalJson(toolsProjection)),
          healthSchemaVersion: HEALTH_SCHEMA_VERSION,
          healthProbeSkip: healthSkip,
          healthCoreChecks,
          managedDeniedTools: deniedTools,
          stdinEof: "passed",
          ...(configRequest ? { configResult } : {}),
          ...(platform === "win32-x64" ? {
            managedReadiness,
          } : {}),
        });
      } catch (error) {
        reject(error);
      }
    });
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_MCP_STDOUT_BYTES) {
        fail(new Error(`provider MCP stdout exceeded ${MAX_MCP_STDOUT_BYTES} bytes`));
        return;
      }
      stdoutBuffer += stdoutDecoder.write(bytes);
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line, "utf8") > MAX_MCP_LINE_BYTES) {
          fail(new Error(`provider MCP response exceeded ${MAX_MCP_LINE_BYTES} bytes`));
          return;
        }
        let message;
        try { message = JSON.parse(line); } catch { fail(new Error("provider emitted non-JSON stdout")); return; }
        if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
          fail(new Error("provider emitted an invalid JSON-RPC message"));
          return;
        }
        if (Number.isSafeInteger(message.id)) {
          if (!expectedResponseIds.has(message.id) || responses.has(message.id)) {
            fail(new Error(`provider emitted an unexpected or duplicate response id: ${message.id}`));
            return;
          }
          const hasResult = Object.hasOwn(message, "result");
          const hasError = Object.hasOwn(message, "error");
          if (hasResult === hasError) {
            fail(new Error(`provider response ${message.id} must contain exactly one of result or error`));
            return;
          }
          responses.set(message.id, message);
          if (message.id === 1 && !toolRequestsSent) {
            send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
            if (platform === "win32-x64") {
              send(child, {
                jsonrpc: "2.0",
                id: 4,
                method: "ling/managed_readiness",
                params: { schemaVersion: 1, childInstanceNonce: nonce, leaseGeneration: 1 },
              });
            } else {
              sendToolRequests();
            }
          }
          if (message.id === 4 && platform === "win32-x64") {
            if (message.error) {
              fail(new Error("provider readiness probe returned a JSON-RPC error"));
              return;
            }
            try {
              validateManagedReadiness(message.result, {
                childPid: child.pid,
                hostPid,
                nonce,
              });
            } catch (error) {
              fail(error);
              return;
            }
            sendToolRequests();
          }
          finishIfReady();
        } else if (typeof message.method !== "string" || Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
          fail(new Error("provider emitted an invalid JSON-RPC notification"));
          return;
        }
      }
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_MCP_LINE_BYTES) {
        fail(new Error(`provider MCP response exceeded ${MAX_MCP_LINE_BYTES} bytes without a delimiter`));
      }
    });
    child.stderr.on("data", (chunk) => {
      // Diagnostics never enter the attestation. Retain only a bounded buffer
      // so an early native startup failure can be classified after redaction.
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, MAX_PROVIDER_DIAGNOSTIC_BYTES - stderrBytes);
      if (remaining > 0) {
        const accepted = bytes.subarray(0, remaining);
        stderrChunks.push(accepted);
        stderrBytes += accepted.length;
      }
      if (bytes.length > remaining) stderrTruncated = true;
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
    });
    timer = setTimeout(() => fail(new Error(`provider probe timed out after ${timeoutMs}ms`)), timeoutMs);
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ling-cua-driver-source-build-probe", version: "1" },
      },
    });
  });
  return result;
}

function providerExitError({ code, signal, stderrChunks, stderrTruncated }) {
  const diagnostic = sanitizeProviderDiagnostic(Buffer.concat(stderrChunks).toString("utf8"));
  return new Error([
    `provider exited before probe completed: code=${code} signal=${signal ?? "none"}`,
    diagnostic ? `diagnostic=${diagnostic}${stderrTruncated ? " [truncated]" : ""}` : "",
  ].filter(Boolean).join(" "));
}

export function sanitizeProviderDiagnosticForTest(value) {
  return sanitizeProviderDiagnostic(value);
}

function sanitizeProviderDiagnostic(value) {
  return String(value ?? "")
    .replaceAll("\0", "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" | ")
    .replace(/[A-Za-z]:\\[^|\r\n]*/gu, "<windows-path>")
    .replace(/\/(?:Users|home|tmp|var)\/[^|\s]*/gu, "<path>")
    .replace(/\b((?:host|provider|child|process)[ _-]?pid)\s*[=:]\s*\d+\b/giu, "$1=<redacted>")
    .slice(0, 2_048);
}

async function createConfigEscapeFixture({ externalHome, platform, stateHome }) {
  const configLink = join(stateHome, "config.json");
  if (platform === "win32-x64") {
    const targetDirectory = join(externalHome, ".cua-driver", "managed-escape-target");
    const sentinel = join(targetDirectory, "sentinel.bin");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(sentinel, "managed-config-must-not-touch-this-directory");
    await symlink(targetDirectory, configLink, "junction");
    return {
      sentinel,
      expected: "managed-config-must-not-touch-this-directory",
      linkPath: configLink,
      linkTarget: await readlink(configLink),
    };
  }
  const sentinel = join(externalHome, ".cua-driver", "managed-escape-sentinel.json");
  await writeFile(sentinel, "managed-config-must-not-touch-this-file");
  await symlink(sentinel, configLink, "file");
  return {
    sentinel,
    expected: "managed-config-must-not-touch-this-file",
    linkPath: configLink,
    linkTarget: await readlink(configLink),
  };
}

async function verifyEscapeFixtureUnchanged({ sentinel, expected, linkPath, linkTarget }) {
  if ((await readFile(sentinel, "utf8")) !== expected) {
    throw new Error("managed config link fixture changed its external sentinel");
  }
  await verifyLinkUnchanged(linkPath, linkTarget, "managed config link fixture");
}

export async function verifyLinkUnchanged(path, expectedTarget, label) {
  const metadata = await lstat(path);
  if (!metadata.isSymbolicLink() || await readlink(path) !== expectedTarget) {
    throw new Error(`${label} was replaced or retargeted`);
  }
}

async function snapshotExternalProviderState(externalHome) {
  const roots = [".cua-driver", ".cua-driver-rs"];
  const snapshot = [];
  for (const root of roots) {
    await snapshotTree(join(externalHome, root), root, snapshot);
  }
  return snapshot;
}

async function snapshotTree(path, relativePath, output) {
  const metadata = await lstat(path);
  const common = { path: relativePath, mode: metadata.mode & 0o777 };
  if (metadata.isDirectory()) {
    output.push({ ...common, type: "directory" });
    const entries = await readdir(path);
    entries.sort();
    for (const entry of entries) {
      await snapshotTree(join(path, entry), `${relativePath}/${entry}`, output);
    }
    return;
  }
  if (metadata.isSymbolicLink()) {
    output.push({ ...common, type: "symlink", target: await readlink(path) });
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`external provider-state fixture contains unsupported entry: ${relativePath}`);
  }
  output.push({
    ...common,
    type: "file",
    size: metadata.size,
    sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
  });
}

function assertSnapshotsEqual(before, after, label) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`external HOME provider state changed during ${label}`);
  }
}

export async function verifyManagedStatePermissions({
  platform,
  stateHome,
  inspectWindowsAcl = inspectManagedWindowsAcl,
}) {
  const entries = [];
  await inspectManagedStateTree(stateHome, ".", entries);
  const config = entries.find((entry) => entry.relativePath === "config.json");
  if (!config || config.type !== "file") {
    throw new Error("managed state positive fixture did not create a regular config file");
  }

  if (platform === "darwin") {
    for (const entry of entries) {
      const expectedMode = entry.type === "directory" ? 0o700 : 0o600;
      if (entry.mode !== expectedMode) {
        throw new Error(
          `managed state permissions mismatch: ${entry.relativePath}=${entry.mode.toString(8)} expected=${expectedMode.toString(8)}`,
        );
      }
    }
    return { root: "0700", directories: "0700", files: "0600" };
  }
  if (platform !== "win32-x64") throw new Error(`unsupported managed-state platform: ${platform}`);

  for (const entry of entries) {
    validateManagedWindowsAcl(await inspectWindowsAcl(entry.path), entry.relativePath);
  }
  return {
    root: "current_user_only_protected_dacl",
    directories: "current_user_only_protected_dacl",
    files: "current_user_only_protected_dacl",
  };
}

async function inspectManagedStateTree(path, relativePath, entries) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`managed state contains a link or reparse point: ${relativePath}`);
  }
  const common = {
    path,
    relativePath,
    mode: metadata.mode & 0o777,
  };
  if (metadata.isDirectory()) {
    entries.push({ ...common, type: "directory" });
    for (const name of (await readdir(path)).sort()) {
      await inspectManagedStateTree(join(path, name), relativePath === "." ? name : `${relativePath}/${name}`, entries);
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`managed state contains a non-regular entry: ${relativePath}`);
  }
  entries.push({ ...common, type: "file" });
}

export function validateManagedWindowsAcl(value, label = "managed state entry") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} ACL evidence is missing`);
  }
  const expectedKeys = ["areAccessRulesProtected", "currentSid", "ownerSid", "rules"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} ACL evidence keys changed`);
  }
  if (
    value.areAccessRulesProtected !== true
    || typeof value.currentSid !== "string"
    || value.currentSid.length === 0
    || value.ownerSid !== value.currentSid
    || !Array.isArray(value.rules)
    || value.rules.length !== 1
  ) {
    throw new Error(`${label} ACL owner/protection invariant failed`);
  }
  const [rule] = value.rules;
  const ruleKeys = ["accessControlType", "fileSystemRights", "isInherited", "sid"];
  if (
    !rule
    || typeof rule !== "object"
    || Array.isArray(rule)
    || JSON.stringify(Object.keys(rule).sort()) !== JSON.stringify(ruleKeys)
    || rule.sid !== value.currentSid
    || rule.accessControlType !== "Allow"
    || rule.isInherited !== false
    || rule.fileSystemRights !== WINDOWS_FULL_CONTROL_MASK
  ) {
    throw new Error(`${label} ACL rule invariant failed`);
  }
  return true;
}

async function inspectManagedWindowsAcl(path) {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot) throw new Error("Windows SystemRoot is unavailable for ACL verification");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$acl = Get-Acl -LiteralPath $env:LING_CUA_ACL_PATH",
    "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "try { $ownerSid = ([System.Security.Principal.SecurityIdentifier]$acl.Owner).Value }",
    "catch { $ownerSid = ([System.Security.Principal.NTAccount]::new($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value }",
    "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {",
    "  [ordered]@{ sid = $_.IdentityReference.Value; accessControlType = $_.AccessControlType.ToString(); isInherited = $_.IsInherited; fileSystemRights = [int]$_.FileSystemRights }",
    "})",
    "[ordered]@{ areAccessRulesProtected = $acl.AreAccessRulesProtected; ownerSid = $ownerSid; currentSid = $currentSid; rules = $rules } | ConvertTo-Json -Compress -Depth 5",
  ].join("\n");
  const result = await execFile(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    env: { ...process.env, LING_CUA_ACL_PATH: path },
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`PowerShell returned invalid ACL evidence for ${path}`, { cause: error });
  }
}

async function expectRootLinkStartupFailure({
  binaryPath,
  platform: _platform,
  stateHome,
  externalHome,
  hostPid,
  timeoutMs,
  spawnProcess,
}) {
  const nonce = randomBytes(24).toString("hex");
  const child = spawnProcess(
    binaryPath,
    ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"],
    {
      env: {
        ...process.env,
        HOME: externalHome,
        USERPROFILE: externalHome,
        CUA_DRIVER_LING_MANAGED: "1",
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_STATE_HOME: stateHome,
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        CUA_DRIVER_RS_UPDATE_CHECK: "false",
        CUA_DRIVER_TELEMETRY_HOME: join(stateHome, "telemetry"),
        CUA_DRIVER_HOST_PID: String(hostPid),
        CUA_DRIVER_CHILD_INSTANCE_NONCE: nonce,
        CUA_DRIVER_LEASE_GENERATION: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best effort */ }
      reject(new Error(`root-link startup probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 || code === null) {
        reject(new Error("provider accepted a managed state root link/reparse point"));
        return;
      }
      if (stdout.trim()) {
        reject(new Error("provider emitted MCP stdout before rejecting the managed root link"));
        return;
      }
      resolve();
    });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
    });
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ling-cua-driver-root-link-probe", version: "1" },
      },
    });
  });
}

function send(child, value) {
  if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
}

function parseHealthText(value) {
  const text = value?.content?.find?.((item) => item?.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function validateManagedReadiness(value, { childPid, hostPid, nonce }) {
  const expectedKeys = [
    "childInstanceNonce",
    "contentObserved",
    "d3d11",
    "hostIntegrityLevel",
    "hostProcessId",
    "hostSessionId",
    "inputDesktop",
    "jobObjectAssigned",
    "killOnJobClose",
    "leaseGeneration",
    "providerIntegrityLevel",
    "providerProcessId",
    "providerSessionId",
    "readinessSequence",
    "schemaVersion",
    "uiaRuntime",
    "wgcApi",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider readiness response is not an object");
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("provider readiness response keys do not match the locked contract");
  }
  if (
    value.schemaVersion !== 1
    || value.childInstanceNonce !== nonce
    || value.leaseGeneration !== 1
    || value.readinessSequence !== 1
    || value.hostProcessId !== hostPid
    || !Number.isSafeInteger(childPid)
    || childPid <= 0
    || value.providerProcessId !== childPid
    || !Number.isSafeInteger(value.hostSessionId)
    || value.hostSessionId <= 0
    || !Number.isSafeInteger(value.providerSessionId)
    || value.providerSessionId <= 0
    || value.providerSessionId !== value.hostSessionId
    || value.hostIntegrityLevel !== "medium"
    || value.providerIntegrityLevel !== "medium"
    || value.inputDesktop !== "default_unlocked"
    || value.jobObjectAssigned !== true
    || value.killOnJobClose !== true
    || value.uiaRuntime !== "available"
    || value.d3d11 !== "available"
    || value.wgcApi !== "supported"
    || value.contentObserved !== false
  ) {
    throw new Error("provider readiness identity or lifetime invariant failed");
  }
  return {
    schemaVersion: 1,
    readinessSequence: 1,
    activeChildPidBound: true,
    childInstanceNonceBound: true,
    leaseGenerationBound: true,
    sameInteractiveSession: true,
    hostIntegrityLevel: "medium",
    providerIntegrityLevel: "medium",
    inputDesktop: "default_unlocked",
    jobObjectAssigned: true,
    killOnJobClose: true,
    uiaRuntime: "available",
    d3d11: "available",
    wgcApi: "supported",
    contentObserved: false,
  };
}

function validateHealthSkip(value) {
  if (!Array.isArray(value)) throw new TypeError("health skip list must be an array");
  const normalized = value.map((entry) => String(entry));
  if (JSON.stringify(normalized) !== JSON.stringify(FROZEN_HEALTH_SKIP)) {
    throw new Error("health skip list does not match the frozen source-build contract");
  }
  return [...normalized];
}

function validateDeniedTools(value) {
  if (!Array.isArray(value)) throw new TypeError("managed denied tools must be an array");
  const normalized = value.map((entry) => String(entry));
  if (JSON.stringify(normalized) !== JSON.stringify(FROZEN_DENIED_TOOLS)) {
    throw new Error("managed denied tools do not match the frozen source-build contract");
  }
  return [...normalized];
}

function validateHealthReport(value, healthSkip, platform) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.checks)) {
    throw new Error("provider health report is not a structured check list");
  }
  const expectedPlatform = platform === "darwin" ? "darwin" : "win32";
  if (
    String(value.schema_version) !== HEALTH_SCHEMA_VERSION
    || value.driver_version !== PROVIDER_VERSION
    || value.overall !== "ok"
    || value.platform !== expectedPlatform
  ) {
    throw new Error("provider health report identity or overall status mismatch");
  }
  const checks = new Map();
  for (const entry of value.checks) {
    if (!entry || typeof entry.name !== "string" || checks.has(entry.name)) {
      throw new Error("provider health report has an invalid or duplicate check");
    }
    checks.set(entry.name, entry.status);
  }
  for (const name of ["binary_version", "platform_supported", "session_active"]) {
    if (checks.get(name) !== "pass") {
      throw new Error(`provider health core check did not pass: ${name}`);
    }
  }
  for (const name of healthSkip) {
    if (checks.get(name) !== "skip") {
      throw new Error(`provider health report did not skip frozen check: ${name}`);
    }
  }
  const expectedNames = ["binary_version", "platform_supported", "session_active", ...healthSkip].sort();
  if (JSON.stringify([...checks.keys()].sort()) !== JSON.stringify(expectedNames)) {
    throw new Error("provider health check inventory changed");
  }
  return {
    binaryVersion: "pass",
    platformSupported: "pass",
    sessionActive: "pass",
  };
}

export function canonicalizeToolsList(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.tools)) {
    throw new TypeError("tools/list result must contain a tools array");
  }
  const tools = value.tools.map((tool) => {
    if (
      !tool
      || typeof tool !== "object"
      || Array.isArray(tool)
      || typeof tool.name !== "string"
      || typeof tool.description !== "string"
      || !tool.inputSchema
      || typeof tool.inputSchema !== "object"
      || Array.isArray(tool.inputSchema)
      || !tool.annotations
      || typeof tool.annotations !== "object"
      || Array.isArray(tool.annotations)
    ) {
      throw new TypeError("tools/list contains a tool outside the locked projection contract");
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    };
  });
  tools.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error("tools/list contains duplicate raw tool names");
  }
  return tools;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
