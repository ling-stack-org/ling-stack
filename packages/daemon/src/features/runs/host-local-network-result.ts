import type { HostLocalNetworkInfoResultV1 } from "@ling-stack/contracts";
import type { PiRunnerToolHandledResult } from "@ling-stack/runner-pi";

const MAX_TEXT_BYTES = 8 * 1024;
const MAX_TEXT_LINES = 40;

/** Readable model/UI text and exact bounded Host-only details; never command facts. */
export function hostLocalNetworkToolResult(result: HostLocalNetworkInfoResultV1): PiRunnerToolHandledResult {
  return { isError: result.status === "failed", content: [{ type: "text", text: render(result) }],
    details: { hostCapabilityResult: result } };
}

function render(result: HostLocalNetworkInfoResultV1): string {
  if (result.status === "failed") return `${result.code}: ${result.message}`;
  const lines = ["Local interface addresses (not a public egress IP query).", `Collected at: ${result.collectedAt}`];
  let displayed = 0;
  for (const address of result.addresses) {
    const line = `${quotedData(address.interfaceName)}: ${address.family} ${quotedData(address.address)}${address.internal ? " (internal)" : ""}`;
    // Reserve two footer lines and their bytes so neither collection nor display
    // truncation can disappear at the downstream evidence text boundary.
    if (lines.length + 3 > MAX_TEXT_LINES || Buffer.byteLength([...lines, line].join("\n"), "utf8") > MAX_TEXT_BYTES - 256) break;
    lines.push(line);
    displayed += 1;
  }
  if (result.addresses.length === 0 && !result.truncated) lines.push("No interface addresses matched the requested filters.");
  if (displayed < result.addresses.length) lines.push(`Showing ${displayed}/${result.addresses.length} recorded addresses; display truncated.`);
  if (result.truncated) lines.push("Collection truncated by Host output limits.");
  return lines.join("\n");
}

/** Preserve names as literal text; no links, HTML, terminal or bidi controls. */
function quotedData(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}
