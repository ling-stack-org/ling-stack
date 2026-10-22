import { parseArgs } from "node:util";
import type { ExecutionEngineHostAuthority } from "@ling-stack/core/execution-engine-host-authority";
import { CliError } from "./errors.js";
import { runOwnedEngineDaemon } from "./execution-engine-owner.js";

export async function runExecutionEngineCommand(args: readonly string[], options: {
  readonly daemonUrl: string;
  readonly json: boolean;
  readonly cwd?: string;
  /** Only a trusted owning process may supply authority; never a CLI flag or host file. */
  readonly getAuthority?: () => Promise<ExecutionEngineHostAuthority>;
}): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, strict: true, options: {
      origin: { type: "string" }, "start-daemon": { type: "boolean" },
    } });
  } catch { throw invalidCommand(); }
  if (parsed.values["start-daemon"] && (options.json || !process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new CliError(2, "engine_terminal_required", "Foreground engine setup requires an interactive terminal without --json or redirected output.");
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "authorize" || typeof parsed.values.origin !== "string") throw invalidCommand();
  const origin = parsed.values.origin;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw invalidCommand();
  } catch { throw invalidCommand(); }
  if (parsed.values["start-daemon"]) {
    return runOwnedEngineDaemon({ daemonUrl: options.daemonUrl, cwd: options.cwd ?? process.cwd(),
      authorize: async (authority, signal) => {
        const result = await enroll(authority, origin, signal);
        signal.throwIfAborted();
        printEnrollment(result, false);
      },
    });
  }
  if (!options.getAuthority) throw new CliError(1, "engine_host_authority_unavailable",
    "Use the owning Desktop, or --start-daemon in a terminal to authorize a new foreground daemon. Existing daemons are never taken over.");
  const authority = await options.getAuthority();
  if (authority.baseUrl !== new URL(options.daemonUrl).origin) throw new CliError(1, "engine_host_authority_unavailable", "The management authority belongs to a different daemon.");
  printEnrollment(await enroll(authority, origin), options.json);
  return 0;
}

async function enroll(authority: ExecutionEngineHostAuthority, origin: string, signal?: AbortSignal) {
  const response = await fetch(`${authority.baseUrl}/execution-engines/enrollments`, {
    method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
    headers: { Origin: authority.baseUrl, "Content-Type": "application/json",
      Authorization: `Bearer ${authority.credentials.capability}`, "X-Ling-Engine-Csrf": authority.credentials.csrfToken },
    body: JSON.stringify({ origin }),
  });
  if (!response.ok) throw new CliError(1, "engine_authorization_failed", "Execution engine authorization failed. Check the selected local daemon.", response.status);
  const value = await response.json() as { code?: unknown; expiresAt?: unknown };
  if (typeof value.code !== "string" || !/^[a-zA-Z0-9_-]{32}$/.test(value.code)
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new CliError(1, "engine_authorization_failed", "The daemon returned an invalid enrollment response.");
  }
  return { origin, code: value.code, expiresAt: value.expiresAt };
}

function printEnrollment(result: { origin: string; code: string; expiresAt: string }, json: boolean): void {
  console.log(json ? JSON.stringify(result) : `Origin: ${result.origin}\nOne-use code: ${result.code}\nExpires: ${result.expiresAt}`);
}

function invalidCommand(): CliError {
  return new CliError(2, "invalid_engine_command", "Usage: ling engine authorize --origin http://127.0.0.1:5175 [--start-daemon]");
}
