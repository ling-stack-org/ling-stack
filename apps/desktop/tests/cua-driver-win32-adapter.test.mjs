import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DEFAULT_CUA_DRIVER_FEATURE_FLAGS } from "@ling-stack/contracts";
import * as cuaDriverPublic from "../dist/main/cua-driver/index.js";
import {
  createBoundedWin32CommandRunner,
  encodeWin32PowerShell,
  resolveWin32SystemExecutables,
  WIN32_KERNEL_SYSTEM_ROOT,
} from "../dist/main/cua-driver/adapters/win32-command.js";
import {
  createWin32CuaDriverIdentityVerifier,
} from "../dist/main/cua-driver/adapters/win32-identity.js";
import {
  createWin32CuaDriverProcessLifecycle,
  Win32CuaDriverLifecycleError,
} from "../dist/main/cua-driver/adapters/win32-lifecycle.js";
import {
  createWin32ExecutableSpawnLeaseAcquirer,
} from "../dist/main/cua-driver/adapters/win32-executable-lease.js";
import {
  createWin32CuaDriverSessionRecoveryObserver,
  Win32CuaDriverSessionObserverError,
} from "../dist/main/cua-driver/adapters/win32-session-observer.js";
import {
  createWin32CuaDriverStateRootProtector,
} from "../dist/main/cua-driver/adapters/win32-state-root.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const PROVIDER_PATH = "C:\\Ling\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\payload\\ling-cua-driver.exe";
const SEAL_PATH = "C:\\Ling\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\payload\\provider-seal.json";
const CATALOG_PATH = "C:\\Ling\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\provider-integrity.cat";
const PROVIDER_SIGNER = Object.freeze({ subject: "CN=Ling Provider", certificateSha256: SHA_D });
const CATALOG_SIGNER = Object.freeze({ subject: "CN=Ling Catalog", certificateSha256: SHA_E });

test("Win32 identity accepts each governed tier and invokes only absolute in-box PowerShell", async (t) => {
  for (const tier of ["unsigned_dev", "test_signed_internal", "production_signed"]) {
    await t.test(tier, async () => {
      const fixture = identityFixture(tier);
      let invocation;
      const verifier = createWin32CuaDriverIdentityVerifier({
        policy: fixture.policy,
        systemRoot: "C:\\Windows",
        baseEnvironment: {
          SystemRoot: "D:\\untrusted-system-root",
          WINDIR: "D:\\untrusted-system-root",
          TEMP: "C:\\Temp",
          PATH: "C:\\attacker-first",
          SECRET_TOKEN: "must-not-leak",
          LING_CUA_CANDIDATE_MANIFEST: "C:\\untrusted\\candidate.json",
        },
        commandRunner: {
          async run(value) {
            invocation = value;
            return commandResult(fixture.evidence);
          },
        },
      });

      await verifier.verify(fixture.input);
      assert.equal(
        invocation.executablePath,
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      assert.deepEqual(invocation.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
      assert.equal(invocation.args.at(-2), "-EncodedCommand");
      const script = Buffer.from(invocation.args.at(-1), "base64").toString("utf16le");
      assert.match(script, /Test-FileCatalog/u);
      assert.doesNotMatch(script, /candidate manifest/u);
      assert.equal(invocation.environment.PATH, undefined);
      assert.equal(invocation.environment.SECRET_TOKEN, undefined);
      assert.equal(invocation.environment.LING_CUA_CANDIDATE_MANIFEST, undefined);
      assert.equal(invocation.environment.SystemRoot, "C:\\Windows");
      assert.equal(invocation.environment.WINDIR, "C:\\Windows");
      assert.equal(invocation.environment.LING_CUA_PROVIDER_PATH, PROVIDER_PATH);
      assert.equal(invocation.environment.LING_CUA_CATALOG_PATH, CATALOG_PATH);
      assert.equal(
        invocation.environment.LING_CUA_REQUIRE_CATALOG,
        tier === "unsigned_dev" ? "0" : "1",
      );
    });
  }
});

test("Win32 signed identity rejects tier, signer, timestamp, catalog, member, hash and PE drift", async (t) => {
  const mutations = [
    ["tier/channel", ({ input }) => { input.seal.distributionChannel = "development"; }],
    ["seal signer", ({ input }) => { input.seal.main.signerSubject = "CN=Other"; }],
    ["provider signer", ({ evidence }) => { evidence.provider.signerSubject = "CN=Other"; }],
    ["provider certificate", ({ evidence }) => { evidence.provider.certificateSha256 = SHA_A; }],
    ["provider timestamp", ({ evidence }) => { evidence.provider.timestampStatus = "NotRequired"; }],
    ["catalog signer", ({ evidence }) => { evidence.catalog.signerSubject = "CN=Other"; }],
    ["catalog certificate", ({ evidence }) => { evidence.catalog.certificateSha256 = SHA_A; }],
    ["catalog timestamp", ({ evidence }) => { evidence.catalog.timestampStatus = "NotRequired"; }],
    ["catalog validation", ({ evidence }) => { evidence.catalog.validationStatus = "ValidationFailed"; }],
    ["catalog extra member", ({ evidence }) => { evidence.catalog.members.push({ relativePath: "payload/extra.exe", sha256: SHA_A }); }],
    ["catalog member hash", ({ evidence }) => { evidence.catalog.members[0].sha256 = SHA_B; }],
    ["PE machine", ({ evidence }) => { evidence.provider.peMachine = "0x014c"; }],
    ["PE magic", ({ evidence }) => { evidence.provider.peMagic = "0x010b"; }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const fixture = identityFixture("production_signed");
      mutate(fixture);
      const verifier = createWin32CuaDriverIdentityVerifier({
        policy: fixture.policy,
        systemRoot: "C:\\Windows",
        commandRunner: { async run() { return commandResult(fixture.evidence); } },
      });
      await assert.rejects(
        verifier.verify(fixture.input),
        (error) => error?.failureKind === "invalid",
      );
    });
  }
});

test("missing, blocked, rejected, overflowing or malformed PowerShell evidence is unavailable", async (t) => {
  const fixture = identityFixture("unsigned_dev");
  const failures = [
    ["runner rejection", async () => { throw new Error("blocked"); }],
    ["missing result", async () => undefined],
    ["spawn blocked", async () => commandResult("", { spawnFailed: true })],
    ["timeout", async () => commandResult("", { timedOut: true })],
    ["stdout overflow", async () => commandResult("", { stdoutOverflow: true })],
    ["stderr overflow", async () => commandResult("", { stderrOverflow: true })],
    ["nonzero exit", async () => commandResult("", { exitCode: 1 })],
    ["signal", async () => commandResult("", { signal: "SIGTERM" })],
    ["malformed JSON", async () => commandResult("not-json")],
    ["explicit unavailable", async () => commandResult({ schemaVersion: 1, verdict: "unavailable" })],
  ];
  for (const [name, run] of failures) {
    await t.test(name, async () => {
      const verifier = createWin32CuaDriverIdentityVerifier({
        policy: fixture.policy,
        systemRoot: "C:\\Windows",
        commandRunner: { run },
      });
      await assert.rejects(
        verifier.verify(fixture.input),
        (error) => error?.failureKind === "unavailable",
      );
    });
  }
});

test("Win32 identity never derives its trusted system root from the process environment", async () => {
  const fixture = identityFixture("unsigned_dev");
  let commandCount = 0;
  const verifier = createWin32CuaDriverIdentityVerifier({
    policy: fixture.policy,
    baseEnvironment: {
      SystemRoot: "C:\\attacker",
      WINDIR: "C:\\attacker",
    },
    commandRunner: {
      async run() {
        commandCount += 1;
        return commandResult(fixture.evidence);
      },
    },
  });

  await assert.rejects(
    verifier.verify(fixture.input),
    (error) => error?.failureKind === "unavailable",
  );
  assert.equal(commandCount, 0);
});

test("Win32 verifier rejects malformed compile-time policies and unsigned signer claims", async () => {
  const production = identityFixture("production_signed");
  assert.throws(
    () => createWin32CuaDriverIdentityVerifier({
      policy: { ...production.policy, catalogTimestampStatus: "NotRequired" },
      systemRoot: "C:\\Windows",
    }),
    /win32_cua_driver_signing_policy_invalid/u,
  );
  assert.throws(
    () => createWin32CuaDriverIdentityVerifier({
      policy: { ...production.policy, providerSigner: undefined },
      systemRoot: "C:\\Windows",
    }),
    /win32_cua_driver_signing_policy_invalid/u,
  );

  const unsigned = identityFixture("unsigned_dev");
  unsigned.input.seal.main.signerSubject = "";
  const verifier = createWin32CuaDriverIdentityVerifier({
    policy: unsigned.policy,
    systemRoot: "C:\\Windows",
    commandRunner: { async run() { return commandResult(unsigned.evidence); } },
  });
  await assert.rejects(
    verifier.verify(unsigned.input),
    (error) => error?.failureKind === "invalid",
  );

  const internal = identityFixture("test_signed_internal");
  const pinnedVerifier = createWin32CuaDriverIdentityVerifier({
    policy: internal.policy,
    systemRoot: "C:\\Windows",
    commandRunner: { async run() { return commandResult(internal.evidence); } },
  });
  internal.policy.providerSigner.subject = "CN=Mutated After Construction";
  internal.input.seal.main.signerSubject = "CN=Mutated After Construction";
  internal.evidence.provider.signerSubject = "CN=Mutated After Construction";
  await assert.rejects(
    pinnedVerifier.verify(internal.input),
    (error) => error?.failureKind === "invalid",
  );
});

test("bounded Win32 commands retain and terminate the exact spawned child on overflow", async () => {
  const child = fakeChild();
  let spawnInvocation;
  const runner = createBoundedWin32CommandRunner({
    spawnCommand(executablePath, args, options) {
      spawnInvocation = { executablePath, args, options };
      queueMicrotask(() => child.stdout.write(Buffer.from("overflow")));
      return child;
    },
  });
  const result = await runner.run({
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoProfile"],
    environment: { SystemRoot: "C:\\Windows" },
    maxStdoutBytes: 4,
  });

  assert.equal(result.stdout, "over");
  assert.equal(result.stdoutOverflow, true);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(spawnInvocation.options.shell, false);
  assert.deepEqual(spawnInvocation.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawnInvocation.options.env.PATH, undefined);
});

test("bounded Win32 commands terminate the retained child on deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  const runner = createBoundedWin32CommandRunner({ spawnCommand() { return child; } });
  const pending = runner.run({
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoProfile"],
    environment: { SystemRoot: "C:\\Windows" },
    timeoutMs: 1,
  });
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
});

test("bounded Win32 commands never settle until the retained process closes", async () => {
  const child = fakeChild({ autoCloseOnKill: false, killResult: false });
  const runner = createBoundedWin32CommandRunner({ spawnCommand() { return child; } });
  let settled = false;
  const pending = runner.run({
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoProfile"],
    environment: { SystemRoot: "C:\\Windows" },
    timeoutMs: 1,
  }).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(settled, false);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  child.signalCode = "SIGTERM";
  child.emit("close", null, "SIGTERM");
  const result = await pending;
  assert.equal(result.timedOut, true);
});

test("Win32 command helpers reject relative, UNC and whitespace-altered system roots", async () => {
  assert.deepEqual(resolveWin32SystemExecutables("C:\\Windows"), {
    systemRoot: "C:\\Windows",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    icaclsPath: "C:\\Windows\\System32\\icacls.exe",
  });
  assert.deepEqual(resolveWin32SystemExecutables(WIN32_KERNEL_SYSTEM_ROOT), {
    systemRoot: "\\\\?\\GLOBALROOT\\SystemRoot",
    powershellPath: "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    icaclsPath: "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\icacls.exe",
  });
  for (const value of ["Windows", "\\\\server\\Windows", "C:\\Windows "]) {
    assert.throws(() => resolveWin32SystemExecutables(value));
  }
  assert.equal(Buffer.from(encodeWin32PowerShell("Write-Output '好'"), "base64").toString("utf16le"), "Write-Output '好'");

  let spawnCount = 0;
  const runner = createBoundedWin32CommandRunner({ spawnCommand() { spawnCount += 1; return fakeChild(); } });
  const result = await runner.run({ executablePath: "powershell.exe", args: [], environment: {} });
  assert.equal(result.spawnFailed, true);
  assert.equal(spawnCount, 0);
});

test("Win32 state root applies and verifies current-user-only ACL with pre/post topology fences", async () => {
  const fixture = stateRootFixture();
  const protector = createWin32CuaDriverStateRootProtector(fixture.options);
  await protector.protect(fixture.input);

  assert.equal(fixture.invocations.length, 3);
  assert.equal(fixture.reparseCallCount(), 2);
  assert.equal(
    fixture.invocations[1].environment.LING_CUA_ICACLS_PATH,
    "C:\\Windows\\System32\\icacls.exe",
  );
  const aclScript = Buffer.from(fixture.invocations[1].args.at(-1), "base64").toString("utf16le");
  assert.match(aclScript, /GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/u);
  assert.match(aclScript, /FileAttributes\]::ReparsePoint/u);
  for (const invocation of fixture.invocations) {
    assert.equal(invocation.executablePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(invocation.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
    assert.equal(invocation.environment.PATH, undefined);
    assert.equal(invocation.environment.SystemRoot, "C:\\Windows");
    assert.equal(invocation.environment.WINDIR, "C:\\Windows");
  }
});

test("Win32 state root rejects symlinks, canonical escapes and reparse points", async (t) => {
  await t.test("symlink", async () => {
    const fixture = stateRootFixture({ symbolicPath: stateRootPaths().root });
    await assert.rejects(
      createWin32CuaDriverStateRootProtector(fixture.options).protect(fixture.input),
      (error) => error?.message === "windows_state_path_reparse_forbidden",
    );
    assert.equal(fixture.invocations.length, 0);
  });
  await t.test("canonical escape", async () => {
    const fixture = stateRootFixture({ canonicalEscapePath: stateRootPaths().root });
    await assert.rejects(
      createWin32CuaDriverStateRootProtector(fixture.options).protect(fixture.input),
      (error) => error?.message === "windows_state_path_canonical_escape",
    );
    assert.equal(fixture.invocations.length, 0);
  });
  await t.test("junction/reparse", async () => {
    const fixture = stateRootFixture({ reparseOnCall: 1 });
    await assert.rejects(
      createWin32CuaDriverStateRootProtector(fixture.options).protect(fixture.input),
      (error) => error?.message === "windows_state_path_reparse_forbidden",
    );
  });
});

test("Win32 state root rejects ACL owner, principal and inheritance drift", async (t) => {
  for (const [name, mutateAcl] of [
    ["owner mismatch", (acl) => { acl.ownerSid = "S-1-5-21-OTHER"; }],
    ["extra principal", (acl) => { acl.rules.push({ sid: "S-1-5-32-544", type: "Allow", rights: "FullControl", inherited: false }); }],
    ["inherited rule", (acl) => { acl.rules[0].inherited = true; }],
  ]) {
    await t.test(name, async () => {
      const fixture = stateRootFixture({ mutateAcl });
      await assert.rejects(
        createWin32CuaDriverStateRootProtector(fixture.options).protect(fixture.input),
        (error) => error?.message === "windows_state_root_acl_invalid",
      );
    });
  }
});

test("Win32 state root catches ACL-time reparse swaps and runner failures", async (t) => {
  await t.test("post-ACL reparse swap", async () => {
    const fixture = stateRootFixture({ reparseOnCall: 2 });
    await assert.rejects(
      createWin32CuaDriverStateRootProtector(fixture.options).protect(fixture.input),
      (error) => error?.message === "windows_state_path_reparse_forbidden",
    );
    assert.equal(fixture.reparseCallCount(), 2);
  });
  await t.test("PowerShell blocked", async () => {
    const fixture = stateRootFixture({ runnerThrows: true });
    await assert.rejects(
      createWin32CuaDriverStateRootProtector(fixture.options).protect(fixture.input),
      (error) => error?.message === "windows_state_root_verifier_unavailable",
    );
  });
});

test("Win32 state root never derives trusted tools from the process environment", async () => {
  const fixture = stateRootFixture();
  const { systemRoot: _systemRoot, ...options } = fixture.options;
  options.baseEnvironment = {
    SystemRoot: "C:\\attacker",
    WINDIR: "C:\\attacker",
  };

  await assert.rejects(
    createWin32CuaDriverStateRootProtector(options).protect(fixture.input),
    (error) => error?.message === "windows_state_root_verifier_unavailable",
  );
  assert.equal(fixture.invocations.length, 0);
});

test("Win32 lifecycle uses direct spawn and only the retained child handle", async () => {
  const child = fakeChild({ autoCloseOnKill: false });
  let captured;
  let releases = 0;
  const lifecycle = createWin32CuaDriverProcessLifecycle({
    async acquireSpawnLease(input) {
      return {
        executablePath: input.executablePath,
        executableDigest: input.executableDigest,
        async release() { releases += 1; },
        async abort() {},
      };
    },
    spawn(executablePath, args, options) {
      captured = { executablePath, args, options };
      return child;
    },
  });
  const preparedSpawn = await lifecycle.prepareSpawn({
    executablePath: PROVIDER_PATH,
    executableDigest: SHA_A,
    signal: new AbortController().signal,
  });
  const spawned = lifecycle.spawn({
    executablePath: PROVIDER_PATH,
    executableDigest: SHA_A,
    preparedSpawn,
    args: ["mcp", "--stdio"],
    cwd: "C:\\Users\\ling\\AppData\\Roaming\\Ling\\providers\\cua-driver\\state",
    environment: { SystemRoot: "C:\\Windows" },
  });
  assert.equal(spawned, child);
  assert.equal(lifecycle.lifetimeBoundary, "windows-job-object");
  assert.equal(captured.executablePath, PROVIDER_PATH);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.detached, false);
  assert.deepEqual(captured.options.stdio, ["pipe", "pipe", "pipe"]);
  await preparedSpawn.release();
  assert.equal(releases, 1);
  assert.throws(
    () => lifecycle.spawn({
      executablePath: PROVIDER_PATH,
      executableDigest: SHA_A,
      preparedSpawn,
      args: ["mcp"],
      cwd: "C:\\state",
      environment: {},
    }),
    (error) => error instanceof Win32CuaDriverLifecycleError && error.lifecycleCode === "spawn_invalid",
  );

  await lifecycle.terminate(child);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);

  const exitedBeforeNodeDelivery = fakeChild({ autoCloseOnKill: false, killResult: false });
  await lifecycle.terminate(exitedBeforeNodeDelivery);
  assert.deepEqual(exitedBeforeNodeDelivery.killSignals, ["SIGTERM"]);

  const closingHandle = fakeChild({ autoCloseOnKill: false, killThrows: true });
  await lifecycle.terminate(closingHandle);
  assert.deepEqual(closingHandle.killSignals, ["SIGTERM"]);
  assert.throws(
    () => lifecycle.spawn({
      executablePath: PROVIDER_PATH,
      args: ["mcp"],
      cwd: "C:\\state",
      environment: { PATH: "C:\\untrusted" },
    }),
    (error) => error instanceof Win32CuaDriverLifecycleError && error.lifecycleCode === "spawn_invalid",
  );
  assert.throws(
    () => lifecycle.spawn({
      executablePath: PROVIDER_PATH.replace("ling-cua-driver.exe", "cua-driver-uia.exe"),
      args: ["mcp"],
      cwd: "C:\\state",
      environment: {},
    }),
    (error) => error instanceof Win32CuaDriverLifecycleError && error.lifecycleCode === "spawn_invalid",
  );
});

test("Win32 spawn lease holds the exact digest until direct CreateProcess returns", async () => {
  const child = fakeChild({ autoCloseOnKill: false });
  let invocation;
  child.stdin.on("data", (chunk) => {
    if (String(chunk) === "release\n") {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
    }
  });
  const acquire = createWin32ExecutableSpawnLeaseAcquirer({
    systemRoot: "C:\\Windows",
    spawnProcess(executablePath, args, options) {
      invocation = { executablePath, args, options };
      queueMicrotask(() => child.stdout.write("LING_CUA_SPAWN_LEASE_READY_V1\r\n"));
      return child;
    },
  });
  const lease = await acquire({
    executablePath: PROVIDER_PATH,
    executableDigest: SHA_A,
    signal: new AbortController().signal,
  });

  assert.equal(lease.executablePath, PROVIDER_PATH);
  assert.equal(lease.executableDigest, SHA_A);
  assert.equal(invocation.executablePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(invocation.options.env.LING_CUA_PROVIDER_PATH, PROVIDER_PATH);
  assert.equal(invocation.options.env.LING_CUA_PROVIDER_SHA256, SHA_A);
  assert.equal(invocation.options.env.PATH, undefined);
  await lease.release();
});

test("Win32 spawn lease fails closed on malformed protocol and abort", async (t) => {
  await t.test("malformed", async () => {
    const child = fakeChild({ autoCloseOnKill: true });
    const acquire = createWin32ExecutableSpawnLeaseAcquirer({
      systemRoot: "C:\\Windows",
      spawnProcess() {
        queueMicrotask(() => {
          child.stdout.write("forged-ready\n");
          child.kill("SIGKILL");
        });
        return child;
      },
    });
    await assert.rejects(
      acquire({
        executablePath: PROVIDER_PATH,
        executableDigest: SHA_A,
        signal: new AbortController().signal,
      }),
      /spawn_lease_/,
    );
  });

  await t.test("abort", async () => {
    const child = fakeChild({ autoCloseOnKill: true });
    const controller = new AbortController();
    const acquire = createWin32ExecutableSpawnLeaseAcquirer({
      systemRoot: "C:\\Windows",
      spawnProcess() { return child; },
    });
    const pending = acquire({
      executablePath: PROVIDER_PATH,
      executableDigest: SHA_A,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, /spawn_lease_/);
    assert.deepEqual(child.killSignals, ["SIGKILL"]);
  });
});

test("Windows powerMonitor maps only its supported unlock recovery hint", () => {
  const monitor = fakePowerMonitor();
  const observer = createWin32CuaDriverSessionRecoveryObserver(monitor);
  const hints = [];
  const dispose = observer.subscribe((hint) => hints.push(hint));

  monitor.emit("unlock-screen");
  monitor.emit("user-did-become-active");
  assert.deepEqual(hints, [{ kind: "unlock" }]);
  dispose();
  dispose();
  assert.equal(monitor.offCount, 1);
  monitor.emit("unlock-screen");
  assert.equal(hints.length, 1);
});

test("powerMonitor partial subscription failure removes the installed listener", () => {
  const monitor = fakePowerMonitor({ failOn: "unlock-screen" });
  const observer = createWin32CuaDriverSessionRecoveryObserver(monitor);
  assert.throws(
    () => observer.subscribe(() => {}),
    (error) => error instanceof Win32CuaDriverSessionObserverError
      && error.observerCode === "subscribe_failed",
  );
  assert.equal(monitor.offCount, 1);
  assert.equal(monitor.listenerCount("unlock-screen"), 0);
});

test("Win32 factory is standard-only, maps active-child readiness and leaves every default gate off", async () => {
  const monitor = fakePowerMonitor();
  const binding = cuaDriverPublic.createWin32CuaDriverPlatformBinding({
    signingPolicy: identityFixture("unsigned_dev").policy,
    powerMonitor: monitor,
    systemRoot: "C:\\Windows",
    commandRunner: { async run() { return commandResult({ schemaVersion: 1, verdict: "unavailable" }); } },
    stateRootFileSystem: stateRootFixture().options.fileSystem,
    spawn() { return fakeChild(); },
  });
  assert.equal(binding.platform, "win32");
  assert.deepEqual(binding.availability, { status: "available" });
  assert.equal(binding.processLifecycle.lifetimeBoundary, "windows-job-object");
  assert.deepEqual(binding.metadata, {
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  });
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.metadata), true);
  assert.equal(Object.isFrozen(binding.metadata.limitations), true);
  assert.equal("uiAccessHelper" in binding, false);

  const context = {
    generation: 7,
    childInstanceNonce: "nonce-for-win32-readiness-123456",
    platform: "win32",
    hostProcessId: 100,
    providerProcessId: 200,
    async requestControl(method, params) {
      assert.equal(method, "ling/managed_readiness");
      assert.deepEqual(params, {
        schemaVersion: 1,
        childInstanceNonce: "nonce-for-win32-readiness-123456",
        leaseGeneration: 7,
      });
      return { jsonrpc: "2.0", id: "readiness", result: readinessEvidence() };
    },
  };
  const ready = await binding.readinessController.check(context);
  assert.equal(ready.ready, true);
  assert.equal(ready.providerState, "ready");
  assert.equal(ready.integrityCoverage, "standard");
  assert.deepEqual(ready.limitations, ["elevated_pixel_input", "uwp_send_input"]);
  const interactive = await binding.readinessController.check({
    ...context,
    async requestControl() {
      return {
        jsonrpc: "2.0",
        id: "readiness",
        result: { ...readinessEvidence(), hostSessionId: 0, providerSessionId: 0 },
      };
    },
  });
  assert.equal(interactive.ready, false);
  assert.equal(interactive.providerState, "interactive_session_required");

  assert.deepEqual(DEFAULT_CUA_DRIVER_FEATURE_FLAGS, {
    bundledEmbedded: { darwin: false, win32: false },
    packagedProvider: { darwin: false, win32: false },
  });
  assert.deepEqual(cuaDriverPublic.DEFAULT_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_CAPABILITIES, {
    schemaVersion: 1,
    resourcesValidated: true,
    darwin: false,
    win32: false,
  });
  assert.equal("Win32CuaDriverIdentityVerifier" in cuaDriverPublic, false);
  assert.equal("Win32CuaDriverStateRootProtector" in cuaDriverPublic, false);
  assert.equal("createWin32CuaDriverProcessLifecycle" in cuaDriverPublic, false);
});

function identityFixture(tier) {
  const signed = tier !== "unsigned_dev";
  const production = tier === "production_signed";
  const distributionChannel = tier === "unsigned_dev"
    ? "development"
    : production ? "production" : "internal";
  const main = signed
    ? {
        relativePath: "payload/ling-cua-driver.exe",
        sha256: SHA_A,
        architecture: "x86_64",
        peManifestCanonicalSha256: SHA_C,
        authenticodeStatus: "Valid",
        signerSubject: PROVIDER_SIGNER.subject,
        certificateSha256: PROVIDER_SIGNER.certificateSha256,
        timestampPolicy: production ? "rfc3161-required" : "internal-policy",
        timestampStatus: production ? "Valid" : "NotRequired",
      }
    : {
        relativePath: "payload/ling-cua-driver.exe",
        sha256: SHA_A,
        architecture: "x86_64",
        peManifestCanonicalSha256: SHA_C,
        authenticodeStatus: "NotSigned",
      };
  const seal = {
    schemaVersion: 2,
    componentId: "cua-driver-win32-x64",
    lockSha256: SHA_C,
    distributionRevision: "ling.1",
    providerVersion: "0.8.3",
    serverInitializeProtocolVersion: "2025-06-18",
    healthSchemaVersion: "1",
    toolsListCanonicalSha256: SHA_D,
    stateSchemaVersion: 1,
    limitations: ["elevated_pixel_input", "uwp_send_input"],
    signingTier: tier,
    distributionChannel,
    productionEligible: production,
    ...(tier === "test_signed_internal" ? { testAuthorityKind: "ephemeral-ci" } : {}),
    main,
    integrityCatalogRelativePath: signed ? "provider-integrity.cat" : null,
  };
  const policy = signed
    ? {
        signingTier: tier,
        distributionChannel,
        providerSigner: PROVIDER_SIGNER,
        catalogSigner: CATALOG_SIGNER,
        catalogTimestampStatus: production ? "Valid" : "NotRequired",
      }
    : { signingTier: tier, distributionChannel };
  const provider = {
    path: PROVIDER_PATH,
    sha256: SHA_A,
    peMachine: "0x8664",
    peMagic: "0x020b",
    authenticodeStatus: signed ? "Valid" : "NotSigned",
    signerSubject: signed ? PROVIDER_SIGNER.subject : null,
    certificateSha256: signed ? PROVIDER_SIGNER.certificateSha256 : null,
    timestampStatus: production ? "Valid" : "NotRequired",
  };
  const catalog = signed
    ? {
        path: CATALOG_PATH,
        sha256: SHA_B,
        authenticodeStatus: "Valid",
        signerSubject: CATALOG_SIGNER.subject,
        certificateSha256: CATALOG_SIGNER.certificateSha256,
        timestampStatus: production ? "Valid" : "NotRequired",
        validationStatus: "Valid",
        members: [
          { relativePath: "payload/ling-cua-driver.exe", sha256: SHA_A },
          { relativePath: "payload/provider-seal.json", sha256: SHA_C },
        ],
      }
    : null;
  return {
    policy: structuredClone(policy),
    input: {
      platform: "win32",
      architecture: "x86_64",
      paths: {
        resourcesPath: "C:\\Ling\\resources",
        providerRoot: "C:\\Ling\\resources\\providers\\cua-driver\\0.8.3-ling.1",
        platformRoot: "C:\\Ling\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64",
        lockPath: "C:\\Ling\\resources\\providers\\cua-driver\\0.8.3-ling.1\\provider-lock.json",
        licensePath: "C:\\Ling\\resources\\providers\\cua-driver\\0.8.3-ling.1\\LICENSE.md",
        noticesPath: "C:\\Ling\\resources\\providers\\cua-driver\\0.8.3-ling.1\\THIRD_PARTY_NOTICES.md",
        executablePath: PROVIDER_PATH,
        sealPath: SEAL_PATH,
        catalogPath: CATALOG_PATH,
      },
      lock: {},
      seal: structuredClone(seal),
      lockDigest: SHA_C,
      executableDigest: SHA_A,
      sealDigest: SHA_C,
      ...(signed ? { catalogDigest: SHA_B } : {}),
    },
    evidence: structuredClone({ schemaVersion: 1, verdict: "observed", provider, catalog }),
  };
}

function commandResult(output, overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    stdout: typeof output === "string" ? output : JSON.stringify(output),
    stderr: "",
    timedOut: false,
    stdoutOverflow: false,
    stderrOverflow: false,
    spawnFailed: false,
    ...overrides,
  };
}

function fakeChild({ autoCloseOnKill = true, killResult = true, killThrows = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4242;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (killThrows) {
      throw new Error("handle already closing");
    }
    if (autoCloseOnKill) {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit("close", null, signal);
      });
    }
    return killResult;
  };
  return child;
}

function stateRootPaths() {
  const userData = "/tmp/ling-win32-user-data";
  const root = `${userData}/providers/cua-driver/state/v1/0.8.3-ling.1`;
  return { userData, root };
}

function stateRootFixture({
  symbolicPath,
  canonicalEscapePath,
  reparseOnCall,
  mutateAcl,
  runnerThrows = false,
} = {}) {
  const { userData, root } = stateRootPaths();
  const invocations = [];
  let reparseCalls = 0;
  const fileSystem = {
    async lstat(path) {
      return {
        isDirectory: () => true,
        isSymbolicLink: () => path === symbolicPath,
      };
    },
    async realpath(path) {
      return path === canonicalEscapePath ? "/tmp/outside-canonical-root" : path;
    },
  };
  const commandRunner = {
    async run(invocation) {
      invocations.push(invocation);
      if (runnerThrows) {
        throw new Error("PowerShell blocked");
      }
      if (invocation.environment.LING_CUA_STATE_PATHS_BASE64) {
        reparseCalls += 1;
        const paths = JSON.parse(Buffer.from(
          invocation.environment.LING_CUA_STATE_PATHS_BASE64,
          "base64",
        ).toString("utf8"));
        const evidence = {
          schemaVersion: 1,
          verdict: "observed",
          paths: paths.map((path, index) => ({
            path,
            fullName: path,
            directory: true,
            reparsePoint: reparseCalls === reparseOnCall && index === paths.length - 1,
          })),
        };
        return commandResult(evidence);
      }
      const sid = "S-1-5-21-1000";
      const acl = {
        schemaVersion: 1,
        verdict: "observed",
        stateRootPath: root,
        currentUserSid: sid,
        ownerSid: sid,
        protected: true,
        icaclsExitCode: 0,
        icaclsOutputPresent: true,
        rules: [{ sid, type: "Allow", rights: "FullControl", inherited: false }],
      };
      mutateAcl?.(acl);
      return commandResult(acl);
    },
  };
  return {
    input: { userDataPath: userData, stateRootPath: root, createdPaths: [] },
    options: {
      systemRoot: "C:\\Windows",
      baseEnvironment: { SystemRoot: "C:\\Windows", PATH: "C:\\untrusted" },
      fileSystem,
      commandRunner,
    },
    invocations,
    reparseCallCount: () => reparseCalls,
  };
}

function fakePowerMonitor({ failOn } = {}) {
  const emitter = new EventEmitter();
  return {
    offCount: 0,
    on(event, listener) {
      if (event === failOn) {
        throw new Error("subscribe failed");
      }
      emitter.on(event, listener);
      return this;
    },
    off(event, listener) {
      this.offCount += 1;
      emitter.off(event, listener);
      return this;
    },
    emit(event) {
      emitter.emit(event);
    },
    listenerCount(event) {
      return emitter.listenerCount(event);
    },
  };
}

function readinessEvidence() {
  return {
    schemaVersion: 1,
    childInstanceNonce: "nonce-for-win32-readiness-123456",
    leaseGeneration: 7,
    readinessSequence: 1,
    hostProcessId: 100,
    hostSessionId: 3,
    hostIntegrityLevel: "medium",
    providerProcessId: 200,
    providerSessionId: 3,
    providerIntegrityLevel: "medium",
    inputDesktop: "default_unlocked",
    jobObjectAssigned: true,
    killOnJobClose: true,
    uiaRuntime: "available",
    d3d11: "available",
    wgcApi: "supported",
    contentObserved: false,
  };
}
