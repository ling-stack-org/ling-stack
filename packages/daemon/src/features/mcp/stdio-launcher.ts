import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { defineProtectedHostActorEntry } from "../../runtime/sandbox/protected-host-actor-inventory.js";

const originalSdkStart = StdioClientTransport.prototype.start;
const ownedSdkTransports = new WeakMap<object, StdioClientTransport>();

/** SDK start, not construction: Client.connect and metadata probes reach this same original entry. */
export const MCP_SDK_STDIO_ACTOR_ENTRY = defineProtectedHostActorEntry("mcp_sdk_stdio",
  (owner: object): Promise<void> => {
    const transport = ownedSdkTransports.get(owner);
    if (!transport) throw new Error("mcp_stdio_original_transport_invalid");
    return Reflect.apply(originalSdkStart, transport, []);
  });

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
      return new OwnedSdkStdioTransport(input);
    },
  };
}

/**
 * Public SDK Transport contract with a private original SDK object. Returning
 * that object would expose its base start method as an alternate launch path.
 * Close/send retain the existing SDK behavior and never retire unknown coverage.
 */
class OwnedSdkStdioTransport implements McpTransport {
  onmessage?: McpTransport["onmessage"];
  onerror?: McpTransport["onerror"];
  onclose?: McpTransport["onclose"];
  readonly #transport: StdioClientTransport;

  constructor(input: McpStdioLaunchInput) {
    const parameters = {
      command: input.command, args: [...input.args], env: { ...getDefaultEnvironment(), ...input.env },
      cwd: input.cwd, stderr: "pipe" as const, maxBufferSize: MCP_STDIO_MAX_BUFFER_BYTES,
    };
    Object.freeze(parameters.args); Object.freeze(parameters.env); Object.freeze(parameters);
    const transport = new StdioClientTransport(parameters);
    this.#transport = transport;
    ownedSdkTransports.set(this, transport);
    transport.onmessage = message => this.onmessage?.(message);
    transport.onerror = error => this.onerror?.(error);
    transport.onclose = () => this.onclose?.();
  }

  async start(): Promise<void> { return MCP_SDK_STDIO_ACTOR_ENTRY.invoke(undefined, this); }
  send(message: JSONRPCMessage): Promise<void> { return this.#transport.send(message); }
  close(): Promise<void> { return this.#transport.close(); }
}
