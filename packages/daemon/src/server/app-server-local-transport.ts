import { once } from "node:events";
import { chmod, link, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
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

export function connectToAppServer(options: AppServerLocalTransportOptions, clientName: string, autoReconnect = false): LingAppServerClient {
  return new LingAppServerClient({
    url: appServerUrl(options),
    createSocket: url => createAppServerSocket(url, options.authToken) as unknown as LingAppServerSocket,
    clientInfo: { name: clientName, version: LING_PRODUCT_VERSION },
    autoReconnect,
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
  await recoverStalePublishedSocket(socketPath);
  // The socket server unlinks its bind path on close. Publish a separate
  // name so that a replacement at the client path survives shutdown.
  const bindingDirectory = await mkdtemp(join(dirname(socketPath), ".s"));
  const bindPath = join(bindingDirectory, "s");
  const peers = new Set<Socket>();
  let socketIdentity: { readonly dev: number; readonly ino: number } | undefined;
  let stopping: Promise<void> | undefined;
  const server = createServer(peer => {
    peers.add(peer);
    peer.once("close", () => peers.delete(peer));
    void runLingAppServerStdio(options, peer, peer).catch(() => peer.destroy());
  });
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    for (const peer of peers) peer.destroy();
    stopping = new Promise<void>(resolve => {
      if (!server.listening) resolve();
      else server.close(() => resolve());
    });
    return stopping;
  };
  const closed = once(server, "close");
  void closed.catch(() => undefined);
  const onAbort = () => { void stop(); };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindPath, resolve);
    });
    await chmod(bindPath, 0o600);
    const stat = await lstat(bindPath);
    await link(bindPath, socketPath);
    socketIdentity = { dev: stat.dev, ino: stat.ino };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) await stop();
    await closed;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (server.listening || stopping) await stop();
    const current = socketIdentity ? await lstat(socketPath).catch(() => undefined) : undefined;
    if (current?.isSocket() && current.dev === socketIdentity?.dev && current.ino === socketIdentity.ino) {
      await unlink(socketPath).catch(() => undefined);
    }
    await unlink(bindPath).catch(() => undefined);
    await rmdir(bindingDirectory);
  }
}

async function recoverStalePublishedSocket(socketPath: string): Promise<void> {
  const existing = await lstat(socketPath).catch(() => undefined);
  if (!existing) return;
  if (!existing.isSocket()) throw new Error("The App Server socket path is occupied: " + socketPath);
  const live = await probeUnixSocket(socketPath);
  const current = await lstat(socketPath).catch(() => undefined);
  if (!current || current.dev !== existing.dev || current.ino !== existing.ino) {
    throw new Error("The App Server socket path changed while it was being checked: " + socketPath);
  }
  if (live) throw new Error("The App Server socket is already in use: " + socketPath);
  await unlink(socketPath);
}

function probeUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(live);
    };
    const timeout = setTimeout(() => finish(true), 1_000);
    socket.once("connect", () => finish(true));
    socket.once("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code !== "ECONNREFUSED" && code !== "ENOENT" && code !== "ENOTSOCK");
    });
  });
}
