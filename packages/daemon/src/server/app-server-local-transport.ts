import { once } from "node:events";
import { chmod, lstat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { LingAppServerClient, type LingAppServerSocket } from "@ling-stack/api-client";
import { LING_PRODUCT_VERSION } from "@ling-stack/contracts";
import { WebSocket } from "ws";

export interface AppServerLocalTransportOptions {
  readonly daemonUrl: string;
  readonly cwd: string;
  readonly authToken?: string;
}

const maxRequestBytes = 1024 * 1024;
const maxResponseBytes = 128 * 1024;
const handshakeTimeout = 5_000;

function appServerUrl(options: AppServerLocalTransportOptions): string {
  const url = new URL("/app-server/rpc", options.daemonUrl);
  if (url.username || url.password) throw new Error("App Server credentials belong in the authorization header.");
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("A remote App Server requires WSS.");
  }
  if (url.protocol === "wss:" && !options.authToken) throw new Error("WSS requires a Daemon bearer credential.");
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Invalid App Server transport URL.");
  url.searchParams.set("cwd", options.cwd);
  return url.href;
}

function createAppServerSocket(url: string, authToken: string | undefined): WebSocket {
  return new WebSocket(url, {
    handshakeTimeout,
    maxPayload: maxResponseBytes,
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
  });
}

export function connectToAppServer(options: AppServerLocalTransportOptions, clientName: string): LingAppServerClient {
  return new LingAppServerClient({
    url: appServerUrl(options),
    createSocket: url => createAppServerSocket(url, options.authToken) as unknown as LingAppServerSocket,
    clientInfo: { name: clientName, version: LING_PRODUCT_VERSION },
    autoReconnect: false,
    requestTimeoutMs: handshakeTimeout,
  });
}

export async function probeLingAppServer(options: AppServerLocalTransportOptions) {
  const client = connectToAppServer(options, "ling-cli");
  try {
    return { ...(await client.getCapabilities()), ...(await client.ping()) };
  } finally {
    client.close();
  }
}

export async function runLingAppServerStdio(
  options: AppServerLocalTransportOptions,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const socket = createAppServerSocket(appServerUrl(options), options.authToken);
  const closed = once(socket, "close");
  void closed.catch(() => undefined);
  const resume = () => socket.resume();
  const rejectOutput = () => socket.terminate();
  try {
    await once(socket, "open");
    output.on("error", rejectOutput);
    socket.on("message", (data, binary) => {
      if (binary) {
        socket.close(1003, "Expected JSON text frames");
        return;
      }
      if (!output.write(data.toString("utf8") + "\n")) {
        socket.pause();
        output.once("drain", resume);
      }
    });
    const forwarded = forwardJsonLines(input, socket);
    await Promise.race([forwarded, closed]);
  } finally {
    output.off("drain", resume);
    output.off("error", rejectOutput);
    input.destroy();
    socket.terminate();
  }
}

async function forwardJsonLines(input: Readable, socket: WebSocket): Promise<void> {
  let buffer = "";
  for await (const chunk of input.setEncoding("utf8")) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxRequestBytes) throw new Error("App Server JSONL frame exceeds 1 MiB.");
      if (!line.trim()) continue;
      await new Promise<void>((resolve, reject) => socket.send(line, error => error ? reject(error) : resolve()));
    }
    if (Buffer.byteLength(buffer) > maxRequestBytes) throw new Error("App Server JSONL frame exceeds 1 MiB.");
  }
  if (buffer.trim()) throw new Error("App Server JSONL input ended before a complete frame.");
}

export async function listenLingAppServerSocket(
  options: AppServerLocalTransportOptions,
  socketPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform === "win32" || !isAbsolute(socketPath)) throw new Error("Use an absolute Unix socket path on macOS or Linux.");
  const directory = await lstat(dirname(socketPath));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) {
    throw new Error("The App Server socket directory must be private and owned by the current user.");
  }
  const peers = new Set<Socket>();
  const server = createServer(peer => {
    peers.add(peer);
    peer.once("close", () => peers.delete(peer));
    void runLingAppServerStdio(options, peer, peer).catch(() => peer.destroy());
  });
  const stop = () => {
    for (const peer of peers) peer.destroy();
    server.close();
  };
  const closed = once(server, "close");
  void closed.catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    await closed;
  } finally {
    signal.removeEventListener("abort", stop);
    if (server.listening) stop();
  }
}
