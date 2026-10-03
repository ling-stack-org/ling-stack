import { MediaLocalExecutionAdmissionError, type MediaLocalExecutionHandle,
  type MediaLocalExecutionRegistry } from "../../runtime/media-local-executions.js";
import { createHostMediaNativeTransport, type HostMediaNativeTransport } from "./native-http-transport.js";
import { getHostMediaOperation } from "./host-operation.js";

/** Shared actual sender for both model Media and Comfy workflow execution. */
export function createGuardedMediaHttpTransport(input: {
  readonly registry: MediaLocalExecutionRegistry;
  readonly execution: MediaLocalExecutionHandle;
  readonly captureAdmissionFailure: (error: MediaLocalExecutionAdmissionError) => void;
}): HostMediaNativeTransport {
  const host = getHostMediaOperation(input.execution);
  let native: HostMediaNativeTransport;
  native = createHostMediaNativeTransport({
    launch: (mode, request, send) => {
      if (!host || mode === "observation") input.registry.launchEffect(input.execution, mode, send);
      else {
        input.registry.assertEffectAllowed(input.execution, mode);
        try { host.launchNativeEffect(request, send); }
        catch (error) { throw new MediaLocalExecutionAdmissionError("host_effect_unconfirmed", message(error)); }
      }
    },
    onCompleted: exchange => {
      input.registry.assertCompletionAllowed(input.execution);
      try { host?.receiptProducer?.capture(native, exchange); }
      catch (error) { throw new MediaLocalExecutionAdmissionError("host_response_unconfirmed", message(error)); }
    },
  });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    try { return await native.fetch(url, init); }
    catch (error) {
      if (error instanceof MediaLocalExecutionAdmissionError) input.captureAdmissionFailure(error);
      throw error;
    }
  };
  return Object.freeze({
    fetch,
    readExchange: native.readExchange,
    readJson: native.readJson,
    assertExchange: native.assertExchange,
  });
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
