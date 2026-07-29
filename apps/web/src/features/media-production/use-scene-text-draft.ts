import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { MediaScene } from "../../types.js";
import type {
  MediaProductionActions,
  MediaProductionFailure,
  MediaProductionMutationOutcome,
} from "./media-production-types.js";

export type SceneTextField = "title" | "prompt";

interface SceneTextDraft {
  readonly title: string;
  readonly prompt: string;
}

interface PendingCommit {
  readonly value: string;
  readonly promise: Promise<MediaProductionMutationOutcome>;
}

export interface SceneTextDraftController {
  readonly draft: SceneTextDraft;
  readonly busyField?: SceneTextField;
  readonly failures: Partial<Record<SceneTextField, MediaProductionFailure>>;
  readonly promptRequired: boolean;
  readonly promptRef: RefObject<HTMLTextAreaElement>;
  readonly change: (field: SceneTextField, value: string) => void;
  readonly clear: (field: SceneTextField) => void;
  readonly commit: (field: SceneTextField, value?: string) => Promise<MediaProductionMutationOutcome>;
  readonly commitPromptForRun: () => Promise<boolean>;
  readonly retry: (field: SceneTextField, failure: MediaProductionFailure) => Promise<void>;
  readonly revert: (field: SceneTextField) => void;
}

export function useSceneTextDraft(
  scene: MediaScene,
  actions: MediaProductionActions,
): SceneTextDraftController {
  const [draft, setDraft] = useState<SceneTextDraft>(() => sceneDraft(scene));
  const [busyField, setBusyField] = useState<SceneTextField>();
  const [failures, setFailures] = useState<Partial<Record<SceneTextField, MediaProductionFailure>>>({});
  const [promptRequired, setPromptRequired] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const targetRef = useRef(scene.id);
  const authorityRef = useRef(sceneDraft(scene));
  const pendingRef = useRef(new Map<string, PendingCommit>());

  useEffect(() => () => {
    targetRef.current = "";
  }, []);

  useEffect(() => {
    const previous = authorityRef.current;
    targetRef.current = scene.id;
    setDraft((current) => {
      const next = {
        title: current.title === previous.title ? scene.title : current.title,
        prompt: current.prompt === previous.prompt ? scene.prompt : current.prompt,
      };
      draftRef.current = next;
      return next;
    });
    authorityRef.current = sceneDraft(scene);
  }, [scene.id, scene.prompt, scene.title]);

  const clear = useCallback((field: SceneTextField): void => {
    setFailures((current) => omitField(current, field));
    if (field === "prompt") setPromptRequired(false);
    actions.clearFailure("scene-update", scene.id);
  }, [actions, scene.id]);

  const change = useCallback((field: SceneTextField, value: string): void => {
    const next = { ...draftRef.current, [field]: value };
    draftRef.current = next;
    setDraft(next);
    clear(field);
  }, [clear]);

  const commit = useCallback(async (
    field: SceneTextField,
    value = draftRef.current[field],
  ): Promise<MediaProductionMutationOutcome> => {
    const sceneId = scene.id;
    const key = `${sceneId}:${field}`;
    const pending = pendingRef.current.get(key);
    if (pending?.value === value) return await pending.promise;
    if (pending) {
      const previous = await pending.promise;
      if (!previous.ok) return previous;
    }
    if (value === authorityRef.current[field]) return succeededOutcome();

    setBusyField(field);
    clear(field);
    const promise = actions.updateScene(sceneId, { [field]: value });
    pendingRef.current.set(key, { value, promise });
    const outcome = await promise;
    if (targetRef.current === sceneId) {
      setFailures((current) => outcome.ok ? omitField(current, field) : { ...current, [field]: outcome.failure });
      setBusyField(undefined);
    }
    if (pendingRef.current.get(key)?.promise === promise) pendingRef.current.delete(key);
    return outcome;
  }, [actions, clear, scene.id]);

  const commitPromptForRun = useCallback(async (): Promise<boolean> => {
    const prompt = draftRef.current.prompt;
    if (!prompt.trim()) {
      setPromptRequired(true);
      promptRef.current?.focus();
      return false;
    }
    setPromptRequired(false);
    return (await commit("prompt", prompt)).ok;
  }, [commit]);

  const retry = useCallback(async (field: SceneTextField, failure: MediaProductionFailure): Promise<void> => {
    if (busyField === field) return;
    const sceneId = scene.id;
    setBusyField(field);
    const outcome = await actions.retryFailure(failure);
    if (targetRef.current === sceneId) {
      setFailures((current) => outcome.ok ? omitField(current, field) : { ...current, [field]: outcome.failure });
      setBusyField(undefined);
    }
  }, [actions, busyField, scene.id]);

  const revert = useCallback((field: SceneTextField): void => {
    change(field, authorityRef.current[field]);
  }, [change]);

  return {
    draft,
    busyField,
    failures,
    promptRequired,
    promptRef,
    change,
    clear,
    commit,
    commitPromptForRun,
    retry,
    revert,
  };
}

function sceneDraft(scene: MediaScene): SceneTextDraft {
  return { title: scene.title, prompt: scene.prompt };
}

function succeededOutcome(): MediaProductionMutationOutcome {
  return { ok: true, value: undefined };
}

function omitField<T>(value: T, field: keyof T): T {
  const next = { ...value };
  delete next[field];
  return next;
}
