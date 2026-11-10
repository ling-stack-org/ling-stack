import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type FormEventHandler,
  type KeyboardEventHandler,
} from "react";
import type { ComposerInputPart } from "@ling-stack/conversation-ui-core";

export interface TokenizedComposerInputHandle {
  readonly focusAt: (caret: number) => void;
  readonly readSelectionEnd: () => number;
  readonly readSelectionStart: () => number;
  readonly readValue: () => string;
}

export interface TokenizedComposerInputProps {
  readonly value: string;
  readonly parts: readonly ComposerInputPart[];
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly title?: string;
  readonly readOnly?: boolean;
  readonly style?: CSSProperties;
  readonly executableSlashCommandId?: string;
  readonly executableSlashTargetLabel?: string;
  readonly onChange: (value: string, caret: number) => void;
  readonly onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  readonly onPasteFiles?: (files: readonly File[]) => void;
  readonly onSelect: (value: string, caret: number) => void;
}

export const TokenizedComposerInput = forwardRef<TokenizedComposerInputHandle, TokenizedComposerInputProps>(function TokenizedComposerInput(
  {
    ariaLabel,
    executableSlashCommandId,
    executableSlashTargetLabel,
    onChange,
    onKeyDown,
    onPasteFiles,
    onSelect,
    parts,
    placeholder,
    readOnly = false,
    style,
    title,
    value,
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const currentValueRef = useRef(value);
  const pendingCaretRef = useRef<number | undefined>(undefined);
  const placeholderAttributes = { placeholder } as Record<string, string>;

  useImperativeHandle(ref, () => ({
    focusAt(caret: number): void {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      pendingCaretRef.current = caret;
      editor.focus();
      placeCaretAtOffset(editor, caret);
    },
    readSelectionEnd(): number {
      return readSelectionOffset(editorRef.current, "end", value.length);
    },
    readSelectionStart(): number {
      return readSelectionOffset(editorRef.current, "start", value.length);
    },
    readValue(): string {
      return serializeComposerDom(editorRef.current);
    },
  }), [value.length]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    currentValueRef.current = value;
    if (composingRef.current) {
      return;
    }
    const active = document.activeElement === editor;
    const caret = pendingCaretRef.current ?? (active ? readSelectionOffset(editor, "end", value.length) : undefined);
    pendingCaretRef.current = undefined;
    renderComposerInlineParts(editor, parts, executableSlashCommandId, executableSlashTargetLabel);
    if (!active || caret === undefined) {
      return;
    }
    placeCaretAtOffset(editor, caret);
  }, [executableSlashCommandId, executableSlashTargetLabel, parts, value]);

  function emitChange(caret = readSelectionOffset(editorRef.current, "end", value.length)): void {
    if (readOnly) return;
    const serializedValue = serializeComposerDom(editorRef.current);
    const normalized = normalizeAtomicTokenBoundaryValue(parts, serializedValue, caret);
    currentValueRef.current = normalized.value;
    pendingCaretRef.current = normalized.caret;
    onChange(normalized.value, normalized.caret);
  }

  function scheduleCompositionCommit(): void {
    const commit = (): void => {
      if (composingRef.current) {
        return;
      }
      const nextValue = serializeComposerDom(editorRef.current);
      emitChange(readSelectionOffset(editorRef.current, "end", nextValue.length));
    };
    if (typeof globalThis.queueMicrotask === "function") {
      globalThis.queueMicrotask(commit);
      return;
    }
    globalThis.setTimeout(commit, 0);
  }

  function applyTextEdit(insertedText: string, start = readCurrentSelectionOffset("start"), end = readCurrentSelectionOffset("end")): void {
    if (readOnly) return;
    const currentValue = currentValueRef.current;
    const rangeStart = Math.max(0, Math.min(start, end, currentValue.length));
    const rangeEnd = Math.max(rangeStart, Math.min(Math.max(start, end), currentValue.length));
    const normalizedInsertedText = normalizeAtomicBoundaryInsertion(parts, insertedText, rangeStart, rangeEnd);
    const nextValue = `${currentValue.slice(0, rangeStart)}${normalizedInsertedText}${currentValue.slice(rangeEnd)}`;
    const caret = rangeStart + normalizedInsertedText.length;
    currentValueRef.current = nextValue;
    pendingCaretRef.current = caret;
    onChange(nextValue, caret);
  }

  function readCurrentSelectionOffset(edge: "start" | "end"): number {
    const currentValue = currentValueRef.current;
    const domStart = readSelectionOffset(editorRef.current, "start", currentValue.length);
    const domEnd = readSelectionOffset(editorRef.current, "end", currentValue.length);
    const pendingCaret = pendingCaretRef.current;
    if (pendingCaret !== undefined && domStart === domEnd) {
      return Math.max(0, Math.min(pendingCaret, currentValue.length));
    }
    return edge === "start" ? domStart : domEnd;
  }

  const handleBeforeInput: FormEventHandler<HTMLDivElement> = (event) => {
    if (readOnly) { event.preventDefault(); return; }
    const nativeEvent = event.nativeEvent as InputEvent;
    if (nativeEvent.isComposing || composingRef.current || nativeEvent.inputType === "insertCompositionText") {
      return;
    }
    const selectionStart = readCurrentSelectionOffset("start");
    const selectionEnd = readCurrentSelectionOffset("end");
    switch (nativeEvent.inputType) {
      case "insertText":
        event.preventDefault();
        applyTextEdit(nativeEvent.data ?? "", selectionStart, selectionEnd);
        return;
      case "insertLineBreak":
      case "insertParagraph":
        event.preventDefault();
        applyTextEdit("\n", selectionStart, selectionEnd);
        return;
      case "deleteByCut":
      case "deleteContent":
        event.preventDefault();
        applyTextEdit("", selectionStart, selectionEnd);
        return;
      case "deleteContentBackward": {
        event.preventDefault();
        const range = selectionStart === selectionEnd
          ? findAtomicDeletionRange(parts, value, selectionStart, "backward")
          : { start: selectionStart, end: selectionEnd };
        applyTextEdit("", range.start, range.end);
        return;
      }
      case "deleteContentForward": {
        event.preventDefault();
        const range = selectionStart === selectionEnd
          ? findAtomicDeletionRange(parts, value, selectionStart, "forward")
          : { start: selectionStart, end: selectionEnd };
        applyTextEdit("", range.start, range.end);
        return;
      }
      default:
        return;
    }
  };

  return (
    <div
      ref={editorRef}
      className={value ? "tokenized-composer-input has-value" : "tokenized-composer-input"}
      contentEditable={readOnly ? false : "plaintext-only"}
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="true"
      aria-readonly={readOnly || undefined}
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      data-value={value}
      title={title}
      style={style}
      {...placeholderAttributes}
      suppressContentEditableWarning
      spellCheck
      tabIndex={0}
      onBeforeInput={handleBeforeInput}
      onCompositionStart={() => {
        composingRef.current = true;
        pendingCaretRef.current = undefined;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        scheduleCompositionCommit();
      }}
      onInput={() => {
        if (composingRef.current) {
          return;
        }
        emitChange();
      }}
      onKeyDown={(event) => {
        if (readOnly) return;
        onKeyDown(event);
        if (event.defaultPrevented) {
          return;
        }
        if (event.key === "Enter" && event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          applyTextEdit("\n");
        }
      }}
      onKeyUp={() => onSelect(serializeComposerDom(editorRef.current), readSelectionOffset(editorRef.current, "end", value.length))}
      onMouseUp={() => onSelect(serializeComposerDom(editorRef.current), readSelectionOffset(editorRef.current, "end", value.length))}
      onPaste={(event) => {
        if (readOnly) { event.preventDefault(); return; }
        const files = clipboardFiles(event.clipboardData);
        if (files.length > 0) {
          event.preventDefault();
          onPasteFiles?.(files);
          return;
        }
        event.preventDefault();
        applyTextEdit(event.clipboardData.getData("text/plain"));
      }}
    />
  );
});

function clipboardFiles(data: DataTransfer): readonly File[] {
  const files = Array.from(data.files);
  if (files.length > 0) {
    return files;
  }
  return Array.from(data.items).flatMap((item) => {
    if (item.kind !== "file") {
      return [];
    }
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

function renderComposerInlineParts(
  root: HTMLDivElement,
  parts: readonly ComposerInputPart[],
  executableSlashCommandId: string | undefined,
  executableSlashTargetLabel: string | undefined,
): void {
  const rendered: Node[] = [];
  let slashIndex = 0;
  parts.forEach((part) => {
    if (part.type === "attachment") {
      return;
    }
    if (part.type === "text") {
      const span = document.createElement("span");
      span.className = "composer-inline-text";
      span.textContent = part.text;
      rendered.push(span);
      return;
    }
    if (part.type === "teammate_mention" || part.type === "skill_mention") {
      rendered.push(createInlineToken({ className: "composer-inline-token mention", icon: "@", label: part.label, raw: part.raw }));
      return;
    }
    if (part.type === "slash_command") {
      const executable = slashIndex === 0 && part.commandId === executableSlashCommandId;
      slashIndex += 1;
      rendered.push(createInlineToken({
        className: executable ? "composer-inline-token command executable" : "composer-inline-token command",
        icon: "/",
        label: part.label,
        raw: part.raw,
        subtitle: executable && executableSlashTargetLabel ? `${executableSlashTargetLabel} · ${part.raw}` : part.raw,
      }));
      return;
    }
    if (part.type === "workspace_file") {
      rendered.push(createInlineToken({
        className: "composer-inline-token file-reference",
        icon: "F",
        label: part.path,
        raw: part.raw,
        subtitle: part.line !== undefined ? `:${part.line}` : undefined,
      }));
      return;
    }
    rendered.push(createInlineToken({
      className: `composer-inline-token url-reference ${part.state ?? "idle"}`,
      icon: "L",
      label: part.label,
      raw: part.raw,
      subtitle: urlReferenceSubtitle(part),
    }));
  });
  root.replaceChildren(...rendered);
}

function createInlineToken(input: {
  readonly className: string;
  readonly icon: string;
  readonly label: string;
  readonly raw: string;
  readonly subtitle?: string;
}): HTMLSpanElement {
  const token = document.createElement("span");
  token.className = input.className;
  token.contentEditable = "false";
  token.dataset.raw = input.raw;

  const icon = document.createElement("span");
  icon.className = "composer-inline-token-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = input.icon;
  token.append(icon);

  const label = document.createElement("strong");
  label.textContent = input.label;
  token.append(label);

  if (input.subtitle) {
    const subtitle = document.createElement("small");
    subtitle.textContent = input.subtitle;
    token.append(subtitle);
  }
  return token;
}

function serializeComposerDom(root: Node | null): string {
  if (!root) {
    return "";
  }
  if (root.nodeType === Node.TEXT_NODE) {
    return root.nodeValue ?? "";
  }
  if (root instanceof HTMLElement) {
    const raw = root.dataset.raw;
    if (raw !== undefined) {
      return raw;
    }
    if (root.tagName === "BR") {
      return "\n";
    }
  }
  let value = "";
  root.childNodes.forEach((child) => {
    value += serializeComposerDom(child);
  });
  return value;
}

function findAtomicDeletionRange(
  parts: readonly ComposerInputPart[],
  value: string,
  caret: number,
  direction: "backward" | "forward",
): { readonly start: number; readonly end: number } {
  const tokenRanges: Array<{ readonly start: number; readonly end: number }> = [];
  let offset = 0;
  for (const part of parts) {
    if (part.type === "attachment") {
      continue;
    }
    if (part.type === "text") {
      offset += part.text.length;
      continue;
    }
    const start = offset;
    const end = start + part.raw.length;
    tokenRanges.push({ start, end });
    offset = end;
  }
  if (direction === "backward") {
    const tokenRange = tokenRanges.find((range) => range.end === caret);
    return tokenRange ?? { start: Math.max(0, caret - 1), end: caret };
  }
  const tokenRange = tokenRanges.find((range) => range.start === caret);
  return tokenRange ?? { start: caret, end: Math.min(value.length, caret + 1) };
}

function normalizeAtomicBoundaryInsertion(
  parts: readonly ComposerInputPart[],
  insertedText: string,
  start: number,
  end: number,
): string {
  if (start !== end || !insertedText || startsWithBoundary(insertedText) || !isAtomicTokenEnd(parts, start)) {
    return insertedText;
  }
  return ` ${insertedText}`;
}

function startsWithBoundary(value: string): boolean {
  return /^\s/u.test(value) || /^[.,;:!?)\}\]，。！？；：、）】》」』]/u.test(value);
}

function isAtomicTokenEnd(parts: readonly ComposerInputPart[], caret: number): boolean {
  let offset = 0;
  for (const part of parts) {
    if (part.type === "attachment") {
      continue;
    }
    if (part.type === "text") {
      offset += part.text.length;
      continue;
    }
    offset += part.raw.length;
    if (offset === caret) {
      return true;
    }
  }
  return false;
}

function normalizeAtomicTokenBoundaryValue(
  parts: readonly ComposerInputPart[],
  value: string,
  caret: number,
): { readonly value: string; readonly caret: number } {
  let nextValue = value;
  let nextCaret = caret;
  let offset = 0;
  let adjustment = 0;
  for (const part of parts) {
    if (part.type === "attachment") {
      continue;
    }
    if (part.type === "text") {
      offset += part.text.length;
      continue;
    }
    const start = offset + adjustment;
    const end = start + part.raw.length;
    offset += part.raw.length;
    if (nextValue.slice(start, end) !== part.raw || end >= nextValue.length || startsWithBoundary(nextValue.slice(end))) {
      continue;
    }
    nextValue = `${nextValue.slice(0, end)} ${nextValue.slice(end)}`;
    if (nextCaret >= end) {
      nextCaret += 1;
    }
    adjustment += 1;
  }
  return { value: nextValue, caret: nextCaret };
}

function readSelectionOffset(root: HTMLDivElement | null, edge: "start" | "end", fallback: number): number {
  if (!root) {
    return fallback;
  }
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return fallback;
  }
  const sourceRange = selection.getRangeAt(0);
  const container = edge === "start" ? sourceRange.startContainer : sourceRange.endContainer;
  if (!root.contains(container) && container !== root) {
    return fallback;
  }
  const range = sourceRange.cloneRange();
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(edge === "start" ? range.startContainer : range.endContainer, edge === "start" ? range.startOffset : range.endOffset);
  return serializeComposerDom(prefix.cloneContents()).length;
}

function placeCaretAtOffset(root: HTMLDivElement, offset: number): void {
  const position = findDomPositionAtOffset(root, Math.max(0, offset));
  const range = document.createRange();
  switch (position.kind) {
    case "after":
      range.setStartAfter(position.node);
      break;
    case "before":
      range.setStartBefore(position.node);
      break;
    case "container":
      range.setStart(position.node, position.offset);
      break;
    case "text":
      range.setStart(position.node, position.offset);
      break;
  }
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

type CaretPosition =
  | { readonly kind: "text"; readonly node: Text; readonly offset: number }
  | { readonly kind: "before" | "after"; readonly node: Node }
  | { readonly kind: "container"; readonly node: Node; readonly offset: number };

function findDomPositionAtOffset(root: Node, offset: number): CaretPosition {
  let remaining = offset;

  function visit(node: Node): CaretPosition | undefined {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? "";
      if (remaining === 0) {
        return { kind: "before", node: textBoundaryNode(node) };
      }
      if (remaining < text.length) {
        return { kind: "text", node: node as Text, offset: remaining };
      }
      if (remaining === text.length) {
        return { kind: "after", node: textBoundaryNode(node) };
      }
      remaining -= text.length;
      return undefined;
    }

    if (node instanceof HTMLElement) {
      const raw = node.dataset.raw;
      if (raw !== undefined) {
        if (remaining === 0) {
          return { kind: "before", node };
        }
        if (remaining <= raw.length) {
          return { kind: "after", node };
        }
        remaining -= raw.length;
        return undefined;
      }
      if (node.tagName === "BR") {
        if (remaining <= 1) {
          return { kind: "after", node };
        }
        remaining -= 1;
        return undefined;
      }
    }

    for (const child of Array.from(node.childNodes)) {
      const result = visit(child);
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  return visit(root) ?? { kind: "container", node: root, offset: root.childNodes.length };
}

function textBoundaryNode(node: Node): Node {
  const parent = node.parentElement;
  return parent?.classList.contains("composer-inline-text") ? parent : node;
}

function urlReferenceSubtitle(part: Extract<ComposerInputPart, { readonly type: "url_ref" }>): string {
  if (part.state === "uploading") {
    return "Fetching";
  }
  if (part.state === "blocked") {
    return part.error || "Blocked";
  }
  if (part.state === "failed") {
    return part.error || "Failed";
  }
  return part.host ?? part.raw;
}
