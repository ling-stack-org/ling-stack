import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  filterSlashCommandPickerOptions,
  findActiveSlashCommand,
  insertSlashCommandToken,
  type ActiveSlashCommandPicker,
  type TokenizedComposerInputHandle,
} from "../../shared/conversation/index.js";
import type { AuthorizationMode, PermissionConfirmation, PermissionPreset, WorkspaceAccessMode } from "../../types.js";
import {
  permissionPresetForWorkspaceAccessMode,
  workspaceAccessModeForPermissionPreset,
} from "../../lib/session-permissions.js";

type SlashCommand = { readonly id: string; readonly label: string };

export interface TeammatePrivateComposerController {
  readonly composerInputRef: React.RefObject<TokenizedComposerInputHandle | null>;
  readonly selectedAuthorizationMode: AuthorizationMode;
  readonly selectedPermissionPreset: PermissionPreset;
  readonly slashActiveIndex: number;
  readonly slashCommandPickerOptions: readonly SlashCommand[];
  readonly slashPicker?: ActiveSlashCommandPicker;
  readonly commitSlashCommand: (option: SlashCommand) => void;
  readonly handleComposerInputKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly handleComposerValueChange: (value: string, caret: number) => void;
  readonly handleAuthorizationModeChange: (mode: AuthorizationMode) => void;
  readonly handlePermissionPresetChange: (preset: PermissionPreset) => void;
  readonly submitComposer: () => void;
  readonly updateSlashPicker: (value: string, caret: number) => void;
}

export function useTeammatePrivateComposerController({
  identityKey,
  authorizationMode,
  messageDraft,
  onComposerKeyDown,
  onComposerSubmit,
  onFullAccessPresetSelected,
  onMessageDraftChange,
  onAuthorizationModeChange,
  onWorkspaceAccessModeChange,
  privateComposerSending,
  slashCommands,
  workspaceAccessMode,
}: {
  readonly identityKey: string;
  readonly authorizationMode: AuthorizationMode;
  readonly messageDraft: string;
  readonly onComposerKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
    authorization: {
      readonly authorizationMode: AuthorizationMode;
      readonly permissionPreset: PermissionPreset;
    },
  ) => void;
  readonly onComposerSubmit: (authorization: {
    readonly authorizationMode: AuthorizationMode;
    readonly permissionPreset: PermissionPreset;
  }) => void;
  readonly onFullAccessPresetSelected?: () => Promise<PermissionConfirmation | undefined>;
  readonly onMessageDraftChange: (value: string) => void;
  readonly onAuthorizationModeChange: (mode: AuthorizationMode) => void;
  readonly onWorkspaceAccessModeChange: (mode: WorkspaceAccessMode) => void;
  readonly privateComposerSending: boolean;
  readonly slashCommands: readonly SlashCommand[];
  readonly workspaceAccessMode: WorkspaceAccessMode;
}): TeammatePrivateComposerController {
  const [selectedAuthorizationMode, setSelectedAuthorizationMode] = useState<AuthorizationMode>(authorizationMode);
  const [selectedPermissionPreset, setSelectedPermissionPreset] = useState<PermissionPreset>(
    () => permissionPresetForWorkspaceAccessMode(workspaceAccessMode),
  );
  const [slashPicker, setSlashPicker] = useState<ActiveSlashCommandPicker>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const composerInputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const slashCommandPickerOptions = filterSlashCommandPickerOptions(slashCommands, slashPicker);

  useEffect(() => {
    setSelectedAuthorizationMode(authorizationMode);
  }, [authorizationMode]);

  useEffect(() => {
    setSelectedPermissionPreset(permissionPresetForWorkspaceAccessMode(workspaceAccessMode));
  }, [workspaceAccessMode]);

  useEffect(() => {
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
  }, [identityKey]);

  useEffect(() => {
    if (!privateComposerSending) return;
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
  }, [privateComposerSending]);

  function submitComposer(): void {
    onComposerSubmit({
      authorizationMode: selectedAuthorizationMode,
      permissionPreset: selectedPermissionPreset,
    });
  }

  function handleComposerInputKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (slashPicker && slashCommandPickerOptions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current + 1) % slashCommandPickerOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current - 1 + slashCommandPickerOptions.length) % slashCommandPickerOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        commitSlashCommand(slashCommandPickerOptions[Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashPicker(undefined);
        setSlashActiveIndex(0);
        return;
      }
    }
    onComposerKeyDown(event, {
      authorizationMode: selectedAuthorizationMode,
      permissionPreset: selectedPermissionPreset,
    });
  }

  function updateSlashPicker(value: string, caret: number): void {
    setSlashPicker(findActiveSlashCommand(value, caret));
    setSlashActiveIndex(0);
  }

  function commitSlashCommand(option: SlashCommand): void {
    const liveCaret = Math.min(
      composerInputRef.current?.readSelectionStart() ?? messageDraft.length,
      messageDraft.length,
    );
    const picker = slashPicker
      ?? findActiveSlashCommand(messageDraft, liveCaret)
      ?? findActiveSlashCommand(messageDraft, messageDraft.length);
    const inserted = insertSlashCommandToken(messageDraft, picker, option.id);
    onMessageDraftChange(inserted.value);
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    focusComposerAt(inserted.caret);
  }

  function handlePermissionPresetChange(preset: PermissionPreset): void {
    if (preset === "full_access" && onFullAccessPresetSelected) {
      void onFullAccessPresetSelected().then((confirmation) => {
        if (!confirmation) return;
        setSelectedPermissionPreset(preset);
        onWorkspaceAccessModeChange(workspaceAccessModeForPermissionPreset(preset));
      });
      return;
    }
    setSelectedPermissionPreset(preset);
    onWorkspaceAccessModeChange(workspaceAccessModeForPermissionPreset(preset));
  }

  function focusComposerAt(caret: number): void {
    const focus = (): void => composerInputRef.current?.focusAt(caret);
    focus();
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(focus);
    } else {
      globalThis.setTimeout(focus, 0);
    }
  }

  return {
    composerInputRef,
    selectedAuthorizationMode,
    selectedPermissionPreset,
    slashActiveIndex,
    slashCommandPickerOptions,
    slashPicker,
    commitSlashCommand,
    handleComposerInputKeyDown,
    handleComposerValueChange: (value, caret) => {
      onMessageDraftChange(value);
      updateSlashPicker(value, caret);
    },
    handleAuthorizationModeChange: (mode) => {
      setSelectedAuthorizationMode(mode);
      onAuthorizationModeChange(mode);
    },
    handlePermissionPresetChange,
    submitComposer,
    updateSlashPicker,
  };
}
