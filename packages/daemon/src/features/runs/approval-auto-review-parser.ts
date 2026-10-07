export type ApprovalAutoReviewVerdict = {
  readonly schemaVersion: 1;
  readonly decision: "approve" | "deny" | "manual";
  readonly reason: string;
};

export type ApprovalAutoReviewParseResult =
  | { readonly ok: true; readonly verdict: ApprovalAutoReviewVerdict }
  | { readonly ok: false; readonly code: "invalid_shape" | "invalid_json" | "invalid_value" };

const MAX_RESPONSE_CHARS = 4_000;
const MAX_REASON_CHARS = 1_000;
const allowedKeys = new Set(["schemaVersion", "decision", "reason"]);

/** Strict JSON only: prose, Markdown fences, partial objects, and unknown keys fail closed. */
export function parseApprovalAutoReviewVerdict(text: string): ApprovalAutoReviewParseResult {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_RESPONSE_CHARS || trimmed.startsWith("```")) {
    return { ok: false, code: "invalid_shape" };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (!isRecord(value)) return { ok: false, code: "invalid_shape" };
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
    return { ok: false, code: "invalid_shape" };
  }
  if (
    value.schemaVersion !== 1
    || !["approve", "deny", "manual"].includes(String(value.decision))
    || typeof value.reason !== "string"
  ) {
    return { ok: false, code: "invalid_value" };
  }
  const reason = value.reason.trim();
  if (!reason || reason.length > MAX_REASON_CHARS || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(reason)) {
    return { ok: false, code: "invalid_value" };
  }
  return {
    ok: true,
    verdict: {
      schemaVersion: 1,
      decision: value.decision as ApprovalAutoReviewVerdict["decision"],
      reason,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
