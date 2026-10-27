import {
  Archive,
  BookOpen,
  Bot,
  Box,
  Brain,
  CircuitBoard,
  Database,
  GitBranch,
  Palette,
  MonitorCog,
  Smartphone,
  Shield,
  SlidersHorizontal,
  UserCircle,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type SettingsSectionId =
  | "model-workbench"
  | "execution-engines"
  | "ai-teammates"
  | "ai-councils"
  | "approval-strategy"
  | "personal-profile"
  | "personalization"
  | "interface-preferences"
  | "computer-control"
  | "mobile-access"
  | "external-work"
  | "mcp-tools"
  | "skill-library"
  | "archived-items"
  | "startup-diagnostics";

export type SettingsWorkspaceToolView = "" | "providers" | "teammates" | "councils";

export interface SettingsSectionDefinition {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly pageTitle?: string;
  readonly description?: string;
  readonly pending?: boolean;
  readonly icon: LucideIcon;
}

export interface SettingsSectionGroupDefinition {
  readonly heading: string;
  readonly items: readonly SettingsSectionDefinition[];
}

export const settingsSectionGroups: readonly SettingsSectionGroupDefinition[] = [
  {
    heading: "Device",
    items: [
      { id: "computer-control", label: "Computer Control", icon: MonitorCog },
      { id: "mobile-access", label: "Mobile Access", icon: Smartphone },
    ],
  },
  {
    heading: "Workspace tools",
    items: [
      { id: "model-workbench", label: "Model Workbench", icon: Box },
      { id: "execution-engines", label: "Execution engines", icon: CircuitBoard },
      { id: "ai-teammates", label: "Teammate Management", icon: Bot },
      { id: "ai-councils", pageTitle: "Council Workspace", label: "Council Workspace", icon: Brain },
      { id: "approval-strategy", label: "Default authorization", icon: Shield },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "personal-profile", label: "User profile", icon: UserCircle },
      {
        id: "personalization",
        label: "Personalization",
        description: "Ling tone and skill generation policy",
        icon: SlidersHorizontal,
      },
      { id: "interface-preferences", label: "Interface preferences", icon: Palette },
      { id: "external-work", label: "External work", icon: GitBranch },
      { id: "mcp-tools", label: "MCP tool servers", icon: Wrench },
      {
        id: "skill-library",
        label: "Skill library",
        description: "Inspect reusable skill definitions, source health, and workspace skills.",
        icon: BookOpen,
      },
    ],
  },
  {
    heading: "Maintenance",
    items: [
      { id: "archived-items", label: "Archived items", icon: Archive },
      { id: "startup-diagnostics", label: "Startup and diagnostics", icon: Database },
    ],
  },
];

export function workspaceToolViewToSectionId(view: SettingsWorkspaceToolView | undefined): SettingsSectionId | undefined {
  if (view === "providers") return "model-workbench";
  if (view === "teammates") return "ai-teammates";
  if (view === "councils") return "ai-councils";
  return undefined;
}

export function isWorkspaceToolSection(sectionId: SettingsSectionId): boolean {
  return sectionId === "model-workbench" || sectionId === "ai-teammates" || sectionId === "ai-councils";
}
