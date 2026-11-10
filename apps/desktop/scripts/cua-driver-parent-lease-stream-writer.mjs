/**
 * Own stdin error handling for one native parent-lease holder. Authority and
 * holder termination remain with the caller; a failed frame cannot settle
 * until that caller's invalidation/drain promise has completed.
 */
export function createNativeParentLeaseStreamWriter({ stream, createFailure, onFailure }) {
  const pending = new Set();
  let failure;
  let failureDrain;
  let closed = stream.closed === true;

  const cleanup = () => {
    stream.off("error", onError);
    stream.off("close", onClose);
  };
  const rejectAfterDrain = (request) => {
    void failureDrain.then(() => request.reject(failure));
  };
  const fail = (cause) => {
    if (failure !== undefined) return failure;
    failure = createFailure(cause);
    // Invoke synchronously so capability invalidation precedes any later
    // callback or queued write. Keep this stream's error sink through close:
    // Writable calls callback(error) before it emits its error event.
    try {
      failureDrain = Promise.resolve(onFailure(failure));
    } catch (invalidationError) {
      failureDrain = Promise.reject(invalidationError);
    }
    failureDrain = failureDrain.catch((invalidationError) => {
      if (Object.isExtensible(failure)) {
        Object.defineProperty(failure, "invalidationError", {
          configurable: true,
          value: invalidationError,
        });
      }
    });
    for (const request of pending) rejectAfterDrain(request);
    return failure;
  };
  const onError = (cause) => { fail(cause); };
  const onClose = () => {
    closed = true;
    if (pending.size > 0) fail(prematureCloseError());
    cleanup();
  };
  if (!closed) {
    stream.on("error", onError);
    stream.once("close", onClose);
  }

  return Object.freeze({
    write: (frame, { end = false } = {}) => new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        pending.delete(request);
        callback(value);
      };
      const request = {
        reject: error => settle(reject, error),
        resolve: () => settle(resolve),
      };
      pending.add(request);
      if (failure !== undefined) {
        rejectAfterDrain(request);
        return;
      }
      if (closed || stream.destroyed) {
        fail(stream.errored ?? prematureCloseError());
        return;
      }
      const complete = (cause) => {
        if (cause !== undefined && cause !== null) {
          fail(cause);
        } else if (failure !== undefined) {
          rejectAfterDrain(request);
        } else {
          request.resolve();
        }
      };
      try {
        if (end) stream.end(frame, complete);
        else stream.write(frame, complete);
      } catch (cause) {
        fail(cause);
      }
    }),
    // Call only after the owned holder has terminated. Do not remove the error
    // listener on child 'exit': its stdin may still deliver error/close later.
    disposeAfterTermination: () => {
      if (closed) cleanup();
      else if (!stream.destroyed) stream.destroy();
    },
  });
}

function prematureCloseError() {
  return Object.assign(new Error("native parent lease stdin closed before frame completion"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
}
