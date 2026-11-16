export interface LockedUseToolCall {
  readonly toolName: string;
  readonly arguments?: unknown;
}
export interface LockedUseActionTarget {
  readonly toolName: string;
  readonly processID?: number;
  readonly windowID?: number;
}

const metadata = new Set(["check_permissions", "health_report", "get_screen_size",
  "get_cursor_position", "get_accessibility_tree", "list_apps", "start_session", "end_session"]);
const targeted = new Set(["bring_to_front", "click", "double_click",
  "get_window_state", "hotkey", "list_windows", "page", "press_key", "right_click",
  "scroll", "set_value", "type_text"]);

/** Keep arguments and user content out of the privileged protocol. */
export function describeLockedUseAction(call: LockedUseToolCall): LockedUseActionTarget {
  const args = call.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("locked_control_secure_surface");
  const value = args as Readonly<Record<string, unknown>>;
  if (value.foreground !== undefined && value.foreground !== false
    || value.delivery_mode !== undefined && value.delivery_mode !== "background"
    || value.scope !== undefined && value.scope !== "window"
    || value.capture_scope !== undefined && value.capture_scope !== "window"
    // Opaque handles and CDP routing can select a different window than the
    // explicit target verified by the native gate.
    || value.element_token !== undefined || value.cdp_port !== undefined
    || value.target_url_contains !== undefined) throw new Error("locked_control_secure_surface");
  const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number"
    && Number.isSafeInteger(value) && value >= min && value <= max;
  if (metadata.has(call.toolName)) {
    if (value.pid !== undefined || value.window_id !== undefined) throw new Error("locked_control_secure_surface");
    return { toolName: call.toolName };
  }
  if (!targeted.has(call.toolName) || !integer(value.pid, 2, 2_147_483_647)
    || call.toolName === "get_window_state" && value.window_id === undefined
    || value.window_id !== undefined && !integer(value.window_id, 1, 4_294_967_295)) throw new Error("locked_control_secure_surface");
  return { toolName: call.toolName, processID: value.pid, ...(value.window_id !== undefined ? { windowID: value.window_id as number } : {}) };
}
