import assert from "node:assert/strict";
import fs from "node:fs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { makeNestedBuildUnsigned, prepareUnsignedJsiCapsule, removeConstantsLoginShell, verifyUnsignedJsiCapsule } from "../scripts/prepare-unsigned-jsi-capsule.mjs";

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const installedApple = join(dirname(expoRequire.resolve("expo-modules-jsi/package.json")), "apple");
const installedConstants = dirname(expoRequire.resolve("expo-constants/package.json"));

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode ? { mode } : undefined);
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-jsi-capsule-test-")));
  const capsule = join(root, "capsule");
  const ios = join(capsule, "apps/mobile/ios");
  const pods = join(ios, "Pods");
  const support = join(pods, "Target Support Files/ExpoModulesJSI");
  const source = join(root, "upstream-apple");
  cpSync(installedApple, source, { recursive: true });
  write(join(capsule, "apps/mobile/package.json"), JSON.stringify({ name: "@ling-stack/mobile" }));
  write(join(ios, "Podfile"), "# Synthetic capsule, no pod install\n");
  const prefix = relative(pods, source);
  const projectPath = join(pods, "Pods.xcodeproj/project.pbxproj");
  write(projectPath, `{
  path = "${prefix}";
  path = "${relative(source, support)}";
  shellScript = ${JSON.stringify('bash -l -c "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"')};
  shellScript = ${JSON.stringify('"${PODS_TARGET_SRCROOT}/scripts/build-xcframework.sh"')};
}\n`);
  write(join(support, "ExpoModulesJSI.debug.xcconfig"), `PODS_TARGET_SRCROOT = \${PODS_ROOT}/${prefix}\n`);
  write(join(support, "ExpoModulesJSI-xcframeworks.sh"), `source="\${PODS_ROOT}/${prefix}/Products/ExpoModulesJSI.xcframework"\n`);
  write(join(support, "ExpoModulesJSI-xcframeworks-input-files.xcfilelist"), `\${PODS_ROOT}/${prefix}/Products/ExpoModulesJSI.xcframework`);
  const rnRoot = join(root, "reviewed-react-native");
  write(join(rnRoot, "package.json"), JSON.stringify({ name: "react-native", version: "0.86.3" }));
  for (const name of ["jsi.h", "jsi-inl.h", "instrumentation.h"]) {
    write(join(rnRoot, name), "// synthetic header\n");
    mkdirSync(join(pods, "Headers/Public/React-jsi/jsi"), { recursive: true });
    symlinkSync(join(rnRoot, name), join(pods, "Headers/Public/React-jsi/jsi", name));
  }
  const commands = join(root, "commands");
  const argvFile = join(root, "nested-argv.txt");
  write(join(commands, "xcrun"), '#!/bin/sh\nprintf "Synthetic Swift version\\n"\n', 0o755);
  write(join(commands, "xcodebuild"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nexit 73\n`, 0o755);
  const env = {
    PATH: `${commands}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: process.env.HOME,
    TMPDIR: tmpdir(),
    PODS_ROOT: pods, REACT_NATIVE_PATH: rnRoot, PLATFORM_NAME: "iphoneos",
    DEVELOPER_DIR: "/synthetic-toolchain", CODE_SIGNING_ALLOWED: "NO", CODE_SIGNING_REQUIRED: "NO",
  };
  return { root, capsule, ios, pods, source, rnRoot, support, projectPath, argvFile, env,
    prepare: () => prepareUnsignedJsiCapsule({ capsulePath: capsule, applePath: source, reactNativePath: rnRoot }) };
}

test("original real upstream nested invocation drops parent unsigned flags; patched copy preserves them", () => {
  const f = fixture();
  const original = spawnSync("/bin/bash", ["--noprofile", "--norc", join(f.source, "scripts/build-xcframework.sh")], { env: f.env, encoding: "utf8" });
  assert.equal(original.status, 73, original.stderr);
  const originalArgs = readFileSync(f.argvFile, "utf8");
  assert.ok(!originalArgs.includes("CODE_SIGNING_ALLOWED=NO"), "baseline proves inherited env flags do not reach the child");
  const receipt = f.prepare();
  const patched = spawnSync("/bin/bash", ["--noprofile", "--norc", join(receipt.staged, "scripts/build-xcframework.sh")], { env: f.env, encoding: "utf8" });
  assert.equal(patched.status, 73, patched.stderr);
  const patchedArgs = readFileSync(f.argvFile, "utf8").split("\n");
  for (const setting of ["CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=", "EXPANDED_CODE_SIGN_IDENTITY=", "DEVELOPMENT_TEAM=", "PROVISIONING_PROFILE=", "PROVISIONING_PROFILE_SPECIFIER="]) {
    assert.ok(patchedArgs.includes(setting), setting);
  }
  assert.ok(patchedArgs.includes("-disableAutomaticPackageResolution"));
  assert.ok(patchedArgs.includes("-sdk") && patchedArgs.includes("iphoneos"));
  assert.ok(readFileSync(join(receipt.staged, ".generated/module.modulemap"), "utf8").includes(f.pods));
  assert.equal(receipt.compilationPerformed, false);
  assert.equal(receipt.signingPerformed, false);
  assert.equal(receipt.deviceInstalled, false);
});

test("relocation preserves vendor bytes, backs up generated consumers, and refuses repeat preparation", () => {
  const f = fixture();
  const old = readFileSync(join(f.source, "scripts/build-xcframework.sh"));
  const receipt = f.prepare();
  assert.deepEqual(readFileSync(join(f.source, "scripts/build-xcframework.sh")), old);
  for (const change of receipt.generatedChanges) {
    const after = readFileSync(join(f.ios, change.path), "utf8");
    assert.ok(!after.includes(relative(f.pods, f.source)));
    assert.ok(existsSync(join(f.ios, "ling-qa-native/original-generated", change.path)));
  }
  assert.ok(readFileSync(f.projectPath, "utf8").includes("--run-jsi"));
  assert.equal(verifyUnsignedJsiCapsule(join(f.ios, "ling-qa-native/receipt.json")).staged, receipt.staged);
  assert.throws(f.prepare, /already exists/);
});

test("upstream anchor or Constants phase drift fails before any capsule mutation", () => {
  assert.throws(() => makeNestedBuildUnsigned("xcodebuild build"), /Unexpected/);
  assert.throws(() => removeConstantsLoginShell("unknown phase"), /Unexpected/);
  const f = fixture();
  write(join(f.source, "scripts/build-xcframework.sh"), "unexpected upstream\n");
  const before = readFileSync(f.projectPath, "utf8");
  assert.throws(f.prepare, /Unexpected/);
  assert.equal(readFileSync(f.projectPath, "utf8"), before);
  assert.equal(existsSync(join(f.ios, "ling-qa-native")), false);
});

test("copied immutable input changes and escaped generated roots reject before helper execution", () => {
  const f = fixture();
  const receipt = f.prepare();
  const receiptPath = join(f.ios, "ling-qa-native/receipt.json");
  const script = join(receipt.staged, "scripts/build-xcframework.sh");
  const before = readFileSync(script, "utf8");
  write(script, `${before}\n# unexpected drift\n`);
  assert.throws(() => verifyUnsignedJsiCapsule(receiptPath), /immutable source changed/);
  write(script, before);
  for (const root of [".generated", ".DerivedData", ".build", ".swiftpm"]) {
    const another = fixture();
    const anotherReceipt = another.prepare();
    symlinkSync(another.source, join(anotherReceipt.staged, root));
    assert.throws(() => verifyUnsignedJsiCapsule(join(another.ios, "ling-qa-native/receipt.json")), /outside its writable root/);
  }
  assert.equal(existsSync(f.argvFile), false, "no native or synthetic child dispatch");
});

test("source symlinks are rejected without touching their targets", () => {
  const f = fixture();
  symlinkSync(f.projectPath, join(f.source, "source-link"));
  const before = readFileSync(f.projectPath, "utf8");
  assert.throws(f.prepare, /symlink/);
  assert.equal(readFileSync(f.projectPath, "utf8"), before);
});

test("generated copy drift and partial receipts never dispatch a child", () => {
  const f = fixture();
  f.prepare();
  const receiptPath = join(f.ios, "ling-qa-native/receipt.json");
  const consumer = join(f.support, "ExpoModulesJSI-xcframeworks.sh");
  const before = readFileSync(consumer, "utf8");
  write(consumer, "# unreviewed copy source\n");
  assert.throws(() => verifyUnsignedJsiCapsule(receiptPath), /consumer changed/);
  write(consumer, before);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  write(receiptPath, JSON.stringify({ ...receipt, status: "partial" }));
  assert.throws(() => verifyUnsignedJsiCapsule(receiptPath), /not complete/);
  assert.equal(existsSync(f.argvFile), false);
});

test("legitimate RN header links work, but retargeting or losing the reviewed root is rejected", () => {
  const f = fixture();
  const receipt = f.prepare();
  const receiptPath = join(f.ios, "ling-qa-native/receipt.json");
  verifyUnsignedJsiCapsule(receiptPath);
  const headerPath = join(f.pods, "Headers/Public/React-jsi/jsi/jsi.h");
  const alternate = join(f.root, "other-rn/jsi.h");
  write(alternate, "// different RN\n");
  unlinkSync(headerPath); // Only unlink this synthetic fixture symlink, never its target.
  symlinkSync(alternate, headerPath);
  assert.throws(() => verifyUnsignedJsiCapsule(receiptPath), /header changed/);
  unlinkSync(headerPath);
  symlinkSync(join(f.rnRoot, "jsi.h"), headerPath);
  const env = { ...f.env };
  delete env.REACT_NATIVE_PATH;
  const result = spawnSync(process.execPath, [join(receipt.staged, "../capsule-runner.mjs"), "--run-jsi", receiptPath], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lacks its reviewed/);
  assert.equal(existsSync(f.argvFile), false);
});

test("new compile inputs and writable links into immutable source are rejected", () => {
  for (const scenario of ["new-source", "internal-write", "optional-framework"]) {
    const f = fixture();
    const receipt = f.prepare();
    if (scenario === "new-source") write(join(receipt.staged, "Sources/Unreviewed.swift"), "// unexpected input\n");
    if (scenario === "internal-write") {
      mkdirSync(join(receipt.staged, ".generated"));
      symlinkSync(join(receipt.staged, "Package.swift"), join(receipt.staged, ".generated/module.modulemap"));
    }
    if (scenario === "optional-framework") mkdirSync(join(receipt.staged, ".test-frameworks"));
    assert.throws(() => verifyUnsignedJsiCapsule(join(f.ios, "ling-qa-native/receipt.json")), /inventory changed|writable root|optional test/);
    assert.equal(existsSync(f.argvFile), false);
  }
});

test("the generated JSI phase strips Node and shell preloads and propagates the nonzero child status", () => {
  const f = fixture();
  const receipt = f.prepare();
  const project = readFileSync(f.projectPath, "utf8");
  const phase = project.split("\n").find((line) => line.includes("--run-jsi"));
  const command = JSON.parse(phase.trim().slice("shellScript = ".length, -1));
  const env = { ...f.env, NODE_OPTIONS: "--require /synthetic-invalid-node-preload", NODE_PATH: "/synthetic-node-path", BASH_ENV: "/synthetic-shell-preload" };
  const result = spawnSync("/bin/sh", ["-c", command], { env, encoding: "utf8" });
  assert.equal(result.status, 73, result.stderr);
  assert.ok(readFileSync(f.argvFile, "utf8").includes("CODE_SIGNING_ALLOWED=NO"));
  assert.equal(existsSync(join(receipt.staged, ".DerivedData/Build/Products/Release-iphoneos/PackageFrameworks/ExpoModulesJSI.framework")), false);
});

test("copied runner drift and shell-active capsule names are refused", () => {
  const f = fixture();
  const receipt = f.prepare();
  write(join(receipt.staged, "../capsule-runner.mjs"), "// different entry point\n");
  assert.throws(() => verifyUnsignedJsiCapsule(join(f.ios, "ling-qa-native/receipt.json")), /runner changed/);
  const other = fixture();
  const unsafeCapsule = `${other.capsule}-$QA_PATH`;
  renameSync(other.capsule, unsafeCapsule);
  assert.throws(() => prepareUnsignedJsiCapsule({ capsulePath: unsafeCapsule, applePath: other.source, reactNativePath: other.rnRoot }), /Unsupported characters/);
  assert.equal(existsSync(join(unsafeCapsule, "apps/mobile/ios/ling-qa-native")), false);
});

test("Constants keeps the real upstream config helper and capsule xcode.env for shallow and deep bundles", () => {
  for (const format of ["shallow", "deep"]) {
    const f = fixture();
    const project = removeConstantsLoginShell(readFileSync(f.projectPath, "utf8"));
    const phase = project.split("\n").find((line) => line.includes("get-app-config-ios.sh"));
    const command = JSON.parse(phase.trim().slice("shellScript = ".length, -1));
    const mobile = join(f.capsule, "apps/mobile");
    const build = join(f.root, "constants-build");
    const resource = join(build, "EXConstants.bundle", format === "deep" ? "Contents/Resources" : "");
    mkdirSync(resource, { recursive: true });
    write(join(mobile, "app.json"), JSON.stringify({ expo: { name: "Synthetic Constants QA", slug: "synthetic-constants-qa" } }));
    write(join(f.ios, ".xcode.env"), `export NODE_BINARY='${process.execPath}'\n`);
    const env = {
      ...f.env, PODS_TARGET_SRCROOT: join(installedConstants, "ios"), PROJECT_DIR: f.pods,
      PROJECT_ROOT: mobile, CONFIGURATION_BUILD_DIR: build, BUNDLE_FORMAT: format,
      NODE_OPTIONS: "--require /synthetic-invalid-node-preload", BASH_ENV: "/synthetic-shell-preload",
      EXPO_NO_DOTENV: "1", // Only synthetic projects; no user dotenv read is required.
    };
    const result = spawnSync("/bin/sh", ["-c", command], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(resource, "app.config"), "utf8"));
    assert.equal(config.name, "Synthetic Constants QA");
    assert.equal(config.slug, "synthetic-constants-qa");
    assert.equal(existsSync(f.argvFile), false, "Constants does not compile or sign");
  }
});

test("an actual preparation write failure preserves backups and an unusable partial receipt", (t) => {
  const f = fixture();
  const failingPath = join(f.support, "ExpoModulesJSI.debug.xcconfig");
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (path, ...args) => {
    if (path === failingPath) throw new Error("Synthetic generated-file write failure");
    return originalWrite(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(f.prepare, /Synthetic generated-file write failure/);
    const receiptPath = join(f.ios, "ling-qa-native/receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.status, "partial");
    assert.deepEqual(receipt.appliedPaths, [
      "Pods/Pods.xcodeproj/project.pbxproj",
      "Pods/Target Support Files/ExpoModulesJSI/ExpoModulesJSI-xcframeworks-input-files.xcfilelist",
      "Pods/Target Support Files/ExpoModulesJSI/ExpoModulesJSI-xcframeworks.sh",
    ]);
    for (const path of receipt.appliedPaths) {
      assert.ok(existsSync(join(f.ios, "ling-qa-native/original-generated", path)));
    }
    assert.ok(existsSync(join(f.ios, "ling-qa-native/original-generated", relative(f.ios, failingPath))));
    assert.ok(readFileSync(failingPath, "utf8").includes(relative(f.pods, f.source)));
    assert.throws(() => verifyUnsignedJsiCapsule(receiptPath), /not complete/);
    assert.equal(existsSync(f.argvFile), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("a Simulator invocation keeps its own SDK and destination while remaining explicitly unsigned", () => {
  const f = fixture();
  const receipt = f.prepare();
  const result = spawnSync(process.execPath, [join(receipt.staged, "../capsule-runner.mjs"), "--run-jsi", join(f.ios, "ling-qa-native/receipt.json")], {
    env: { ...f.env, PLATFORM_NAME: "iphonesimulator" }, encoding: "utf8",
  });
  assert.equal(result.status, 73, result.stderr);
  const argv = readFileSync(f.argvFile, "utf8").split("\n");
  assert.equal(argv[argv.indexOf("-sdk") + 1], "iphonesimulator");
  assert.equal(argv[argv.indexOf("-destination") + 1], "generic/platform=iOS Simulator");
  assert.ok(argv.includes("CODE_SIGNING_ALLOWED=NO"));
});
