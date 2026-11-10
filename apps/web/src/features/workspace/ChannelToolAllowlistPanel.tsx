import { ShieldAlert, Wrench } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { allTools, riskyTools } from "../../lib/tools.js";
import {
  DataRow,
  InlineFeedback,
  StatusIndicator,
  Switch,
} from "../../shared/ui/index.js";
import type { ToolName } from "../../types.js";

export function ChannelToolAllowlistPanel({
  allowedTools,
  disabled = false,
  onChange,
}: {
  readonly allowedTools: readonly ToolName[];
  readonly disabled?: boolean;
  readonly onChange: (allowedTools: readonly ToolName[]) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const enabledTools = new Set(allowedTools);

  function toggleTool(tool: ToolName): void {
    if (enabledTools.has(tool)) {
      if (enabledTools.size === 1) return;
      onChange(allowedTools.filter((current) => current !== tool));
      return;
    }
    onChange([...allowedTools, tool]);
  }

  return (
    <section className="channel-settings-surface channel-tool-allowlist-panel" aria-label={t("Channel capabilities")}>
      <div className="channel-settings-surface-heading">
        <div className="channel-settings-section-heading-copy">
          <Wrench aria-hidden="true" size={18} />
          <strong>{t("Channel capabilities")}</strong>
        </div>
      </div>
      <InlineFeedback tone="info">
        <span className="channel-tool-allowlist-note">
          <ShieldAlert aria-hidden="true" size={14} />
          <span>{t("The channel allowlist is a hard capability boundary; risky actions still require approval.")}</span>
        </span>
      </InlineFeedback>
      <div className="channel-tool-allowlist" role="list" aria-label={t("Channel capabilities")}>
        {allTools.map((tool) => {
          const enabled = enabledTools.has(tool);
          const risky = riskyTools.includes(tool);
          return (
            <DataRow
              compact
              className="channel-tool-allowlist-row"
              key={tool}
              role="listitem"
              identity={<strong>{t(toolLabelKey(tool))}</strong>}
              status={<StatusIndicator label={t(enabled ? "Enabled" : "Disabled")} tone={enabled ? (risky ? "warning" : "success") : "neutral"} />}
              actions={(
                <Switch
                  aria-label={t("Use capability in channel: {name}", { name: t(toolLabelKey(tool)) })}
                  checked={enabled}
                  disabled={disabled || (enabled && enabledTools.size === 1)}
                  onCheckedChange={() => toggleTool(tool)}
                />
              )}
            />
          );
        })}
      </div>
    </section>
  );
}

function toolLabelKey(tool: ToolName): string {
  if (tool === "read") return "Read files";
  if (tool === "grep") return "Search file contents";
  if (tool === "find") return "Find files";
  if (tool === "ls") return "List folders";
  if (tool === "bash") return "Run commands";
  if (tool === "edit") return "Edit files";
  return "Write files";
}
