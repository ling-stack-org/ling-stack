import { fetch as nativeFetch } from "undici";
import { preparePinnedPublicHttpRequest } from "../../shared/public-http-transport.js";

const githubAssetHosts = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const officialReleaseRepositories = new Set([
  "ling-stack",
  "ling-plugin-office-documents",
  "ling-plugin-chrome-browser",
  "ling-plugin-cua-driver",
]);

export function isOfficialPluginReleaseUrl(value: string): boolean {
  const url = new URL(value);
  return url.origin === "https://github.com"
    && !url.username && !url.password
    && /^\/ling-stack-org\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/u.test(url.pathname)
    && officialReleaseRepositories.has(url.pathname.split("/")[2]!);
}

export async function downloadPluginBytes(input: {
  readonly url: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly label: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  let url = parseDownloadUrl(input.url);
  const mayRedirect = isOfficialPluginReleaseUrl(input.url);
  const deadline = Date.now() + input.timeoutMs;
  const signal = AbortSignal.timeout(input.timeoutMs);
  for (let hop = 0; hop < 3; hop++) {
    const init: RequestInit = { redirect: "manual", signal };
    const connection = !input.fetchImpl
      ? await preparePinnedPublicHttpRequest(url, init, { timeoutMs: Math.max(1, deadline - Date.now()) })
      : undefined;
    try {
      const response = connection
        ? await connection.fetch(nativeFetch as unknown as typeof fetch)
        : await input.fetchImpl!(url.href, init);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!mayRedirect || !location) throw new Error(`${input.label} returned an unexpected redirect.`);
        const target = parseDownloadUrl(new URL(location, url).href);
        if (!githubAssetHosts.has(target.hostname)) {
          throw new Error(`${input.label} redirected outside GitHub's release asset service.`);
        }
        url = target;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${input.label} request failed with HTTP ${response.status}.`);
      }
      return await readBytes(response, input.maxBytes, input.label);
    } finally {
      await connection?.dispose();
    }
  }
  throw new Error(`${input.label} exceeded its download redirect limit.`);
}

function parseDownloadUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) {
    throw new Error("Plugin downloads require an HTTPS URL without credentials, a fragment, or a custom port.");
  }
  return url;
}

async function readBytes(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds the configured size limit.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return Buffer.concat(chunks, count);
      count += result.value.byteLength;
      if (count > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds the configured size limit.`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}
