import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  resolveChannelExecutionCwd,
  type Channel,
  type ResponseLanguage,
  type ResponseLanguagePreference,
  type RunStore,
} from "@ling-stack/core";

export type ResponseLanguageResolutionSource =
  | "message"
  | "project_instructions"
  | "channel"
  | "workspace"
  | "follow_user";

export interface ResponseLanguageResolution {
  readonly language: ResponseLanguage;
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
    return { language: explicitLanguage, source: "message" };
  }

  const projectInstructionLanguage = readProjectInstructionLanguage(input.store, input.channel);
  if (projectInstructionLanguage) {
    return { language: projectInstructionLanguage, source: "project_instructions" };
  }

  const channelPreference = input.channel.responseLanguage;
  if (channelPreference && channelPreference !== "workspace") {
    return resolvePreference(channelPreference, input.sourceText, "channel");
  }

  const workspacePreference = input.store.getWorkspaceSettings().responseLanguage;
  if (workspacePreference) {
    return resolvePreference(workspacePreference, input.sourceText, "workspace");
  }

  return { language: inferUserLanguage(input.sourceText), source: "follow_user" };
}

export function responseLanguageInstruction(language: ResponseLanguage): string {
  return language === "zh-CN"
    ? "用户可读输出请使用中文；代码、日志、命令输出、错误、文件名、API 字段和证据摘录保持原文。"
    : "Use English for user-visible output; keep code, logs, command output, errors, file names, API fields, and evidence excerpts in their original language.";
}

function resolvePreference(
  preference: ResponseLanguagePreference,
  sourceText: string,
  source: Exclude<ResponseLanguageResolutionSource, "message" | "project_instructions" | "follow_user">,
): ResponseLanguageResolution {
  if (preference === "follow_user") {
    return { language: inferUserLanguage(sourceText), source };
  }
  return { language: preference, source };
}

function inferUserLanguage(text: string): ResponseLanguage {
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
