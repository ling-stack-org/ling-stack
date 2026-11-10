import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { constants as osConstants, release as osRelease, version as osVersion } from "node:os";
import { spawnSync, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncReturns } from "node:child_process";
import { defineProtectedHostActorEntry, type ProtectedHostActorEntry } from "./protected-host-actor-inventory.js";
import type { ExecutionSandboxBackendIdentity } from "@ling-stack/core";
import { isDeepStrictEqual } from "node:util";
import { readMacosSandboxBackendIdentity } from "./macos-sandbox-backend.js";
import { consumeProtectedHostBootstrapReviewUnsupported, readProtectedHostBootstrapReadRoots } from "./protected-host-bootstrap-domain.js";
import { captureProtectedHostStagePaths, type ProtectedHostStagePaths } from "./protected-host-stage-paths.js";
import { MACOS_DYLD_PROFILE, MACOS_SANDBOX_EXECUTABLE, MACOS_SYSTEM_READ_ROOTS } from "./macos-seatbelt-profile.js";
import { captureOriginalCodesignFile, type OriginalCodesignHeldFile } from "./packaged-codesign-held-file.js";
import { readOriginalPublishedCodesignReview, type PublishedOriginalCodesignReview } from "./packaged-codesign-published-review.js";
import type { ProtectedHostActorDomain } from "./protected-host-actor-domain.js";
import { isProtectedHostCommandArenaPath } from "./protected-host-domain-paths.js";
import { PACKAGED_CODESIGN_ROLE, PACKAGED_CODESIGN_MODE, PACKAGED_CODESIGN_MAX_FRAME, PACKAGED_CODESIGN_OS_PLIST,
  PACKAGED_CODESIGN_OS_DAEMON, parsePackagedCodesignBuildEvidence, readPackagedCodesignTaskgatedBinding,
  parsePackagedCodesignCompletion, parsePackagedCodesignFailure, type PackagedCodesignBuildEvidence, type PackagedCodesignRequest,
  type PackagedCodesignCompletion, type PackagedCodesignFailure } from "./packaged-codesign-native-protocol.js";

declare const preparedSourceBrand: unique symbol;
/** An original source candidate, NOT a certified actor, Run authority or process-drain proof. */
export interface PreparedOriginalPackagedCodesignSource { readonly [preparedSourceBrand]: true }
export interface OriginalPackagedCodesignSourceFacts {
  readonly sourceId: "packaged_codesign";
  readonly sourceKind: "original_host_process";
  readonly protection: "candidate_unverified";
  readonly hostProcessEpoch: string;
  readonly hostPid: number;
  readonly hostExecutablePath: string;
  readonly hostExecutableSha256: string;
  readonly appBundlePath: string;
  readonly appIdentity: ReturnType<ProtectedHostStagePaths["identityFacts"]>;
  readonly resourceIdentity: ReturnType<ProtectedHostStagePaths["identityFacts"]>;
  readonly codesignSha256: string;
  readonly backend: ExecutionSandboxBackendIdentity;
  readonly bootstrapReview: "reviewed" | "unsupported";
  readonly staticReadRoots: readonly string[];
  readonly profileSha256: string;
  readonly operationSha256: string;
  readonly helperPath: string;
  readonly helperIdentity: OriginalCodesignHeldFile["identity"];
  readonly helperSha256: string;
  readonly manifestIdentity: OriginalCodesignHeldFile["identity"];
  readonly manifestSha256: string;
  /** Manifest build hashes bind provenance only; the final signed helper has its own actual digest. */
  readonly buildEvidence: PackagedCodesignBuildEvidence;
  readonly osSource: Readonly<{ release: string; version: string; plistIdentity: OriginalCodesignHeldFile["identity"];
    plistSha256: string; binding: "reviewed_xml_v1" | "unsupported"; daemonIdentity: OriginalCodesignHeldFile["identity"];
    daemonSha256: string }>;
  readonly registryEpoch: null;
}
export interface OriginalPackagedCodesignExecutionObservation {
  readonly sourceId: "packaged_codesign";
  readonly hostProcessEpoch: string;
  readonly requestId: string;
  readonly operationSha256: string;
  readonly helperPid: number | null;
  readonly helperStatus: number | null;
  readonly helperSignal: NodeJS.Signals | null;
  readonly helperErrorCode: string | null;
  readonly helperWait: "direct_wait_observed" | "unknown";
  readonly deadline: "timeout_reported" | "not_reported" | "unknown";
  /** Configuration is not an observed signal request or descendant-reap receipt. */
  readonly timeoutMs: 35000;
  readonly configuredKillSignal: "SIGKILL";
  readonly killRequest: "not_observed";
  readonly input: "single_frame_spawn_sync_input";
  readonly elapsedNs: string;
  readonly protocol: "valid_completed" | "valid_error" | "helper_failed" | "invalid" | "not_observed";
  readonly innerCommand: PackagedCodesignCompletion | null;
  readonly nativeFailure: PackagedCodesignFailure | null;
  readonly descendantDrain: "not_verified";
  readonly protection: "candidate_unverified";
}
interface SourceState {
  readonly facts: OriginalPackagedCodesignSourceFacts;
  readonly appPaths: ProtectedHostStagePaths;
  readonly resourcePaths: ProtectedHostStagePaths;
  readonly files: readonly OriginalCodesignHeldFile[];
  readonly profile: string;
  readonly native: Readonly<{ executable: string; argv: readonly string[]; options: SpawnSyncOptionsWithBufferEncoding }>;
  readonly request: PackagedCodesignRequest;
  /** Never expose a mutable Buffer to the caller of enterSource. */
  readonly requestFrameHex: string;
  readonly bootstrapReviewed: boolean;
  appDomainCustody: "source" | "history";
  certificateAttempted: boolean;
  hostProof?: OriginalPackagedCodesignHostProof;
  observation?: OriginalPackagedCodesignExecutionObservation;
  launchPhase: "prepared" | "consumed" | "entered";
  identityLifetime: "retained" | "closed" | "unknown";
}
const sources = new WeakMap<PreparedOriginalPackagedCodesignSource, SourceState>();
// Original cold Host snapshot, not a caller-selected App/build pin or isolation certificate.
const originalHost = Object.freeze({ processEpoch: randomUUID(), pid: process.pid, executable: process.execPath,
  platform: process.platform, architecture: process.arch, electronVersion: process.versions.electron, nodeVersion: process.versions.node, uvVersion: process.versions.uv,
  packaged: process.env.LING_STACK_PACKAGED_DESKTOP, electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  osRelease: osRelease(), osVersion: osVersion() });
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
function requireSource(value: unknown): asserts value { if (!value) throw new Error("packaged_codesign_host_source_invalid"); }
function buildProfile(appBundle: string): string {
  const reads = [...MACOS_SYSTEM_READ_ROOTS, appBundle];
  return [
    "(version 1)", "(deny default)", "(import " + JSON.stringify(MACOS_DYLD_PROFILE) + ")",
    "(allow process-exec)", "(allow process-fork)", "(allow sysctl-read)",
    "(allow signal (target same-sandbox))", "(allow file-read-metadata)",
    "(allow file-read* file-map-executable (require-any "
      + reads.map(path => "(subpath " + JSON.stringify(path) + ")").join(" ") + "))",
    "(allow file-read* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))",
    "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/zero\"))", "(deny network*)",
  ].join("\n");
}

function nativeTuple(helperPath: string): SourceState["native"] {
  const env = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", HOME: "/",
    TMPDIR: "/private/tmp/", PWD: "/" });
  const options: SpawnSyncOptionsWithBufferEncoding = Object.freeze({ encoding: "buffer", timeout: 35_000,
    killSignal: "SIGKILL", maxBuffer: PACKAGED_CODESIGN_MAX_FRAME + 4, windowsHide: true, stdio: "pipe", cwd: "/", env });
  return Object.freeze({ executable: helperPath, argv: Object.freeze([PACKAGED_CODESIGN_MODE]), options });
}
function encodeRequest(request: PackagedCodesignRequest): string {
  const body = Buffer.from(JSON.stringify(request));
  requireSource(body.length > 0 && body.length <= PACKAGED_CODESIGN_MAX_FRAME);
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]).toString("hex");
}
function operationIdentity(state: Omit<SourceState, "facts">, facts: Omit<OriginalPackagedCodesignSourceFacts, "operationSha256">): string {
  return hash(JSON.stringify({ native: state.native, requestFrameHex: state.requestFrameHex,
    profileSha256: facts.profileSha256, hostProcessEpoch: facts.hostProcessEpoch, hostPid: facts.hostPid,
    hostExecutablePath: facts.hostExecutablePath, hostExecutableSha256: facts.hostExecutableSha256,
    appBundlePath: facts.appBundlePath, appIdentity: facts.appIdentity, resourceIdentity: facts.resourceIdentity,
    codesignSha256: facts.codesignSha256, backend: facts.backend, bootstrapReview: facts.bootstrapReview,
    staticReadRoots: facts.staticReadRoots, helperPath: facts.helperPath, helperIdentity: facts.helperIdentity,
    helperSha256: facts.helperSha256, manifestIdentity: facts.manifestIdentity, manifestSha256: facts.manifestSha256,
    buildEvidence: facts.buildEvidence, osSource: facts.osSource }));
}
function readBootstrapCandidate(backend: ExecutionSandboxBackendIdentity): {
  readonly reviewed: boolean; readonly roots: readonly string[];
} {
  try { return { reviewed: true, roots: readProtectedHostBootstrapReadRoots(backend) }; }
  catch (error) {
    if (consumeProtectedHostBootstrapReviewUnsupported(error)) return { reviewed: false, roots: [] };
    throw error; // Identity/tampering/FD/cleanup failure is never a fallback.
  }
}

function requireOwned(source: PreparedOriginalPackagedCodesignSource): SourceState {
  const state = sources.get(source); requireSource(state && Object.isFrozen(source)); return state;
}
function assertStateCurrentUnchecked(state: SourceState): void {
  requireSource(state.identityLifetime === "retained" && process.pid === originalHost.pid
    && process.execPath === originalHost.executable && process.platform === originalHost.platform
    && process.arch === originalHost.architecture && process.versions.electron === originalHost.electronVersion
    && osRelease() === originalHost.osRelease && osVersion() === originalHost.osVersion);
  state.appPaths.assertCurrent(); state.resourcePaths.assertCurrent();
  for (const file of state.files) file.assertCurrent();
  const backend = readMacosSandboxBackendIdentity();
  requireSource(isDeepStrictEqual(backend, state.facts.backend));
  const bootstrap = readBootstrapCandidate(backend);
  requireSource(bootstrap.reviewed === state.bootstrapReviewed
    && state.profile === buildProfile(state.facts.appBundlePath) && hash(state.profile) === state.facts.profileSha256
    && isDeepStrictEqual(state.native, nativeTuple(state.facts.helperPath)) && state.requestFrameHex === encodeRequest(state.request)
    && operationIdentity(state, state.facts) === state.facts.operationSha256);
}
function assertStateCurrent(state: SourceState): void {
  try { assertStateCurrentUnchecked(state); }
  catch (error) {
    // Real original integrity/custody loss is irreversible, including after
    // native entry. A normal command exit/error/timeout alone is not this loss.
    if (state.hostProof) {
      const proof = hostProofs.get(state.hostProof);
      if (proof) proof.phase = "unknown";
    }
    throw error;
  }
}

/** Actual cold Host only: no config, arbitrary root, caller executable, callback or authority argument. */
export function prepareOriginalPackagedCodesignSource(): PreparedOriginalPackagedCodesignSource {
  requireSource(originalHost.platform === "darwin" && ["arm64", "x64"].includes(originalHost.architecture)
    && typeof originalHost.electronVersion === "string" && originalHost.electronVersion.length > 0
    && originalHost.packaged === "1" && originalHost.electronRunAsNode === "1");
  const executable = realpathSync(originalHost.executable), contents = dirname(dirname(executable)), appBundle = dirname(contents);
  requireSource(basename(dirname(executable)) === "MacOS" && basename(contents) === "Contents"
    && basename(appBundle).endsWith(".app") && realpathSync(appBundle) === appBundle
    && Buffer.byteLength(appBundle) <= 4096 && !/[\\\x00-\x1f\x7f]/u.test(appBundle));
  const resourceRoot = join(contents, "Resources", "restricted-command");
  const helperPath = join(resourceRoot, "ling-sandbox-runner"), manifestPath = join(resourceRoot, "manifest.json");
  const files: OriginalCodesignHeldFile[] = [];
  let appPaths: ProtectedHostStagePaths | undefined, resourcePaths: ProtectedHostStagePaths | undefined;
  const hold = (path: string, maximum: number, osOwned: boolean, executableFile = true): OriginalCodesignHeldFile => {
    const file = captureOriginalCodesignFile(path, maximum, osOwned, executableFile); files.push(file); return file;
  };
  try {
    appPaths = captureProtectedHostStagePaths(appBundle); resourcePaths = captureProtectedHostStagePaths(resourceRoot);
    const host = hold(executable, 512 * 1024 * 1024, false), codesign = hold("/usr/bin/codesign", 8 * 1024 * 1024, true);
    const sandbox = hold(MACOS_SANDBOX_EXECUTABLE, 8 * 1024 * 1024, true);
    const helper = hold(helperPath, 65 * 1024 * 1024, false), manifest = hold(manifestPath, 2 * 1024 * 1024, false, false);
    const plist = hold(PACKAGED_CODESIGN_OS_PLIST, 65_536, true, false), daemon = hold(PACKAGED_CODESIGN_OS_DAEMON, 8 * 1024 * 1024, true);
    const target = originalHost.architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    const build = parsePackagedCodesignBuildEvidence(manifest.readBytes(), target);
    // Existing distribution signs nested executables after manifest staging. Do NOT compare an unsigned digest to the signed binary.
    requireSource(helper.sizeBytes >= build.unsignedBinarySizeBytes && helper.sizeBytes <= build.unsignedBinarySizeBytes + 1024 * 1024);
    const backend = readMacosSandboxBackendIdentity(), bootstrap = readBootstrapCandidate(backend), profile = buildProfile(appBundle);
    requireSource(Buffer.byteLength(profile) <= 65_536 && sandbox.sha256 === backend.executableSha256);
    const appIdentity = appPaths.identityFacts(), app = appIdentity.at(-1)!;
    const request: PackagedCodesignRequest = Object.freeze({ protocolVersion: 1, operation: PACKAGED_CODESIGN_ROLE,
      requestId: randomUUID(), nonce: randomBytes(32).toString("hex"), expectedHelperVersion: build.helperVersion,
      parentPid: originalHost.pid, hostProcessEpoch: originalHost.processEpoch, appBundlePath: appBundle,
      appDevice: app.device, appInode: app.inode });
    const native = nativeTuple(helperPath), requestFrameHex = encodeRequest(request);
    const baseFacts: Omit<OriginalPackagedCodesignSourceFacts, "operationSha256"> = Object.freeze({ sourceId: "packaged_codesign",
      sourceKind: "original_host_process", protection: "candidate_unverified", hostProcessEpoch: originalHost.processEpoch,
      hostPid: originalHost.pid, hostExecutablePath: executable, hostExecutableSha256: host.sha256,
      appBundlePath: appBundle, appIdentity, resourceIdentity: resourcePaths.identityFacts(), codesignSha256: codesign.sha256, backend,
      bootstrapReview: bootstrap.reviewed ? "reviewed" : "unsupported",
      staticReadRoots: Object.freeze([...new Set([...MACOS_SYSTEM_READ_ROOTS, ...bootstrap.roots, appBundle])]),
      profileSha256: hash(profile), helperPath, helperIdentity: helper.identity, helperSha256: helper.sha256,
      manifestIdentity: manifest.identity, manifestSha256: manifest.sha256, buildEvidence: build,
      osSource: Object.freeze({ release: originalHost.osRelease, version: originalHost.osVersion, plistIdentity: plist.identity,
        plistSha256: plist.sha256, binding: readPackagedCodesignTaskgatedBinding(plist.readBytes()),
        daemonIdentity: daemon.identity, daemonSha256: daemon.sha256 }), registryEpoch: null });
    const prepared: Omit<SourceState, "facts"> = { appPaths, resourcePaths, files: Object.freeze(files), profile,
      native, request, requestFrameHex, bootstrapReviewed: bootstrap.reviewed, appDomainCustody: "source", certificateAttempted: false,
      launchPhase: "prepared", identityLifetime: "retained" };
    const facts = Object.freeze({ ...baseFacts, operationSha256: operationIdentity(prepared, baseFacts) });
    const source = Object.freeze({}) as PreparedOriginalPackagedCodesignSource;
    const state: SourceState = { ...prepared, facts };
    sources.set(source, state); assertStateCurrent(state); return source;
  } catch (error) {
    const errors: unknown[] = [];
    for (const file of [...files].reverse()) try { file.close(); } catch (closeError) { errors.push(closeError); }
    try { resourcePaths?.close(); } catch (closeError) { errors.push(closeError); }
    try { appPaths?.close(); } catch (closeError) { errors.push(closeError); }
    if (errors.length) throw new AggregateError([error, ...errors], "packaged_codesign_identity_close_unknown");
    throw error;
  }
}
export function readOriginalPackagedCodesignSource(source: PreparedOriginalPackagedCodesignSource): OriginalPackagedCodesignSourceFacts {
  const state = requireOwned(source); assertStateCurrent(state); return state.facts;
}
/** Readonly producer receipt, available after identity cleanup; it cannot authorize, retire or replay anything. */
export function readOriginalPackagedCodesignExecutionObservation(source: PreparedOriginalPackagedCodesignSource):
  OriginalPackagedCodesignExecutionObservation | undefined { return requireOwned(source).observation; }
export function consumeOriginalPackagedCodesignSource(source: PreparedOriginalPackagedCodesignSource): void {
  const state = requireOwned(source); requireSource(state.launchPhase === "prepared");
  state.launchPhase = "consumed"; assertStateCurrent(state);
}
export function enterOriginalPackagedCodesignSource(source: PreparedOriginalPackagedCodesignSource): SourceState["native"] {
  const state = requireOwned(source); requireSource(state.launchPhase === "consumed");
  state.launchPhase = "entered"; assertStateCurrent(state); return state.native;
}
/** Close original readonly FDs only. Unknown remains sticky; no entry-history/descendant retirement. */
export function closeOriginalPackagedCodesignIdentity(source: PreparedOriginalPackagedCodesignSource): void {
  const state = requireOwned(source);
  if (state.identityLifetime === "closed") return;
  requireSource(state.identityLifetime === "retained"); state.identityLifetime = "unknown";
  const errors: unknown[] = [];
  for (const file of [...state.files].reverse()) try { file.close(); } catch (error) { errors.push(error); }
  try { state.resourcePaths.close(); } catch (error) { errors.push(error); }
  if (state.appDomainCustody === "source") try { state.appPaths.close(); } catch (error) { errors.push(error); }
  if (errors.length) {
    const proof = state.hostProof ? hostProofs.get(state.hostProof) : undefined;
    if (proof) proof.phase = "unknown";
    throw new AggregateError(errors, "packaged_codesign_identity_close_unknown");
  }
  state.identityLifetime = "closed";
}

declare const hostProofBrand: unique symbol;
/** Source-owned allow-domain proof. Not Run authority, a native receipt, or descendant-drain proof. */
export interface OriginalPackagedCodesignHostProof { readonly [hostProofBrand]: true }
interface HostProofState {
  readonly source: PreparedOriginalPackagedCodesignSource;
  readonly state: SourceState;
  readonly review: PublishedOriginalCodesignReview;
  readonly domain: ProtectedHostActorDomain;
  readonly directoryFdCost: number;
  phase: "prepared" | "retained" | "unknown";
}
const hostProofs = new WeakMap<OriginalPackagedCodesignHostProof, HostProofState>();
let retainedDomainCount = 0;
let retainedDirectoryFdCount = 0;
const templateRoot = "/__LING_PACKAGED_APP_ROOT__.app";
const maxRetainedDomains = 16, maxRetainedDirectoryFds = 128;
function hasReviewedPathEncoding(path: string): boolean {
  return Buffer.byteLength(path) <= 4096 && Buffer.from(path, "utf8").toString("utf8") === path
    && !/[\u0000-\u001f\u007f-\u009f"\\\u2028\u2029]/u.test(path) && JSON.stringify(path) === '"' + path + '"';
}
function assertPublishedBuildBinding(state: SourceState, review: PublishedOriginalCodesignReview): void {
  const build = state.facts.buildEvidence;
  requireSource(state.facts.manifestSha256 === review.manifestSha256 && build.helperVersion === review.helperVersion
    && build.unsignedBinarySha256 === review.unsignedBinarySha256
    && build.unsignedBinarySizeBytes === review.unsignedBinarySizeBytes
    && isDeepStrictEqual(build.sourceSha256, review.sourceSha256));
  // The final signed helper is not compared to its unsigned build hash. Its
  // own actual held identity/digest remains part of the immutable operation.
  // Trust in the install/signing transformation is explicit, not inferred
  // from a self-reported native completion or publisher identity.
}
function hasFixedReviewSupport(state: SourceState, review: PublishedOriginalCodesignReview): boolean {
  return state.bootstrapReviewed && hasReviewedPathEncoding(state.facts.appBundlePath)
    && !isProtectedHostCommandArenaPath(state.facts.appBundlePath)
    && originalHost.platform === review.runtime.platform && originalHost.architecture === review.runtime.architecture
    && originalHost.electronVersion === review.runtime.electron && originalHost.nodeVersion === review.runtime.node
    && originalHost.uvVersion === review.runtime.uv && originalHost.osRelease === review.os.release
    && state.facts.backend.kind === "macos_seatbelt" && state.facts.backend.protocolVersion === 1
    && state.facts.backend.helperVersion === review.os.backendHelperVersion
    && state.facts.backend.executableSha256 === review.os.backendSha256
    && state.facts.codesignSha256 === review.os.codesignSha256
    && state.facts.osSource.binding === review.os.taskgatedBinding
    && hash(buildProfile(templateRoot)) === review.os.templateSha256;
}
function assertOriginalHostEpochCurrent(): void {
  requireSource(process.pid === originalHost.pid && process.execPath === originalHost.executable
    && process.platform === originalHost.platform && process.arch === originalHost.architecture
    && process.versions.electron === originalHost.electronVersion && process.versions.node === originalHost.nodeVersion
    && process.versions.uv === originalHost.uvVersion && osRelease() === originalHost.osRelease && osVersion() === originalHost.osVersion);
}
/** Private issuer: only the original consumed-record reader below can call it. */
function tryIssueOriginalHostProof(source: PreparedOriginalPackagedCodesignSource): OriginalPackagedCodesignHostProof | undefined {
  const state = requireOwned(source);
  requireSource(state.launchPhase === "consumed");
  if (state.certificateAttempted) return state.hostProof;
  state.certificateAttempted = true;
  assertOriginalHostEpochCurrent(); assertStateCurrent(state);
  const review = readOriginalPublishedCodesignReview();
  if (!review) return undefined; // Ordinary dev/old package is usable, but cannot grant Host coverage.
  assertPublishedBuildBinding(state, review); // Integrity errors never become unsupported-review fallback.
  if (!hasFixedReviewSupport(state, review)) return undefined;
  const directoryFdCost = state.appPaths.ancestors.length + 1;
  requireSource(retainedDomainCount < maxRetainedDomains && retainedDirectoryFdCount + directoryFdCost <= maxRetainedDirectoryFds);
  const token = Object.freeze({}) as OriginalPackagedCodesignHostProof;
  const domain = Object.freeze({ backend: state.facts.backend, staticReadRoots: state.facts.staticReadRoots });
  hostProofs.set(token, { source, state, review, domain, directoryFdCost, phase: "prepared" });
  state.hostProof = token;
  return token;
}
function requireHostProof(token: OriginalPackagedCodesignHostProof): HostProofState {
  const proof = hostProofs.get(token);
  requireSource(proof && Object.isFrozen(token) && proof.state.hostProof === token
    && sources.get(proof.source) === proof.state && proof.phase !== "unknown");
  return proof;
}
/** A fixed direct reader, not a generic resolver/certificate callback. Fake same-name entries acquire nothing. */
export function readConsumedOriginalPackagedCodesignHostProof(entry: ProtectedHostActorEntry, args: readonly unknown[]):
  OriginalPackagedCodesignHostProof | undefined {
  if (entry !== readOriginalPackagedCodesignActorEntry()) return undefined;
  requireInvocation(args.length === 1);
  const invocation = readInvocation(args[0] as OriginalPackagedCodesignInvocation);
  requireInvocation(invocation.phase === "consumed");
  return invocation.source ? tryIssueOriginalHostProof(invocation.source) : undefined;
}
/** Revalidate held topology after transient cleanup; never path-reopen to repair a lost lifetime. */
export function readOriginalPackagedCodesignHostProof(entry: ProtectedHostActorEntry, token: OriginalPackagedCodesignHostProof):
  Readonly<{ readonly entryId: "packaged_codesign"; readonly domain: ProtectedHostActorDomain; readonly phase: "prepared" | "retained" }> {
  requireSource(entry === readOriginalPackagedCodesignActorEntry());
  const proof = requireHostProof(token), state = proof.state;
  try {
    assertOriginalHostEpochCurrent();
    requireSource(readOriginalPublishedCodesignReview() === proof.review && hasFixedReviewSupport(state, proof.review));
    if (proof.phase === "prepared") {
      requireSource(state.launchPhase === "consumed" && state.appDomainCustody === "source");
      assertStateCurrent(state); assertPublishedBuildBinding(state, proof.review);
    } else {
      requireSource(state.appDomainCustody === "history");
      state.appPaths.assertCurrent();
      requireSource(isDeepStrictEqual(state.appPaths.identityFacts(), state.facts.appIdentity)
        && isDeepStrictEqual(readMacosSandboxBackendIdentity(), state.facts.backend));
      const roots = readProtectedHostBootstrapReadRoots(state.facts.backend);
      requireSource(roots.every(root => state.facts.staticReadRoots.includes(root)));
    }
    requireSource(proof.phase === "prepared" || proof.phase === "retained");
    return Object.freeze({ entryId: "packaged_codesign", domain: proof.domain, phase: proof.phase });
  } catch (error) { proof.phase = "unknown"; throw error; }
}
/** Called after every attached registry's readonly gate. Retention is conservative, not a native-entered receipt. */
export function retainOriginalPackagedCodesignHostProof(entry: ProtectedHostActorEntry, token: OriginalPackagedCodesignHostProof): void {
  const proof = requireHostProof(token);
  requireSource(readOriginalPackagedCodesignHostProof(entry, token).phase === "prepared"
    && retainedDomainCount < maxRetainedDomains && retainedDirectoryFdCount + proof.directoryFdCost <= maxRetainedDirectoryFds);
  proof.state.appDomainCustody = "history";
  proof.phase = "retained";
  retainedDomainCount++; retainedDirectoryFdCount += proof.directoryFdCost;
  // Strong original-entry history keeps this custody until the Host epoch ends.
  // Child exit/timeout, registry GC, stage close and sync return do not retire it.
}

declare const originalInvocationBrand: unique symbol;
export interface OriginalPackagedCodesignInvocation { readonly [originalInvocationBrand]: true }
interface InvocationState {
  readonly source?: PreparedOriginalPackagedCodesignSource;
  readonly rawArgs?: readonly string[];
  phase: "prepared" | "consumed" | "entered";
}
const originalInvocations = new WeakMap<OriginalPackagedCodesignInvocation, InvocationState>();
const originalSpawnSync = spawnSync;
const originalClock = process.hrtime.bigint.bind(process.hrtime);
let originalActorEntry: ProtectedHostActorEntry<[OriginalPackagedCodesignInvocation], SpawnSyncReturns<string>> | undefined;
function requireInvocation(value: unknown): asserts value {
  if (!value) throw new Error("packaged_codesign_record_invalid");
}

/** The source owns each actual default tuple; no caller callback/boolean can select physical execution. */
export function createOriginalPackagedCodesignInvocation(source: PreparedOriginalPackagedCodesignSource):
  OriginalPackagedCodesignInvocation {
  requireSource(requireOwned(source).launchPhase === "prepared");
  const record = Object.freeze({}) as OriginalPackagedCodesignInvocation;
  originalInvocations.set(record, { source, phase: "prepared" }); return record;
}
/** Injected dependencies preserve their original unverified raw semantics and sticky unknown history. */
export function createUnverifiedPackagedCodesignInvocation(args: readonly string[]): OriginalPackagedCodesignInvocation {
  requireInvocation(Array.isArray(args) && args.every(arg => typeof arg === "string"));
  const record = Object.freeze({}) as OriginalPackagedCodesignInvocation;
  originalInvocations.set(record, { rawArgs: Object.freeze([...args]), phase: "prepared" }); return record;
}
function readInvocation(record: OriginalPackagedCodesignInvocation): InvocationState {
  const invocation = originalInvocations.get(record);
  requireInvocation(invocation && Object.isFrozen(record)); return invocation;
}

function observeNative(state: SourceState, started: bigint, result?: SpawnSyncReturns<Buffer>,
  protocol: OriginalPackagedCodesignExecutionObservation["protocol"] = "not_observed",
  completed: PackagedCodesignCompletion | null = null, thrown?: unknown, nativeFailure: PackagedCodesignFailure | null = null): void {
  const actualError = result?.error ?? thrown;
  const errorCode = actualError && typeof actualError === "object" && "code" in actualError
    && typeof actualError.code === "string" ? actualError.code : actualError ? "unknown" : null;
  const pid = Number.isSafeInteger(result?.pid) && result!.pid > 0 ? result!.pid : null;
  const waited = pid !== null && (Number.isInteger(result?.status) || typeof result?.signal === "string");
  state.observation = Object.freeze({ sourceId: "packaged_codesign", hostProcessEpoch: state.facts.hostProcessEpoch,
    requestId: state.request.requestId, operationSha256: state.facts.operationSha256, helperPid: pid,
    helperStatus: result?.status ?? null, helperSignal: result?.signal ?? null, helperErrorCode: errorCode,
    helperWait: waited ? "direct_wait_observed" : "unknown",
    deadline: errorCode === "ETIMEDOUT" ? "timeout_reported" : result ? "not_reported" : "unknown",
    timeoutMs: 35000, configuredKillSignal: "SIGKILL", killRequest: "not_observed", input: "single_frame_spawn_sync_input",
    elapsedNs: String(originalClock() - started), protocol, innerCommand: completed, nativeFailure,
    descendantDrain: "not_verified", protection: "candidate_unverified" });
}
function executeOriginalNativeSource(source: PreparedOriginalPackagedCodesignSource): SpawnSyncReturns<string> {
  const native = enterOriginalPackagedCodesignSource(source), state = requireOwned(source);
  const started = originalClock();
  let result: SpawnSyncReturns<Buffer>;
  try {
    // Buffer exists only at the original physical entry. spawnSync owns the
    // single input pipe and closes it after this frame, allowing native EOF.
    // Its origin timeout covers input/frame/EOF/lookup/output, not just codesign.
    result = originalSpawnSync(native.executable, [...native.argv], { ...native.options,
      input: Buffer.from(state.requestFrameHex, "hex") });
  } catch (error) { observeNative(state, started, undefined, "not_observed", null, error); throw error; }
  observeNative(state, started, result, "helper_failed");
  assertStateCurrent(state); // No frame survives original Host/App/helper/OS identity loss.
  const outerStdout = result.stdout?.toString("utf8") ?? "", outerStderr = result.stderr?.toString("utf8") ?? "";
  const fallback: SpawnSyncReturns<string> = { ...result, output: [null, outerStdout, outerStderr],
    stdout: outerStdout, stderr: outerStderr };
  if (result.error || result.signal) return fallback;
  if (result.status === 2 && Number.isSafeInteger(result.pid) && result.pid > 0
    && Buffer.isBuffer(result.stdout) && Buffer.isBuffer(result.stderr) && result.stderr.length === 0) {
    try {
      const failure = parsePackagedCodesignFailure(result.stdout);
      observeNative(state, started, result, "valid_error", null, undefined, failure);
      return { ...fallback, error: Object.assign(new Error(failure.code), { code: failure.code }) };
    } catch {
      observeNative(state, started, result, "invalid");
      return { ...fallback, error: new Error("packaged_codesign_native_protocol_invalid") };
    }
  }
  // exit3 means the helper could not finish its output frame. Never treat it as a command or cleanup receipt.
  if (result.status !== 0) return fallback;
  try {
    requireSource(Buffer.isBuffer(result.stdout) && Buffer.isBuffer(result.stderr) && result.stderr.length === 0);
    const completed = parsePackagedCodesignCompletion(result.stdout, state.request, state.profile, result.pid, state.facts.osSource.binding);
    const signal = completed.signal === null ? null
      : Object.entries(osConstants.signals).find(([, number]) => number === completed.signal)?.[0] as NodeJS.Signals | undefined;
    requireSource(signal !== undefined);
    observeNative(state, started, result, "valid_completed", completed);
    const stdout = Buffer.from(completed.stdoutHex, "hex").toString("utf8"), stderr = Buffer.from(completed.stderrHex, "hex").toString("utf8");
    // Only the actual fixed inner command result reaches the existing synchronous bootstrap validator.
    return { pid: completed.childPid, status: completed.exitCode, signal, stdout, stderr, output: [null, stdout, stderr] };
  } catch (error) {
    observeNative(state, started, result, "invalid");
    return { ...fallback, status: null, error: error instanceof Error ? error : new Error("packaged_codesign_native_protocol_invalid") };
  }
}
/** Exact lazy source-owned singleton. No callback resolver, caller certificate or general process path. */
export function readOriginalPackagedCodesignActorEntry():
  ProtectedHostActorEntry<[OriginalPackagedCodesignInvocation], SpawnSyncReturns<string>> {
  if (originalActorEntry) return originalActorEntry;
  originalActorEntry = defineProtectedHostActorEntry("packaged_codesign",
    (record: OriginalPackagedCodesignInvocation): SpawnSyncReturns<string> => {
      const invocation = readInvocation(record);
      requireInvocation(invocation.phase === "consumed"); invocation.phase = "entered";
      if (invocation.source) return executeOriginalNativeSource(invocation.source);
      requireInvocation(invocation.rawArgs);
      return originalSpawnSync("/usr/bin/codesign", [...invocation.rawArgs], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    },
    (record: OriginalPackagedCodesignInvocation): void => {
      const invocation = readInvocation(record); requireInvocation(invocation.phase === "prepared");
      invocation.phase = "consumed";
      if (invocation.source) consumeOriginalPackagedCodesignSource(invocation.source);
    });
  return originalActorEntry;
}
