import { spawn } from "node:child_process";
import { NativeConnectionError } from "./codex-connection.js";
import { EngineCredentialError } from "./native-secrets.js";
import { claudeProcessEnvironment } from "./claude-environment.js";
import { captureClaudeProbeProcess } from "./claude-probe-process.js";

/** Public CLI auth metadata only: this command never starts a prompt or model session. */
export async function captureClaudeAccountOperation(executable: string, root: string, apiKey: string,
  signal: AbortSignal, launch: typeof spawn) {
  signal.throwIfAborted();
  try {
    const { exitCode, payload } = await captureClaudeProbeProcess({ executable, root, signal, launch,
      args: ["--bare", "--setting-sources=", "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
        "--strict-mcp-config", "auth", "status", "--json"],
      environment: { ...claudeProcessEnvironment(root), ANTHROPIC_API_KEY: apiKey },
    });
    signal.throwIfAborted();
    if (exitCode === 1) {
      if (accountStatus(payload) && !payload.loggedIn) throw new EngineCredentialError("engine_native_auth_mismatch");
      throw new NativeConnectionError("process_failed");
    }
    if (!accountStatus(payload)) throw new NativeConnectionError("protocol_error");
    if (!payload.loggedIn || payload.authMethod !== "api_key" || payload.apiProvider !== "firstParty"
      || payload.apiKeySource !== "ANTHROPIC_API_KEY" || (payload.tokenSource !== undefined && payload.tokenSource !== "none")) {
      throw new EngineCredentialError("engine_native_auth_mismatch");
    }
    // Optional identity/account fields are neither returned nor persisted.
    return { connection: "connected", authentication: "configured_unverified" } as const;
  } catch (error) {
    throw safeClaudeError(error);
  }
}

function accountStatus(value: unknown): value is {
  loggedIn: boolean; authMethod: string; apiProvider: string; apiKeySource?: string; tokenSource?: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const account = value as Record<string, unknown>;
  return typeof account.loggedIn === "boolean" && typeof account.authMethod === "string" && typeof account.apiProvider === "string"
    && (account.apiKeySource === undefined || typeof account.apiKeySource === "string")
    && (account.tokenSource === undefined || typeof account.tokenSource === "string");
}

function safeClaudeError(error: unknown): Error {
  if (error instanceof NativeConnectionError && error.code === "auth_required") return new EngineCredentialError("engine_native_auth_mismatch");
  return error instanceof NativeConnectionError || error instanceof EngineCredentialError ? error : new NativeConnectionError("process_failed");
}
