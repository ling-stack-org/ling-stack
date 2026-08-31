import { createHash } from "node:crypto";
import type { ApprovalCommandRuleProposal, ApprovalRequest, ApprovalRisk } from "@ling-stack/core";
import { parse } from "shell-quote";

const RULE_VERSION = 1 as const;
const FORBIDDEN_LEADING_COMMANDS = new Set([
  "bash",
  "chown",
  "chmod",
  "curl",
  "env",
  "eval",
  "exec",
  "fish",
  "node",
  "osascript",
  "perl",
  "php",
  "python",
  "python3",
  "rm",
  "ruby",
  "script",
  "sh",
  "sudo",
  "wget",
  "xargs",
  "zsh",
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

export function createApprovalCommandRuleProposal(input: {
  readonly command: string;
  readonly requestedPrefix: readonly string[] | undefined;
  readonly risk: ApprovalRisk;
  readonly riskFlags: readonly string[];
}): ApprovalCommandRuleProposal | undefined {
  if (input.risk === "high" || input.risk === "critical" || input.riskFlags.length > 0) {
    return undefined;
  }
  const argv = commandArgvForRuleMatching(input.command);
  const prefix = normalizeRequestedPrefix(input.requestedPrefix);
  if (!argv || !prefix || prefix.length > argv.length) return undefined;
  if (!prefix.every((token, index) => token === argv[index])) return undefined;
  if (!isSafePrefix(prefix)) return undefined;

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ version: RULE_VERSION, prefix }))
    .digest("hex");
  return {
    prefix,
    display: prefix.join(" "),
    fingerprint,
    version: RULE_VERSION,
  };
}

export function commandArgvForRuleMatching(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[\r\n$`]/.test(trimmed)) return undefined;
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.length === 0 || parsed.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  const argv = parsed as string[];
  if (argv.some((token) => !token.trim()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? "")) {
    return undefined;
  }
  return argv;
}

export function isApprovalCommandRuleProposalCurrent(approval: ApprovalRequest): boolean {
  if (approval.payload.type !== "bash" || !approval.proposedCommandRule) return false;
  const proposal = createApprovalCommandRuleProposal({
    command: approval.payload.command,
    requestedPrefix: approval.proposedCommandRule.prefix,
    risk: approval.risk,
    riskFlags: approval.payload.riskFlags,
  });
  return proposal?.fingerprint === approval.proposedCommandRule.fingerprint;
}

function normalizeRequestedPrefix(prefix: readonly string[] | undefined): string[] | undefined {
  if (!prefix || prefix.length === 0 || prefix.length > 8) return undefined;
  const normalized = prefix.map((token) => token.trim());
  if (normalized.some((token) => !token || /[\r\n\0]/.test(token))) return undefined;
  return normalized;
}

function isSafePrefix(prefix: readonly string[]): boolean {
  const executable = prefix[0]?.toLowerCase();
  if (!executable || FORBIDDEN_LEADING_COMMANDS.has(executable)) return false;
  if (executable === "git") {
    return prefix.length >= 2 && SAFE_GIT_SUBCOMMANDS.has(prefix[1]?.toLowerCase() ?? "");
  }
  return true;
}
