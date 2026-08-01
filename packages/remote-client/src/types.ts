import type {
  RemoteP256PublicJwkV1,
  RemoteResumeCursorV1,
} from "@ling-stack/contracts";

export interface RemoteDeviceKeyInfo {
  readonly keyId: string;
  readonly publicJwk: RemoteP256PublicJwkV1;
  readonly hardwareBacked: boolean;
  readonly privateKeyExportable: false;
}

export interface RemoteDeviceKeyAdapter {
  generateOrLoad(keyId: string): Promise<RemoteDeviceKeyInfo>;
  sign(keyId: string, message: Uint8Array): Promise<string>;
  verify(publicJwk: RemoteP256PublicJwkV1, message: Uint8Array, signatureBase64Url: string): Promise<boolean>;
  delete(keyId: string): Promise<void>;
}

export interface RemoteEntropy {
  randomBytes(length: number): Promise<Uint8Array> | Uint8Array;
  randomId(prefix: string): Promise<string> | string;
}

export interface RemoteClock {
  now(): string;
}

export interface RemoteHttpResponse<T> {
  readonly status: number;
  readonly body: T;
}

export interface RemoteHttpClient {
  getJson<T>(origin: string, path: string): Promise<RemoteHttpResponse<T>>;
  postJson<T>(origin: string, path: string, body: unknown): Promise<RemoteHttpResponse<T>>;
}

export interface RemoteSocketMessageEvent {
  readonly data: unknown;
}

export interface RemoteSocketCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

export interface RemoteWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: RemoteSocketMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: RemoteSocketCloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type RemoteWebSocketFactory = (url: string) => RemoteWebSocketLike;

export interface RemoteBindingV1 {
  readonly version: 1;
  readonly status: "active" | "revoked";
  readonly gatewayId: string;
  readonly gatewayOrigin: string;
  readonly gatewayIdentityPublicKeyJwk: RemoteP256PublicJwkV1;
  readonly gatewayIdentityFingerprint: string;
  readonly deviceId: string;
  readonly deviceKeyId: string;
  readonly deviceEpoch: number;
  readonly pairedAt: string;
  readonly workspaceBindingId?: string;
}

export interface RemoteBindingStore {
  read(): Promise<RemoteBindingV1 | undefined>;
  write(binding: RemoteBindingV1): Promise<void>;
  remove(): Promise<void>;
}

export interface RemoteCacheEnvelopeV1<TState> {
  readonly version: 1;
  readonly workspaceBindingId: string;
  readonly state: TState;
  readonly resume: readonly RemoteResumeCursorV1[];
  readonly updatedAt: string;
}

export interface RemoteCacheStore<TState> {
  read(workspaceBindingId: string): Promise<RemoteCacheEnvelopeV1<TState> | undefined>;
  write(workspaceBindingId: string, cache: RemoteCacheEnvelopeV1<TState>): Promise<void>;
  remove(workspaceBindingId: string): Promise<void>;
}

export const systemRemoteClock: RemoteClock = {
  now: () => new Date().toISOString(),
};

export function createFetchRemoteHttpClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): RemoteHttpClient {
  return {
    async getJson<T>(origin: string, path: string): Promise<RemoteHttpResponse<T>> {
      return await requestJson<T>(fetchImpl, origin, path, { method: "GET" });
    },
    async postJson<T>(origin: string, path: string, body: unknown): Promise<RemoteHttpResponse<T>> {
      return await requestJson<T>(fetchImpl, origin, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

async function requestJson<T>(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  path: string,
  init: RequestInit,
): Promise<RemoteHttpResponse<T>> {
  const response = await fetchImpl(new URL(path, origin), init);
  const body = await response.json() as T;
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
    throw new Error(typeof record?.message === "string" ? record.message : `remote_http_${response.status}`);
  }
  return { status: response.status, body };
}

export function remoteWebSocketUrl(origin: string): string {
  const url = new URL("/v1/session", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
