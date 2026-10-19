import type { ExecutionEngineConnectionProbe, ExternalExecutionEngineId } from "@ling-stack/contracts";

export function engineGuideUrl(engineId: ExternalExecutionEngineId): string | undefined {
  switch (engineId) {
    case "codex-app-server": return "https://developers.openai.com/codex/cli/";
    case "claude-agent-sdk": return "https://code.claude.com/docs/en/setup";
    case "kimi-acp": return "https://moonshotai.github.io/kimi-code/en/guides/getting-started";
    case "openclaw-acp": return "https://docs.openclaw.ai/cli/acp";
  }
}

export function engineProbeMessage(outcome: ExecutionEngineConnectionProbe["status"], t: (key: string) => string): string {
  switch (outcome) {
    case "connected": return t("Connected");
    case "auth_required": return t("Sign in required.");
    case "not_found": return t("Executable not found");
    case "not_executable": return t("File is not executable");
    case "unexpected_runtime": return t("Incompatible");
    case "unsupported_engine": return t("Not available in this version.");
    case "unsupported_platform": return t("Unsupported platform");
    case "unsupported_auth": return t("Unsupported authentication method");
    case "timed_out": return t("Timed out");
    case "cancelled": return t("Cancelled");
    case "protocol_error": return t("protocol mismatch");
    default: return t("Connection check failed");
  }
}
