import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DARWIN_CUA_DRIVER_SYSTEM_TOOLS,
  DarwinCuaDriverIdentityVerifier,
  DarwinCuaDriverPermissionController,
  DarwinCuaDriverReadinessController,
  DarwinIdentityCommandError,
  createDarwinCuaDriverAdapter,
  createDarwinCuaDriverProcessLifecycle,
  createDarwinExecFileCommandRunner,
} from "../dist/main/cua-driver/index.js";

const TEAM_ID = "LINGTEAM01";
const IDENTIFIER = "com.lingstack.desktop.cua-driver";
const REQUIREMENT = `identifier "${IDENTIFIER}" and anchor apple generic`;
const EXECUTABLE_PATH = "/Applications/Ling Stack.app/Contents/Resources/providers/cua-driver/0.8.3-ling.1/darwin/cua-driver";
const ENTITLEMENTS = Object.freeze({
  "com.apple.security.automation.apple-events": true,
  "com.apple.security.device.screen-capture": true,
});
const ENTITLEMENTS_DIGEST = sha256(canonicalJson(ENTITLEMENTS));
const CDHASHES = Object.freeze({
  arm64: "a".repeat(40),
});

test("Darwin identity verifier accepts only the locked arm64 signed tuple", async () => {
  const fixture = createIdentityFixture();

  await fixture.verifier.verify(fixture.input);

  assert.equal(fixture.calls.length, 7);
  assert.deepEqual(fixture.calls[0], {
    executable: "/usr/bin/codesign",
    args: ["--verify", "--strict", "--all-architectures", "--verbose=4", EXECUTABLE_PATH],
  });
  assert.deepEqual(fixture.calls[1], {
    executable: "/usr/bin/lipo",
    args: ["-archs", EXECUTABLE_PATH],
  });
  for (const architecture of ["arm64"]) {
    const entitlementsCall = fixture.calls.find((call) =>
      call.args.includes("--entitlements") && call.args.includes(architecture));
    assert.deepEqual(entitlementsCall?.args, [
      "--display", "--entitlements", "-", "--xml", "--arch", architecture, EXECUTABLE_PATH,
    ]);
  }
  const plistCalls = fixture.calls.filter((call) => call.executable === "/usr/bin/plutil");
  assert.equal(plistCalls.length, 1);
  assert.equal(plistCalls.every((call) => call.stdin?.includes("<?xml version=\"1.0\"")), true);
  assert.equal(fixture.calls.every((call) =>
    Object.values(DARWIN_CUA_DRIVER_SYSTEM_TOOLS).includes(call.executable)), true);
});

test("Darwin identity verifier rejects every mismatched Mach-O or signing dimension", async (t) => {
  const cases = [
    ["unexpected architecture", { architectures: "arm64 x86_64" }],
    ["unexpected minimum macOS", { minimumMacOS: { arm64: "12.0" } }],
    ["unexpected Team ID", { teamIds: { arm64: "WRONGTEAM1" } }],
    ["unexpected code identifier", { identifiers: { arm64: "com.example.cua-driver" } }],
    ["unexpected CDHash", { cdhashes: { arm64: "c".repeat(40) } }],
    ["missing hardened runtime", { hardenedRuntime: { arm64: false } }],
    ["unexpected designated requirement", { requirements: { arm64: `${REQUIREMENT} and true` } }],
    ["unexpected designated requirement digest", {
      seal: { designatedRequirementSha256: "0".repeat(64) },
    }],
    ["extra entitlement", {
      entitlements: {
        arm64: { ...ENTITLEMENTS, "com.apple.security.network.client": true },
      },
    }],
    ["missing entitlement", {
      entitlements: {
        arm64: { "com.apple.security.device.screen-capture": true },
      },
    }],
    ["seal architecture mismatch", { seal: { architectures: ["arm64", "x86_64"] } }],
  ];

  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = createIdentityFixture(options);
      await assert.rejects(
        fixture.verifier.verify(fixture.input),
        (error) => error?.name === "CuaDriverPlatformIdentityVerificationError"
          && error.failureKind === "invalid",
      );
    });
  }
});

test("Darwin identity verifier distinguishes unavailable native tools from invalid identity", async () => {
  for (const failureKind of ["unavailable", "invalid"]) {
    const fixture = createIdentityFixture({
      commandFailure: new DarwinIdentityCommandError(failureKind, "/usr/bin/codesign"),
    });
    await assert.rejects(
      fixture.verifier.verify(fixture.input),
      (error) => error?.name === "CuaDriverPlatformIdentityVerificationError"
        && error.failureKind === failureKind,
    );
  }
});

test("Darwin native command runner fixes executable, environment, timeout, output cap and stdin", async () => {
  const calls = [];
  const runner = createDarwinExecFileCommandRunner({
    timeoutMs: 2_345,
    maxOutputBytes: 12_345,
    baseEnvironment: { PATH: "/fixture/bin", LANG: "fixture" },
    execFile(file, args, options, callback) {
      const call = { file, args, options, stdin: undefined, killed: false };
      calls.push(call);
      const child = {
        stdin: {
          destroyed: false,
          writable: true,
          end(value, encoding) {
            call.stdin = { value, encoding };
          },
        },
        kill() {
          call.killed = true;
          return true;
        },
      };
      queueMicrotask(() => callback(null, "{}", ""));
      return child;
    },
  });

  await runner.run({
    executable: "/usr/bin/plutil",
    args: ["-convert", "json", "-o", "-", "--", "-"],
    stdin: "<plist/>",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/plutil");
  assert.deepEqual(calls[0].args, ["-convert", "json", "-o", "-", "--", "-"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 2_345);
  assert.equal(calls[0].options.maxBuffer, 12_345);
  assert.equal(calls[0].options.encoding, "utf8");
  assert.equal(calls[0].options.env.PATH, "/fixture/bin");
  assert.equal(calls[0].options.env.LANG, "C");
  assert.equal(calls[0].options.env.LC_ALL, "C");
  assert.deepEqual(calls[0].stdin, { value: "<plist/>", encoding: "utf8" });
  await assert.rejects(
    runner.run({ executable: "codesign", args: [] }),
    (error) => error instanceof DarwinIdentityCommandError
      && error.failureKind === "unavailable",
  );
  await assert.rejects(
    runner.run({ executable: "/tmp/codesign", args: [] }),
    (error) => error instanceof DarwinIdentityCommandError
      && error.failureKind === "unavailable",
  );

  const oversizedRunner = createDarwinExecFileCommandRunner({
    maxOutputBytes: 8,
    execFile(_file, _args, _options, callback) {
      queueMicrotask(() => callback(null, "123456789", ""));
      return { stdin: null, kill: () => true };
    },
  });
  await assert.rejects(
    oversizedRunner.run({ executable: "/usr/bin/codesign", args: [] }),
    (error) => error instanceof DarwinIdentityCommandError
      && error.failureKind === "unavailable",
  );

  const brokenStdinRunner = createDarwinExecFileCommandRunner({
    execFile(_file, _args, _options, callback) {
      queueMicrotask(() => callback(null, "{}", ""));
      return {
        stdin: {
          destroyed: false,
          writable: true,
          end() {
            throw new Error("stdin unavailable");
          },
        },
        kill: () => true,
      };
    },
  });
  await assert.rejects(
    brokenStdinRunner.run({ executable: "/usr/bin/plutil", args: [], stdin: "<plist/>" }),
    (error) => error instanceof DarwinIdentityCommandError
      && error.failureKind === "unavailable",
  );
});

test("Darwin native command runner maps ENOENT, timeout and nonzero exit fail closed", async (t) => {
  const cases = [
    ["ENOENT", Object.assign(new Error("missing"), { code: "ENOENT" }), "unavailable"],
    ["timeout", Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" }), "unavailable"],
    ["nonzero", Object.assign(new Error("invalid"), { code: 1 }), "invalid"],
  ];
  for (const [name, commandError, expectedKind] of cases) {
    await t.test(name, async () => {
      const runner = createDarwinExecFileCommandRunner({
        execFile(_file, _args, _options, callback) {
          queueMicrotask(() => callback(commandError, "", "fixture stderr"));
          return { stdin: null, kill: () => true };
        },
      });
      await assert.rejects(
        runner.run({ executable: "/usr/bin/codesign", args: ["--verify", EXECUTABLE_PATH] }),
        (error) => error instanceof DarwinIdentityCommandError
          && error.failureKind === expectedKind,
      );
    });
  }
});

test("Darwin lifecycle directly spawns and terminates the retained child without a shell", async () => {
  const spawnCalls = [];
  const child = createChildFixture();
  const lifecycle = createDarwinCuaDriverProcessLifecycle({
    pinExecutable(executablePath) {
      return { identityPath: executablePath, release() {} };
    },
    spawn(executablePath, args, options) {
      spawnCalls.push({ executablePath, args, options });
      return child;
    },
  });
  const environment = { CUA_DRIVER_STATE_HOME: "/tmp/ling-cua" };

  const returned = lifecycle.spawn({
    executablePath: EXECUTABLE_PATH,
    args: ["mcp", "--embedded"],
    cwd: "/tmp/ling-cua",
    environment,
  });

  assert.equal(returned, child);
  assert.equal(lifecycle.lifetimeBoundary, "darwin-direct-child");
  assert.deepEqual(spawnCalls, [{
    executablePath: EXECUTABLE_PATH,
    args: ["mcp", "--embedded"],
    options: {
      cwd: "/tmp/ling-cua",
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: false,
      windowsHide: true,
    },
  }]);

  await lifecycle.terminate(child);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.throws(
    () => lifecycle.spawn({ executablePath: "cua-driver", args: ["mcp"], cwd: "/tmp", environment: {} }),
    /spawn_invalid/,
  );
  assert.throws(
    () => lifecycle.spawn({ executablePath: EXECUTABLE_PATH, args: [], cwd: "/tmp", environment: {} }),
    /spawn_invalid/,
  );
});

test("Darwin lifecycle reports retained-child termination failure and ignores an exited child", async () => {
  const lifecycle = createDarwinCuaDriverProcessLifecycle();
  const refused = createChildFixture({ killResult: false });
  await assert.rejects(lifecycle.terminate(refused), /terminate_failed/);
  const exited = createChildFixture({ exitCode: 0 });
  await lifecycle.terminate(exited);
  assert.deepEqual(exited.killSignals, []);
});

test("Darwin readiness requires cached host grants, a host live probe and provider capturability", async () => {
  const fixture = createReadinessFixture();
  const result = await fixture.readiness.check(fixture.context);

  assert.deepEqual(result, {
    generation: 7,
    childInstanceNonce: "darwin-child-instance-nonce-0001",
    ready: true,
    providerState: "ready",
  });
  assert.equal(fixture.calls.read, 1);
  assert.equal(fixture.calls.liveProbe, 1);
  assert.equal(fixture.calls.provider, 1);
});

test("Darwin readiness maps host and provider permission failures without prompting", async (t) => {
  const cases = [
    ["host accessibility", { host: { accessibility: false, screenRecording: true } },
      "darwin_accessibility_permission_required", 0],
    ["provider accessibility", { provider: { accessibility: false } },
      "darwin_accessibility_permission_required", 0],
    ["host cached screen recording", { host: { accessibility: true, screenRecording: false } },
      "darwin_screen_recording_permission_required", 0],
    ["provider screen recording", { provider: { screen_recording: false } },
      "darwin_screen_recording_permission_required", 0],
    ["host live screen capture", { liveCapturable: false },
      "darwin_host_screen_recording_not_capturable", 1],
    ["provider live screen capture", { provider: { screen_recording_capturable: false } },
      "darwin_screen_recording_not_capturable", 1],
  ];

  for (const [name, options, reason, expectedLiveProbeCount] of cases) {
    await t.test(name, async () => {
      const fixture = createReadinessFixture(options);
      const result = await fixture.readiness.check(fixture.context);
      assert.equal(result.ready, false);
      assert.equal(result.providerState, "permission_required");
      assert.equal(result.reason, reason);
      assert.equal(fixture.calls.liveProbe, expectedLiveProbeCount);
      assert.equal(fixture.calls.requestAccessibility, 0);
      assert.equal(fixture.calls.requestScreenRecording, 0);
    });
  }
});

test("Darwin readiness rejects malformed or falsely attributed provider responses", async (t) => {
  const cases = [
    ["malformed", { response: { jsonrpc: "2.0", id: 1, result: { structuredContent: { accessibility: "yes" } } } },
      "darwin_check_permissions_response_invalid"],
    ["provider error", { response: { jsonrpc: "2.0", id: 1, result: { isError: true, structuredContent: {} } } },
      "darwin_check_permissions_response_invalid"],
    ["malformed provider error flag", {
      response: {
        jsonrpc: "2.0",
        id: 1,
        result: { isError: "false", structuredContent: createProviderPermissionPayload() },
      },
    }, "darwin_check_permissions_response_invalid"],
    ["wrong attribution", { provider: { source: { attribution: "provider" } } },
      "darwin_host_attribution_invalid"],
    ["not embedded", { provider: { source: { embedded: false } } },
      "darwin_host_attribution_invalid"],
    ["wrong host bundle", { provider: { source: { host_bundle_id: "com.example.desktop" } } },
      "darwin_host_attribution_invalid"],
  ];

  for (const [name, options, reason] of cases) {
    await t.test(name, async () => {
      const fixture = createReadinessFixture(options);
      const result = await fixture.readiness.check(fixture.context);
      assert.equal(result.ready, false);
      assert.equal(result.providerState, "platform_unavailable");
      assert.equal(result.reason, reason);
      assert.equal(fixture.calls.liveProbe, 0);
    });
  }
});

test("Darwin readiness maps unavailable host, live and provider probes to platform_unavailable", async (t) => {
  const cases = [
    ["host snapshot", { readError: new Error("host unavailable") }, "darwin_host_permission_probe_unavailable"],
    ["provider request", { providerError: new Error("provider unavailable") }, "darwin_check_permissions_request_failed"],
    ["host live capture", { liveError: new Error("capture unavailable") }, "darwin_live_screen_capture_probe_unavailable"],
  ];
  for (const [name, options, reason] of cases) {
    await t.test(name, async () => {
      const fixture = createReadinessFixture(options);
      const result = await fixture.readiness.check(fixture.context);
      assert.equal(result.ready, false);
      assert.equal(result.providerState, "platform_unavailable");
      assert.equal(result.reason, reason);
    });
  }

  const wrongPlatform = createReadinessFixture({ platform: "win32" });
  const result = await wrongPlatform.readiness.check(wrongPlatform.context);
  assert.equal(result.reason, "darwin_check_permissions_unavailable");
  assert.equal(wrongPlatform.calls.read, 0);
});

test("Darwin explicit permission request is single-flight and returns a normalized snapshot", async () => {
  const accessibilityGate = deferred();
  const calls = { read: 0, requestAccessibility: 0, requestScreenRecording: 0 };
  const controller = new DarwinCuaDriverPermissionController({
    port: {
      async read() {
        calls.read += 1;
        return { accessibility: true, screenRecording: true };
      },
      async probeLiveScreenCapture() {
        return true;
      },
      async requestAccessibility() {
        calls.requestAccessibility += 1;
        await accessibilityGate.promise;
      },
      async requestScreenRecording() {
        calls.requestScreenRecording += 1;
      },
    },
  });

  const first = controller.requestHostPermissions();
  const second = controller.requestHostPermissions();
  assert.equal(first, second);
  assert.equal(calls.requestAccessibility, 1);
  accessibilityGate.resolve();
  assert.deepEqual(await first, { accessibility: true, screenRecording: true });
  assert.equal(calls.requestScreenRecording, 1);
  assert.equal(calls.read, 1);
  controller.dispose();
});

test("Darwin permission monitor emits changes and becomes inert after stop or dispose", async () => {
  let current = { accessibility: false, screenRecording: false };
  const changes = [];
  const scheduled = [];
  const controller = new DarwinCuaDriverPermissionController({
    port: {
      async read() {
        return current;
      },
      async probeLiveScreenCapture() {
        return true;
      },
      async requestAccessibility() {},
      async requestScreenRecording() {},
    },
    scheduler: {
      schedule(task, delayMs) {
        const entry = { task, delayMs, cancelled: false };
        scheduled.push(entry);
        return { cancel: () => { entry.cancelled = true; } };
      },
    },
    pollIntervalMs: 250,
    onChanged(next, previous) {
      changes.push({ next, previous });
    },
  });

  await controller.startMonitoring();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 250);
  current = { accessibility: true, screenRecording: false };
  await scheduled[0].task();
  assert.deepEqual(changes, [{
    next: { accessibility: true, screenRecording: false },
    previous: { accessibility: false, screenRecording: false },
  }]);
  assert.equal(scheduled.length, 2);

  controller.stopMonitoring();
  assert.equal(scheduled[1].cancelled, true);
  current = { accessibility: true, screenRecording: true };
  await scheduled[1].task();
  assert.equal(changes.length, 1);

  controller.dispose();
  controller.dispose();
  await assert.rejects(controller.snapshot(), /darwin_permission_disposed/);
  await assert.rejects(controller.probeLiveScreenCapture(), /darwin_permission_disposed/);
});

test("Darwin permission monitor retries a failed recovery callback before advancing its baseline", async () => {
  let current = { accessibility: false, screenRecording: false };
  let callbackAttempts = 0;
  const changes = [];
  const scheduled = [];
  const controller = new DarwinCuaDriverPermissionController({
    port: {
      async read() {
        return current;
      },
      async probeLiveScreenCapture() {
        return true;
      },
      async requestAccessibility() {},
      async requestScreenRecording() {},
    },
    scheduler: {
      schedule(task) {
        const entry = { task, cancelled: false };
        scheduled.push(entry);
        return { cancel: () => { entry.cancelled = true; } };
      },
    },
    onChanged(next, previous) {
      callbackAttempts += 1;
      changes.push({ next, previous });
      if (callbackAttempts === 1) {
        throw new Error("fixture recovery failed");
      }
    },
  });

  await controller.startMonitoring();
  current = { accessibility: true, screenRecording: false };
  await scheduled[0].task();
  assert.equal(callbackAttempts, 1);
  assert.equal(scheduled.length, 2);

  await scheduled[1].task();
  assert.equal(callbackAttempts, 2);
  assert.deepEqual(changes, [
    {
      next: { accessibility: true, screenRecording: false },
      previous: { accessibility: false, screenRecording: false },
    },
    {
      next: { accessibility: true, screenRecording: false },
      previous: { accessibility: false, screenRecording: false },
    },
  ]);
  assert.equal(scheduled.length, 3);

  await scheduled[2].task();
  assert.equal(callbackAttempts, 2);
  controller.dispose();
});

test("Darwin adapter factory exposes one available binding and disposes idempotently", async () => {
  const adapter = createDarwinCuaDriverAdapter({
    expectedTeamId: TEAM_ID,
    identityCommandRunner: { async run() { return { stdout: "", stderr: "" }; } },
    permissionPort: {
      async read() {
        return { accessibility: true, screenRecording: true };
      },
      async probeLiveScreenCapture() {
        return true;
      },
      async requestAccessibility() {},
      async requestScreenRecording() {},
    },
  });

  assert.equal(adapter.binding.platform, "darwin");
  assert.deepEqual(adapter.binding.availability, { status: "available" });
  assert.equal(adapter.binding.processLifecycle.lifetimeBoundary, "darwin-direct-child");
  assert.deepEqual(adapter.binding.metadata, { limitations: [] });
  assert.equal(Object.isFrozen(adapter.binding), true);
  assert.equal(Object.isFrozen(adapter.binding.metadata), true);
  assert.equal(Object.isFrozen(adapter.binding.metadata.limitations), true);
  adapter.dispose();
  adapter.dispose();
  await assert.rejects(adapter.permissionController.snapshot(), /darwin_permission_disposed/);
});

function createIdentityFixture(options = {}) {
  const calls = [];
  let currentEntitlementsArchitecture = "arm64";
  const runner = {
    async run(input) {
      calls.push({
        executable: input.executable,
        args: [...input.args],
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      });
      if (options.commandFailure) {
        throw options.commandFailure;
      }
      const architecture = valueAfter(input.args, "--arch") ?? "arm64";
      if (input.executable === "/usr/bin/lipo") {
        return { stdout: `${options.architectures ?? "arm64"}\n`, stderr: "" };
      }
      if (input.executable === "/usr/bin/otool") {
        const minimumMacOS = options.minimumMacOS?.[architecture] ?? "13.0";
        return {
          stdout: `Load command 1\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${minimumMacOS}\n      sdk 15.0\n`,
          stderr: "",
        };
      }
      if (input.executable === "/usr/bin/codesign" && input.args.includes("--verify")) {
        return { stdout: "", stderr: `${EXECUTABLE_PATH}: valid on disk\n` };
      }
      if (input.executable === "/usr/bin/codesign" && input.args.includes("--requirements")) {
        const requirement = options.requirements?.[architecture] ?? REQUIREMENT;
        return { stdout: "", stderr: `designated => ${requirement}\n` };
      }
      if (input.executable === "/usr/bin/codesign" && input.args.includes("--entitlements")) {
        currentEntitlementsArchitecture = architecture;
        return {
          stdout: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>fixture-architecture</key><string>${architecture}</string></dict></plist>\n`,
          stderr: "",
        };
      }
      if (input.executable === "/usr/bin/codesign") {
        const identifier = options.identifiers?.[architecture] ?? IDENTIFIER;
        const teamId = options.teamIds?.[architecture] ?? TEAM_ID;
        const cdhash = options.cdhashes?.[architecture] ?? CDHASHES[architecture];
        const runtime = options.hardenedRuntime?.[architecture] ?? true;
        return {
          stdout: "",
          stderr: [
            `Identifier=${identifier}`,
            `TeamIdentifier=${teamId}`,
            `CDHash=${cdhash}`,
            `CodeDirectory v=20500 size=512 flags=${runtime ? "0x10000(runtime)" : "0x0(none)"} hashes=10+7 location=embedded`,
            "",
          ].join("\n"),
        };
      }
      if (input.executable === "/usr/bin/plutil") {
        const entitlements = options.entitlements?.[currentEntitlementsArchitecture] ?? ENTITLEMENTS;
        return { stdout: `${JSON.stringify(entitlements)}\n`, stderr: "" };
      }
      throw new Error(`unexpected fixture command: ${input.executable}`);
    },
  };
  const seal = {
    componentId: "cua-driver-darwin",
    teamId: TEAM_ID,
    architectures: ["arm64"],
    codeIdentifier: IDENTIFIER,
    cdhashes: CDHASHES,
    designatedRequirement: REQUIREMENT,
    designatedRequirementSha256: sha256(REQUIREMENT),
    entitlementsCanonicalSha256: ENTITLEMENTS_DIGEST,
    ...options.seal,
  };
  const lock = {
    platforms: {
      darwin: {
        componentId: "cua-driver-darwin",
        binary: {
          minimumMacOS: "13.0",
          requiredEntitlements: ENTITLEMENTS,
          requiredEntitlementsCanonicalSha256: ENTITLEMENTS_DIGEST,
          ...options.lockBinary,
        },
      },
    },
  };
  const input = {
    platform: "darwin",
    architecture: "arm64",
    paths: { executablePath: EXECUTABLE_PATH },
    lock,
    seal,
    lockDigest: "1".repeat(64),
    executableDigest: "2".repeat(64),
    sealDigest: "3".repeat(64),
  };
  return {
    calls,
    input,
    verifier: new DarwinCuaDriverIdentityVerifier({ expectedTeamId: TEAM_ID, runner }),
  };
}

function createReadinessFixture(options = {}) {
  const calls = {
    read: 0,
    liveProbe: 0,
    provider: 0,
    requestAccessibility: 0,
    requestScreenRecording: 0,
  };
  const host = options.host ?? { accessibility: true, screenRecording: true };
  const port = {
    async read() {
      calls.read += 1;
      if (options.readError) {
        throw options.readError;
      }
      return host;
    },
    async probeLiveScreenCapture() {
      calls.liveProbe += 1;
      if (options.liveError) {
        throw options.liveError;
      }
      return options.liveCapturable ?? true;
    },
    async requestAccessibility() {
      calls.requestAccessibility += 1;
    },
    async requestScreenRecording() {
      calls.requestScreenRecording += 1;
    },
  };
  const providerSource = {
    attribution: "host",
    embedded: true,
    host_bundle_id: "com.lingstack.desktop",
    ...options.provider?.source,
  };
  const provider = {
    accessibility: true,
    screen_recording: true,
    screen_recording_capturable: true,
    ...options.provider,
    source: providerSource,
  };
  const response = options.response ?? {
    jsonrpc: "2.0",
    id: "ling-control:fixture",
    result: { isError: false, structuredContent: provider },
  };
  const permissions = new DarwinCuaDriverPermissionController({ port });
  const readiness = new DarwinCuaDriverReadinessController(permissions);
  const context = {
    generation: 7,
    childInstanceNonce: "darwin-child-instance-nonce-0001",
    platform: options.platform ?? "darwin",
    async requestCheckPermissions() {
      calls.provider += 1;
      if (options.providerError) {
        throw options.providerError;
      }
      return response;
    },
  };
  return { calls, context, permissions, readiness };
}

function createProviderPermissionPayload() {
  return {
    accessibility: true,
    screen_recording: true,
    screen_recording_capturable: true,
    source: {
      attribution: "host",
      embedded: true,
      host_bundle_id: "com.lingstack.desktop",
    },
  };
}

function createChildFixture(options = {}) {
  const child = {
    exitCode: options.exitCode ?? null,
    signalCode: options.signalCode ?? null,
    killSignals: [],
    kill(signal) {
      child.killSignals.push(signal);
      return options.killResult ?? true;
    },
  };
  return child;
}

function valueAfter(values, marker) {
  const index = values.indexOf(marker);
  return index >= 0 ? values[index + 1] : undefined;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((item) => JSON.parse(canonicalJson(item))));
  }
  if (value && typeof value === "object") {
    return JSON.stringify(Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, JSON.parse(canonicalJson(item))]),
    ));
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
