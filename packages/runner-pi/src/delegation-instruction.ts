import { types } from "node:util";
import type {
  PiRunnerDelegationInstructionDirective,
  PiRunnerDelegationInstructionMessage,
} from "./types.js";

interface InstructionBatch {
  readonly insertAfterMessageCount: number;
  readonly messages: readonly PiRunnerDelegationInstructionMessage[];
}

/** Copy only the exact closed directive. Accessors, prototypes and extra authority are rejected. */
export function readDelegationInstructionDirective(value: unknown): PiRunnerDelegationInstructionDirective {
  const reject = (): never => { throw new Error("Invalid delegation instruction directive."); };
  try {
    if (!plainRecord(value, ["kind", "schemaVersion", "insertAfterMessageCount", "messages"])) return reject();
    if (value.kind !== "delegation_instructions" || value.schemaVersion !== 1
      || !Number.isSafeInteger(value.insertAfterMessageCount) || Number(value.insertAfterMessageCount) < 1) return reject();
    const entries = dataArray(value.messages);
    if (!entries || entries.length < 1 || entries.length > 32) return reject();
    const messages = entries.map((message): PiRunnerDelegationInstructionMessage => {
      if (!plainRecord(message, ["role", "content", "timestamp", "delegationInstruction"])
        || message.role !== "user" || typeof message.content !== "string" || !message.content.trim()
        || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)
        || !plainRecord(message.delegationInstruction, ["messageId", "digest"])) return reject();
      const identity = message.delegationInstruction;
      if (typeof identity.messageId !== "string" || !/^[a-zA-Z0-9_.:-]{1,240}$/u.test(identity.messageId)
        || typeof identity.digest !== "string" || !/^[a-f0-9]{64}$/u.test(identity.digest)) return reject();
      return Object.freeze({ role: "user", content: message.content, timestamp: message.timestamp,
        delegationInstruction: Object.freeze({ messageId: identity.messageId, digest: identity.digest }) });
    });
    if (new Set(messages.map(message => message.delegationInstruction.messageId)).size !== messages.length) return reject();
    return Object.freeze({ kind: "delegation_instructions", schemaVersion: 1,
      insertAfterMessageCount: Number(value.insertAfterMessageCount), messages: Object.freeze(messages) });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid delegation instruction directive.") throw error;
    return reject();
  }
}

/** Per physical SDK Session. Durable identity still belongs to Core receipts, not this process-local projection. */
export function createDelegationInstructionContextProjector() {
  const batches: InstructionBatch[] = [];
  const messagesById = new Map<string, {
    readonly insertAfterMessageCount: number;
    readonly message: PiRunnerDelegationInstructionMessage;
  }>();

  const accept = (raw: unknown): PiRunnerDelegationInstructionDirective => {
    const directive = readDelegationInstructionDirective(raw);
    const fresh: PiRunnerDelegationInstructionMessage[] = [];
    for (const message of directive.messages) {
      const id = message.delegationInstruction.messageId;
      const previous = messagesById.get(id);
      if (previous) {
        if (previous.insertAfterMessageCount !== directive.insertAfterMessageCount
          || JSON.stringify(previous.message) !== JSON.stringify(message)) {
          throw new Error("Delegation instruction identity changed inside one Pi Session.");
        }
        continue;
      }
      messagesById.set(id, { insertAfterMessageCount: directive.insertAfterMessageCount, message });
      fresh.push(message);
    }
    if (fresh.length) batches.push({ insertAfterMessageCount: directive.insertAfterMessageCount, messages: fresh });
    return directive;
  };

  const project = <T>(messages: readonly T[]): T[] => {
    if (!batches.length) return [...messages];
    for (const batch of batches) {
      if (batch.insertAfterMessageCount > messages.length) {
        throw new Error("Delegation instruction transcript anchor is unavailable.");
      }
    }
    const output: T[] = [];
    for (let count = 0; count <= messages.length; count += 1) {
      for (const batch of batches) {
        if (batch.insertAfterMessageCount === count) output.push(...batch.messages as unknown as T[]);
      }
      if (count < messages.length) output.push(messages[count]!);
    }
    return output;
  };

  return { accept, project };
}

function plainRecord(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === names.length && keys.every(key => typeof key === "string" && names.includes(key)
    && Boolean(descriptors[key]) && "value" in descriptors[key]!);
}

function dataArray(value: unknown): readonly unknown[] | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(descriptors).length !== length + 1) return undefined;
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Invalid delegation instruction directive.");
    }
    return descriptor.value;
  });
}
