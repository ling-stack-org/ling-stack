import { useEffect, useRef, useState } from "react";

import { readConversationDraft, writeConversationDraft } from "../../../platform/remote-storage";

export function useConversationDraft(workspaceBindingId: string, conversationId: string) {
  const [draft, setDraftState] = useState("");
  const loadGeneration = useRef(0);
  const editGeneration = useRef(0);

  useEffect(() => {
    const requestGeneration = ++loadGeneration.current;
    const initialEditGeneration = editGeneration.current;
    setDraftState("");
    void readConversationDraft(workspaceBindingId, conversationId).then((value) => {
      if (
        requestGeneration !== loadGeneration.current
        || initialEditGeneration !== editGeneration.current
      ) {
        return;
      }
      setDraftState(value);
    });
  }, [workspaceBindingId, conversationId]);

  const setDraft = (value: string): void => {
    editGeneration.current += 1;
    setDraftState(value);
    void writeConversationDraft(workspaceBindingId, conversationId, value);
  };

  return { draft, setDraft };
}
