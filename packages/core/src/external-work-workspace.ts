import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createCoreOriginalProcessEntry, isCoreOriginalLaunchRefusal, type CoreOriginalProcessEntry } from "./original-host-process-entry.js";
import { normalizeGitRemoteUrl } from "./external-work.js";
import { redactGitRemoteUrl, redactSecrets } from "./redaction.js";
import type { ExternalWorkspaceHooks } from "./external-work-types.js";
import type { RunArtifact, RunExecutionStoreFacet, RunStorePathsFacet, RuntimeSupervisorStoreFacet } from "./run-types.js";
import { DEFAULT_WORKSPACE_ID, type Channel } from "./workspace-types.js";

type WorkspaceStore = RunStorePathsFacet & Pick<RunExecutionStoreFacet, "createArtifact"> &
  Pick<RuntimeSupervisorStoreFacet, "acquireResourceLease" | "releaseResourceLeasesForOwner">;
type WorkspaceCommand = { readonly cwd: string } & (
  | { readonly kind: "hook"; readonly command: string }
  | { readonly kind: "git_checkout"; readonly remoteUrl: string }
);
interface CommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}
interface WorkspacePreparationInput {
  readonly store: WorkspaceStore;
  readonly externalWorkId: string;
  readonly channel: Channel;
  readonly workspacePath: string;
  readonly hooks: ExternalWorkspaceHooks;
  readonly gitRemoteUrl?: string;
  readonly previousCheckoutFailed: boolean;
  readonly executeHooks: boolean;
  readonly runAfterCreate: boolean;
  readonly ownerId: string;
  readonly now: string;
  readonly extraSecrets: readonly (string | undefined)[];
}

const LEASE_TTL_MS = 15 * 60 * 1000;
const originalSpawn = spawn;
const originalWorkspaceProcess = createCoreOriginalProcessEntry("external_work_scheduler", (input: WorkspaceCommand) =>
  input.kind === "hook"
    ? originalSpawn(input.command, { cwd: input.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] })
    : originalSpawn("git", ["clone", "--", input.remoteUrl, "."], {
      cwd: input.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    }));
export const CORE_EXTERNAL_WORK_SCHEDULER_ENTRY: CoreOriginalProcessEntry = originalWorkspaceProcess.entry;

export class WorkspacePreparationError extends Error {
  constructor(message: string, readonly artifacts: readonly RunArtifact[], readonly checkoutFailed = false) {
    super(message);
    this.name = "WorkspacePreparationError";
  }
}

/** Workspace preparation shares the scheduler's leases, explicit execution gate and original Host entry. */
export async function runWorkspacePreparation(input: WorkspacePreparationInput): Promise<RunArtifact[]> {
  const defaultCheckout = Boolean(input.gitRemoteUrl && !input.hooks.afterCreate);
  if (defaultCheckout && input.previousCheckoutFailed && !input.runAfterCreate) {
    throw new WorkspacePreparationError("Workspace checkout is blocked after an earlier failure; allocate a fresh workspace before retrying.", [], true);
  }
  if (!input.executeHooks) return [];
  const expiresAt = new Date(Date.parse(input.now) + LEASE_TTL_MS).toISOString();
  const leases = [
    input.store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "external_workspace", resourceKey: input.workspacePath,
      ownerType: "system", ownerId: input.ownerId, acquiredAt: input.now, expiresAt,
    }),
    input.store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "bound_path", resourceKey: input.channel.boundPath ?? input.workspacePath,
      ownerType: "system", ownerId: input.ownerId, acquiredAt: input.now, expiresAt,
    }),
  ];
  if (leases.some((lease) => lease === undefined)) {
    input.store.releaseResourceLeasesForOwner("system", input.ownerId, new Date().toISOString());
    throw new WorkspacePreparationError("Workspace hook lease conflict.", [], defaultCheckout && input.runAfterCreate);
  }
  const artifacts: RunArtifact[] = [];
  try {
    if (input.runAfterCreate && input.hooks.afterCreate) {
      await runPreparationCommand(input, { kind: "hook", command: input.hooks.afterCreate, cwd: input.workspacePath }, "afterCreate", artifacts);
    } else if (defaultCheckout && input.runAfterCreate) {
      try {
        if (readdirSync(input.workspacePath).length === 0) {
          const remoteUrl = normalizeGitRemoteUrl(input.gitRemoteUrl!);
          await runPreparationCommand(input, { kind: "git_checkout", remoteUrl, cwd: input.workspacePath }, "checkout", artifacts);
        }
      } catch (error) {
        if (isCoreOriginalLaunchRefusal(error) || error instanceof WorkspacePreparationError) throw error;
        throw new WorkspacePreparationError("Workspace checkout could not be confirmed; inspect the workspace and checkout evidence before retrying.", artifacts, true);
      }
    }
    if (input.hooks.beforeRun) {
      await runPreparationCommand(input, { kind: "hook", command: input.hooks.beforeRun, cwd: input.workspacePath }, "beforeRun", artifacts);
    }
    return artifacts;
  } finally {
    input.store.releaseResourceLeasesForOwner("system", input.ownerId, new Date().toISOString());
  }
}

async function runPreparationCommand(
  input: WorkspacePreparationInput, command: WorkspaceCommand,
  name: "afterCreate" | "beforeRun" | "checkout", artifacts: RunArtifact[],
): Promise<void> {
  const startedAt = Date.now();
  const result = await runCommand(command, input.hooks.timeoutMs);
  const remoteUrl = command.kind === "git_checkout" ? redactGitRemoteUrl(command.remoteUrl) : undefined;
  const payload = redactSecrets({
    ...(command.kind === "hook" ? { hook: name } : { type: "git_checkout", remoteUrl, redactedRemoteUrl: remoteUrl }),
    command: command.kind === "hook" ? command.command : `git clone -- ${remoteUrl} .`,
    cwd: input.workspacePath, exitCode: result.exitCode, timedOut: result.timedOut,
    durationMs: Date.now() - startedAt, stdout: result.stdout, stderr: result.stderr,
  }, input.extraSecrets);
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const artifactDir = resolve(input.store.paths.artifactsDir, "external-work", input.externalWorkId, "hooks");
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = resolve(artifactDir, `${Date.now()}-${name}.json`);
  writeFileSync(artifactPath, content, "utf8");
  try {
    artifacts.push(input.store.createArtifact({
      externalWorkId: input.externalWorkId, type: "json", path: relative(input.store.paths.artifactsDir, artifactPath).replace(/\\/g, "/"),
      title: command.kind === "hook" ? `External work hook: ${name}` : "External work Git checkout",
      contentType: "application/json; charset=utf-8", sizeBytes: Buffer.byteLength(content, "utf8"), createdAt: new Date().toISOString(),
    }));
  } catch (error) {
    throw new WorkspacePreparationError(
      command.kind === "git_checkout"
        ? "Workspace checkout evidence could not be persisted. The workspace remains blocked."
        : `Workspace hook evidence could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      artifacts,
      command.kind === "git_checkout",
    );
  }
  if (result.timedOut || result.exitCode !== 0) {
    const operation = command.kind === "hook" ? `Workspace hook ${name}` : "Workspace checkout";
    throw new WorkspacePreparationError(
      result.timedOut ? `${operation} timed out.` : `${operation} failed with exit code ${result.exitCode}.`, artifacts, command.kind === "git_checkout",
    );
  }
}

function runCommand(command: WorkspaceCommand, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const record = originalWorkspaceProcess.capture(Object.freeze(command));
    const child = originalWorkspaceProcess.entry.invoke(record);
    let stdout = "", stderr = "", timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      if (command.kind === "git_checkout") escalation = setTimeout(() => terminate("SIGKILL"), 1_000);
    }, timeoutMs);
    const terminate = (signal: NodeJS.Signals): void => {
      if (command.kind === "git_checkout" && process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, signal); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
      } else child.kill(signal);
    };
    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      clearTimeout(escalation);
      resolveResult({ exitCode, timedOut, stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => { stdout = appendLimited(stdout, String(chunk)); });
    child.stderr?.on("data", (chunk) => { stderr = appendLimited(stderr, String(chunk)); });
    child.once("error", (error) => { stderr = appendLimited(stderr, error.message); finish(1); });
    child.once("close", finish);
  });
}

function appendLimited(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-64_000);
}
