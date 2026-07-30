import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";

export const CUA_DRIVER_INPUT_FENCE_PROTOCOL_VERSION = 1 as const;
export const CUA_DRIVER_INPUT_FENCE_HARD_DEADLINE_MS = 100 as const;
const CUA_DRIVER_INPUT_FENCE_MAX_RESPONSE_BYTES = 4_096;

export interface CuaDriverInputFenceConfiguration {
  readonly port: number;
  readonly token: string;
  readonly epoch: number;
}

export interface CuaDriverInputFenceAcknowledgement {
  readonly protocolVersion: 1;
  readonly status: "fenced";
  readonly previousEpoch: number;
  readonly nextEpoch: number;
  readonly activeInputs: 0;
}

export type CuaDriverInputFenceErrorCode =
  | "configuration_invalid"
  | "connection_failed"
  | "response_invalid"
  | "timeout";

export class CuaDriverInputFenceError extends Error {
  constructor(readonly fenceCode: CuaDriverInputFenceErrorCode) {
    super(`cua_driver_input_fence_${fenceCode}`);
    this.name = "CuaDriverInputFenceError";
  }
}

/**
 * Reserve a generation-specific loopback endpoint without giving the provider
 * access to any Desktop bearer authority. Closing this temporary listener does
 * leave a small bind race, but a squatting process has no token and can only
 * make startup fail closed.
 */
export async function createCuaDriverInputFenceConfiguration(
  epoch: number,
): Promise<CuaDriverInputFenceConfiguration> {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new CuaDriverInputFenceError("configuration_invalid");
  }
  const port = await reserveLoopbackPort();
  return Object.freeze({
    port,
    token: randomBytes(32).toString("hex"),
    epoch,
  });
}

/**
 * Close provider input admission and accept only an exact, drained epoch ack.
 * The deadline covers connect, provider drain and response parsing.
 */
export function fenceCuaDriverInput(
  configuration: CuaDriverInputFenceConfiguration,
  timeoutMs: number = CUA_DRIVER_INPUT_FENCE_HARD_DEADLINE_MS,
): Promise<CuaDriverInputFenceAcknowledgement> {
  assertConfiguration(configuration);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_000) {
    return Promise.reject(new CuaDriverInputFenceError("configuration_invalid"));
  }
  return new Promise<CuaDriverInputFenceAcknowledgement>((resolveFence, rejectFence) => {
    let settled = false;
    let responseBytes = Buffer.alloc(0);
    let deadline: NodeJS.Timeout | undefined;
    const socket = createConnection({ host: "127.0.0.1", port: configuration.port });
    const finish = (
      result: { readonly acknowledgement: CuaDriverInputFenceAcknowledgement }
        | { readonly error: CuaDriverInputFenceError },
    ): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      socket.destroy();
      if ("acknowledgement" in result) resolveFence(result.acknowledgement);
      else rejectFence(result.error);
    };
    // net.Socket timeouts measure inactivity and are reset by every received
    // chunk. The security contract is an absolute connect + drain + parse
    // deadline, so a provider cannot extend it by trickling response bytes.
    deadline = setTimeout(
      () => finish({ error: new CuaDriverInputFenceError("timeout") }),
      timeoutMs,
    );
    deadline.unref?.();
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        protocolVersion: CUA_DRIVER_INPUT_FENCE_PROTOCOL_VERSION,
        token: configuration.token,
        command: "fence",
        expectedEpoch: configuration.epoch,
        timeoutMs,
      })}\n`, "utf8", (error) => {
        if (error) finish({ error: new CuaDriverInputFenceError("connection_failed") });
      });
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled || chunk.byteLength === 0) return;
      responseBytes = Buffer.concat([responseBytes, chunk]);
      if (responseBytes.byteLength > CUA_DRIVER_INPUT_FENCE_MAX_RESPONSE_BYTES) {
        finish({ error: new CuaDriverInputFenceError("response_invalid") });
        return;
      }
      const newline = responseBytes.indexOf(0x0a);
      if (newline < 0) return;
      const trailing = responseBytes.subarray(newline + 1);
      if (trailing.some((byte) => byte !== 0x0d && byte !== 0x0a)) {
        finish({ error: new CuaDriverInputFenceError("response_invalid") });
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(responseBytes.subarray(0, newline).toString("utf8"));
      } catch {
        finish({ error: new CuaDriverInputFenceError("response_invalid") });
        return;
      }
      const acknowledgement = parseAcknowledgement(value, configuration.epoch);
      finish(acknowledgement
        ? { acknowledgement }
        : { error: new CuaDriverInputFenceError("response_invalid") });
    });
    socket.once("error", () => finish({ error: new CuaDriverInputFenceError("connection_failed") }));
    socket.once("end", () => {
      if (!settled) finish({ error: new CuaDriverInputFenceError("response_invalid") });
    });
  });
}

function parseAcknowledgement(
  value: unknown,
  expectedEpoch: number,
): CuaDriverInputFenceAcknowledgement | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  const expectedKeys = ["activeInputs", "nextEpoch", "previousEpoch", "protocolVersion", "status"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return undefined;
  }
  if (value.protocolVersion !== 1
    || value.status !== "fenced"
    || value.previousEpoch !== expectedEpoch
    || value.nextEpoch !== expectedEpoch + 1
    || value.activeInputs !== 0) {
    return undefined;
  }
  return value as unknown as CuaDriverInputFenceAcknowledgement;
}

function assertConfiguration(configuration: CuaDriverInputFenceConfiguration): void {
  if (!Number.isSafeInteger(configuration.port)
    || configuration.port <= 0
    || configuration.port > 65_535
    || !Number.isSafeInteger(configuration.epoch)
    || configuration.epoch <= 0
    || !/^[a-f0-9]{64}$/u.test(configuration.token)) {
    throw new CuaDriverInputFenceError("configuration_invalid");
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.family !== "IPv4") {
      throw new CuaDriverInputFenceError("configuration_invalid");
    }
    return address.port;
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
