import {
  RemotePairingClient,
  RemoteSessionClient,
  createFetchRemoteHttpClient,
  createInitialRemoteClientState,
  systemRemoteClock,
  type RemoteBindingV1,
  type RemoteClientState,
  type RemotePendingPairing,
  type RemoteWebSocketLike,
} from "@ling-stack/remote-client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  mobileRemoteBindingStore,
  mobileRemoteCacheStore,
  removeConversationDrafts,
} from "../platform/remote-storage";
import {
  nativeSecureDeviceKeyAdapter,
  nativeSecureEntropy,
} from "../platform/secure-device-key/native-adapter";
import { pollForPairingAcceptance } from "./pairing-polling";

export type MobilePairingPhase =
  | "loading"
  | "welcome"
  | "scanner"
  | "submitting"
  | "awaiting_pc"
  | "initial_sync"
  | "paired"
  | "error";

export interface MobileRemoteContextValue {
  readonly phase: MobilePairingPhase;
  readonly error?: string;
  readonly pendingPairing?: RemotePendingPairing;
  readonly binding?: RemoteBindingV1;
  readonly client?: RemoteSessionClient;
  readonly remoteState: RemoteClientState;
  readonly openScanner: () => void;
  readonly cancelPairing: () => void;
  readonly pairFromQr: (encodedQr: string) => Promise<void>;
  readonly retryConnection: () => Promise<void>;
  readonly unpair: () => Promise<void>;
}

const MobileRemoteContext = createContext<MobileRemoteContextValue | undefined>(undefined);
const http = createFetchRemoteHttpClient();

export function MobileRemoteProvider({ children }: { readonly children: ReactNode }) {
  const [phase, setPhase] = useState<MobilePairingPhase>("loading");
  const [error, setError] = useState<string>();
  const [pendingPairing, setPendingPairing] = useState<RemotePendingPairing>();
  const [binding, setBinding] = useState<RemoteBindingV1>();
  const [client, setClient] = useState<RemoteSessionClient>();
  const [remoteState, setRemoteState] = useState<RemoteClientState>(createInitialRemoteClientState());
  const pairingGeneration = useRef(0);
  const unsubscribeClient = useRef<(() => void) | undefined>(undefined);
  const userUnpairing = useRef(false);

  useEffect(() => {
    void mobileRemoteBindingStore.read()
      .then(async (stored) => {
        if (!stored || stored.status !== "active") {
          setPhase("welcome");
          return;
        }
        await startSession(stored);
      })
      .catch((loadError) => {
        setError(userFacingError(loadError));
        setPhase("error");
      });
    return () => {
      pairingGeneration.current += 1;
      unsubscribeClient.current?.();
    };
  }, []);

  const finishRemoteRevocation = async (workspaceBindingId: string | undefined): Promise<void> => {
    pairingGeneration.current += 1;
    let draftCleanupFailed = false;
    if (workspaceBindingId) {
      await removeConversationDrafts(workspaceBindingId).catch(() => {
        draftCleanupFailed = true;
      });
    }
    unsubscribeClient.current?.();
    unsubscribeClient.current = undefined;
    setClient(undefined);
    setBinding(undefined);
    setRemoteState(createInitialRemoteClientState());
    setError(draftCleanupFailed
      ? "PC 已撤销绑定，但本地草稿清理未完成；请重新绑定前重试。"
      : "PC 已撤销这台 iPhone，请重新扫描配对码。");
    setPhase("welcome");
  };

  const startSession = async (nextBinding: RemoteBindingV1): Promise<void> => {
    unsubscribeClient.current?.();
    setBinding(nextBinding);
    const nextClient = new RemoteSessionClient({
      binding: nextBinding,
      bindingStore: mobileRemoteBindingStore,
      cacheStore: mobileRemoteCacheStore,
      http,
      keys: nativeSecureDeviceKeyAdapter,
      entropy: nativeSecureEntropy,
      clock: systemRemoteClock,
      webSocketFactory: (url) => new WebSocket(url) as unknown as RemoteWebSocketLike,
    });
    let observedWorkspaceBindingId = nextBinding.workspaceBindingId;
    unsubscribeClient.current = nextClient.subscribe((nextState) => {
      observedWorkspaceBindingId = nextState.workspaceBindingId ?? observedWorkspaceBindingId;
      setRemoteState(nextState);
      if (nextState.connection === "revoked" && !userUnpairing.current) {
        void finishRemoteRevocation(observedWorkspaceBindingId);
      }
    });
    setClient(nextClient);
    await nextClient.restoreCachedState();
    setPhase("paired");
    void nextClient.connect().catch((connectError) => {
      setError(userFacingError(connectError));
    });
  };

  const value = useMemo<MobileRemoteContextValue>(() => ({
    phase,
    error,
    pendingPairing,
    binding,
    client,
    remoteState,
    openScanner: () => {
      setError(undefined);
      setPhase("scanner");
    },
    cancelPairing: () => {
      pairingGeneration.current += 1;
      setPendingPairing(undefined);
      setError(undefined);
      setPhase("welcome");
    },
    pairFromQr: async (encodedQr) => {
      const generation = ++pairingGeneration.current;
      setError(undefined);
      setPhase("submitting");
      const pairing = new RemotePairingClient({
        http,
        keys: nativeSecureDeviceKeyAdapter,
        entropy: nativeSecureEntropy,
        bindingStore: mobileRemoteBindingStore,
        clock: systemRemoteClock,
      });
      try {
        const started = await pairing.begin(encodedQr, { displayName: "我的 iPhone" });
        if (generation !== pairingGeneration.current) {
          return;
        }
        setPendingPairing(started.pending);
        if (started.binding) {
          setPhase("initial_sync");
          await startSession(started.binding);
          return;
        }
        setPhase("awaiting_pc");
        const accepted = await pollForPairingAcceptance({
          expiresAt: started.pending.qr.expiresAt,
          isActive: () => generation === pairingGeneration.current,
          submit: () => pairing.submit(started.pending),
          onTransientError: (submitError) => console.warn("mobile_remote_pairing_retry", submitError),
        });
        if (!accepted || generation !== pairingGeneration.current) {
          return;
        }
        setPhase("initial_sync");
        await startSession(accepted);
        setPendingPairing(undefined);
      } catch (pairingError) {
        if (generation !== pairingGeneration.current) {
          return;
        }
        console.error("mobile_remote_pairing_failed", pairingError);
        setError(userFacingError(pairingError));
        setPhase("error");
      }
    },
    retryConnection: async () => {
      setError(undefined);
      if (!client) {
        return;
      }
      await client.connect().catch((connectError) => setError(userFacingError(connectError)));
    },
    unpair: async () => {
      pairingGeneration.current += 1;
      userUnpairing.current = true;
      const cleanupErrors: unknown[] = [];
      const workspaceBindingId = binding?.workspaceBindingId ?? remoteState.workspaceBindingId;
      if (workspaceBindingId) {
        await removeConversationDrafts(workspaceBindingId).catch((cleanupError) => cleanupErrors.push(cleanupError));
      }
      try {
        if (client) {
          await client.unpair();
        } else if (binding) {
          if (binding.workspaceBindingId) {
            await mobileRemoteCacheStore.remove(binding.workspaceBindingId);
          }
          await nativeSecureDeviceKeyAdapter.delete(binding.deviceKeyId).catch(() => undefined);
          await mobileRemoteBindingStore.remove();
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      } finally {
        unsubscribeClient.current?.();
        unsubscribeClient.current = undefined;
        setClient(undefined);
        setBinding(undefined);
        setRemoteState(createInitialRemoteClientState());
        setError(cleanupErrors.length > 0 ? "本机绑定已关闭；请在 PC 设置中确认手机也已撤销。" : undefined);
        setPhase("welcome");
        userUnpairing.current = false;
      }
    },
  }), [phase, error, pendingPairing, binding, client, remoteState]);

  return <MobileRemoteContext.Provider value={value}>{children}</MobileRemoteContext.Provider>;
}

export function useMobileRemote(): MobileRemoteContextValue {
  const value = useContext(MobileRemoteContext);
  if (!value) {
    throw new Error("MobileRemoteProvider is required");
  }
  return value;
}

function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/expired/u.test(message)) {
    return "配对码已过期，请在 PC 上重新生成。";
  }
  if (/pin|signature|identity/u.test(message)) {
    return "无法验证这台 PC，请重新扫描最新配对码。";
  }
  if (/camera/u.test(message)) {
    return "无法使用相机扫描配对码。";
  }
  if (/secure_enclave|keychain|secure_device/u.test(message)) {
    return "无法使用此 iPhone 的安全设备密钥。";
  }
  return "暂时无法连接 Ling PC，请稍后重试。";
}
