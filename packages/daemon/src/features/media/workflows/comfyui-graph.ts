import { createHash } from "node:crypto";
import type {
  MediaWorkflowInputField,
  MediaWorkflowOutputRule,
  MediaWorkflowValidationReport,
} from "@ling-stack/core";
import { isRecord } from "../../../shared/validation.js";

export interface ComfyWorkflowAnalysis {
  readonly sourceDigest: string;
  readonly inputFields: readonly MediaWorkflowInputField[];
  readonly outputRules: readonly MediaWorkflowOutputRule[];
  readonly validation: MediaWorkflowValidationReport;
  readonly nodeClasses: readonly string[];
}

export function analyzeComfyWorkflowGraph(
  graph: Record<string, unknown>,
  objectInfo: Record<string, unknown> | undefined,
  now = new Date().toISOString(),
): ComfyWorkflowAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  const inputFields: MediaWorkflowInputField[] = [];
  const outputRules: MediaWorkflowOutputRule[] = [];
  const nodeClasses = new Set<string>();
  const entries = Object.entries(graph);
  if (entries.length === 0) {
    errors.push("工作流没有可执行节点。");
  }
  for (const [nodeId, value] of entries) {
    if (!isRecord(value)) {
      errors.push(`节点 ${nodeId} 不是有效对象。`);
      continue;
    }
    const classType = typeof value.class_type === "string" ? value.class_type : "";
    const inputs = isRecord(value.inputs) ? value.inputs : undefined;
    if (!classType || !inputs) {
      errors.push(`节点 ${nodeId} 缺少 class_type 或 inputs。请导入 ComfyUI API Format JSON。`);
      continue;
    }
    nodeClasses.add(classType);
    if (objectInfo && !Object.hasOwn(objectInfo, classType)) {
      errors.push(`当前 ComfyUI 缺少节点：${classType}。`);
    }
    for (const [inputName, inputValue] of Object.entries(inputs)) {
      const field = inferInputField(nodeId, classType, inputName, inputValue);
      if (field && !inputFields.some((item) => item.semantic === field.semantic && item.semantic !== "custom")) {
        inputFields.push(field);
      }
    }
    const outputType = inferOutputArtifactType(classType);
    if (outputType) {
      outputRules.push({ nodeId, artifactType: outputType, collect: "all" });
    }
  }
  if (inputFields.every((field) => field.semantic !== "prompt")) {
    warnings.push("没有自动识别到提示词输入，请在映射步骤中选择对应节点字段。");
  }
  if (outputRules.length === 0) {
    errors.push("没有识别到图片或视频输出节点，请在映射步骤中指定输出节点。");
  }
  return {
    sourceDigest: digestComfyWorkflowGraph(graph),
    inputFields,
    outputRules,
    validation: { ok: errors.length === 0, errors, warnings, checkedAt: now },
    nodeClasses: [...nodeClasses].sort(),
  };
}

export function validateComfyWorkflowMappings(
  graph: Record<string, unknown>,
  inputFields: readonly MediaWorkflowInputField[],
  outputRules: readonly MediaWorkflowOutputRule[],
  now = new Date().toISOString(),
): MediaWorkflowValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fieldIds = new Set<string>();
  for (const field of inputFields) {
    if (fieldIds.has(field.id)) {
      errors.push(`输入字段 ID 重复：${field.id}`);
    }
    fieldIds.add(field.id);
    const node = graph[field.nodeId];
    if (!isRecord(node) || !isRecord(node.inputs) || !Object.hasOwn(node.inputs, field.inputName)) {
      errors.push(`输入映射不存在：节点 ${field.nodeId} / ${field.inputName}。`);
    }
    if (!field.label.trim()) {
      errors.push(`输入字段 ${field.id} 缺少名称。`);
    }
  }
  if (!inputFields.some((field) => field.semantic === "prompt")) {
    warnings.push("流程没有映射主提示词，将只使用工作流内置提示词。 ");
  }
  if (outputRules.length === 0) {
    errors.push("至少需要一个图片或视频输出规则。");
  }
  for (const rule of outputRules) {
    if (!isRecord(graph[rule.nodeId])) {
      errors.push(`输出节点不存在：${rule.nodeId}。`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, checkedAt: now };
}

export function materializeComfyWorkflowGraph(
  graph: Record<string, unknown>,
  fields: readonly MediaWorkflowInputField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const materialized = structuredClone(graph);
  for (const field of fields) {
    const value = values[field.id] ?? field.defaultValue;
    if (value === undefined || value === null || value === "") {
      if (field.required) {
        throw new Error(`工作流输入“${field.label}”不能为空。`);
      }
      continue;
    }
    const node = materialized[field.nodeId];
    if (!isRecord(node) || !isRecord(node.inputs)) {
      throw new Error(`工作流输入节点不存在：${field.nodeId}。`);
    }
    node.inputs[field.inputName] = normalizeFieldValue(field, value);
  }
  return materialized;
}

export function digestComfyWorkflowGraph(graph: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(graph)).digest("hex");
}

function inferInputField(
  nodeId: string,
  classType: string,
  inputName: string,
  value: unknown,
): MediaWorkflowInputField | undefined {
  if (Array.isArray(value) || isRecord(value)) {
    return undefined;
  }
  const normalized = `${classType} ${inputName}`.toLowerCase();
  const semantic = inferSemantic(normalized);
  if (!semantic) {
    return undefined;
  }
  const kind = inferKind(semantic, value);
  return {
    id: `${nodeId}.${inputName}`,
    label: inputLabel(semantic, inputName),
    kind,
    semantic,
    required: semantic === "prompt",
    nodeId,
    inputName,
    defaultValue: value,
  };
}

function inferSemantic(value: string): MediaWorkflowInputField["semantic"] | undefined {
  if (/negative|neg_prompt|negative_prompt/u.test(value)) return "negative_prompt";
  if (/cliptextencode|positive|prompt|text/u.test(value)) return "prompt";
  if (/duration|seconds|video_length|frame_count|num_frames/u.test(value)) return "duration";
  if (/seed|noise_seed/u.test(value)) return "seed";
  if (/ratio|aspect/u.test(value)) return "ratio";
  if (/loadimage|reference|image/u.test(value)) return "reference_image";
  return undefined;
}

function inferKind(semantic: MediaWorkflowInputField["semantic"], value: unknown): MediaWorkflowInputField["kind"] {
  if (semantic === "reference_image") return "image_artifact";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "text";
}

function inputLabel(semantic: MediaWorkflowInputField["semantic"], fallback: string): string {
  switch (semantic) {
    case "prompt": return "提示词";
    case "negative_prompt": return "负面提示词";
    case "ratio": return "画面比例";
    case "duration": return "视频时长";
    case "seed": return "随机种子";
    case "reference_image": return "参考图片";
    default: return fallback;
  }
}

function inferOutputArtifactType(classType: string): MediaWorkflowOutputRule["artifactType"] | undefined {
  const normalized = classType.toLowerCase();
  if (/video|vhs|saveanimated|savewebm|savemp4/u.test(normalized)) return "video";
  if (/saveimage|previewimage/u.test(normalized)) return "image";
  return undefined;
}

function normalizeFieldValue(field: MediaWorkflowInputField, value: unknown): unknown {
  if (field.kind === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`工作流输入“${field.label}”必须是数字。`);
    return number;
  }
  if (field.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error(`工作流输入“${field.label}”必须是开关值。`);
    return value;
  }
  if (field.kind === "select" && field.options && !field.options.includes(String(value))) {
    throw new Error(`工作流输入“${field.label}”不在允许选项中。`);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
