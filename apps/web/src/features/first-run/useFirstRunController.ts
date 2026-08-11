import { useEffect, useMemo, useRef, useState } from "react";
import {
  readFirstRunPreference,
  writeFirstRunPreference,
  type FirstRunPreferenceV1,
} from "./first-run-storage.js";
import {
  firstRunReady,
  initialFirstRunStep,
  type FirstRunReadiness,
  type FirstRunStepId,
} from "./first-run-view-models.js";

export interface FirstRunController {
  readonly open: boolean;
  readonly readiness: FirstRunReadiness;
  readonly step: FirstRunStepId;
  readonly complete: () => void;
  readonly next: () => void;
  readonly openModelWorkbench: () => void;
  readonly recheck: () => void;
  readonly skip: () => void;
}

export function useFirstRunController(input: {
  readonly daemonHealthy: boolean | undefined;
  readonly hasReadyProvider: boolean;
  readonly providersLoaded: boolean;
  readonly workspaceCwd: string;
  readonly onOpenModelWorkbench: () => void;
}): FirstRunController {
  const readiness = useMemo<FirstRunReadiness>(() => ({
    daemonReady: input.daemonHealthy === true,
    hasReadyProvider: input.hasReadyProvider,
    workspaceReady: Boolean(input.workspaceCwd.trim()),
  }), [input.daemonHealthy, input.hasReadyProvider, input.workspaceCwd]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<FirstRunStepId>("workspace");
  const sessionPreferenceRef = useRef<FirstRunPreferenceV1 | undefined>(undefined);

  useEffect(() => {
    if (input.daemonHealthy === undefined || !input.providersLoaded) return;
    const preference = sessionPreferenceRef.current ?? readFirstRunPreference();
    if (preference) {
      sessionPreferenceRef.current = preference;
      setOpen(false);
      return;
    }
    if (firstRunReady(readiness)) {
      sessionPreferenceRef.current = writeFirstRunPreference("completed", input.workspaceCwd);
      setOpen(false);
      return;
    }
    setStep(initialFirstRunStep(readiness));
    setOpen(true);
  }, [input.daemonHealthy, input.providersLoaded, input.workspaceCwd, readiness]);

  const remember = (status: FirstRunPreferenceV1["status"]): void => {
    sessionPreferenceRef.current = writeFirstRunPreference(status, input.workspaceCwd);
    setOpen(false);
  };

  return {
    open,
    readiness,
    step,
    complete: () => remember(firstRunReady(readiness) ? "completed" : "skipped"),
    next: () => setStep(step === "workspace" ? "model" : "check"),
    openModelWorkbench: () => {
      remember("skipped");
      input.onOpenModelWorkbench();
    },
    recheck: () => setStep(initialFirstRunStep(readiness)),
    skip: () => remember("skipped"),
  };
}
