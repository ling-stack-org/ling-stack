import { useEffect, useRef } from "react";
import type { AuthorizationMode, PermissionConfirmation, WorkspaceAccessMode } from "../../types.js";

export interface CompactPermissionSelection {
  readonly authorizationMode: AuthorizationMode;
  readonly workspaceAccessMode: WorkspaceAccessMode;
}

interface PermissionSelectionInput extends CompactPermissionSelection {
  readonly ownerKey: string;
  readonly defaultWorkspaceAccessMode: WorkspaceAccessMode;
  readonly disabled: boolean;
  readonly confirmFullAccess?: () => Promise<PermissionConfirmation | undefined>;
  readonly onChange: (selection: CompactPermissionSelection) => void;
  readonly onError: (error: unknown) => void;
}

// The surface owns the permission state; this controller only sequences explicit
// selections. A dialog result is not permission to modify a replacement owner.
export class ConversationPermissionSelectionController {
  private input: PermissionSelectionInput;
  private revision = 0;
  private active = true;
  private beforeFullAccess: WorkspaceAccessMode | undefined;

  constructor(input: PermissionSelectionInput) { this.input = input; }

  update(input: PermissionSelectionInput): void {
    const previous = this.input;
    if (previous.ownerKey !== input.ownerKey) this.beforeFullAccess = undefined;
    if (previous.ownerKey !== input.ownerKey || previous.authorizationMode !== input.authorizationMode
      || previous.workspaceAccessMode !== input.workspaceAccessMode || previous.disabled !== input.disabled
      || previous.defaultWorkspaceAccessMode !== input.defaultWorkspaceAccessMode) this.revision++;
    this.input = input;
  }

  attach(): void { this.active = true; }
  detach(): void { this.active = false; this.revision++; }

  async select(mode: AuthorizationMode): Promise<void> {
    const input = this.input;
    if (!this.active || input.disabled) return;
    const revision = ++this.revision;
    if (mode !== "always") {
      const workspaceAccessMode = input.authorizationMode === "always" && input.workspaceAccessMode === "full_access"
        ? this.beforeFullAccess ?? input.defaultWorkspaceAccessMode : input.workspaceAccessMode;
      this.beforeFullAccess = undefined;
      input.onChange({ authorizationMode: mode, workspaceAccessMode });
      return;
    }
    try {
      if (!input.confirmFullAccess) throw new Error("Use full access for this conversation after explicit confirmation.");
      const confirmation = await input.confirmFullAccess();
      if (!confirmation || !this.active || revision !== this.revision) return;
      if (input.authorizationMode !== "always" || input.workspaceAccessMode !== "full_access") {
        this.beforeFullAccess = input.workspaceAccessMode;
      }
      input.onChange({ authorizationMode: "always", workspaceAccessMode: "full_access" });
    } catch (error) {
      if (this.active && revision === this.revision) this.input.onError(error);
    }
  }
}

export function useConversationPermissionSelection(input: PermissionSelectionInput): (mode: AuthorizationMode) => void {
  const controllerRef = useRef<ConversationPermissionSelectionController | null>(null);
  if (!controllerRef.current) controllerRef.current = new ConversationPermissionSelectionController(input);
  const controller = controllerRef.current;
  controller.update(input);
  useEffect(() => { controller.attach(); return () => controller.detach(); }, [controller]);
  return (mode) => { void controller.select(mode); };
}
