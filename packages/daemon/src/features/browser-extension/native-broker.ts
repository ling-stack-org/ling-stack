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

interface BrokerLifecycle {
  readonly epoch: number;
  readonly sockets: Set<Socket>;
  readonly failures: unknown[];
  server?: Server;
  descriptor?: ChromeBrowserRuntimeDescriptorV1;
  timer?: NodeJS.Timeout;
  startPromise?: Promise<void>;
  refreshPromise?: Promise<void>;
  closePromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
  cleanupFailureRecorded: boolean;
  closing: boolean;
  closed: boolean;
  superseded: boolean;
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
  let epoch = 0;
  let current: BrokerLifecycle | undefined;
  // A timer has no awaiting caller. Preserve its failure even if a subsequent
  // successful start replaces current before anyone calls close(). Failed starts
  // already report through their returned promise and do not enter this set.
  const deferredRefreshFailures = new Set<BrokerLifecycle>();

  function stopRefresh(lifecycle: BrokerLifecycle): void {
    if (lifecycle.timer) clearInterval(lifecycle.timer);
    lifecycle.timer = undefined;
  }

  async function closeServer(activeServer: Server | undefined): Promise<void> {
    if (!activeServer || !activeServer.listening) return;
    await new Promise<void>((resolve, reject) => activeServer.close((error) => error ? reject(error) : resolve()));
  }

  function cleanup(lifecycle: BrokerLifecycle): Promise<void> {
    if (lifecycle.cleanupPromise) return lifecycle.cleanupPromise;
    lifecycle.cleanupPromise = (async () => {
      stopRefresh(lifecycle);
      for (const socket of lifecycle.sockets) socket.destroy();
      lifecycle.sockets.clear();
      const failures: unknown[] = [];
      try { await closeServer(lifecycle.server); }
      catch (error) { failures.push(error); }
      lifecycle.server = undefined;
      try {
        if (lifecycle.descriptor) {
          await removeChromeBrowserRuntimeDescriptor(lifecycle.descriptor.generation, input.descriptorPath);
        }
      } catch (error) { failures.push(error); }
      lifecycle.descriptor = undefined;
      throwFailures(failures, "chrome_native_broker_cleanup_failed");
    })();
    return lifecycle.cleanupPromise;
  }

  async function cleanupAndRecord(lifecycle: BrokerLifecycle): Promise<void> {
    try { await cleanup(lifecycle); }
    catch (error) {
      if (!lifecycle.cleanupFailureRecorded) {
        lifecycle.cleanupFailureRecorded = true;
        lifecycle.failures.push(error);
      }
    }
  }

  async function startLifecycle(lifecycle: BrokerLifecycle): Promise<void> {
    try {
      const hostPath = input.hostPath ?? safeDefaultHostPath();
      let hostInstalled = false;
      if (hostPath) {
        try { hostInstalled = (await browserHostStatus({ hostPath })).installed; }
        catch { hostInstalled = false; }
      }
      if (lifecycle.closing || current !== lifecycle) return;
      input.controller.observeNativeState({
        cwd: input.workspaceCwd,
        hostState: hostInstalled ? "ready" : "missing",
      });
      const activeServer = createServer((socket) => {
        if (lifecycle.closing || !isLoopbackAddress(socket.remoteAddress)) {
          socket.destroy();
          return;
        }
        lifecycle.sockets.add(socket);
        socket.once("close", () => lifecycle.sockets.delete(socket));
        const transport = createChromeBrowserNativeSocketTransport(socket);
        const removeHelloListener = transport.onMessage((raw) => {
          removeHelloListener();
          void acceptHello(lifecycle, raw, transport).catch(() => {
            void sendError(transport, "native_protocol_invalid").finally(() => transport.close(4002, "native_protocol_invalid"));
          });
        });
      });
      lifecycle.server = activeServer;
      await new Promise<void>((resolve, reject) => {
        activeServer.once("error", reject);
        activeServer.listen(0, "127.0.0.1", () => {
          activeServer.off("error", reject);
          resolve();
        });
      });
      if (lifecycle.closing || current !== lifecycle) return;
      const address = activeServer.address();
      if (!address || typeof address === "string") throw new Error("chrome_native_broker_address_invalid");
      lifecycle.descriptor = createChromeBrowserRuntimeDescriptor({
        port: address.port,
        nowMs: now(),
        ttlMs: descriptorTtlMs,
        token: token(),
      });
      await publishChromeBrowserRuntimeDescriptor(lifecycle.descriptor, input.descriptorPath);
      if (lifecycle.closing || current !== lifecycle) return;
      lifecycle.timer = setInterval(() => { void refresh(lifecycle); }, descriptorRefreshMs);
    } catch (error) {
      lifecycle.failures.push(error);
      lifecycle.closing = true;
      // This task never waits on its own start/close promise.
      await cleanupAndRecord(lifecycle);
      lifecycle.closed = true;
      throwFailures(lifecycle.failures, "chrome_native_broker_start_and_cleanup_failed");
    }
  }

  function refresh(lifecycle: BrokerLifecycle): Promise<void> {
    if (lifecycle.closing || lifecycle.superseded || current !== lifecycle || !lifecycle.descriptor) return Promise.resolve();
    if (lifecycle.refreshPromise) return lifecycle.refreshPromise;
    const previous = lifecycle.descriptor;
    lifecycle.refreshPromise = (async () => {
      try {
        const candidate = createChromeBrowserRuntimeDescriptor({
          port: previous.port,
          daemonPid: previous.daemonPid,
          nowMs: now(),
          ttlMs: descriptorTtlMs,
          token: previous.token,
          generation: previous.generation,
        });
        const result = await publishChromeBrowserRuntimeDescriptor(candidate, input.descriptorPath, {
          expectedGeneration: previous.generation,
        });
        if (result === "superseded") {
          lifecycle.superseded = true;
          stopRefresh(lifecycle);
        } else if (!lifecycle.closing && current === lifecycle) {
          lifecycle.descriptor = candidate;
        }
      } catch (error) {
        lifecycle.failures.push(error);
        deferredRefreshFailures.add(lifecycle);
        lifecycle.closing = true;
        await cleanupAndRecord(lifecycle);
        lifecycle.closed = true;
        // Timer failures remain observable through close(), including cleanup
        // errors. A failed callback only ever cleans its captured lifecycle.
      } finally {
        lifecycle.refreshPromise = undefined;
      }
    })();
    return lifecycle.refreshPromise;
  }

  function start(): Promise<void> {
    const active = current;
    if (active && !active.closed) {
      if (active.closing && active.closePromise) return active.closePromise.then(start);
      if (active.closing && active.refreshPromise) return active.refreshPromise.then(start);
      return active.startPromise ?? Promise.resolve();
    }
    const lifecycle: BrokerLifecycle = { epoch: ++epoch, sockets: new Set(), failures: [],
      cleanupFailureRecorded: false, closing: false, closed: false, superseded: false };
    current = lifecycle;
    lifecycle.startPromise = startLifecycle(lifecycle);
    return lifecycle.startPromise;
  }

  function close(): Promise<void> {
    const lifecycle = current;
    if (!lifecycle) return Promise.resolve();
    if (lifecycle.closePromise) return lifecycle.closePromise;
    // Synchronous admission fence precedes every await.
    lifecycle.closing = true;
    stopRefresh(lifecycle);
    lifecycle.closePromise = (async () => {
      // Failure handlers have already retained their errors. Settle both tasks
      // before cleanup; none of their handlers waits for this close promise.
      await Promise.allSettled([lifecycle.startPromise, lifecycle.refreshPromise]);
      await cleanupAndRecord(lifecycle);
      lifecycle.closed = true;
      const failures = [...lifecycle.failures];
      for (const failed of deferredRefreshFailures) {
        if (failed !== lifecycle) failures.push(...failed.failures);
        deferredRefreshFailures.delete(failed);
      }
      throwFailures(failures, "chrome_native_broker_shutdown_failed");
    })();
    return lifecycle.closePromise;
  }

  return {
    start,
    close,
    descriptor: () => current?.descriptor,
  };

  async function acceptHello(
    lifecycle: BrokerLifecycle,
    raw: string,
    transport: ReturnType<typeof createChromeBrowserNativeSocketTransport>,
  ): Promise<void> {
    const descriptor = lifecycle.descriptor;
    if (lifecycle.closing) {
      transport.close(1000, "broker_closing");
      return;
    }
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
      if (migration.migratedLegacyCredential) {
        input.controller.commitNativeCredentialMigration(input.workspaceCwd);
      }
    } catch (error) {
      await sendError(transport, error instanceof ChromeBrowserSessionError && error.code === "chrome_browser_disabled"
        ? "plugin_disabled"
        : "native_protocol_invalid");
      transport.close(4003, "native_connection_rejected");
    }
  }
}

function throwFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
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
