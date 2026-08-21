import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  browserHostStatus,
  createChromeBrowserRuntimeDescriptor,
  defaultDevelopmentBrowserHostPath,
  publishChromeBrowserRuntimeDescriptor,
  removeChromeBrowserRuntimeDescriptor,
} from "@ling-stack/browser-host";
import {
  CHROME_BROWSER_NATIVE_HOST_VERSION,
  CHROME_BROWSER_NATIVE_PROTOCOL,
  isCompatibleChromeBrowserNativeVersion,
  parseChromeBrowserNativeBrokerHello,
  type ChromeBrowserNativeErrorMessage,
  type ChromeBrowserNativeReadyMessage,
  type ChromeBrowserRuntimeDescriptorV1,
} from "@ling-stack/contracts";
import {
  ChromeBrowserSessionError,
  chromeExtensionIdFromOrigin,
  type ChromeBrowserSessionController,
} from "./session-controller.js";
import { createChromeBrowserNativeSocketTransport } from "./transport.js";

export interface ChromeBrowserNativeBrokerHandle {
  start(): Promise<void>;
  close(): Promise<void>;
  descriptor(): ChromeBrowserRuntimeDescriptorV1 | undefined;
}

export function createChromeBrowserNativeBroker(input: {
  readonly controller: ChromeBrowserSessionController;
  readonly workspaceCwd: string;
  readonly descriptorPath?: string;
  readonly hostPath?: string;
  readonly now?: () => number;
  readonly token?: () => string;
  readonly descriptorTtlMs?: number;
  readonly descriptorRefreshMs?: number;
}): ChromeBrowserNativeBrokerHandle {
  const now = input.now ?? Date.now;
  const token = input.token ?? (() => randomBytes(32).toString("base64url"));
  const descriptorTtlMs = input.descriptorTtlMs ?? 12 * 60 * 60 * 1000;
  const descriptorRefreshMs = input.descriptorRefreshMs ?? 60 * 60 * 1000;
  let descriptor: ChromeBrowserRuntimeDescriptorV1 | undefined;
  let server: Server | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  const sockets = new Set<Socket>();

  const publish = async (): Promise<void> => {
    if (!descriptor) return;
    descriptor = createChromeBrowserRuntimeDescriptor({
      port: descriptor.port,
      daemonPid: descriptor.daemonPid,
      nowMs: now(),
      ttlMs: descriptorTtlMs,
      token: descriptor.token,
      generation: descriptor.generation,
    });
    await publishChromeBrowserRuntimeDescriptor(descriptor, input.descriptorPath);
  };

  return {
    async start() {
      if (server) return;
      const hostPath = input.hostPath ?? safeDefaultHostPath();
      let hostInstalled = false;
      if (hostPath) {
        try {
          hostInstalled = (await browserHostStatus({ hostPath })).installed;
        } catch {
          hostInstalled = false;
        }
      }
      input.controller.observeNativeState({
        cwd: input.workspaceCwd,
        hostState: hostInstalled ? "ready" : "missing",
      });
      server = createServer((socket) => {
        if (!isLoopbackAddress(socket.remoteAddress)) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        const transport = createChromeBrowserNativeSocketTransport(socket);
        const removeHelloListener = transport.onMessage((raw) => {
          removeHelloListener();
          void acceptHello(raw, transport).catch(() => {
            void sendError(transport, "native_protocol_invalid").finally(() => transport.close(4002, "native_protocol_invalid"));
          });
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          server!.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("chrome_native_broker_address_invalid");
      descriptor = createChromeBrowserRuntimeDescriptor({
        port: address.port,
        nowMs: now(),
        ttlMs: descriptorTtlMs,
        token: token(),
      });
      await publish();
      refreshTimer = setInterval(() => void publish().catch(() => undefined), descriptorRefreshMs);
    },
    async close() {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const activeServer = server;
      server = undefined;
      if (activeServer) {
        await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      }
      if (descriptor) await removeChromeBrowserRuntimeDescriptor(descriptor.generation, input.descriptorPath);
      descriptor = undefined;
    },
    descriptor: () => descriptor,
  };

  async function acceptHello(
    raw: string,
    transport: ReturnType<typeof createChromeBrowserNativeSocketTransport>,
  ): Promise<void> {
    let hello;
    try {
      hello = parseChromeBrowserNativeBrokerHello(JSON.parse(raw));
    } catch {
      await sendError(transport, "native_protocol_invalid");
      transport.close(4002, "native_protocol_invalid");
      return;
    }
    const extensionId = chromeExtensionIdFromOrigin(hello.origin.replace(/\/$/u, ""));
    if (!extensionId) {
      await sendError(transport, "origin_forbidden");
      transport.close(4003, "origin_forbidden");
      return;
    }
    if (!descriptor || descriptor.expiresAtEpochMs <= now() || !safeSecretEquals(hello.token, descriptor.token)) {
      await sendError(transport, "descriptor_invalid");
      transport.close(4003, "descriptor_invalid");
      return;
    }
    if (hello.hostVersion !== CHROME_BROWSER_NATIVE_HOST_VERSION
      || !isCompatibleChromeBrowserNativeVersion(hello.extensionVersion)) {
      input.controller.observeNativeState({
        cwd: input.workspaceCwd,
        hostState: hello.hostVersion === CHROME_BROWSER_NATIVE_HOST_VERSION ? "ready" : "incompatible",
        extensionState: "incompatible",
      });
      await sendError(transport, "version_incompatible");
      transport.close(4002, "version_incompatible");
      return;
    }
    if (hello.paused) {
      input.controller.observeNativeState({ cwd: input.workspaceCwd, hostState: "ready", extensionState: "paused" });
      await sendReady(transport, false, false);
      transport.close(1000, "extension_paused");
      return;
    }
    try {
      const migration = input.controller.acceptNativeTransport(input.workspaceCwd, extensionId, transport, {
        extensionVersion: hello.extensionVersion,
        ...(hello.browserVersion ? { browserVersion: hello.browserVersion } : {}),
      });
      await sendReady(transport, true, migration.migratedLegacyCredential);
    } catch (error) {
      await sendError(transport, error instanceof ChromeBrowserSessionError && error.code === "chrome_browser_disabled"
        ? "plugin_disabled"
        : "native_protocol_invalid");
      transport.close(4003, "native_connection_rejected");
    }
  }
}

async function sendReady(
  transport: ReturnType<typeof createChromeBrowserNativeSocketTransport>,
  connected: boolean,
  migratedLegacyCredential: boolean,
): Promise<void> {
  const message: ChromeBrowserNativeReadyMessage = {
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    type: "ready",
    connected,
    migratedLegacyCredential,
  };
  await transport.send(JSON.stringify(message));
}

async function sendError(
  transport: ReturnType<typeof createChromeBrowserNativeSocketTransport>,
  code: ChromeBrowserNativeErrorMessage["code"],
): Promise<void> {
  const message: ChromeBrowserNativeErrorMessage = { protocol: CHROME_BROWSER_NATIVE_PROTOCOL, type: "error", code };
  await transport.send(JSON.stringify(message)).catch(() => undefined);
}

function safeSecretEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function safeDefaultHostPath(): string | undefined {
  try {
    return defaultDevelopmentBrowserHostPath();
  } catch {
    return undefined;
  }
}
