import { createHash } from "node:crypto";
import {
  execFile as nodeExecFile,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { canonicalJson, platformLockFor } from "../artifact-lock.js";
import {
  CuaDriverPlatformIdentityVerificationError,
  type CuaDriverPlatformIdentityVerificationInput,
  type CuaDriverPlatformIdentityVerifier,
} from "../provider-seal.js";

const DARWIN_SYSTEM_TOOLS = Object.freeze({
  codesign: "/usr/bin/codesign",
  lipo: "/usr/bin/lipo",
  otool: "/usr/bin/otool",
  plutil: "/usr/bin/plutil",
});
const DARWIN_SYSTEM_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(
  Object.values(DARWIN_SYSTEM_TOOLS),
);

export const DEFAULT_DARWIN_IDENTITY_COMMAND_TIMEOUT_MS = 10_000;
export const DEFAULT_DARWIN_IDENTITY_COMMAND_MAX_BYTES = 256 * 1024;

export type DarwinIdentityCommandFailureKind = "invalid" | "unavailable";

export class DarwinIdentityCommandError extends Error {
  constructor(
    readonly failureKind: DarwinIdentityCommandFailureKind,
    readonly executable: string,
  ) {
    super(`darwin_identity_command_${failureKind}`);
    this.name = "DarwinIdentityCommandError";
  }
}

export interface DarwinIdentityCommandInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

export interface DarwinIdentityCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface DarwinIdentityCommandRunner {
  run(input: DarwinIdentityCommandInput): Promise<DarwinIdentityCommandResult>;
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => ChildProcess;

export function createDarwinExecFileCommandRunner(options: {
  readonly execFile?: ExecFileLike;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
} = {}): DarwinIdentityCommandRunner {
  const execFile = options.execFile ?? nodeExecFile as ExecFileLike;
  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs,
    DEFAULT_DARWIN_IDENTITY_COMMAND_TIMEOUT_MS,
    60_000,
  );
  const maxOutputBytes = boundedPositiveInteger(
    options.maxOutputBytes,
    DEFAULT_DARWIN_IDENTITY_COMMAND_MAX_BYTES,
    4 * 1024 * 1024,
  );
  const environment = Object.freeze({
    ...(options.baseEnvironment ?? process.env),
    LANG: "C",
    LC_ALL: "C",
  });
  return Object.freeze({
    run(input: DarwinIdentityCommandInput) {
      if (!input.executable.startsWith("/") || !DARWIN_SYSTEM_TOOL_ALLOWLIST.has(input.executable)) {
        return Promise.reject(new DarwinIdentityCommandError("unavailable", input.executable));
      }
      return new Promise<DarwinIdentityCommandResult>((resolveCommand, rejectCommand) => {
        let child: ChildProcess;
        try {
          child = execFile(
            input.executable,
            [...input.args],
            {
              encoding: "utf8",
              env: environment,
              timeout: timeoutMs,
              maxBuffer: maxOutputBytes,
              windowsHide: true,
              shell: false,
            },
            (error, stdout, stderr) => {
              if (error) {
                rejectCommand(new DarwinIdentityCommandError(
                  commandFailureKind(error),
                  input.executable,
                ));
                return;
              }
              if (Buffer.byteLength(stdout) > maxOutputBytes || Buffer.byteLength(stderr) > maxOutputBytes) {
                rejectCommand(new DarwinIdentityCommandError("unavailable", input.executable));
                return;
              }
              resolveCommand({ stdout, stderr });
            },
          );
        } catch {
          rejectCommand(new DarwinIdentityCommandError("unavailable", input.executable));
          return;
        }
        if (input.stdin !== undefined) {
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || !stdin.writable) {
            try {
              child.kill();
            } catch {
              // The normalized unavailable error below remains authoritative.
            }
            rejectCommand(new DarwinIdentityCommandError("unavailable", input.executable));
            return;
          }
          try {
            stdin.end(input.stdin, "utf8");
          } catch {
            try {
              child.kill();
            } catch {
              // The normalized unavailable error below remains authoritative.
            }
            rejectCommand(new DarwinIdentityCommandError("unavailable", input.executable));
          }
        }
      });
    },
  });
}

export class DarwinCuaDriverIdentityVerifier implements CuaDriverPlatformIdentityVerifier {
  private readonly runner: DarwinIdentityCommandRunner;

  constructor(private readonly options: {
    readonly expectedTeamId: string;
    readonly runner?: DarwinIdentityCommandRunner;
  }) {
    if (!/^[A-Z0-9]{10}$/u.test(options.expectedTeamId)) {
      throw new Error("darwin_cua_driver_expected_team_id_invalid");
    }
    this.runner = options.runner ?? createDarwinExecFileCommandRunner();
  }

  async verify(input: CuaDriverPlatformIdentityVerificationInput): Promise<void> {
    try {
      await this.verifyInternal(input);
    } catch (error) {
      if (error instanceof CuaDriverPlatformIdentityVerificationError) {
        throw error;
      }
      if (error instanceof DarwinIdentityCommandError && error.failureKind === "unavailable") {
        throw new CuaDriverPlatformIdentityVerificationError("unavailable");
      }
      throw new CuaDriverPlatformIdentityVerificationError("invalid");
    }
  }

  private async verifyInternal(input: CuaDriverPlatformIdentityVerificationInput): Promise<void> {
    if (input.platform !== "darwin" || input.seal.componentId !== "cua-driver-darwin") {
      throw new Error("darwin_cua_driver_identity_platform_mismatch");
    }
    const seal = input.seal;
    const platformLock = platformLockFor(input.lock, "darwin");
    if (platformLock.componentId !== "cua-driver-darwin") {
      throw new Error("darwin_cua_driver_lock_platform_mismatch");
    }
    if (seal.teamId !== this.options.expectedTeamId) {
      throw new Error("darwin_cua_driver_seal_team_id_mismatch");
    }

    await this.runner.run({
      executable: DARWIN_SYSTEM_TOOLS.codesign,
      args: ["--verify", "--strict", "--all-architectures", "--verbose=4", input.paths.executablePath],
    });
    const architectureResult = await this.runner.run({
      executable: DARWIN_SYSTEM_TOOLS.lipo,
      args: ["-archs", input.paths.executablePath],
    });
    const architectures = parseArchitectures(architectureResult.stdout);
    if (architectures.join(",") !== "arm64,x86_64"
      || seal.architectures.join(",") !== "arm64,x86_64") {
      throw new Error("darwin_cua_driver_architectures_mismatch");
    }

    let sharedIdentifier: string | undefined;
    let sharedRequirement: string | undefined;
    let sharedEntitlementsDigest: string | undefined;
    for (const architecture of architectures) {
      const minimumVersionResult = await this.runner.run({
        executable: DARWIN_SYSTEM_TOOLS.otool,
        args: ["-l", "-arch", architecture, input.paths.executablePath],
      });
      if (parseMinimumMacOS(minimumVersionResult.stdout) !== platformLock.binary.minimumMacOS) {
        throw new Error("darwin_cua_driver_minimum_macos_mismatch");
      }

      const detailsResult = await this.runner.run({
        executable: DARWIN_SYSTEM_TOOLS.codesign,
        args: ["--display", "--verbose=4", "--arch", architecture, input.paths.executablePath],
      });
      const details = parseCodesignDetails(`${detailsResult.stdout}\n${detailsResult.stderr}`);
      if (details.teamId !== this.options.expectedTeamId
        || details.identifier !== seal.codeIdentifier
        || details.hardenedRuntime !== true
        || details.cdhash !== seal.cdhashes[architecture]) {
        throw new Error("darwin_cua_driver_codesign_identity_mismatch");
      }
      sharedIdentifier ??= details.identifier;
      if (details.identifier !== sharedIdentifier) {
        throw new Error("darwin_cua_driver_slice_identifier_mismatch");
      }

      const requirementResult = await this.runner.run({
        executable: DARWIN_SYSTEM_TOOLS.codesign,
        args: ["--display", "--requirements", "-", "--arch", architecture, input.paths.executablePath],
      });
      const requirement = normalizeDesignatedRequirement(
        `${requirementResult.stdout}\n${requirementResult.stderr}`,
      );
      if (requirement !== seal.designatedRequirement
        || sha256Utf8(requirement) !== seal.designatedRequirementSha256) {
        throw new Error("darwin_cua_driver_designated_requirement_mismatch");
      }
      sharedRequirement ??= requirement;
      if (requirement !== sharedRequirement) {
        throw new Error("darwin_cua_driver_slice_requirement_mismatch");
      }

      const entitlementsResult = await this.runner.run({
        executable: DARWIN_SYSTEM_TOOLS.codesign,
        args: ["--display", "--entitlements", "-", "--xml", "--arch", architecture, input.paths.executablePath],
      });
      const entitlementsPlist = extractPlist(entitlementsResult.stdout, entitlementsResult.stderr);
      const entitlementsJson = await this.runner.run({
        executable: DARWIN_SYSTEM_TOOLS.plutil,
        args: ["-convert", "json", "-o", "-", "--", "-"],
        stdin: entitlementsPlist,
      });
      const entitlements = parseEntitlements(entitlementsJson.stdout);
      if (canonicalJson(entitlements) !== canonicalJson(platformLock.binary.requiredEntitlements)) {
        throw new Error("darwin_cua_driver_entitlements_allowlist_mismatch");
      }
      const entitlementsDigest = sha256Utf8(canonicalJson(entitlements));
      if (entitlementsDigest !== platformLock.binary.requiredEntitlementsCanonicalSha256
        || entitlementsDigest !== seal.entitlementsCanonicalSha256) {
        throw new Error("darwin_cua_driver_entitlements_digest_mismatch");
      }
      sharedEntitlementsDigest ??= entitlementsDigest;
      if (entitlementsDigest !== sharedEntitlementsDigest) {
        throw new Error("darwin_cua_driver_slice_entitlements_mismatch");
      }
    }
  }
}

function parseArchitectures(output: string): readonly ["arm64", "x86_64"] {
  const values = [...new Set(output.trim().split(/\s+/u).filter(Boolean))].sort();
  if (values.length !== 2 || values[0] !== "arm64" || values[1] !== "x86_64") {
    throw new Error("darwin_cua_driver_architectures_invalid");
  }
  return values as ["arm64", "x86_64"];
}

function parseMinimumMacOS(output: string): string {
  const blocks = output.split(/(?=Load command \d+)/u);
  for (const block of blocks) {
    if (/\bcmd LC_BUILD_VERSION\b/u.test(block)) {
      const match = /^\s*minos\s+([^\s]+)\s*$/mu.exec(block);
      if (match) {
        return match[1];
      }
    }
  }
  throw new Error("darwin_cua_driver_minimum_macos_missing");
}

function parseCodesignDetails(output: string): {
  readonly identifier: string;
  readonly teamId: string;
  readonly cdhash: string;
  readonly hardenedRuntime: boolean;
} {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const valueFor = (prefix: string): string | undefined =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
  const identifier = valueFor("Identifier=");
  const teamId = valueFor("TeamIdentifier=");
  const cdhash = valueFor("CDHash=")?.toLowerCase();
  const codeDirectory = lines.find((line) => line.startsWith("CodeDirectory "));
  if (!identifier || !teamId || !cdhash || !/^[0-9a-f]{40}$/u.test(cdhash) || !codeDirectory) {
    throw new Error("darwin_cua_driver_codesign_details_invalid");
  }
  return {
    identifier,
    teamId,
    cdhash,
    hardenedRuntime: /(?:\(|,)runtime(?:\)|,)/u.test(codeDirectory),
  };
}

function normalizeDesignatedRequirement(output: string): string {
  const line = output
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value.startsWith("designated =>"));
  if (!line) {
    throw new Error("darwin_cua_driver_designated_requirement_missing");
  }
  return line.replace(/^designated\s*=>\s*/u, "").trim();
}

function extractPlist(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`;
  const start = combined.indexOf("<?xml");
  const end = combined.lastIndexOf("</plist>");
  if (start < 0 || end < start) {
    throw new Error("darwin_cua_driver_entitlements_plist_missing");
  }
  return `${combined.slice(start, end + "</plist>".length).trim()}\n`;
}

function parseEntitlements(output: string): Readonly<Record<string, true>> {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("darwin_cua_driver_entitlements_json_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("darwin_cua_driver_entitlements_shape_invalid");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([, item]) => item !== true)) {
    throw new Error("darwin_cua_driver_entitlements_shape_invalid");
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))) as Readonly<Record<string, true>>;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function commandFailureKind(error: ExecFileException): DarwinIdentityCommandFailureKind {
  const code = String(error.code ?? "");
  if (code === "ENOENT"
    || code === "EACCES"
    || code === "ETIMEDOUT"
    || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    || error.killed === true) {
    return "unavailable";
  }
  return "invalid";
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("darwin_identity_command_bound_invalid");
  }
  return value;
}

export const DARWIN_CUA_DRIVER_SYSTEM_TOOLS = DARWIN_SYSTEM_TOOLS;
