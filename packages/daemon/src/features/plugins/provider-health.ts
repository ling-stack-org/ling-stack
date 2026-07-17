import type { McpServer, SecretResolver } from "@ling-stack/core";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import type { McpBroker } from "../../context.js";

export interface CuaDriverProviderHealthResult {
  readonly ok: boolean;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Tools required for the Windows preview handoff. `health_report` proves the
 * provider is attached to an interactive desktop; the other two tools are
 * the structured identity/state inputs used by the descriptor producer.
 */
export const CUA_DRIVER_REQUIRED_TOOL_NAMES = [
  "health_report",
  "list_windows",
  "get_window_state",
] as const;

export const CUA_DRIVER_REQUIRED_HEALTH_CHECK_NAMES = [
  "binary_version",
  "platform_supported",
  "session_active",
  "ax_capability",
  "screen_capture_capability",
] as const;
export const CUA_DRIVER_SUPPORTED_VERSIONS = ["0.8.3"] as const;

/**
 * Probe the provider-owned health contract on Windows. Electron's screen
 * permission API cannot detect Session 0, UIA, or DXGI availability, while
 * Cua Driver's `health_report` explicitly checks those conditions.
 */
export async function checkCuaDriverProviderHealth(input: {
  readonly server: McpServer;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly now: string;
  readonly platform?: NodeJS.Platform;
  readonly availableToolNames?: readonly string[];
}): Promise<CuaDriverProviderHealthResult> {
  if ((input.platform ?? process.platform) !== "win32") {
    return { ok: true, message: "Provider health probe is not required on this platform." };
  }
  if (input.availableToolNames) {
    const missingTools = CUA_DRIVER_REQUIRED_TOOL_NAMES.filter(
      (toolName) => !input.availableToolNames?.includes(toolName),
    );
    if (missingTools.length > 0) {
      return {
        ok: false,
        message: `Cua Driver is missing required Windows tool(s): ${missingTools.join(", ")}.`,
        details: {
          errorCode: "plugin_provider_incompatible",
          missingTools,
        },
      };
    }
  }

  let result: PiRunnerMcpToolCallResult;
  try {
    result = await input.mcpBroker.callTool(
      input.server,
      { secretResolver: input.secretResolver, now: () => input.now },
      "health_report",
      { include: [...CUA_DRIVER_REQUIRED_HEALTH_CHECK_NAMES] },
    );
  } catch (error) {
    return {
      ok: false,
      message: "Cua Driver health_report failed; verify the interactive Windows session.",
      details: {
        errorCode: "plugin_provider_health_failed",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (result.isError === true) {
    return {
      ok: false,
      message: "Cua Driver health_report returned an error.",
      details: { errorCode: "plugin_provider_health_failed" },
    };
  }
  const report = readStructuredHealthReport(result);
  if (!report) {
    return {
      ok: false,
      message: "Cua Driver returned no compatible structured health_report.",
      details: { errorCode: "plugin_provider_incompatible" },
    };
  }

  if (
    report.schemaVersion !== "1"
    || report.platform !== "win32"
    || !isSupportedProviderVersion(report.driverVersion)
  ) {
    return {
      ok: false,
      message: "Cua Driver health_report schema or platform version is incompatible with Windows preview capture.",
      details: {
        errorCode: "plugin_provider_incompatible",
        schemaVersion: report.schemaVersion,
        platform: report.platform,
        driverVersion: report.driverVersion,
        supportedDriverVersions: CUA_DRIVER_SUPPORTED_VERSIONS,
      },
    };
  }

  const requiredChecks = readRequiredChecks(report.checks);
  if (!requiredChecks) {
    return {
      ok: false,
      message: "Cua Driver health_report is missing a required Windows capability check.",
      details: {
        errorCode: "plugin_provider_incompatible",
        driverVersion: report.driverVersion,
        requiredChecks: CUA_DRIVER_REQUIRED_HEALTH_CHECK_NAMES,
      },
    };
  }

  if (report.overall !== "ok" || requiredChecks.some((check) => check.status !== "pass")) {
    return {
      ok: false,
      message: "Cua Driver is not healthy in the current Windows interactive session.",
      details: {
        errorCode: "plugin_provider_health_failed",
        driverVersion: report.driverVersion,
        platform: report.platform,
        overall: report.overall,
        checks: summarizeChecks(requiredChecks),
      },
    };
  }
  return {
    ok: true,
    message: "Cua Driver Windows provider health is OK.",
    details: {
      driverVersion: report.driverVersion,
      platform: report.platform,
      overall: report.overall,
      checks: summarizeChecks(requiredChecks),
    },
  };
}

interface StructuredHealthReport {
  readonly schemaVersion: string;
  readonly driverVersion: string;
  readonly platform: string;
  readonly overall: string;
  readonly checks: readonly unknown[];
}

interface StructuredHealthCheck {
  readonly name: string;
  readonly status: string;
  readonly message?: string;
  readonly hint?: string;
}

function readStructuredHealthReport(result: PiRunnerMcpToolCallResult): StructuredHealthReport | undefined {
  const candidates: unknown[] = [result.details];
  for (const content of result.content) {
    if (content.type === "text") {
      try {
        candidates.push(JSON.parse(content.text));
      } catch {
        // The structuredContent path below is authoritative.
      }
    }
  }
  for (const candidate of candidates) {
    const report = unwrapHealthReport(candidate);
    if (report) {
      return report;
    }
  }
  return undefined;
}

function unwrapHealthReport(value: unknown): StructuredHealthReport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nested = isRecord(value.structuredContent) ? value.structuredContent : value;
  if (
    typeof nested.schema_version === "string" &&
    typeof nested.driver_version === "string" &&
    typeof nested.platform === "string" &&
    typeof nested.overall === "string" &&
    Array.isArray(nested.checks)
  ) {
    return {
      schemaVersion: nested.schema_version,
      driverVersion: nested.driver_version,
      platform: nested.platform,
      overall: nested.overall,
      checks: nested.checks,
    };
  }
  return undefined;
}

function readRequiredChecks(checks: readonly unknown[]): readonly StructuredHealthCheck[] | undefined {
  const parsed = checks.flatMap((value): StructuredHealthCheck[] => {
    if (!isRecord(value) || typeof value.name !== "string" || typeof value.status !== "string") {
      return [];
    }
    return [{
      name: value.name,
      status: value.status,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
      ...(typeof value.hint === "string" ? { hint: value.hint } : {}),
    }];
  });
  const byName = new Map(parsed.map((check) => [check.name, check]));
  if (byName.size !== parsed.length || CUA_DRIVER_REQUIRED_HEALTH_CHECK_NAMES.some((name) => !byName.has(name))) {
    return undefined;
  }
  return CUA_DRIVER_REQUIRED_HEALTH_CHECK_NAMES.map((name) => byName.get(name) as StructuredHealthCheck);
}

function summarizeChecks(checks: readonly StructuredHealthCheck[]): readonly Readonly<Record<string, string>>[] {
  return checks.map((check) => ({
    name: check.name,
    status: check.status,
    ...(check.message ? { message: check.message } : {}),
    ...(check.hint ? { hint: check.hint } : {}),
  }));
}

function isSupportedProviderVersion(version: string): boolean {
  const normalized = version.trim();
  return CUA_DRIVER_SUPPORTED_VERSIONS.some((supported) => supported === normalized);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
