import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Source identity and import-order contracts. Only the isolated history probe
// invokes an original source, with the existing physical process observer
// installed before imports; it starts no actual OS producer. No test prepares
// a native session, substitutes a source/gate, or claims kernel protection.
// Same-name factory objects are counterfeits, never successful source coverage.
const manifestPath = "runtime/sandbox/protected-host-original-entry-manifest.js";
const inventoryPath = "runtime/sandbox/protected-host-actor-inventory.js";
const supervisorPath = "runtime/supervisor.js";
const distUrl = path => new URL(`../dist/${path}`, import.meta.url).href;
const slots = Object.freeze([
  ["macos_native_command", "runtime/sandbox/macos-native-command.js", "MACOS_NATIVE_COMMAND_ACTOR_ENTRY"],
  ["unified_exec_raw", "features/runs/unified-exec-raw-source.js", "UNIFIED_EXEC_RAW_ACTOR_ENTRY"],
  ["unified_exec_full_access", "features/runs/unified-exec-raw-source.js", "UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY"],
  ["native_input_capture", "runtime/sandbox/native-input-capture.js", "NATIVE_INPUT_CAPTURE_ACTOR_ENTRY"],
  ["mcp_host_stdio", "features/mcp/host-stdio-transport.js", "MCP_HOST_STDIO_ACTOR_ENTRY"],
  ["mcp_sdk_stdio", "features/mcp/stdio-launcher.js", "MCP_SDK_STDIO_ACTOR_ENTRY"],
  ["workspace_changes_git", "features/previews/workspace-changes.js", "WORKSPACE_CHANGES_GIT_ACTOR_ENTRY"],
  ["managed_worktrees_git", "features/workspaces/managed-worktrees.js", "MANAGED_WORKTREES_GIT_ACTOR_ENTRY"],
  ["action_classifier_git", "features/runs/action-classifier.js", "ACTION_CLASSIFIER_GIT_ACTOR_ENTRY"],
  ["workspace_terminal", "features/workspace-directory/terminal-runner.js", "workspaceTerminalActorEntry"],
  ["workspace_directory_picker", "features/workspace-directory/directory-picker.js", "workspaceDirectoryPickerActorEntry"],
  ["external_work_scheduler", "runtime/sandbox/core-original-process-bridge.js", "CORE_EXTERNAL_WORK_SCHEDULER_ACTOR_ENTRY"],
  ["official_skill_git", "runtime/sandbox/core-original-process-bridge.js", "CORE_OFFICIAL_SKILL_GIT_ACTOR_ENTRY"],
  ["workspace_file_launch", "features/previews/workspace-file-actions.js", "WORKSPACE_FILE_LAUNCH_ACTOR_ENTRY"],
  ["local_path_open", "shared/local-path-open.js", "LOCAL_PATH_OPEN_ACTOR_ENTRY"],
  ["workspace_file_probe", "features/previews/workspace-file-actions.js", "WORKSPACE_FILE_PROBE_ACTOR_ENTRY"],
  ["workspace_icon_probe", "features/previews/workspace-file-open-icons.js", "WORKSPACE_ICON_PROBE_ACTOR_ENTRY"],
  ["keychain_security", "features/providers/keychain-secret-store.js", "KEYCHAIN_SECURITY_ACTOR_ENTRY"],
  ["packaged_codesign", "runtime/sandbox/packaged-restricted-command-bootstrap.js", "PACKAGED_CODESIGN_ACTOR_ENTRY"],
  ["docker_probe", "runtime/sandbox/docker.js", "DOCKER_PROBE_ACTOR_ENTRY"],
  ["external_workflow_request", "runtime/sandbox/external-workflow-request-source.js", "EXTERNAL_WORKFLOW_REQUEST_ACTOR_ENTRY"],
].map(slot => Object.freeze(slot)));
const expectedIds = slots.map(([id]) => id).sort();

async function originalSet() {
  const manifest = await import(distUrl(manifestPath));
  assert.equal(typeof manifest.readOriginalProtectedHostActorEntries, "function");
  const entries = manifest.readOriginalProtectedHostActorEntries();
  assert.ok(Array.isArray(entries));
  assert.equal(entries.length, 21,
    "fixed original producer-source manifest must contain all 21 real exports, not the empty fail-closed placeholder");
  return { manifest, entries, inventory: await import(distUrl(inventoryPath)) };
}

async function newSupervisor(bootstrap) {
  const [{ RuntimeSupervisor }, { resolveConfig }] = await Promise.all([
    import(distUrl(supervisorPath)), import(distUrl("config.js")),
  ]);
  // Constructor and registry readers only: no getRuntime, Store or native artifact.
  return new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: process.cwd() }), undefined, bootstrap);
}

test("fixed manifest has exactly 21 original owner exports and exact entry identities", async () => {
  const { entries, inventory } = await originalSet();
  assert.deepEqual(Object.keys(inventory.PROTECTED_HOST_ACTOR_ENTRIES).sort(), expectedIds);
  assert.deepEqual(entries.map(entry => entry.entryId).sort(), expectedIds);
  assert.equal(new Set(entries).size, 21);
  const byId = new Map(entries.map(entry => [entry.entryId, entry]));
  for (const [id, path, exportName] of slots) {
    const owner = await import(distUrl(path)), entry = owner[exportName];
    assert.ok(entry, `${path} must export its actual ${exportName}`);
    assert.equal(byId.get(id), entry, `${id} must be the exact original owner object`);
    assert.deepEqual(inventory.readProtectedHostActorEntry(entry), {
      entryId: id, kind: inventory.PROTECTED_HOST_ACTOR_ENTRIES[id],
    });
  }
});

test("the cached original list and every captured entry are frozen data, not replaceable methods", async () => {
  const { manifest, entries } = await originalSet();
  assert.equal(manifest.readOriginalProtectedHostActorEntries(), entries);
  assert.equal(Object.isFrozen(entries), true);
  assert.throws(() => entries.push({}), TypeError);
  assert.throws(() => { entries[0] = {}; }, TypeError);
  assert.throws(() => { entries.length = 0; }, TypeError);
  assert.throws(() => Object.defineProperty(entries, "0", { value: {} }), TypeError);
  for (const entry of entries) {
    assert.equal(Object.isFrozen(entry), true);
    for (const key of ["entryId", "assertMayInvoke", "invoke"]) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      assert.ok(descriptor && Object.hasOwn(descriptor, "value"), `${entry.entryId}.${key} must be captured data`);
      assert.equal(descriptor.writable, false);
      assert.equal(descriptor.configurable, false);
    }
    assert.throws(() => { entry.invoke = () => assert.fail("must not replace an original producer"); }, TypeError);
    assert.throws(() => { entry.assertMayInvoke = () => undefined; }, TypeError);
  }
  assert.equal(manifest.readOriginalProtectedHostActorEntries(), entries);
});

test("the fixed reader exposes no caller registration and never consults caller arrays or resolvers", async () => {
  const { manifest, entries } = await originalSet();
  assert.deepEqual(Object.keys(manifest), ["readOriginalProtectedHostActorEntries"]);
  assert.equal(manifest.readOriginalProtectedHostActorEntries.length, 0);
  let reads = 0, resolverCalls = 0;
  const callerEntries = new Proxy([], {
    get() { reads++; assert.fail("fixed source must not inspect a caller list"); },
    ownKeys() { reads++; assert.fail("fixed source must not enumerate a caller list"); },
  });
  assert.equal(manifest.readOriginalProtectedHostActorEntries(callerEntries, () => { resolverCalls++; }), entries);
  assert.equal(manifest.readOriginalProtectedHostActorEntries([]), entries);
  assert.deepEqual([reads, resolverCalls], [0, 0]);
});

test("spread, prototype and Proxy entry clones cannot replace any original slot", async () => {
  const { entries, inventory } = await originalSet();
  const { ProtectedHostStageRegistry } = await import(distUrl("runtime/sandbox/protected-host-staging.js"));
  for (const entry of entries) {
    for (const clone of [Object.freeze({ ...entry }), Object.create(entry), new Proxy(entry, {})]) {
      assert.throws(() => inventory.readProtectedHostActorEntry(clone), /protected_host_actor_entry_invalid/u);
      const replaced = entries.map(value => value === entry ? clone : value);
      assert.throws(() => new ProtectedHostStageRegistry().bindOriginalActorEntries(replaced),
        /protected_host_actor_entry_invalid/u);
    }
  }
});

test("same-name factory entries cannot substitute for the fixed source manifest", async () => {
  const { entries, inventory } = await originalSet();
  const { ProtectedHostStageRegistry } = await import(distUrl("runtime/sandbox/protected-host-staging.js"));
  const replacements = entries.map(entry => inventory.defineProtectedHostActorEntry(entry.entryId,
    () => assert.fail("counterfeit producer must never be invoked")));
  assert.deepEqual(replacements.map(entry => entry.entryId).sort(), expectedIds);
  for (const replacement of replacements) assert.equal(entries.includes(replacement), false);
  const registry = new ProtectedHostStageRegistry();
  registry.bindOriginalActorEntries(replacements);
  assert.throws(() => registry.assertActorInventoryCurrent(), /protected_host_actor_entry_unbound/u);
  const actual = new inventory.ProtectedHostActorInventory();
  actual.bindOriginalEntries(entries, new ProtectedHostStageRegistry());
  assert.doesNotThrow(() => actual.assertOriginalSourceManifest(entries));
  for (const replacement of replacements) {
    assert.throws(() => actual.assertOriginal(replacement), /protected_host_actor_entry_unbound/u);
  }
});

test("the exact fixed list binds an original Registry once without a stage or producer invocation", async () => {
  const { entries } = await originalSet();
  const { ProtectedHostStageRegistry } = await import(distUrl("runtime/sandbox/protected-host-staging.js"));
  const registry = new ProtectedHostStageRegistry();
  registry.bindOriginalActorEntries(entries);
  assert.doesNotThrow(() => registry.assertActorInventoryCurrent());
  assert.throws(() => registry.bindOriginalActorEntries(entries), /protected_host_actor_inventory_already_bound/u);
});

test("default Supervisor enrollment uses the fixed list when bootstrap or actorEntries is absent", async t => {
  const { entries } = await originalSet();
  for (const bootstrap of [undefined, {}]) {
    const supervisor = await newSupervisor(bootstrap);
    t.after(() => supervisor.releaseAll());
    const registry = supervisor.getProtectedHostStageRegistry();
    assert.doesNotThrow(() => registry.assertActorInventoryCurrent());
    assert.throws(() => registry.bindOriginalActorEntries(entries), /protected_host_actor_inventory_already_bound/u);
  }
});

test("multiple default Supervisors retain separate registries and the same original source identities", async t => {
  const { manifest, entries } = await originalSet();
  const supervisors = [];
  t.after(() => { for (const supervisor of supervisors) supervisor.releaseAll(); });
  supervisors.push(await newSupervisor());
  supervisors.push(await newSupervisor());
  const [firstRegistry, secondRegistry] = supervisors.map(supervisor => supervisor.getProtectedHostStageRegistry());
  assert.notEqual(firstRegistry, secondRegistry);
  assert.doesNotThrow(() => firstRegistry.assertActorInventoryCurrent());
  assert.doesNotThrow(() => secondRegistry.assertActorInventoryCurrent());
  supervisors[0].releaseAll();
  assert.doesNotThrow(() => secondRegistry.assertActorInventoryCurrent());
  supervisors.push(await newSupervisor());
  const thirdRegistry = supervisors[2].getProtectedHostStageRegistry();
  assert.notEqual(thirdRegistry, firstRegistry);
  assert.notEqual(thirdRegistry, secondRegistry);
  assert.doesNotThrow(() => thirdRegistry.assertActorInventoryCurrent());
  assert.equal(manifest.readOriginalProtectedHostActorEntries(), entries);
  for (const [id, path, exportName] of slots) {
    assert.equal(entries.find(entry => entry.entryId === id), (await import(distUrl(path)))[exportName]);
  }
  const core = await import("@ling-stack/core");
  for (const entry of [core.CORE_OFFICIAL_SKILL_GIT_ENTRY, core.CORE_EXTERNAL_WORK_SCHEDULER_ENTRY]) {
    const facts = core.readCoreOriginalProcessEntry(entry);
    assert.equal(facts.guardBound, true);
    assert.equal(facts.enteredBeforeBinding, false);
    assert.equal(facts.nativeEntryEntered, false);
  }
});

test("an explicit full same-name Supervisor fixture is not silently upgraded to genuine source enrollment", async t => {
  const { entries, inventory } = await originalSet();
  const actorEntries = Object.freeze(entries.map(entry => inventory.defineProtectedHostActorEntry(entry.entryId,
    () => assert.fail("fixture producer must never be invoked"))));
  const supervisor = await newSupervisor({ actorEntries });
  t.after(() => supervisor.releaseAll());
  assert.throws(() => supervisor.getProtectedHostStageRegistry().assertActorInventoryCurrent(),
    /protected_host_actor_entry_unbound/u);
});

test("an explicit empty Supervisor fixture remains incomplete instead of receiving the default list", async t => {
  await originalSet();
  const supervisor = await newSupervisor({ actorEntries: Object.freeze([]) });
  t.after(() => supervisor.releaseAll());
  assert.throws(() => supervisor.getProtectedHostStageRegistry().assertActorInventoryCurrent(),
    /protected_host_actor_inventory_incomplete/u);
});

// Run source history in its own process: a real controlled entry's entered
// history is permanent, so this must not contaminate import-only assertions.
const historyProbe = `
import assert from "node:assert/strict";
import test from "node:test";
const [fixtureUrl, dockerUrl, manifestUrl, supervisorUrl, configUrl, serializedSlots] = process.argv.slice(1);
await test("controlled producer history cannot be cleared by later default enrollment", async t => {
  const { observeGitSourceProcesses } = await import(fixtureUrl);
  const observer = observeGitSourceProcesses(t);
  observer.setAsyncHandler(() => "observed-only\\n");
  // Install the physical observer first, then use the actual default source.
  // No commandRunner is supplied, and no actor/source/gate is mocked.
  const docker = await import(dockerUrl);
  const check = await docker.checkDockerSandboxBackend({
    workspaceRoot: process.cwd(), config: { enabled: true, image: "manifest-history:observed" },
  });
  assert.deepEqual(check.diagnostics, []);
  const expectedCalls = [
    ["execFile", "docker", ["info", "--format", "{{json .ServerVersion}}"]],
    ["execFile", "docker", ["image", "inspect", "manifest-history:observed", "--format", "{{.Id}}"]],
  ];
  const observedCalls = () => observer.calls.map(({ kind, command, args }) => [kind, command, args]);
  assert.deepEqual(observedCalls(), expectedCalls);
  const manifest = await import(manifestUrl);
  const entries = manifest.readOriginalProtectedHostActorEntries();
  const slots = JSON.parse(serializedSlots);
  assert.equal(entries.length, 21);
  assert.equal(Object.isFrozen(entries), true);
  assert.equal(entries.find(entry => entry.entryId === "docker_probe"), docker.DOCKER_PROBE_ACTOR_ENTRY);
  const { RuntimeSupervisor } = await import(supervisorUrl);
  const { resolveConfig } = await import(configUrl);
  const supervisors = [];
  t.after(() => { for (const supervisor of supervisors) supervisor.releaseAll(); });
  const enroll = () => {
    const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: process.cwd() }));
    supervisors.push(supervisor);
    return supervisor.getProtectedHostStageRegistry();
  };
  const firstRegistry = enroll(), secondRegistry = enroll();
  assert.notEqual(firstRegistry, secondRegistry);
  for (const registry of [firstRegistry, secondRegistry]) {
    assert.throws(() => registry.assertActorInventoryCurrent(),
      { message: "protected_host_actor_coverage_unknown" });
  }
  for (const supervisor of supervisors) supervisor.releaseAll();
  const thirdRegistry = enroll();
  assert.notEqual(thirdRegistry, firstRegistry);
  assert.notEqual(thirdRegistry, secondRegistry);
  assert.throws(() => thirdRegistry.assertActorInventoryCurrent(),
    { message: "protected_host_actor_coverage_unknown" });
  assert.equal(manifest.readOriginalProtectedHostActorEntries(), entries);
  for (const [id, ownerUrl, exportName] of slots) {
    assert.equal(entries.find(entry => entry.entryId === id), (await import(ownerUrl))[exportName]);
  }
  assert.deepEqual(observedCalls(), expectedCalls, "enrollment and retirement must not enter another producer");
  console.log("manifest_history_probe_pass");
});
`;

test("controlled producer before enrollment keeps all later Supervisor inventories coverage-unknown in isolation", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", historyProbe,
    new URL("./support/protected-host-git-source-hooks-fixture.mjs", import.meta.url).href,
    distUrl("runtime/sandbox/docker.js"), distUrl(manifestPath), distUrl(supervisorPath), distUrl("config.js"),
    JSON.stringify(slots.map(([id, path, exportName]) => [id, distUrl(path), exportName]))], {
    cwd: new URL("..", import.meta.url), env, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  const diagnostics = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.error, undefined, diagnostics);
  assert.equal(result.signal, null, diagnostics);
  assert.equal(result.status, 0, diagnostics);
  assert.match(result.stdout, /manifest_history_probe_pass/u, diagnostics);
});

// Each process starts with a different real module and a cold module cache.
// The first reader receives poisonous caller data before its cache is created,
// so this also checks that first initialization is fixed, not caller-selected.
const importProbe = `
import assert from "node:assert/strict";
const [firstUrl, manifestUrl, inventoryUrl, serializedSlots, supervisorUrl, configUrl] = process.argv.slice(1);
const slots = JSON.parse(serializedSlots);
const first = await import(firstUrl);
const manifest = await import(manifestUrl);
const caller = new Proxy([], { get() { assert.fail("first reader consulted caller data"); } });
const entries = manifest.readOriginalProtectedHostActorEntries(caller, () => assert.fail("caller resolver ran"));
assert.equal(entries.length, 21, "fresh first read must contain the 21 real producer exports");
assert.equal(Object.isFrozen(entries), true);
assert.equal(new Set(entries).size, 21);
assert.deepEqual(entries.map(entry => entry.entryId).sort(), slots.map(([id]) => id).sort());
assert.equal(manifest.readOriginalProtectedHostActorEntries(), entries);
const inventory = await import(inventoryUrl);
for (const [id, ownerUrl, exportName] of slots) {
  const owner = await import(ownerUrl);
  const entry = entries.find(value => value.entryId === id);
  assert.equal(entry, owner[exportName], id + " must retain exact source identity across import order");
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(inventory.readProtectedHostActorEntry(entry).entryId, id);
}
assert.equal(await import(firstUrl), first, "canonical re-import must reuse its original module");
const core = await import("@ling-stack/core");
for (const entry of [core.CORE_OFFICIAL_SKILL_GIT_ENTRY, core.CORE_EXTERNAL_WORK_SCHEDULER_ENTRY]) {
  const facts = core.readCoreOriginalProcessEntry(entry);
  assert.equal(facts.guardBound, true);
  assert.equal(facts.enteredBeforeBinding, false);
  assert.equal(facts.nativeEntryEntered, false, "import checks must not invoke native Core producers");
}
const { RuntimeSupervisor } = await import(supervisorUrl);
const { resolveConfig } = await import(configUrl);
const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: process.cwd() }));
try { supervisor.getProtectedHostStageRegistry().assertActorInventoryCurrent(); }
finally { supervisor.releaseAll(); }
console.log("manifest_import_probe_pass");
`;

const firstImports = [
  "runtime/sandbox/macos-native-command.js",
  "runtime/sandbox/protected-host-staging.js",
  "runtime/sandbox/restricted-command-runtime.js",
  "features/office-documents/office-local-native-runtime.js",
  "features/office-documents/office-local-directory-core-authority.js",
  supervisorPath,
  manifestPath,
  "runtime/sandbox/core-original-process-bridge.js",
  "runtime/sandbox/packaged-restricted-command-bootstrap.js",
  "features/runs/unified-exec-raw-source.js",
  "features/mcp/host-stdio-transport.js",
  "features/previews/workspace-file-actions.js",
  "features/providers/keychain-secret-store.js",
  "runtime/sandbox/docker.js",
  "runtime/sandbox/external-workflow-request-source.js",
];

for (const firstImport of firstImports) {
  test(`cold import from ${firstImport} reads the fixed list without TDZ or Core guard rebinding`, () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", importProbe,
      distUrl(firstImport), distUrl(manifestPath), distUrl(inventoryPath),
      JSON.stringify(slots.map(([id, path, exportName]) => [id, distUrl(path), exportName])),
      distUrl(supervisorPath), distUrl("config.js")], {
      cwd: new URL("..", import.meta.url), env, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    const diagnostics = `${firstImport}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.error, undefined, diagnostics);
    assert.equal(result.signal, null, diagnostics);
    assert.equal(result.status, 0, diagnostics);
    assert.equal(result.stdout, "manifest_import_probe_pass\n", diagnostics);
  });
}
