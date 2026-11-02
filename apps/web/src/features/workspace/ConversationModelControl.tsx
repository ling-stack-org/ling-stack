import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, RotateCcw, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, IconButton, Input, Popover, PopoverContent, PopoverTrigger } from "../../shared/ui/index.js";
import type { ProviderThinkingMode } from "../../types.js";
import { normalConversationDefaultThinkingLevel, normalConversationThinkingLabel, normalConversationThinkingOptions } from "./normal-conversation-composer-options.js";
import type { ConversationHomeModelOption } from "./normal-conversation-types.js";

interface ConversationModelControlProps {
  readonly modelOptions: readonly ConversationHomeModelOption[];
  readonly selectedProviderPresetId: string;
  readonly defaultProviderPresetId: string;
  readonly defaultProviderLabel: string;
  readonly thinkingLevel: ProviderThinkingMode;
  readonly disabled: boolean;
  readonly onModelChange: (option: ConversationHomeModelOption) => void;
  readonly onThinkingLevelChange: (level: ProviderThinkingMode) => void;
}

export function ConversationModelControl({
  modelOptions, selectedProviderPresetId, defaultProviderPresetId, defaultProviderLabel,
  thinkingLevel, disabled, onModelChange, onThinkingLevelChange,
}: ConversationModelControlProps): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"reasoning" | "models">("reasoning");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const modelSwitchRef = useRef<HTMLButtonElement>(null);
  const selectedId = selectedProviderPresetId || defaultProviderPresetId;
  const selectedModel = modelOptions.find((option) => option.id === selectedId);
  const defaultModel = modelOptions.find((option) => option.id === defaultProviderPresetId);
  // Routing details stay in the model list; the composer only needs the model name.
  const modelLabel = selectedModel?.model || defaultProviderLabel;
  const levels = useMemo(() => normalConversationThinkingOptions(selectedModel?.thinkingModes ?? []), [selectedModel?.thinkingModes]);
  const supportsReasoning = levels.length > 0;
  const defaultLevel = normalConversationDefaultThinkingLevel(levels);
  const levelIndex = Math.max(0, levels.indexOf(thinkingLevel));
  const levelLabel = normalConversationThinkingLabel(levels[levelIndex] ?? "off", t);
  const thinkingOff = (levels[levelIndex] ?? "off") === "off";
  const effortLabel = thinkingOff ? t("Thinking off") : levelLabel;
  const visibleModels = modelOptions.filter((option) =>
    [option.model, option.label, option.displayName, option.providerId].join(" ").toLowerCase().includes(search.trim().toLowerCase()),
  );

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || view !== "models") return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, view]);

  function selectModel(option: ConversationHomeModelOption): void {
    if (disabled) return;
    onModelChange(option);
    setOpen(false);
  }

  return (
    <Popover open={open && !disabled} onOpenChange={(nextOpen) => {
      setOpen(nextOpen && !disabled);
      setView(supportsReasoning ? "reasoning" : "models");
      setSearch("");
    }}>
      <PopoverTrigger asChild>
        <Button
          className="conversation-model-trigger"
          variant="ghost"
          size="sm"
          aria-label={`${t("Selected model {label}", { label: modelLabel })}${supportsReasoning ? ` · ${t("Selected thinking mode {label}", { label: levelLabel })}` : ""}`}
          title={`${modelLabel}${supportsReasoning ? ` · ${thinkingOff ? t("Thinking is off; no thinking level will be sent.") : levelLabel}` : ""}`}
          trailingIcon={<ChevronDown size={13} />}
          disabled={disabled}
        >
          <span className="conversation-model-trigger-name">{modelLabel}</span>
          {supportsReasoning ? <span className="conversation-model-trigger-effort">{effortLabel}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={`conversation-model-popover ${view === "models" ? "conversation-model-menu" : "conversation-reasoning-panel"}`}
        side="top"
        align="end"
        sideOffset={12}
        size="content"
        aria-label={view === "models" ? t("Model options") : t("Thinking mode")}
        onEscapeKeyDown={(event) => {
          if (view !== "models" || !supportsReasoning) return;
          event.preventDefault();
          setView("reasoning");
          setSearch("");
          requestAnimationFrame(() => modelSwitchRef.current?.focus());
        }}
      >
        {view === "reasoning" ? (
          <>
            <div className="conversation-reasoning-header">
              <Button
                ref={modelSwitchRef}
                className="conversation-reasoning-model-switch"
                variant="ghost"
                onClick={() => setView("models")}
                aria-label={t("Model options")}
              >
                <strong>{levelLabel}</strong>
                <span>{modelLabel}<ChevronRight size={14} /></span>
              </Button>
              <IconButton
                className="conversation-reasoning-reset"
                icon={RotateCcw}
                label={t("Reset")}
                tooltip={t("Reset")}
                disabled={thinkingLevel === defaultLevel}
                onClick={() => onThinkingLevelChange(defaultLevel)}
              />
            </div>
            <div className="conversation-reasoning-slider" style={{ "--reasoning-progress": levelIndex / Math.max(1, levels.length - 1) } as CSSProperties}>
              <div className="conversation-reasoning-ticks" aria-hidden="true">
                {levels.map((level, index) => <span key={level} style={{ left: `${index / Math.max(1, levels.length - 1) * 100}%` }} />)}
              </div>
              <input
                data-ling-control-native="true"
                type="range"
                min={0}
                max={Math.max(0, levels.length - 1)}
                step={1}
                value={levelIndex}
                disabled={levels.length <= 1 || disabled}
                aria-label={t("Thinking mode")}
                aria-valuetext={levelLabel}
                onChange={(event) => {
                  const level = levels[Number(event.currentTarget.value)];
                  if (level && !disabled) onThinkingLevelChange(level);
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="conversation-model-menu-header">
              {supportsReasoning ? <IconButton icon={ArrowLeft} label={t("Back")} tooltip={t("Back")} onClick={() => { setView("reasoning"); setSearch(""); requestAnimationFrame(() => modelSwitchRef.current?.focus()); }} /> : null}
              <span>{t("Model options")}</span>
            </div>
            <Input
              ref={searchRef}
              containerClassName="conversation-model-search"
              size="sm"
              prefix={<Search size={14} />}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search models")}
              aria-label={t("Search models")}
            />
            <div className="conversation-model-list">
              {!search.trim() && defaultModel ? (
                <Button
                  className="conversation-model-default-option"
                  variant="ghost"
                  onClick={() => selectModel(defaultModel)}
                >
                  <span><strong>{t("Default")}</strong><small>{defaultModel.model}</small></span>
                  {selectedId === defaultProviderPresetId ? <Check size={15} /> : null}
                </Button>
              ) : null}
              {visibleModels.map((option) => (
                <Button
                  key={option.id}
                  className="conversation-model-option"
                  variant="ghost"
                  aria-pressed={option.id === selectedId}
                  title={option.label || option.displayName}
                  onClick={() => selectModel(option)}
                >
                  <span className="conversation-model-option-copy"><strong>{option.model}</strong><small>{option.displayName}</small></span>
                  {option.id === selectedId ? <Check size={15} /> : null}
                </Button>
              ))}
              {visibleModels.length === 0 ? <span className="conversation-model-empty">{t("No matching models")}</span> : null}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
