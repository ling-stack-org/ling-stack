export function trimBoundaryCharacters(
  value: string,
  characters: string,
  side: "start" | "end" | "both" = "both",
): string {
  let start = 0;
  let end = value.length;
  if (side !== "end") {
    while (start < end && characters.includes(value[start] ?? "")) start += 1;
  }
  if (side !== "start") {
    while (end > start && characters.includes(value[end - 1] ?? "")) end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

export function collapseRepeatedCharacter(value: string, character: string): string {
  const result: string[] = [];
  let previousWasCharacter = false;
  for (const current of value) {
    if (current === character) {
      if (!previousWasCharacter) result.push(current);
      previousWasCharacter = true;
    } else {
      result.push(current);
      previousWasCharacter = false;
    }
  }
  return result.join("");
}

export function extractWrappedSection(
  value: string,
  labels: readonly string[],
  boundaryLabels: readonly string[],
  acceptedColons = ":：",
  allowWhitespaceBeforeColon = true,
): string | undefined {
  const searchValue = asciiLowercase(value);
  let selected: { readonly labelIndex: number; readonly start: number } | undefined;
  for (const label of labels) {
    const searchLabel = asciiLowercase(label);
    let labelIndex = searchValue.indexOf(searchLabel);
    while (labelIndex !== -1) {
      let start = labelIndex + label.length;
      if (allowWhitespaceBeforeColon) {
        while (start < value.length && isWhitespace(value[start])) start += 1;
      }
      if (acceptedColons.includes(value[start] ?? "")) {
        start += 1;
        while (start < value.length && isWhitespace(value[start])) start += 1;
        if (!selected || labelIndex < selected.labelIndex) selected = { labelIndex, start };
        break;
      }
      labelIndex = searchValue.indexOf(searchLabel, labelIndex + 1);
    }
  }
  if (!selected) return undefined;
  let end = value.length;
  for (const boundary of boundaryLabels) {
    const searchBoundary = asciiLowercase(boundary);
    let boundaryIndex = searchValue.indexOf(searchBoundary, selected.start);
    while (boundaryIndex !== -1) {
      const before = value[boundaryIndex - 1];
      const after = value[boundaryIndex + boundary.length];
      if (isWhitespace(before) && !isWordCharacter(after)) {
        end = Math.min(end, boundaryIndex);
        break;
      }
      boundaryIndex = searchValue.indexOf(searchBoundary, boundaryIndex + 1);
    }
  }
  const section = value.slice(selected.start, end).trim();
  return section || undefined;
}

/** Fold ASCII search tokens without changing offsets into the original text. */
export function asciiLowercase(value: string): string {
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const code = character.charCodeAt(0);
    result.push(code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character);
  }
  return result.join("");
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "";
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/u.test(value);
}
