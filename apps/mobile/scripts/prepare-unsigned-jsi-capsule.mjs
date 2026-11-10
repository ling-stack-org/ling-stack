import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BUILD_SCRIPT = "scripts/build-xcframework.sh";
const EXCLUDED = new Set([".DerivedData", ".build", ".swiftpm", ".generated", ".test-frameworks"]);
const UNSIGNED_SETTINGS = [
  "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", 'CODE_SIGN_IDENTITY=""',
  'EXPANDED_CODE_SIGN_IDENTITY=""', 'DEVELOPMENT_TEAM=""',
  'PROVISIONING_PROFILE=""', 'PROVISIONING_PROFILE_SPECIFIER=""',
];

/** Restrict this acceptance-only transformation to a real, fresh temporary capsule. */
function assertCapsule(capsule) {
  assertGeneratedPath(capsule);
  const roots = [tmpdir(), "/private/tmp", "/tmp"].filter(existsSync).map((path) => realpathSync(path));
  if (!roots.some((root) => isInside(root, capsule))) throw new Error("Capsule must be a temporary directory");
  const mobile = join(capsule, "apps/mobile");
  if (JSON.parse(readFileSync(join(mobile, "package.json"), "utf8")).name !== "@ling-stack/mobile") {
    throw new Error("Not a Ling Mobile capsule");
  }
  const ios = join(mobile, "ios");
  for (const file of ["Podfile", "Pods/Pods.xcodeproj/project.pbxproj"]) {
    const path = join(ios, file);
    if (realpathSync(path) !== path || !isInside(capsule, realpathSync(path))) {
      throw new Error("Native project must not resolve outside the capsule");
    }
  }
  return ios;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function pbxShellField(script) { return `shellScript = ${JSON.stringify(script)};`; }

function assertGeneratedPath(path) {
  // Generated CocoaPods shell/xcconfig paths are not general-purpose parsers.
  if (!/^[A-Za-z0-9_./ +@=-]+$/.test(path)) throw new Error("Unsupported characters in a generated QA path");
}

/** Abort on upstream drift rather than silently claiming an unsigned nested build. */
export function makeNestedBuildUnsigned(source) {
  const anchor = "    xcodebuild \\\n    build \\\n";
  if (source.split(anchor).length !== 2 || source.includes("CODE_SIGNING_ALLOWED=")) {
    throw new Error("Unexpected JSI nested-build source; review upstream changes first");
  }
  const args = UNSIGNED_SETTINGS.map((setting) => `    ${setting} \\\n`).join("");
  return source.replace(anchor, `${anchor}${args}`);
}

/** Preserve Constants' original helper and .xcode.env semantics, without login profiles. */
export function removeConstantsLoginShell(project) {
  const before = 'bash -l -c "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"';
  const after = 'unset BASH_ENV ENV NODE_OPTIONS NODE_PATH; /bin/bash --noprofile --norc "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"';
  const oldField = pbxShellField(before);
  if (project.split(oldField).length !== 2) throw new Error("Unexpected Constants phase; review before changing it");
  return project.replace(oldField, pbxShellField(after));
}

/** Copy only package-local inputs; refuse symlinks that could redirect generated writes. */
function packageFiles(root, prefix = "", immutableOnly = false) {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (!prefix && (EXCLUDED.has(entry.name) || (immutableOnly && entry.name === "Products"))) continue;
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("JSI input contains a symlink; review isolation before copying");
    if (entry.isDirectory()) files.push(...packageFiles(root, path, immutableOnly));
    else if (entry.isFile()) files.push(path);
    else throw new Error("Unexpected JSI input file type");
  }
  return files.sort();
}

function generatedFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Generated support input must not be a symlink");
    if (entry.isDirectory()) files.push(...generatedFiles(path));
    else if (entry.isFile() && /\.(?:xcconfig|xcfilelist|sh)$/.test(path)) files.push(path);
  }
  return files.sort();
}

/** Prepare a QA-only native copy. Never compile, sign, install, or write vendor sources. */
export function prepareUnsignedJsiCapsule({ capsulePath, applePath, reactNativePath }) {
  const capsule = realpathSync(capsulePath);
  const ios = assertCapsule(capsule);
  const source = realpathSync(applePath);
  assertGeneratedPath(source);
  if (isInside(capsule, source) || !readFileSync(join(source, "Package.swift"), "utf8").includes('name: "ExpoModulesJSI"')) {
    throw new Error("Expected an external installed ExpoModulesJSI apple package");
  }
  const taskRoot = join(ios, "ling-qa-native");
  if (existsSync(taskRoot)) throw new Error("QA native stage already exists; inspect the existing receipt instead");
  const staged = join(taskRoot, "ExpoModulesJSI");
  const pods = join(ios, "Pods");
  if (realpathSync(pods) !== pods) throw new Error("Pods root must be capsule-local");
  if (!reactNativePath) throw new Error("An explicit reviewed React Native root is required");
  const rnRoot = realpathSync(reactNativePath);
  assertGeneratedPath(rnRoot);
  const rnVersion = JSON.parse(readFileSync(join(rnRoot, "package.json"), "utf8")).version;
  const headerManifest = ["jsi.h", "jsi-inl.h", "instrumentation.h"].map((name) => {
    const path = join(pods, "Headers/Public/React-jsi/jsi", name);
    const target = realpathSync(path);
    if (!isInside(rnRoot, target)) throw new Error("JSI header resolves outside the reviewed React Native root");
    return { path, target, sha256: hash(readFileSync(target)) };
  });
  const support = join(pods, "Target Support Files");
  const projectPath = join(pods, "Pods.xcodeproj/project.pbxproj");
  const oldRelative = relative(pods, source);
  const newRelative = relative(pods, staged);
  const originalProject = readFileSync(projectPath, "utf8");
  const xcconfig = readFileSync(join(support, "ExpoModulesJSI/ExpoModulesJSI.debug.xcconfig"), "utf8");
  if (!xcconfig.includes(`PODS_TARGET_SRCROOT = \${PODS_ROOT}/${oldRelative}\n`)) {
    throw new Error("JSI source root does not match the supplied installed package");
  }
  const sourceFiles = packageFiles(source);
  const sourceManifest = sourceFiles.filter((path) => !path.startsWith(`Products${sep}`))
    .map((path) => ({ path, sha256: hash(readFileSync(join(source, path))) }));
  const transformedBuild = makeNestedBuildUnsigned(readFileSync(join(source, BUILD_SCRIPT), "utf8"));
  let project = removeConstantsLoginShell(originalProject);
  const oldSupport = relative(source, join(support, "ExpoModulesJSI"));
  const newSupport = relative(staged, join(support, "ExpoModulesJSI"));
  if (project.split(oldSupport).length !== 2 || !project.includes(oldRelative)) {
    throw new Error("Unexpected JSI project references; review before relocation");
  }
  project = project.replaceAll(oldRelative, newRelative).replace(oldSupport, newSupport);
  const jsiPhase = pbxShellField('"${PODS_TARGET_SRCROOT}/scripts/build-xcframework.sh"');
  if (project.split(jsiPhase).length !== 2) throw new Error("Unexpected JSI build phase");
  const node = realpathSync(process.execPath);
  assertGeneratedPath(node);
  const jsiRunner = `unset BASH_ENV ENV NODE_OPTIONS NODE_PATH; "${node}" "${staged}/../capsule-runner.mjs" --run-jsi "${taskRoot}/receipt.json"`;
  project = project.replace(jsiPhase, pbxShellField(jsiRunner));
  const changes = [{ path: projectPath, before: originalProject, after: project }];
  for (const path of generatedFiles(support)) {
    const before = readFileSync(path, "utf8");
    if (before.includes(oldRelative)) changes.push({ path, before, after: before.replaceAll(oldRelative, newRelative) });
  }
  if (!changes.some(({ path }) => path.endsWith("ExpoModulesJSI-xcframeworks.sh")) ||
      !changes.some(({ path }) => path.endsWith("ExpoModulesJSI-xcframeworks-input-files.xcfilelist"))) {
    throw new Error("Missing XCFramework consumer relocation");
  }
  // All inputs and exact replacement contracts are validated before writes.
  mkdirSync(taskRoot);
  mkdirSync(staged);
  const originals = join(taskRoot, "original-generated");
  for (const { path, before } of changes) {
    const backup = join(originals, relative(ios, path));
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, before, { flag: "wx" });
  }
  for (const path of sourceFiles) {
    const destination = join(staged, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(source, path), destination, { errorOnExist: true, force: false });
  }
  writeFileSync(join(staged, BUILD_SCRIPT), transformedBuild);
  cpSync(fileURLToPath(import.meta.url), join(taskRoot, "capsule-runner.mjs"), { errorOnExist: true, force: false });
  const receipt = {
    schema: "ling-mobile-unsigned-jsi-capsule-v1", capsule, source, staged,
    status: "prepared", appliedPaths: [],
    sourceManifest, rnRoot, rnVersion, headerManifest, nestedBuildSha256: hash(transformedBuild),
    runnerSha256: hash(readFileSync(join(taskRoot, "capsule-runner.mjs"))),
    generatedChanges: changes.map(({ path, before, after }) => ({
      path: relative(ios, path), beforeSha256: hash(before), afterSha256: hash(after),
    })),
    compilationPerformed: false, signingPerformed: false, deviceInstalled: false,
    boundary: "JSI generated writes relocated only; not whole-build OS or cache isolation",
  };
  const receiptPath = join(taskRoot, "receipt.json");
  const saveReceipt = (options) => writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, options);
  saveReceipt({ flag: "wx" });
  try {
    // Compare all first, then recheck each immediately before writing. This is
    // not a multi-file transaction or a defence against other same-user writers.
    for (const change of changes) {
      if (readFileSync(change.path, "utf8") !== change.before) throw new Error("Capsule changed during preparation");
    }
    for (const change of changes) {
      if (readFileSync(change.path, "utf8") !== change.before) throw new Error("Capsule changed during preparation");
      writeFileSync(change.path, change.after);
      receipt.appliedPaths.push(relative(ios, change.path));
      saveReceipt();
    }
    receipt.status = "ready";
    saveReceipt();
  } catch (error) {
    receipt.status = "partial";
    saveReceipt();
    throw error; // Preserve original-generated and partial receipt; never roll back somebody else's edits.
  }
  return receipt;
}

/** Check immutable inputs and preexisting output links before invoking a copied helper. */
export function verifyUnsignedJsiCapsule(receiptPath) {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.schema !== "ling-mobile-unsigned-jsi-capsule-v1" || receipt.status !== "ready") throw new Error("Capsule preparation is not complete");
  const capsule = realpathSync(receipt.capsule);
  const ios = assertCapsule(capsule);
  const staged = join(ios, "ling-qa-native/ExpoModulesJSI");
  if (receipt.staged !== staged || realpathSync(staged) !== staged ||
      realpathSync(receiptPath) !== join(ios, "ling-qa-native/receipt.json")) {
    throw new Error("JSI stage or receipt moved outside the capsule");
  }
  const runner = join(ios, "ling-qa-native/capsule-runner.mjs");
  if (realpathSync(runner) !== runner || hash(readFileSync(runner)) !== receipt.runnerSha256) {
    throw new Error("JSI copied runner changed");
  }
  if (JSON.stringify(packageFiles(staged, "", true)) !== JSON.stringify(receipt.sourceManifest.map(({ path }) => path))) {
    throw new Error("JSI immutable source inventory changed");
  }
  if (existsSync(join(staged, ".test-frameworks"))) throw new Error("Unreviewed optional test frameworks appeared");
  for (const { path, sha256 } of receipt.sourceManifest) {
    if (!isInside(staged, resolve(staged, path))) throw new Error("Invalid manifest path");
    const file = join(staged, path);
    if (realpathSync(file) !== file || hash(readFileSync(file)) !==
        (path === BUILD_SCRIPT ? receipt.nestedBuildSha256 : sha256)) {
      throw new Error("JSI immutable source changed");
    }
  }
  for (const { path, afterSha256 } of receipt.generatedChanges) {
    const file = resolve(ios, path);
    if (!isInside(ios, file) || realpathSync(file) !== file || hash(readFileSync(file)) !== afterSha256) {
      throw new Error("JSI generated consumer changed");
    }
  }
  if (JSON.parse(readFileSync(join(receipt.rnRoot, "package.json"), "utf8")).version !== receipt.rnVersion) {
    throw new Error("Reviewed React Native version changed");
  }
  for (const header of receipt.headerManifest) {
    if (realpathSync(header.path) !== header.target || !isInside(receipt.rnRoot, header.target) ||
        hash(readFileSync(header.target)) !== header.sha256) {
      throw new Error("Reviewed JSI header changed");
    }
  }
  for (const path of ["Products", ".generated", ".DerivedData", ".build", ".swiftpm"]) {
    const root = join(staged, path);
    verifyOutputLinks(root, root);
  }
  return receipt;
}

function verifyOutputLinks(root, path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink()) {
    if (!isInside(root, realpathSync(path))) throw new Error("JSI generated output points outside its writable root");
    return;
  }
  if (stat.isDirectory()) for (const entry of readdirSync(path)) verifyOutputLinks(root, join(path, entry));
}

/** Run only the reviewed copied helper; sanitise shell/Node preloads, preserve Pods inputs. */
export function runUnsignedJsiCapsule(receiptPath) {
  const receipt = verifyUnsignedJsiCapsule(receiptPath);
  const expectedPods = join(receipt.capsule, "apps/mobile/ios/Pods");
  if (!process.env.REACT_NATIVE_PATH || realpathSync(process.env.REACT_NATIVE_PATH) !== receipt.rnRoot ||
      !process.env.PODS_ROOT || realpathSync(process.env.PODS_ROOT) !== expectedPods) {
    throw new Error("JSI invocation lacks its reviewed React Native or Pods root");
  }
  const env = { ...process.env };
  for (const key of ["BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH"]) delete env[key];
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", join(receipt.staged, BUILD_SCRIPT)], {
    env, cwd: receipt.staged, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal || result.status === null) throw new Error("JSI child terminated without a normal exit");
  return result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [capsulePath, applePath, reactNativePath, ...extra] = process.argv.slice(2);
  if (capsulePath === "--run-jsi" && applePath && !reactNativePath && !extra.length) {
    process.exitCode = runUnsignedJsiCapsule(applePath);
  } else {
    if (!capsulePath || !applePath || !reactNativePath || extra.length) throw new Error("Usage: node prepare-unsigned-jsi-capsule.mjs CAPSULE INSTALLED_JSI_APPLE REVIEWED_RN_ROOT");
    const receipt = prepareUnsignedJsiCapsule({ capsulePath, applePath, reactNativePath });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
}
