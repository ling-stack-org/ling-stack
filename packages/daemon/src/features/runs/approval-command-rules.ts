import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  ApprovalCommandRule,
  ApprovalCommandRuleProposal,
  ApprovalRequest,
  ApprovalRisk,
} from "@ling-stack/core";
import { parse } from "shell-quote";

const RULE_VERSION = 1 as const;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_COMMAND_SEGMENTS = 16;
const MAX_COMMAND_ARGV = 256;
const SUPPORTED_CHAIN_OPERATORS = new Set(["&&", ";"]);
const CONTEXT_ONLY_COMMANDS = new Set(["cd", "echo", "false", "pwd", "true"]);
const SAFE_SCOPED_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  ["bun", new Set(["build", "lint", "test"])],
  ["cargo", new Set(["build", "check", "fmt", "test"])],
  ["node", new Set(["--test"])],
  ["npm", new Set(["test"])],
  ["pnpm", new Set(["build", "lint", "test"])],
  ["yarn", new Set(["build", "lint", "test"])],
]);
const FORBIDDEN_LEADING_COMMANDS = new Set([
  "bash",
  "builtin",
  "chown",
  "chmod",
  "command",
  "curl",
  "env",
  "eval",
  "exec",
  "fish",
  "npx",
  "nohup",
  "osascript",
  "perl",
  "php",
  "python",
  "python3",
  "rm",
  "ruby",
  "script",
  "sh",
  "source",
  "sudo",
  "time",
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
  readonly cwd?: string;
}): ApprovalCommandRuleProposal | undefined {
  if (input.cwd !== undefined && (!isAbsolute(input.cwd) || /[\r\n\0]/u.test(input.cwd))) return undefined;
  if (input.risk === "high" || input.risk === "critical" || input.riskFlags.length > 0) {
    return undefined;
  }
  const commandSegments = commandSegmentsForRuleMatching(input.command);
  if (!commandSegments) return undefined;
  const ruleSegments = commandSegmentsRequiringRules(commandSegments);
  const requestedPrefix = normalizeRequestedPrefix(input.requestedPrefix);
  const prefix = requestedPrefix && prefixCoversAllSegments(requestedPrefix, ruleSegments)
    ? requestedPrefix
    : deriveHostCommandRulePrefix(ruleSegments);
  if (!prefix) return undefined;
  if (!isSafePrefix(prefix)) return undefined;

  const cwd = input.cwd === undefined ? undefined : resolve(input.cwd);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ version: RULE_VERSION, prefix, ...(cwd === undefined ? {} : { cwd }) }))
    .digest("hex");
  return {
    prefix,
    display: prefix.join(" "),
    fingerprint,
    version: RULE_VERSION,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

export function commandArgvForRuleMatching(command: string): string[] | undefined {
  const segments = commandSegmentsForRuleMatching(command);
  return segments?.length === 1 ? segments[0] : undefined;
}

/** Parse only the literal shell subset needed to validate workspace command rules. */
export function commandSegmentsForRuleMatching(command: string): readonly string[][] | undefined {
  return parseLiteralCommandSegments(command, true);
}

export function findMatchingApprovalCommandRulesForCommand(
  lookup: {
    readonly findMatchingApprovalCommandRule: (
      toolName: "bash",
      argv: readonly string[],
      cwd?: string,
    ) => ApprovalCommandRule | undefined;
  },
  command: string,
  cwd?: string,
): readonly ApprovalCommandRule[] | undefined {
  const segments = commandSegmentsForRuleMatching(command);
  if (!segments) return undefined;
  const matches = new Map<string, ApprovalCommandRule>();
  for (const argv of commandSegmentsRequiringRules(segments)) {
    const rule = lookup.findMatchingApprovalCommandRule("bash", argv, cwd);
    if (!rule || !isSafePrefix(rule.prefix) || (cwd !== undefined && rule.cwd !== resolve(cwd))) return undefined;
    matches.set(rule.id, rule);
  }
  return matches.size > 0 ? [...matches.values()] : undefined;
}

export function isApprovalCommandRuleProposalCurrent(approval: ApprovalRequest): boolean {
  if (approval.payload.type !== "bash" || !approval.proposedCommandRule) return false;
  const proposal = createApprovalCommandRuleProposal({
    command: approval.payload.command,
    requestedPrefix: approval.proposedCommandRule.prefix,
    risk: approval.risk,
    riskFlags: approval.payload.riskFlags,
    ...(approval.proposedCommandRule.cwd === undefined ? {} : { cwd: approval.payload.cwd }),
  });
  return proposal?.fingerprint === approval.proposedCommandRule.fingerprint
    && (approval.proposedCommandRule.cwd === undefined || approval.proposedCommandRule.cwd === proposal?.cwd);
}

function normalizeRequestedPrefix(prefix: readonly string[] | undefined): string[] | undefined {
  if (!prefix || prefix.length === 0 || prefix.length > 8) return undefined;
  const normalized = prefix.map((token) => token.trim());
  if (normalized.some((token) => !token || /[\r\n\0]/.test(token))) return undefined;
  return normalized;
}

function isSafePrefix(prefix: readonly string[]): boolean {
  const executable = prefix[0]?.toLowerCase();
  if (!executable) return false;
  if (executable === ".") return false;
  const scopedSubcommands = SAFE_SCOPED_SUBCOMMANDS.get(executable);
  if (scopedSubcommands) {
    return prefix.length >= 2 && scopedSubcommands.has(prefix[1]?.toLowerCase() ?? "");
  }
  if (FORBIDDEN_LEADING_COMMANDS.has(executable)) return false;
  if (executable === "git") {
    return prefix.length >= 2 && SAFE_GIT_SUBCOMMANDS.has(prefix[1]?.toLowerCase() ?? "");
  }
  return true;
}

function parseLiteralCommandSegments(
  command: string,
  allowShellWrapper: boolean,
): readonly string[][] | undefined {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH || /[\r\n\0`]/u.test(trimmed)) return undefined;
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(trimmed, () => {
      throw new Error("approval_command_rule_expansion_unsupported");
    });
  } catch {
    return undefined;
  }

  const segments: string[][] = [];
  let argv: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") {
      if (!entry.trim() || argv.length >= MAX_COMMAND_ARGV) return undefined;
      argv.push(entry);
      continue;
    }
    const operator = readOperator(entry);
    if (!operator || !SUPPORTED_CHAIN_OPERATORS.has(operator) || argv.length === 0) return undefined;
    if (!isLiteralArgv(argv)) return undefined;
    segments.push(argv);
    if (segments.length >= MAX_COMMAND_SEGMENTS) return undefined;
    argv = [];
  }
  if (argv.length === 0 || !isLiteralArgv(argv)) return undefined;
  segments.push(argv);

  if (allowShellWrapper && segments.length === 1) {
    const wrappedScript = readShellWrapperScript(segments[0]);
    if (wrappedScript !== undefined) {
      return parseLiteralCommandSegments(wrappedScript, false);
    }
  }
  return segments;
}

function readOperator(entry: Exclude<ReturnType<typeof parse>[number], string>): string | undefined {
  if (!entry || typeof entry !== "object" || !("op" in entry)) return undefined;
  return typeof entry.op === "string" ? entry.op : undefined;
}

function isLiteralArgv(argv: readonly string[]): boolean {
  const executable = argv[0];
  return Boolean(
    executable
    && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(executable)
    && argv.every((token) => token.length > 0 && !/[\r\n\0]/u.test(token)),
  );
}

function readShellWrapperScript(argv: readonly string[]): string | undefined {
  if (argv.length !== 3) return undefined;
  const executable = argv[0]?.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (!executable || !new Set(["bash", "sh", "zsh"]).has(executable)) return undefined;
  return argv[1] === "-c" || argv[1] === "-lc" ? argv[2] : undefined;
}

function commandSegmentsRequiringRules(segments: readonly string[][]): readonly string[][] {
  const material = segments.filter((argv) => !CONTEXT_ONLY_COMMANDS.has(argv[0]?.toLowerCase() ?? ""));
  return material.length > 0 ? material : segments;
}

function prefixCoversAllSegments(prefix: readonly string[], segments: readonly string[][]): boolean {
  return isSafePrefix(prefix) && segments.every((argv) => prefixMatchesArgv(prefix, argv));
}

function prefixMatchesArgv(prefix: readonly string[], argv: readonly string[]): boolean {
  return prefix.length <= argv.length && prefix.every((token, index) => token === argv[index]);
}

function deriveHostCommandRulePrefix(segments: readonly string[][]): string[] | undefined {
  if (segments.length !== 1) return undefined;
  const argv = segments[0];
  const executable = argv[0]?.toLowerCase();
  if (!executable) return undefined;
  const scopedSubcommands = SAFE_SCOPED_SUBCOMMANDS.get(executable);
  if (scopedSubcommands) {
    const subcommand = argv[1]?.toLowerCase();
    return subcommand && scopedSubcommands.has(subcommand) ? argv.slice(0, 2) : undefined;
  }
  if (executable === "git") {
    const subcommand = argv[1]?.toLowerCase();
    return subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand) ? argv.slice(0, 2) : undefined;
  }
  const candidate = [argv[0]!];
  return isSafePrefix(candidate) ? candidate : undefined;
}
