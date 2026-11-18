import { deriveCuaDriverProxyToken, deriveCuaDriverWorkspaceBinding, type CuaDriverProxyContext } from "../cua-driver/mcp-proxy.js";

/** One authenticated in-memory MCP consumer; endpoint and token are never logged. */
export async function connectLockedUseValidationTransport(options: {
  readonly endpoint: string;
  readonly context: CuaDriverProxyContext;
  readonly signal: AbortSignal;
}): Promise<(name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>> {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("locked_use_validation_endpoint_invalid");
  let sequence = 0;
  let session: string | undefined;
  const headers = {
    "content-type": "application/json", accept: "application/json",
    authorization: "Bearer " + deriveCuaDriverProxyToken(options.context),
    "x-ling-cua-driver-generation": String(options.context.generation),
    "x-ling-cua-driver-workspace-sha256": deriveCuaDriverWorkspaceBinding(options.context.workspaceCwd),
    "x-ling-cua-driver-authority-epoch": options.context.daemonAuthorityEpoch,
    "x-ling-cua-driver-instance-epoch": String(options.context.desktopInstanceEpoch),
    "x-ling-cua-driver-bridge-connection": options.context.bridgeConnectionId,
  };
  const request = async (method: string, params: Record<string, unknown>, notification = false): Promise<unknown> => {
    const id = ++sequence;
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.any([options.signal, AbortSignal.timeout(40_000)]),
      headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (!response.ok || session && nextSession !== session) { await response.body?.cancel(); throw new Error("locked_use_validation_transport_failed"); }
    if (!session) {
      if (!nextSession || nextSession.length > 256) { await response.body?.cancel(); throw new Error("locked_use_validation_mcp_session_missing"); }
      session = nextSession;
    }
    const bytes = await responseBytes(response);
    if (notification) return;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("locked_use_validation_mcp_invalid");
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== "2.0" || message.id !== id || Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) {
      throw new Error("locked_use_validation_mcp_error");
    }
    return message.result;
  };
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ling-locked-use-validation", version: "1" } });
  await request("notifications/initialized", {}, true);
  return (name, args) => request("tools/call", { name, arguments: args });
}

async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      length += value.byteLength;
      if (length > 20 * 1024 * 1024) { await reader.cancel(); throw new Error("locked_use_validation_response_oversized"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}
