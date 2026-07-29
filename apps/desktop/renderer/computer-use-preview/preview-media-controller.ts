import type {
  ComputerUsePreviewReleaseMediaRequest,
  ComputerUsePreviewReleaseMediaResult,
  ComputerUsePipRendererSnapshot,
  LingComputerUsePreviewCapabilities,
} from "../../shared/desktop-capabilities.js";

interface StoppedTrackBatch {
  readonly tracks: readonly MediaStreamTrack[];
  readonly releasedTracks: readonly MediaStreamTrack[];
}

interface MediaAcquisitionSettlement {
  readonly stream?: MediaStream;
  readonly stoppedTracks: StoppedTrackBatch;
  readonly error?: unknown;
}

interface PendingMediaAcquisition {
  readonly mediaKey: string;
  readonly generation: number;
  readonly completion: Promise<MediaAcquisitionSettlement>;
}

interface MediaReleaseRecord {
  readonly mediaKey: string;
  readonly generationBoundary: number;
  readonly completion: Promise<ComputerUsePreviewReleaseMediaResult>;
}

export interface ComputerUsePreviewMediaController {
  dispose(): void;
  releaseMediaForRequest(
    request: ComputerUsePreviewReleaseMediaRequest,
  ): Promise<ComputerUsePreviewReleaseMediaResult>;
  setVideoElement(video: HTMLVideoElement | undefined): void;
  sync(snapshot: ComputerUsePipRendererSnapshot): Promise<void>;
}

export function createComputerUsePreviewMediaController(input: {
  readonly getCapabilities: () => LingComputerUsePreviewCapabilities | undefined;
}): ComputerUsePreviewMediaController {
  let currentMediaKey: string | undefined;
  let currentStream: MediaStream | undefined;
  let videoElement: HTMLVideoElement | undefined;
  let mediaRequestGeneration = 0;
  let lastFrameActivityReportAt = 0;
  const pendingMediaAcquisitions = new Map<number, PendingMediaAcquisition>();
  const mediaReleaseRecords = new Map<string, MediaReleaseRecord>();
  const capabilities = (): LingComputerUsePreviewCapabilities | undefined => input.getCapabilities();

  const setVideoElement = (video: HTMLVideoElement | undefined): void => {
    videoElement = video;
    attachCurrentStream();
  };

  const sync = async (snapshot: ComputerUsePipRendererSnapshot): Promise<void> => {
    const mediaKey = mediaKeyFor(snapshot);
    if (
      snapshot.sourceKind === "display_media" &&
      snapshot.sourceStatus !== "connecting" &&
      snapshot.sourceStatus !== "live" &&
      snapshot.sourceStatus !== "stalled"
    ) {
      invalidateCurrentMedia();
      return;
    }
    if (currentMediaKey === mediaKey) {
      if (currentStream) {
        attachCurrentStream();
      }
      return;
    }
    invalidateCurrentMedia();
    currentMediaKey = mediaKey;
    const requestGeneration = mediaRequestGeneration;
    if (snapshot.sourceKind === "fake") {
      const { sessionId, sourceRevision, sourceGeneration } = snapshot;
      window.setTimeout(() => capabilities()?.reportFrameReady(
        sessionId,
        sourceRevision,
        sourceGeneration,
      ), 0);
      return;
    }

    const { sessionId, sourceRevision, sourceGeneration } = snapshot;
    const pendingAcquisition = beginMediaAcquisition(mediaKey, requestGeneration);
    pendingMediaAcquisitions.set(requestGeneration, pendingAcquisition);
    let settlement: MediaAcquisitionSettlement;
    try {
      settlement = await pendingAcquisition.completion;
    } finally {
      if (pendingMediaAcquisitions.get(requestGeneration) === pendingAcquisition) {
        pendingMediaAcquisitions.delete(requestGeneration);
      }
    }
    if (settlement.error !== undefined) {
      if (!isCurrentMediaIdentity(mediaKey, requestGeneration)) {
        return;
      }
      invalidateCurrentMedia();
      capabilities()?.reportSourceFailure(
        sessionId,
        sourceRevision,
        sourceGeneration,
        settlement.error instanceof Error ? settlement.error.message : String(settlement.error),
      );
      return;
    }
    const stream = settlement.stream;
    if (!stream || !isCurrentMediaIdentity(mediaKey, requestGeneration) || currentStream !== stream) {
      if (stream) {
        stopMediaStream(stream);
      }
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!isCurrentMediaIdentity(mediaKey, requestGeneration) || currentStream !== stream) {
      stopMediaStream(stream);
      return;
    }
    const video = videoElement;
    if (!video) {
      invalidateCurrentMedia();
      return;
    }
    attachCurrentStream();
    track?.addEventListener("ended", () => {
      if (isCurrentMediaIdentity(mediaKey, requestGeneration) && currentStream === stream) {
        capabilities()?.reportSourceEnded(
          sessionId,
          sourceRevision,
          sourceGeneration,
          "capture_track_ended",
        );
      }
    }, { once: true });
    let frameReported = false;
    const reportFrameReady = (): void => {
      if (
        frameReported ||
        !isCurrentMediaIdentity(mediaKey, requestGeneration) ||
        currentStream !== stream ||
        track?.readyState === "ended" ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }
      frameReported = true;
      capabilities()?.reportFrameReady(sessionId, sourceRevision, sourceGeneration);
    };
    video.addEventListener("loadeddata", reportFrameReady, { once: true });
    const videoWithFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
    };
    const requestFrameCallback = videoWithFrameCallback.requestVideoFrameCallback?.bind(videoWithFrameCallback);
    if (requestFrameCallback) {
      const reportVideoFrame = (now: number): void => {
        if (
          !isCurrentMediaIdentity(mediaKey, requestGeneration) ||
          currentStream !== stream ||
          track?.readyState === "ended"
        ) {
          return;
        }
        reportFrameReady();
        if (now - lastFrameActivityReportAt >= 250) {
          lastFrameActivityReportAt = now;
          capabilities()?.reportFrameActivity(sessionId, sourceRevision, sourceGeneration);
        }
        requestFrameCallback(reportVideoFrame);
      };
      requestFrameCallback(reportVideoFrame);
    } else {
      video.addEventListener("timeupdate", () => {
        if (isCurrentMediaIdentity(mediaKey, requestGeneration) && currentStream === stream) {
          capabilities()?.reportFrameActivity(sessionId, sourceRevision, sourceGeneration);
        }
      });
    }
    const pollDecodedFrame = (): void => {
      if (
        frameReported ||
        !isCurrentMediaIdentity(mediaKey, requestGeneration) ||
        currentStream !== stream ||
        track?.readyState === "ended"
      ) {
        return;
      }
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        reportFrameReady();
        return;
      }
      window.setTimeout(pollDecodedFrame, 16);
    };
    window.setTimeout(pollDecodedFrame, 0);
    try {
      await video.play();
    } catch (error) {
      if (!isCurrentMediaIdentity(mediaKey, requestGeneration) || currentStream !== stream) {
        return;
      }
      invalidateCurrentMedia();
      capabilities()?.reportSourceFailure(
        sessionId,
        sourceRevision,
        sourceGeneration,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      reportFrameReady();
    }
  };

  const beginMediaAcquisition = (mediaKey: string, generation: number): PendingMediaAcquisition => {
    const completion = (async (): Promise<MediaAcquisitionSettlement> => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: {
            frameRate: { ideal: 30, max: 30 },
            width: { ideal: 960, max: 960 },
            height: { ideal: 600, max: 600 },
          },
        });
        if (!isCurrentMediaIdentity(mediaKey, generation)) {
          return { stoppedTracks: stopMediaStream(stream) };
        }
        currentStream = stream;
        return { stream, stoppedTracks: emptyStoppedTrackBatch() };
      } catch (error) {
        return { stoppedTracks: emptyStoppedTrackBatch(), error };
      }
    })();
    return { mediaKey, generation, completion };
  };

  const releaseMediaForRequest = async (
    request: ComputerUsePreviewReleaseMediaRequest,
  ): Promise<ComputerUsePreviewReleaseMediaResult> => {
    const requestedMediaKey = `${request.sessionId}:${request.sourceRevision}:${request.sourceGeneration}:display_media`;
    if (currentMediaKey && currentMediaKey !== requestedMediaKey) {
      return identityMismatchReleaseResult();
    }
    if (currentMediaKey === requestedMediaKey) {
      const release = invalidateCurrentMedia();
      if (release) {
        return release.completion;
      }
    }
    const existingRelease = mediaReleaseRecords.get(requestedMediaKey);
    return existingRelease ? existingRelease.completion : identityMismatchReleaseResult();
  };

  const invalidateCurrentMedia = (): MediaReleaseRecord | undefined => {
    const mediaKey = currentMediaKey;
    if (!mediaKey) {
      if (currentStream) {
        mediaRequestGeneration += 1;
        stopMediaStream(currentStream);
      }
      currentStream = undefined;
      clearAttachedVideo();
      lastFrameActivityReportAt = 0;
      return undefined;
    }
    const generationBoundary = mediaRequestGeneration;
    mediaRequestGeneration += 1;
    currentMediaKey = undefined;
    const stoppedCurrentTracks = currentStream
      ? stopMediaStream(currentStream)
      : emptyStoppedTrackBatch();
    currentStream = undefined;
    lastFrameActivityReportAt = 0;
    clearAttachedVideo();
    const pendingCompletions = [...pendingMediaAcquisitions.values()]
      .filter((pending) => pending.generation <= generationBoundary)
      .map((pending) => pending.completion);
    const completion = Promise.all(pendingCompletions).then((settlements) => releaseResultForTracks([
      stoppedCurrentTracks,
      ...settlements.map((settlement) => settlement.stoppedTracks),
    ]));
    const release = { mediaKey, generationBoundary, completion };
    rememberMediaRelease(release);
    return release;
  };

  const rememberMediaRelease = (release: MediaReleaseRecord): void => {
    mediaReleaseRecords.delete(release.mediaKey);
    mediaReleaseRecords.set(release.mediaKey, release);
    while (mediaReleaseRecords.size > 8) {
      const oldestKey = mediaReleaseRecords.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }
      mediaReleaseRecords.delete(oldestKey);
    }
  };

  const releaseResultForTracks = (
    batches: readonly StoppedTrackBatch[],
  ): ComputerUsePreviewReleaseMediaResult => {
    const tracks = new Set<MediaStreamTrack>();
    const releasedTracks = new Set<MediaStreamTrack>();
    for (const batch of batches) {
      batch.tracks.forEach((track) => tracks.add(track));
      batch.releasedTracks.forEach((track) => releasedTracks.add(track));
    }
    return {
      status: releasedTracks.size > 0 ? "released" : "already_released",
      releasedTrackCount: releasedTracks.size,
      allTracksEnded: [...tracks].every((track) => track.readyState === "ended"),
    };
  };

  const identityMismatchReleaseResult = (): ComputerUsePreviewReleaseMediaResult => ({
    status: "identity_mismatch",
    releasedTrackCount: 0,
    allTracksEnded: false,
  });

  const stopMediaStream = (stream: MediaStream): StoppedTrackBatch => stopMediaTracks(stream.getTracks());

  const stopMediaTracks = (tracks: readonly MediaStreamTrack[]): StoppedTrackBatch => {
    const releasedTracks: MediaStreamTrack[] = [];
    for (const track of tracks) {
      if (isMediaTrackEnded(track)) {
        continue;
      }
      try {
        track.stop();
      } catch {
        // A non-ended track produces a negative ACK and main destroys the window.
      }
      if (isMediaTrackEnded(track)) {
        releasedTracks.push(track);
      }
    }
    return { tracks: [...tracks], releasedTracks };
  };

  const emptyStoppedTrackBatch = (): StoppedTrackBatch => ({ tracks: [], releasedTracks: [] });

  const clearAttachedVideo = (): void => {
    if (videoElement) {
      videoElement.srcObject = null;
    }
  };

  const isCurrentMediaIdentity = (mediaKey: string, generation: number): boolean => {
    return currentMediaKey === mediaKey && mediaRequestGeneration === generation;
  };

  function attachCurrentStream(): void {
    if (!videoElement || !currentStream || videoElement.srcObject === currentStream) {
      return;
    }
    videoElement.srcObject = currentStream;
    void videoElement.play().catch(() => undefined);
  }

  return {
    dispose: () => {
      invalidateCurrentMedia();
      videoElement = undefined;
    },
    releaseMediaForRequest,
    setVideoElement,
    sync,
  };
}

function mediaKeyFor(value: ComputerUsePipRendererSnapshot): string {
  return `${value.sessionId}:${value.sourceRevision}:${value.sourceGeneration}:${value.sourceKind}`;
}

function isMediaTrackEnded(track: MediaStreamTrack): boolean {
  return track.readyState === "ended";
}
