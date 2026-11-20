import assert from "node:assert/strict";
import test from "node:test";

import { LinuxSshProcessExecutor } from "../dist/features/device-support/adapters/linux-ssh-executor.js";

test("Linux SSH executor uses pinned host-key options and fixed remote commands", async () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const executor = new LinuxSshProcessExecutor({
    host: "192.0.2.10",
    user: "linaro",
    port: 22,
    identityFile: "/tmp/ling-key",
    knownHostsFile: "/tmp/known_hosts",
    runner: {
      async run(file, args) {
        calls.push({ file, args });
        const command = args.slice(args.findIndex(arg => arg.includes("@192.0.2.10")) + 1).join(" ");
        if (command === "hostname") return { stdout: "linaro-p\n", stderr: "", exitCode: 0 };
        if (command === "uname -sr") return { stdout: "Linux 6.6\n", stderr: "", exitCode: 0 };
        if (command === "ip -j addr") return { stdout: "inet 192.168.1.8\n", stderr: "", exitCode: 0 };
        if (command === "ip route get 1.1.1.1") return { stdout: "1.1.1.1 dev wlan0\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  });
  assert.deepEqual(await executor.inventory(), { hostname: "linaro-p", kernel: "Linux 6.6" });
  assert.equal((await executor.readNetwork()).interfaceName, "wlan0");
  assert.equal(calls.every(call => call.file === "ssh" && call.args.includes("StrictHostKeyChecking=yes") && call.args.includes("UserKnownHostsFile=/tmp/known_hosts")), true);
});
