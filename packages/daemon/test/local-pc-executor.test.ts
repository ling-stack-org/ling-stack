import assert from "node:assert/strict";
import test from "node:test";

import { LocalPcTargetExecutor } from "../dist/features/device-support/adapters/local-pc-executor.js";

test("local PC executor uses fixed typed commands and normalizes Linux observations", async () => {
  const calls: string[] = [];
  const executor = new LocalPcTargetExecutor({
    platform: "linux",
    runner: {
      async run(file, args) {
        calls.push(`${file} ${args.join(" ")}`);
        if (file === "hostname") return { stdout: "board\n", stderr: "", exitCode: 0 };
        if (file === "uname") return { stdout: "Linux 6.6\n", stderr: "", exitCode: 0 };
        if (file === "ip" && args[0] === "-j") return { stdout: "1: eth0: <UP>\\n    inet 192.168.1.2\\n", stderr: "", exitCode: 0 };
        if (file === "systemctl" && args[0] === "list-units") return { stdout: "NetworkManager.service loaded active running Network Manager\n", stderr: "", exitCode: 0 };
        if (file === "systemctl" && args[0] === "restart") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    },
  });
  assert.deepEqual(await executor.inventory(), { hostname: "board", os: "linux", version: "Linux 6.6" });
  assert.equal((await executor.readNetwork()).connected, true);
  assert.equal((await executor.readServices())[0]?.state, "running");
  assert.deepEqual(await executor.repairNetwork({ mode: "restart_network" }), { accepted: true, changed: true });
  assert.deepEqual(calls, ["hostname ", "uname -sr", "ip -j addr", "systemctl list-units --type=service --no-legend --plain", "systemctl restart NetworkManager"]);
});
