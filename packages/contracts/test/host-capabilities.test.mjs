import assert from "node:assert/strict";
import test from "node:test";
import { hostCapabilityToolsV1, readHostCapabilityCallV1, isHostCapabilityToolDefinitionV1 } from "../dist/index.js";

test("Host catalog is a closed immutable schema surface, not an execution grant", () => {
  assert.deepEqual(hostCapabilityToolsV1.map(tool => tool.name), ["host_open_local_target", "host_local_network_info"]);
  for (const tool of hostCapabilityToolsV1) {
    assert.equal(isHostCapabilityToolDefinitionV1(JSON.parse(JSON.stringify(tool))), true);
    assert.ok(Object.isFrozen(tool.inputSchema.properties));
    assert.equal(isHostCapabilityToolDefinitionV1({ ...tool, defaultApproval: "allow" }), false);
    assert.equal(isHostCapabilityToolDefinitionV1({ ...tool, contractVersion: 2 }), false);
    assert.equal(isHostCapabilityToolDefinitionV1({ ...tool, inputSchema: { type: "object" } }), false);
  }
});
test("Host applies and records network defaults and preserves a literal open target", () => {
  assert.deepEqual(readHostCapabilityCallV1("host_local_network_info", {}), {
    contractVersion: 1, capabilityId: "host.local_network_info", input: { family: "all", includeLoopback: false },
  });
  assert.deepEqual(readHostCapabilityCallV1("host_open_local_target", { path: "小项目/index.html" }), {
    contractVersion: 1, capabilityId: "host.open_local_target", input: { path: "小项目/index.html" },
  });
});
test("Host inputs cannot invent ownership, authority, arbitrary commands or targets", () => {
  for (const input of [null, [], { path: "../secret" }, { path: "/tmp/file" }, { path: "https://example.test" },
    { path: "ok.txt", runId: "other" }, { path: "ok.txt", executor: "bash" }, { path: "ok.txt", approvalId: "forged" },
    { path: "ok.txt", command: "open ok.txt" }, { path: "a\u0000b" }]) {
    assert.throws(() => readHostCapabilityCallV1("host_open_local_target", input));
  }
  for (const input of [{ family: "IPv5" }, { includeLoopback: "false" }, { publicIp: true }, { family: "all", grant: true }]) {
    assert.throws(() => readHostCapabilityCallV1("host_local_network_info", input));
  }
  assert.throws(() => readHostCapabilityCallV1("host_execute_script", {}));
});
