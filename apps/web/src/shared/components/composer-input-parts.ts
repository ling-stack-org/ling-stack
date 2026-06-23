import { parseLocalFileReference } from "../conversation/message-body.js";

export type ComposerInputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "attachment"; readonly attachmentId: string }
  | { readonly type: "workspace_file"; readonly path: string; readonly raw: string; readonly line?: number }
  | { readonly type: "teammate_mention"; readonly teammateId: string; readonly label: string; readonly raw: string }
  | { readonly type: "skill_mention"; readonly skillId: string; readonly label: string; readonly raw: string }
  | { readonly type: "slash_command"; readonly commandId: string; readonly label: string; readonly raw: string };

export interface ComposerInputMentionOption {
  readonly id: string;
  readonly label: string;
}

export interface ComposerInputSkillOption {
  readonly id: string;
  readonly label: string;
}

export interface ComposerInputSlashCommandOption {
  readonly id: string;
  readonly label: string;
}

export interface ComposerInputAttachmentOption {
  readonly attachmentId: string;
}

export interface ParseComposerInputPartsOptions {
  readonly cwd?: string;
  readonly attachments?: readonly ComposerInputAttachmentOption[];
  readonly teammateMentions?: readonly ComposerInputMentionOption[];
  readonly skills?: readonly ComposerInputSkillOption[];
  readonly slashCommands?: readonly ComposerInputSlashCommandOption[];
}

interface KnownMentionRead {
  readonly type: "teammate_mention" | "skill_mention";
  readonly id: string;
  readonly label: string;
  readonly raw: string;
}

const pathPattern = /^(?:~\/|\.{1,2}\/|\/|(?:[A-Za-z0-9_.-]+\/))[^\s<>"'`]+/;
const slashCommandTokenPattern = /^\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

export function parseComposerInputParts(text: string, options: ParseComposerInputPartsOptions = {}): readonly ComposerInputPart[] {
  const parts: ComposerInputPart[] = [
    ...(options.attachments ?? []).map((attachment): ComposerInputPart => ({
      type: "attachment",
      attachmentId: attachment.attachmentId,
    })),
  ];

  let index = 0;
  let textBuffer = "";

  function flushText(): void {
    if (textBuffer.length > 0) {
      parts.push({ type: "text", text: textBuffer });
      textBuffer = "";
    }
  }

  while (index < text.length) {
    const remaining = text.slice(index);
    const mention = readKnownMentionAtStart(remaining, options);
    if (mention) {
      if (mention.type === "teammate_mention") {
        flushText();
        parts.push({ type: "teammate_mention", teammateId: mention.id, label: mention.label, raw: mention.raw });
        index += mention.raw.length;
        continue;
      }
      if (mention.type === "skill_mention") {
        flushText();
        parts.push({ type: "skill_mention", skillId: mention.id, label: mention.label, raw: mention.raw });
        index += mention.raw.length;
        continue;
      }
    }

    const previousChar = index > 0 ? text[index - 1] ?? "" : "";
    const pathCanStart = index === 0 || /\s/u.test(previousChar) || previousChar === "(" || previousChar === "[" || previousChar === "{";
    const path = pathCanStart ? pathPattern.exec(remaining) : null;
    if (path && path[0].includes("/")) {
      const command = readRegisteredSlashCommandToken(path[0], options.slashCommands ?? []);
      if (command) {
        flushText();
        parts.push({
          type: "slash_command",
          commandId: command.id,
          label: command.label,
          raw: path[0],
        });
        index += path[0].length;
        continue;
      }
      flushText();
      const ref = parseLocalFileReference(path[0], options.cwd);
      parts.push({
        type: "workspace_file",
        path: stripDisplayLocation(ref.displayPath, ref.location),
        raw: path[0],
        line: readLineSuffix(ref.location),
      });
      index += path[0].length;
      continue;
    }

    textBuffer += text[index] ?? "";
    index += 1;
  }

  flushText();
  return mergeAdjacentTextParts(parts);
}

export function serializeComposerInputParts(parts: readonly ComposerInputPart[]): {
  readonly body: string;
  readonly attachmentIds: readonly string[];
} {
  const attachmentIds: string[] = [];
  let body = "";
  for (const part of parts) {
    if (part.type === "attachment") {
      attachmentIds.push(part.attachmentId);
    } else if (part.type === "text") {
      body += part.text;
    } else if (part.type === "teammate_mention" || part.type === "skill_mention") {
      body += part.raw;
    } else if (part.type === "workspace_file" || part.type === "slash_command") {
      body += part.raw;
    }
  }
  return { body, attachmentIds };
}

export function composerWorkspaceFileParts(parts: readonly ComposerInputPart[]): readonly Extract<ComposerInputPart, { readonly type: "workspace_file" }>[] {
  return parts.filter((part): part is Extract<ComposerInputPart, { readonly type: "workspace_file" }> => part.type === "workspace_file");
}

export function composerSlashCommandParts(parts: readonly ComposerInputPart[]): readonly Extract<ComposerInputPart, { readonly type: "slash_command" }>[] {
  return parts.filter((part): part is Extract<ComposerInputPart, { readonly type: "slash_command" }> => part.type === "slash_command");
}

export function removeComposerInputRawToken(text: string, raw: string, occurrenceIndex = 0): string {
  if (!raw) {
    return text;
  }
  let cursor = 0;
  let seen = 0;
  while (cursor < text.length) {
    const index = text.indexOf(raw, cursor);
    if (index === -1) {
      return text;
    }
    if (seen === occurrenceIndex) {
      const before = text.slice(0, index);
      const after = text.slice(index + raw.length);
      if (/\s$/.test(before) && /^\s/.test(after)) {
        return `${before}${after.slice(1)}`;
      }
      return `${before}${after}`;
    }
    seen += 1;
    cursor = index + raw.length;
  }
  return text;
}

function mergeAdjacentTextParts(parts: readonly ComposerInputPart[]): readonly ComposerInputPart[] {
  const merged: ComposerInputPart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (part.type === "text" && previous?.type === "text") {
      merged[merged.length - 1] = { type: "text", text: previous.text + part.text };
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function readKnownMentionAtStart(
  text: string,
  options: ParseComposerInputPartsOptions,
): KnownMentionRead | undefined {
  const teammateMentions = (options.teammateMentions ?? []).flatMap((mention) =>
    mentionAliases(mention).map((alias) => ({ type: "teammate_mention" as const, id: mention.id, label: mention.label, alias })),
  );
  const skillMentions = (options.skills ?? []).flatMap((skill) =>
    mentionAliases(skill).map((alias) => ({ type: "skill_mention" as const, id: skill.id, label: skill.label, alias })),
  );
  const candidates = [...teammateMentions, ...skillMentions]
    .sort((left, right) => right.alias.length - left.alias.length);

  for (const candidate of candidates) {
    const raw = `@${candidate.alias}`;
    if (startsWithCaseInsensitive(text, raw) && hasMentionBoundary(text, raw.length)) {
      return { type: candidate.type, id: candidate.id, label: candidate.label, raw };
    }
  }
  return undefined;
}

function readRegisteredSlashCommandToken(
  raw: string,
  commands: readonly ComposerInputSlashCommandOption[],
): ComposerInputSlashCommandOption | undefined {
  const match = slashCommandTokenPattern.exec(raw);
  if (!match) {
    return undefined;
  }
  const token = normalizeLabel(match[1] ?? "");
  return commands.find((command) => normalizeLabel(command.id) === token || normalizeLabel(command.label) === token);
}

function readLineSuffix(location: string | undefined): number | undefined {
  const match = /^(?::|#L)(\d+)/.exec(location ?? "");
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

function stripDisplayLocation(displayPath: string, location: string | undefined): string {
  if (!location || !displayPath.endsWith(location)) {
    return displayPath;
  }
  return displayPath.slice(0, -location.length);
}

function mentionAliases(mention: { readonly id: string; readonly label: string }): readonly string[] {
  return uniqueStrings([
    mention.label.trim(),
    mention.id.trim(),
    normalizeLabel(mention.label),
    normalizeLabel(mention.id),
  ]);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.toLowerCase();
    if (!value || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function hasMentionBoundary(value: string, index: number): boolean {
  const next = value[index];
  return next === undefined || /\s/u.test(next);
}
