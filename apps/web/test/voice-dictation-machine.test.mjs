import assert from "node:assert/strict";
import test from "node:test";
import {
  appendDictation,
  mapRecognitionErrorCode,
  reduceVoiceDictation,
  voiceErrorMessage,
  voiceRecognitionSupported,
} from "../src/shared/conversation/voice-dictation-machine.ts";

test("voice support probe accepts either global binding", () => {
  assert.equal(voiceRecognitionSupported({ SpeechRecognition: function X() {} }), true);
  assert.equal(voiceRecognitionSupported({ webkitSpeechRecognition: function X() {} }), true);
  assert.equal(voiceRecognitionSupported({}), false);
});

test("dictation appends to the draft without auto-send semantics", () => {
  assert.equal(appendDictation("", "hello world"), "hello world");
  assert.equal(appendDictation("existing", "hello"), "existing hello");
  assert.equal(appendDictation("keep", "   "), "keep");
});

test("recognition error codes map to the closed taxonomy", () => {
  assert.equal(mapRecognitionErrorCode("not-allowed"), "denied");
  assert.equal(mapRecognitionErrorCode("service-not-allowed"), "denied");
  assert.equal(mapRecognitionErrorCode("no-speech"), "no_speech");
  assert.equal(mapRecognitionErrorCode("aborted"), "aborted");
  assert.equal(mapRecognitionErrorCode("network"), "network");
  assert.equal(mapRecognitionErrorCode("audio-capture"), "unsupported");
  assert.equal(mapRecognitionErrorCode(undefined), "unsupported");
});

test("state machine tracks recording, interim, stop and reset", () => {
  let state = reduceVoiceDictation({ status: "idle", interim: "" }, { type: "start" });
  assert.equal(state.status, "recording");
  state = reduceVoiceDictation(state, { type: "interim", text: "hel" });
  assert.equal(state.interim, "hel");
  state = reduceVoiceDictation(state, { type: "final", text: "hello" });
  assert.equal(state.interim, "");
  state = reduceVoiceDictation(state, { type: "stop" });
  assert.equal(state.status, "finalizing");
  state = reduceVoiceDictation(state, { type: "reset" });
  assert.deepEqual(state, { status: "idle", interim: "" });
});

test("state machine maps errors to taxonomy and ignores stray interim when idle", () => {
  const errored = reduceVoiceDictation({ status: "recording", interim: "x" }, { type: "error", code: "not-allowed" });
  assert.equal(errored.status, "idle");
  assert.equal(errored.error, "denied");
  const idle = reduceVoiceDictation({ status: "idle", interim: "" }, { type: "interim", text: "y" });
  assert.equal(idle.interim, "");
});

test("every taxonomy member has recovery copy", () => {
  const t = (key) => key;
  for (const error of ["denied", "no_speech", "aborted", "network", "unsupported"]) {
    assert.equal(voiceErrorMessage(error, t).length > 0, true);
  }
});
