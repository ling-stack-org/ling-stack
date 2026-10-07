import { nodeFunctionGoalCommand, type ChannelNodeFunctionGoalV1 } from "./channel-command-goal.js";

/** A quote is provenance, not proof that the selector understood user authority. */
export interface ChannelOperationSourceV1 {
  readonly itemId: string;
  readonly quote: string;
  readonly revision?: number;
  readonly actorType?: "local_user" | "ling_agent" | "teammate";
}

export interface ChannelOperationFileBindingV1 {
  /** Canonical, workspace-relative path. Labels are never execution targets. */
  readonly path: string;
  readonly sourceRefs: readonly ChannelOperationSourceV1[];
}

export type ChannelOperationContentSourceV1 =
  | {
      readonly kind: "literal";
      readonly text: string;
      readonly sourceRefs: readonly ChannelOperationSourceV1[];
    }
  | {
      readonly kind: "generated_objective";
      readonly text: string;
      readonly inputOperationIds: readonly string[];
      readonly sourceRefs: readonly ChannelOperationSourceV1[];
    };

export interface ChannelOperationBindingV1 {
  readonly schemaVersion: 1;
  readonly ownerParticipantId: string;
  readonly ownerSelection?: "explicit" | "host_default";
  readonly inputRefs: readonly ChannelOperationFileBindingV1[];
  readonly outputRefs: readonly ChannelOperationFileBindingV1[];
  readonly contentSource?: ChannelOperationContentSourceV1;
  readonly commandGoal?: ChannelNodeFunctionGoalV1;
  readonly sourceRefs: readonly ChannelOperationSourceV1[];
  readonly effectScope: {
    readonly readPaths: readonly string[];
    readonly writePaths: readonly string[];
    readonly exactCommands: readonly string[];
    readonly allowEnvironmentAccess: false;
    readonly allowNetworkAccess: false;
  };
}

/** Strict serialization shared by persistence, dispatch and evidence consumers. */
export function channelOperationPlanFingerprintV1(operations: readonly unknown[]): string {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
      : value;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(canonical(operations)))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `opbv1_${hash.toString(16).padStart(16, "0")}`;
}

export function isChannelOperationBindingV1(value: unknown): value is ChannelOperationBindingV1 {
  if (!record(value, ["schemaVersion", "ownerParticipantId", "ownerSelection", "inputRefs", "outputRefs", "contentSource", "commandGoal", "sourceRefs", "effectScope"])
    || value.schemaVersion !== 1 || !text(value.ownerParticipantId)
    || (value.ownerSelection !== undefined && value.ownerSelection !== "explicit" && value.ownerSelection !== "host_default")
    || !Array.isArray(value.inputRefs) || !value.inputRefs.every(fileBinding)
    || !Array.isArray(value.outputRefs) || !value.outputRefs.every(fileBinding)
    || !sources(value.sourceRefs)) return false;
  const scope = value.effectScope;
  if (!record(scope, ["readPaths", "writePaths", "exactCommands", "allowEnvironmentAccess", "allowNetworkAccess"])
    || !paths(scope.readPaths) || !paths(scope.writePaths)
    || !texts(scope.exactCommands) || scope.exactCommands.some((command) => command.length > 512 || /[\r\n]/u.test(command))
    || scope.allowEnvironmentAccess !== false || scope.allowNetworkAccess !== false
    || JSON.stringify(scope.readPaths) !== JSON.stringify(value.inputRefs.map((ref) => ref.path))
    || JSON.stringify(scope.writePaths) !== JSON.stringify(value.outputRefs.map((ref) => ref.path))) return false;
  if (value.commandGoal !== undefined) {
    const goal = value.commandGoal;
    if (!record(goal, ["kind", "modulePath", "invocation", "inputOperationId", "sourceRefs"])
      || goal.kind !== "node_function" || !isChannelOperationRelativePathV1(goal.modulePath)
      || !text(goal.invocation) || !sources(goal.sourceRefs)
      || (goal.inputOperationId !== undefined && !text(goal.inputOperationId))
      || !goal.sourceRefs.some(ref => ref.quote.includes(goal.invocation as string))
      || value.inputRefs.length !== 1 || value.inputRefs[0].path !== goal.modulePath
      || scope.exactCommands.length !== 1
      || nodeFunctionGoalCommand({ modulePath: goal.modulePath, invocation: goal.invocation }) !== scope.exactCommands[0]) return false;
  }
  if (value.contentSource === undefined) return true;
  const content = value.contentSource;
  return record(content, ["kind", "text", "sourceRefs", "inputOperationIds"])
    && typeof content.text === "string" && sources(content.sourceRefs)
    && (content.kind === "literal" ? content.inputOperationIds === undefined
      : content.kind === "generated_objective" && text(content.text) && texts(content.inputOperationIds));
}

export function isChannelOperationRelativePathV1(value: unknown): value is string {
  return text(value) && !value.startsWith("/") && !value.includes("\\") && !/[\u0000-\u001f:*?]/u.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function fileBinding(value: unknown): value is ChannelOperationFileBindingV1 {
  return record(value, ["path", "sourceRefs"]) && isChannelOperationRelativePathV1(value.path) && sources(value.sourceRefs);
}

function sources(value: unknown): value is readonly ChannelOperationSourceV1[] {
  return Array.isArray(value) && value.length > 0
    && value.every((source) => record(source, ["itemId", "quote", "revision", "actorType"]) && text(source.itemId) && text(source.quote)
      && (source.revision === undefined || typeof source.revision === "number" && Number.isInteger(source.revision) && source.revision >= 0)
      && (source.actorType === undefined || source.actorType === "local_user" || source.actorType === "ling_agent" || source.actorType === "teammate"));
}

function paths(value: unknown): value is readonly string[] {
  return texts(value) && value.every(isChannelOperationRelativePathV1);
}

function texts(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}
