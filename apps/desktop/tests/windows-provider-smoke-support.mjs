const MAX_WINDOWS_PID = 0xffff_ffff;
const MINIMUM_PROVIDER_VERSION = [0, 8, 3];
const REQUIRED_HEALTH_CHECKS = [
  "binary_version",
  "platform_supported",
  "session_active",
  "ax_capability",
  "screen_capture_capability",
];

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
    || !isProviderVersionAtLeast(report.driver_version)
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

function isProviderVersionAtLeast(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim());
  if (!match) {
    return false;
  }
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < MINIMUM_PROVIDER_VERSION.length; index += 1) {
    if (current[index] !== MINIMUM_PROVIDER_VERSION[index]) {
      return current[index] > MINIMUM_PROVIDER_VERSION[index];
    }
  }
  return true;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
