import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { transcribeAudio } from "../../api/transcriptions.js";
import { useI18n } from "../../i18n.js";

type DictationState = "idle" | "recording" | "transcribing" | "error";

export function DesktopDictationButton({
  cwd,
  disabled = false,
  onInsertText,
}: {
  readonly cwd: string;
  readonly disabled?: boolean;
  readonly onInsertText: (text: string) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [state, setState] = useState<DictationState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelRef = useRef(false);
  const startPendingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const activeInputRef = useRef<"pointer" | "keyboard" | undefined>(undefined);

  const desktopHosted = typeof window !== "undefined" && Boolean(window.lingDesktop);
  const unavailable = disabled || !cwd.trim() || !desktopHosted;

  useEffect(() => {
    const handleWindowBlur = (): void => {
      if (activeInputRef.current || startPendingRef.current) {
        stopRecording(true);
      }
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      cancelRef.current = true;
      stopRequestedRef.current = true;
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  if (!desktopHosted) {
    return null;
  }

  async function startRecording(source: "pointer" | "keyboard"): Promise<void> {
    if (unavailable || recorderRef.current || startPendingRef.current || state === "transcribing") {
      return;
    }
    setErrorMessage("");
    setState("idle");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("error");
      setErrorMessage(t("This Desktop does not support microphone recording."));
      return;
    }
    startPendingRef.current = true;
    stopRequestedRef.current = false;
    cancelRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stopRequestedRef.current || cancelRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = supportedMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelRef.current = false;
      activeInputRef.current = source;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });
      recorder.addEventListener("stop", () => {
        void finishRecording(recorder.mimeType || mimeType || "audio/webm");
      }, { once: true });
      recorder.start();
      setState("recording");
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      activeInputRef.current = undefined;
      setState("error");
      setErrorMessage(readErrorMessage(error, t("Microphone permission was denied.")));
    } finally {
      startPendingRef.current = false;
    }
  }

  function stopRecording(cancel = false): void {
    const recorder = recorderRef.current;
    if (!recorder) {
      if (startPendingRef.current) {
        stopRequestedRef.current = true;
        cancelRef.current = cancel;
      }
      return;
    }
    cancelRef.current = cancel;
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  }

  async function finishRecording(mimeType: string): Promise<void> {
    const wasCancelled = cancelRef.current;
    cancelRef.current = false;
    const chunks = chunksRef.current;
    const stream = streamRef.current;
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
    activeInputRef.current = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    if (wasCancelled || chunks.length === 0) {
      setState("idle");
      return;
    }
    setState("transcribing");
    try {
      const audio = new Blob(chunks, { type: mimeType });
      const response = await transcribeAudio(cwd.trim(), audio, {
        filename: recordingFilename(mimeType),
      });
      onInsertText(response.text);
      setState("idle");
    } catch (error) {
      setState("error");
      setErrorMessage(readErrorMessage(error, t("Transcription failed. Try again.")));
    }
  }

  const label = state === "recording"
    ? t("Release to transcribe")
    : state === "transcribing"
      ? t("Transcribing")
      : state === "error"
        ? errorMessage || t("Transcription failed. Try again.")
        : t("Hold to transcribe");

  return (
    <button
      className={dictationButtonClass(state)}
      type="button"
      disabled={unavailable || state === "transcribing"}
      data-dictation-state={state}
      aria-label={label}
      aria-pressed={state === "recording"}
      title={label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        void startRecording("pointer");
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        stopRecording();
      }}
      onPointerCancel={(event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        stopRecording(true);
      }}
      onBlur={() => {
        if (activeInputRef.current === "pointer" || startPendingRef.current) {
          stopRecording(true);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && state === "recording") {
          event.preventDefault();
          stopRecording(true);
          return;
        }
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          void startRecording("keyboard");
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          stopRecording();
        }
      }}
    >
      {state === "transcribing" ? <Loader2 className="spin" size={16} /> : state === "recording" ? <Square size={15} /> : <Mic size={16} />}
    </button>
  );
}

function dictationButtonClass(state: DictationState): string {
  const classes = ["icon-button", "composer-tool-button", "desktop-dictation-button"];
  if (state === "recording") classes.push("recording");
  if (state === "error") classes.push("error");
  return classes.join(" ");
}

function supportedMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function recordingFilename(mimeType: string): string {
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
