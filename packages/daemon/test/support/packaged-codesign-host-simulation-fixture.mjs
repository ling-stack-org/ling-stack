import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = process.env.LING_PROTECTED_HOST_SOURCE_TEST_DIST
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
const moduleUrl = path => pathToFileURL(join(dist, path)).href;
let importSequence = 0;
export const SIMULATED_APP = "/private/tmp/ling-codesign-host-simulation/Host.app";
export const SIMULATED_EXECUTABLE = SIMULATED_APP + "/Contents/MacOS/Host";
export const SIMULATED_CODESIGN = "/usr/bin/codesign";
export const SIMULATED_BACKEND = "/usr/bin/sandbox-exec";
export const SIMULATED_HELPER = SIMULATED_APP + "/Contents/Resources/restricted-command/ling-sandbox-runner";
export const SIMULATED_MANIFEST = SIMULATED_APP + "/Contents/Resources/restricted-command/manifest.json";
export const SIMULATED_TASKGATED_PLIST = "/System/Library/LaunchDaemons/com.apple.taskgated.plist";
export const SIMULATED_TASKGATED_DAEMON = "/usr/libexec/taskgated";
const SIMULATED_SOURCE_PATHS = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs", "src/protocol.rs",
  "src/input_read.rs", "src/codesign.rs", "src/codesign_darwin.rs", "src/codesign_mach.rs", "scripts/build.mjs",
  "tests/protocol-smoke.mjs", "tests/input-read-smoke.mjs", "tests/codesign-leaf-smoke.mjs", "tests/build-evidence.test.mjs",
  "src/codesign_faults.rs", "src/codesign_darwin_tests.rs", "src/codesign_capability_tests.rs",
  "tests/support/codesign-capability-wire.rs", "tests/support/codesign-capability-observer.rs"];
const SIMULATED_TASKGATED_BYTES = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>'
  + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  + '<plist version="1.0"><dict><key>POSIXSpawnType</key><string>Interactive</string>'
  + '<key>EnableTransactions</key><true/><key>Label</key><string>com.apple.taskgated</string>'
  + '<key>MachServices</key><dict><key>com.apple.taskgated</key><dict><key>TaskSpecialPort</key><integer>9</integer>'
  + '</dict></dict><key>ProgramArguments</key><array><string>/usr/libexec/taskgated</string></array></dict></plist>');
const simulatedBuildEvidence = helperBytes => ({
  schemaVersion: 1, helperName: "ling-sandbox-runner", helperVersion: "0.1.0-dev.0", protocolVersion: 1,
  target: "aarch64-apple-darwin", host: "aarch64-apple-darwin", toolchain: "1.97.1",
  binary: { filename: "ling-sandbox-runner", sha256: crypto.createHash("sha256").update("unsigned-not-runtime").digest("hex"),
    sizeBytes: helperBytes.length },
  sourceSha256: Object.fromEntries(SIMULATED_SOURCE_PATHS.map(path => [path, "a".repeat(64)])),
  dependencies: { packages: [], ling: { path: "licenses/Ling-LICENSE", sha256: "a".repeat(64) } },
  fixedCodesignLeaf: { role: "packaged_codesign_v1", invocation: "--verify-packaged-codesign", protocolVersion: 1,
    supportedTarget: true, parserProtocol: "passed", capabilityClosure: "not_verified", hostSourceAuthority: "not_certified",
    sourcePaths: ["src/codesign.rs", "src/codesign_darwin.rs", "src/codesign_mach.rs", "tests/codesign-leaf-smoke.mjs"] },
  verification: { format: "passed", targetCheck: "passed", releaseBuild: "passed", rustTests: "passed",
    processHandshake: "passed", inputCapture: "passed", vulnerabilityAudit: "not_run", distributionSignature: "not_verified" },
  executionSupported: false, enforcementReady: false, capabilities: [], trust: "Observer-only provenance, never trust"
});
const simulatedProfile = app => [
  "(version 1)", "(deny default)", '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
  "(allow process-exec)", "(allow process-fork)", "(allow sysctl-read)", "(allow signal (target same-sandbox))",
  "(allow file-read-metadata)", "(allow file-read* file-map-executable (require-any "
    + ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/share", "/System/Library", app]
      .map(path => "(subpath " + JSON.stringify(path) + ")").join(" ") + "))",
  '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
  '(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))', "(deny network*)"
].join("\n");
const DYLD_PATH = "/System/Library/Sandbox/Profiles/dyld-support.sb";
const DYLD_BYTES = Buffer.from("OBSERVER-ONLY dyld sentinel; not reviewed OS profile bytes\n");
// Only the sentinel's digest is substituted to reach mechanism checks on every CI platform.
// This deliberately counterfeits bootstrap input: it is NOT real OS/profile trust evidence.
const SIMULATED_REVIEWED_DIGEST = "bdfc2354c683c8fb95a39e63fbc8610e9739b0256c89ab880564edefbe73a5ce";
export const errno = (code, message = code) => Object.assign(new Error(message), { code });

/**
 * Portable mechanism observer, not an Electron/kernel/signature fixture.
 * All filesystem/native-process calls below are virtual; no real App, keychain,
 * codesign, sandbox-exec or machine-dependent OS profile is opened or launched.
 * Host fields are restored after each awaited, sequential subtest.
 */
export async function createCodesignHostSimulation(t, { electron = true, reviewedPublication = false } = {}) {
  // Finish dependency loading before builtin observers; new source modules still
  // execute their real code and capture their own Host snapshot after installation.
  const preloadedModules = ["electron-node-resources.js", "macos-native-command.js", "macos-sandbox-backend.js", "protected-host-bootstrap-domain.js",
    "protected-host-stage-paths.js", "macos-seatbelt-profile.js", "protected-host-domain-paths.js", "protected-host-actor-domain.js",
    "protected-host-original-entry-manifest.js", "protected-host-office-directory-window.js",
    "../../features/office-documents/office-local-native-runtime.js", "../../features/runs/workflow-operation-snapshot.js",
    "../../features/channels/channel-command-input-policy.js"];
  await Promise.all(preloadedModules.map(path => import(moduleUrl("runtime/sandbox/" + path))));
  const coreUrl = import.meta.resolve("@ling-stack/core");
  await import(coreUrl);
  const originalHash = crypto.createHash;
  // Preload only the two real, query-isolated compiled source files. An original
  // readFileSync passthrough would still call our mocked openSync internally.
  const loaderBytes = new Map(["packaged-codesign-host-source.js", "packaged-restricted-command-bootstrap.js",
    "packaged-codesign-held-file.js", "packaged-codesign-native-protocol.js", "packaged-codesign-published-review.js",
    "protected-host-actor-inventory.js", "protected-host-staging.js"]
    .map(path => { const actual = join(dist, "runtime/sandbox", path); return [actual, fs.readFileSync(actual)]; }));
  const resolvablePaths = new Set([...loaderBytes.keys(),
    ...preloadedModules.map(path => join(dist, "runtime/sandbox", path))]);
  // The ESM loader has its own captured readFileSync, which still enters openSync.
  // Supply exact existing dist bytes through the supported loader hook instead
  // of allowing any real filesystem descriptor through the mechanism observer.
  const fixtureSequence = ++importSequence;
  const sourceUrl = moduleUrl("runtime/sandbox/packaged-codesign-host-source.js")
    + "?codesign-mechanism=" + fixtureSequence;
  const bootstrapUrl = moduleUrl("runtime/sandbox/packaged-restricted-command-bootstrap.js")
    + "?codesign-mechanism=" + fixtureSequence;
  let simulatedPublishedJson;
  const isolatedModules = new Map(["packaged-codesign-host-source.js", "protected-host-actor-inventory.js",
    "protected-host-staging.js", "packaged-codesign-published-review.js"].map(path => {
      const url = moduleUrl("runtime/sandbox/" + path);
      return [path, url + "?codesign-mechanism=" + fixtureSequence];
    }));
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (reviewedPublication && [...isolatedModules.values()].includes(context.parentURL)
      && specifier.startsWith("./") && isolatedModules.has(specifier.slice(2))) {
      return { url: isolatedModules.get(specifier.slice(2)), shortCircuit: true };
    }
    // Only this real bootstrap's exact relative import shares this fixture's
    // original source object. No source rewriting, filesystem passthrough or
    // process-global canonical cache may borrow a previous fixture's observer.
    if (context.parentURL === bootstrapUrl && specifier === "./packaged-codesign-host-source.js") {
      return { url: sourceUrl, shortCircuit: true };
    }
    if (specifier === "@ling-stack/core" && context.parentURL?.startsWith("file:")
      && resolvablePaths.has(fileURLToPath(context.parentURL))) {
      return { url: coreUrl, shortCircuit: true };
    }
    // Node resolves file identity before entering load. Keep that lookup inside
    // the exact preloaded module set, without routing loader stat calls through
    // the virtual Host filesystem or permitting any real filesystem passthrough.
    const candidate = specifier.startsWith("file:") ? new URL(specifier)
      : (specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")
        ? new URL(specifier, context.parentURL) : undefined;
    if (candidate && resolvablePaths.has(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }, load(url, context, nextLoad) {
    const bytes = url.startsWith("file:") ? loaderBytes.get(fileURLToPath(url)) : undefined;
    if (reviewedPublication && url === isolatedModules.get("packaged-codesign-published-review.js")) {
      const marker = 'const embeddedPublishedReviewJson = "NO_PACKAGED_CODESIGN_REVIEW";';
      const actual = bytes?.toString("utf8");
      assert.equal(actual?.split(marker).length, 2, "the real compiled lexical marker must match");
      assert.equal(typeof simulatedPublishedJson, "string");
      // Explicit synthetic mechanism input, not production review approval.
      return { format: "module", source: actual.replace(marker,
        "const embeddedPublishedReviewJson = " + JSON.stringify(simulatedPublishedJson) + ";"), shortCircuit: true };
    }
    return bytes ? { format: "module", source: bytes, shortCircuit: true } : nextLoad(url, context);
  } });
  t.after(() => loader.deregister());
  const rows = new Map(), descriptors = new Map(), opens = [], closes = [], nativeCalls = [];
  const hooks = {}, patches = [], restorers = [];
  let nextFd = 10000, nextInode = 20000;
  const file = (path, bytes, uid = 0, mode = 0o100755) => {
    const row = { path, bytes: Buffer.from(bytes), uid, mode, dev: 1, ino: nextInode++,
      mtimeNs: 10, ctimeNs: 11, directory: false };
    rows.set(path, row); return row;
  };
  const directory = path => {
    if (!rows.has(path)) rows.set(path, { path, bytes: Buffer.alloc(0), uid: 501,
      mode: 0o40755, dev: 1, ino: nextInode++, mtimeNs: 10, ctimeNs: 11, directory: true });
  };
  let ancestor = dirname(SIMULATED_EXECUTABLE);
  for (;;) { directory(ancestor); if (dirname(ancestor) === ancestor) break; ancestor = dirname(ancestor); }
  file(SIMULATED_EXECUTABLE, "simulated-electron-executable", 501);
  file(SIMULATED_CODESIGN, "simulated-codesign");
  file(SIMULATED_BACKEND, "simulated-sandbox-exec");
  const resourceRoot = dirname(SIMULATED_HELPER);
  directory(dirname(resourceRoot)); directory(resourceRoot);
  const helper = file(SIMULATED_HELPER, "simulated-fixed-native-helper", 501);
  const manifest = file(SIMULATED_MANIFEST, JSON.stringify(simulatedBuildEvidence(helper.bytes), null, 2) + "\n", 501, 0o100600);
  const taskgatedPlist = file(SIMULATED_TASKGATED_PLIST, SIMULATED_TASKGATED_BYTES, 0, 0o100644);
  const taskgatedDaemon = file(SIMULATED_TASKGATED_DAEMON, "simulated-OS-daemon", 0);
  const dyld = file(DYLD_PATH, DYLD_BYTES, 0, 0o100644);
  if (reviewedPublication) {
    const sha = bytes => originalHash("sha256").update(bytes).digest("hex"), build = JSON.parse(manifest.bytes.toString("utf8"));
    simulatedPublishedJson = JSON.stringify({ schemaVersion: 1, reviewId: "packaged_codesign_original_host_v1",
      sourceReviewSha256: "c".repeat(64), manifestSha256: sha(manifest.bytes), helperVersion: build.helperVersion,
      unsignedBinarySha256: build.binary.sha256, unsignedBinarySizeBytes: build.binary.sizeBytes,
      sourceSha256: build.sourceSha256, runtime: { platform: "darwin", architecture: "arm64",
        electron: "44.1.1", node: process.versions.node, uv: process.versions.uv },
      os: { release: "27.0.0", backendHelperVersion: "ling-seatbelt-v1:27.0.0:" + SIMULATED_REVIEWED_DIGEST,
        backendSha256: sha(rows.get(SIMULATED_BACKEND).bytes), codesignSha256: sha(rows.get(SIMULATED_CODESIGN).bytes),
        templateSha256: sha(simulatedProfile("/__LING_PACKAGED_APP_ROOT__.app")), taskgatedBinding: "reviewed_xml_v1" },
      trust: "original_host_and_trusted_packaging_transform_v1" });
  }
  const rowAt = path => {
    const row = rows.get(String(path));
    if (!row) throw errno("ENOENT", "unmodeled filesystem access: " + String(path));
    return row;
  };
  const descriptorAt = fd => {
    const slot = descriptors.get(fd);
    if (!slot) throw errno("EBADF");
    return slot;
  };
  const stat = (row, bigint) => {
    const number = value => bigint ? BigInt(value) : value;
    return { dev: number(row.dev), ino: number(row.ino), uid: number(row.uid), mode: number(row.mode),
      size: number(row.bytes.length), mtimeNs: number(row.mtimeNs), ctimeNs: number(row.ctimeNs),
      isFile: () => !row.directory, isDirectory: () => row.directory, isSymbolicLink: () => false };
  };
  const mock = (object, method, implementation) => patches.push(t.mock.method(object, method, implementation));
  const property = (object, key, value, present = true) => {
    const original = Object.getOwnPropertyDescriptor(object, key);
    restorers.push(() => original ? Object.defineProperty(object, key, original) : Reflect.deleteProperty(object, key));
    if (present) Object.defineProperty(object, key, { value, writable: false, enumerable: true, configurable: true });
    else Reflect.deleteProperty(object, key);
  };
  property(process, "execPath", SIMULATED_EXECUTABLE);
  property(process, "platform", "darwin");
  property(process, "arch", "arm64");
  property(process.versions, "electron", reviewedPublication ? "44.1.1" : "SIMULATED-NOT-AN-ELECTRON-BINARY", electron);
  if (reviewedPublication) mock(os, "release", () => "27.0.0"); // Explicit synthetic OS review, not real support evidence.
  for (const [key, value] of [["LING_STACK_PACKAGED_DESKTOP", "1"], ["ELECTRON_RUN_AS_NODE", "1"]]) {
    const original = process.env[key];
    restorers.push(() => original === undefined ? Reflect.deleteProperty(process.env, key) : process.env[key] = original);
    process.env[key] = value;
  }
  mock(fs, "realpathSync", path => { rowAt(path); return String(path); });
  mock(fs, "lstatSync", (path, options) => stat(rowAt(path), options?.bigint));
  mock(fs, "openSync", (path, flags) => {
    const row = rowAt(path);
    if ((flags & fs.constants.O_DIRECTORY) && !row.directory) throw errno("ENOTDIR");
    const slot = { fd: nextFd++, path: String(path), row, offset: 0, statCalls: 0, readCalls: 0 };
    descriptors.set(slot.fd, slot); opens.push(slot); hooks.open?.(slot); return slot.fd;
  });
  mock(fs, "fstatSync", (fd, options) => {
    const slot = descriptorAt(fd); slot.statCalls++; hooks.stat?.(slot);
    return stat(slot.row, options?.bigint);
  });
  mock(fs, "readSync", (fd, buffer, offset, length, position) => {
    const slot = descriptorAt(fd); slot.readCalls++; hooks.read?.(slot);
    const start = position === null ? slot.offset : position;
    const count = Math.max(0, Math.min(length, slot.row.bytes.length - start));
    slot.row.bytes.copy(buffer, offset, start, start + count);
    if (position === null) slot.offset += count;
    return count;
  });
  mock(fs, "readFileSync", (path, options) => {
    const bytes = Buffer.from(rowAt(path).bytes);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  });
  mock(fs, "closeSync", fd => {
    const slot = descriptorAt(fd); closes.push({ fd, path: slot.path, row: slot.row });
    hooks.close?.(slot); descriptors.delete(fd);
  });
  mock(crypto, "createHash", (algorithm, options) => {
    const original = originalHash(algorithm, options), pieces = [];
    const observed = {
      update(bytes, encoding) {
        pieces.push(typeof bytes === "string" ? Buffer.from(bytes, encoding) : Buffer.from(bytes));
        original.update(bytes, encoding); return observed;
      },
      digest(encoding) {
        if (algorithm === "sha256" && Buffer.concat(pieces).equals(DYLD_BYTES)) {
          original.digest();
          const simulated = Buffer.from(SIMULATED_REVIEWED_DIGEST, "hex");
          return encoding ? simulated.toString(encoding) : simulated;
        }
        return original.digest(encoding);
      },
    };
    return observed;
  });
  mock(childProcess, "spawnSync", (command, args, options) => {
    const call = { command, args: [...args], options }; nativeCalls.push(call);
    // Both choices are recorded only; no actual native process can be entered.
    assert.ok([SIMULATED_CODESIGN, SIMULATED_HELPER].includes(command), "unexpected native process");
    if (command === SIMULATED_HELPER) {
      assert.deepEqual(args, ["--verify-packaged-codesign"]);
      assert.equal(options.encoding, "buffer"); assert.equal(options.timeout, 35000);
      assert.equal(options.killSignal, "SIGKILL"); assert.equal(options.maxBuffer, 262148);
      assert.equal(options.stdio, "pipe"); assert.equal(options.cwd, "/"); assert.ok(Buffer.isBuffer(options.input));
    }
    const supplied = hooks.native?.(call);
    if (supplied !== undefined) return supplied;
    const stdout = command === SIMULATED_HELPER ? Buffer.alloc(0) : "";
    const stderr = command === SIMULATED_HELPER ? Buffer.from("observer failure") : "observer failure";
    return { pid: 987654, status: 1, signal: null, error: undefined, stdout, stderr, output: [null, stdout, stderr] };
  });
  mock(childProcess, "execFileSync", () => { throw new Error("native execFileSync is forbidden in this simulation"); });
  mock(childProcess, "spawn", () => { throw new Error("native spawn is forbidden in this simulation"); });
  syncBuiltinESMExports();
  t.after(() => {
    for (const patch of patches.reverse()) patch.mock.restore();
    for (const restore of restorers.reverse()) restore();
    syncBuiltinESMExports();
  });
  const completed = (call, changes = {}, helperChanges = {}) => {
    assert.equal(call.command, SIMULATED_HELPER);
    const frame = call.options.input;
    assert.equal(frame.readUInt32BE(0), frame.length - 4);
    const request = JSON.parse(frame.subarray(4).toString("utf8"));
    const value = { type: "codesign_completed", protocolVersion: 1, helperVersion: request.expectedHelperVersion,
      role: "packaged_codesign_v1", helperPid: 987654, parentPid: request.parentPid, requestId: request.requestId,
      nonce: request.nonce, hostProcessEpoch: request.hostProcessEpoch, appBundlePath: request.appBundlePath,
      appDevice: request.appDevice, appInode: request.appInode, profile: simulatedProfile(request.appBundlePath),
      childPid: 987655, exitCode: 0, signal: null, stdoutHex: "", stderrHex: "",
      spawnBackend: "darwin_posix_spawn_no_fallback_v1", registeredNullActionCount: 3, exceptionActionMask: 16382,
      nullSpecialPortActions: [4], reviewedNonInheritedSpecialSlots: [10, 11],
      specialSlotEvidence: "reviewed_xnu_no_parent_copy_not_runtime_observed_v1", helperHostObjectType: 3,
      helperAccessObjectType: null, helperAccessService: "absent", helperInheritedExtraFdsClosed: 7,
      machCapabilityClosure: "not_certified", childStdio: [0, 1, 2], descendantDrain: "not_verified", enforcementReady: false,
      ...changes };
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    const stdout = Buffer.concat([header, body]), stderr = Buffer.alloc(0);
    return { pid: 987654, status: 0, signal: null, stdout, stderr, output: [null, stdout, stderr], ...helperChanges };
  };
  return { hooks, opens, closes, descriptors, nativeCalls, dyld, helper, manifest, taskgatedPlist, taskgatedDaemon, completed,
    loadInventory: () => import(isolatedModules.get("protected-host-actor-inventory.js")),
    loadRegistry: () => import(isolatedModules.get("protected-host-staging.js")),
    alterPublishedReview(alter) { const value = JSON.parse(simulatedPublishedJson); alter(value); simulatedPublishedJson = JSON.stringify(value); },
    loadSource: () => import(sourceUrl),
    loadBootstrap: () => import(bootstrapUrl),
    loadIndependentSource: () => import(moduleUrl("runtime/sandbox/packaged-codesign-host-source.js")
      + "?codesign-independent=" + ++importSequence),
    loadBootstrapReview: () => import(moduleUrl("runtime/sandbox/protected-host-bootstrap-domain.js")),
    loadBackend: () => import(moduleUrl("runtime/sandbox/macos-sandbox-backend.js")),
    loadNativeCommand: () => import(moduleUrl("runtime/sandbox/macos-native-command.js")),
    closeCount: fd => closes.filter(call => call.fd === fd).length,
    originalFiles: () => [...descriptors.values()].filter(slot => !slot.row.foreign),
    replaceWithForeign(slot) {
      slot.row = { ...slot.row, ino: slot.row.ino + 100000, foreign: true };
    },
  };
}
