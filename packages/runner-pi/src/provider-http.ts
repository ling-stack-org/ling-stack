import { Agent } from "undici";

/**
 * Compatible relays can take longer than Undici's default connection budget
 * to complete DNS/TCP/TLS setup, especially when the upstream model is cold.
 * Keep this separate from the response/idle timeout so a slow connection does
 * not make a healthy provider look unavailable.
 */
export const PROVIDER_CONNECT_TIMEOUT_MS = 30_000;

type ProviderFetchInit = RequestInit & { readonly dispatcher?: unknown };

let providerHttpAgent: Agent | undefined;

function getProviderHttpAgent(): Agent {
  providerHttpAgent ??= new Agent({
    connect: { timeout: PROVIDER_CONNECT_TIMEOUT_MS },
  });
  return providerHttpAgent;
}

/**
 * Fetch a provider endpoint with an explicit Undici connection timeout.
 * Callers may still provide their own dispatcher; this helper only supplies
 * the Ling default when one is not already present.
 */
export function fetchProvider(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): ReturnType<typeof globalThis.fetch> {
  const requestInit = (init ?? {}) as ProviderFetchInit;
  return globalThis.fetch(input, {
    ...requestInit,
    dispatcher: requestInit.dispatcher ?? getProviderHttpAgent(),
  } as RequestInit & { readonly dispatcher: Agent });
}

