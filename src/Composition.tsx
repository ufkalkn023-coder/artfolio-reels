import { AbsoluteFill, Composition } from "remotion";

export const ArtfolioReel = () => {
  return (
    <Composition
      id="ArtfolioReel"
      component={ArtfolioReelComponent}
      durationInFrames={900}
      fps={30}
      width={1080}
      height={1920}
    />
  );
};

export const ArtfolioReelComponent: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        backgroundColor: "#f5efe6",
        color: "#292521",
        display: "flex",
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: 72,
        justifyContent: "center",
        letterSpacing: 12,
      }}
    >
      ARTFOLIO
    </AbsoluteFill>
  );
};
