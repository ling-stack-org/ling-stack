import type {
  MediaWorkflowInputField,
  MediaWorkflowOutputRule,
} from "@ling-stack/core";
import { isRecord } from "../../../shared/validation.js";

const inputKinds = ["text", "number", "boolean", "select", "image_artifact"] as const;
const inputSemantics = [
  "prompt",
  "negative_prompt",
  "ratio",
  "duration",
  "seed",
  "reference_image",
  "custom",
] as const;
const artifactTypes = ["image", "video"] as const;
const collectModes = ["first", "all"] as const;

export function parseMediaWorkflowInputFields(value: unknown): readonly MediaWorkflowInputField[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("inputFields 必须是数组。");
  return value.map((item, index) => parseInputField(item, index));
}

export function parseMediaWorkflowOutputRules(value: unknown): readonly MediaWorkflowOutputRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("outputRules 必须是数组。");
  return value.map((item, index) => parseOutputRule(item, index));
}

function parseInputField(value: unknown, index: number): MediaWorkflowInputField {
  if (!isRecord(value)) throw new Error(`inputFields[${index}] 必须是对象。`);
  const kind = readEnum(value.kind, inputKinds, `inputFields[${index}].kind`);
  const defaultValue = readDefaultValue(value.defaultValue, kind, `inputFields[${index}].defaultValue`);
  const options = readOptions(value.options, kind, index);
  return {
    id: readNonEmptyString(value.id, `inputFields[${index}].id`),
    label: readNonEmptyString(value.label, `inputFields[${index}].label`),
    kind,
    semantic: readEnum(value.semantic, inputSemantics, `inputFields[${index}].semantic`),
    required: readBoolean(value.required, `inputFields[${index}].required`),
    nodeId: readNonEmptyString(value.nodeId, `inputFields[${index}].nodeId`),
    inputName: readNonEmptyString(value.inputName, `inputFields[${index}].inputName`),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(options ? { options } : {}),
  };
}

function parseOutputRule(value: unknown, index: number): MediaWorkflowOutputRule {
  if (!isRecord(value)) throw new Error(`outputRules[${index}] 必须是对象。`);
  return {
    nodeId: readNonEmptyString(value.nodeId, `outputRules[${index}].nodeId`),
    artifactType: readEnum(value.artifactType, artifactTypes, `outputRules[${index}].artifactType`),
    collect: readEnum(value.collect, collectModes, `outputRules[${index}].collect`),
  };
}

function readOptions(value: unknown, kind: MediaWorkflowInputField["kind"], index: number): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (kind !== "select") throw new Error(`inputFields[${index}].options 只允许用于选项字段。`);
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`inputFields[${index}].options 必须是非空字符串数组。`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function readDefaultValue(value: unknown, kind: MediaWorkflowInputField["kind"], key: string): unknown {
  if (value === undefined || value === null) return value;
  if (kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${key} 必须是有限数字。`);
  }
  if (kind === "boolean" && typeof value !== "boolean") throw new Error(`${key} 必须是布尔值。`);
  if ((kind === "text" || kind === "select" || kind === "image_artifact") && typeof value !== "string") {
    throw new Error(`${key} 必须是字符串。`);
  }
  return value;
}

function readNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} 必须是非空字符串。`);
  return value.trim();
}

function readBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${key} 必须是布尔值。`);
  return value;
}

function readEnum<const T extends readonly string[]>(value: unknown, values: T, key: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${key} 必须是：${values.join(" / ")}。`);
  }
  return value;
}
