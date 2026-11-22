import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LingAppServerProjectInstructionManifest, LingAppServerProjectInstructionUpdate } from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, parseApplyPatch, redactSecrets, type RunSession, type RunStore } from "@ling-stack/core";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import { trimOversizedEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import { readPatchText } from "../runs/patch-actions.js";
import { collectProjectInstructions, isInside, maxProjectInstructionBytes, maxProjectInstructionScopes,
  projectInstructionManifest } from "./project-instructions.js";

interface StoredInstructions extends LingAppServerProjectInstructionUpdate {
  readonly threadId: string;
  readonly prompt: readonly string[];
}

type ToolCheck = NonNullable<PiRunnerRunOptions["onToolBefore"]>;
type ProjectContext = NonNullable<PiRunnerRunOptions["projectInstructionContext"]>;

export function createRuntimeProjectInstructions(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly cwd: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly prepared?: LingAppServerProjectInstructionManifest;
  readonly extraSecrets: readonly (string | undefined)[];
  readonly events?: ControlPlaneEventHub;
  readonly assertCurrent: () => void;
}): { readonly checkTool: ToolCheck; readonly projectContext: ProjectContext } {
  const { store, run, threadId, turnId } = input;
  const initial = input.prepared?.sources ?? [];
  const retained = store.getAppServerState("project_instruction_update", run.id);
  let revision = retained?.revision ?? 0;
  let state = retained?.payload as StoredInstructions | undefined ?? {
    runId: run.id, threadId, manifest: projectInstructionManifest([], []), prompt: [], presentedSourceCount: 0,
  };
  let discoveries: Promise<unknown> = Promise.resolve();

  function save(next: StoredInstructions, action: "discovered" | "presented"): void {
    input.assertCurrent();
    const saved = store.putAppServerState({
      kind: "project_instruction_update", recordId: run.id, expectedRevision: revision, payload: next,
    }, new Date().toISOString(), {
      workspaceId: DEFAULT_WORKSPACE_ID, cwd: input.cwd, domain: "runs", entityType: "turn", entityId: turnId,
      action: `turn.project_instructions.${action}`,
      data: { threadId, turnId, runId: run.id, revision: revision + 1,
        manifestDigest: next.manifest.digest, presentedSourceCount: next.presentedSourceCount },
    });
    if (!saved) throw new Error("Project instruction evidence changed during execution.");
    revision = saved.record.revision;
    state = next;
    if (saved.event) input.events?.publish(trimOversizedEvent(saved.event));
  }

  const checkTool: ToolCheck = request => {
    const paths = scopedToolPaths(request);
    if (!paths.length) return { allowed: true };
    const mutates = request.toolName === "edit" || request.toolName === "write";
    const next = discoveries.then(async () => {
      const root = await realpath(input.cwd);
      const executionRoot = await realpath(run.cwd);
      if (!isInside(root, executionRoot)) return { allowed: true } as const;
      const directories = (await Promise.all(paths.map(path => instructionDirectory(root, executionRoot, path, mutates))))
        .filter((directory): directory is string => directory !== undefined);
      if (!directories.length) return { allowed: true } as const;
      const known = [...initial, ...state.manifest.sources];
      const usedBytes = known.reduce((sum, source) => sum + (source.applicable ? source.textBytes ?? 0 : 0), 0);
      const rules = await collectProjectInstructions(root, directories, {
        frozenScopes: new Set(known.map(source => source.scope)),
        remainingBytes: maxProjectInstructionBytes - usedBytes,
        remainingSources: maxProjectInstructionScopes - known.length,
      });
      const omitted = [...new Set([...state.manifest.omitted, ...rules.manifest.omitted])].slice(0, maxProjectInstructionScopes);
      if (rules.manifest.sources.length || omitted.length !== state.manifest.omitted.length) {
        save({ ...state,
          manifest: projectInstructionManifest([...state.manifest.sources, ...rules.manifest.sources], omitted),
          prompt: [...state.prompt, ...rules.prompt.map(prompt => String(redactSecrets(prompt, input.extraSecrets)))],
        }, "discovered");
      }
      input.assertCurrent();
      if (!mutates) return { allowed: true };
      const affectsDirectory = (scope: string) => directories.some(directory => isInside(resolve(root, scope), directory));
      if (rules.manifest.omitted.length || state.manifest.sources.some(source => !source.applicable && affectsDirectory(source.scope))) {
        return { allowed: false, code: "project_instructions_unavailable", reason: "Project conventions in this scope could not be loaded." };
      }
      const unpresented = state.manifest.sources.filter(source => source.applicable).slice(state.presentedSourceCount);
      return unpresented.some(source => affectsDirectory(source.scope))
        ? { allowed: false, code: "project_instructions_pending", reason: "Scoped project conventions are included in your next model request. Review them before retrying this edit." }
        : { allowed: true };
    }) satisfies Promise<Awaited<ReturnType<ToolCheck>>>;
    discoveries = next.catch(() => undefined);
    return next;
  };

  const projectContext: ProjectContext = () => {
    const { prompt } = state;
    if (!prompt.length) return undefined;
    return {
      prompt: prompt.join("\n\n"),
      onAdmitted() {
        if (prompt.length > state.presentedSourceCount) save({ ...state, presentedSourceCount: prompt.length }, "presented");
      },
    };
  };
  return { checkTool, projectContext };
}

export function readRuntimeProjectInstructions(store: RunStore, turnId: string): LingAppServerProjectInstructionUpdate[] {
  return store.listLingTurnRuns(turnId).slice(-16).flatMap(({ runId }) => {
    const record = store.getAppServerState("project_instruction_update", runId)?.payload as StoredInstructions | undefined;
    return record ? [{ runId, manifest: record.manifest, presentedSourceCount: record.presentedSourceCount }] : [];
  });
}

function scopedToolPaths(request: Parameters<ToolCheck>[0]): readonly string[] {
  if (!["read", "grep", "find", "ls", "edit", "write"].includes(request.toolName) || !isRecord(request.input)) return [];
  const patch = readPatchText(request.toolName, request.input);
  if (patch) return parseApplyPatch(patch).operations.map(operation => operation.path);
  return typeof request.input.path === "string" && request.input.path.trim() ? [request.input.path] : [];
}

async function instructionDirectory(root: string, cwd: string, path: string, mutates: boolean): Promise<string | undefined> {
  let target = resolve(cwd, !mutates && path.startsWith("@") ? path.slice(1) : path);
  while (isInside(root, target)) {
    const canonical = await realpath(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (canonical) {
      if (!isInside(root, canonical)) return undefined;
      return (await lstat(canonical)).isDirectory() ? canonical : dirname(canonical);
    }
    if (target === root) break;
    target = dirname(target);
  }
  return undefined;
}
