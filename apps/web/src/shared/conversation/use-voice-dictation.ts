import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  reduceVoiceDictation,
  voiceRecognitionSupported,
  VOICE_DICTATION_ENGINE,
  type VoiceDictationError,
  type VoiceDictationSnapshot,
} from "./voice-dictation-machine.js";

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}

interface SpeechRecognitionErrorEventLike {
  readonly error?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function resolveRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const scope = globalThis as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  if (typeof scope.SpeechRecognition === "function") return scope.SpeechRecognition as SpeechRecognitionCtor;
  if (typeof scope.webkitSpeechRecognition === "function") return scope.webkitSpeechRecognition as SpeechRecognitionCtor;
  return undefined;
}

export interface VoiceDictationController {
  readonly engine: typeof VOICE_DICTATION_ENGINE;
  readonly supported: boolean;
  readonly status: VoiceDictationSnapshot["status"];
  readonly interim: string;
  readonly error?: VoiceDictationError;
  readonly toggle: () => void;
  readonly cancel: () => void;
}

/**
 * Web Speech API dictation controller. Text lands in the composer draft via
 * onTranscript and is never sent automatically. The recognizer instance is
 * created lazily on first use so no mic permission is touched on page load.
 */
export function useVoiceDictation(input: {
  readonly locale: string;
  readonly onTranscript: (text: string) => void;
}): VoiceDictationController {
  const { locale, onTranscript } = input;
  const [snapshot, setSnapshot] = useState<VoiceDictationSnapshot>({ status: "idle", interim: "" });
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalizeGuardRef = useRef(false);
  const supported = useMemo(() => voiceRecognitionSupported(globalThis as never), []);

  const stopRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      finalizeGuardRef.current = true;
      try {
        recognition.stop();
      } catch {
        // already stopped
      }
    }
  }, []);

  const cancel = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      finalizeGuardRef.current = true;
      try {
        recognition.abort();
      } catch {
        // already aborted
      }
    }
    recognitionRef.current = null;
    setSnapshot({ status: "idle", interim: "" });
  }, []);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    if (recognition) {
      finalizeGuardRef.current = true;
      try {
        recognition.abort();
      } catch {
        // page teardown
      }
    }
    recognitionRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    if (snapshot.status === "recording") {
      stopRecognition();
      return;
    }
    if (snapshot.status !== "idle") return;
    const Ctor = resolveRecognitionCtor();
    if (!Ctor) {
      setSnapshot({ status: "idle", interim: "", error: "unsupported" });
      return;
    }
    const recognition = new Ctor();
    recognition.lang = locale;
    recognition.continuous = true;
    recognition.interimResults = true;
    finalizeGuardRef.current = false;
    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (final.trim().length > 0) {
        onTranscript(final);
      }
      setSnapshot((previous) => (previous.status === "recording" ? { ...previous, interim } : previous));
    };
    recognition.onerror = (event) => {
      setSnapshot({ status: "idle", interim: "", error: reduceVoiceDictation({ status: "idle", interim: "" }, { type: "error", code: event.error }).error });
    };
    recognition.onend = () => {
      if (finalizeGuardRef.current) {
        finalizeGuardRef.current = false;
        recognitionRef.current = null;
        setSnapshot({ status: "idle", interim: "" });
        return;
      }
      // Engine stopped on its own (silence or engine cap): surface no_speech.
      recognitionRef.current = null;
      setSnapshot({ status: "idle", interim: "", error: "no_speech" });
    };
    recognitionRef.current = recognition;
    setSnapshot({ status: "recording", interim: "" });
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setSnapshot({ status: "idle", interim: "", error: "aborted" });
    }
  }, [locale, onTranscript, snapshot.status, stopRecognition]);

  return {
    engine: VOICE_DICTATION_ENGINE,
    supported,
    status: snapshot.status,
    interim: snapshot.interim,
    error: snapshot.error,
    toggle,
    cancel,
  };
}
