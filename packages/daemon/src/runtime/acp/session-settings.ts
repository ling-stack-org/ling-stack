import { isAbsolute } from "node:path";
import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { AcpLifecycleError, record, text } from "./live-errors.js";

export interface AcpSessionConfiguration {
  readonly cwd: string;
  readonly modelId?: string;
  readonly modeId?: "default" | "plan";
  readonly thoughtLevel?: string;
}
export interface AcpSessionSettingsSnapshot {
  readonly configOptions: readonly SessionConfigOption[];
  readonly modes?: SessionModeState;
}

export function validateAcpSessionConfiguration(value: unknown): asserts value is AcpSessionConfiguration {
  if (!record(value) || Object.keys(value).some(key => !["cwd", "modelId", "modeId", "thoughtLevel"].includes(key))
    || !text(value.cwd) || !isAbsolute(value.cwd)
    || [value.modelId, value.thoughtLevel].some(item => item !== undefined && !text(item))
    || (value.modeId !== undefined && value.modeId !== "default" && value.modeId !== "plan")) invalid("invalid_input");
}

/** Owns the native catalog and confirmed choices, never arbitrary permission configuration. */
export class AcpSessionSettings {
  readonly #configuration: AcpSessionConfiguration;
  readonly #engineId: "kimi-acp" | "openclaw-acp";
  #options: SessionConfigOption[] = [];
  #modes?: SessionModeState;
  #lockedMode?: string;
  #notifiedMode?: string;
  #sessionReceived = false;
  #modeConfirmation?: { readonly value: string; readonly resolve: () => void };
  #pending?: readonly [string, string];
  #locked = new Map<string, string>();

  constructor(engineId: "kimi-acp" | "openclaw-acp", configuration: AcpSessionConfiguration) {
    validateAcpSessionConfiguration(configuration);
    this.#configuration = structuredClone(configuration);
    this.#engineId = engineId;
  }

  get snapshot(): AcpSessionSettingsSnapshot { return structuredClone({ configOptions: this.#options, modes: this.#modes }); }

  acceptSession(value: unknown): void {
    if (!record(value)) invalid();
    this.#sessionReceived = true;
    this.#notifiedMode = undefined;
    this.#modes = parseModes(value.modes);
    this.#replace(parseOptions(value.configOptions ?? []));
  }

  acceptConfiguration(value: unknown): void {
    if (!record(value) || !this.#pending) invalid();
    const options = parseOptions(value.configOptions);
    this.#require(this.#pending[0], this.#pending[1], options, true);
    this.#replace(options);
  }

  receive(update: Readonly<Record<string, unknown>>): boolean {
    if (update.sessionUpdate === "current_mode_update") {
      if (!text(update.currentModeId)) invalid();
      if (this.#lockedMode !== undefined && this.#lockedMode !== update.currentModeId) invalid("binding_mismatch");
      if (this.#modes) {
        if (!this.#modes.availableModes.some(mode => mode.id === update.currentModeId)) invalid("unsupported_capability");
        this.#modes = { ...this.#modes, currentModeId: update.currentModeId };
      } else if (this.#sessionReceived && this.#engineId === "kimi-acp") {
        this.#require("mode", update.currentModeId);
      }
      this.#notifiedMode = update.currentModeId;
      if (this.#modeConfirmation?.value === update.currentModeId) this.#modeConfirmation.resolve();
      return true;
    }
    if (update.sessionUpdate !== "config_option_update") return false;
    this.#replace(parseOptions(update.configOptions));
    return true;
  }

  async negotiate(request: (configId: string, value: string) => Promise<unknown>,
    requestMode: (modeId: string, confirmed: Promise<void>) => Promise<unknown>): Promise<void> {
    const selected = this.#configuration;
    if (this.#engineId !== "kimi-acp" && (selected.modelId !== undefined || selected.modeId !== undefined)) invalid("unsupported_capability");
    const thoughtId = this.#engineId === "kimi-acp" ? "thinking" : "thought_level";
    // Model changes can replace the thinking catalog. Validate thinking only after its model is confirmed.
    const choices = [["mode", selected.modeId], ["model", selected.modelId], [thoughtId, selected.thoughtLevel]] as const;
    for (const [id, value] of choices) {
      if (value === undefined) continue;
      if (id === "mode" && !this.#options.some(option => option.id === "mode")) {
        if (!this.#modes?.availableModes.some(mode => mode.id === value)) invalid("unsupported_capability");
        if (this.#modes.currentModeId !== value) {
          const confirmed = new Promise<void>(resolve => { this.#modeConfirmation = { value, resolve }; });
          try { await requestMode(value, confirmed); } finally { this.#modeConfirmation = undefined; }
        }
        if (this.#modes.currentModeId !== value) invalid("binding_mismatch");
        continue;
      }
      const option = this.#require(id, value);
      if (option.currentValue !== value) {
        this.#pending = [id, value];
        try { await request(id, value); } finally { this.#pending = undefined; }
      }
      this.#require(id, value, this.#options, true);
    }
    for (const [id, value] of choices) if (value !== undefined) {
      if (id === "mode" && !this.#options.some(option => option.id === "mode")) {
        if (this.#modes?.currentModeId !== value) invalid("binding_mismatch");
      } else this.#require(id, value, this.#options, true);
    }
    const mode = this.#options.find(option => option.id === "mode");
    if (this.#engineId === "kimi-acp") {
      const current = mode?.currentValue ?? this.#modes?.currentModeId;
      if (this.#notifiedMode !== undefined && this.#notifiedMode !== current) invalid("binding_mismatch");
      if (current !== undefined && current !== "default" && current !== "plan") invalid("unsupported_capability");
      if (mode && this.#modes && mode.currentValue !== this.#modes.currentModeId) invalid("binding_mismatch");
      this.#lockedMode = typeof current === "string" ? current : undefined;
    } else if (selected.thoughtLevel !== undefined) {
      if (this.#modes && this.#modes.currentModeId !== selected.thoughtLevel) invalid("binding_mismatch");
      this.#lockedMode = selected.thoughtLevel;
    }
    for (const id of ["model", "mode", ...(selected.thoughtLevel !== undefined ? [thoughtId] : [])]) {
      const option = this.#options.find(option => option.id === id);
      if (option?.type === "select" && text(option.currentValue)) this.#locked.set(id, option.currentValue);
    }
  }

  #require(id: string, value: string, options = this.#options, confirmed = false): SessionConfigOption {
    const option = options.find(option => option.id === id);
    if (!option || option.type !== "select" || !optionValues(option).includes(value)) invalid("unsupported_capability");
    if (confirmed && option.currentValue !== value) invalid("binding_mismatch");
    return option;
  }

  #replace(options: SessionConfigOption[]): void {
    for (const [id, value] of this.#locked) this.#require(id, value, options, true);
    this.#options = options;
  }
}

function optionValues(option: Extract<SessionConfigOption, { type: "select" }>): string[] {
  return option.options.flatMap(item => "group" in item ? item.options.map(option => option.value) : [item.value]);
}

function parseOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value) || value.length > 64) invalid();
  const ids = new Set<string>();
  for (const option of value) {
    if (!record(option) || !text(option.id) || ids.has(option.id) || !text(option.name)
      || (option.category != null && !text(option.category)) || (option.description != null && typeof option.description !== "string")) invalid();
    ids.add(option.id);
    if (option.type !== "select") invalid("unsupported_capability");
    if (typeof option.currentValue !== "string" || (option.currentValue !== "" && !text(option.currentValue))
      || !Array.isArray(option.options) || option.options.length > 512) invalid();
    const values = new Set<string>();
    const groups = new Set<string>();
    const grouped = option.options.length > 0 && record(option.options[0]) && "group" in option.options[0];
    for (const item of option.options) {
      if (!record(item) || grouped !== ("group" in item)) invalid();
      if (grouped && (!text(item.group) || groups.has(item.group) || !text(item.name)
        || !Array.isArray(item.options) || item.options.length > 512)) invalid();
      if (grouped) groups.add(item.group as string);
      for (const choice of grouped ? item.options as unknown[] : [item]) {
        if (!record(choice) || !text(choice.value) || !text(choice.name) || values.has(choice.value)
          || (choice.description != null && typeof choice.description !== "string") || values.size >= 2048) invalid();
        values.add(choice.value);
      }
    }
    if (option.currentValue !== "" && !values.has(option.currentValue)) invalid();
  }
  return structuredClone(value) as SessionConfigOption[];
}

function invalid(code: AcpLifecycleError["code"] = "protocol_error"): never { throw new AcpLifecycleError(code); }

function parseModes(value: unknown): SessionModeState | undefined {
  if (value == null) return undefined;
  if (!record(value) || !text(value.currentModeId) || !Array.isArray(value.availableModes) || value.availableModes.length > 64) invalid();
  const ids = new Set<string>();
  for (const mode of value.availableModes) {
    if (!record(mode) || !text(mode.id) || !text(mode.name) || ids.has(mode.id)
      || (mode.description != null && typeof mode.description !== "string")) invalid();
    ids.add(mode.id);
  }
  if (!ids.has(value.currentModeId)) invalid();
  return structuredClone(value) as SessionModeState;
}
