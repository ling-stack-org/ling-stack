import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";

const PROTOCOL_VERSION = "2025-06-18";
const HEALTH_SCHEMA_VERSION = "1";

/**
 * Run the built provider through its real embedded stdio MCP boundary.
 *
 * The returned object deliberately omits the child nonce, host/provider PIDs
 * and generation. Those values are runtime-only identity material and must
 * never enter a checked-in or uploaded attestation.
 */
export async function probeCuaDriverProvider({
  binaryPath,
  platform,
  stateHome,
  hostPid = process.pid,
  timeoutMs = 30_000,
  spawnProcess = spawn,
}) {
  if (!binaryPath || !stateHome) throw new TypeError("binaryPath and stateHome are required");
  if (platform !== "darwin" && platform !== "win32-x64") {
    throw new TypeError(`unsupported provider platform: ${platform}`);
  }
  if (typeof spawnProcess !== "function") throw new TypeError("spawnProcess must be a function");
  await mkdir(stateHome, { recursive: true });
  const nonce = randomBytes(24).toString("hex");
  const environment = {
    ...process.env,
    CUA_DRIVER_LING_MANAGED: "1",
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_STATE_HOME: stateHome,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    CUA_DRIVER_HOST_PID: String(hostPid),
    CUA_DRIVER_CHILD_INSTANCE_NONCE: nonce,
    CUA_DRIVER_LEASE_GENERATION: "1",
  };
  const child = spawnProcess(binaryPath, ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const responses = new Map();
  let stdoutBuffer = "";
  let stdinClosed = false;
  let settled = false;
  let timer;

  const result = await new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* best effort */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finishIfReady = () => {
      const required = platform === "win32-x64" ? [1, 2, 3, 4] : [1, 2, 3];
      if (!required.every((id) => responses.has(id)) || stdinClosed) return;
      stdinClosed = true;
      child.stdin.end();
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (!settled && !stdinClosed) {
        fail(new Error(`provider exited before probe completed: code=${code} signal=${signal ?? "none"}`));
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 && code !== null) {
        fail(new Error(`provider probe exited with code ${code} signal=${signal ?? "none"}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        const initialize = responses.get(1)?.result;
        const tools = responses.get(2)?.result;
        const health = responses.get(3)?.result;
        const readiness = responses.get(4)?.result;
        if (responses.get(1)?.error || responses.get(2)?.error || responses.get(3)?.error || responses.get(4)?.error) {
          throw new Error("provider probe returned a JSON-RPC error");
        }
        if (initialize?.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(`provider protocol version mismatch: ${initialize?.protocolVersion ?? "missing"}`);
        }
        const healthSchema = health?.structuredContent?.schema_version
          ?? parseHealthText(health)?.schema_version;
        if (String(healthSchema) !== HEALTH_SCHEMA_VERSION) {
          throw new Error(`provider health schema mismatch: ${healthSchema ?? "missing"}`);
        }
        if (platform === "win32-x64") validateManagedReadiness(readiness, { hostPid, nonce });
        resolve({
          initializeProtocolVersion: initialize.protocolVersion,
          serverInfo: initialize.serverInfo ?? null,
          toolsListCanonicalSha256: sha256Text(canonicalJson(tools)),
          healthSchemaVersion: HEALTH_SCHEMA_VERSION,
          stdinEof: "passed",
          ...(platform === "win32-x64" ? {
            managedReadiness: {
              schemaVersion: readiness.schemaVersion,
              readinessSequence: readiness.readinessSequence,
              inputDesktop: readiness.inputDesktop,
              jobObjectAssigned: readiness.jobObjectAssigned,
              killOnJobClose: readiness.killOnJobClose,
              uiaRuntime: readiness.uiaRuntime,
              d3d11: readiness.d3d11,
              wgcApi: readiness.wgcApi,
              contentObserved: readiness.contentObserved,
            },
          } : {}),
        });
      } catch (error) {
        reject(error);
      }
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail(new Error("provider emitted non-JSON stdout")); return; }
        if (Number.isSafeInteger(message.id)) {
          responses.set(message.id, message);
          if (message.id === 1 && !responses.has(2)) {
            send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
            send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
            send(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "health_report", arguments: {} } });
            if (platform === "win32-x64") {
              send(child, {
                jsonrpc: "2.0",
                id: 4,
                method: "ling/managed_readiness",
                params: { schemaVersion: 1, childInstanceNonce: nonce, leaseGeneration: 1 },
              });
            }
          }
          finishIfReady();
        }
      }
    });
    child.stderr.on("data", () => {
      // Provider diagnostics are intentionally not part of the attestation;
      // they may contain runner-specific paths and process ids.
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
    });
    timer = setTimeout(() => fail(new Error(`provider probe timed out after ${timeoutMs}ms`)), timeoutMs);
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ling-cua-driver-source-build-probe", version: "1" },
      },
    });
  });
  return result;
}

function send(child, value) {
  if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
}

function parseHealthText(value) {
  const text = value?.content?.find?.((item) => item?.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function validateManagedReadiness(value, { hostPid, nonce }) {
  const expectedKeys = [
    "childInstanceNonce",
    "contentObserved",
    "d3d11",
    "hostIntegrityLevel",
    "hostProcessId",
    "hostSessionId",
    "inputDesktop",
    "jobObjectAssigned",
    "killOnJobClose",
    "leaseGeneration",
    "providerIntegrityLevel",
    "providerProcessId",
    "providerSessionId",
    "readinessSequence",
    "schemaVersion",
    "uiaRuntime",
    "wgcApi",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider readiness response is not an object");
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("provider readiness response keys do not match the locked contract");
  }
  if (
    value.schemaVersion !== 1
    || value.childInstanceNonce !== nonce
    || value.leaseGeneration !== 1
    || !Number.isSafeInteger(value.readinessSequence)
    || value.readinessSequence <= 0
    || value.hostProcessId !== hostPid
    || !Number.isSafeInteger(value.providerProcessId)
    || value.providerProcessId <= 0
    || !Number.isSafeInteger(value.hostSessionId)
    || value.hostSessionId < 0
    || !Number.isSafeInteger(value.providerSessionId)
    || value.providerSessionId < 0
    || value.jobObjectAssigned !== true
    || value.killOnJobClose !== true
    || value.contentObserved !== false
  ) {
    throw new Error("provider readiness identity or lifetime invariant failed");
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
