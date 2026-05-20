import type { RunEventsResponse, RunFormState, RunListResponse, RunSession, ToolName } from "./types.js";

export const daemonBaseUrl =
  import.meta.env.VITE_LING_STACK_DAEMON_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:17891";

export async function getDaemonHealth(): Promise<boolean> {
  const response = await fetch(`${daemonBaseUrl}/health`);
  if (!response.ok) {
    return false;
  }
  const body = (await response.json()) as { ok?: unknown };
  return body.ok === true;
}

export async function getRun(runId: string, cwd?: string): Promise<RunSession> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/runs/${encodeURIComponent(runId)}`, cwd));
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RunSession;
}

export async function listRuns(cwd: string, limit = 50): Promise<RunListResponse> {
  const parsed = new URL(`${daemonBaseUrl}/runs`);
  parsed.searchParams.set("cwd", cwd);
  parsed.searchParams.set("limit", String(limit));
  const response = await fetch(parsed.toString());
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RunListResponse;
}

export async function getRunEvents(runId: string, cwd?: string): Promise<RunEventsResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/runs/${encodeURIComponent(runId)}/events`, cwd));
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RunEventsResponse;
}

export function buildRunRequest(form: RunFormState): unknown {
  return {
    cwd: form.cwd,
    task: {
      id: form.taskId,
      title: form.title,
      prompt: form.prompt,
      channelId: "workspace",
    },
    provider: {
      provider: form.provider,
      model: form.model,
      baseUrl: form.baseUrl || undefined,
      apiKey: form.apiKey || undefined,
      api: form.api || undefined,
      authHeader: true,
      input: ["text"],
    },
    tools: form.tools.filter(isRunnerTool),
    thinkingLevel: "medium",
  };
}

function isRunnerTool(tool: ToolName): tool is "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write" {
  return ["read", "grep", "find", "ls", "bash", "edit", "write"].includes(tool);
}

function withCwd(url: string, cwd?: string): string {
  if (!cwd) {
    return url;
  }
  const parsed = new URL(url);
  parsed.searchParams.set("cwd", cwd);
  return parsed.toString();
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") {
      return body.message;
    }
    if (typeof body.error === "string") {
      return body.error;
    }
  } catch {
    return `${response.status} ${response.statusText}`;
  }
  return `${response.status} ${response.statusText}`;
}
