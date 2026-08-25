import {
  commandMatchExecutableValuesV1,
  type CommandMatchExecutableV1,
  type CommandMatchPolicyV1,
} from "@ling-stack/contracts";

export interface MaterializedCommandIntent {
  readonly targetLabel: string;
  readonly policy: CommandMatchPolicyV1;
}

interface ParsedSimpleCommand {
  readonly canonical: string;
  readonly executable: string;
  readonly hasArguments: boolean;
}

const executableAlternation = [...commandMatchExecutableValuesV1]
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join("|");

const commandExecutionPattern = /(运行|执行|跑一下|跑下|调用|验证|测试|检查|run|execute|invoke|verify|test|check)/iu;
const unquotedCommandPattern = new RegExp(
  `(?<![\\w./-])((?:${executableAlternation})\\s+[^\\n，。；;!?！？]*)`,
  "iu",
);
const executableTokenPattern = new RegExp(
  `(?<![\\w./-])(${executableAlternation})(?![\\w./-])`,
  "iu",
);

export function materializeCommandIntent(text: string): MaterializedCommandIntent | undefined {
  if (!commandExecutionPattern.test(text)) return undefined;

  const inlineCandidates = [...text.matchAll(/`([^`]+)`/gu)]
    .map((match) => match[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of inlineCandidates) {
    const parsed = parseSimpleCommand(candidate);
    if (parsed && isKnownExecutable(parsed.executable)) {
      return {
        targetLabel: parsed.canonical,
        policy: { kind: "exact_command", command: parsed.canonical },
      };
    }
  }

  const unquotedMatch = unquotedCommandPattern.exec(text);
  const unquotedCandidate = trimUnquotedCommandTail(unquotedMatch?.[1]?.trim());
  const parsedUnquoted = unquotedCandidate ? parseSimpleCommand(unquotedCandidate) : undefined;
  if (parsedUnquoted?.hasArguments && isKnownExecutable(parsedUnquoted.executable)) {
    return {
      targetLabel: parsedUnquoted.canonical,
      policy: { kind: "exact_command", command: parsedUnquoted.canonical },
    };
  }

  const executableMatch = executableTokenPattern.exec(text);
  const executable = executableMatch?.[1]?.toLowerCase();
  if (!executableMatch || !executable || !isKnownExecutable(executable)
    || !hasExecutionRelation(text, executableMatch.index, executableMatch.index + executableMatch[1].length)) {
    return undefined;
  }
  return {
    targetLabel: executableMatch?.[1] ?? executable,
    policy: { kind: "executable", executable },
  };
}

export function commandMatchesPolicy(
  actualCommand: string,
  policy: CommandMatchPolicyV1,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const actual = parseSimpleCommand(actualCommand);
  if (!actual) return false;
  if (policy.kind === "exact_command") {
    const expected = parseSimpleCommand(policy.command);
    return Boolean(expected && actual.canonical === expected.canonical);
  }
  const actualExecutable = platform === "win32"
    ? actual.executable.toLowerCase()
    : actual.executable;
  const expectedExecutable = platform === "win32"
    ? policy.executable.toLowerCase()
    : policy.executable;
  return actualExecutable === expectedExecutable;
}

function parseSimpleCommand(command: string): ParsedSimpleCommand | undefined {
  const canonical = command.trim();
  if (!canonical || canonical.length > 512 || /[\r\n]/u.test(canonical)) return undefined;

  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = 0; index < canonical.length; index += 1) {
    const character = canonical[index];
    const next = canonical[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        quote = undefined;
      } else if (character === "`" || (character === "$" && next === "(")) {
        return undefined;
      }
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === "\"") {
      quote = "double";
      continue;
    }
    if (character === "`" || (character === "$" && next === "(") || /[;&|<>]/u.test(character)) {
      return undefined;
    }
  }
  if (quote || escaped) return undefined;

  const executable = /^([^\s]+)/u.exec(canonical)?.[1];
  if (!executable || !/^[A-Za-z0-9_-]+$/u.test(executable)) return undefined;
  return {
    canonical,
    executable,
    hasArguments: canonical.slice(executable.length).trim().length > 0,
  };
}

function trimUnquotedCommandTail(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const cjkBoundary = /\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.exec(candidate);
  const englishBoundary = /\s+(?:and\s+then|then|and\s+(?:report|verify|check)|to\s+(?:verify|check))\b/iu.exec(candidate);
  const boundary = [cjkBoundary?.index, englishBoundary?.index]
    .filter((index): index is number => index !== undefined)
    .sort((left, right) => left - right)[0];
  return (boundary === undefined ? candidate : candidate.slice(0, boundary)).trim() || undefined;
}

function hasExecutionRelation(text: string, start: number, end: number): boolean {
  const prefix = text.slice(Math.max(0, start - 40), start);
  const suffix = text.slice(end, Math.min(text.length, end + 40));
  const boundedGap = "[^，。；;!?！？\\r\\n]{0,20}";
  const beforePattern = new RegExp(`(?:运行|执行|跑一下|跑下|调用|验证|测试|检查|run|execute|invoke|verify|test|check)${boundedGap}$`, "iu");
  const afterPattern = new RegExp(`^${boundedGap}(?:运行|执行|跑一下|跑下|调用|验证|测试|检查|run|execute|invoke|verify|test|check)`, "iu");
  return beforePattern.test(prefix) || afterPattern.test(suffix);
}

function isKnownExecutable(value: string): value is CommandMatchExecutableV1 {
  return commandMatchExecutableValuesV1.includes(value.toLowerCase() as CommandMatchExecutableV1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
