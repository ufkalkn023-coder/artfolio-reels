import { Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { secondsToFrames } from "./design";
import { type ReelData } from "./schema";

type Track = NonNullable<ReelData["music"]>;

export type AudioGainBounds = {
  absoluteFrame: number;
  compositionDurationInFrames: number;
  trackStartFrame: number;
  sourceDurationInFrames?: number;
  fadeInFrames: number;
  fadeOutFrames: number;
};

const assertWholeFrame = (value: number, label: string, allowZero = true): void => {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} whole frame`);
  }
};

const unit = (value: number): number => Math.max(0, Math.min(1, value));

/** Pure absolute-frame gain calculation, shared by rendering and regression tests. */
export const calculateAudioGain = ({
  absoluteFrame,
  compositionDurationInFrames,
  trackStartFrame,
  sourceDurationInFrames,
  fadeInFrames,
  fadeOutFrames,
}: AudioGainBounds): number => {
  assertWholeFrame(absoluteFrame, "absoluteFrame");
  assertWholeFrame(compositionDurationInFrames, "compositionDurationInFrames", false);
  assertWholeFrame(trackStartFrame, "trackStartFrame");
  assertWholeFrame(fadeInFrames, "fadeInFrames");
  assertWholeFrame(fadeOutFrames, "fadeOutFrames");
  if (sourceDurationInFrames !== undefined) assertWholeFrame(sourceDurationInFrames, "sourceDurationInFrames", false);
  if (trackStartFrame >= compositionDurationInFrames) throw new Error("trackStartFrame must be inside the composition");

  const trackEndFrame = Math.min(
    compositionDurationInFrames,
    sourceDurationInFrames === undefined ? compositionDurationInFrames : trackStartFrame + sourceDurationInFrames,
  );
  if (absoluteFrame < trackStartFrame || absoluteFrame >= trackEndFrame) return 0;

  const localFrame = absoluteFrame - trackStartFrame;
  const lastTrackFrame = trackEndFrame - 1;
  const fadeIn = fadeInFrames > 0 ? unit(localFrame / Math.max(1, fadeInFrames - 1)) : 1;
  const fadeOut = fadeOutFrames > 0
    ? unit((lastTrackFrame - absoluteFrame) / Math.max(1, fadeOutFrames - 1))
    : 1;
  return Math.min(fadeIn, fadeOut);
};

const FadingTrack: React.FC<{ track: Track; trackStartFrame: number }> = ({ track, trackStartFrame }) => {
  const localFrame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const source = track.src.startsWith("http") || track.src.startsWith("/") ? track.src : staticFile(track.src);
  const fadeInFrames = secondsToFrames(track.fadeIn ?? 0);
  const fadeOutFrames = secondsToFrames(track.fadeOut ?? 0);
  const gain = calculateAudioGain({
    absoluteFrame: localFrame + trackStartFrame,
    compositionDurationInFrames: durationInFrames,
    trackStartFrame,
    sourceDurationInFrames: track.durationSeconds === undefined ? undefined : secondsToFrames(track.durationSeconds),
    fadeInFrames,
    fadeOutFrames,
  });
  return <Audio src={source} volume={track.volume * gain} />;
};

export const AudioSystem: React.FC<Pick<ReelData, "music" | "voiceover">> = ({ music, voiceover }) => {
  const { durationInFrames } = useVideoConfig();
  const trackStartFrame = music ? secondsToFrames(music.start) : 0;
  if (music && trackStartFrame >= durationInFrames) {
    throw new Error("music.start must be inside the Reel duration");
  }
  return (
    <>
      {music ? <Sequence from={trackStartFrame} layout="none"><FadingTrack track={music} trackStartFrame={trackStartFrame} /></Sequence> : null}
      {voiceover ? <Audio src={voiceover.src.startsWith("http") || voiceover.src.startsWith("/") ? voiceover.src : staticFile(voiceover.src)} volume={voiceover.volume} /> : null}
    </>
  );
};
