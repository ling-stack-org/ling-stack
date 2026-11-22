export type StoredValues = Record<string, unknown>;
export type WireMessage = Record<string, unknown>;
export type MessageListener = (message: WireMessage) => void;

export interface PopupMessage {
  type: "status" | "connect" | "pause" | "resume";
}

export interface PopupResponse {
  ok: boolean;
  error?: string;
  connected?: boolean;
  state?: string;
  transport?: string;
}

export type PopupListener = (
  message: PopupMessage,
  sender: Record<string, unknown>,
  sendResponse: (response: PopupResponse) => void,
) => boolean;

export interface AlarmOptions {
  delayInMinutes: number;
  periodInMinutes: number;
}

export interface RuntimeListeners {
  alarm?: (alarm: { name: string }) => void;
  installed?: () => void;
  message?: PopupListener;
  startup?: () => void;
}

export interface NativePort {
  onMessage: { addListener(listener: MessageListener): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: WireMessage): void;
  disconnect(): void;
}

interface StorageArea {
  get(keys: string[]): Promise<StoredValues>;
  remove(keys: string[]): Promise<void>;
  set(values: StoredValues): Promise<unknown>;
}

interface Tab {
  id: number;
  windowId: number;
  active: boolean;
  title: string;
  url: string;
}

export interface ChromeFixture {
  alarms: {
    clear(name: string): Promise<boolean>;
    create(name: string, options: AlarmOptions): unknown;
    get(name: string): Promise<AlarmOptions | undefined>;
    onAlarm: { addListener(listener: NonNullable<RuntimeListeners["alarm"]>): void };
  };
  runtime: {
    lastError?: { message: string };
    connectNative(name: string): NativePort;
    getManifest(): { version: string };
    onInstalled: { addListener(listener: () => void): void };
    onMessage: { addListener(listener: PopupListener): void };
    onStartup: { addListener(listener: () => void): void };
    sendMessage(message: WireMessage): Promise<unknown>;
  };
  scripting: {
    executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
  storage: { local: StorageArea; session: StorageArea };
  tabs: {
    query(options: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    get?(tabId: number): Promise<Tab>;
    update?(tabId: number, options: { active: boolean }): Promise<Tab>;
    captureVisibleTab?(windowId: number, options: { format: "jpeg"; quality: number }): Promise<string>;
  };
  windows?: {
    update(windowId: number, options: { focused: boolean }): Promise<{ id: number; focused: boolean }>;
  };
}

export type ChromeFixtureGlobals = typeof globalThis & { chrome?: ChromeFixture };

export interface SocketEvent {
  code?: number;
  reason?: string;
  data?: string;
}

// Timer handles belong to the fixtures and expose only the callbacks they drive.
export interface IntervalHandle {
  callback: () => void;
}

export interface TimeoutEntry {
  callback: () => void;
  delay?: number;
}
