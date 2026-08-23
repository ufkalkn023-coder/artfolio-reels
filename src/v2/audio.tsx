import { Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { secondsToFrames } from "./design";
import { type ReelData } from "./schema";

type Track = NonNullable<ReelData["music"]>;

const FadingTrack: React.FC<{ track: Track }> = ({ track }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const source = track.src.startsWith("http") || track.src.startsWith("/") ? track.src : staticFile(track.src);
  const fadeInFrames = secondsToFrames(track.fadeIn ?? 0);
  const fadeOutFrames = secondsToFrames(track.fadeOut ?? 0);
  const fadeIn = fadeInFrames > 0 ? interpolate(frame, [0, fadeInFrames], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const fadeOut = fadeOutFrames > 0 ? interpolate(frame, [durationInFrames - fadeOutFrames, durationInFrames], [1, 0], { extrapolateLeft: "clamp" }) : 1;
  return <Audio src={source} volume={track.volume * fadeIn * fadeOut} />;
};

export const AudioSystem: React.FC<Pick<ReelData, "music" | "voiceover">> = ({ music, voiceover }) => (
  <>
    {music ? <Sequence from={secondsToFrames(music.start)} layout="none"><FadingTrack track={music} /></Sequence> : null}
    {voiceover ? <Audio src={voiceover.src.startsWith("http") || voiceover.src.startsWith("/") ? voiceover.src : staticFile(voiceover.src)} volume={voiceover.volume} /> : null}
  </>
);
