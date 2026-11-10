import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type {
  RemoteBindingStore,
  RemoteBindingV1,
  RemoteCacheEnvelopeV1,
  RemoteCacheStore,
  RemoteClientState,
} from "@ling-stack/remote-client";
import {
  draftNamespacePrefix,
  removeConversationDraftsFromStorage,
} from "./conversation-draft-cleanup";

const BINDING_KEY = "ling.remote.binding.v1";
const CACHE_PREFIX = "ling.remote.cache.v1.";
const THEME_KEY = "ling.mobile.theme.v1";

export const mobileRemoteBindingStore: RemoteBindingStore = {
  async read(): Promise<RemoteBindingV1 | undefined> {
    const value = await SecureStore.getItemAsync(BINDING_KEY);
    if (!value) {
      return undefined;
    }
    const parsed = JSON.parse(value) as RemoteBindingV1;
    return parsed.version === 1 ? parsed : undefined;
  },
  async write(binding): Promise<void> {
    await SecureStore.setItemAsync(BINDING_KEY, JSON.stringify(binding), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async remove(): Promise<void> {
    await SecureStore.deleteItemAsync(BINDING_KEY);
  },
};

export const mobileRemoteCacheStore: RemoteCacheStore<RemoteClientState> = {
  async read(workspaceBindingId): Promise<RemoteCacheEnvelopeV1<RemoteClientState> | undefined> {
    const value = await AsyncStorage.getItem(cacheKey(workspaceBindingId));
    if (!value) {
      return undefined;
    }
    const parsed = JSON.parse(value) as RemoteCacheEnvelopeV1<RemoteClientState>;
    return parsed.version === 1 && parsed.workspaceBindingId === workspaceBindingId ? parsed : undefined;
  },
  async write(workspaceBindingId, cache): Promise<void> {
    await AsyncStorage.setItem(cacheKey(workspaceBindingId), JSON.stringify(cache));
  },
  async remove(workspaceBindingId): Promise<void> {
    await AsyncStorage.removeItem(cacheKey(workspaceBindingId));
  },
};

export async function readMobileThemePreference(): Promise<"system" | "light" | "dark"> {
  const value = await AsyncStorage.getItem(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export async function writeMobileThemePreference(value: "system" | "light" | "dark"): Promise<void> {
  await AsyncStorage.setItem(THEME_KEY, value);
}

export async function readConversationDraft(workspaceBindingId: string, conversationId: string): Promise<string> {
  return await AsyncStorage.getItem(draftKey(workspaceBindingId, conversationId)) ?? "";
}

export async function writeConversationDraft(workspaceBindingId: string, conversationId: string, value: string): Promise<void> {
  const key = draftKey(workspaceBindingId, conversationId);
  if (value) {
    await AsyncStorage.setItem(key, value);
  } else {
    await AsyncStorage.removeItem(key);
  }
}

export async function removeConversationDrafts(workspaceBindingId: string): Promise<void> {
  await removeConversationDraftsFromStorage(AsyncStorage, workspaceBindingId);
}

function cacheKey(workspaceBindingId: string): string {
  return `${CACHE_PREFIX}${encodeURIComponent(workspaceBindingId)}`;
}

function draftKey(workspaceBindingId: string, conversationId: string): string {
  return `${draftNamespacePrefix(workspaceBindingId)}${encodeURIComponent(conversationId)}`;
}
