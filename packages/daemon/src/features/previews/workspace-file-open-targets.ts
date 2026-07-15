import type { WorkspaceFileOpenTarget } from "@ling-stack/contracts";

export interface WorkspaceFileOpenTargetDefinition {
  readonly id: WorkspaceFileOpenTarget;
  readonly label: string;
  readonly kind: "editor" | "finder" | "terminal";
  readonly command?: string;
  readonly macApplication?: string;
  readonly macBundleIdentifiers?: readonly string[];
}

const definitions = [
  {
    id: "vscode",
    label: "Visual Studio Code",
    kind: "editor",
    command: "code",
    macApplication: "Visual Studio Code",
    macBundleIdentifiers: ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"],
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "editor",
    command: "cursor",
    macApplication: "Cursor",
    macBundleIdentifiers: ["com.todesktop.230313mzl4w4u92"],
  },
  {
    id: "zed",
    label: "Zed",
    kind: "editor",
    command: "zed",
    macApplication: "Zed",
    macBundleIdentifiers: ["dev.zed.Zed"],
  },
  {
    id: "sublime_text",
    label: "Sublime Text",
    kind: "editor",
    command: "subl",
    macApplication: "Sublime Text",
    macBundleIdentifiers: ["com.sublimetext.4", "com.sublimetext.3"],
  },
  {
    id: "textedit",
    label: "TextEdit",
    kind: "editor",
    macApplication: "TextEdit",
    macBundleIdentifiers: ["com.apple.TextEdit"],
  },
  {
    id: "xcode",
    label: "Xcode",
    kind: "editor",
    command: "xed",
    macApplication: "Xcode",
    macBundleIdentifiers: ["com.apple.dt.Xcode"],
  },
  {
    id: "pycharm",
    label: "PyCharm",
    kind: "editor",
    command: "charm",
    macApplication: "PyCharm",
    macBundleIdentifiers: ["com.jetbrains.pycharm", "com.jetbrains.pycharm-EAP"],
  },
  {
    id: "webstorm",
    label: "WebStorm",
    kind: "editor",
    command: "webstorm",
    macApplication: "WebStorm",
    macBundleIdentifiers: ["com.jetbrains.WebStorm", "com.jetbrains.WebStorm-EAP"],
  },
  {
    id: "intellij",
    label: "IntelliJ IDEA",
    kind: "editor",
    command: "idea",
    macApplication: "IntelliJ IDEA",
    macBundleIdentifiers: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce", "com.jetbrains.intellij-EAP"],
  },
  { id: "finder", label: "Show in Finder", kind: "finder" },
  { id: "terminal", label: "Terminal", kind: "terminal" },
] as const satisfies readonly WorkspaceFileOpenTargetDefinition[];

const definitionsById = new Map<WorkspaceFileOpenTarget, WorkspaceFileOpenTargetDefinition>(
  definitions.map((definition) => [definition.id, definition]),
);

export function workspaceFileOpenTargetDefinitions(): readonly WorkspaceFileOpenTargetDefinition[] {
  return definitions;
}

export function workspaceFileOpenTargetDefinition(
  target: WorkspaceFileOpenTarget,
): WorkspaceFileOpenTargetDefinition {
  return definitionsById.get(target)!;
}

export function isWorkspaceFileOpenTarget(value: unknown): value is WorkspaceFileOpenTarget {
  return typeof value === "string" && definitionsById.has(value as WorkspaceFileOpenTarget);
}
