import { parseLocalFileReference } from "../conversation/message-body.js";

export type ComposerInputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "attachment"; readonly attachmentId: string }
  | { readonly type: "workspace_file"; readonly path: string; readonly raw: string; readonly line?: number }
  | { readonly type: "teammate_mention"; readonly teammateId: string; readonly label: string; readonly raw: string }
  | { readonly type: "skill_mention"; readonly skillId: string; readonly label: string; readonly raw: string };

export interface ComposerInputMentionOption {
  readonly id: string;
  readonly label: string;
}

export interface ComposerInputSkillOption {
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
}

const mentionPattern = /^@[A-Za-z0-9][A-Za-z0-9_.-]*/;
const pathPattern = /^(?:~\/|\.{1,2}\/|\/|(?:[A-Za-z0-9_.-]+\/))[^\s<>"'`]+/;

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
    const mention = mentionPattern.exec(remaining);
    if (mention) {
      const raw = mention[0];
      const label = raw.slice(1);
      const teammate = options.teammateMentions?.find((candidate) => labelsMatch(candidate.label, label));
      const skill = teammate ? undefined : options.skills?.find((candidate) => labelsMatch(candidate.label, label));
      if (teammate) {
        flushText();
        parts.push({ type: "teammate_mention", teammateId: teammate.id, label: teammate.label, raw });
        index += raw.length;
        continue;
      }
      if (skill) {
        flushText();
        parts.push({ type: "skill_mention", skillId: skill.id, label: skill.label, raw });
        index += raw.length;
        continue;
      }
    }

    const path = pathPattern.exec(remaining);
    if (path && path[0].includes("/")) {
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
    } else if (part.type === "workspace_file") {
      body += part.raw;
    }
  }
  return { body, attachmentIds };
}

export function composerWorkspaceFileParts(parts: readonly ComposerInputPart[]): readonly Extract<ComposerInputPart, { readonly type: "workspace_file" }>[] {
  return parts.filter((part): part is Extract<ComposerInputPart, { readonly type: "workspace_file" }> => part.type === "workspace_file");
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

function labelsMatch(left: string, right: string): boolean {
  return normalizeLabel(left) === normalizeLabel(right);
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
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
