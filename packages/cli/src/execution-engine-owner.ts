import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { ExecutionEngineHostAuthority } from "@ling-stack/core/execution-engine-host-authority";
import type { ExecutionEngineHost } from "@ling-stack/daemon/dist/execution-engine-host.js";
import { CliError } from "./errors.js";

/** Foreground ownership only. No independent process can recover this authority from disk. */
export async function runOwnedEngineDaemon(options: {
  readonly daemonUrl: string;
  readonly cwd: string;
  readonly authorize: (authority: ExecutionEngineHostAuthority, signal: AbortSignal) => Promise<void>;
}): Promise<number> {
  const endpoint = localEndpoint(options.daemonUrl);
  const abort = new AbortController();
  const stopped = new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
  const stop = (): void => abort.abort();
  const terminal = createInterface({ input: process.stdin, terminal: false });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  terminal.once("close", stop);
  let daemon: ExecutionEngineHost | undefined;
  let startup: Promise<void> | undefined;
  let issuance: Promise<void> | undefined;
  let authority: ExecutionEngineHostAuthority | undefined;
  let startupTimeout: NodeJS.Timeout | undefined;
  const issue = async (): Promise<void> => {
    if (!authority || issuance || abort.signal.aborted) return;
    issuance = options.authorize(authority, abort.signal);
    try { await issuance; } finally { issuance = undefined; }
  };
  try {
    const { createExecutionEngineHost } = await import("@ling-stack/daemon/dist/execution-engine-host.js");
    if (abort.signal.aborted) return 0;
    // Keep the instance before start so a bind/startup failure still has an owner to close it.
    daemon = createExecutionEngineHost({ host: endpoint.hostname.replace(/^\[|\]$/g, ""),
      port: Number(endpoint.port || "80"), defaultWorkspaceCwd: options.cwd });
    startup = daemon.start();
    const timeout = new Promise<never>((_, reject) => {
      startupTimeout = setTimeout(() => reject(new CliError(1, "engine_daemon_start_timeout", "The foreground daemon did not finish starting.")), 20_000);
    });
    await Promise.race([startup, stopped, timeout]);
    clearTimeout(startupTimeout);
    if (abort.signal.aborted) return 0;
    authority = { schemaVersion: 1, instanceId: randomUUID(), baseUrl: endpoint.origin,
      pid: process.pid, credentials: daemon.engineManagement };
    daemon.server.once("close", stop);
    console.log(`Daemon: ${endpoint.origin}\nKeep this terminal open. Press Enter for a new code; Ctrl+C stops this daemon.`);
    await Promise.race([issue(), stopped]);
    if (abort.signal.aborted) return 0;
    terminal.on("line", () => { void issue().catch(() => {
      if (!abort.signal.aborted) console.error("Engine authorization failed. Press Enter to retry.");
    }); });
    await stopped;
    return 0;
  } catch (error) {
    if (abort.signal.aborted) return 0;
    if (error instanceof CliError) throw error;
    throw new CliError(1, "engine_daemon_start_failed", "Cannot start the foreground daemon. Check that its local port is free; existing daemons are not reused.");
  } finally {
    stop();
    clearTimeout(startupTimeout);
    authority = undefined;
    terminal.close();
    process.stdin.pause();
    // This module runs only as the foreground CLI owner; an unresponsive startup cannot outlive it.
    const deadline = setTimeout(() => {
      console.error("engine_daemon_stop_timeout");
      process.exit(1);
    }, 5000);
    try {
      await startup?.catch(() => undefined);
      await issuance?.catch(() => undefined);
      await daemon?.stop();
    } finally {
      clearTimeout(deadline);
      for (const signal of signals) process.off(signal, stop);
      terminal.removeAllListeners();
    }
  }
}

function localEndpoint(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port === "0") throw new Error();
    return url;
  } catch {
    throw new CliError(2, "engine_daemon_url_invalid", "Foreground engine setup requires an HTTP loopback daemon URL without credentials, a path or query.");
  }
}
