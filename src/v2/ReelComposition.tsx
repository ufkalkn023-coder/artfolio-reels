import { AbsoluteFill, Sequence } from "remotion";
import { type ReelData } from "./schema";
import {
  ArtworkDetailScene,
  ArtworkOverviewScene,
  ComparisonScene,
  MasterIntroScene,
  MasterOutroScene,
  MetadataScene,
  ObservationScene,
} from "./scenes";
import { createScenePlan, resolveDetailSceneContent, resolveOverviewSceneSynthesis, shouldRenderDetailObservation } from "./timing";
import { assertValidReelData } from "./templates";
import { AudioSystem } from "./audio";

export const ReelComposition: React.FC<{ reel: ReelData }> = ({ reel: rawReel }) => {
  const reel = assertValidReelData(rawReel);
  const plan = createScenePlan(reel);
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#111417" }}>
      <AudioSystem music={reel.music} voiceover={reel.voiceover} />
      {plan.map((scene, sceneIndex) => {
        const artwork = reel.artworks[scene.artworkIndex] ?? reel.artworks[0];
        const detailContent = resolveDetailSceneContent(artwork, scene);
        const overviewSynthesis = resolveOverviewSceneSynthesis(reel.centralIdea, scene, plan);
        const comparisonObservation = reel.observations[scene.observationIndex ?? 0];
        const renderDetailObservation = shouldRenderDetailObservation(scene, plan[sceneIndex + 1]);
        const sequence = (
          <Sequence key={scene.id} from={from} durationInFrames={scene.durationInFrames} layout="none" name={scene.id}>
            {scene.kind === "intro" ? <MasterIntroScene artwork={artwork} durationInFrames={scene.durationInFrames} hook={reel.hook} label={reel.label} camera={scene.input?.camera ?? reel.camera} /> : null}
            {scene.kind === "overview" ? <ArtworkOverviewScene artwork={artwork} durationInFrames={scene.durationInFrames} camera={scene.input?.camera ?? reel.camera} synthesis={overviewSynthesis} /> : null}
            {scene.kind === "detail" && detailContent.target ? <ArtworkDetailScene artwork={artwork} detail={detailContent.target} durationInFrames={scene.durationInFrames} camera={scene.input?.camera} observation={renderDetailObservation ? detailContent.observation : undefined} label={detailContent.label} debugTargetOverlay={reel.debugTargetOverlay} /> : null}
            {scene.kind === "observation" && detailContent.target ? <ObservationScene artwork={artwork} durationInFrames={scene.durationInFrames} observation={detailContent.observation} label={detailContent.label} target={detailContent.target} camera={scene.input?.camera} debugTargetOverlay={reel.debugTargetOverlay} /> : null}
            {scene.kind === "comparison" && comparisonObservation ? <ComparisonScene artworks={reel.artworks} durationInFrames={scene.durationInFrames} observation={comparisonObservation} /> : null}
            {scene.kind === "metadata" ? <MetadataScene artwork={artwork} durationInFrames={scene.durationInFrames} camera={scene.input?.camera} /> : null}
            {scene.kind === "outro" ? <MasterOutroScene artwork={artwork} durationInFrames={scene.durationInFrames} /> : null}
          </Sequence>
        );
        from += scene.durationInFrames;
        return sequence;
      })}
    </AbsoluteFill>
  );
};
