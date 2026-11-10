import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  resolveChannelExecutionCwd,
  type Channel,
  type ResponseLanguage,
  type ResponseLanguagePreference,
  type RunStore,
} from "@ling-stack/core";
import {
  responseLanguageInstruction as explicitResponseLanguageInstruction,
} from "@ling-stack/localization";
import { resolveEffectiveChannelCollaborationProtocol, type ChannelProtocolFieldSource } from "./collaboration-protocol.js";

export type ResponseLanguageResolutionSource =
  | "message"
  | "project_instructions"
  | "channel"
  | "workspace"
  | "follow_user";

export interface ResponseLanguageResolution {
  readonly language: ResponseLanguage;
  readonly instructionLanguage: ResponseLanguagePreference;
  readonly source: ResponseLanguageResolutionSource;
}

export interface ResolveChannelResponseLanguageInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceText: string;
  readonly explicitLanguage?: ResponseLanguage;
}

export function resolveChannelResponseLanguage(input: ResolveChannelResponseLanguageInput): ResponseLanguageResolution {
  const explicitLanguage = input.explicitLanguage ?? detectExplicitResponseLanguage(input.sourceText);
  if (explicitLanguage) {
    return { language: explicitLanguage, instructionLanguage: explicitLanguage, source: "message" };
  }

  const projectInstructionLanguage = readProjectInstructionLanguage(input.store, input.channel);
  if (projectInstructionLanguage) {
    return {
      language: projectInstructionLanguage,
      instructionLanguage: projectInstructionLanguage,
      source: "project_instructions",
    };
  }

  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  return resolveProtocolPreference(
    protocol.protocol.responseLanguage,
    input.sourceText,
    protocol.sources.responseLanguage.source,
  );
}

export function responseLanguageInstruction(language: ResponseLanguagePreference): string {
  return language === "follow_user"
    ? "Match the language of the most recent user message for user-visible output; do not force non-Chinese text to English. Keep code, logs, command output, errors, file names, API fields, and evidence excerpts in their original language."
    : explicitResponseLanguageInstruction(language);
}

export function fallbackResponseLanguage(language: ResponseLanguagePreference | undefined): ResponseLanguage {
  return !language || language === "follow_user" ? "en-US" : language;
}

function resolveProtocolPreference(
  preference: ResponseLanguagePreference | "workspace",
  sourceText: string,
  source: ChannelProtocolFieldSource,
): ResponseLanguageResolution {
  if (preference === "workspace" || preference === "follow_user") {
    return {
      language: inferUserLanguage(sourceText),
      instructionLanguage: "follow_user",
      source: source === "channel_setting"
        ? "channel"
        : source === "workspace_setting"
          ? "workspace"
          : "follow_user",
    };
  }
  return {
    language: preference,
    instructionLanguage: preference,
    source: source === "workspace_setting" ? "workspace" : "channel",
  };
}

export function inferUserLanguage(text: string): ResponseLanguage {
  return /[\u3400-\u9fff]/u.test(text) ? "zh-CN" : "en-US";
}

function detectExplicitResponseLanguage(text: string): ResponseLanguage | undefined {
  if (/(?:请|用|使用|回复|回答|输出).{0,12}(?:中文|汉语|简体中文)/iu.test(text)) {
    return "zh-CN";
  }
  if (/\b(?:respond|reply|answer|write|use|output)\b.{0,24}\b(?:Chinese|Mandarin|Simplified Chinese)\b/iu.test(text)) {
    return "zh-CN";
  }
  if (/(?:请|用|使用|回复|回答|输出).{0,12}(?:英文|英语)/iu.test(text)) {
    return "en-US";
  }
  if (/\b(?:respond|reply|answer|write|use|output)\b.{0,24}\bEnglish\b/iu.test(text)) {
    return "en-US";
  }
  return undefined;
}

function readProjectInstructionLanguage(store: RunStore, channel: Channel): ResponseLanguage | undefined {
  const candidateDirs = [
    resolveChannelExecutionCwd(channel, store.paths.cwd),
    store.paths.cwd,
  ].map((cwd) => resolve(cwd));
  for (const cwd of [...new Set(candidateDirs)]) {
    const agentsPath = join(cwd, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      continue;
    }
    try {
      const content = readFileSync(agentsPath, "utf8");
      const language = detectProjectInstructionLanguage(content);
      if (language) {
        return language;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function detectProjectInstructionLanguage(content: string): ResponseLanguage | undefined {
  if (/All responses must be in Chinese/iu.test(content) || /所有(?:回复|回答|输出).{0,12}(?:中文|汉语)/iu.test(content)) {
    return "zh-CN";
  }
  if (/All responses must be in English/iu.test(content) || /所有(?:回复|回答|输出).{0,12}(?:英文|英语)/iu.test(content)) {
    return "en-US";
  }
  return undefined;
}
