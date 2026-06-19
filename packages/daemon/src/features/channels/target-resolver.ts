import type { Channel, ChannelMessage, ChannelStoreFacet } from "@ling-stack/core";

export type ResolvedExecutableFileTarget =
  | {
      readonly status: "resolved";
      readonly target: string;
      readonly source: "explicit_path" | "explicit_name" | "recent_work" | "recent_message";
    }
  | {
      readonly status: "missing";
      readonly reason: string;
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly string[];
      readonly reason: string;
    };

export interface ResolveExecutableFileTargetInput {
  readonly store: ChannelStoreFacet;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly target?: string;
  readonly allowRecentMessageTarget?: boolean;
}

export function extractFileTargetCandidate(text: string): string | undefined {
  const absolutePath = extractAbsoluteOrRelativePath(text);
  if (absolutePath && hasFileExtension(absolutePath)) {
    return stripTrailingPunctuation(absolutePath);
  }
  const fileName = extractFileName(text);
  if (absolutePath && fileName) {
    return `${stripTrailingSlash(stripTrailingPunctuation(absolutePath))}/${fileName}`;
  }
  return fileName;
}

export function resolveExecutableFileTarget(input: ResolveExecutableFileTargetInput): ResolvedExecutableFileTarget {
  if (!input.target) {
    return input.allowRecentMessageTarget
      ? resolveRecentChannelMessageFileTarget(input)
      : {
          status: "missing",
          reason: "No explicit file target was supplied.",
        };
  }

  const normalizedTarget = normalizeExecutablePathCandidate(stripTrailingPunctuation(input.target));
  if (isPathLikeFileTarget(normalizedTarget)) {
    return {
      status: "resolved",
      target: normalizedTarget,
      source: "explicit_path",
    };
  }

  const recentMatches = resolveRecentChannelFileTargets(input, normalizedTarget);
  if (recentMatches.length === 1) {
    return {
      status: "resolved",
      target: recentMatches[0],
      source: "recent_work",
    };
  }
  if (recentMatches.length > 1) {
    return {
      status: "ambiguous",
      candidates: recentMatches,
      reason: `Multiple recent file targets match ${normalizedTarget}.`,
    };
  }

  return {
    status: "resolved",
    target: normalizedTarget,
    source: "explicit_name",
  };
}

function resolveRecentChannelFileTargets(input: ResolveExecutableFileTargetInput, fileName: string): readonly string[] {
  const wanted = fileBasename(fileName).toLowerCase();
  if (!wanted) {
    return [];
  }
  return recentChannelFileTargetCandidates(input).filter((candidate) => fileBasename(candidate).toLowerCase() === wanted);
}

function recentChannelFileTargetCandidates(input: ResolveExecutableFileTargetInput): readonly string[] {
  const textSources: string[] = [];
  const sourceCreatedAt = input.sourceMessage.createdAt;
  const workflows = input.store
    .listChannelWorkflows({ channelId: input.channel.id, limit: 20 })
    .filter((workflow) => workflow.createdAt <= sourceCreatedAt);
  for (const workflow of workflows) {
    textSources.push(workflow.title, workflow.objective);
    for (const step of input.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 50 })) {
      textSources.push(step.title, step.prompt);
      if (step.resultSummary) {
        textSources.push(step.resultSummary);
      }
    }
  }
  const proposals = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, limit: 20 })
    .filter((proposal) => proposal.createdAt <= sourceCreatedAt);
  for (const proposal of proposals) {
    textSources.push(proposal.title, proposal.prompt);
    if (proposal.riskSummary) {
      textSources.push(proposal.riskSummary);
    }
    textSources.push(...proposal.acceptanceCriteria);
    textSources.push(...proposal.collaborationSteps.map((step) => step.summary));
  }
  return uniqueStrings(textSources.flatMap(extractFilePathCandidates));
}

function resolveRecentChannelMessageFileTarget(input: ResolveExecutableFileTargetInput): ResolvedExecutableFileTarget {
  const recentMessages = input.store
    .listChannelMessages({ channelId: input.channel.id, limit: 30 })
    .filter((message) => message.id !== input.sourceMessage.id && message.createdAt <= input.sourceMessage.createdAt && message.status !== "failed")
    .slice()
    .reverse();
  for (const message of recentMessages) {
    const candidates = extractFileTargetCandidates(message.body);
    if (candidates.length === 1) {
      return {
        status: "resolved",
        target: candidates[0],
        source: "recent_message",
      };
    }
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        candidates,
        reason: `Recent message ${message.id} contains multiple file targets.`,
      };
    }
  }
  return {
    status: "missing",
    reason: "No recent single file target was found.",
  };
}

function extractFileTargetCandidates(text: string): readonly string[] {
  const pathCandidates = extractFilePathCandidates(text);
  const pathBasenames = new Set(pathCandidates.map((candidate) => fileBasename(candidate).toLowerCase()));
  const nameCandidates = extractFileNameCandidates(text).filter((candidate) => !pathBasenames.has(fileBasename(candidate).toLowerCase()));
  return uniqueStrings([...pathCandidates, ...nameCandidates]);
}

function extractFilePathCandidates(text: string): readonly string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s"'`([{（，。:：])((?:\/(?!\/)|\.{1,2}\/|Users\/)[^\s"'`，。；;：:!?！？)）\]}]*?[\w.-]+\.(?:md|txt|json|jsonl|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|sql|css|scss|html|xml|csv|env|example))/giu;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1];
    if (candidate) {
      paths.push(normalizeExecutablePathCandidate(stripTrailingPunctuation(candidate)));
    }
  }
  return paths;
}

function extractAbsoluteOrRelativePath(text: string): string | undefined {
  const matches = text.match(/(?:^|[\s"'`([{（，。:：])((?:\/(?!\/)|\.{1,2}\/|Users\/)[^\s"'`，。；;：:!?！？)）\]}]+)/u);
  const candidate = matches?.[1];
  if (!candidate || candidate.startsWith("//")) {
    return undefined;
  }
  return normalizeExecutablePathCandidate(stripTrailingPunctuation(candidate));
}

function extractFileName(text: string): string | undefined {
  return extractFileNameCandidates(text)[0];
}

function extractFileNameCandidates(text: string): readonly string[] {
  const names: string[] = [];
  const pattern = /\b([\w.-]+\.(?:md|txt|json|jsonl|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|sql|css|scss|html|xml|csv|env|example))\b/giu;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) {
      names.push(stripTrailingPunctuation(match[1]));
    }
  }
  return uniqueStrings(names);
}

function isPathLikeFileTarget(value: string): boolean {
  return value.includes("/") || value.startsWith(".");
}

function fileBasename(value: string): string {
  return stripTrailingPunctuation(value).split("/").filter(Boolean).at(-1) ?? "";
}

function normalizeExecutablePathCandidate(value: string): string {
  return value.replace(/^Users\//u, "/Users/");
}

function hasFileExtension(value: string): boolean {
  return /\.[a-z0-9][a-z0-9_-]*$/iu.test(stripTrailingPunctuation(value));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[，。；;:：!?！？)）\]}]+$/u, "");
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}
