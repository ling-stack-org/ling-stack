import type { PropsWithChildren } from "react";
import { OverlayScrollArea } from "../../shared/ui/index.js";

export function SkillLibraryOverlayScrollArea({ children }: PropsWithChildren): JSX.Element {
  return (
    <OverlayScrollArea
      className="settings-skill-table-scroll-area"
      nativeScrollbarGutterProperty="--skill-library-native-scrollbar-gutter"
      scrollbarClassName="settings-skill-overlay-scrollbar"
      thumbClassName="settings-skill-overlay-scrollbar-thumb"
      viewportClassName="ling-ui-table-container settings-skill-table-wrap settings-skill-table-wrap--compact"
    >
      {children}
    </OverlayScrollArea>
  );
}
