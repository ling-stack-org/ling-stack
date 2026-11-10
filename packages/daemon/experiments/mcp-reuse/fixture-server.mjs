import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "ling-reuse-research-fixture", version: "1" });
server.registerTool("read_fixture", {}, async () => ({ content: [{ type: "text", text: "research fixture" }] }));
await server.connect(new StdioServerTransport());
