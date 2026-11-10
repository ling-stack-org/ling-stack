const locatePulseClassName = "conversation-timeline-locate-pulse";

export function revealConversationTarget(target: HTMLElement): void {
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  target.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
  target.classList.remove(locatePulseClassName);
  if (reducedMotion) {
    return;
  }

  // Restart the pulse when the same result is located twice in quick succession.
  void target.offsetWidth;
  target.classList.add(locatePulseClassName);
  const clearPulse = (event: AnimationEvent): void => {
    if (event.animationName !== "conversation-locate-pulse") {
      return;
    }
    target.classList.remove(locatePulseClassName);
    target.removeEventListener("animationend", clearPulse);
    target.removeEventListener("animationcancel", clearPulse);
  };
  target.addEventListener("animationend", clearPulse);
  target.addEventListener("animationcancel", clearPulse);
}
