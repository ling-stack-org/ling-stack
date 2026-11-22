import assert from "node:assert/strict";
import test from "node:test";

import { LocalPcTargetExecutor } from "../dist/features/device-support/adapters/local-pc-executor.js";

test("local PC executor uses fixed typed commands and normalizes Linux observations", async () => {
  const calls: string[] = [];
  const executor = new LocalPcTargetExecutor({
    platform: "linux",
    readInterfaces: () => ({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "", cidr: "127.0.0.1/8" }],
      wlan0: [{ address: "169.254.1.2", family: "IPv4", internal: false, netmask: "255.255.0.0", mac: "", cidr: "169.254.1.2/16" }],
      eth0: [{ address: "192.0.2.10", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "", cidr: "192.0.2.10/24" }],
    }),
    runner: {
      async run(file, args) {
        calls.push(`${file} ${args.join(" ")}`);
        if (file === "hostname") return { stdout: "board\n", stderr: "", exitCode: 0 };
        if (file === "uname") return { stdout: "Linux 6.6\n", stderr: "", exitCode: 0 };
        if (file === "systemctl" && args[0] === "list-units") return {
          stdout: [
            "NetworkManager.service loaded active running Network Manager",
            "cups.service loaded inactive dead Print Service",
            "backup.service loaded failed failed Backup Service",
            "mount-helper.service loaded activating start Mount Helper",
          ].join("\n"),
          stderr: "", exitCode: 0,
        };
        if (file === "systemctl" && args[0] === "restart") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    },
  });
  assert.deepEqual(await executor.inventory(), { hostname: "board", os: "linux", version: "Linux 6.6" });
  assert.deepEqual(await executor.readNetwork(), { connected: true, interfaceName: "eth0", address: "192.0.2.10" });
  assert.deepEqual(await executor.readServices(), [
    { name: "NetworkManager", state: "running" }, { name: "cups", state: "stopped" },
    { name: "backup", state: "failed" }, { name: "mount-helper", state: "unknown" },
  ]);
  assert.deepEqual(await executor.repairNetwork({ mode: "restart_network" }), { accepted: true, changed: true });
  assert.deepEqual(calls, [
    "hostname ", "uname -sr", "systemctl list-units --type=service --all --no-legend --plain --no-pager --full",
    "systemctl restart NetworkManager",
  ]);
});

test("macOS service inspection reads the statuses of jobs in the current launchd domain", async () => {
  const executor = new LocalPcTargetExecutor({
    platform: "darwin",
    runner: {
      async run(file, args) {
        assert.equal(file, "/bin/launchctl");
        assert.deepEqual(args, ["list"]);
        return {
          stdout: "PID\tStatus\tLabel\n42\t-9\tcom.example.running\n-\t0\tcom.example.dormant\n-\t1\tcom.example.failed\n-\t-9\tcom.example.signaled\n",
          stderr: "", exitCode: 0,
        };
      },
    },
  });
  assert.deepEqual(await executor.readServices(), [
    { name: "com.example.running", state: "running" }, { name: "com.example.dormant", state: "stopped" },
    { name: "com.example.failed", state: "failed" }, { name: "com.example.signaled", state: "unknown" },
  ]);
});

test("Windows service inspection projects names and states from the structured native query", async () => {
  const executor = new LocalPcTargetExecutor({
    platform: "win32",
    runner: {
      async run(file, args) {
        assert.match(file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
        assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
        assert.match(args[4] ?? "", /Get-Service/u);
        return {
          stdout: JSON.stringify([
            { name: "Dnscache", state: "Running" }, { name: "Windows 更新", state: "Stopped" },
            { name: "Spooler", state: "StartPending" },
          ]) + "\r\n",
          stderr: "", exitCode: 0,
        };
      },
    },
  });
  assert.deepEqual(await executor.readServices(), [
    { name: "Dnscache", state: "running" }, { name: "Windows 更新", state: "stopped" },
    { name: "Spooler", state: "unknown" },
  ]);
});

test("an empty PC service inspection requires a successful query with valid output", async () => {
  const inspect = async (platform: NodeJS.Platform, stdout: string, exitCode: number) => {
    return new LocalPcTargetExecutor({ platform, runner: { async run() { return { stdout, stderr: "", exitCode }; } } }).readServices();
  };
  assert.deepEqual(await inspect("linux", "", 0), []);
  assert.deepEqual(await inspect("darwin", "PID\tStatus\tLabel\n", 0), []);
  assert.deepEqual(await inspect("win32", "[]", 0), []);
  assert.equal(await inspect("linux", "partial.service loaded active running Partial\n", 1), undefined);
  assert.equal(await inspect("linux", "invalid service-manager output", 0), undefined);
  assert.equal(await inspect("darwin", "42\t0\tcom.example.running", 0), undefined);
  assert.equal(await inspect("win32", '[{"name":"test","state":null}]', 0), undefined);
});

test("PC process inspection reads PIDs and native names without command arguments", async t => {
  for (const [platform, output, rows] of [
    ["linux", "  1 systemd\n 42 Sample Worker\n", [{ pid: 1, name: "systemd" }, { pid: 42, name: "Sample Worker" }]],
    ["darwin", "  1 launchd \n 42 Sample Worker \n", [{ pid: 1, name: "launchd" }, { pid: 42, name: "Sample Worker" }]],
    ["win32", '[{"pid":0,"name":"Idle"},{"pid":42,"name":"示例"}]\r\n', [{ pid: 0, name: "Idle" }, { pid: 42, name: "示例" }]],
  ] as const) {
    await t.test(platform, async () => {
      const executor = new LocalPcTargetExecutor({
        platform,
        runner: {
          async run(file, args) {
            if (platform === "win32") {
              assert.match(file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
              assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
              assert.match(args[4] ?? "", /Get-Process.*\n\s+@\{ pid = \$_\.Id; name = \$_\.ProcessName \}/u);
            } else {
              assert.equal(file, "/bin/ps");
              assert.deepEqual(args, ["-ww", "-axo", platform === "darwin" ? "pid=,ucomm=" : "pid=,comm="]);
            }
            return { stdout: output, stderr: "", exitCode: 0 };
          },
        },
      });
      assert.deepEqual(await executor.readProcesses(), rows);
    });
  }
});

test("PC process inspection distinguishes empty, malformed, unavailable and cancelled results", async () => {
  const inspect = (platform: NodeJS.Platform, stdout: string, exitCode: number) =>
    new LocalPcTargetExecutor({ platform, runner: { async run() { return { stdout, stderr: "", exitCode }; } } });
  assert.deepEqual(await inspect("linux", "", 0).readProcesses(), []);
  assert.deepEqual(await inspect("win32", "[]", 0).readProcesses(), []);
  assert.equal(await inspect("darwin", "1 launchd\n", 1).readProcesses(), undefined);
  assert.equal(await inspect("linux", "1 systemd\n2\n", 0).readProcesses(), undefined);
  assert.equal(await inspect("linux", "9999999999999999999 fake\n", 0).readProcesses(), undefined);
  assert.equal(await inspect("win32", '[{"pid":"42","name":"Process"}]', 0).readProcesses(), undefined);
  assert.equal(await inspect("win32", '[{"pid":42,"name":"bad\\u0000name"}]', 0).readProcesses(), undefined);
  assert.equal(await inspect("freebsd", "", 0).readProcesses(), undefined);

  const stop = new AbortController();
  const stopped = new Error("operator stopped the task");
  const cancelled = new LocalPcTargetExecutor({ platform: "darwin", runner: {
    async run(_file, _args, signal) {
      stop.abort(stopped);
      assert.equal(signal?.aborted, true);
      return { stdout: "1 launchd\n", stderr: "", exitCode: 0 };
    },
  } });
  await assert.rejects(() => cancelled.readProcesses(stop.signal), stopped);
});
