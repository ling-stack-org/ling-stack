const MAX_WINDOWS_PID = 0xffff_ffff;
const SUPPORTED_PROVIDER_VERSIONS = new Set(["0.8.3"]);
const REQUIRED_HEALTH_CHECKS = [
  "binary_version",
  "platform_supported",
  "session_active",
  "ax_capability",
  "screen_capture_capability",
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BUNDLED_RUNTIME_READY_PREFIX =
  "Ling Stack Desktop Windows bundled provider runtime ready ";

/**
 * Parse the provider-owned schema-v1 health report. This is deliberately
 * independent from Ling's daemon parser so the VM smoke proves the CLI/MCP
 * provider itself before Desktop is launched.
 */
export function parseWindowsProviderHealthReport(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("windows_provider_smoke_health_json_invalid");
  }
  const report = isRecord(payload) && isRecord(payload.structuredContent)
    ? payload.structuredContent
    : payload;
  if (!isRecord(report)) {
    throw new Error("windows_provider_smoke_health_shape_invalid");
  }
  if (
    report.schema_version !== "1"
    || report.platform !== "win32"
    || typeof report.driver_version !== "string"
    || !SUPPORTED_PROVIDER_VERSIONS.has(report.driver_version.trim())
    || report.overall !== "ok"
    || !Array.isArray(report.checks)
  ) {
    throw new Error("windows_provider_smoke_health_incompatible");
  }
  const checks = report.checks.filter(isRecord);
  const byName = new Map(checks.map((check) => [check.name, check]));
  if (
    byName.size !== checks.length
    || REQUIRED_HEALTH_CHECKS.some((name) => byName.get(name)?.status !== "pass")
  ) {
    throw new Error("windows_provider_smoke_health_capability_failed");
  }
  return {
    driverVersion: report.driver_version,
    platform: report.platform,
    overall: report.overall,
    checks: REQUIRED_HEALTH_CHECKS.map((name) => ({
      name,
      status: byName.get(name).status,
    })),
  };
}

/**
 * Validate the daemon response that can only become ready after packaged
 * Desktop publishes a verified lease and the daemon initializes that exact
 * bundled child through Desktop's loopback MCP proxy.
 */
export function parseWindowsBundledProviderActivation(value) {
  if (!isRecord(value)) {
    throw new Error("windows_bundled_provider_activation_shape_invalid");
  }
  const plugin = value.plugin;
  const setup = isRecord(plugin) ? plugin.setup : undefined;
  const health = value.health;
  const details = isRecord(health) ? health.details : undefined;
  const statusSnapshot = value.statusSnapshot;
  const tools = Array.isArray(value.tools) ? value.tools : [];
  const toolIds = tools.map((tool) => isRecord(tool)
    && tool.serverId === "mcp_cua_driver"
    && typeof tool.rawName === "string"
    && tool.callableNamespace === "mcp_cua_driver"
    && tool.callableName === tool.rawName
    && tool.enabled === true
    ? `${tool.serverId}:${tool.rawName}`
    : undefined);
  if (
    !isRecord(plugin)
    || plugin.id !== "trusted-local:cua-driver"
    || !isRecord(setup)
    || setup.distribution !== "bundled_embedded"
    || setup.providerState !== "ready"
    || !isRecord(health)
    || health.status !== "ready"
    || !isRecord(details)
    || details.providerState !== "ready"
    || details.platform !== "win32"
    || details.providerVersion !== "0.8.3"
    || details.providerDistributionRevision !== "ling.1"
    || details.integrityCoverage !== "standard"
    || typeof details.desktopInstanceId !== "string"
    || details.desktopInstanceId.length === 0
    || !positiveInteger(details.desktopInstanceEpoch)
    || !positiveInteger(details.generation)
    || !SHA256_PATTERN.test(details.providerSealDigest ?? "")
    || !SHA256_PATTERN.test(details.providerCatalogDigest ?? "")
    || !isRecord(statusSnapshot)
    || statusSnapshot.status !== "ready"
    || tools.length === 0
    || toolIds.some((toolId) => typeof toolId !== "string" || toolId.length === 0)
    || new Set(toolIds).size !== toolIds.length
    || toolIds.filter((toolId) => toolId === "mcp_cua_driver:list_windows").length !== 1
  ) {
    throw new Error("windows_bundled_provider_activation_not_ready");
  }
  return {
    desktopInstanceId: details.desktopInstanceId,
    desktopInstanceEpoch: details.desktopInstanceEpoch,
    generation: details.generation,
    providerVersion: details.providerVersion,
    providerSealDigest: details.providerSealDigest,
    providerCatalogDigest: details.providerCatalogDigest,
    toolCount: tools.length,
    toolIds,
  };
}

/**
 * Parse the structured proof emitted only after packaged Desktop asks the
 * daemon to call list_windows through the current generation proxy and the
 * daemon returns the exact PID/HWND owner.
 */
export function parseWindowsBundledProviderRuntimeProof(stdout) {
  if (typeof stdout !== "string") {
    throw new Error("windows_bundled_provider_runtime_proof_output_invalid");
  }
  const proofLines = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(BUNDLED_RUNTIME_READY_PREFIX));
  if (proofLines.length !== 1) {
    throw new Error(`windows_bundled_provider_runtime_proof_count_invalid:${proofLines.length}`);
  }
  let value;
  try {
    value = JSON.parse(proofLines[0].slice(BUNDLED_RUNTIME_READY_PREFIX.length));
  } catch {
    throw new Error("windows_bundled_provider_runtime_proof_json_invalid");
  }
  const target = isRecord(value) ? value.target : undefined;
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.desktopInstanceId !== "string"
    || value.desktopInstanceId.length === 0
    || !positiveInteger(value.desktopInstanceEpoch)
    || !positiveInteger(value.generation)
    || !positiveInteger(value.providerProcessId)
    || typeof value.executablePath !== "string"
    || !/^(?:[A-Za-z]:[\\/]|\\\\)[\s\S]+/u.test(value.executablePath)
    || !SHA256_PATTERN.test(value.providerChildInstanceNonceSha256 ?? "")
    || !SHA256_PATTERN.test(value.lockDigest ?? "")
    || !SHA256_PATTERN.test(value.providerSealDigest ?? "")
    || !SHA256_PATTERN.test(value.providerCatalogDigest ?? "")
    || !isRecord(target)
    || target.platform !== "windows"
    || !positiveInteger(target.processId)
    || typeof target.nativeWindowId !== "string"
    || !/^[1-9][0-9]*$/u.test(target.nativeWindowId)
  ) {
    throw new Error("windows_bundled_provider_runtime_proof_invalid");
  }
  return {
    desktopInstanceId: value.desktopInstanceId,
    desktopInstanceEpoch: value.desktopInstanceEpoch,
    generation: value.generation,
    providerProcessId: value.providerProcessId,
    executablePath: value.executablePath,
    providerChildInstanceNonceSha256: value.providerChildInstanceNonceSha256,
    lockDigest: value.lockDigest,
    providerSealDigest: value.providerSealDigest,
    providerCatalogDigest: value.providerCatalogDigest,
    target: {
      processId: target.processId,
      nativeWindowId: target.nativeWindowId,
    },
  };
}

export function assertWindowsBundledRuntimeProof({
  activation,
  proof,
  target,
  expectedExecutablePath,
}) {
  if (
    proof.desktopInstanceId !== activation.desktopInstanceId
    || proof.desktopInstanceEpoch !== activation.desktopInstanceEpoch
    || proof.generation !== activation.generation
    || proof.providerSealDigest !== activation.providerSealDigest
    || proof.providerCatalogDigest !== activation.providerCatalogDigest
    || proof.target.processId !== target.processId
    || proof.target.nativeWindowId !== target.nativeWindowId
    || normalizeWindowsPath(proof.executablePath) !== normalizeWindowsPath(expectedExecutablePath)
  ) {
    throw new Error("windows_bundled_provider_runtime_proof_activation_mismatch");
  }
  return proof;
}

/**
 * Parse the structured JSON emitted by `cua-driver call list_windows` and
 * select exactly one HWND by the test-owned target process id.
 *
 * Titles, foreground state, and z-order are deliberately ignored. A smoke
 * result is useful as provider evidence only when the provider returns one
 * unambiguous, exact PID/HWND pair.
 */
export function parseExactWindowsProviderTarget(stdout, targetPid) {
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0 || targetPid > MAX_WINDOWS_PID) {
    throw new Error("windows_provider_smoke_target_pid_invalid");
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("windows_provider_smoke_list_windows_json_invalid");
  }
  if (!isRecord(payload) || !Array.isArray(payload.windows)) {
    throw new Error("windows_provider_smoke_list_windows_shape_invalid");
  }

  const exactPidWindows = payload.windows.filter((window) => (
    isRecord(window) && readProviderPid(window.pid) === targetPid
  ));
  if (exactPidWindows.length === 0) {
    throw new Error("windows_provider_smoke_target_not_found");
  }
  if (exactPidWindows.length !== 1) {
    throw new Error(`windows_provider_smoke_target_ambiguous:${exactPidWindows.length}`);
  }

  const nativeWindowId = readProviderWindowId(exactPidWindows[0].window_id);
  if (!nativeWindowId) {
    throw new Error("windows_provider_smoke_window_id_invalid");
  }
  return {
    processId: targetPid,
    nativeWindowId,
  };
}

function readProviderPid(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_WINDOWS_PID
    ? value
    : undefined;
}

function readProviderWindowId(value) {
  if (Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= 0xffff_ffff_ffff_ffffn ? value : undefined;
  } catch {
    return undefined;
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeWindowsPath(value) {
  return typeof value === "string" ? value.replaceAll("/", "\\").toLowerCase() : "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
