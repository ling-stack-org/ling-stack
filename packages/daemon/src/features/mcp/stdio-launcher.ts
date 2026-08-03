import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";

// A 25 MiB binary image becomes roughly 34 MiB after base64 and JSON framing.
// Keep stdio MCP results bounded while preserving Ling's existing image-sized payloads.
export const MCP_STDIO_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface McpStdioLaunchInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface McpProcessLauncher {
  createStdioTransport(input: McpStdioLaunchInput): McpTransport;
}

export function createDefaultMcpProcessLauncher(): McpProcessLauncher {
  return {
    createStdioTransport(input: McpStdioLaunchInput): McpTransport {
      return new StdioClientTransport({
        command: input.command,
        args: [...input.args],
        env: {
          ...getDefaultEnvironment(),
          ...input.env,
        },
        cwd: input.cwd,
        stderr: "pipe",
        maxBufferSize: MCP_STDIO_MAX_BUFFER_BYTES,
      });
    },
  };
}
