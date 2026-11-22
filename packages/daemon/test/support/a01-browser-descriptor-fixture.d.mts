import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import type { TestContext } from "node:test";
import type { ChromeBrowserRuntimeDescriptorV1 } from "../../../contracts/dist/index.js";
import type { ChromeBrowserNativeBrokerHandle } from "../../dist/features/browser-extension/native-broker.js";
import type { ChromeBrowserSessionController } from "../../dist/features/browser-extension/session-controller.js";

interface Signal<T = void> {
  promise: Promise<T>;
  complete(value: T): void;
}

interface DescriptorGate {
  entered: Signal<ChromeBrowserRuntimeDescriptorV1>;
  release: Signal;
}

interface LockContention {
  path: string;
  code: string;
  errcode: number;
}

type WorkerEvent =
  | { kind: "ready"; generation: string; port: number }
  | { kind: "held" | "published"; generation: string }
  | { kind: "lock-contention"; evidence: LockContention }
  | { kind: "read-captured" | "closed" | "ready-to-publish" };

type WorkerCommand = { kind: "close" | "release-read" | "go" | "release" | "finish" };

export function signal<T = void>(): Signal<T>;
export function bounded<T>(promise: PromiseLike<T>, label: string, timeoutMs?: number): Promise<T>;
export function assertA01Isolation(environment?: NodeJS.ProcessEnv): void;
export function a01Environment(home: string, workspace: string, caseName: string): NodeJS.ProcessEnv;
export function descriptorPathForA01(): string;
export function runA01Child(caseName: string, entryUrl: string): Promise<void>;

export function observeA01Descriptor(
  context: { mock: TestContext["mock"]; after(callback: () => void): void },
  descriptorPath: string,
): {
  events: { kind: string; [key: string]: unknown }[];
  contention: Signal<LockContention>;
  readonly contentionCount: number;
  readonly published: Signal;
  record(kind: string, details?: Record<string, unknown>): void;
  restore(): void;
  readGate(generation: string): DescriptorGate;
  renameGate(generation?: string): DescriptorGate;
  releaseAll(): void;
  actualRead(): Promise<ChromeBrowserRuntimeDescriptorV1 | undefined>;
};

export function createA01Broker(options?: { workspace?: string; refreshMs?: number; now?: () => number }): Promise<{
  broker: ChromeBrowserNativeBrokerHandle;
  controller: ChromeBrowserSessionController;
  workspace: string;
  close(): Promise<void>;
}>;

export function assertA01BrokerHandshake(
  descriptor: Pick<ChromeBrowserRuntimeDescriptorV1, "port" | "token">,
  options?: { keepOpen?: boolean; expectedCode?: string; hello?: Record<string, unknown> },
): Promise<Socket>;

export function spawnA01Worker(entryUrl: string, role: string, workspace: string): {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  send(message: WorkerCommand): void;
  wait<K extends WorkerEvent["kind"]>(kind: K): Promise<WorkerEvent & { kind: K }>;
  waitAny<K extends WorkerEvent["kind"]>(kinds: readonly K[]): Promise<WorkerEvent & { kind: K }>;
};
