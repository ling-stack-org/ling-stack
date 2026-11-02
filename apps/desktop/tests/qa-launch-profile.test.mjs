import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeDesktopQaLaunchProfile, readDesktopLaunchPackageMetadata } from "../dist/main/qa-launch-profile.js";
import { readPackagedQaHarnessSelection } from "../../../packages/daemon/dist/runtime/packaged-qa-harness-bootstrap.js";

const packageMarker = { schemaVersion: 1, purpose: "synthetic-human-evaluation", release: false };
const packageMetadata = { name: "owned-qa", lingHumanQaPackage: packageMarker };
function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ling-qa-launch-profile-")));
  const profile = join(parent, "profile");
  mkdirSync(profile, { mode: 0o700 });
  for (const name of ["user-data", "workspace", "ling-home"]) mkdirSync(join(profile, name), { mode: 0o700 });
  const marker = { schemaVersion: 1, kind: "synthetic-human-qa-profile", synthetic: true, modelExecution: false,
    humanConfirmation: false, workspaceCwd: join(profile, "workspace"), userDataDir: join(profile, "user-data"), lingHome: join(profile, "ling-home") };
  const markerPath = join(profile, "qa-profile.json");
  const writeMarker = value => writeFileSync(markerPath, JSON.stringify(value), { mode: 0o600 });
  writeMarker(marker);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  let userData = "/unchanged-daily-user-data", setCalls = 0;
  const environment = { HOME: "/actual-os-home", PATH: "/trusted/bin", LANG: "zh_CN.UTF-8", LC_CTYPE: "UTF-8",
    OPENAI_API_KEY: "synthetic-secret", OPENAI_API_KEY_2: "synthetic-secret-2", MY_PROVIDER_CREDENTIAL: "synthetic-ref",
    OPENAI_BASE_URL: "https://invalid.example/v1", NODE_OPTIONS: "--require=untrusted", DYLD_INSERT_LIBRARIES: "untrusted",
    LING_STACK_DAEMON_URL: "https://invalid.example", LING_STACK_HOME: "/daily-home", LING_STACK_PROVIDER_PRESET: "daily",
    LC_PROVIDER_SECRET: "not-a-locale" };
  const options = { argv: ["electron", `--ling-desktop-owned-qa-profile=${profile}`, `--user-data-dir=${marker.userDataDir}`],
    environment, packaged: true, packageMetadata, userId: process.getuid?.(),
    getUserDataPath: () => userData, setUserDataPath: value => { setCalls++; userData = value; } };
  return { parent, profile, markerPath, marker, options, environment, writeMarker, get setCalls() { return setCalls; }, get userData() { return userData; } };
}

test("normal launch preserves all environment and userData, including existing normal debugging flags", () => {
  const environment = { HOME: "/actual-home", OPENAI_API_KEY: "not-read-or-removed", LING_STACK_HOME: "/daily", NODE_OPTIONS: "normal-hook" };
  const before = { ...environment };
  let calls = 0;
  assert.equal(initializeDesktopQaLaunchProfile({ argv: ["electron", "--inspect=9229"], environment, packaged: true,
    packageMetadata: { name: "ordinary" }, userId: undefined, getUserDataPath: () => { calls++; return "/daily"; }, setUserDataPath: () => { calls++; } }), undefined);
  assert.deepEqual(environment, before); assert.equal(calls, 0);
});

test("valid explicit packaged QA fixes scope and clears every non-OS/locale inherited configuration before userData", t => {
  const f = fixture(t);
  f.options.setUserDataPath = value => {
    assert.equal(f.environment.LING_STACK_HOME, f.marker.lingHome);
    assert.equal(f.environment.MY_PROVIDER_CREDENTIAL, undefined);
    assert.equal(f.environment.NODE_OPTIONS, undefined);
    f.options.getUserDataPath = () => value;
  };
  const scope = initializeDesktopQaLaunchProfile(f.options);
  assert.deepEqual(scope, { schemaVersion: 1, purpose: "synthetic-human-evaluation", synthetic: true, profileCwd: f.profile,
    userDataDir: f.marker.userDataDir, workspaceCwd: f.marker.workspaceCwd, lingHome: f.marker.lingHome, daemonBaseUrl: "http://127.0.0.1:17928" });
  assert.equal(Object.isFrozen(scope), true);
  assert.deepEqual(f.environment, { HOME: "/actual-os-home", PATH: "/trusted/bin", LANG: "zh_CN.UTF-8", LC_CTYPE: "UTF-8",
    LING_STACK_HOME: f.marker.lingHome, LING_STACK_DEFAULT_WORKSPACE_CWD: f.marker.workspaceCwd, LING_STACK_DAEMON_URL: "http://127.0.0.1:17928",
    LING_STACK_HARNESS_CONTINUATIONS_MODE: "enforce", LING_STACK_LOCAL_WS_RPC: "false" });
  assert.equal("humanConfirmation" in scope, false); assert.equal("authorization" in scope, false);
});

function delegationSelection(f, changes = {}) {
  return { schemaVersion: 1, kind: "isolated-qa-delegation-selection", modelExecution: "host-authorized-budgeted", workspaceCwd: f.marker.workspaceCwd,
    selectedWorkflowIds: ["workflow-qa-explicit"], maxDepth: 2,
    rootBudget: { tokenBudget: 4096, wallTimeBudgetMs: 60000 }, ...changes };
}

test("only an explicit private QA selection enables bounded workflow delegation before Main", t => {
  const f = fixture(t), selection = delegationSelection(f);
  writeFileSync(join(f.profile, "qa-harness.json"), JSON.stringify(selection), { mode: 0o600 });
  f.environment.LING_STACK_QA_HARNESS_SELECTION = "inherited-untrusted-value";
  const scope = initializeDesktopQaLaunchProfile(f.options);
  assert.equal(scope.synthetic, false, "combined bounded-model scope must not claim synthetic-only execution");
  assert.equal(scope.modelExecution, "host-authorized-budgeted");
  assert.equal(f.environment.LING_STACK_HARNESS_TOOL_BROKER_MODE, "enforce");
  assert.equal(f.environment.LING_STACK_HARNESS_DELEGATIONS_MODE, "enforce");
  assert.deepEqual(JSON.parse(f.environment.LING_STACK_QA_HARNESS_SELECTION), selection);
  assert.equal(f.environment.LING_STACK_HARNESS_EVALUATIONS_MODE, undefined);
  assert.equal(f.environment.OPENAI_API_KEY, undefined, "selection is not permission to inherit a credential");
});

test("Desktop private selection reaches the typed Daemon resolver without broadening the policy", t => {
  const f = fixture(t), selection = delegationSelection(f);
  writeFileSync(join(f.profile, "qa-harness.json"), JSON.stringify(selection), { mode: 0o600 });
  initializeDesktopQaLaunchProfile(f.options);
  // These two transport flags are added by the packaged Daemon launcher, not
  // supplied by the workspace policy or inherited from the daily app process.
  const harness = readPackagedQaHarnessSelection({ ...f.environment,
    LING_STACK_PACKAGED_DESKTOP: "1", LING_STACK_PORT: "17928", LING_STACK_HOST: "127.0.0.1" });
  assert.deepEqual(harness, { continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
    delegations: { mode: "enforce", maxDepth: selection.maxDepth, selectedWorkflowIds: selection.selectedWorkflowIds,
      rootBudget: selection.rootBudget } });
  assert.equal(Object.hasOwn(harness, "evaluations"), false);
  assert.equal(Object.hasOwn(harness, "sandbox"), false);
});

for (const [label, changes] of [
  ["foreign workspace", { workspaceCwd: "/daily" }],
  ["empty workflow selection", { selectedWorkflowIds: [] }],
  ["wildcard workflow", { selectedWorkflowIds: ["*"] }],
  ["duplicate workflow", { selectedWorkflowIds: ["workflow-qa", "workflow-qa"] }],
  ["unbounded token budget", { rootBudget: { wallTimeBudgetMs: 60000 } }],
  ["missing deadline", { rootBudget: { tokenBudget: 4096 } }],
  ["unpriced monetary budget", { rootBudget: { tokenBudget: 4096, wallTimeBudgetMs: 60000, costBudgetMicros: 1 } }],
  ["extra permission", { fullAccess: true }],
  ["depth escalation", { maxDepth: 17 }],
  ["missing execution declaration", { modelExecution: undefined }],
  ["synthetic-only execution declaration", { modelExecution: false }],
]) test(`QA delegation selection rejects ${label} without mutating launch state`, t => {
  const f = fixture(t), before = { ...f.environment };
  writeFileSync(join(f.profile, "qa-harness.json"), JSON.stringify(delegationSelection(f, changes)), { mode: 0o600 });
  assert.throws(() => initializeDesktopQaLaunchProfile(f.options), /desktop_qa_/u);
  assert.deepEqual(f.environment, before); assert.equal(f.setCalls, 0);
});

for (const kind of ["public", "symlink", "hardlink"]) test(`QA selection rejects a ${kind} policy file before launch mutation`, t => {
  const f = fixture(t), before = { ...f.environment }, path = join(f.profile, "qa-harness.json");
  const text = JSON.stringify(delegationSelection(f));
  if (kind === "symlink") {
    const target = join(f.parent, "policy-target"); writeFileSync(target, text, { mode: 0o600 }); symlinkSync(target, path);
  } else {
    writeFileSync(path, text, { mode: kind === "public" ? 0o644 : 0o600 });
    if (kind === "hardlink") linkSync(path, join(f.parent, "policy-alias"));
  }
  assert.throws(() => initializeDesktopQaLaunchProfile(f.options), /desktop_qa_/u);
  assert.deepEqual(f.environment, before); assert.equal(f.setCalls, 0);
});

for (const [label, mutate] of [
  ["normal package with QA flag", f => { f.options.packageMetadata = { name: "ordinary" }; }],
  ["unpackaged developer process with QA flag", f => { f.options.packaged = false; }],
  ["QA package without profile flag", f => { f.options.argv = ["electron"]; }],
  ["package marker extra authority", f => { f.options.packageMetadata = { lingHumanQaPackage: { ...packageMarker, approved: true } }; }],
  ["package marker release true", f => { f.options.packageMetadata = { lingHumanQaPackage: { ...packageMarker, release: true } }; }],
  ["duplicate profile flag", f => { f.options.argv.push(`--ling-desktop-owned-qa-profile=${f.profile}`); }],
  ["bare profile flag", f => { f.options.argv = ["electron", "--ling-desktop-owned-qa-profile", f.profile]; }],
  ["unknown QA flag", f => { f.options.argv.push("--ling-desktop-owned-qa-enable-approval"); }],
  ["unknown QA family flag", f => { f.options.argv.push("--ling-desktop-qa-secret=hidden"); }],
  ["relative profile", f => { f.options.argv[1] = "--ling-desktop-owned-qa-profile=profile"; }],
  ["lexical parent traversal", f => { f.options.argv[1] = `--ling-desktop-owned-qa-profile=${f.profile}/../profile`; }],
  ["userData conflict", f => { f.options.argv[2] = "--user-data-dir=/daily"; }],
  ["duplicate userData", f => { f.options.argv.push(`--user-data-dir=${f.marker.userDataDir}`); }],
  ["bare userData flag", f => { f.options.argv[2] = "--user-data-dir"; f.options.argv.push(f.marker.userDataDir); }],
  ["inspector flag", f => { f.options.argv.push("--inspect=9229"); }],
  ["break inspector flag", f => { f.options.argv.push("--inspect-brk"); }],
  ["remote debugging flag", f => { f.options.argv.push("--remote-debugging-port=9229"); }],
  ["fake capture hook", f => { f.options.argv.push("--ling-desktop-fake-computer-use"); }],
  ["sandbox override", f => { f.options.argv.push("--no-sandbox"); }],
  ["JavaScript hook", f => { f.options.argv.push("--js-flags=--expose-gc"); }],
  ["proxy override", f => { f.options.argv.push("--proxy-server=https://invalid.example"); }],
  ["app override", f => { f.options.argv.push("--app=https://invalid.example"); }],
  ["unknown Chromium argument", f => { f.options.argv.push("--unfamiliar-chromium-switch"); }],
  ["unexpected positional target", f => { f.options.argv.push("https://invalid.example"); }],
  ["missing UID", f => { f.options.userId = undefined; }],
  ["wrong UID", f => { f.options.userId = Number(process.getuid?.() ?? 0) + 1; }],
  ["profile public mode", f => { chmodSync(f.profile, 0o755); }],
  ["child public mode", f => { chmodSync(f.marker.workspaceCwd, 0o750); }],
  ["marker public mode", f => { chmodSync(f.markerPath, 0o644); }],
  ["missing marker", f => { rmSync(f.markerPath); }],
  ["marker malformed JSON", f => { writeFileSync(f.markerPath, "{"); }],
  ["marker excessive bytes", f => { writeFileSync(f.markerPath, " ".repeat(4097)); }],
  ["marker synthetic false", f => { f.writeMarker({ ...f.marker, synthetic: false }); }],
  ["marker model execution true", f => { f.writeMarker({ ...f.marker, modelExecution: true }); }],
  ["marker human confirmed true", f => { f.writeMarker({ ...f.marker, humanConfirmation: true }); }],
  ["marker workspace mismatch", f => { f.writeMarker({ ...f.marker, workspaceCwd: "/daily" }); }],
  ["marker extra approval field", f => { f.writeMarker({ ...f.marker, approval: "approved" }); }],
  ["marker hardlink", f => { linkSync(f.markerPath, join(f.parent, "linked-marker")); }],
  ["marker symlink", f => { const source = join(f.parent, "marker-source"); writeFileSync(source, JSON.stringify(f.marker), { mode: 0o600 }); rmSync(f.markerPath); symlinkSync(source, f.markerPath); }],
  ["child symlink", f => { const source = join(f.parent, "external-workspace"); mkdirSync(source, { mode: 0o700 }); rmSync(f.marker.workspaceCwd, { recursive: true }); symlinkSync(source, f.marker.workspaceCwd); }],
  ["profile symlink", f => { const alias = join(f.parent, "alias"); symlinkSync(f.profile, alias); f.options.argv[1] = `--ling-desktop-owned-qa-profile=${alias}`; }],
]) {
  test(`QA early entry rejects ${label} before environment or userData changes`, t => {
    const f = fixture(t), before = { ...f.environment };
    mutate(f);
    assert.throws(() => initializeDesktopQaLaunchProfile(f.options), /desktop_qa_/u);
    assert.deepEqual(f.environment, before); assert.equal(f.setCalls, 0);
  });
}

test("normal package rejects unfamiliar QA flags without consulting profile or altering state", () => {
  const environment = { OPENAI_API_KEY: "not-removed" };
  assert.throws(() => initializeDesktopQaLaunchProfile({ argv: ["electron", "--ling-desktop-qa-unknown"], environment,
    packaged: true, packageMetadata: {}, getUserDataPath: () => { throw new Error("must-not-call"); }, setUserDataPath: () => { throw new Error("must-not-call"); } }), /desktop_qa_/u);
  assert.deepEqual(environment, { OPENAI_API_KEY: "not-removed" });
});

test("failed Electron userData readback stops QA before Main can load", t => {
  const f = fixture(t);
  f.options.setUserDataPath = () => {};
  assert.throws(() => initializeDesktopQaLaunchProfile(f.options), /desktop_qa_/u);
});

test("QA accepts only its actual app-path positional argument after executable", t => {
  const f = fixture(t);
  f.options.applicationPath = "/owned-verified-package/Contents/Resources/app.asar";
  f.options.argv.splice(1, 0, f.options.applicationPath);
  assert.equal(initializeDesktopQaLaunchProfile(f.options).profileCwd, f.profile);
});

test("early entry statically imports only Electron, Node and its pure QA leaf; Main is deferred", () => {
  const source = readFileSync(new URL("../main/entry.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']@ling-stack\//u);
  assert.doesNotMatch(source, /import\s+["']\.\/main\.js/u);
  assert.match(source, /await import\("\.\/main\.js"\)/u);
  assert.ok(source.indexOf("initializeDesktopQaLaunchProfile({") < source.indexOf('await import("./main.js")'));
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(metadata.main, "./dist/main/entry.js");
});

test("package metadata reader accepts its selected package and rejects missing, malformed or oversized metadata", t => {
  const f = fixture(t), path = join(f.parent, "package.json");
  writeFileSync(path, JSON.stringify(packageMetadata));
  assert.deepEqual(readDesktopLaunchPackageMetadata(f.parent), packageMetadata);
  for (const text of ["{", " ".repeat(131073)]) {
    writeFileSync(path, text);
    assert.throws(() => readDesktopLaunchPackageMetadata(f.parent), /desktop_qa_package_metadata_invalid/u);
  }
  rmSync(path);
  assert.throws(() => readDesktopLaunchPackageMetadata(f.parent), /desktop_qa_package_metadata_invalid/u);
});

test("verified owned QA skips the browser installer while keeping the real OS HOME", async t => {
  const qa = await import("../dist/main/qa-launch-profile.js?registration=qa");
  const f = fixture(t);
  qa.initializeDesktopQaLaunchProfile(f.options);
  let calls = 0;
  const manifest = join(f.parent, "must-not-register.json");
  const result = await qa.installDesktopBrowserHostForLaunch({ hostPath: "/owned-qa/ling-browser-host",
    installBrowserHost: async () => { calls++; writeFileSync(manifest, "unexpected"); } });
  assert.equal(result, "skipped_owned_qa");
  assert.equal(calls, 0);
  assert.equal(existsSync(manifest), false);
  assert.equal(f.environment.HOME, "/actual-os-home");
});

test("normal launch still calls the original browser installer with its original host path", async t => {
  const qa = await import("../dist/main/qa-launch-profile.js?registration=normal");
  const f = fixture(t);
  f.environment.LING_DESKTOP_OWNED_QA_PROFILE = f.profile;
  qa.initializeDesktopQaLaunchProfile({ ...f.options, argv: ["electron"], packageMetadata: { name: "ordinary" } });
  const calls = [];
  const manifest = join(f.parent, "normal-registration.json");
  const result = await qa.installDesktopBrowserHostForLaunch({ hostPath: "/ordinary/ling-browser-host",
    installBrowserHost: async input => { calls.push(input); writeFileSync(manifest, JSON.stringify(input)); } });
  assert.equal(result, "registered");
  assert.deepEqual(calls, [{ hostPath: "/ordinary/ling-browser-host" }]);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), calls[0]);
});

test("Main routes startup browser registration through the verified QA policy", () => {
  const source = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.ok(/await installDesktopBrowserHostForLaunch\(\{\s*hostPath: resources\.browserHostPath,\s*installBrowserHost,\s*\}\)/u.test(source),
    "Main must use the QA-aware registration policy with the original installer");
  assert.doesNotMatch(source, /await installBrowserHost\(/u);
});
