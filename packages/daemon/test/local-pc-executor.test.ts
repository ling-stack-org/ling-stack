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
        if (file === "systemctl" && args[0] === "list-units") return { stdout: "NetworkManager.service loaded active running Network Manager\n", stderr: "", exitCode: 0 };
        if (file === "systemctl" && args[0] === "restart") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    },
  });
  assert.deepEqual(await executor.inventory(), { hostname: "board", os: "linux", version: "Linux 6.6" });
  assert.deepEqual(await executor.readNetwork(), { connected: true, interfaceName: "eth0", address: "192.0.2.10" });
  assert.equal((await executor.readServices())[0]?.state, "running");
  assert.deepEqual(await executor.repairNetwork({ mode: "restart_network" }), { accepted: true, changed: true });
  assert.deepEqual(calls, ["hostname ", "uname -sr", "systemctl list-units --type=service --no-legend --plain", "systemctl restart NetworkManager"]);
});
