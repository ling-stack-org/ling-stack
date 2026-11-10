import { useEffect, useState } from "react";
import type { ConversationExecutionSelectionQuery, ConversationExecutionSelectionResponse } from "@ling-stack/contracts";
import { getConversationExecutionSelection } from "../../api/runtime.js";
import { projectNativeConversationSelection } from "./native-conversation-selection.js";

export function useNativeConversationSelection(cwd: string, query: ConversationExecutionSelectionQuery, blockedLabel: string, revision?: string) {
  const key = JSON.stringify({ cwd, query, revision });
  const [state, setState] = useState<{ key: string; selection?: ConversationExecutionSelectionResponse; error?: boolean }>();
  useEffect(() => {
    if (!cwd) return;
    let active = true, generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const selection = await getConversationExecutionSelection(cwd, query);
        if (selection.cwd !== cwd) throw new Error("workspace_mismatch");
        if (active && current === generation) setState({ key, selection });
      } catch { if (active && current === generation) setState({ key, error: true }); }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [key]);
  return projectNativeConversationSelection(state?.key === key ? state.selection : undefined,
    state?.key === key && state.error === true, blockedLabel);
}
