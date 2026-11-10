import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { release, version } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MACOS_DYLD_PROFILE, MACOS_SANDBOX_EXECUTABLE, MACOS_SYSTEM_READ_ROOTS } from "../../../packages/daemon/src/runtime/sandbox/macos-seatbelt-profile.ts";
import { PACKAGED_CODESIGN_OS_PLIST, PACKAGED_CODESIGN_OS_DAEMON,
  readPackagedCodesignTaskgatedBinding } from "../../../packages/daemon/src/runtime/sandbox/packaged-codesign-native-protocol.ts";

const hash = value => createHash("sha256").update(value).digest("hex");
function requireObservation(value) { if (!value) throw new Error("packaged_restricted_runtime_observation_invalid"); }
function systemFile(path) {
  const before = lstatSync(path, { bigint: true });
  requireObservation(before.isFile() && !before.isSymbolicLink() && realpathSync(path) === path
    && before.uid === 0n && (before.mode & 0o022n) === 0n && before.size > 0n && before.size <= 8n * 1024n * 1024n);
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  requireObservation(BigInt(bytes.length) === before.size && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs);
  return { bytes, evidence: Object.freeze({ path, sha256: hash(bytes), sizeBytes: bytes.length,
    identity: Object.freeze({ device: String(before.dev), inode: String(before.ino), uid: String(before.uid),
      mode: String(before.mode), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) }) }) };
}

/** Observation-only mirror of the fixed private codesign template. Its source
 * digest is included for reviewer comparison; no Host proof reads this output. */
function codesignTemplate() {
  const reads = [...MACOS_SYSTEM_READ_ROOTS, "/__LING_PACKAGED_APP_ROOT__.app"];
  return ["(version 1)", "(deny default)", "(import " + JSON.stringify(MACOS_DYLD_PROFILE) + ")",
    "(allow process-exec)", "(allow process-fork)", "(allow sysctl-read)",
    "(allow signal (target same-sandbox))", "(allow file-read-metadata)",
    "(allow file-read* file-map-executable (require-any "
      + reads.map(path => "(subpath " + JSON.stringify(path) + ")").join(" ") + "))",
    "(allow file-read* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))",
    "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/zero\"))", "(deny network*)"].join("\n");
}

/** Read system-owned fingerprints only. Never invoke sandbox-exec/codesign,
 * certify task/Mach isolation, change a review row, or mint a publication. */
export function observeRestrictedRuntime() {
  requireObservation(process.platform === "darwin" && process.arch === "arm64");
  const backend = systemFile(MACOS_SANDBOX_EXECUTABLE), profile = systemFile(MACOS_DYLD_PROFILE);
  const codesign = systemFile("/usr/bin/codesign"), taskgatedPlist = systemFile(PACKAGED_CODESIGN_OS_PLIST);
  const taskgatedDaemon = systemFile(PACKAGED_CODESIGN_OS_DAEMON), osRelease = release();
  return Object.freeze({ schemaVersion: 1, kind: "restricted_runtime_observation", approval: "not_granted",
    runtime: Object.freeze({ platform: process.platform, architecture: process.arch, electron: process.versions.electron ?? null,
      node: process.versions.node, uv: process.versions.uv }),
    os: Object.freeze({ release: osRelease, backendHelperVersion: "ling-seatbelt-v1:" + osRelease + ":" + profile.evidence.sha256,
      backendSha256: backend.evidence.sha256, codesignSha256: codesign.evidence.sha256,
      templateSha256: hash(codesignTemplate()), taskgatedBinding: readPackagedCodesignTaskgatedBinding(taskgatedPlist.bytes) }),
    evidence: Object.freeze({ osVersion: version(), backend: backend.evidence, dyldProfile: profile.evidence,
      codesign: codesign.evidence, taskgatedPlist: taskgatedPlist.evidence, taskgatedDaemon: taskgatedDaemon.evidence,
      templateHostSourceSha256: hash(readFileSync(new URL("../../../packages/daemon/src/runtime/sandbox/packaged-codesign-host-source.ts", import.meta.url))),
      limits: "Fingerprint and exact taskgated XML observations only; no capability, sandbox enforcement, packaging or independent approval proof." }) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("packaged_restricted_runtime_observation_arguments_invalid");
  process.stdout.write(JSON.stringify(observeRestrictedRuntime(), null, 2) + "\n");
}
