import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame } from "remotion";
import { ArtworkCamera, resolveArtworkFraming, targetNeedsTopText } from "./camera";
import { DESIGN } from "./design";
import { type Artwork, type CameraSettings, type DetailPoint } from "./schema";
import { EditorialText } from "./text";

type SceneBase = { artwork: Artwork; durationInFrames: number; camera?: Partial<CameraSettings>; debugTargetOverlay?: boolean };

const observationTextStyle = (artwork: Artwork, target?: DetailPoint): React.CSSProperties => {
  const top = target && targetNeedsTopText(resolveArtworkFraming(artwork, target.scale, target.focalX, target.focalY, target));
  return top
    ? { left: DESIGN.safe.left, position: "absolute", top: DESIGN.safe.top + 66, textShadow: "0 3px 20px rgba(0,0,0,0.52)" }
    : { bottom: DESIGN.safe.bottom + 80, left: DESIGN.safe.left, position: "absolute", textShadow: "0 3px 20px rgba(0,0,0,0.52)" };
};

const Label: React.FC<{ children: string }> = ({ children }) => (
  <EditorialText kind="label" maxLines={1} maxWidth={680} style={{ left: DESIGN.safe.left, position: "absolute", top: DESIGN.safe.top }}>
    {children}
  </EditorialText>
);

export const MasterIntroScene: React.FC<SceneBase & { hook: string; label: string }> = ({ artwork, durationInFrames, camera, hook, label }) => (
  <AbsoluteFill>
    <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={camera ?? { move: "zoom-in", focalX: 0.5, focalY: 0.32, startScale: 1.04, endScale: 1.1 }} />
    <AbsoluteFill style={{ backgroundColor: "rgba(4, 10, 15, 0.2)" }} />
    <Label>{label}</Label>
    <EditorialText kind="hook" maxLines={3} maxWidth={760} style={{ bottom: DESIGN.safe.bottom + 70, left: DESIGN.safe.left, position: "absolute", textShadow: "0 3px 20px rgba(0,0,0,0.5)" }}>
      {hook}
    </EditorialText>
  </AbsoluteFill>
);

export const ArtworkOverviewScene: React.FC<SceneBase & { synthesis?: string }> = ({ artwork, durationInFrames, camera, synthesis }) => {
  // Leave at least one readable second after the artwork establishes itself.
  const synthesisStartFrame = Math.min(18, Math.max(0, durationInFrames - 30));
  return (
    <AbsoluteFill>
      <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={camera ?? { move: "none", focalX: 0.5, focalY: 0.5, startScale: 1 }} contain darkBackdrop />
      {synthesis ? (
        <Sequence from={synthesisStartFrame} layout="none">
          <AbsoluteFill style={{ backgroundColor: "rgba(4, 10, 15, 0.2)" }} />
          <EditorialText kind="observation" maxLines={3} maxWidth={760} style={{ bottom: DESIGN.safe.bottom + 80, left: DESIGN.safe.left, position: "absolute", textShadow: "0 3px 20px rgba(0,0,0,0.52)" }}>
            {synthesis}
          </EditorialText>
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

export const ArtworkDetailScene: React.FC<SceneBase & { detail: DetailPoint; observation?: string; label?: string }> = ({ artwork, durationInFrames, camera, detail, observation, label, debugTargetOverlay }) => {
  const configuredCamera = camera ?? { move: "detail-hold" as const, focalX: detail.focalX, focalY: detail.focalY, startScale: detail.scale, endScale: detail.scale + 0.05 };
  if (!observation) return <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={configuredCamera} artwork={artwork} target={detail} debugTargetOverlay={debugTargetOverlay} />;
  return (
    <AbsoluteFill>
      <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={configuredCamera} artwork={artwork} target={detail} debugTargetOverlay={debugTargetOverlay} />
      <AbsoluteFill style={{ backgroundColor: "rgba(4, 10, 15, 0.2)" }} />
      {label ? <Label>{label}</Label> : null}
      <EditorialText kind="observation" maxLines={3} maxWidth={760} style={observationTextStyle(artwork, detail)}>
        {observation}
      </EditorialText>
    </AbsoluteFill>
  );
};

export const ObservationScene: React.FC<SceneBase & { observation?: string; label?: string; target: DetailPoint }> = ({ artwork, durationInFrames, camera, observation, label, target, debugTargetOverlay }) => {
  const configuredCamera = camera ?? { move: "detail-hold" as const, startScale: target.scale, endScale: target.scale + 0.04 };
  if (!observation) return <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={configuredCamera} artwork={artwork} target={target} debugTargetOverlay={debugTargetOverlay} />;
  return (
  <AbsoluteFill>
    <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={configuredCamera} artwork={artwork} target={target} debugTargetOverlay={debugTargetOverlay} />
    <AbsoluteFill style={{ backgroundColor: "rgba(4, 10, 15, 0.28)" }} />
    {label ? <Label>{label}</Label> : null}
    <EditorialText kind="observation" maxLines={3} maxWidth={760} style={observationTextStyle(artwork, target)}>
      {observation}
    </EditorialText>
  </AbsoluteFill>
  );
};

export const ComparisonScene: React.FC<{ artworks: Artwork[]; durationInFrames: number; observation: string }> = ({ artworks, durationInFrames, observation }) => (
  <AbsoluteFill style={{ backgroundColor: DESIGN.color.charcoal }}>
    {artworks.slice(0, 2).map((artwork, index) => (
      <div key={artwork.id} style={{ bottom: 540, left: index === 0 ? 52 : 552, position: "absolute", top: 220, width: 476 }}>
        <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={{ move: "none", focalX: 0.5, focalY: 0.5, startScale: 1 }} contain containPadding={0} />
      </div>
    ))}
    <EditorialText kind="observation" maxLines={2} maxWidth={860} style={{ bottom: DESIGN.safe.bottom + 70, left: DESIGN.safe.left, position: "absolute" }}>
      {observation}
    </EditorialText>
  </AbsoluteFill>
);

export const MetadataScene: React.FC<SceneBase> = ({ artwork, durationInFrames, camera }) => (
  <AbsoluteFill>
    <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={camera ?? { move: "none", startScale: 1 }} contain darkBackdrop />
    <div style={{ bottom: DESIGN.safe.bottom + 70, left: DESIGN.safe.left, position: "absolute" }}>
      <EditorialText kind="title" maxLines={2} maxWidth={760}>{artwork.title}</EditorialText>
      <EditorialText kind="metadata" maxLines={4} maxWidth={700} style={{ marginTop: 24 }}>{`${artwork.artist}\n${artwork.date}\n${artwork.museum}`}</EditorialText>
    </div>
  </AbsoluteFill>
);

export const MasterOutroScene: React.FC<SceneBase> = ({ artwork, durationInFrames }) => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 16], [0, 1], { easing: Easing.bezier(0.16, 1, 0.3, 1), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: DESIGN.color.charcoal }}>
      <div style={{ bottom: 610, left: 52, position: "absolute", right: 52, top: 130 }}>
        <ArtworkCamera src={artwork.src} durationInFrames={durationInFrames} camera={{ move: "none", startScale: 1 }} contain containPadding={0} />
      </div>
      <div style={{ bottom: DESIGN.safe.bottom, left: DESIGN.safe.left, opacity: fade, position: "absolute" }}>
        <EditorialText kind="title" maxLines={2} maxWidth={720}>{artwork.title}</EditorialText>
        <EditorialText kind="metadata" maxLines={4} maxWidth={700} style={{ marginTop: 22 }}>{`${artwork.artist}\n${artwork.date}\n${artwork.museum}`}</EditorialText>
      </div>
      <EditorialText kind="label" maxLines={1} maxWidth={300} style={{ bottom: DESIGN.safe.bottom - 5, opacity: fade, position: "absolute", right: DESIGN.safe.right }}>
        ARTFOLIO
      </EditorialText>
    </AbsoluteFill>
  );
};
