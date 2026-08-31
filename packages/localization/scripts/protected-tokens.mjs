export const protectedMarkerPattern = /(?:__\d+__|[\uE000-\uF8FF]|XQZ\d+X|\d+XQZ\d+|LING_TOKEN|[⟦⟧])/iu;

const protectedPatterns = [
  /\{[A-Za-z0-9_]+\}/g,
  /`[^`\n]+`/g,
  /https?:\/\/[^\s)]+/g,
  /\b(?:Ling Stack|Ling|MCP|Agent|Skill|Daemon|Desktop|Computer Use|Chrome|WPS|API|URL|ID)\b/g,
];

export function protectMessage(value) {
  const tokens = [];
  let text = value;
  for (const pattern of protectedPatterns) {
    text = text.replace(pattern, (match) => {
      const index = tokens.push(match) - 1;
      return markerFor(index);
    });
  }
  return { text, tokens };
}

export function restoreProtectedTokens(value, tokens) {
  let output = value;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const currentMarker = markerFor(index);
    const legacyMarkers = [
      String.fromCodePoint(0xE000 + index),
      `${index}XQZ${index}`,
      `XQZ${index}X`,
    ];
    for (const marker of [currentMarker, ...legacyMarkers]) {
      for (const protectedForm of [`[${marker}]`, `［${marker}］`, `【${marker}】`, marker]) {
        output = output.replaceAll(protectedForm, tokens[index]);
      }
    }
  }
  return output;
}

export function protectedMessageParts(value, tokens) {
  const parts = [];
  const markerPattern = /__(\d+)__/gu;
  let offset = 0;
  for (const match of value.matchAll(markerPattern)) {
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= tokens.length) {
      throw new Error(`Protected token marker is out of range: ${match[0]}`);
    }
    if (match.index > offset) {
      parts.push({ kind: "text", value: value.slice(offset, match.index) });
    }
    parts.push({ kind: "token", value: tokens[index] });
    offset = match.index + match[0].length;
  }
  if (offset < value.length) {
    parts.push({ kind: "text", value: value.slice(offset) });
  }
  return parts;
}

export function splitTranslatableText(value) {
  const candidates = [...value.matchAll(/\s+/gu)]
    .filter((match) => {
      const index = match.index ?? 0;
      return value.slice(0, index).trim() && value.slice(index + match[0].length).trim();
    });
  if (candidates.length === 0) return undefined;

  const midpoint = value.length / 2;
  const boundary = candidates.reduce((best, candidate) => {
    const bestDistance = Math.abs((best.index ?? 0) - midpoint);
    const candidateDistance = Math.abs((candidate.index ?? 0) - midpoint);
    return candidateDistance < bestDistance ? candidate : best;
  });
  const index = boundary.index ?? 0;
  return {
    left: value.slice(0, index),
    separator: boundary[0],
    right: value.slice(index + boundary[0].length),
  };
}

function markerFor(index) {
  // Numeric sentinels remain opaque across writing systems. Alphabetic markers
  // can be transliterated, punctuation can be rebalanced, and PUA characters
  // can be treated as ignorable whitespace by machine translation.
  return `__${index}__`;
}
