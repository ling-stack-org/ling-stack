import { createRequire } from "node:module";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { DesktopHumanEvaluationRequest, DesktopHumanEvaluationInspectRequest } from "../../shared/human-evaluation-capabilities.js";
import { DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { HumanEvaluationCoordinator } from "./coordinator.js";

export function registerHumanEvaluationIpc(options: {
  readonly coordinator?: HumanEvaluationCoordinator;
  readonly knownAppUrl: string;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly ipcMainImpl?: Pick<IpcMain, "handle" | "removeHandler">;
}): () => void {
  const ipc = options.ipcMainImpl ?? createRequire(import.meta.url)("electron").ipcMain as IpcMain;
  const registered: string[] = [];
  const authorized = (event: IpcMainInvokeEvent): boolean => {
    try {
      const window = options.getMainWindow(), owner = window?.webContents;
      return !!window && !window.isDestroyed() && !!owner && !owner.isDestroyed()
        && !event.sender.isDestroyed() && owner === event.sender && owner.mainFrame === event.senderFrame
        && owner.getURL() === options.knownAppUrl && event.sender.getURL() === options.knownAppUrl
        && event.senderFrame?.url === options.knownAppUrl;
    } catch { return false; }
  };
  try {
    ipc.handle(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.submit, async (event, ...args: unknown[]) => {
      if (!authorized(event)) return { accepted: false, reason: "unauthorized_sender" };
      let request: DesktopHumanEvaluationRequest | undefined;
      try { request = args.length === 1 ? parseHumanEvaluationRequest(args[0]) : undefined; } catch { /* Invalid structured input. */ }
      if (!request) return { accepted: false, reason: "invalid_request" };
      if (!options.coordinator) return { accepted: false, reason: "native_unavailable" };
      const result = await options.coordinator.submit(request, () => authorized(event));
      return authorized(event) ? result : { accepted: false, reason: "unauthorized_sender" };
    });
    registered.push(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.submit);
    ipc.handle(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.cancel, async (event, ...args: unknown[]) => {
      if (!authorized(event) || args.length !== 1 || !id(args[0])) return { accepted: false };
      return options.coordinator?.cancel(args[0]) ?? { accepted: false };
    });
    registered.push(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.cancel);
    ipc.handle(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.inspect, async (event, ...args: unknown[]) => {
      if (!authorized(event)) return { accepted: false, reason: "unauthorized_sender" };
      let request: DesktopHumanEvaluationInspectRequest | undefined;
      try { request = args.length === 1 ? parseHumanEvaluationInspectRequest(args[0]) : undefined; } catch { /* Invalid input. */ }
      if (!request) return { accepted: false, reason: "invalid_request" };
      if (!options.coordinator) return { accepted: false, reason: "native_unavailable" };
      const result = await options.coordinator.inspect(request, () => authorized(event));
      return authorized(event) ? result : { accepted: false, reason: "unauthorized_sender" };
    });
    registered.push(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.inspect);
  } catch (error) { for (const channel of registered) ipc.removeHandler(channel); throw error; }
  return () => { for (const channel of registered) ipc.removeHandler(channel); };
}

export function parseHumanEvaluationInspectRequest(value: unknown): DesktopHumanEvaluationInspectRequest | undefined {
  if (!own(value, ["taskId"], ["afterRevision", "reportRef"]) || !id(value.taskId)
    || (Object.hasOwn(value, "afterRevision") && (!Number.isSafeInteger(value.afterRevision) || Number(value.afterRevision) < 0))) return undefined;
  const ref = value.reportRef;
  if (ref !== undefined && (!own(ref, ["taskId", "eventId", "revision"]) || ref.taskId !== value.taskId
    || !id(ref.eventId) || !Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1)) return undefined;
  return Object.freeze({ taskId: value.taskId,
    ...(value.afterRevision !== undefined ? { afterRevision: value.afterRevision as number } : {}),
    ...(ref ? { reportRef: Object.freeze({ taskId: ref.taskId as string, eventId: ref.eventId as string, revision: ref.revision as number }) } : {}) });
}

/** Clone exact own data before any await; JSON identity flags and accessors are rejected. */
export function parseHumanEvaluationRequest(value: unknown): DesktopHumanEvaluationRequest | undefined {
  if (!own(value, ["taskId", "requestId", "submission"]) || !id(value.taskId) || !id(value.requestId)) return undefined;
  const s = value.submission;
  if (!s || typeof s !== "object") return undefined;
  const kind = Object.getOwnPropertyDescriptor(s, "kind")?.value;
  if (kind === "revoke" && own(s, ["kind", "revokesEventId", "rationale"])
    && id(s.revokesEventId) && rationale(s.rationale)) {
    return Object.freeze({ taskId: value.taskId, requestId: value.requestId,
      submission: Object.freeze({ kind: "revoke", revokesEventId: s.revokesEventId, rationale: s.rationale }) });
  }
  if (kind !== "adjudicate" && kind !== "correct") return undefined;
  if (!own(s, kind === "adjudicate" ? ["kind", "decision"] : ["kind", "decision", "supersedesEventId"])) return undefined;
  if (kind === "correct" && !id(s.supersedesEventId)) return undefined;
  const d = s.decision;
  if (!own(d, ["verdict", "rationale"], ["score", "severity"]) || !rationale(d.rationale)
    || typeof d.verdict !== "string" || !["pass", "fail", "abstain", "error"].includes(d.verdict)
    || (Object.hasOwn(d, "score") && (typeof d.score !== "number" || !Number.isFinite(d.score) || d.score < 0 || d.score > 1))
    || (Object.hasOwn(d, "severity") && (typeof d.severity !== "string"
      || !["info", "warning", "error", "critical"].includes(d.severity)))) return undefined;
  const decision = Object.freeze({ verdict: d.verdict, rationale: d.rationale,
    ...(Object.hasOwn(d, "score") ? { score: d.score } : {}), ...(Object.hasOwn(d, "severity") ? { severity: d.severity } : {}) });
  return Object.freeze({ taskId: value.taskId, requestId: value.requestId, submission: Object.freeze({ kind,
    ...(kind === "correct" ? { supersedesEventId: s.supersedesEventId } : {}), decision }) }) as DesktopHumanEvaluationRequest;
}

function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(value); }
function rationale(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0
  && value.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value); }
function own(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  return keys.every((key) => typeof key === "string" && [...required, ...optional].includes(key)
    && Object.hasOwn(descriptors[key], "value")) && required.every((key) => Object.hasOwn(descriptors, key));
}
