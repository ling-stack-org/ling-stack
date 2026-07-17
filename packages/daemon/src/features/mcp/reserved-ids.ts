const pluginReservedMcpServerIds = new Set([
  "mcp_cua_driver",
  "mcp:cua-driver",
]);

export function isPluginReservedMcpServerId(serverId: string): boolean {
  return pluginReservedMcpServerIds.has(serverId);
}
