import type { Channel } from "../../types.js";

const channelAvatarTones = ["tone-slate", "tone-blue", "tone-teal", "tone-amber", "tone-rose", "tone-violet"] as const;

export function channelAvatarMeta(channel: Channel): { readonly label: string; readonly tone: (typeof channelAvatarTones)[number] } {
  const seed = channel.id || channel.name;
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return {
    label: channelInitialsFromName(channel.name),
    tone: channelAvatarTones[hash % channelAvatarTones.length] ?? "tone-slate",
  };
}
function channelInitialsFromName(name: string): string {
  const value = name.trim();
  if (!value) {
    return "#";
  }
  const compact = Array.from(value.replace(/\s+/g, ""));
  const firstChar = compact[0] ?? "#";
  if (isCjkCharacter(firstChar)) {
    return firstChar;
  }
  const tokens = value.match(/[A-Za-z0-9]+/g) ?? [];
  if (tokens.length >= 2) {
    return `${tokens[0]?.[0] ?? ""}${tokens[1]?.[0] ?? ""}`.toUpperCase();
  }
  const token = tokens[0] ?? compact.join("");
  return Array.from(token).slice(0, 2).join("").toUpperCase() || firstChar.toUpperCase();
}

function isCjkCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df)
  );
}
