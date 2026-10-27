import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseMarketplaceIndex, type MarketplaceIndex } from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { writeJson } from "../../shared/response.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;

/**
 * Fetch and validate a marketplace index. The index is untrusted: it is
 * parsed with the versioned contract, bounded in size, and only ever points
 * at packs that the review-queue import flow will re-verify by integrity.
 */
export async function handleSkillsMarketplaceInspect(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Use GET for marketplace inspect" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const indexUrl = url.searchParams.get("url");
  if (!indexUrl) {
    writeJson(response, 400, { error: "bad_request", message: "url query parameter is required" });
    return;
  }
  let parsedIndexUrl: URL;
  try {
    parsedIndexUrl = new URL(indexUrl);
  } catch {
    writeJson(response, 400, { error: "bad_request", message: "url must be an absolute URL" });
    return;
  }
  if (parsedIndexUrl.protocol !== "https:") {
    writeJson(response, 400, { error: "bad_request", message: "Marketplace indexes must be served over https." });
    return;
  }

  // Prefer the daemon-managed web fetch (egress audited); fall back to the
  // global fetch when the runtime constructs none — the route itself enforces
  // https, a timeout and a size cap regardless of which fetch runs.
  const fetchImpl = context.webFetch ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init));

  try {
    const fetched = await fetchImpl(parsedIndexUrl.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await fetched.text();
    if (text.length > MAX_INDEX_BYTES) {
      writeJson(response, 413, { error: "index_too_large", message: "Marketplace index exceeds the size cap." });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      writeJson(response, 502, { error: "index_not_json", message: "Marketplace index is not valid JSON." });
      return;
    }
    const parsed = parseMarketplaceIndex(raw);
    if (!parsed.ok || !parsed.index) {
      writeJson(response, 422, { error: "index_invalid", message: parsed.reason ?? "Marketplace index is invalid." });
      return;
    }
    const index: MarketplaceIndex = parsed.index;
    writeJson(response, 200, {
      schemaVersion: 1,
      source: parsedIndexUrl.toString(),
      index,
      skills: index.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        latestVersion: skill.versions[skill.versions.length - 1]?.version,
        integrityAlgorithm: "sha256",
      })),
    });
  } catch (error) {
    writeJson(response, 502, {
      error: "index_fetch_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Shared with the import flow: verifies pack bytes against sha256-<hex> integrity. */
export function verifyMarketplacePackIntegrity(data: Uint8Array, integrity: string): boolean {
  const match = /^sha256-([0-9a-f]{64})$/u.exec(integrity);
  if (!match) return false;
  const digest = createHash("sha256").update(data).digest("hex");
  return digest === match[1];
}
