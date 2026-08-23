import { Composition } from "remotion";
import { VIDEO } from "./v2/design";
import { ReelComposition } from "./v2/ReelComposition";
import { SAMPLE_REELS } from "./v2/samples";
import { getDurationInFrames } from "./v2/timing";
import { type ReelData } from "./v2/schema";

const PlannedReel: React.FC<ReelData> = (reel) => <ReelComposition reel={reel} />;

export const ArtfolioV2Compositions: React.FC = () => (
  <>
    {Object.entries(SAMPLE_REELS).map(([templateId, reel]) => (
      <Composition
        key={templateId}
        id={`ArtfolioV2-${templateId}`}
        component={ReelComposition}
        defaultProps={{ reel }}
        durationInFrames={getDurationInFrames(reel)}
        fps={VIDEO.fps}
        width={VIDEO.width}
        height={VIDEO.height}
      />
    ))}
    <Composition
      id="ArtfolioV2-PlannedReel"
      component={PlannedReel}
      defaultProps={SAMPLE_REELS["why-this-works"]}
      calculateMetadata={({ props }) => ({ durationInFrames: getDurationInFrames(props) })}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
  </>
);
