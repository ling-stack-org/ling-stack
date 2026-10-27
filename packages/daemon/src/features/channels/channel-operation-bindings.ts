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
import type { ChannelOperationContinuationAnchor, ChannelOperationContinuationContext, ChannelOperationVisibleSource } from "./channel-operation-sources.js";

interface CandidatePath {
  /** Workspace-relative unless relativeTo explicitly supplies the directory anchor. */
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
    readonly kind: "literal";
    readonly text: string;
    readonly sourceQuote: string;
    readonly sourceItemId?: string;
    readonly inputOperationIds?: never;
  } | {
    readonly kind: "generated_objective";
    readonly text: string;
    readonly sourceQuote: string;
    readonly sourceItemId?: string;
    readonly inputOperationIds: readonly string[];
  };
}

export interface ChannelOperationCandidatePlanV2 {
  readonly schemaVersion: 2;
  readonly continuation?: ChannelOperationContinuationAnchor & {
    readonly confirmationQuote: string;
    readonly excludedParticipants?: readonly { readonly participantId: string; readonly sourceQuote: string }[];
  };
  readonly operations: readonly ChannelOperationCandidateV2[];
}

export interface ChannelOperationCandidateShapeIssue {
  /** Host schema path only: never a candidate key, value, ID or array index. */
  readonly path: string;
  readonly code: "missing" | "invalid_type" | "invalid_value" | "unexpected_fields"
    | "empty_array" | "too_many_items" | "duplicate_value";
}

export type ChannelOperationBindingResult =
  | { readonly status: "bound"; readonly execution: ChannelIntentExecutionPlanV1;
      readonly excludedParticipantIds: readonly string[];
      readonly capabilityBlockers: readonly { readonly operationId: string; readonly participantId: string; readonly tool: RunTool }[] }
  | { readonly status: "blocked"; readonly code: "operation_binding_host_capability_unavailable";
      readonly operationId: string; readonly reason: string }
  | { readonly status: "clarify"; readonly missingFields: readonly string[]; readonly reason: string;
      readonly shapeIssue?: ChannelOperationCandidateShapeIssue };

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
  /** Resolved from canonical Host state, never supplied by the model or HTTP. */
  readonly continuationContext?: ChannelOperationContinuationContext;
  readonly hostCapabilityAvailable?: (capabilityId: "host.open_local_target") => boolean;
  /** Selected by existing Host routing, never by the candidate's participant ID. */
  readonly defaultOwnerParticipantId?: string;
}): ChannelOperationBindingResult {
  try {
    let shapeIssue: ChannelOperationCandidateShapeIssue | undefined;
    if (!validateCandidatePlan(input.candidate, issue => { shapeIssue ??= issue; })) {
      return { status: "clarify", missingFields: [shapeIssue!.path], shapeIssue,
        reason: `Operation candidate schema rejected: ${shapeIssue!.path} (${shapeIssue!.code}).` };
    }
    const candidate = input.candidate;
    const continuation = candidate.continuation ? input.continuationContext : undefined;
    const excludedParticipantIds = new Set<string>();
    if (candidate.continuation) {
      const { confirmationQuote, ...anchor } = candidate.continuation;
      if (!continuation || Object.entries(continuation.anchor).some(([key, value]) => anchor[key as keyof typeof anchor] !== value)
        || continuation.confirmation.itemId !== input.sourceItemId || continuation.confirmation.body !== input.sourceText
        || confirmationQuote !== input.sourceText || continuation.source.actorType !== "local_user"
        || ![continuation.source, continuation.confirmation, continuation.clarification].every(source =>
          input.visibleSources?.some(item => item.itemId === source.itemId && item.revision === source.revision
            && item.actorType === source.actorType && item.body === source.body))) {
        fail("execution.continuation", "Continuation must match the Host's current pending clarification and complete current user confirmation.");
      }
      for (const exclusion of candidate.continuation.excludedParticipants ?? []) {
        const participant = input.participants.find(item => item.id === exclusion.participantId);
        if (!participant || excludedParticipantIds.has(participant.id)
          || !input.sourceText.includes(exclusion.sourceQuote)
          || ![participant.id, participant.displayName, participant.roleKey].some(name =>
            exclusion.sourceQuote.toLocaleLowerCase().includes(name.toLocaleLowerCase()))) {
          fail("execution.continuation.excludedParticipants", "A participant exclusion needs a unique selected identity and a verbatim quote from the complete current confirmation.");
        }
        excludedParticipantIds.add(participant.id);
      }
    }
    const instructionItemId = continuation?.source.itemId ?? input.sourceItemId;
    const capabilityBlockers: { operationId: string; participantId: string; tool: RunTool }[] = [];
    const byId = new Map(candidate.operations.map((operation) => [operation.id, operation]));
    if (byId.size !== candidate.operations.length) fail("execution.operations", "Operation IDs must be unique.");
    const quote = (value: string, sourceItemId = instructionItemId, field = "sourceQuote"): ChannelOperationSourceV1 => {
      const source = input.visibleSources?.find((item) => item.itemId === sourceItemId);
      const body = sourceItemId === input.sourceItemId ? input.sourceText : source?.body;
      if (!value.trim() || !body?.includes(value)) fail(field, "Binding provenance is not a verbatim quote from a current projected canonical item.");
      return { itemId: sourceItemId, quote: value,
        ...(source ? { revision: source.revision, actorType: source.actorType } : {}) };
    };
    const file = (target: CandidatePath, field = `${operationPath}.target`): ChannelOperationFileBindingV1 => {
      const sourceRefs = [quote(target.sourceQuote, target.sourceItemId, `${field}.sourceQuote`)];
      if (!isChannelOperationRelativePathV1(target.path) || !target.sourceQuote.includes(target.path)) {
        fail("target.path", "A file target must be a quoted workspace-relative path, not an inferred first file or display label.");
      }
      let path = target.path;
      if (target.relativeTo) {
        sourceRefs.push(quote(target.relativeTo.sourceQuote, target.relativeTo.sourceItemId, `${field}.relativeTo.sourceQuote`));
        if (!isChannelOperationRelativePathV1(target.relativeTo.path) || !target.relativeTo.sourceQuote.includes(target.relativeTo.path)) {
          fail("target.relativeTo", "The input directory needs its own explicit source binding.");
        }
        path = `${target.relativeTo.path}/${path}`;
      }
      assertWorkspacePath(path, input.workspaceCwd);
      return { path, sourceRefs };
    };
    const operations = candidate.operations.map((operation): ChannelIntentExecutionOperationV1 => {
      const source = quote(operation.sourceQuote, instructionItemId, `${operationPath}.sourceQuote`);
      const defaultOwner = operation.owner.kind === "host_default";
      const ownerSource = defaultOwner ? undefined : quote(operation.owner.sourceQuote, instructionItemId, `${operationPath}.owner.sourceQuote`);
      if (ownerSource && !operation.sourceQuote.includes(ownerSource.quote)) fail("owner.sourceQuote", "The named owner must belong to this operation's instruction span.");
      const ownerId = defaultOwner ? input.defaultOwnerParticipantId : operation.owner.participantId;
      const owner = input.participants.find((participant) => participant.id === ownerId);
      if (!owner) fail("owner.participantId", `Operation ${operation.id} names an unavailable or unselected participant.`);
      if (excludedParticipantIds.has(owner.id)) fail("owner.participantId", "A currently excluded participant cannot own an operation.");
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
        const directorySource = quote(directory.sourceQuote, instructionItemId, `${operationPath}.workingDirectory.sourceQuote`);
        if (directorySource.actorType !== undefined && directorySource.actorType !== "local_user") {
          fail("workingDirectory", "A command directory must be selected by the current local user, not model text.");
        }
        assertWorkspaceDirectory(directory.path, input.workspaceCwd);
        workingDirectory = { path: directory.path, sourceRefs: [{ ...directorySource, actorType: "local_user" }] };
      }
      const commandFile = (target: CandidatePath, field = `${operationPath}.inputs[]`): ChannelOperationFileBindingV1 => {
        const sourceRef = quote(target.sourceQuote, target.sourceItemId, `${field}.sourceQuote`);
        if (!text(target.path) || target.path.startsWith("/") || /[\\\u0000-\u001f:*?]/u.test(target.path)
          || target.path.split("/").some(part => !part)
          || !hasExplicitChannelOperationPathQuoteV1(target.sourceQuote, target.path)) {
          fail("inputs.path", "A command input needs its literal path quote; relativeTo alone supplies an explicit directory anchor.");
        }
        // Cwd chooses where to launch, never how to interpret file coordinates.
        // General file targets still reject ..; only explicitly anchored command
        // inputs/modules may normalize quoted parent operands within workspace.
        if (!target.relativeTo) return file(target, field);
        const anchor = target.relativeTo;
        const anchorSource = quote(anchor.sourceQuote, anchor.sourceItemId, `${field}.relativeTo.sourceQuote`);
        if (!isChannelOperationRelativePathV1(anchor.path)
          || !hasExplicitChannelOperationPathQuoteV1(anchor.sourceQuote, anchor.path)
          || ((!anchor.sourceItemId || anchor.sourceItemId === instructionItemId)
            && !operation.sourceQuote.includes(anchor.sourceQuote))) {
          fail("inputs.relativeTo", "The command input anchor needs its own literal directory quote in this operation's instruction span.");
        }
        // Inspect the original directory before normalization can erase it via .. .
        assertWorkspaceDirectory(anchor.path, input.workspaceCwd, "inputs.relativeTo");
        const lexicalPath = `${anchor.path}/${target.path}`;
        const path = posix.normalize(lexicalPath);
        if (!isChannelOperationRelativePathV1(path)) fail("inputs.path", "Command input escapes its workspace.");
        assertWorkspaceDirectory(posix.dirname(lexicalPath), input.workspaceCwd, "inputs.relativeTo");
        assertWorkspacePath(path, input.workspaceCwd);
        return { path, sourceRefs: [sourceRef, anchorSource] };
      };
      const target = operation.target ? file(operation.target) : undefined;
      if (operation.target && (!operation.target.sourceItemId || operation.target.sourceItemId === instructionItemId)
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
        const sourceRef = quote(content.sourceQuote, content.sourceItemId, `${operationPath}.contentSource.sourceQuote`);
        if ((!content.sourceItemId || content.sourceItemId === instructionItemId)
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
            if (!predecessor || (predecessor.kind !== "file_read" && predecessor.kind !== "run_command")
              || predecessorOwnerId !== owner.id || !operation.dependsOn.includes(id)) {
              fail("contentSource.inputOperationIds", "Generated content inputs must name this owner's explicit read or command dependencies.");
            }
          }
          contentSource = { kind: "generated_objective", text: content.text, inputOperationIds, sourceRefs: [sourceRef] };
        }
      }
      const inputRefs = operation.kind === "file_read" || operation.kind === "file_edit" || operation.kind === "open_local_target" ? [target!] : [];
      if (operation.inputs) {
        if (operation.kind !== "run_command") fail("inputs", "Only a command operation may declare staged command inputs.");
        for (const commandInput of operation.inputs) {
          if ((!commandInput.sourceItemId || commandInput.sourceItemId === instructionItemId)
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
          // Command results are evidence dependencies, not file-read authority.
          // Their exact command/cwd and successful completion are checked by
          // the existing immutable-Run effect gate and operation verifier.
          if (predecessor.kind === "run_command") continue;
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
        const goalSource = quote(goal.sourceQuote, instructionItemId, `${operationPath}.commandGoal.sourceQuote`);
        if (!/\bnode\b/iu.test(operation.sourceQuote) || !operation.sourceQuote.includes(goal.sourceQuote) || !goal.sourceQuote.includes(goal.invocation)) {
          fail("commandGoal.sourceQuote", "The invocation must be quoted in the current operation, not supplied by prior model text.");
        }
        const module = commandFile(goal.module, `${operationPath}.commandGoal.module`);
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
        quote(operation.command.sourceQuote, instructionItemId, `${operationPath}.command.sourceQuote`);
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
        const rootSource = quote(root.sourceQuote, instructionItemId, `${operationPath}.projectInputRoot.sourceQuote`);
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
          ...(contentSource ? { contentSource } : {}), sourceRefs: [source, ...(ownerSource ? [ownerSource] : []),
            ...(continuation ? [quote(continuation.confirmation.body, input.sourceItemId),
              quote(continuation.clarification.body, continuation.clarification.itemId)] : [])],
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
    return { status: "bound", execution, capabilityBlockers, excludedParticipantIds: [...excludedParticipantIds] };
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

/** The same filesystem boundary applies to a deferred scope field. */
export function assertChannelOperationWorkspacePath(path: string, workspaceCwd: string): void {
  try { assertWorkspacePath(path, workspaceCwd); }
  catch (error) {
    if (!(error instanceof BindingError)) throw error;
    throw new Error("channel_pending_operation.invalid_project_scope", { cause: error });
  }
}

function assertWorkspaceDirectory(path: string, workspaceCwd: string, field = "workingDirectory"): void {
  let current = realpathSync(workspaceCwd);
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      const fact = lstatSync(current);
      if (!fact.isDirectory() || fact.isSymbolicLink()) fail(field, "Command directory cannot traverse a symlink or a non-directory.");
    } catch (error) {
      // A producer may create missing directories later. Still inspect the rest:
      // lexical .. can return to an existing ancestor before another symlink.
      // Execution must capture the final directory identity before any await.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof BindingError) throw error;
      fail(field, "Command directory could not be verified.");
    }
  }
}

export function isChannelOperationCandidatePlanV2(value: unknown): value is ChannelOperationCandidatePlanV2 {
  return validateCandidatePlan(value);
}

type ShapeReporter = (issue: ChannelOperationCandidateShapeIssue) => void;
const operationPath = "execution.operations[]";

/** The boolean guard and diagnostics share exactly the same strict validator. */
function validateCandidatePlan(value: unknown, report?: ShapeReporter): value is ChannelOperationCandidatePlanV2 {
  return record(value, ["schemaVersion", "operations", "continuation"], report, "execution")
    && literal(value.schemaVersion, 2, report, "execution.schemaVersion")
    && (value.continuation === undefined || candidateContinuation(value.continuation, report))
    && array(value.operations, 1, 64, report, "execution.operations")
    && value.operations.every(operation => candidateOperation(operation, report));
}

function candidateContinuation(value: unknown, report?: ShapeReporter): value is NonNullable<ChannelOperationCandidatePlanV2["continuation"]> {
  const path = "execution.continuation";
  return record(value, ["sourceItemId", "sourceRevision", "clarificationDecisionId", "clarificationItemId",
    "clarificationRevision", "contextSegmentId", "projectionFingerprint", "confirmationQuote", "excludedParticipants"], report, path)
    && ["sourceItemId", "clarificationDecisionId", "clarificationItemId", "contextSegmentId", "projectionFingerprint", "confirmationQuote"]
      .every(key => text(value[key], report, `${path}.${key}`))
    && ["sourceRevision", "clarificationRevision"].every(key => scalar(value[key], "number", report, `${path}.${key}`)
      && shape(Number.isSafeInteger(value[key]) && Number(value[key]) >= 0, `${path}.${key}`, "invalid_value", report))
    && (value.excludedParticipants === undefined || (array(value.excludedParticipants, 1, 64, report, `${path}.excludedParticipants`)
      && value.excludedParticipants.every(item => quotedPair(item, "participantId", report, `${path}.excludedParticipants[]`))));
}

function candidateOperation(value: unknown, report?: ShapeReporter): value is ChannelOperationCandidateV2 {
  const p = operationPath;
  if (!record(value, ["id", "kind", "targetKind", "required", "dependsOn", "owner", "sourceQuote", "target", "inputs", "projectInputRoot", "workingDirectory", "command", "commandGoal", "contentSource"], report, p)
    || !text(value.id, report, `${p}.id`) || !text(value.sourceQuote, report, `${p}.sourceQuote`)
    || !scalar(value.required, "boolean", report, `${p}.required`)
    || !texts(value.dependsOn, report, `${p}.dependsOn`)
    || !oneOf(value.kind, ["file_read", "file_create", "file_edit", "run_command", "open_local_target"], report, `${p}.kind`)
    || !literal(value.targetKind, value.kind === "run_command" ? "command" : "file", report, `${p}.targetKind`)
    || !candidateOwner(value.owner, report)
    || (value.target !== undefined && !candidatePath(value.target, report, `${p}.target`))
    || (value.inputs !== undefined && (!array(value.inputs, 1, 256, report, `${p}.inputs`)
      || !value.inputs.every(input => candidateCommandInput(input, report))))
    || (value.projectInputRoot !== undefined && !quotedPair(value.projectInputRoot, "path", report, `${p}.projectInputRoot`))
    || (value.workingDirectory !== undefined && !quotedPair(value.workingDirectory, "path", report, `${p}.workingDirectory`))
    || (value.command !== undefined && !quotedPair(value.command, "text", report, `${p}.command`))) return false;
  if (value.commandGoal !== undefined && (!record(value.commandGoal, ["kind", "module", "invocation", "sourceQuote"], report, `${p}.commandGoal`)
    || !literal(value.commandGoal.kind, "node_function", report, `${p}.commandGoal.kind`)
    || !candidatePath(value.commandGoal.module, report, `${p}.commandGoal.module`)
    || !text(value.commandGoal.invocation, report, `${p}.commandGoal.invocation`)
    || !text(value.commandGoal.sourceQuote, report, `${p}.commandGoal.sourceQuote`))) return false;
  const content = value.contentSource;
  const c = `${p}.contentSource`;
  return content === undefined || (record(content, ["kind", "text", "sourceQuote", "sourceItemId", "inputOperationIds"], report, c)
    && scalar(content.text, "string", report, `${c}.text`) && text(content.sourceQuote, report, `${c}.sourceQuote`)
    && (content.sourceItemId === undefined || text(content.sourceItemId, report, `${c}.sourceItemId`))
    && (content.kind === "literal" ? shape(content.inputOperationIds === undefined, `${c}.inputOperationIds`, "invalid_value", report)
      : literal(content.kind, "generated_objective", report, `${c}.kind`)
        && text(content.text, report, `${c}.text`) && texts(content.inputOperationIds, report, `${c}.inputOperationIds`)));
}

function candidateCommandInput(value: unknown, report?: ShapeReporter): value is CandidateCommandInput {
  const p = `${operationPath}.inputs[]`;
  return record(value, ["path", "sourceQuote", "sourceItemId", "relativeTo", "fromOperationId"], report, p)
    && pathFields(value, report, p)
    && (value.fromOperationId === undefined || text(value.fromOperationId, report, `${p}.fromOperationId`));
}

function candidatePath(value: unknown, report: ShapeReporter | undefined, path: string): value is CandidatePath {
  return record(value, ["path", "sourceQuote", "sourceItemId", "relativeTo"], report, path) && pathFields(value, report, path);
}

function pathFields(value: Record<string, unknown>, report: ShapeReporter | undefined, path: string): boolean {
  return text(value.path, report, `${path}.path`) && text(value.sourceQuote, report, `${path}.sourceQuote`)
    && (value.sourceItemId === undefined || text(value.sourceItemId, report, `${path}.sourceItemId`))
    && (value.relativeTo === undefined || (record(value.relativeTo, ["path", "sourceQuote", "sourceItemId"], report, `${path}.relativeTo`)
      && text(value.relativeTo.path, report, `${path}.relativeTo.path`)
      && text(value.relativeTo.sourceQuote, report, `${path}.relativeTo.sourceQuote`)
      && (value.relativeTo.sourceItemId === undefined || text(value.relativeTo.sourceItemId, report, `${path}.relativeTo.sourceItemId`))));
}

function candidateOwner(value: unknown, report?: ShapeReporter): value is ChannelOperationCandidateV2["owner"] {
  const p = `${operationPath}.owner`;
  if (!record(value, ["kind", "participantId", "sourceQuote"], report, p)) return false;
  return value.kind === "host_default" ? record(value, ["kind"], report, p)
    : (value.kind === undefined || literal(value.kind, "explicit", report, `${p}.kind`))
      && text(value.participantId, report, `${p}.participantId`) && text(value.sourceQuote, report, `${p}.sourceQuote`);
}

function quotedPair(value: unknown, key: "path" | "text" | "participantId", report: ShapeReporter | undefined, path: string): boolean {
  return record(value, [key, "sourceQuote"], report, path)
    && text(value[key], report, `${path}.${key}`) && text(value.sourceQuote, report, `${path}.sourceQuote`);
}

function shape(valid: boolean, path: string, code: ChannelOperationCandidateShapeIssue["code"], report?: ShapeReporter): boolean {
  if (!valid) report?.({ path, code });
  return valid;
}
function scalar(value: unknown, type: "string" | "number" | "boolean", report: ShapeReporter | undefined, path: string): boolean {
  return shape(typeof value === type, path, value === undefined ? "missing" : "invalid_type", report);
}
function literal(value: unknown, expected: string | number, report: ShapeReporter | undefined, path: string): boolean {
  return scalar(value, typeof expected === "string" ? "string" : "number", report, path)
    && shape(value === expected, path, "invalid_value", report);
}
function oneOf(value: unknown, allowed: readonly string[], report: ShapeReporter | undefined, path: string): boolean {
  return scalar(value, "string", report, path) && shape(allowed.includes(value as string), path, "invalid_value", report);
}
function record(value: unknown, keys: readonly string[], report?: ShapeReporter, path = "execution"): value is Record<string, unknown> {
  return shape(typeof value === "object" && value !== null && !Array.isArray(value), path, value === undefined ? "missing" : "invalid_type", report)
    && shape(Object.keys(value as object).every(key => keys.includes(key)), path, "unexpected_fields", report);
}
function text(value: unknown, report?: ShapeReporter, path = "execution"): value is string {
  return shape(typeof value === "string", path, value === undefined ? "missing" : "invalid_type", report)
    && shape((value as string).trim().length > 0, path, "invalid_value", report);
}
function array(value: unknown, min: number, max: number, report: ShapeReporter | undefined, path: string): value is readonly unknown[] {
  return shape(Array.isArray(value), path, value === undefined ? "missing" : "invalid_type", report)
    && shape((value as unknown[]).length >= min, path, "empty_array", report)
    && shape((value as unknown[]).length <= max, path, "too_many_items", report);
}
function texts(value: unknown, report?: ShapeReporter, path = "execution"): value is readonly string[] {
  return array(value, 0, Infinity, report, path) && value.every(item => text(item, report, `${path}[]`))
    && shape(new Set(value).size === value.length, path, "duplicate_value", report);
}
class BindingError extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}
function fail(field: string, reason: string): never { throw new BindingError(field, reason); }
