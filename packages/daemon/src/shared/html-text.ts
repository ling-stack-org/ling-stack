interface HtmlEntityDecodeOptions {
  readonly names?: readonly ("nbsp" | "amp" | "lt" | "gt" | "quot" | "#39")[];
  readonly numeric?: boolean;
}

const htmlEntityPattern = /&(?:nbsp|amp|lt|gt|quot|#39|#\d{1,7}|#x[0-9a-f]{1,6});/giu;

export function decodeHtmlEntitiesOnce(value: string, options: HtmlEntityDecodeOptions = {}): string {
  const names = new Set(options.names ?? ["nbsp", "amp", "lt", "gt", "quot", "#39"]);
  return value.replace(htmlEntityPattern, (entity) => {
    const token = entity.slice(1, -1).toLowerCase();
    if (token.startsWith("#") && token !== "#39") {
      if (options.numeric !== true) return entity;
      const radix = token.startsWith("#x") ? 16 : 10;
      const digits = token.slice(radix === 16 ? 2 : 1);
      const codePoint = Number.parseInt(digits, radix);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (!names.has(token as "nbsp" | "amp" | "lt" | "gt" | "quot" | "#39")) return entity;
    switch (token) {
      case "nbsp": return " ";
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "#39": return "'";
      default: return entity;
    }
  });
}

export function stripUnreadableHtml(html: string): string {
  const body = findBodyContentRange(html);
  const source = body ? html.slice(body.start, body.end) : html;
  const output: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] !== "<") {
      output.push(source[cursor] ?? "");
      cursor += 1;
      continue;
    }
    if (source.startsWith("<!--", cursor)) {
      const commentEnd = source.indexOf("-->", cursor + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      output.push(" ");
      continue;
    }
    const tag = readHtmlTag(source, cursor);
    if (!tag) {
      output.push("<");
      cursor += 1;
      continue;
    }
    cursor = tag.end;
    if (!tag.closing && unreadableTags.has(tag.name)) {
      cursor = findClosingTag(source, tag.name, cursor)?.end ?? source.length;
      output.push(" ");
      continue;
    }
    if (tag.name === "br" || (tag.closing && blockTags.has(tag.name))) output.push("\n");
    else output.push(" ");
  }
  return output.join("");
}

const unreadableTags = new Set(["script", "style", "noscript", "svg", "nav", "footer", "form", "aside", "head"]);
const blockTags = new Set(["p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr"]);

function findBodyContentRange(html: string): { readonly start: number; readonly end: number } | undefined {
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening === -1) return undefined;
    const tag = readHtmlTag(html, opening);
    if (!tag) {
      cursor = opening + 1;
      continue;
    }
    if (!tag.closing && tag.name === "body") {
      const closing = findClosingTag(html, "body", tag.end);
      return { start: tag.end, end: closing?.start ?? html.length };
    }
    if (!tag.closing && unreadableTags.has(tag.name)) {
      cursor = findClosingTag(html, tag.name, tag.end)?.end ?? html.length;
    } else {
      cursor = tag.end;
    }
  }
  return undefined;
}

function findClosingTag(html: string, name: string, start: number): HtmlTag | undefined {
  let cursor = start;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening === -1) return undefined;
    const tag = readHtmlTag(html, opening);
    if (tag?.closing && tag.name === name) return tag;
    cursor = tag ? tag.end : opening + 1;
  }
  return undefined;
}

interface HtmlTag {
  readonly start: number;
  readonly name: string;
  readonly closing: boolean;
  readonly end: number;
}

function readHtmlTag(html: string, start: number): HtmlTag | undefined {
  if (html[start] !== "<") return undefined;
  let cursor = start + 1;
  while (isHtmlWhitespace(html[cursor])) cursor += 1;
  let closing = false;
  if (html[cursor] === "/") {
    closing = true;
    cursor += 1;
    while (isHtmlWhitespace(html[cursor])) cursor += 1;
  }
  const nameStart = cursor;
  while (isAsciiLetterOrDigit(html[cursor])) cursor += 1;
  if (cursor === nameStart) return undefined;
  const name = html.slice(nameStart, cursor).toLowerCase();
  let quote: "\"" | "'" | undefined;
  while (cursor < html.length) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return { start, name, closing, end: cursor + 1 };
    }
    cursor += 1;
  }
  return undefined;
}

function isHtmlWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r" || value === "\f";
}

function isAsciiLetterOrDigit(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
}
