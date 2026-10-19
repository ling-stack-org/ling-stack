import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { client, methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { NativeConnectionError } from "./codex-connection.js";
import { createAcpProbeStream } from "./acp-probe-transport.js";

export interface AcpConnectionState {
  readonly connection: "connected";
  readonly authentication: "required" | "configured_unverified" | "provider_managed";
}

/** Owns these one-use streams; the caller owns timeout and native child reaping. */
export async function inspectAcpConnection(options: {
  readonly engineId: "kimi-acp" | "openclaw-acp";
  readonly input: Writable;
  readonly output: Readable;
  readonly expectedVersion: string;
  readonly signal: AbortSignal;
  readonly beginLocalCleanup?: () => void;
}): Promise<AcpConnectionState> {
  if (options.signal.aborted) throw new NativeConnectionError("cancelled");
  if (options.input.destroyed || options.input.writableEnded || options.output.destroyed || options.output.readableEnded) {
    throw new NativeConnectionError("process_failed");
  }
  const closed = Promise.allSettled([finished(options.input, { cleanup: true }), finished(options.output, { cleanup: true })]);
  const transport = createAcpProbeStream(options.input, options.output);
  const connection = client({ name: `ling-${options.engineId}-connection` }).connect(transport.stream);
  let failure: NativeConnectionError | undefined;
  let candidate: AcpConnectionState | undefined;
  let cleaning = false;
  const aborted = (): void => connection.close(new NativeConnectionError("cancelled"));
  const failed = (): void => { failure ??= new NativeConnectionError("process_failed"); connection.close(failure); };
  const inputClosed = (): void => { if (!cleaning) failed(); };
  options.signal.addEventListener("abort", aborted, { once: true });
  options.input.on("error", failed).on("finish", inputClosed).on("close", inputClosed);
  options.output.on("error", failed);
  try {
    if (options.signal.aborted) aborted();
    const initialization = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      clientInfo: { name: "ling-stack", version: "0.1.2-alpha.1" },
    });
    const isKimi = options.engineId === "kimi-acp";
    if (initialization.protocolVersion !== PROTOCOL_VERSION || initialization.agentInfo?.name !== (isKimi ? "Kimi Code CLI" : "openclaw-acp")
      || initialization.agentInfo.version !== options.expectedVersion || !record(initialization.agentCapabilities)
      || !Array.isArray(initialization.authMethods)
      || (isKimi ? initialization.authMethods.filter(method => method.id === "login" && "type" in method && method.type === "terminal").length !== 1
        : initialization.authMethods.length !== 0)) {
      throw new NativeConnectionError("protocol_error");
    }
    if (isKimi) {
      try {
        const authentication = await connection.agent.request(methods.agent.authenticate, { methodId: "login" });
        if (!record(authentication)) throw new NativeConnectionError("protocol_error");
        candidate = { connection: "connected", authentication: "configured_unverified" };
      } catch (error) {
        if (error instanceof RequestError && error.code === -32000) candidate = { connection: "connected", authentication: "required" };
        else throw error;
      }
    } else {
      // The pinned bridge serves initialize only after Gateway hello; model auth stays upstream.
      candidate = { connection: "connected", authentication: "provider_managed" };
    }
    await transport.flush(options.signal);
  } catch (error) {
    failure ??= error instanceof NativeConnectionError ? error : new NativeConnectionError("protocol_error");
  } finally {
    cleaning = true;
    options.beginLocalCleanup?.();
    options.signal.removeEventListener("abort", aborted);
    options.input.destroy();
    options.output.destroy();
    connection.close();
    await closed;
    await connection.closed;
    options.input.off("error", failed).off("finish", inputClosed).off("close", inputClosed);
    options.output.off("error", failed);
  }
  if (options.signal.aborted) throw new NativeConnectionError("cancelled");
  if (failure) throw failure;
  if (transport.failure) throw transport.failure;
  return candidate!;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
