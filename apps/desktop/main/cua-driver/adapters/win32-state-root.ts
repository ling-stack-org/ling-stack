import { Buffer } from "node:buffer";
import { lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CuaDriverStateRootError, type CuaDriverStateRootPlatformProtector } from "../state-root.js";
import {
  createBoundedWin32CommandRunner,
  createWin32VerifierEnvironment,
  encodeWin32PowerShell,
  isWin32CommandResult,
  resolveWin32SystemExecutables,
  WIN32_CUA_DRIVER_COMMAND_TIMEOUT_MS,
  WIN32_CUA_DRIVER_STDERR_MAX_BYTES,
  WIN32_CUA_DRIVER_STDOUT_MAX_BYTES,
  type Win32CommandRunner,
} from "./win32-command.js";

export interface Win32StateRootFileSystem {
  lstat(path: string): Promise<Pick<Stats, "isDirectory" | "isSymbolicLink">>;
  realpath(path: string): Promise<string>;
}

export interface Win32CuaDriverStateRootProtectorOptions {
  /** Trusted Windows system-directory fact supplied by the platform layer. */
  readonly systemRoot: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly commandRunner?: Win32CommandRunner;
  readonly fileSystem?: Win32StateRootFileSystem;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

interface ReparseEvidence {
  readonly schemaVersion: 1;
  readonly verdict: "observed" | "invalid" | "unavailable";
  readonly paths?: readonly {
    readonly path: string;
    readonly fullName: string;
    readonly directory: boolean;
    readonly reparsePoint: boolean;
  }[];
}

interface AclEvidence {
  readonly schemaVersion: 1;
  readonly verdict: "observed" | "invalid" | "unavailable";
  readonly stateRootPath?: string;
  readonly currentUserSid?: string;
  readonly ownerSid?: string;
  readonly protected?: boolean;
  readonly icaclsExitCode?: number;
  readonly icaclsOutputPresent?: boolean;
  readonly rules?: readonly {
    readonly sid: string;
    readonly type: string;
    readonly rights: string;
    readonly inherited: boolean;
  }[];
}

const POWERSHELL_ARGS_PREFIX = ["-NoLogo", "-NoProfile", "-NonInteractive"] as const;

/** Windows current-user-only state boundary with pre/post reparse fencing. */
export class Win32CuaDriverStateRootProtector implements CuaDriverStateRootPlatformProtector {
  private readonly options: Win32CuaDriverStateRootProtectorOptions;
  private readonly runner: Win32CommandRunner;
  private readonly fileSystem: Win32StateRootFileSystem;
  private readonly baseEnvironment: NodeJS.ProcessEnv;

  constructor(options: Win32CuaDriverStateRootProtectorOptions) {
    this.options = Object.freeze({ ...options });
    this.runner = options.commandRunner ?? createBoundedWin32CommandRunner();
    this.fileSystem = options.fileSystem ?? { lstat, realpath };
    this.baseEnvironment = Object.freeze(createWin32VerifierEnvironment(
      options.baseEnvironment ?? process.env,
      {},
    ));
  }

  async protect(input: {
    readonly userDataPath: string;
    readonly stateRootPath: string;
    readonly createdPaths: readonly string[];
  }): Promise<void> {
    const paths = collectProtectedPaths(input);
    await this.assertTopology(input.userDataPath, paths);
    const executables = this.resolveExecutables();
    await this.assertNoReparsePoints(executables, paths);
    await this.applyAndVerifyAcl(executables, input.stateRootPath);
    // A junction swap while ACL work was in flight must not survive pre-spawn.
    await this.assertTopology(input.userDataPath, paths);
    await this.assertNoReparsePoints(executables, paths);
  }

  private resolveExecutables(): ReturnType<typeof resolveWin32SystemExecutables> {
    try {
      return resolveWin32SystemExecutables(this.options.systemRoot);
    } catch {
      throw stateRootError("windows_state_root_verifier_unavailable");
    }
  }

  private async assertTopology(userDataPath: string, paths: readonly string[]): Promise<void> {
    if (!isAbsolute(userDataPath)) {
      throw stateRootError("windows_user_data_path_must_be_absolute", userDataPath);
    }
    const userDataResolved = resolve(userDataPath);
    let userDataReal: string;
    try {
      userDataReal = await this.fileSystem.realpath(userDataResolved);
    } catch {
      throw stateRootError("windows_user_data_realpath_unavailable", userDataResolved);
    }
    for (const path of paths) {
      const resolvedPath = resolve(path);
      assertInsideOrEqual(resolvedPath, userDataResolved, "windows_state_path_outside_user_data");
      let stat: Pick<Stats, "isDirectory" | "isSymbolicLink">;
      let canonicalPath: string;
      try {
        [stat, canonicalPath] = await Promise.all([
          this.fileSystem.lstat(resolvedPath),
          this.fileSystem.realpath(resolvedPath),
        ]);
      } catch {
        throw stateRootError("windows_state_path_unavailable", resolvedPath);
      }
      if (stat.isSymbolicLink()) {
        throw stateRootError("windows_state_path_reparse_forbidden", resolvedPath);
      }
      if (!stat.isDirectory()) {
        throw stateRootError("windows_state_path_not_directory", resolvedPath);
      }
      assertInsideOrEqual(canonicalPath, userDataReal, "windows_state_path_canonical_escape");
      if (!sameRelativePath(
        relative(userDataResolved, resolvedPath),
        relative(userDataReal, canonicalPath),
      )) {
        throw stateRootError("windows_state_path_canonical_mismatch", resolvedPath);
      }
    }
  }

  private async assertNoReparsePoints(
    executables: ReturnType<typeof resolveWin32SystemExecutables>,
    paths: readonly string[],
  ): Promise<void> {
    const result = await this.runPowerShell(
      executables.powershellPath,
      WIN32_REPARSE_INSPECTION_SCRIPT,
      {
        SystemRoot: executables.systemRoot,
        WINDIR: executables.systemRoot,
        LING_CUA_STATE_PATHS_BASE64: Buffer.from(JSON.stringify(paths), "utf8").toString("base64"),
      },
    );
    const evidence = parseReparseEvidence(result);
    if (evidence.verdict === "unavailable") {
      throw stateRootError("windows_state_root_verifier_unavailable");
    }
    if (evidence.verdict !== "observed" || !evidence.paths || evidence.paths.length !== paths.length) {
      throw stateRootError("windows_state_path_reparse_forbidden");
    }
    for (let index = 0; index < paths.length; index += 1) {
      const item = evidence.paths[index];
      if (!samePath(item.path, paths[index])
        || !samePath(item.fullName, paths[index])
        || !item.directory
        || item.reparsePoint) {
        throw stateRootError("windows_state_path_reparse_forbidden", paths[index]);
      }
    }
  }

  private async applyAndVerifyAcl(
    executables: ReturnType<typeof resolveWin32SystemExecutables>,
    stateRootPath: string,
  ): Promise<void> {
    const result = await this.runPowerShell(
      executables.powershellPath,
      WIN32_ACL_SCRIPT,
      {
        SystemRoot: executables.systemRoot,
        WINDIR: executables.systemRoot,
        LING_CUA_STATE_ROOT: stateRootPath,
        LING_CUA_ICACLS_PATH: executables.icaclsPath,
      },
    );
    const evidence = parseAclEvidence(result);
    if (evidence.verdict === "unavailable") {
      throw stateRootError("windows_state_root_acl_unavailable", stateRootPath);
    }
    if (evidence.verdict !== "observed"
      || !samePath(evidence.stateRootPath ?? "", stateRootPath)
      || !hasText(evidence.currentUserSid)
      || evidence.ownerSid !== evidence.currentUserSid
      || evidence.protected !== true
      || evidence.icaclsExitCode !== 0
      || evidence.icaclsOutputPresent !== true
      || !evidence.rules
      || evidence.rules.length !== 1) {
      throw stateRootError("windows_state_root_acl_invalid", stateRootPath);
    }
    const rule = evidence.rules[0];
    if (rule.sid !== evidence.currentUserSid
      || rule.type !== "Allow"
      || rule.rights !== "FullControl"
      || rule.inherited) {
      throw stateRootError("windows_state_root_acl_invalid", stateRootPath);
    }
  }

  private async runPowerShell(
    powershellPath: string,
    script: string,
    values: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    try {
      return await this.runner.run({
        executablePath: powershellPath,
        args: [...POWERSHELL_ARGS_PREFIX, "-EncodedCommand", encodeWin32PowerShell(script)],
        environment: createWin32VerifierEnvironment(this.baseEnvironment, values),
        timeoutMs: this.options.timeoutMs ?? WIN32_CUA_DRIVER_COMMAND_TIMEOUT_MS,
        maxStdoutBytes: this.options.maxStdoutBytes ?? WIN32_CUA_DRIVER_STDOUT_MAX_BYTES,
        maxStderrBytes: this.options.maxStderrBytes ?? WIN32_CUA_DRIVER_STDERR_MAX_BYTES,
      });
    } catch {
      return undefined;
    }
  }
}

export function createWin32CuaDriverStateRootProtector(
  options: Win32CuaDriverStateRootProtectorOptions,
): CuaDriverStateRootPlatformProtector {
  return new Win32CuaDriverStateRootProtector(options);
}

function collectProtectedPaths(input: {
  readonly userDataPath: string;
  readonly stateRootPath: string;
  readonly createdPaths: readonly string[];
}): readonly string[] {
  const userDataPath = resolve(input.userDataPath);
  const stateRootPath = resolve(input.stateRootPath);
  assertInsideOrEqual(stateRootPath, userDataPath, "windows_state_root_outside_user_data");
  const rel = relative(userDataPath, stateRootPath);
  const segments = rel.split(sep).filter(Boolean);
  const paths = new Set<string>([userDataPath]);
  let cursor = userDataPath;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    paths.add(cursor);
  }
  for (const createdPath of input.createdPaths) {
    const resolvedPath = resolve(createdPath);
    assertInsideOrEqual(resolvedPath, userDataPath, "windows_state_path_outside_user_data");
    paths.add(resolvedPath);
  }
  // Shared state-root always creates these directories; include them on reverify
  // even though createdPaths is intentionally empty on the pre-spawn pass.
  paths.add(resolve(stateRootPath, "telemetry"));
  paths.add(resolve(stateRootPath, "version-check"));
  return Object.freeze([...paths]);
}

function parseReparseEvidence(result: unknown): ReparseEvidence {
  const parsed = parsePowerShellResult(result);
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || (parsed.verdict !== "observed" && parsed.verdict !== "invalid" && parsed.verdict !== "unavailable")) {
    throw stateRootError("windows_state_root_verifier_unavailable");
  }
  if (parsed.verdict !== "observed") {
    return { schemaVersion: 1, verdict: parsed.verdict };
  }
  if (!Array.isArray(parsed.paths)) {
    throw stateRootError("windows_state_root_verifier_unavailable");
  }
  const paths = parsed.paths.map((item) => {
    if (!isRecord(item)
      || !hasText(item.path)
      || !hasText(item.fullName)
      || typeof item.directory !== "boolean"
      || typeof item.reparsePoint !== "boolean") {
      throw stateRootError("windows_state_root_verifier_unavailable");
    }
    return item as unknown as ReparseEvidence["paths"] extends readonly (infer T)[] | undefined ? T : never;
  });
  return { schemaVersion: 1, verdict: "observed", paths };
}

function parseAclEvidence(result: unknown): AclEvidence {
  const parsed = parsePowerShellResult(result);
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || (parsed.verdict !== "observed" && parsed.verdict !== "invalid" && parsed.verdict !== "unavailable")) {
    throw stateRootError("windows_state_root_acl_unavailable");
  }
  if (parsed.verdict !== "observed") {
    return { schemaVersion: 1, verdict: parsed.verdict };
  }
  if (!hasText(parsed.stateRootPath)
    || !hasText(parsed.currentUserSid)
    || !hasText(parsed.ownerSid)
    || typeof parsed.protected !== "boolean"
    || !Number.isInteger(parsed.icaclsExitCode)
    || typeof parsed.icaclsOutputPresent !== "boolean"
    || !Array.isArray(parsed.rules)) {
    throw stateRootError("windows_state_root_acl_unavailable");
  }
  const rules = parsed.rules.map((rule) => {
    if (!isRecord(rule)
      || !hasText(rule.sid)
      || !hasText(rule.type)
      || !hasText(rule.rights)
      || typeof rule.inherited !== "boolean") {
      throw stateRootError("windows_state_root_acl_unavailable");
    }
    return rule as unknown as NonNullable<AclEvidence["rules"]>[number];
  });
  return { ...(parsed as unknown as Omit<AclEvidence, "rules">), rules };
}

function parsePowerShellResult(result: unknown): unknown {
  if (!isWin32CommandResult(result)
    || result.spawnFailed
    || result.timedOut
    || result.stdoutOverflow
    || result.stderrOverflow
    || result.exitCode !== 0
    || result.signal !== null) {
    throw stateRootError("windows_state_root_verifier_unavailable");
  }
  try {
    return JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw stateRootError("windows_state_root_verifier_unavailable");
  }
}

function assertInsideOrEqual(candidate: string, root: string, errorCode: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw stateRootError(errorCode, candidate);
  }
}

function sameRelativePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function samePath(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  return sameRelativePath(resolve(left), resolve(right));
}

function isRecord(value: unknown): value is Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function stateRootError(message: string, path?: string): CuaDriverStateRootError {
  return new CuaDriverStateRootError(message, path);
}

const WIN32_REPARSE_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
try {
  $managementModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1')
  $utilityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
  if (![IO.File]::Exists($managementModule) -or ![IO.File]::Exists($utilityModule)) { exit 2 }
  Microsoft.PowerShell.Core\Import-Module -Name $managementModule -Force -ErrorAction Stop
  Microsoft.PowerShell.Core\Import-Module -Name $utilityModule -Force -ErrorAction Stop
  function Write-LingJson([object]$Value) { [Console]::Out.WriteLine(($Value | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 6)) }
  $json = $utf8.GetString([Convert]::FromBase64String($env:LING_CUA_STATE_PATHS_BASE64))
  $paths = @($json | Microsoft.PowerShell.Utility\ConvertFrom-Json)
  $items = @()
  foreach ($path in $paths) {
    if (!(Microsoft.PowerShell.Management\Test-Path -LiteralPath $path -PathType Container)) {
      Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'invalid' })
      exit 0
    }
    $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $path -Force
    $items += [ordered]@{
      path = [string]$path
      fullName = [string]$item.FullName
      directory = [bool]$item.PSIsContainer
      reparsePoint = [bool](($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
    }
  }
  Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'observed'; paths = $items })
} catch {
  Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'unavailable' })
}
`;

const WIN32_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
try {
  $managementModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1')
  $securityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')
  $utilityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
  if (![IO.File]::Exists($managementModule) -or ![IO.File]::Exists($securityModule) -or ![IO.File]::Exists($utilityModule)) { exit 2 }
  Microsoft.PowerShell.Core\Import-Module -Name $managementModule -Force -ErrorAction Stop
  Microsoft.PowerShell.Core\Import-Module -Name $securityModule -Force -ErrorAction Stop
  Microsoft.PowerShell.Core\Import-Module -Name $utilityModule -Force -ErrorAction Stop
  function Write-LingJson([object]$Value) { [Console]::Out.WriteLine(($Value | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 6)) }
  $root = [IO.Path]::GetFullPath($env:LING_CUA_STATE_ROOT)
  $icacls = [IO.Path]::GetFullPath($env:LING_CUA_ICACLS_PATH)
  if (![IO.Directory]::Exists($root) -or ![IO.File]::Exists($icacls)) {
    Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'unavailable' })
    exit 0
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $targets = @((Microsoft.PowerShell.Management\Get-Item -LiteralPath $root -Force)) + @(
    Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $root -Force -Recurse
  )
  foreach ($target in $targets) {
    if (($target.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'invalid' })
      exit 0
    }
    $isDirectory = [bool]$target.PSIsContainer
    $security = if ($isDirectory) {
      [Security.AccessControl.DirectorySecurity]::new()
    } else {
      [Security.AccessControl.FileSecurity]::new()
    }
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = if ($isDirectory) {
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
    if ($isDirectory) {
      [IO.Directory]::SetAccessControl($target.FullName, $security)
    } else {
      [IO.File]::SetAccessControl($target.FullName, $security)
    }
  }

  $icaclsOutput = @(& $icacls $root 2>&1)
  $icaclsExitCode = $LASTEXITCODE
  $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $root
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  $rules = @(
    $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
      Microsoft.PowerShell.Core\ForEach-Object {
        [ordered]@{
          sid = [string]$_.IdentityReference.Value
          type = [string]$_.AccessControlType
          rights = [string]$_.FileSystemRights
          inherited = [bool]$_.IsInherited
        }
      }
  )
  Write-LingJson ([ordered]@{
    schemaVersion = 1
    verdict = 'observed'
    stateRootPath = $root
    currentUserSid = [string]$sid.Value
    ownerSid = [string]$ownerSid.Value
    protected = [bool]$acl.AreAccessRulesProtected
    icaclsExitCode = [int]$icaclsExitCode
    icaclsOutputPresent = [bool]($icaclsOutput.Count -gt 0)
    rules = $rules
  })
} catch {
  Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'unavailable' })
}
`;
