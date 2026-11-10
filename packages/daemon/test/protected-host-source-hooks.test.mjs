import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSourceHookFixture, loadSourceHookModule, observeSourceSpawns } from "./support/protected-host-source-hooks-fixture.mjs";

const macos = await loadSourceHookModule("runtime/sandbox/macos-native-command.js");
const input = await loadSourceHookModule("runtime/sandbox/native-input-capture.js");
const host = await loadSourceHookModule("features/mcp/host-stdio-transport.js");
const sdk = await loadSourceHookModule("features/mcp/stdio-launcher.js");
const { readProtectedHostActorEntry } = await loadSourceHookModule("runtime/sandbox/protected-host-actor-inventory.js");
const { AttemptHostOperationTracker } = await loadSourceHookModule("runtime/attempt-host-operation-tracker.js");
const { reserveHostMcpOperation } = await loadSourceHookModule("features/mcp/host-operation.js");
const entries = [macos.MACOS_NATIVE_COMMAND_ACTOR_ENTRY, input.NATIVE_INPUT_CAPTURE_ACTOR_ENTRY,
  host.MCP_HOST_STDIO_ACTOR_ENTRY, sdk.MCP_SDK_STDIO_ACTOR_ENTRY];
const launch = { command: process.execPath, args: ["-e", "process.exit(0)"], env: {} };

// These tests exercise real source-owned wrappers with an observed, non-OS spawn.
// They do not certify a new profile, SDK artifact, native helper, or descendants.
test("four original source wrappers enforce the captured stage gate at physical launch",
  { skip: process.platform !== "darwin" }, async t => {
    const f = await createSourceHookFixture(t), observed = observeSourceSpawns(t), stage = f.register();
    f.registry.bindOriginalActorEntries(entries);
    const createHostTransport = callId => {
      const tracker = new AttemptHostOperationTracker({ store: f.store, source: { runId: f.run.id, ...f.sourceFence } });
      const operation = reserveHostMcpOperation(tracker, callId);
      return { operation, transport: host.createHostMcpStdioTransport({ launch, operation }) };
    };

    await t.test("the exact original certified actor reaches the one original native spawn", () => {
      const before = observed.calls.length, original = f.prepared();
      const actor = f.registry.bindPreparedActor(original.source, original.prepared);
      f.registry.beginActorLaunch(actor);
      const child = original.prepared.spawn(() => {}, actor);
      f.registry.recordActorLaunched(actor, child);
      assert.equal(observed.calls.length, before + 1);
      assert.equal(observed.calls.at(-1)[0], "/usr/bin/sandbox-exec");
      assert.equal(macos.isOwnedMacosSandboxChild(child, original.prepared), true);
    });

    await t.test("a genuine actor cannot be borrowed by a different original prepared command", () => {
      const before = observed.calls.length, owner = f.prepared(), other = f.prepared();
      const actor = f.registry.bindPreparedActor(owner.source, owner.prepared);
      assert.throws(() => other.prepared.spawn(() => {}, actor), /actor_prepared_binding_invalid/u);
      assert.equal(observed.calls.length, before);
    });

    await t.test("cloned prepared receivers, flags and manufactured launch records cannot grant native entry", () => {
      const before = observed.calls.length, original = f.prepared();
      const actor = f.registry.bindPreparedActor(original.source, original.prepared);
      let authorityChecks = 0, callerReads = 0;
      const assertAuthority = () => { authorityChecks++; };
      for (const receiver of [{ ...original.prepared }, Object.create(original.prepared), new Proxy(original.prepared, {
        get() { callerReads++; throw new Error("caller_prepared_read"); },
      })]) {
        assert.throws(() => Reflect.apply(original.prepared.spawn, receiver, [assertAuthority, actor]),
          { code: "macos_prepared_capability_invalid" });
        assert.equal(authorityChecks, 0, "a copied receiver cannot enter the original authority callback");
        assert.equal(callerReads, 0); assert.equal(observed.calls.length, before);
      }
      assert.throws(() => macos.MACOS_NATIVE_COMMAND_ACTOR_ENTRY.invoke(actor,
        { prepared: original.prepared, actor, command: "/usr/bin/sandbox-exec", policyVerified: true }),
        { code: "macos_native_launch_record_invalid" });
      assert.equal(observed.calls.length, before);
      for (const copyActor of [() => ({ policyVerified: true }), value => ({ ...value }), value => new Proxy(value, {
        get() { callerReads++; throw new Error("caller_actor_read"); },
      })]) {
        const owner = f.prepared(), owningActor = f.registry.bindPreparedActor(owner.source, owner.prepared);
        const checkedBefore = authorityChecks;
        assert.throws(() => owner.prepared.spawn(assertAuthority, copyActor(owningActor)),
          { message: "protected_host_actor_prepared_binding_invalid" });
        assert.equal(authorityChecks, checkedBefore + 1);
        assert.equal(callerReads, 0); assert.equal(observed.calls.length, before);
        // Source-owned preparation was consumed before the binding refusal; a
        // later genuine actor cannot replay that rejected physical launch.
        assert.throws(() => owner.prepared.spawn(assertAuthority, owningActor), { code: "macos_launch_already_consumed" });
        assert.equal(authorityChecks, checkedBefore + 1); assert.equal(observed.calls.length, before);
      }
    });

    await t.test("undefined macos actor is rejected at the source wrapper despite a caller authority callback", () => {
      const before = observed.calls.length, original = f.prepared();
      let checked = false;
      assert.throws(() => original.prepared.spawn(() => { checked = true; }), /unbound_with_active_stage/u);
      assert.equal(checked, true); assert.equal(observed.calls.length, before);
    });

    await t.test("the original input-helper producer is refused inside the effect guard before spawn", async () => {
      const before = observed.calls.length;
      let gates = 0, cleanup = 0;
      await assert.rejects(input.captureNativeCommandInput({ ...f.input, registry: { assertActorEntryLaunchCurrent() {} },
        effectGuard: { launch(effect) { gates++; return effect(); }, cleanup() { cleanup++; } } }), /unbound_with_active_stage/u);
      assert.equal(gates, 1); assert.equal(cleanup, 0); assert.equal(observed.calls.length, before);
      assert.throws(() => input.NATIVE_INPUT_CAPTURE_ACTOR_ENTRY.invoke({ policyVerified: true }, f.input.helper.path), /entry_proof_invalid/u);
    });

    await t.test("tracked Host MCP starts through the original physical connection entry", async () => {
      const before = observed.calls.length, original = createHostTransport("source-host-denied");
      try { await assert.rejects(original.transport.start(), /unbound_with_active_stage/u); }
      finally { await original.transport.close(); original.operation.finish(); }
      assert.equal(original.transport.getCloseObservation().settledBy, "not_started");
      assert.equal(observed.calls.length, before);
      assert.throws(() => host.MCP_HOST_STDIO_ACTOR_ENTRY.invoke({ sandboxVerified: true }, launch), /entry_proof_invalid/u);
    });

    await t.test("SDK construction is inert; direct start and metadata Client.connect use the same deferred gate", async () => {
      const before = observed.calls.length, launcher = sdk.createDefaultMcpProcessLauncher();
      const transport = launcher.createStdioTransport(launch), metadata = launcher.createStdioTransport(launch);
      assert.equal(observed.calls.length, before);
      await assert.rejects(transport.start(), /unbound_with_active_stage/u);
      const client = new Client({ name: "source-metadata", version: "1" });
      try { await assert.rejects(client.connect(metadata), /unbound_with_active_stage/u); }
      finally { await client.close(); await transport.close(); }
      assert.equal(observed.calls.length, before);
      // The private SDK object is not returned, so its base start cannot spawn through this facade.
      await assert.rejects(Reflect.apply(StdioClientTransport.prototype.start, transport, []));
      assert.equal(observed.calls.length, before);
      assert.throws(() => sdk.MCP_SDK_STDIO_ACTOR_ENTRY.invoke({ coreSafe: true }, transport), /entry_proof_invalid/u);
    });

    await t.test("stage-free input/Host/SDK preserve original launches but even complete leader/pipe close retains unknown", async () => {
      f.registry.closeStage(stage);
      const before = observed.calls.length;
      const captured = await input.captureNativeCommandInput(f.input);
      assert.equal(captured.bytes.toString(), "abc");
      const original = createHostTransport("source-host-ordinary");
      try { await original.transport.start(); await original.transport.close(); }
      finally { original.operation.finish(); }
      assert.equal(original.transport.getCloseObservation().stdioClosed, true);
      assert.equal(original.transport.getCloseObservation().descendants, "unverified");
      const args = [...launch.args], env = { FIXTURE: "original" };
      const transport = sdk.createDefaultMcpProcessLauncher().createStdioTransport({ ...launch, args, env });
      args[0] = "changed"; env.FIXTURE = "changed";
      const replacement = t.mock.method(StdioClientTransport.prototype, "start", () => { assert.fail("replaced SDK start must not be selected"); });
      try { await transport.start(); await transport.close(); }
      finally { replacement.mock.restore(); }
      assert.deepEqual(observed.calls.at(-1)[1], launch.args);
      assert.equal(observed.calls.at(-1)[2].env.FIXTURE, "original");
      assert.equal(observed.calls.length, before + 3);
      assert.throws(() => f.register(), /coverage_unknown/u);
      await assert.rejects(Reflect.apply(transport.start, { ...transport, coreSafe: true }, []), /original_transport_invalid/u);
    });
    assert.throws(() => f.registry.assertActorInventoryCurrent(), /inventory_incomplete/u);
  });

test("the four installed exports are original immutable entries, not cloned manifests", () => {
  assert.deepEqual(entries.map(entry => readProtectedHostActorEntry(entry).entryId),
    ["macos_native_command", "native_input_capture", "mcp_host_stdio", "mcp_sdk_stdio"]);
  for (const entry of entries) {
    assert.equal(Object.isFrozen(entry), true);
    assert.throws(() => readProtectedHostActorEntry({ ...entry }), /entry_invalid/u);
    assert.throws(() => { entry.invoke = () => undefined; }, TypeError);
    assert.equal(Object.hasOwn(entry, "registry"), false);
  }
});
