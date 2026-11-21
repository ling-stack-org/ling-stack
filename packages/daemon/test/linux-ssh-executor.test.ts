import assert from "node:assert/strict";
import test from "node:test";

import { LinuxSshProcessExecutor, type LinuxSshProcessExecutorOptions } from "../dist/features/device-support/adapters/linux-ssh-executor.js";
import type { LocalProcessRunner } from "../dist/features/device-support/adapters/local-pc-executor.js";

const addressOutput = JSON.stringify([
  { ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1", scope: "host" }] },
  { ifname: "eth0", addr_info: [{ family: "inet", local: "192.0.2.1", scope: "global" }] },
  { ifname: "wlan0", addr_info: [
    { family: "inet", local: "192.0.2.2", scope: "global" },
    { family: "inet", local: "192.0.2.3", scope: "global" },
  ] },
]);
const routeCommand = "env LC_ALL=C ip -j route get 1.1.1.1";
const routeOutput = JSON.stringify([{ dst: "1.1.1.1", dev: "wlan0", prefsrc: "192.0.2.3", gateway: "192.0.2.254" }]);
type ProcessResult = Awaited<ReturnType<LocalProcessRunner["run"]>>;

function createExecutor(
  results: Record<string, string | ProcessResult>,
  options: Partial<Omit<LinuxSshProcessExecutorOptions, "runner">> = {},
) {
  const calls: { readonly file: string; readonly args: readonly string[] }[] = [];
  const executor = new LinuxSshProcessExecutor({
    host: "192.0.2.10",
    user: "linaro",
    port: 2222,
    identityFile: "/fixture/ling-key",
    knownHostsFile: "/fixture/SSH profile/known_hosts",
    ...options,
    runner: {
      async run(file, args) {
        calls.push({ file, args });
        const endOfOptions = args.indexOf("--");
        assert.notEqual(endOfOptions, -1);
        const command = args.slice(endOfOptions + 2).join(" ");
        const result = results[command];
        assert.ok(result !== undefined, `unexpected SSH command: ${command}`);
        return typeof result === "string" ? { stdout: result, stderr: "", exitCode: 0 } : result;
      },
    },
  });
  return { executor, calls };
}

test("Linux SSH inventory uses the supplied trust store and fixed remote commands", async () => {
  const { executor, calls } = createExecutor({ hostname: "linaro-p\n", "uname -sr": "Linux 6.6\n" });
  assert.deepEqual(await executor.inventory(), { hostname: "linaro-p", kernel: "Linux 6.6" });
  const options = [
    "-F", "none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "GlobalKnownHostsFile=none", "-o", 'UserKnownHostsFile="/fixture/SSH profile/known_hosts"',
    "-o", "UpdateHostKeys=no", "-p", "2222", "-o", "IdentitiesOnly=yes", "-i", "/fixture/ling-key",
    "-l", "linaro", "--", "192.0.2.10",
  ];
  assert.deepEqual(calls, [
    { file: "ssh", args: [...options, "hostname"] },
    { file: "ssh", args: [...options, "uname", "-sr"] },
  ]);
  assert.throws(() => createExecutor({}, { host: "ssh://192.0.2.10" }), /must be valid/u);
  assert.throws(() => createExecutor({}, { port: 65_536 }), /must be valid/u);
});

test("Linux Wi-Fi facts keep address, route and wireless association independent", async () => {
  const { executor } = createExecutor({
    "ip -j addr": addressOutput,
    [routeCommand]: routeOutput,
    "iw dev": "phy#0\n\tInterface wlan1\n\tInterface wlan0\n",
    "iw dev wlan0 link": "Connected to 00:11:22:33:44:55 (on wlan0)\n\tSSID: Fixture Hotspot\n",
  });
  assert.deepEqual(await executor.readNetwork(), {
    connected: true, routeAvailable: true, interfaceName: "wlan0", ipv4: "192.0.2.3",
  });
  assert.deepEqual(await executor.readWifi(), {
    connected: true, routeAvailable: true, interfaceName: "wlan0", ipv4: "192.0.2.3",
    wifiInterfaceName: "wlan0", wifiAssociated: true, ssid: "Fixture Hotspot",
  });

  const offline = createExecutor({
    "ip -j addr": addressOutput,
    [routeCommand]: JSON.stringify([{ dst: "1.1.1.1", dev: "eth0", prefsrc: "192.0.2.1" }]),
    "iw dev": "phy#0\n\tInterface wlan0\n",
    "iw dev wlan0 link": "Not connected.\n",
  }).executor;
  assert.deepEqual(await offline.readWifi(), {
    connected: true, routeAvailable: true, interfaceName: "eth0", ipv4: "192.0.2.1",
    wifiInterfaceName: "wlan0", wifiAssociated: false,
  });
});

test("Linux route observations distinguish a missing route from a failed query", async () => {
  const unreachable = createExecutor({
    "ip -j addr": addressOutput,
    [routeCommand]: { stdout: "", stderr: "RTNETLINK answers: Network is unreachable\n", exitCode: 2 },
  }).executor;
  assert.equal((await unreachable.readNetwork()).routeAvailable, false);

  const unsupported = createExecutor({
    "ip -j addr": addressOutput,
    [routeCommand]: { stdout: "", stderr: "route query not supported", exitCode: 1 },
    "iw dev": { stdout: "", stderr: "iw: command not found", exitCode: 127 },
  }).executor;
  assert.deepEqual(await unsupported.readWifi(), {
    connected: true, interfaceName: "eth0", ipv4: "192.0.2.1", linkError: "wireless_tools_unavailable",
  });

  const malformed = createExecutor({ "ip -j addr": "unexpected private output" }).executor;
  await assert.rejects(malformed.readNetwork(), { message: "Linux ip command returned invalid JSON" });
});

test("Linux SSH transport loss keeps restart and observation outcomes unresolved", async () => {
  const failed = { stdout: "", stderr: "Connection reset", exitCode: 255 };
  const { executor, calls } = createExecutor({
    "ip -j addr": addressOutput,
    [routeCommand]: failed,
    "systemctl restart NetworkManager": failed,
  });
  await assert.rejects(executor.readNetwork(), /interrupted/u);
  await assert.rejects(executor.restartNetwork({}), /interrupted/u);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(executor.inventory(abort.signal), { name: "AbortError" });
  assert.equal(calls.length, 3);
});
