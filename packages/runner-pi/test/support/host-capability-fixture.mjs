// Adapter-only schema fixture. Runner tests must not require an undeclared
// Contracts package build; Daemon tests verify the real catalog/adapter seam.
export const hostCapabilityToolsFixture = [
  { name: "host_open_local_target", capabilityId: "host.open_local_target", contractVersion: 1,
    description: "Fixture Host file viewer; no actual OS effect.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } } },
  { name: "host_local_network_info", capabilityId: "host.local_network_info", contractVersion: 1,
    description: "Fixture Host local network query; no actual OS effect.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      family: { type: "string", enum: ["all", "IPv4", "IPv6"] }, includeLoopback: { type: "boolean" },
    } } },
];
