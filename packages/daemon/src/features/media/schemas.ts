import {
  mediaJobStatuses,
  mediaOperations,
  type CreateMediaJobInput,
  type MediaJobStatus,
  type MediaOperation,
} from "@ling-stack/core";
import { isRecord, readOptionalObject, readString } from "../../shared/validation.js";

export function parseCreateMediaJobInput(value: unknown): CreateMediaJobInput {
  if (!isRecord(value)) {
    throw new Error("Media job request must be a JSON object");
  }
  const input: CreateMediaJobInput = {
    providerPresetId: readString(value, "providerPresetId"),
    operation: readMediaOperation(value, "operation"),
    prompt: readString(value, "prompt"),
    input: readOptionalObject(value, "input"),
  };
  validateMediaJobInput(input);
  return input;
}

export function readOptionalMediaJobStatusQuery(url: URL): MediaJobStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!mediaJobStatuses.includes(value as MediaJobStatus)) {
    throw new Error(`status must be one of: ${mediaJobStatuses.join(", ")}`);
  }
  return value as MediaJobStatus;
}

function validateMediaJobInput(input: CreateMediaJobInput): void {
  if (!input.providerPresetId.trim()) {
    throw new Error("providerPresetId must be a non-empty string");
  }
  if (!input.prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }
}

function readMediaOperation(record: Record<string, unknown>, key: string): MediaOperation {
  const value = readString(record, key);
  if (!mediaOperations.includes(value as MediaOperation)) {
    throw new Error(`${key} must be one of: ${mediaOperations.join(", ")}`);
  }
  return value as MediaOperation;
}
