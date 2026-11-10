import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { createCodesignHostSimulation, errno, SIMULATED_HELPER } from "./support/packaged-codesign-host-simulation-fixture.mjs";

// Sequential virtual mechanism observations only. No child, sandbox, signature,
// OS source trust, actual cold Host or protection certificate is established.
test("fixed native codesign source correlation and failure axes, never protection certification", async t => {
  const setup = async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource();
    const owned = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(owned);
    return { f, api, owned, record, entry: api.readOriginalPackagedCodesignActorEntry() };
  };
  const cleanup = ({ f, api, owned }) => { api.closeOriginalPackagedCodesignIdentity(owned); assert.deepEqual(f.originalFiles(), []); };

  await t.test("actual runtime helper hash differs from unsigned evidence without pretending either hash is trust", async t => {
    const x = await setup(t), { f, api, owned } = x, facts = api.readOriginalPackagedCodesignSource(owned);
    assert.equal(facts.helperPath, SIMULATED_HELPER); assert.equal(facts.protection, "candidate_unverified");
    assert.equal(facts.helperSha256, crypto.createHash("sha256").update(f.helper.bytes).digest("hex"));
    assert.notEqual(facts.helperSha256, facts.buildEvidence.unsignedBinarySha256);
    assert.equal(facts.osSource.binding, "reviewed_xml_v1"); assert.equal(facts.registryEpoch, null);
    assert.equal(Object.isFrozen(facts.buildEvidence.sourceSha256), true);
    assert.equal(api.readOriginalPackagedCodesignExecutionObservation(owned), undefined); cleanup(x);
  });

  await t.test("only one fixed request pipe, original PID and immutable tuple enter the physical observer", async t => {
    const x = await setup(t), { f, api, owned, record, entry } = x;
    f.hooks.native = call => {
      assert.equal(call.command, SIMULATED_HELPER); assert.deepEqual(call.args, ["--verify-packaged-codesign"]);
      assert.deepEqual(Object.keys(call.options.env), ["PATH", "LANG", "HOME", "TMPDIR", "PWD"]);
      assert.equal(call.options.env.HOME, "/"); assert.equal(call.options.timeout, 35000);
      assert.equal(call.options.killSignal, "SIGKILL"); assert.equal(call.options.maxBuffer, 262148);
      assert.equal(call.options.stdio, "pipe"); assert.equal(call.options.cwd, "/");
      const request = JSON.parse(call.options.input.subarray(4).toString("utf8"));
      assert.equal(request.parentPid, process.pid); assert.match(request.nonce, /^[a-f0-9]{64}$/u);
      assert.deepEqual(Object.keys(request), ["protocolVersion", "operation", "requestId", "nonce", "expectedHelperVersion",
        "parentPid", "hostProcessEpoch", "appBundlePath", "appDevice", "appInode"]);
      return f.completed(call, { stdoutHex: Buffer.from("inner command output").toString("hex") });
    };
    const result = entry.invoke(undefined, record);
    assert.equal(result.status, 0); assert.equal(result.pid, 987655); assert.equal(result.stdout, "inner command output");
    const receipt = api.readOriginalPackagedCodesignExecutionObservation(owned);
    assert.equal(receipt.helperPid, 987654); assert.equal(receipt.helperStatus, 0);
    assert.equal(receipt.helperWait, "direct_wait_observed"); assert.equal(receipt.protocol, "valid_completed");
    assert.equal(receipt.descendantDrain, "not_verified"); assert.equal(receipt.protection, "candidate_unverified");
    assert.equal(receipt.innerCommand.specialSlotEvidence, "reviewed_xnu_no_parent_copy_not_runtime_observed_v1");
    assert.equal(receipt.innerCommand.enforcementReady, false); assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.innerCommand.reviewedNonInheritedSpecialSlots), true);
    assert.throws(() => entry.invoke(undefined, record), /record_invalid/u); assert.equal(f.nativeCalls.length, 1);
    cleanup(x); assert.equal(api.readOriginalPackagedCodesignExecutionObservation(owned), receipt);
  });

  await t.test("helper success is not inner command success", async t => {
    const x = await setup(t); x.f.hooks.native = call => x.f.completed(call, { exitCode: 7,
      stderrHex: Buffer.from("signature verification rejected").toString("hex") });
    const result = x.entry.invoke(undefined, x.record), receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
    assert.equal(receipt.helperStatus, 0); assert.equal(receipt.protocol, "valid_completed");
    assert.equal(result.status, 7); assert.equal(result.stderr, "signature verification rejected"); cleanup(x);
  });

  for (const code of ["codesign_cleanup_unknown", "codesign_wait_failed", "codesign_mach_preflight_failed", "codesign_timeout"]) {
    await t.test("typed native " + code + " is diagnostic, never no-start or cleanup success", async t => {
      const x = await setup(t); x.f.hooks.native = () => {
        const body = Buffer.from(JSON.stringify({ type: "error", protocolVersion: 1, code, enforcementReady: false }));
        const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
        const stdout = Buffer.concat([header, body]), stderr = Buffer.alloc(0);
        return { pid: 987654, status: 2, signal: null, stdout, stderr, output: [null, stdout, stderr] };
      };
      const result = x.entry.invoke(undefined, x.record), receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
      assert.equal(result.error.code, code); assert.equal(result.status, 2);
      assert.equal(receipt.protocol, "valid_error"); assert.equal(receipt.nativeFailure.code, code);
      assert.equal(receipt.innerCommand, null); assert.equal(receipt.helperWait, "direct_wait_observed");
      assert.equal(receipt.deadline, "not_reported", "inner timeout is separate from the outer Node timeout");
      assert.equal(receipt.descendantDrain, "not_verified"); cleanup(x);
    });
  }

  for (const corruption of ["unknown_code", "authority", "wrong_version", "extra_authority", "duplicate",
    "trailing", "truncated", "invalid_utf8", "stderr"]) {
    await t.test("typed error " + corruption + " cannot become a native failure or command receipt", async t => {
      const x = await setup(t);
      x.f.hooks.native = () => {
        const value = { type: "error", protocolVersion: 1, code: "codesign_cleanup_unknown", enforcementReady: false };
        if (corruption === "unknown_code") value.code = "caller_invented_success";
        if (corruption === "authority") value.enforcementReady = true;
        if (corruption === "wrong_version") value.protocolVersion = 2;
        if (corruption === "extra_authority") value.certified = true;
        const text = JSON.stringify(value);
        const body = corruption === "invalid_utf8" ? Buffer.from([0xff])
          : Buffer.from(corruption === "duplicate" ? text.replace("{", '{"type":"error",') : text);
        const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
        let stdout = Buffer.concat([header, body]);
        if (corruption === "trailing") stdout = Buffer.concat([stdout, Buffer.from("x")]);
        if (corruption === "truncated") stdout = stdout.subarray(0, -1);
        const stderr = corruption === "stderr" ? Buffer.from("unexpected helper stderr") : Buffer.alloc(0);
        return { pid: 987654, status: 2, signal: null, stdout, stderr, output: [null, stdout, stderr] };
      };
      const result = x.entry.invoke(undefined, x.record), receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
      assert.equal(result.status, 2); assert.equal(receipt.helperWait, "direct_wait_observed");
      if (corruption === "stderr") {
        assert.equal(result.error, undefined); assert.equal(receipt.protocol, "helper_failed");
      } else {
        assert.match(result.error.message, /native_protocol_invalid/u); assert.equal(receipt.protocol, "invalid");
      }
      assert.equal(receipt.nativeFailure, null); assert.equal(receipt.innerCommand, null);
      assert.equal(receipt.descendantDrain, "not_verified"); assert.equal(receipt.protection, "candidate_unverified");
      assert.equal(receipt.deadline, "not_reported"); assert.equal(receipt.killRequest, "not_observed");
      assert.equal(x.f.nativeCalls.length, 1);
      assert.throws(() => x.entry.invoke(undefined, x.record), /record_invalid/u);
      assert.equal(x.f.nativeCalls.length, 1); cleanup(x);
    });
  }

  await t.test("a valid typed error without an observed helper PID stays unknown, not valid_error or no-start", async t => {
    const x = await setup(t);
    x.f.hooks.native = () => {
      const body = Buffer.from(JSON.stringify({ type: "error", protocolVersion: 1,
        code: "codesign_cleanup_unknown", enforcementReady: false }));
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
      const stdout = Buffer.concat([header, body]), stderr = Buffer.alloc(0);
      return { pid: 0, status: 2, signal: null, stdout, stderr, output: [null, stdout, stderr] };
    };
    const result = x.entry.invoke(undefined, x.record), receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
    assert.equal(result.status, 2); assert.equal(result.error, undefined); assert.equal(receipt.helperPid, null);
    assert.equal(receipt.helperWait, "unknown"); assert.equal(receipt.protocol, "helper_failed");
    assert.equal(receipt.nativeFailure, null); assert.equal(receipt.innerCommand, null);
    assert.equal(receipt.descendantDrain, "not_verified"); assert.equal(receipt.protection, "candidate_unverified");
    assert.equal(x.f.nativeCalls.length, 1); assert.throws(() => x.entry.invoke(undefined, x.record), /record_invalid/u);
    assert.equal(x.f.nativeCalls.length, 1); cleanup(x);
  });

  await t.test("exit3 partial output is a helper write failure, not an inner terminal report", async t => {
    const x = await setup(t); x.f.hooks.native = () => ({ pid: 987654, status: 3, signal: null,
      stdout: Buffer.from([0, 0, 0, 120, 123]), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] });
    const result = x.entry.invoke(undefined, x.record), receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
    assert.equal(result.status, 3); assert.equal(receipt.helperStatus, 3); assert.equal(receipt.protocol, "helper_failed");
    assert.equal(receipt.innerCommand, null); assert.equal(receipt.nativeFailure, null); cleanup(x);
  });

  await t.test("exit3 with a complete correlated frame still has no inner command receipt", async t => {
    const x = await setup(t); x.f.hooks.native = call => x.f.completed(call, {}, { status: 3 });
    const result = x.entry.invoke(undefined, x.record), receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
    assert.equal(result.status, 3); assert.equal(receipt.helperStatus, 3); assert.equal(receipt.protocol, "helper_failed");
    assert.equal(result.pid, 987654); assert.equal(receipt.innerCommand, null); assert.equal(receipt.nativeFailure, null);
    assert.equal(receipt.descendantDrain, "not_verified"); assert.equal(receipt.protection, "candidate_unverified");
    assert.equal(x.f.nativeCalls.length, 1); assert.throws(() => x.entry.invoke(undefined, x.record), /record_invalid/u);
    assert.equal(x.f.nativeCalls.length, 1); cleanup(x);
  });

  await t.test("numeric inner signal is normalized independently of helper exit", async t => {
    const x = await setup(t); x.f.hooks.native = call => x.f.completed(call, { exitCode: null, signal: 9 });
    const result = x.entry.invoke(undefined, x.record);
    assert.equal(result.status, null); assert.equal(result.signal, "SIGKILL");
    assert.equal(x.api.readOriginalPackagedCodesignExecutionObservation(x.owned).helperSignal, null); cleanup(x);
  });

  for (const [name, changes] of [
    ["foreign helper PID", { helperPid: 987650 }], ["foreign parent", { parentPid: 1 }],
    ["wrong nonce", { nonce: "f".repeat(64) }], ["wrong request", { requestId: "foreign-request" }],
    ["wrong Host epoch", { hostProcessEpoch: "foreign-host" }], ["changed App inode", { appInode: "999999" }],
    ["caller-selected profile", { profile: "(allow default)" }], ["invented enforcement", { enforcementReady: true }],
    ["invented drain", { descendantDrain: "verified" }], ["second authority field", { certified: true }],
    ["legacy false getter claims", { helperEmptySpecialSlots: [10, 11] }],
    ["wrong static evidence axis", { specialSlotEvidence: "runtime_observed" }],
    ["both terminal axes", { exitCode: 0, signal: 9 }], ["oversized output", { stdoutHex: "00".repeat(49153) }],
  ]) await t.test("reject " + name + " without replay or certificate", async t => {
    const x = await setup(t); x.f.hooks.native = call => x.f.completed(call, changes);
    const result = x.entry.invoke(undefined, x.record);
    assert.equal(result.status, null); assert.match(result.error.message, /native_protocol_invalid/u);
    const receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
    assert.equal(receipt.helperWait, "direct_wait_observed"); assert.equal(receipt.protocol, "invalid");
    assert.equal(receipt.innerCommand, null); assert.equal(receipt.descendantDrain, "not_verified");
    assert.throws(() => x.entry.invoke(undefined, x.record), /record_invalid/u); cleanup(x);
  });

  for (const corruption of ["trailing", "duplicate", "truncated", "invalid_utf8", "stderr"]) {
    await t.test("reject " + corruption + " transport after a successful helper wait", async t => {
      const x = await setup(t); x.f.hooks.native = call => {
        const result = x.f.completed(call);
        if (corruption === "stderr") result.stderr = Buffer.from("unexpected helper stderr");
        else if (corruption === "trailing") result.stdout = Buffer.concat([result.stdout, Buffer.from("x")]);
        else if (corruption === "truncated") result.stdout = result.stdout.subarray(0, -1);
        else {
          const body = corruption === "duplicate"
            ? Buffer.from(result.stdout.subarray(4).toString("utf8").replace('{', '{"type":"codesign_completed",'))
            : Buffer.from([0xff]);
          const header = Buffer.alloc(4); header.writeUInt32BE(body.length); result.stdout = Buffer.concat([header, body]);
        }
        return result;
      };
      const result = x.entry.invoke(undefined, x.record); assert.equal(result.status, null); assert.ok(result.error);
      assert.equal(x.api.readOriginalPackagedCodesignExecutionObservation(x.owned).protocol, "invalid"); cleanup(x);
    });
  }

  await t.test("timeout kill configuration does not manufacture a wait or descendant receipt", async t => {
    const x = await setup(t); x.f.hooks.native = () => ({ pid: 987654, status: null, signal: null,
      error: errno("ETIMEDOUT"), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] });
    const result = x.entry.invoke(undefined, x.record), receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
    assert.equal(result.error.code, "ETIMEDOUT"); assert.equal(receipt.deadline, "timeout_reported");
    assert.equal(receipt.helperWait, "unknown"); assert.equal(receipt.killRequest, "not_observed");
    assert.equal(receipt.descendantDrain, "not_verified"); cleanup(x);
  });

  await t.test("a timeout with an actual direct SIGKILL wait remains distinct from inner/descendant drain", async t => {
    const x = await setup(t); x.f.hooks.native = () => ({ pid: 987654, status: null, signal: "SIGKILL",
      error: errno("ETIMEDOUT"), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] });
    x.entry.invoke(undefined, x.record); const receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
    assert.equal(receipt.helperWait, "direct_wait_observed"); assert.equal(receipt.helperSignal, "SIGKILL");
    assert.equal(receipt.deadline, "timeout_reported"); assert.equal(receipt.innerCommand, null);
    assert.equal(receipt.descendantDrain, "not_verified"); cleanup(x);
  });

  for (const outerAxis of ["timeout", "signal"]) {
    await t.test("a correlated completed frame cannot override the outer " + outerAxis + " result", async t => {
      const x = await setup(t), originalError = errno("ETIMEDOUT", "original outer timeout with stale completion");
      x.f.hooks.native = call => x.f.completed(call, {},
        outerAxis === "timeout" ? { error: originalError } : { status: null, signal: "SIGKILL" });
      const result = x.entry.invoke(undefined, x.record), receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
      if (outerAxis === "timeout") {
        assert.equal(result.error, originalError); assert.equal(result.status, 0); assert.equal(result.signal, null);
        assert.equal(receipt.deadline, "timeout_reported"); assert.equal(receipt.helperErrorCode, "ETIMEDOUT");
      } else {
        assert.equal(result.error, undefined); assert.equal(result.status, null); assert.equal(result.signal, "SIGKILL");
        assert.equal(receipt.deadline, "not_reported"); assert.equal(receipt.helperErrorCode, null);
      }
      assert.equal(result.pid, 987654, "outer failure must not normalize to the claimed inner child PID");
      assert.equal(receipt.protocol, "helper_failed"); assert.equal(receipt.helperWait, "direct_wait_observed");
      assert.equal(receipt.innerCommand, null); assert.equal(receipt.nativeFailure, null);
      assert.equal(receipt.killRequest, "not_observed"); assert.equal(receipt.descendantDrain, "not_verified");
      assert.equal(receipt.protection, "candidate_unverified"); assert.equal(x.f.nativeCalls.length, 1);
      assert.throws(() => x.entry.invoke(undefined, x.record), /record_invalid/u);
      assert.equal(x.f.nativeCalls.length, 1); cleanup(x);
    });
  }

  await t.test("missing observed PID is unknown, not fictitious no-start", async t => {
    const x = await setup(t); x.f.hooks.native = () => ({ pid: 0, status: null, signal: null,
      error: errno("ENOENT"), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] });
    x.entry.invoke(undefined, x.record); const receipt = x.api.readOriginalPackagedCodesignExecutionObservation(x.owned);
    assert.equal(receipt.helperPid, null); assert.equal(receipt.helperWait, "unknown"); cleanup(x);
  });

  await t.test("post-launch identity loss refuses even a correlated success frame", async t => {
    const x = await setup(t); x.f.hooks.native = call => {
      const result = x.f.completed(call); x.f.helper.bytes = Buffer.from("changed-helper-same-size---"); return result;
    };
    assert.throws(() => x.entry.invoke(undefined, x.record), /original_file_changed/u);
    assert.equal(x.api.readOriginalPackagedCodesignExecutionObservation(x.owned).innerCommand, null);
    assert.throws(() => x.entry.invoke(undefined, x.record), /record_invalid/u); cleanup(x);
  });

  await t.test("OS service frame needs fixed original plist binding, not just the service label", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource();
    f.taskgatedPlist.bytes = Buffer.from(f.taskgatedPlist.bytes.toString().replace('<integer>9</integer>', '<integer>8</integer>'));
    const owned = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(owned);
    assert.equal(api.readOriginalPackagedCodesignSource(owned).osSource.binding, "unsupported");
    f.hooks.native = call => f.completed(call, { helperAccessService: "privileged_taskgated_v1", helperAccessObjectType: 0xffffffff });
    const result = api.readOriginalPackagedCodesignActorEntry().invoke(undefined, record);
    assert.equal(result.status, null); assert.match(result.error.message, /native_protocol_invalid/u);
    api.closeOriginalPackagedCodesignIdentity(owned); assert.deepEqual(f.originalFiles(), []);
  });

  for (const corruption of ["missing_source", "missing_joint_source", "extra_source", "duplicate", "authority", "wrong_target", "unrun_parser"]) {
    await t.test("manifest " + corruption + " rejects before native entry and closes original FDs", async t => {
      const f = await createCodesignHostSimulation(t), api = await f.loadSource();
      const manifest = JSON.parse(f.manifest.bytes.toString("utf8"));
      if (corruption === "missing_source") delete manifest.sourceSha256["src/codesign_mach.rs"];
      if (corruption === "missing_joint_source") delete manifest.sourceSha256["src/codesign_faults.rs"];
      if (corruption === "extra_source") manifest.sourceSha256["src/caller_invented.rs"] = "a".repeat(64);
      if (corruption === "authority") manifest.fixedCodesignLeaf.hostSourceAuthority = "certified";
      if (corruption === "wrong_target") manifest.target = "x86_64-apple-darwin";
      if (corruption === "unrun_parser") manifest.fixedCodesignLeaf.parserProtocol = "not_run_on_target";
      const text = JSON.stringify(manifest);
      f.manifest.bytes = Buffer.from(corruption === "duplicate" ? text.replace('{', '{"schemaVersion":1,') : text);
      assert.throws(() => api.prepareOriginalPackagedCodesignSource(), /native_protocol_invalid/u);
      assert.deepEqual(f.originalFiles(), []); assert.deepEqual(f.nativeCalls, []);
    });
  }

  t.diagnostic("These cases exercise only virtual original-source wiring, strict DTOs, FD custody and explicit unknown axes. Real signed package, native Mach controls, timeouts, default Host and macOS GUI remain Root acceptance gates.");
});
