export interface PluginActionFenceInput {
  readonly pluginId: string;
  readonly action: string;
  readonly owner: string;
  readonly requestId: string;
}

export function pluginActionKey(
  action: Pick<PluginActionFenceInput, "pluginId" | "action" | "owner">,
): string {
  const family = action.owner === "computer-control" && isActivationFamilyAction(action.action)
    ? "activation"
    : action.action;
  return `${action.pluginId}:${family}:${action.owner}`;
}

export class PluginActionRequestFence {
  private readonly latest = new Map<string, string>();

  begin(action: PluginActionFenceInput): void {
    this.latest.set(pluginActionKey(action), action.requestId);
  }

  isLatest(action: PluginActionFenceInput): boolean {
    return this.latest.get(pluginActionKey(action)) === action.requestId;
  }

  finish(action: PluginActionFenceInput): void {
    if (this.isLatest(action)) this.latest.delete(pluginActionKey(action));
  }

  clear(): void {
    this.latest.clear();
  }
}

function isActivationFamilyAction(action: string): boolean {
  return action === "enable" || action === "disable" || action === "check";
}
