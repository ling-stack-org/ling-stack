export interface DesktopOwnerWindow {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
}

export async function openDesktopOwnerWindow(input: {
  readonly openMainWindow: () => Promise<boolean>;
  readonly getMainWindow: () => DesktopOwnerWindow | undefined;
}): Promise<boolean> {
  if (!await input.openMainWindow()) {
    return false;
  }
  const window = input.getMainWindow();
  if (!window || window.isDestroyed()) {
    return false;
  }
  try {
    window.show();
    window.focus();
    return true;
  } catch {
    return false;
  }
}
