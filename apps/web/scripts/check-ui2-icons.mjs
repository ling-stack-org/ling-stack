import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ts, visitTypeScriptNode, withTypeScriptSourceFiles } from "./typescript-ast.mjs";

const typedActionOwners = [
  "src/app/DesktopWindowChrome.tsx",
  "src/features/automations/AutomationDefinitionRow.tsx",
  "src/features/automations/AutomationDraftList.tsx",
  "src/features/automations/AutomationListPane.tsx",
  "src/features/automations/AutomationRunList.tsx",
  "src/features/councils/CouncilChannelsPanel.tsx",
  "src/features/councils/CouncilListHealthPanel.tsx",
  "src/features/councils/CouncilMemberRow.tsx",
  "src/features/mcp/McpServerRow.tsx",
  "src/features/media-production/ProjectSceneOutline.tsx",
  "src/features/media-production/MediaProjectAssetPickerDialog.tsx",
  "src/features/media-production/MediaProductionDockRail.tsx",
  "src/features/media-production/SceneVideoImageInputs.tsx",
  "src/features/media-production/SceneInspector.tsx",
  "src/features/media-production/StoryboardCanvas.tsx",
  "src/features/media-production/workflows/WorkflowConnectionWorkspace.tsx",
  "src/features/media-production/workflows/WorkflowLibraryWorkspace.tsx",
  "src/features/navigation/SidebarNavigation.tsx",
  "src/features/navigation/SidebarSection.tsx",
  "src/features/navigation/SidebarSectionMenu.tsx",
  "src/features/plugins/CuaDriverInstallDrawer.tsx",
  "src/features/plugins/PluginRowActions.tsx",
  "src/features/profile/ProfileSettingsSurface.tsx",
  "src/features/providers/ProviderModelImportPanel.tsx",
  "src/features/providers/ProviderRouteActions.tsx",
  "src/features/providers/ProviderRouteList.tsx",
  "src/features/providers/ProviderSecretInput.tsx",
  "src/shared/components/ComposerPendingAssetStrip.tsx",
  "src/features/settings/ExternalWorkSettingsPanel.tsx",
  "src/features/settings/ArchivedItemList.tsx",
  "src/features/settings/ArchivedItemsToolbar.tsx",
  "src/features/settings/SettingsRunDiagnosticsToolbar.tsx",
  "src/features/settings/SkillEditorCoreFields.tsx",
  "src/features/settings/SkillLibraryInspectorPanel.tsx",
  "src/features/settings/SkillLibraryTable.tsx",
  "src/features/settings/StartupReadinessSummary.tsx",
  "src/features/settings/theme-packages/ThemePackageActions.tsx",
  "src/features/teammates/TeammateChatHeader.tsx",
  "src/features/teammates/TeammateCustomSetupStep.tsx",
  "src/features/teammates/TeammatePrivateChatComposer.tsx",
  "src/features/teammates/TeammatePrivateChatFeed.tsx",
  "src/features/teammates/TeammateManagementList.tsx",
  "src/features/teammates/TeammateMemoryHealthSection.tsx",
  "src/features/teammates/TeammateMemoryReviewList.tsx",
  "src/features/teammates/TeammateMemoryScopeList.tsx",
  "src/features/teammates/TeammateProfileTab.tsx",
  "src/features/teammates/TeammateSettingsHeader.tsx",
  "src/features/work-board/WorkBoardToolbar.tsx",
  "src/features/workspace/ChannelCouncilSettingsPanel.tsx",
  "src/features/workspace/ChannelDetailOverlays.tsx",
  "src/features/workspace/ChannelExecutionPathField.tsx",
  "src/features/workspace/ChannelFeedChrome.tsx",
  "src/features/workspace/ChannelGovernanceNotificationsPopover.tsx",
  "src/features/workspace/ChannelHeaderToolbar.tsx",
  "src/features/workspace/ChannelNameField.tsx",
  "src/features/workspace/ChannelTeammateManagerPanel.tsx",
  "src/features/workspace/NormalConversationComposer.tsx",
  "src/features/workspace/NormalConversationFeed.tsx",
  "src/features/workspace/WorkspaceClientView.tsx",
  "src/features/workspace/right-dock/ConversationTopToolbar.tsx",
  "src/features/workspace/right-dock/ConversationHeaderSearch.tsx",
  "src/features/workspace/right-dock/PlanHistoryPage.tsx",
  "src/features/workspace/right-dock/WorkspaceDockToolbar.tsx",
  "src/features/workspace/right-dock/WorkspaceChangeReviewPage.tsx",
  "src/features/workspace/right-dock/WorkspaceSnapshotRestorePanel.tsx",
];
const frozenGeometryOwners = new Set([
  "src/features/navigation/SidebarNavigation.tsx",
  "src/features/navigation/SidebarPrimaryNavigation.tsx",
  "src/features/navigation/SidebarSectionMenu.tsx",
  "src/features/workspace/ChannelHeaderToolbar.tsx",
  "src/features/workspace/right-dock/ConversationTopToolbar.tsx",
  "src/features/workspace/right-dock/WorkspaceDockToolbar.tsx",
]);

const iconButtonTags = new Set(["IconButton", "WorkspaceToolbarIconButton"]);
const legacyReactNodeBudgets = new Map([
  ["src/features/profile/ProfileSettingsSurface.tsx", 1],
]);
const standardIconWithGeometry = /<(?:Archive|GitBranch|ListChecks|MoreHorizontal|PanelBottom(?:Close)?|PanelLeft(?:Close|Open)|PanelRight(?:Close|Open)|Plus|RefreshCw|Search|Settings|UserPlus)\b[^>]*(?:\bsize|\bstrokeWidth)=/gu;
const violations = [];
const discoveredOwners = new Set();
const sourceRoot = resolve(process.cwd(), "src");

const sourceFiles = collectTsxFiles(sourceRoot);
withTypeScriptSourceFiles(sourceFiles, (parsedFiles) => {
  for (const absolutePath of sourceFiles) {
    const sourcePath = relative(process.cwd(), absolutePath).replaceAll("\\", "/");
    const sourceFile = parsedFiles.get(resolve(absolutePath));
    let jsxIconCount = 0;

    visitTypeScriptNode(sourceFile, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sourceFile);
        if (iconButtonTags.has(tagName)) {
          discoveredOwners.add(sourcePath);
          const iconAttribute = node.attributes.properties.find((property) => (
            ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "icon"
          ));
          if (iconAttribute?.initializer && ts.isJsxExpression(iconAttribute.initializer)) {
            const expression = iconAttribute.initializer.expression;
            if (expression && containsJsx(expression)) jsxIconCount += 1;
          }
        }
      }
    });

    const budget = legacyReactNodeBudgets.get(sourcePath) ?? 0;
    if (jsxIconCount !== budget) {
      violations.push(`${sourcePath} legacy ReactNode IconButton budget is ${jsxIconCount}, expected ${budget}`);
    }
  }
});

const expectedOwners = new Set(typedActionOwners);
for (const sourcePath of discoveredOwners) {
  if (!expectedOwners.has(sourcePath)) violations.push(`${sourcePath} IconButton owner is missing from the frozen inventory`);
}
for (const sourcePath of expectedOwners) {
  if (!discoveredOwners.has(sourcePath)) violations.push(`${sourcePath} frozen IconButton owner no longer contains an IconButton`);
}

for (const sourcePath of frozenGeometryOwners) {
  const source = readFileSync(resolve(process.cwd(), sourcePath), "utf8");
  for (const match of source.matchAll(standardIconWithGeometry)) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${sourcePath}:${line} standard action icon geometry belongs to shared Icon`);
  }
}

if (violations.length > 0) {
  console.error("UI 2.0 typed icon contract violations:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`UI 2.0 typed icon contract: ${typedActionOwners.length} Web IconButton owners + ${legacyReactNodeBudgets.size} identity budget`);

function collectTsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [entryPath] : [];
  });
}

function containsJsx(node) {
  let found = false;
  visitTypeScriptNode(node, (current) => {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
      found = true;
    }
  });
  return found;
}
