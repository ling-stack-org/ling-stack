import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";

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
      });
    },
  };
}
