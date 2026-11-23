#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  EDGE_LOCAL_NETWORK_CAPABILITY_ID, type DeviceTaskGraphNodeReceiptV1, type EdgeRuntimeDiagnosisWorkV1, type EdgeRuntimeJournalEntryV1,
} from "@ling-stack/contracts";
import { SqliteDeviceFabricStore } from "@ling-stack/core";
import {
  edgeRuntimeDiagnosisClaimBytes, edgeRuntimeJournalEntryBytes, edgeRuntimeTaskGraphReceiptBytes, type EdgeRuntimeEvidenceBindingV1,
} from "@ling-stack/remote-protocol";
import { LocalPcTargetExecutor } from "./features/device-support/adapters/local-pc-executor.js";
import { isRecord } from "./shared/validation.js";

interface Config {
  readonly origin: string;
  readonly runtimeId: string;
  readonly graphId: string;
  readonly binding: EdgeRuntimeEvidenceBindingV1;
  readonly privateKeyFile: string;
  readonly stateDirectory: string;
}

async function run(config: Config): Promise<void> {
  const key = createPrivateKey(await readFile(config.privateKeyFile));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Edge requires an Ed25519 key.");
  const { binding, graphId, runtimeId } = config;
  const origin = new URL(config.origin).origin;
  const endpoint = `${origin}/v1/device-support/fabric/edge-runtimes/${runtimeId}`;
  async function post(operation: string, payload: unknown, bytes: Uint8Array): Promise<unknown> {
    const response = await fetch(`${endpoint}/${operation}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ binding, payload, signature: sign(null, bytes, key).toString("base64url") }),
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Coordinator rejected ${operation} (HTTP ${response.status}).`);
    return response.json();
  }

  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(config.stateDirectory);
  try {
    const response = await post("diagnosis-claim", { graphId }, edgeRuntimeDiagnosisClaimBytes(binding, graphId));
    const work = readWork(response, graphId);
    const journal = new SqliteDeviceFabricStore({ databasePath: join(config.stateDirectory, "edge.sqlite") });
    try {
      const entries = journal.listEdgeRuntimeJournalEntries(runtimeId, graphId);
      const sendEntry = (entry: EdgeRuntimeJournalEntryV1) => post("journal", entry, edgeRuntimeJournalEntryBytes(binding, entry));
      const recordEntry = (sequence: number, fields: Pick<EdgeRuntimeJournalEntryV1, "kind" | "outcome" | "payloadDigest" | "networkObservation">) => {
        const entry: EdgeRuntimeJournalEntryV1 = {
          entryId: `${work.attemptId}:${sequence}`, ownerTaskId: graphId, operationId: work.attemptId, runtimeId, sequence,
          recordedAt: new Date().toISOString(), ...fields,
        };
        journal.appendEdgeRuntimeJournalEntry(entry);
        return entry;
      };
      if (entries.length > 2 || entries.some(entry => entry.operationId !== work.attemptId)) {
        throw new Error("The local journal belongs to a different diagnosis attempt.");
      }
      const retainedStart = entries[0];
      const start = retainedStart ?? recordEntry(1, { kind: "task_started", outcome: "pending" });
      if (start.kind !== "task_started") throw new Error("The local Edge journal is missing its dispatch intent.");
      const acknowledged = await sendEntry(start);
      if (!isRecord(acknowledged) || typeof acknowledged.replayed !== "boolean") {
        throw new Error("Coordinator returned an invalid Edge dispatch acknowledgement.");
      }
      let terminal = entries[1];
      if (!terminal && (retainedStart || acknowledged.replayed)) terminal = recordEntry(2, { kind: "task_unknown", outcome: "unknown" });
      if (!terminal) {
        const { connected } = await new LocalPcTargetExecutor().readNetwork();
        const networkObservation = { connected };
        terminal = recordEntry(2, {
          kind: "task_completed", outcome: "completed", networkObservation,
          payloadDigest: createHash("sha256").update(JSON.stringify(networkObservation)).digest("hex"),
        });
      }
      if (terminal.outcome !== "completed" && terminal.outcome !== "unknown" && terminal.outcome !== "failed") {
        throw new Error("The local Edge journal has an unexpected diagnosis outcome.");
      }
      await sendEntry(terminal);
      const receipt: DeviceTaskGraphNodeReceiptV1 = {
        graphId, graphRevision: work.graphRevision, nodeId: work.nodeId, ownerKind: "edge", ownerId: runtimeId,
        targetDeviceId: work.targetDeviceId, capabilitySnapshotId: work.capabilitySnapshotId, attemptId: work.attemptId,
        routeGeneration: binding.runtimeRevision, status: terminal.outcome === "completed" ? "succeeded" : terminal.outcome,
        resultRef: terminal.entryId, receivedAt: terminal.recordedAt,
      };
      await post("task-graph-receipt", receipt, edgeRuntimeTaskGraphReceiptBytes(binding, receipt));
      process.stdout.write(`${JSON.stringify({ graphId, attemptId: work.attemptId, status: receipt.status, observation: terminal.networkObservation })}\n`);
    } finally {
      journal.close();
    }
  } finally {
    await release();
  }
}

function readWork(value: unknown, graphId: string): EdgeRuntimeDiagnosisWorkV1 {
  if (!isRecord(value) || value.graphId !== graphId || value.capabilityId !== EDGE_LOCAL_NETWORK_CAPABILITY_ID
    || value.nodeId !== "inspect-network" || typeof value.attemptId !== "string" || !/^edge_attempt_[0-9a-f]{64}$/u.test(value.attemptId)
    || typeof value.targetDeviceId !== "string" || !/^edge_host_[0-9a-f]{64}$/u.test(value.targetDeviceId)
    || typeof value.capabilitySnapshotId !== "string" || !/^edge_snapshot_[0-9a-f]{64}$/u.test(value.capabilitySnapshotId)
    || typeof value.graphRevision !== "number" || !Number.isSafeInteger(value.graphRevision) || value.graphRevision < 2) {
    throw new Error("Coordinator returned an invalid Edge diagnosis.");
  }
  return { graphId, graphRevision: value.graphRevision, nodeId: value.nodeId, targetDeviceId: value.targetDeviceId,
    capabilityId: value.capabilityId, capabilitySnapshotId: value.capabilitySnapshotId, attemptId: value.attemptId };
}

async function readConfig(file: string): Promise<Config> {
  const data: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(data) || !isRecord(data.binding)) throw new Error("Invalid Edge diagnosis configuration.");
  const { origin, runtimeId, graphId, privateKeyFile, stateDirectory } = data;
  const { grantId, runtimeRevision, placementId } = data.binding;
  if (typeof origin !== "string" || typeof runtimeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(runtimeId)
    || typeof graphId !== "string" || !/^edge_diagnosis_[0-9a-f]{64}$/u.test(graphId)
    || typeof placementId !== "string" || !/^edge_placement_[0-9a-f]{64}$/u.test(placementId)
    || typeof grantId !== "string" || !/^[0-9a-f-]{36}$/u.test(grantId)
    || typeof runtimeRevision !== "number" || !Number.isSafeInteger(runtimeRevision) || runtimeRevision < 1
    || typeof privateKeyFile !== "string" || !privateKeyFile || typeof stateDirectory !== "string" || !stateDirectory) {
    throw new Error("Invalid Edge diagnosis configuration.");
  }
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Edge diagnosis requires the loopback origin of its authenticated coordinator link.");
  }
  return { origin: url.origin, runtimeId, graphId, privateKeyFile, stateDirectory, binding: { grantId, runtimeRevision, placementId } };
}

const [command, configFile, extra] = process.argv.slice(2);
if (command !== "diagnose" || !configFile || extra !== undefined) {
  process.stderr.write("Usage: ling-edge diagnose <configuration.json>\n");
  process.exitCode = 2;
} else {
  try {
    await run(await readConfig(configFile));
  } catch (error) {
    const message = error instanceof Error && /^(?:Coordinator |Edge requires|Invalid Edge|The local |Edge diagnosis requires)/u.test(error.message)
      ? error.message : "Edge diagnosis could not complete. The local journal can resume the same task.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
