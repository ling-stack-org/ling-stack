import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import {
  channelOperationPlanFingerprintV1,
  isChannelIntentExecutionPlanV1,
  isChannelOperationRelativePathV1,
  hasExplicitChannelOperationPathQuoteV1,
  nodeFunctionGoalCommand,
  type ChannelNodeFunctionGoalV1,
  type ChannelIntentExecutionOperationV1,
  type ChannelIntentExecutionPlanV1,
  type ChannelOperationContentSourceV1,
  type ChannelOperationFileBindingV1,
  type ChannelCommandInputScopeV1,
  type ChannelCommandWorkingDirectoryV1,
  type ChannelOperationSourceV1,
} from "@ling-stack/contracts";
import type { AiTeammate, RunTool } from "@ling-stack/core";
import { commandMatchesPolicy } from "./command-operation-match.js";
import type { ChannelOperationVisibleSource } from "./channel-operation-sources.js";

interface CandidatePath {
  readonly path: string;
  readonly sourceQuote: string;
  readonly sourceItemId?: string;
  readonly relativeTo?: { readonly path: string; readonly sourceQuote: string; readonly sourceItemId?: string };
}

interface CandidateCommandInput extends CandidatePath {
  /** Optional data-flow edge to a file operation already present in dependsOn. */
  readonly fromOperationId?: string;
}

export interface ChannelOperationCandidateV2 {
  readonly id: string;
  readonly kind: ChannelIntentExecutionOperationV1["kind"];
  readonly targetKind: ChannelIntentExecutionOperationV1["targetKind"];
  readonly required: boolean;
  readonly dependsOn: readonly string[];
  readonly owner: { readonly participantId: string; readonly sourceQuote: string; readonly kind?: "explicit" }
    | { readonly kind: "host_default" };
  readonly sourceQuote: string;
  readonly target?: CandidatePath;
  readonly inputs?: readonly CandidateCommandInput[];
  readonly projectInputRoot?: { readonly path: string; readonly sourceQuote: string };
  readonly workingDirectory?: { readonly path: string; readonly sourceQuote: string };
  readonly command?: { readonly text: string; readonly sourceQuote: string };
  readonly commandGoal?: { readonly kind: "node_function"; readonly module: CandidatePath;
    readonly invocation: string; readonly sourceQuote: string };
  readonly contentSource?: {
    readonly kind: "literal" | "generated_objective";
    readonly text: string;
    readonly sourceQuote: string;
    readonly sourceItemId?: string;
    readonly inputOperationIds?: readonly string[];
  };
}

export interface ChannelOperationCandidatePlanV2 {
  readonly schemaVersion: 2;
  readonly operations: readonly ChannelOperationCandidateV2[];
}

export type ChannelOperationBindingResult =
  | { readonly status: "bound"; readonly execution: ChannelIntentExecutionPlanV1;
      readonly capabilityBlockers: readonly { readonly operationId: string; readonly participantId: string; readonly tool: RunTool }[] }
  | { readonly status: "blocked"; readonly code: "operation_binding_host_capability_unavailable";
      readonly operationId: string; readonly reason: string }
  | { readonly status: "clarify"; readonly missingFields: readonly string[]; readonly reason: string };

/**
 * Binds only explicit candidate fields. It never re-parses the whole request into
 * replacement operations. Filesystem probes resolve symlinks, not file contents.
 * The result is a plan, not scheduling authority: runtime effect gates must also
 * enforce these bindings against the actual tool arguments and owner Run.
 */
export function bindChannelOperationPlan(input: {
  readonly candidate: unknown;
  readonly sourceItemId: string;
  readonly sourceText: string;
  readonly workspaceCwd: string;
  readonly participants: readonly Pick<AiTeammate, "id" | "displayName" | "roleKey" | "allowedTools">[];
  readonly visibleSources?: readonly ChannelOperationVisibleSource[];
  readonly hostCapabilityAvailable?: (capabilityId: "host.open_local_target") => boolean;
  /** Selected by existing Host routing, never by the candidate's participant ID. */
  readonly defaultOwnerParticipantId?: string;
}): ChannelOperationBindingResult {
  try {
    if (!isChannelOperationCandidatePlanV2(input.candidate)) fail("execution.operations", "A versioned operation graph with per-operation owner, target and content bindings is required.");
    const candidate = input.candidate;
    const capabilityBlockers: { operationId: string; participantId: string; tool: RunTool }[] = [];
    const byId = new Map(candidate.operations.map((operation) => [operation.id, operation]));
    if (byId.size !== candidate.operations.length) fail("execution.operations", "Operation IDs must be unique.");
    const quote = (value: string, sourceItemId = input.sourceItemId): ChannelOperationSourceV1 => {
      const source = input.visibleSources?.find((item) => item.itemId === sourceItemId);
      const body = sourceItemId === input.sourceItemId ? input.sourceText : source?.body;
      if (!value.trim() || !body?.includes(value)) fail("sourceQuote", "Binding provenance is not a verbatim quote from a current projected canonical item.");
      return { itemId: sourceItemId, quote: value,
        ...(source ? { revision: source.revision, actorType: source.actorType } : {}) };
    };
    const file = (target: CandidatePath): ChannelOperationFileBindingV1 => {
      const sourceRefs = [quote(target.sourceQuote, target.sourceItemId)];
      if (!isChannelOperationRelativePathV1(target.path) || !target.sourceQuote.includes(target.path)) {
        fail("target.path", "A file target must be a quoted workspace-relative path, not an inferred first file or display label.");
      }
      let path = target.path;
      if (target.relativeTo) {
        sourceRefs.push(quote(target.relativeTo.sourceQuote, target.relativeTo.sourceItemId));
        if (!isChannelOperationRelativePathV1(target.relativeTo.path) || !target.relativeTo.sourceQuote.includes(target.relativeTo.path)) {
          fail("target.relativeTo", "The input directory needs its own explicit source binding.");
        }
        path = `${target.relativeTo.path}/${path}`;
      }
      assertWorkspacePath(path, input.workspaceCwd);
      return { path, sourceRefs };
    };
    const operations = candidate.operations.map((operation): ChannelIntentExecutionOperationV1 => {
      const source = quote(operation.sourceQuote);
      const defaultOwner = operation.owner.kind === "host_default";
      const ownerSource = defaultOwner ? undefined : quote(operation.owner.sourceQuote);
      if (ownerSource && !operation.sourceQuote.includes(ownerSource.quote)) fail("owner.sourceQuote", "The named owner must belong to this operation's instruction span.");
      const ownerId = defaultOwner ? input.defaultOwnerParticipantId : operation.owner.participantId;
      const owner = input.participants.find((participant) => participant.id === ownerId);
      if (!owner) fail("owner.participantId", `Operation ${operation.id} names an unavailable or unselected participant.`);
      const ownerQuote = ownerSource?.quote.toLocaleLowerCase();
      if (ownerQuote !== undefined && ![owner.id, owner.displayName, owner.roleKey].some((name) => ownerQuote.includes(name.toLocaleLowerCase()))) {
        fail("owner.sourceQuote", `Operation ${operation.id} has no source-backed participant identity.`);
      }
      const tool = operation.kind === "file_read" ? "read" : operation.kind === "file_create" ? "write"
        : operation.kind === "file_edit" ? "edit" : "bash";
      // Opening is a Host effect, not bash or a file read. Do not manufacture a
      // shell permission request while reporting this unavailable capability.
      if (operation.kind !== "open_local_target" && !owner.allowedTools.includes(tool)) {
        capabilityBlockers.push({ operationId: operation.id, participantId: owner.id, tool });
      }
      const writes = operation.kind === "file_create" || operation.kind === "file_edit";
      let workingDirectory: ChannelCommandWorkingDirectoryV1 | undefined;
      if (operation.workingDirectory) {
        const directory = operation.workingDirectory;
        const outsideCommand = operation.sourceQuote.split(operation.command?.text ?? operation.commandGoal?.invocation ?? "\u0000").join(" ");
        if (operation.kind !== "run_command" || !isChannelOperationRelativePathV1(directory.path)
          || !hasExplicitChannelOperationPathQuoteV1(directory.sourceQuote, directory.path)
          || !outsideCommand.includes(directory.sourceQuote)) {
          fail("workingDirectory", "The command directory needs its own current-operation quote, separate from command operands.");
        }
        const directorySource = quote(directory.sourceQuote);
        if (directorySource.actorType !== undefined && directorySource.actorType !== "local_user") {
          fail("workingDirectory", "A command directory must be selected by the current local user, not model text.");
        }
        assertWorkspaceDirectory(directory.path, input.workspaceCwd);
        workingDirectory = { path: directory.path, sourceRefs: [{ ...directorySource, actorType: "local_user" }] };
      }
      const commandFile = (target: CandidatePath): ChannelOperationFileBindingV1 => {
        if (!workingDirectory || target.relativeTo) return file(target);
        // Only command operands gain cwd-relative normalization. General file
        // targets remain canonical workspace-relative paths and still reject .. .
        const sourceRef = quote(target.sourceQuote, target.sourceItemId);
        if (!text(target.path) || target.path.startsWith("/") || /[\\\u0000-\u001f:*?]/u.test(target.path)
          || target.path.split("/").some(part => !part) || !target.sourceQuote.includes(target.path)) {
          fail("inputs.path", "A command input must be a literal quoted path relative to its frozen directory.");
        }
        const path = posix.normalize(`${workingDirectory.path}/${target.path}`);
        if (!isChannelOperationRelativePathV1(path)) fail("inputs.path", "Command input escapes its workspace.");
        assertWorkspacePath(path, input.workspaceCwd);
        return { path, sourceRefs: [sourceRef, ...workingDirectory.sourceRefs] };
      };
      const target = operation.target ? file(operation.target) : undefined;
      if (operation.target && (!operation.target.sourceItemId || operation.target.sourceItemId === input.sourceItemId)
        && !operation.sourceQuote.includes(operation.target.sourceQuote)) fail("target.sourceQuote", "The file target must belong to this operation's instruction span.");
      if (operation.kind === "run_command" && Boolean(operation.command) === Boolean(operation.commandGoal)) {
        fail("command", `Operation ${operation.id} needs either an explicit command or a source-bound invocation goal, not both.`);
      }
      if (operation.kind === "run_command" ? target !== undefined
        : !target || operation.command !== undefined || operation.commandGoal !== undefined) fail("target", `Operation ${operation.id} has an incompatible target.`);
      if (writes ? !operation.contentSource : operation.contentSource !== undefined) {
        fail("contentSource", `Operation ${operation.id} needs content only when writing a file.`);
      }
      let contentSource: ChannelOperationContentSourceV1 | undefined;
      if (operation.contentSource) {
        const content = operation.contentSource;
        const sourceRef = quote(content.sourceQuote, content.sourceItemId);
        if ((!content.sourceItemId || content.sourceItemId === input.sourceItemId)
          && !operation.sourceQuote.includes(content.sourceQuote)) fail("contentSource.sourceQuote", "Content must belong to this operation's instruction span.");
        if (!content.sourceQuote.includes(content.text)) fail("contentSource.text", "Content or objective text must be separately quoted, not extracted from a path suffix.");
        if (content.kind === "literal") {
          contentSource = { kind: "literal", text: content.text, sourceRefs: [sourceRef] };
        } else {
          const inputOperationIds = content.inputOperationIds ?? [];
          for (const id of inputOperationIds) {
            const predecessor = byId.get(id);
            const predecessorOwnerId = predecessor?.owner.kind === "host_default" ? input.defaultOwnerParticipantId
              : predecessor?.owner.participantId;
            if (!predecessor || predecessor.kind !== "file_read" || predecessorOwnerId !== owner.id
              || !operation.dependsOn.includes(id)) fail("contentSource.inputOperationIds", "Generated content inputs must name this owner's explicit read dependencies.");
          }
          contentSource = { kind: "generated_objective", text: content.text, inputOperationIds, sourceRefs: [sourceRef] };
        }
      }
      const inputRefs = operation.kind === "file_read" || operation.kind === "file_edit" || operation.kind === "open_local_target" ? [target!] : [];
      if (operation.inputs) {
        if (operation.kind !== "run_command") fail("inputs", "Only a command operation may declare staged command inputs.");
        for (const commandInput of operation.inputs) {
          if ((!commandInput.sourceItemId || commandInput.sourceItemId === input.sourceItemId)
            && !operation.sourceQuote.includes(commandInput.sourceQuote)) {
            fail("inputs.sourceQuote", "A command input must belong to this operation's instruction span.");
          }
          const ref = commandFile(commandInput);
          if (inputRefs.some((candidate) => candidate.path === ref.path)) fail("inputs", "Command input paths must be unique.");
          if (commandInput.fromOperationId) {
            const predecessor = byId.get(commandInput.fromOperationId);
            if (!predecessor || !operation.dependsOn.includes(predecessor.id) || !predecessor.target) {
              fail("inputs.fromOperationId", "A command input producer must be an explicit file dependency.");
            }
            if (!["file_read", "file_create", "file_edit"].includes(predecessor.kind)
              || file(predecessor.target).path !== ref.path) {
              fail("inputs.fromOperationId", "A command input path must match its declared file dependency.");
            }
          }
          inputRefs.push(ref);
        }
      }
      if (contentSource?.kind === "generated_objective") {
        for (const id of contentSource.inputOperationIds) {
          const predecessor = byId.get(id)!;
          if (!predecessor.target) fail("contentSource.inputOperationIds", "Generated content input has no file target.");
          const ref = file(predecessor.target);
          if (!inputRefs.some((inputRef) => inputRef.path === ref.path)) inputRefs.push(ref);
        }
      }
      const outputRefs = writes ? [target!] : [];
      const exactCommands: string[] = [];
      let commandGoal: ChannelNodeFunctionGoalV1 | undefined;
      if (operation.commandGoal) {
        const goal = operation.commandGoal;
        const goalSource = quote(goal.sourceQuote);
        if (!/\bnode\b/iu.test(operation.sourceQuote) || !operation.sourceQuote.includes(goal.sourceQuote) || !goal.sourceQuote.includes(goal.invocation)) {
          fail("commandGoal.sourceQuote", "The invocation must be quoted in the current operation, not supplied by prior model text.");
        }
        const module = commandFile(goal.module);
        const predecessors = operation.dependsOn.map(id => byId.get(id)).filter(predecessor => predecessor
          && ["file_read", "file_create", "file_edit"].includes(predecessor.kind)
          && predecessor.target && file(predecessor.target).path === module.path);
        if (predecessors.length > 1 || (!operation.sourceQuote.includes(goal.module.sourceQuote) && predecessors.length !== 1)) {
          fail("commandGoal.module", "The invocation module needs its own current target or one explicit input dependency.");
        }
        commandGoal = { kind: "node_function", modulePath: module.path, invocation: goal.invocation,
          ...(predecessors[0] ? { inputOperationId: predecessors[0].id } : {}), sourceRefs: [source, goalSource, ...module.sourceRefs] };
        const command = nodeFunctionGoalCommand(commandGoal, workingDirectory?.path);
        if (!command || !commandMatchesPolicy(command, { kind: "exact_command", command })) {
          fail("commandGoal.invocation", "Node invocation needs a named export and bounded JSON-literal arguments; arbitrary expressions are not executable goals.");
        }
        inputRefs.push(module);
        exactCommands.push(command);
      }
      if (operation.command) {
        quote(operation.command.sourceQuote);
        if (!operation.sourceQuote.includes(operation.command.sourceQuote) || !operation.command.sourceQuote.includes(operation.command.text)
          || !commandMatchesPolicy(operation.command.text, { kind: "exact_command", command: operation.command.text })) {
          fail("command", "An exact command must be source-bound and pass the host shell-structure policy.");
        }
        exactCommands.push(operation.command.text);
      }
      let commandInputScope: ChannelCommandInputScopeV1 | undefined;
      if (operation.projectInputRoot) {
        const root = operation.projectInputRoot;
        const outsideCommand = operation.command ? operation.sourceQuote.split(operation.command.text).join(" ")
          : operation.sourceQuote.split(operation.commandGoal?.invocation ?? "\u0000").join(" ");
        if (operation.kind !== "run_command" || !/^node\s/u.test(exactCommands[0] ?? "")
          || !outsideCommand.includes(root.sourceQuote)
          || !isChannelOperationRelativePathV1(root.path) || root.path.split("/").some(part => part.startsWith("."))
          || !hasExplicitChannelOperationPathQuoteV1(root.sourceQuote, root.path)
          || !hasExplicitChannelOperationPathQuoteV1(outsideCommand, root.path)
          || !inputRefs.some(ref => ref.path.startsWith(root.path + "/") && /\.(?:mjs|cjs|js)$/u.test(ref.path))) {
          fail("projectInputRoot", "Node dependencies need an explicitly named current-operation project directory and source input; a command path prefix is not scope authority.");
        }
        const rootSource = quote(root.sourceQuote);
        assertWorkspacePath(root.path, input.workspaceCwd);
        commandInputScope = { kind: "node_module_closure_v1", projectRoot: root.path,
          sourceRefs: [{ ...rootSource, actorType: "local_user" }] };
      }
      return {
        id: operation.id,
        kind: operation.kind,
        targetKind: operation.targetKind,
        targetRef: { type: "operation", id: `${input.sourceItemId}:${operation.id}`,
          label: commandGoal ? `${commandGoal.modulePath} → ${commandGoal.invocation}` : target?.path ?? exactCommands[0] },
        required: operation.required,
        dependsOn: [...operation.dependsOn],
        ...(exactCommands.length ? { commandMatchPolicy: { kind: "exact_command" as const, command: exactCommands[0]! } } : {}),
        binding: {
          schemaVersion: 1, ownerParticipantId: owner.id, ownerSelection: defaultOwner ? "host_default" : "explicit", inputRefs, outputRefs,
          ...(contentSource ? { contentSource } : {}), sourceRefs: ownerSource ? [source, ownerSource] : [source],
          ...(commandGoal ? { commandGoal } : {}),
          ...(commandInputScope ? { commandInputScope } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
          effectScope: { readPaths: inputRefs.map((ref) => ref.path), writePaths: outputRefs.map((ref) => ref.path),
            exactCommands, allowEnvironmentAccess: false, allowNetworkAccess: false },
        },
      };
    });
    const writtenPaths = new Set<string>();
    for (const operation of operations) {
      for (const ref of operation.binding!.outputRefs) {
        if (writtenPaths.has(ref.path)) fail("outputRefs", "Multiple operations write the same output; resolve output ownership before execution.");
        writtenPaths.add(ref.path);
      }
    }
    const execution: ChannelIntentExecutionPlanV1 = {
      bindingVersion: 1, operations, fingerprint: channelOperationPlanFingerprintV1(operations),
    };
    if (!isChannelIntentExecutionPlanV1(execution)) fail("execution.operations", "Bound operation graph has invalid dependencies or incompatible bindings.");
    // Validate the whole source-bound graph first; malformed or foreign input
    // must not be hidden behind a capability diagnostic. Nothing is dispatched.
    const unsupported = operations.find((operation) => operation.kind === "open_local_target"
      && input.hostCapabilityAvailable?.("host.open_local_target") !== true);
    if (unsupported) return { status: "blocked", code: "operation_binding_host_capability_unavailable",
      operationId: unsupported.id, reason: "Opening a local target requires an independent Host executor and authorization; this runtime has neither connected." };
    return { status: "bound", execution, capabilityBlockers };
  } catch (error) {
    if (error instanceof BindingError) return { status: "clarify", missingFields: [error.field], reason: error.message };
    throw error;
  }
}

function assertWorkspacePath(path: string, workspaceCwd: string): void {
  if (!isChannelOperationRelativePathV1(path)) fail("target.path", "File target escapes or is not normalized within the workspace.");
  const root = realpathSync(workspaceCwd);
  let existing = resolve(root, path);
  for (;;) {
    try { lstatSync(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === root) fail("target.path", "File target cannot be resolved safely within the workspace.");
      existing = dirname(existing);
    }
  }
  let physical: string;
  try { physical = realpathSync(existing); }
  catch { fail("target.path", "File target has an unresolved or inaccessible symlink."); }
  const remainder = relative(root, physical);
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || resolve(root, remainder) !== physical) {
    fail("target.path", "File target resolves through a symlink outside the workspace.");
  }
}

function assertWorkspaceDirectory(path: string, workspaceCwd: string): void {
  let current = realpathSync(workspaceCwd);
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      const fact = lstatSync(current);
      if (!fact.isDirectory() || fact.isSymbolicLink()) fail("workingDirectory", "Command directory cannot traverse a symlink or a non-directory.");
    } catch (error) {
      // A preceding explicit create may create the directory later. Execution
      // requires it to exist and captures its real identity before any await.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (error instanceof BindingError) throw error;
      fail("workingDirectory", "Command directory could not be verified.");
    }
  }
}

export function isChannelOperationCandidatePlanV2(value: unknown): value is ChannelOperationCandidatePlanV2 {
  return record(value, ["schemaVersion", "operations"]) && value.schemaVersion === 2
    && Array.isArray(value.operations) && value.operations.length > 0 && value.operations.length <= 64
    && value.operations.every(candidateOperation);
}

function candidateOperation(value: unknown): value is ChannelOperationCandidateV2 {
  if (!record(value, ["id", "kind", "targetKind", "required", "dependsOn", "owner", "sourceQuote", "target", "inputs", "projectInputRoot", "workingDirectory", "command", "commandGoal", "contentSource"])
    || !text(value.id) || !text(value.sourceQuote) || typeof value.required !== "boolean" || !texts(value.dependsOn)
    || !["file_read", "file_create", "file_edit", "run_command", "open_local_target"].includes(String(value.kind))
    || (value.kind === "run_command" ? value.targetKind !== "command" : value.targetKind !== "file")
    || !candidateOwner(value.owner)
    || (value.target !== undefined && !candidatePath(value.target))
    || (value.inputs !== undefined && (!Array.isArray(value.inputs) || value.inputs.length === 0 || value.inputs.length > 256
      || !value.inputs.every(candidateCommandInput)))
    || (value.projectInputRoot !== undefined && (!record(value.projectInputRoot, ["path", "sourceQuote"])
      || !text(value.projectInputRoot.path) || !text(value.projectInputRoot.sourceQuote)))
    || (value.workingDirectory !== undefined && (!record(value.workingDirectory, ["path", "sourceQuote"])
      || !text(value.workingDirectory.path) || !text(value.workingDirectory.sourceQuote)))
    || (value.command !== undefined && (!record(value.command, ["text", "sourceQuote"]) || !text(value.command.text) || !text(value.command.sourceQuote)))) return false;
  if (value.commandGoal !== undefined && (!record(value.commandGoal, ["kind", "module", "invocation", "sourceQuote"])
    || value.commandGoal.kind !== "node_function" || !candidatePath(value.commandGoal.module)
    || !text(value.commandGoal.invocation) || !text(value.commandGoal.sourceQuote))) return false;
  const content = value.contentSource;
  return content === undefined || (record(content, ["kind", "text", "sourceQuote", "sourceItemId", "inputOperationIds"])
    && typeof content.text === "string" && text(content.sourceQuote)
    && (content.sourceItemId === undefined || text(content.sourceItemId))
    && (content.kind === "literal" ? content.inputOperationIds === undefined
      : content.kind === "generated_objective" && text(content.text) && texts(content.inputOperationIds)));
}

function candidateCommandInput(value: unknown): value is CandidateCommandInput {
  return record(value, ["path", "sourceQuote", "sourceItemId", "relativeTo", "fromOperationId"])
    && text(value.path) && text(value.sourceQuote)
    && (value.sourceItemId === undefined || text(value.sourceItemId))
    && (value.relativeTo === undefined || (record(value.relativeTo, ["path", "sourceQuote", "sourceItemId"])
      && text(value.relativeTo.path) && text(value.relativeTo.sourceQuote)
      && (value.relativeTo.sourceItemId === undefined || text(value.relativeTo.sourceItemId))))
    && (value.fromOperationId === undefined || text(value.fromOperationId));
}

function candidatePath(value: unknown): value is CandidatePath {
  return record(value, ["path", "sourceQuote", "sourceItemId", "relativeTo"]) && text(value.path) && text(value.sourceQuote)
    && (value.sourceItemId === undefined || text(value.sourceItemId))
    && (value.relativeTo === undefined || (record(value.relativeTo, ["path", "sourceQuote", "sourceItemId"])
      && text(value.relativeTo.path) && text(value.relativeTo.sourceQuote)
      && (value.relativeTo.sourceItemId === undefined || text(value.relativeTo.sourceItemId))));
}

function candidateOwner(value: unknown): value is ChannelOperationCandidateV2["owner"] {
  return record(value, ["kind"]) && value.kind === "host_default"
    || record(value, ["kind", "participantId", "sourceQuote"]) && (value.kind === undefined || value.kind === "explicit")
      && text(value.participantId) && text(value.sourceQuote);
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function texts(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}
class BindingError extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}
function fail(field: string, reason: string): never { throw new BindingError(field, reason); }
