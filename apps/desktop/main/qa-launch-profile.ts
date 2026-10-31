import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const profilePrefix = "--ling-desktop-owned-qa-profile=";
const osEnvironmentNames = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TZ", "__CF_USER_TEXT_ENCODING",
  "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
]);
const markerFields = ["schemaVersion", "kind", "synthetic", "modelExecution", "humanConfirmation", "workspaceCwd", "userDataDir", "lingHome"];

/** Baseline namespace only: never use this marker as a model-run or human-decision receipt. */
export interface DesktopQaLaunchProfile {
  readonly schemaVersion: 1;
  readonly purpose: "synthetic-human-evaluation";
  readonly synthetic: boolean;
  /** Startup selection only, never evidence that any model invocation happened. */
  readonly modelExecution?: "host-authorized-budgeted";
  readonly profileCwd: string;
  readonly userDataDir: string;
  readonly workspaceCwd: string;
  readonly lingHome: string;
  readonly daemonBaseUrl: "http://127.0.0.1:17928";
}

// Set only after early-entry package/profile validation and userData readback.
// Main imports this same module instance; inherited environment is not policy.
let initializedQaProfile: DesktopQaLaunchProfile | undefined;

/** Owned QA must not replace the user's Chrome/Chromium native host registration. */
export async function installDesktopBrowserHostForLaunch(input: {
  readonly hostPath: string;
  readonly installBrowserHost: (input: { readonly hostPath: string }) => Promise<unknown>;
}): Promise<"registered" | "skipped_owned_qa"> {
  if (initializedQaProfile) return "skipped_owned_qa";
  await input.installBrowserHost({ hostPath: input.hostPath });
  return "registered";
}

export interface DesktopQaLaunchOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly packaged: boolean;
  readonly packageMetadata: unknown;
  readonly applicationPath?: string;
  readonly userId?: number;
  readonly getUserDataPath: () => string;
  readonly setUserDataPath: (path: string) => void;
}

/**
 * Read only Electron's hash-verified package selection, including its asar virtual path.
 * The post-read cap is not a concurrent-writer/filesystem custody claim for virtual asar files.
 */
export function readDesktopLaunchPackageMetadata(appPath: string): unknown {
  try {
    const bytes = readFileSync(join(appPath, "package.json"));
    if (bytes.length === 0 || bytes.length > 131_072) throw new Error("invalid");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new Error("desktop_qa_package_metadata_invalid"); }
}

/** Must complete before importing Main or any Ling runtime/config/store module. Normal launch is untouched. */
export function initializeDesktopQaLaunchProfile(options: DesktopQaLaunchOptions): DesktopQaLaunchProfile | undefined {
  const profileArgument = parseProfileArgument(options.argv);
  const qaPackage = isQaPackage(options.packageMetadata);
  if (!profileArgument) {
    if (qaPackage) throw new Error("desktop_qa_profile_required");
    initializedQaProfile = undefined;
    return undefined;
  }
  if (!options.packaged || !qaPackage) throw new Error("desktop_qa_package_required");
  const userId = options.userId;
  if (!Number.isSafeInteger(userId) || userId === undefined || userId < 0) throw new Error("desktop_qa_profile_owner_invalid");
  const profile = Object.freeze({ schemaVersion: 1, purpose: "synthetic-human-evaluation", synthetic: true,
    profileCwd: profileArgument, userDataDir: join(profileArgument, "user-data"), workspaceCwd: join(profileArgument, "workspace"),
    lingHome: join(profileArgument, "ling-home"), daemonBaseUrl: "http://127.0.0.1:17928" } as const);
  validateQaArguments(options.argv, profile, options.applicationPath);
  let harnessSelection: unknown;
  try {
    const paths = [profile.profileCwd, profile.userDataDir, profile.workspaceCwd, profile.lingHome];
    const before = paths.map(path => privateDirectory(path, userId));
    validateProfileMarker(profile, userId);
    harnessSelection = readQaHarnessSelection(profile, userId);
    paths.forEach((path, index) => sameIdentity(before[index], privateDirectory(path, userId)));
  } catch { throw new Error("desktop_qa_profile_invalid"); }

  // No finite Provider blacklist: preserve only exact OS/locale names, then inject the fixed QA scope.
  for (const name of Object.keys(options.environment)) if (!osEnvironmentNames.has(name)) delete options.environment[name];
  Object.assign(options.environment, {
    LING_STACK_HOME: profile.lingHome,
    LING_STACK_DEFAULT_WORKSPACE_CWD: profile.workspaceCwd,
    LING_STACK_DAEMON_URL: profile.daemonBaseUrl,
    LING_STACK_HARNESS_CONTINUATIONS_MODE: "enforce",
    LING_STACK_LOCAL_WS_RPC: "false",
    ...(harnessSelection === undefined ? {} : {
      LING_STACK_HARNESS_TOOL_BROKER_MODE: "enforce",
      LING_STACK_HARNESS_DELEGATIONS_MODE: "enforce",
      LING_STACK_QA_HARNESS_SELECTION: JSON.stringify(harnessSelection),
    }),
  });
  try {
    options.setUserDataPath(profile.userDataDir);
    if (options.getUserDataPath() !== profile.userDataDir) throw new Error("invalid");
  } catch { throw new Error("desktop_qa_user_data_invalid"); }
  initializedQaProfile = harnessSelection === undefined ? profile : Object.freeze({ ...profile,
    synthetic: false, modelExecution: "host-authorized-budgeted" as const });
  return initializedQaProfile;
}

function parseProfileArgument(argv: readonly string[]): string | undefined {
  let profile: string | undefined;
  for (const argument of argv) {
    if (argument.startsWith(profilePrefix)) {
      if (profile !== undefined) throw new Error("desktop_qa_arguments_invalid");
      profile = argument.slice(profilePrefix.length);
      if (!profile || profile.length > 4096 || /[\0\r\n]/u.test(profile) || !isAbsolute(profile) || resolve(profile) !== profile) {
        throw new Error("desktop_qa_arguments_invalid");
      }
    } else if (/^--ling-desktop-(?:owned-)?qa(?:[-=]|$)/u.test(argument)) {
      throw new Error("desktop_qa_arguments_invalid");
    }
  }
  return profile;
}

function validateQaArguments(argv: readonly string[], profile: DesktopQaLaunchProfile, applicationPath?: string): void {
  let userDataArguments = 0;
  for (const [index, argument] of argv.entries()) {
    if (argument.startsWith("--user-data-dir=")) {
      userDataArguments++;
      if (argument.slice("--user-data-dir=".length) !== profile.userDataDir || userDataArguments > 1) throw new Error("desktop_qa_arguments_invalid");
    } else if (!argument.startsWith(profilePrefix) && (argument.startsWith("-") || (index !== 0 && argument !== applicationPath))) {
      throw new Error("desktop_qa_arguments_invalid");
    }
  }
}

function isQaPackage(metadata: unknown): boolean {
  if (!record(metadata) || !Object.hasOwn(metadata, "lingHumanQaPackage")) return false;
  const marker = metadata.lingHumanQaPackage;
  if (!exactRecord(marker, ["schemaVersion", "purpose", "release"]) || marker.schemaVersion !== 1
    || marker.purpose !== "synthetic-human-evaluation" || marker.release !== false) throw new Error("desktop_qa_package_invalid");
  return true;
}

function privateDirectory(path: string, userId: number): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(userId) || (stat.mode & 0o7777n) !== 0o700n
    || realpathSync(path) !== path) throw new Error("invalid");
  return stat;
}

/** Both policy files are Host startup input, never read from workspace/model metadata. */
function readPrivateQaJson(path: string, userId: number): unknown {
  const before = lstatSync(path, { bigint: true });
  const validFile = (stat: BigIntStats): void => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== BigInt(userId) || (stat.mode & 0o7777n) !== 0o600n
      || stat.nlink !== 1n || stat.size <= 0n || stat.size > 4096n) throw new Error("invalid");
  };
  validFile(before);
  if (realpathSync(path) !== path) throw new Error("invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: unknown;
  try {
    const opened = fstatSync(fd, { bigint: true }); validFile(opened); sameIdentity(before, opened);
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length > 4096 || BigInt(length) !== opened.size) throw new Error("invalid");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    const after = fstatSync(fd, { bigint: true }); validFile(after); sameIdentity(opened, after);
    sameIdentity(after, lstatSync(path, { bigint: true }));
  } finally { closeSync(fd); }
  return value;
}

function validateProfileMarker(profile: DesktopQaLaunchProfile, userId: number): void {
  const value = readPrivateQaJson(join(profile.profileCwd, "qa-profile.json"), userId);
  if (!exactRecord(value, markerFields) || value.schemaVersion !== 1 || value.kind !== "synthetic-human-qa-profile"
    || value.synthetic !== true || value.modelExecution !== false || value.humanConfirmation !== false
    || value.workspaceCwd !== profile.workspaceCwd || value.userDataDir !== profile.userDataDir || value.lingHome !== profile.lingHome) {
    throw new Error("invalid");
  }
}

function readQaHarnessSelection(profile: DesktopQaLaunchProfile, userId: number): unknown {
  const path = join(profile.profileCwd, "qa-harness.json");
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = readPrivateQaJson(path, userId);
  if (!exactRecord(value, ["schemaVersion", "kind", "modelExecution", "workspaceCwd", "selectedWorkflowIds", "maxDepth", "rootBudget"])
    || value.schemaVersion !== 1 || value.kind !== "isolated-qa-delegation-selection"
    || value.modelExecution !== "host-authorized-budgeted"
    || value.workspaceCwd !== profile.workspaceCwd || !Array.isArray(value.selectedWorkflowIds)
    || value.selectedWorkflowIds.length < 1 || value.selectedWorkflowIds.length > 100
    || value.selectedWorkflowIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/u.test(id))
    || new Set(value.selectedWorkflowIds).size !== value.selectedWorkflowIds.length
    || !positive(value.maxDepth) || value.maxDepth > 16
    || !exactRecord(value.rootBudget, ["tokenBudget", "wallTimeBudgetMs"])
    || !positive(value.rootBudget.tokenBudget) || !positive(value.rootBudget.wallTimeBudgetMs)) throw new Error("invalid");
  return value;
}

function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

function sameIdentity(left: BigIntStats, right: BigIntStats): void {
  for (const key of ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const) if (left[key] !== right[key]) throw new Error("invalid");
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return record(value) && Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
