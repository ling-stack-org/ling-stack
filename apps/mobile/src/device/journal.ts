import type {
  DeviceObservationV1,
  DeviceTaskV1,
} from "@ling-stack/contracts";
import {
  isDeviceActionRequestV1,
  isDeviceObservationV1,
  isDeviceTaskAttemptV1,
  isDeviceTaskV1,
} from "@ling-stack/contracts";
import type { MobileAttemptRecord, MobileDeviceJournal } from "./execution.js";

export interface MobileStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}

export function createAsyncStorageMobileDeviceJournal(storage: MobileStorageLike, ownerId: string): MobileDeviceJournal {
  const prefix = `ling-device-execution:v1:${ownerId}`;
  const tasksKey = `${prefix}:tasks`;
  const taskKey = (taskId: string) => `${prefix}:task:${taskId}`;
  const attemptKey = (taskId: string, idempotencyKey: string) => `${prefix}:attempt:${taskId}:${encodeURIComponent(idempotencyKey)}`;
  const attemptsKey = (taskId: string) => `${prefix}:attempts:${taskId}`;
  const observationKey = (taskId: string) => `${prefix}:observations:${taskId}`;
  let writes = Promise.resolve();
  const write = (mutation: () => Promise<void>): Promise<void> => {
    const next = writes.then(mutation);
    writes = next.catch(() => undefined);
    return next;
  };

  return {
    async getTask(taskId) {
      return parseTaskValue(await storage.getItem(taskKey(taskId)));
    },
    async listTasks() {
      const ids = parseStringArray(await storage.getItem(tasksKey));
      const tasks = await Promise.all(ids.map(id => parseTask(storage.getItem(taskKey(id)))));
      return tasks.filter((task): task is DeviceTaskV1 => task !== undefined);
    },
    saveTask(task) {
      return write(async () => {
        if (!isDeviceTaskV1(task)) throw new Error("Invalid mobile device task");
        const ids = parseStringArray(await storage.getItem(tasksKey));
        if (!ids.includes(task.id)) await storage.setItem(tasksKey, JSON.stringify([...ids, task.id]));
        await storage.setItem(taskKey(task.id), JSON.stringify(task));
      });
    },
    async getAttemptByIdempotency(taskId, idempotencyKey) {
      const attempts = parseAttemptArray(await storage.getItem(attemptsKey(taskId)));
      return attempts.find(item => item.request.idempotencyKey === idempotencyKey)
        ?? await parseAttempt(storage.getItem(attemptKey(taskId, idempotencyKey)));
    },
    async listAttempts(taskId) {
      return parseAttemptArray(await storage.getItem(attemptsKey(taskId)));
    },
    async listObservations(taskId) {
      return parseObservationArray(await storage.getItem(observationKey(taskId)));
    },
    saveAttempt(record) {
      return write(async () => {
        if (!isDeviceTaskAttemptV1(record.attempt) || !isDeviceActionRequestV1(record.request)) throw new Error("Invalid mobile device attempt");
        const key = attemptsKey(record.request.taskId);
        const attempts = parseAttemptArray(await storage.getItem(key));
        const next = attempts.filter(item => item.request.idempotencyKey !== record.request.idempotencyKey);
        next.push(record);
        await storage.setItem(key, JSON.stringify(next));
      });
    },
    saveObservation(taskId, observation: DeviceObservationV1) {
      return write(async () => {
        if (!isDeviceObservationV1(observation)) throw new Error("Invalid mobile device observation");
        const key = observationKey(taskId);
        const current = parseObservationArray(await storage.getItem(key));
        if (!current.some(item => item.id === observation.id)) await storage.setItem(key, JSON.stringify([...current, observation]));
      });
    },
  };
}

async function parseTask(value: Promise<string | null>): Promise<DeviceTaskV1 | undefined> {
  return parseTaskValue(await value);
}

function parseTaskValue(value: string | null): DeviceTaskV1 | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  return isDeviceTaskV1(parsed) ? parsed : undefined;
}

function parseStringArray(value: string | null): readonly string[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : [];
}

function parseAttempt(value: Promise<string | null>): Promise<MobileAttemptRecord | undefined> {
  return value.then(raw => {
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isAttemptRecord(parsed) ? parsed : undefined;
  });
}

function parseAttemptArray(value: string | null): readonly MobileAttemptRecord[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter(isAttemptRecord) : [];
}

function parseObservationArray(value: string | null): readonly DeviceObservationV1[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter(isDeviceObservationV1) : [];
}

function isAttemptRecord(value: unknown): value is MobileAttemptRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && isDeviceTaskAttemptV1((value as Record<string, unknown>).attempt)
    && isDeviceActionRequestV1((value as Record<string, unknown>).request)
    && typeof (value as Record<string, unknown>).requestDigest === "string";
}
