import type { ComposerInputSlashCommandOption } from "./composer-input-parts.js";

export interface ActiveSlashCommandPicker {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export function findActiveSlashCommand(
  value: string,
  caret: number,
): ActiveSlashCommandPicker | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(^|[\s([{])\/([A-Za-z0-9_.-]{0,48})$/.exec(beforeCaret);
  if (!match) {
    return undefined;
  }
  const slashStart = beforeCaret.length - (match[2]?.length ?? 0) - 1;
  if (!slashCommandCanOpenAt(value, slashStart)) {
    return undefined;
  }
  return {
    query: match[2] ?? "",
    start: slashStart,
    end: caret,
  };
}

export function filterSlashCommandPickerOptions(
  slashCommands: readonly ComposerInputSlashCommandOption[],
  picker: ActiveSlashCommandPicker | undefined,
  limit = 8,
): readonly ComposerInputSlashCommandOption[] {
  if (!picker) {
    return [];
  }
  const query = picker.query.trim().toLowerCase();
  return slashCommands
    .filter((option) => {
      if (!query) {
        return true;
      }
      return option.id.toLowerCase().includes(query) || option.label.toLowerCase().includes(query);
    })
    .slice(0, limit);
}

export function insertSlashCommandToken(
  value: string,
  picker: ActiveSlashCommandPicker | undefined,
  commandId: string,
): { readonly value: string; readonly caret: number } {
  const start = Math.max(0, Math.min(picker?.start ?? value.length, value.length));
  const end = Math.max(start, Math.min(picker?.end ?? value.length, value.length));
  const prefix = value.slice(0, start);
  const suffix = value.slice(end).replace(/^\s+/, "");
  const command = `/${commandId}`;
  return {
    value: `${prefix}${command}${suffix ? ` ${suffix}` : " "}`,
    caret: prefix.length + command.length + 1,
  };
}

function slashCommandCanOpenAt(
  value: string,
  slashStart: number,
): boolean {
  if (slashStart === 0) {
    return true;
  }
  return !/[/:]/u.test(value.slice(0, slashStart).trimEnd().at(-1) ?? "");
}
