import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";

const CLIENT_PROTOCOL_VERSION = "2025-11-25";
const SERVER_PROTOCOL_VERSION = "2025-06-18";
const MAX_MCP_LINE_BYTES = 4 * 1024 * 1024;
const MAX_MCP_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_STDERR_BYTES = 16 * 1024;
const MAX_HELPER_STDOUT_BYTES = 16 * 1024;
const INPUT_FENCE_PROTOCOL_VERSION = 1;

export const DARWIN_LOCKED_CONTROL_PROBE_ADAPTER_VERSION = "darwin-attended-probe-v2";
export const DARWIN_LOCKED_CONTROL_PROBE_WINDOW_TITLE = "Ling Locked Control Probe";
export const DARWIN_LOCKED_CONTROL_PROBE_BUTTON_LABEL = "Acknowledge probe";

export class LockedControlProbeFailure extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "LockedControlProbeFailure";
    this.reason = reason;
  }
}

export class EmbeddedCuaDriverClient {
  constructor({ binaryPath, environment, cwd, timeoutMs = 30_000 }) {
    this.binaryPath = binaryPath;
    this.environment = environment;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.child = undefined;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stdoutBytes = 0;
    this.stderr = "";
    this.closed = false;
  }

  async start() {
    if (this.child) throw new Error("locked_control_probe_provider_already_started");
    const child = spawn(
      this.binaryPath,
      ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"],
      {
        cwd: this.cwd,
        env: this.environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_PROVIDER_STDERR_BYTES);
    });
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      this.closed = true;
      const diagnostic = this.stderr.trim().replaceAll("\n", " ").slice(-512);
      this.#failAll(new Error(
        `locked_control_probe_provider_exited:code=${code ?? "none"}:signal=${signal ?? "none"}`
          + (diagnostic ? `:${diagnostic}` : ""),
      ));
    });
    child.stdin.once("error", (error) => {
      if (error.code !== "EPIPE") this.#failAll(error);
    });

    const initialized = await this.request("initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ling-locked-control-attended-probe", version: "1" },
    });
    if (initialized?.protocolVersion !== SERVER_PROTOCOL_VERSION
      || initialized?.serverInfo?.name !== "cua-driver"
      || initialized?.serverInfo?.version !== "0.8.3") {
      throw new Error("locked_control_probe_provider_identity_mismatch");
    }
    this.notify("notifications/initialized", {});
    return initialized;
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    if (!this.child || this.closed) {
      return Promise.reject(new Error("locked_control_probe_provider_not_running"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`locked_control_probe_provider_request_timeout:${method}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async callTool(name, args, timeoutMs = this.timeoutMs) {
    const response = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    if (response?.isError === true) {
      const text = Array.isArray(response.content)
        ? response.content.map((entry) => entry?.text ?? "").join("\n")
        : "";
      throw new Error(`locked_control_probe_tool_error:${name}:${text.slice(0, 512)}`);
    }
    return response;
  }

  notify(method, params) {
    if (!this.child || this.closed) throw new Error("locked_control_probe_provider_not_running");
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }

  #send(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`, "utf8");
  }

  #consumeStdout(chunk) {
    this.stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (this.stdoutBytes > MAX_MCP_STDOUT_BYTES) {
      this.#failAll(new Error("locked_control_probe_provider_stdout_too_large"));
      this.child?.kill("SIGKILL");
      return;
    }
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_MCP_LINE_BYTES) {
        this.#failAll(new Error("locked_control_probe_provider_line_too_large"));
        this.child?.kill("SIGKILL");
        return;
      }
      if (line) this.#consumeMessage(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  #consumeMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#failAll(new Error("locked_control_probe_provider_non_json_stdout"));
      this.child?.kill("SIGKILL");
      return;
    }
    if (!message || message.jsonrpc !== "2.0" || !Number.isSafeInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (Object.hasOwn(message, "error")) {
      pending.reject(new Error(`locked_control_probe_provider_jsonrpc_error:${JSON.stringify(message.error)}`));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      pending.reject(new Error("locked_control_probe_provider_response_invalid"));
      return;
    }
    pending.resolve(message.result);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createManagedProviderEnvironment({
  baseEnvironment,
  stateHome,
  hostPid,
  childNonce,
  inputFence,
}) {
  const environment = {};
  for (const key of [
    "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
  ]) {
    if (typeof baseEnvironment[key] === "string") environment[key] = baseEnvironment[key];
  }
  return {
    ...environment,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_LING_MANAGED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: "com.lingstack.desktop",
    CUA_DRIVER_HOST_PID: String(hostPid),
    CUA_DRIVER_CHILD_INSTANCE_NONCE: childNonce,
    CUA_DRIVER_LEASE_GENERATION: "1",
    CUA_DRIVER_INPUT_FENCE_PORT: String(inputFence.port),
    CUA_DRIVER_INPUT_FENCE_TOKEN: inputFence.token,
    CUA_DRIVER_INPUT_EPOCH: String(inputFence.epoch),
    CUA_DRIVER_STATE_HOME: stateHome,
    CUA_DRIVER_TELEMETRY_HOME: `${stateHome}/telemetry`,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
  };
}

export async function createInputFenceConfiguration(epoch = 1) {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new TypeError("locked_control_probe_input_epoch_invalid");
  }
  const port = await reserveLoopbackPort();
  return Object.freeze({ port, token: randomBytes(32).toString("hex"), epoch });
}

export async function fenceProviderInput(configuration, timeoutMs = 500) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let bytes = Buffer.alloc(0);
    const socket = connect({ host: "127.0.0.1", port: configuration.port });
    const timer = setTimeout(() => finish(new Error("locked_control_probe_input_fence_timeout")), timeoutMs);
    timer.unref?.();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        protocolVersion: INPUT_FENCE_PROTOCOL_VERSION,
        token: configuration.token,
        command: "fence",
        expectedEpoch: configuration.epoch,
        timeoutMs,
      })}\n`);
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.byteLength > 4_096) {
        finish(new Error("locked_control_probe_input_fence_response_too_large"));
        return;
      }
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
      } catch {
        finish(new Error("locked_control_probe_input_fence_response_invalid"));
        return;
      }
      if (response?.protocolVersion !== 1
        || response?.status !== "fenced"
        || response?.previousEpoch !== configuration.epoch
        || response?.nextEpoch !== configuration.epoch + 1
        || response?.activeInputs !== 0) {
        finish(new Error("locked_control_probe_input_fence_response_invalid"));
        return;
      }
      finish(undefined, response);
    });
    socket.once("error", () => finish(new Error("locked_control_probe_input_fence_connection_failed")));
    socket.once("end", () => finish(new Error("locked_control_probe_input_fence_response_invalid")));
  });
}

export async function readNativeSession(helperPath, timeoutMs = 5_000) {
  const result = await invokeJsonProcess(
    helperPath,
    { command: "session", platform: "darwin" },
    timeoutMs,
  );
  if (!result || result.platform !== "darwin"
    || !/^[a-f0-9]{64}$/u.test(result.sessionBindingDigest)
    || typeof result.sessionActive !== "boolean"
    || typeof result.sessionLocked !== "boolean") {
    throw new Error("locked_control_probe_native_session_invalid");
  }
  return result;
}

export function extractStructuredContent(toolResult) {
  if (isRecord(toolResult?.structuredContent)) return toolResult.structuredContent;
  const text = Array.isArray(toolResult?.content)
    ? toolResult.content.find((entry) => entry?.type === "text")?.text
    : undefined;
  if (typeof text !== "string") return undefined;
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function selectProbeWindow(toolResult, expectedPid) {
  const value = extractStructuredContent(toolResult);
  const windows = Array.isArray(value?.windows)
    ? value.windows
    : Array.isArray(value) ? value : undefined;
  if (!windows) return undefined;
  const matches = windows.filter((window) => isRecord(window)
    && window.title === DARWIN_LOCKED_CONTROL_PROBE_WINDOW_TITLE
    && Number.isSafeInteger(window.window_id)
    && window.pid === expectedPid);
  if (matches.length !== 1) return undefined;
  return matches[0];
}

export function selectProbeButton(toolResult) {
  const value = extractStructuredContent(toolResult);
  const elements = Array.isArray(value?.elements) ? value.elements : [];
  const matches = elements.filter((element) => isRecord(element)
    && element.role === "AXButton"
    && isProbeButtonLabel(element.label ?? element.title));
  if (matches.length !== 1) return undefined;
  const [element] = matches;
  if (!Number.isSafeInteger(element.element_index)) return undefined;
  return {
    elementIndex: element.element_index,
    ...(typeof element.element_token === "string" && element.element_token
      ? { elementToken: element.element_token }
      : {}),
  };
}

function isProbeButtonLabel(value) {
  return value === DARWIN_LOCKED_CONTROL_PROBE_BUTTON_LABEL
    || (typeof value === "string" && /^Acknowledged [1-9]\d*$/u.test(value));
}

export function hasProbeStatus(toolResult, expectedStatus) {
  const value = extractStructuredContent(toolResult);
  const elements = Array.isArray(value?.elements) ? value.elements : [];
  return elements.some((element) => isRecord(element)
    && (element.label === expectedStatus
      || element.title === expectedStatus
      || element.value === expectedStatus));
}

export function readScreenshotCenter(toolResult) {
  const value = extractStructuredContent(toolResult);
  if (!Number.isSafeInteger(value?.screenshot_width)
    || value.screenshot_width <= 0
    || !Number.isSafeInteger(value?.screenshot_height)
    || value.screenshot_height <= 0) {
    return undefined;
  }
  return Object.freeze({
    x: value.screenshot_width / 2,
    y: value.screenshot_height / 2,
  });
}

export function assertPngToolResult(toolResult) {
  const image = Array.isArray(toolResult?.content)
    ? toolResult.content.find((entry) => entry?.type === "image")
    : undefined;
  if (!image
    || image.mimeType !== "image/png"
    || typeof image.data !== "string"
    || image.data.length === 0) {
    const contentShape = Array.isArray(toolResult?.content)
      ? toolResult.content.map((entry) => ({
          type: entry?.type,
          mimeType: entry?.mimeType,
          dataLength: typeof entry?.data === "string" ? entry.data.length : undefined,
          textLength: typeof entry?.text === "string" ? entry.text.length : undefined,
        }))
      : [];
    const structuredKeys = isRecord(toolResult?.structuredContent)
      ? Object.keys(toolResult.structuredContent).sort()
      : [];
    const note = typeof toolResult?.structuredContent?._note === "string"
      ? toolResult.structuredContent._note.slice(0, 512)
      : undefined;
    throw new Error(
      `locked_control_probe_screenshot_missing:content=${JSON.stringify(contentShape)}`
        + `:structuredKeys=${JSON.stringify(structuredKeys)}`
        + (note ? `:note=${JSON.stringify(note)}` : ""),
    );
  }
  const data = Buffer.from(image.data, "base64");
  if (data.byteLength < 64
    || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("locked_control_probe_screenshot_not_png");
  }
}

export function parseProbeAppEvent(line, expectedNonce) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.nonce !== expectedNonce
    || (value.event !== "ready" && value.event !== "input_acknowledged")) {
    return undefined;
  }
  const keys = Object.keys(value).sort();
  if (value.event === "ready") {
    return keys.join(",") === "event,nonce,schemaVersion" ? value : undefined;
  }
  return keys.join(",") === "event,nonce,schemaVersion,sequence"
    && Number.isSafeInteger(value.sequence)
    && value.sequence > 0
    ? value
    : undefined;
}

export function createFeasibilityEvidence({
  proofs,
  reason,
  helperSha256,
  providerSha256,
  osVersion,
  observedAt = new Date().toISOString(),
}) {
  const allProofs = proofs.sameUserSessionBound
    && proofs.captureReadyWhileLocked
    && proofs.inputAcknowledgedWhileLocked
    && proofs.secureSurfaceExcluded;
  if (allProofs && reason) throw new TypeError("locked_control_probe_candidate_cannot_have_reason");
  if (!allProofs && !reason) throw new TypeError("locked_control_probe_unsupported_requires_reason");
  return Object.freeze({
    schemaVersion: 1,
    platform: "darwin",
    result: allProofs ? "feasible_candidate" : "unsupported",
    ...(reason ? { reason } : {}),
    sameUserSessionBound: proofs.sameUserSessionBound,
    captureReadyWhileLocked: proofs.captureReadyWhileLocked,
    inputAcknowledgedWhileLocked: proofs.inputAcknowledgedWhileLocked,
    secureSurfaceExcluded: proofs.secureSurfaceExcluded,
    providerIntegrationMode: "embedded-stdio",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    helperSha256,
    providerSha256,
    adapterVersion: DARWIN_LOCKED_CONTROL_PROBE_ADAPTER_VERSION,
    osVersion,
    observedAt,
  });
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function reserveLoopbackPort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string" || address.family !== "IPv4") {
    throw new Error("locked_control_probe_input_fence_port_invalid");
  }
  return address.port;
}

async function invokeJsonProcess(executable, request, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("locked_control_probe_native_helper_timeout")), timeoutMs);
    timer.unref?.();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value);
    };
    child.once("error", finish);
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAX_HELPER_STDOUT_BYTES) {
        finish(new Error("locked_control_probe_native_helper_output_too_large"));
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error("locked_control_probe_native_helper_failed"));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout.toString("utf8")));
      } catch {
        finish(new Error("locked_control_probe_native_helper_json_invalid"));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
