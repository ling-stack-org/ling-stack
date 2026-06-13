import type { ChannelContextSection, ChannelContextView } from "./types.js";

export function promptSectionsFromContextView(view: ChannelContextView): readonly ChannelContextSection[] {
  return view.sections.filter((section) => section.visibility === "prompt");
}

export function renderChannelContextView(view: ChannelContextView): string {
  return promptSectionsFromContextView(view).map((section) => section.text).join("\n\n");
}
