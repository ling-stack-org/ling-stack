import { isDeepStrictEqual } from "node:util";

export const PACKAGED_CODESIGN_ROLE = "packaged_codesign_v1" as const;
export const PACKAGED_CODESIGN_MODE = "--verify-packaged-codesign" as const;
export const PACKAGED_CODESIGN_MAX_FRAME = 262_144;
export const PACKAGED_CODESIGN_OS_PLIST = "/System/Library/LaunchDaemons/com.apple.taskgated.plist";
export const PACKAGED_CODESIGN_OS_DAEMON = "/usr/libexec/taskgated";
const sourcePaths = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs", "src/protocol.rs",
  "src/input_read.rs", "src/codesign.rs", "src/codesign_darwin.rs", "src/codesign_mach.rs", "scripts/build.mjs",
  "tests/protocol-smoke.mjs", "tests/input-read-smoke.mjs", "tests/codesign-leaf-smoke.mjs", "tests/build-evidence.test.mjs",
  "src/codesign_faults.rs", "src/codesign_darwin_tests.rs", "src/codesign_capability_tests.rs",
  "tests/support/codesign-capability-wire.rs", "tests/support/codesign-capability-observer.rs"];
const leafPaths = ["src/codesign.rs", "src/codesign_darwin.rs", "src/codesign_mach.rs", "tests/codesign-leaf-smoke.mjs"];
export interface PackagedCodesignBuildEvidence {
  readonly helperVersion: string;
  readonly target: string;
  readonly unsignedBinarySha256: string;
  readonly unsignedBinarySizeBytes: number;
  readonly sourceSha256: Readonly<Record<string, string>>;
}
export interface PackagedCodesignRequest {
  readonly protocolVersion: 1;
  readonly operation: typeof PACKAGED_CODESIGN_ROLE;
  readonly requestId: string;
  readonly nonce: string;
  readonly expectedHelperVersion: string;
  readonly parentPid: number;
  readonly hostProcessEpoch: string;
  readonly appBundlePath: string;
  readonly appDevice: string;
  readonly appInode: string;
}
export interface PackagedCodesignCompletion {
  readonly type: "codesign_completed";
  readonly protocolVersion: 1;
  readonly helperVersion: string;
  readonly role: typeof PACKAGED_CODESIGN_ROLE;
  readonly helperPid: number;
  readonly parentPid: number;
  readonly requestId: string;
  readonly nonce: string;
  readonly hostProcessEpoch: string;
  readonly appBundlePath: string;
  readonly appDevice: string;
  readonly appInode: string;
  readonly profile: string;
  readonly childPid: number;
  readonly exitCode: number | null;
  readonly signal: number | null;
  readonly stdoutHex: string;
  readonly stderrHex: string;
  readonly spawnBackend: "darwin_posix_spawn_no_fallback_v1";
  readonly registeredNullActionCount: 3;
  readonly exceptionActionMask: 16382;
  readonly nullSpecialPortActions: readonly [4];
  /** Reviewed XNU no-parent-copy fact only; not an actual helper getter or post-exec observation. */
  readonly reviewedNonInheritedSpecialSlots: readonly [10, 11];
  readonly specialSlotEvidence: "reviewed_xnu_no_parent_copy_not_runtime_observed_v1";
  readonly helperHostObjectType: 3;
  readonly helperAccessObjectType: number | null;
  readonly helperAccessService: "absent" | "privileged_taskgated_v1";
  readonly helperInheritedExtraFdsClosed: number;
  readonly machCapabilityClosure: "not_certified";
  readonly childStdio: readonly [0, 1, 2];
  readonly descendantDrain: "not_verified";
  readonly enforcementReady: false;
}
export interface PackagedCodesignFailure {
  readonly type: "error";
  readonly protocolVersion: 1;
  readonly code: string;
  readonly enforcementReady: false;
}
const failureCodes = new Set(["missing_request", "invalid_frame_length", "truncated_frame", "input_unavailable",
  "invalid_request", "unsupported_protocol_version", "unsupported_operation", "helper_version_mismatch",
  "parent_mismatch", "parent_unavailable", "unsupported_invocation", "invalid_codesign_request",
  "codesign_stdio_invalid", "codesign_source_changed", "codesign_api_unsupported", "codesign_prepare_failed",
  "codesign_mach_preflight_failed", "codesign_host_capability_unsupported", "codesign_inherited_port_unsupported",
  "codesign_mach_action_failed", "codesign_spawn_failed", "codesign_wait_failed", "codesign_output_unavailable",
  "codesign_output_budget_exceeded", "codesign_timeout", "codesign_cleanup_unknown",
  "codesign_inherited_fd_unknown", "codesign_task_access_unbound"]);
function requireProtocol(value: unknown): asserts value {
  if (!value) throw new Error("packaged_codesign_native_protocol_invalid");
}
function record(value: unknown): Record<string, unknown> {
  requireProtocol(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  requireProtocol(isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()));
}
function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/**
 * Exact producer JSON only: round-trip excludes duplicate keys, noncanonical
 * number/string spellings and invalid UTF-8. Manifest whitespace is permitted.
 * No source trust or native authority is derived from successful parsing.
 */
function parseJson(bytes: Buffer, maximum: number, pretty: boolean): Record<string, unknown> {
  requireProtocol(bytes.length > 0 && bytes.length <= maximum);
  const text = bytes.toString("utf8"); requireProtocol(Buffer.from(text, "utf8").equals(bytes));
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("packaged_codesign_native_protocol_invalid"); }
  let compact = "", quoted = false, escaped = false;
  for (const char of text) {
    if (quoted || !/\s/u.test(char)) compact += char;
    if (quoted && escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  requireProtocol((pretty ? compact : text) === JSON.stringify(value)); return record(value);
}

/** Build evidence remains unauthenticated provenance, not a hash pin or publisher signature. */
export function parsePackagedCodesignBuildEvidence(bytes: Buffer, target: string): PackagedCodesignBuildEvidence {
  const value = parseJson(bytes, 2 * 1024 * 1024, true);
  exactKeys(value, ["schemaVersion", "helperName", "helperVersion", "protocolVersion", "target", "host", "toolchain",
    "binary", "sourceSha256", "dependencies", "fixedCodesignLeaf", "verification", "executionSupported",
    "enforcementReady", "capabilities", "trust"]);
  requireProtocol(value.schemaVersion === 1 && value.protocolVersion === 1 && value.helperName === "ling-sandbox-runner"
    && typeof value.helperVersion === "string" && /^[\w.+-]{1,128}$/u.test(value.helperVersion)
    && value.target === target && value.host === target && value.toolchain === "1.97.1"
    && value.executionSupported === false && value.enforcementReady === false
    && isDeepStrictEqual(value.capabilities, []) && typeof value.trust === "string" && value.trust.length <= 1024);
  const binary = record(value.binary); exactKeys(binary, ["filename", "sha256", "sizeBytes"]);
  requireProtocol(binary.filename === "ling-sandbox-runner" && validHash(binary.sha256)
    && integer(binary.sizeBytes, 1, 64 * 1024 * 1024));
  const source = record(value.sourceSha256); exactKeys(source, sourcePaths);
  requireProtocol(Object.values(source).every(validHash));
  const leaf = record(value.fixedCodesignLeaf);
  exactKeys(leaf, ["role", "invocation", "protocolVersion", "supportedTarget", "parserProtocol", "capabilityClosure",
    "hostSourceAuthority", "sourcePaths"]);
  requireProtocol(leaf.role === PACKAGED_CODESIGN_ROLE && leaf.invocation === PACKAGED_CODESIGN_MODE
    && leaf.protocolVersion === 1 && leaf.supportedTarget === true && leaf.parserProtocol === "passed"
    && leaf.capabilityClosure === "not_verified" && leaf.hostSourceAuthority === "not_certified"
    && isDeepStrictEqual(leaf.sourcePaths, leafPaths));
  const verification = record(value.verification);
  exactKeys(verification, ["format", "targetCheck", "releaseBuild", "rustTests", "processHandshake", "inputCapture",
    "vulnerabilityAudit", "distributionSignature"]);
  requireProtocol(["format", "targetCheck", "releaseBuild", "rustTests", "processHandshake", "inputCapture"]
    .every(key => verification[key] === "passed") && verification.vulnerabilityAudit === "not_run"
    && verification.distributionSignature === "not_verified");
  const dependencies = record(value.dependencies); exactKeys(dependencies, ["packages", "ling"]);
  requireProtocol(Array.isArray(dependencies.packages) && dependencies.packages.length <= 64);
  const ling = record(dependencies.ling); exactKeys(ling, ["path", "sha256"]);
  requireProtocol(ling.path === "licenses/Ling-LICENSE" && validHash(ling.sha256));
  return Object.freeze({ helperVersion: value.helperVersion, target, unsignedBinarySha256: binary.sha256,
    unsignedBinarySizeBytes: binary.sizeBytes, sourceSha256: Object.freeze({ ...source } as Record<string, string>) });
}

/** Fixed OS configuration grammar only, never a general plist/entity evaluator. */
export function readPackagedCodesignTaskgatedBinding(bytes: Buffer): "reviewed_xml_v1" | "unsupported" {
  if (bytes.length === 0 || bytes.length > 65_536) return "unsupported";
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return "unsupported";
  const expected = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    + '<plist version="1.0"><dict><key>POSIXSpawnType</key><string>Interactive</string>'
    + '<key>EnableTransactions</key><true/><key>Label</key><string>com.apple.taskgated</string>'
    + '<key>MachServices</key><dict><key>com.apple.taskgated</key><dict><key>TaskSpecialPort</key><integer>9</integer>'
    + '</dict></dict><key>ProgramArguments</key><array><string>/usr/libexec/taskgated</string></array></dict></plist>';
  return text.trim().replace(/>\s+</gu, "><") === expected ? "reviewed_xml_v1" : "unsupported";
}

/** An uncorrelated typed error from the captured producer, never a no-start or cleanup receipt. */
export function parsePackagedCodesignFailure(bytes: Buffer): PackagedCodesignFailure {
  requireProtocol(bytes.length >= 5 && bytes.length <= PACKAGED_CODESIGN_MAX_FRAME + 4
    && bytes.readUInt32BE(0) === bytes.length - 4);
  const value = parseJson(bytes.subarray(4), PACKAGED_CODESIGN_MAX_FRAME, false);
  exactKeys(value, ["type", "protocolVersion", "code", "enforcementReady"]);
  requireProtocol(value.type === "error" && value.protocolVersion === 1 && typeof value.code === "string"
    && failureCodes.has(value.code) && value.enforcementReady === false);
  return Object.freeze(value) as unknown as PackagedCodesignFailure;
}

/** Single bounded correlated frame. All Mach fields remain claims of the captured producer, not certificates. */
export function parsePackagedCodesignCompletion(bytes: Buffer, expected: PackagedCodesignRequest,
  profile: string, helperPid: number, taskgatedBinding: "reviewed_xml_v1" | "unsupported"): PackagedCodesignCompletion {
  requireProtocol(bytes.length >= 5 && bytes.length <= PACKAGED_CODESIGN_MAX_FRAME + 4
    && bytes.readUInt32BE(0) === bytes.length - 4);
  const value = parseJson(bytes.subarray(4), PACKAGED_CODESIGN_MAX_FRAME, false);
  exactKeys(value, ["type", "protocolVersion", "helperVersion", "role", "helperPid", "parentPid", "requestId", "nonce",
    "hostProcessEpoch", "appBundlePath", "appDevice", "appInode", "profile", "childPid", "exitCode", "signal",
    "stdoutHex", "stderrHex", "spawnBackend", "registeredNullActionCount", "exceptionActionMask", "nullSpecialPortActions",
    "reviewedNonInheritedSpecialSlots", "specialSlotEvidence", "helperHostObjectType", "helperAccessObjectType", "helperAccessService",
    "helperInheritedExtraFdsClosed", "machCapabilityClosure", "childStdio", "descendantDrain", "enforcementReady"]);
  requireProtocol(value.type === "codesign_completed" && value.protocolVersion === 1 && value.role === PACKAGED_CODESIGN_ROLE
    && value.helperVersion === expected.expectedHelperVersion && integer(helperPid, 1, 0x7fff_ffff)
    && value.helperPid === helperPid && value.parentPid === expected.parentPid && value.requestId === expected.requestId
    && value.nonce === expected.nonce && value.hostProcessEpoch === expected.hostProcessEpoch
    && value.appBundlePath === expected.appBundlePath && value.appDevice === expected.appDevice && value.appInode === expected.appInode
    && value.profile === profile && integer(value.childPid, 1, 0x7fff_ffff) && value.childPid !== helperPid
    && value.childPid !== expected.parentPid
    && ((integer(value.exitCode, 0, 255) && value.signal === null) || (value.exitCode === null && integer(value.signal, 1, 64))));
  for (const key of ["stdoutHex", "stderrHex"]) requireProtocol(typeof value[key] === "string"
    && value[key].length <= 2 * 48 * 1024 && /^(?:[a-f0-9]{2})*$/u.test(value[key]));
  requireProtocol(value.spawnBackend === "darwin_posix_spawn_no_fallback_v1" && value.registeredNullActionCount === 3
    && value.exceptionActionMask === 16382 && isDeepStrictEqual(value.nullSpecialPortActions, [4])
    && isDeepStrictEqual(value.reviewedNonInheritedSpecialSlots, [10, 11])
    && value.specialSlotEvidence === "reviewed_xnu_no_parent_copy_not_runtime_observed_v1" && value.helperHostObjectType === 3
    && integer(value.helperInheritedExtraFdsClosed, 0, 0xffff_ffff) && isDeepStrictEqual(value.childStdio, [0, 1, 2])
    && value.machCapabilityClosure === "not_certified" && value.descendantDrain === "not_verified" && value.enforcementReady === false);
  requireProtocol((value.helperAccessService === "absent" && value.helperAccessObjectType === null)
    || (value.helperAccessService === "privileged_taskgated_v1" && integer(value.helperAccessObjectType, 0, 0xffff_ffff)
      && taskgatedBinding === "reviewed_xml_v1"));
  for (const key of ["nullSpecialPortActions", "reviewedNonInheritedSpecialSlots", "childStdio"]) Object.freeze(value[key]);
  return Object.freeze(value) as unknown as PackagedCodesignCompletion;
}
