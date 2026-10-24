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

/** Host-compiled scope for preparing local Node dependencies, not a general read grant. */
export interface ChannelCommandInputScopeV1 {
  readonly kind: "node_module_closure_v1";
  readonly projectRoot: string;
  readonly sourceRefs: readonly ChannelOperationSourceV1[];
}

/** A directory must be explicitly named, not merely a prefix of a script path. */
export function hasExplicitChannelOperationPathQuoteV1(quote: string, path: string): boolean {
  let offset = -1;
  while ((offset = quote.indexOf(path, offset + 1)) !== -1) {
    const pathCharacter = /[\p{L}\p{N}_./\\-]/u;
    if ((!offset || !pathCharacter.test(quote[offset - 1]!))
      && (offset + path.length === quote.length || !pathCharacter.test(quote[offset + path.length]!))) return true;
  }
  return false;
}

export function isChannelCommandInputScopeV1(value: unknown): value is ChannelCommandInputScopeV1 {
  return record(value, ["kind", "projectRoot", "sourceRefs"]) && value.kind === "node_module_closure_v1"
    && isChannelOperationRelativePathV1(value.projectRoot) && !value.projectRoot.split("/").some(part => part.startsWith("."))
    && sources(value.sourceRefs) && value.sourceRefs.every(ref => ref.actorType === "local_user")
    && value.sourceRefs.some(ref => hasExplicitChannelOperationPathQuoteV1(ref.quote, value.projectRoot as string));
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
  readonly commandInputScope?: ChannelCommandInputScopeV1;
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
  if (!record(value, ["schemaVersion", "ownerParticipantId", "ownerSelection", "inputRefs", "outputRefs", "contentSource", "commandGoal", "commandInputScope", "sourceRefs", "effectScope"])
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
  if (value.commandInputScope !== undefined) {
    const dependency = value.commandInputScope;
    const bindingSources = value.sourceRefs;
    const command = scope.exactCommands[0];
    const invocation = typeof value.commandGoal === "object" && value.commandGoal !== null
      && "invocation" in value.commandGoal && typeof value.commandGoal.invocation === "string" ? value.commandGoal.invocation : "\u0000";
    if (!isChannelCommandInputScopeV1(dependency)
      || !value.inputRefs.some(ref => ref.path.startsWith(dependency.projectRoot + "/") && /\.(?:mjs|cjs|js)$/u.test(ref.path))
      || scope.exactCommands.length !== 1 || !command || !/^node\s/u.test(command)
      || !dependency.sourceRefs.every(rootSource => bindingSources.some(source => {
        const outsideCommand = source.quote.split(command).join(" ").split(invocation).join(" ");
        return source.itemId === rootSource.itemId && outsideCommand.includes(rootSource.quote)
          && hasExplicitChannelOperationPathQuoteV1(outsideCommand, dependency.projectRoot);
      }))) return false;
  }
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
