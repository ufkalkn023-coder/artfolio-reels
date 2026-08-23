import {
  AbsoluteFill,
  Composition,
  Easing,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";

const artwork = staticFile("artworks/starry-night.jpg");

const serif = 'Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif';
const sans = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

type ArtworkViewProps = {
  durationInFrames: number;
  endFocusX: number;
  endFocusY: number;
  endScale: number;
  focusX: number;
  focusY: number;
  framed?: boolean;
  scale?: number;
};

const ArtworkView: React.FC<ArtworkViewProps> = ({
  durationInFrames,
  endFocusX,
  endFocusY,
  endScale,
  focusX,
  focusY,
  framed = false,
  scale = 1,
}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    easing: Easing.bezier(0.33, 0, 0.2, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const artworkScale = interpolate(progress, [0, 1], [scale, endScale]);
  const objectPositionX = interpolate(progress, [0, 1], [focusX, endFocusX]);
  const objectPositionY = interpolate(progress, [0, 1], [focusY, endFocusY]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#08111d", overflow: "hidden" }}>
      <Img
        src={artwork}
        style={{
          filter: "blur(28px) saturate(0.72) brightness(0.38)",
          height: "100%",
        objectFit: "cover",
        objectPosition: `${objectPositionX}% ${objectPositionY}%`,
        opacity: 0.72,
        position: "absolute",
        scale: 1.13,
        top: 0,
        left: 0,
        width: "100%",
        }}
      />
      <AbsoluteFill style={{ backgroundColor: "rgba(2, 8, 15, 0.38)" }} />
      {framed ? (
        <div
          style={{
            alignItems: "center",
            display: "flex",
            inset: "320px 52px 510px",
            justifyContent: "center",
            position: "absolute",
          }}
        >
          <Img
            src={artwork}
            style={{
              boxShadow: "0 28px 75px rgba(0, 0, 0, 0.38)",
              height: "100%",
              objectFit: "contain",
              scale: artworkScale,
              width: "100%",
            }}
          />
        </div>
      ) : (
        <Img
          src={artwork}
          style={{
            height: "100%",
            objectFit: "cover",
            objectPosition: `${objectPositionX}% ${objectPositionY}%`,
            position: "absolute",
            scale: artworkScale,
            top: 0,
            left: 0,
            width: "100%",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

const SceneFade: React.FC<{
  children: React.ReactNode;
  durationInFrames: number;
  holdAtEnd?: boolean;
}> = ({ children, durationInFrames, holdAtEnd = false }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        opacity: interpolate(
          frame,
          holdAtEnd ? [0, 16] : [0, 16, durationInFrames - 16, durationInFrames],
          holdAtEnd ? [0, 1] : [0, 1, 1, 0],
          {
            easing: Easing.bezier(0.33, 0, 0.2, 1),
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          },
        ),
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const ArtfolioReel = () => {
  return (
    <Composition
      id="ArtfolioReel"
      component={ArtfolioReelComponent}
      durationInFrames={1800}
      fps={30}
      width={1080}
      height={1920}
    />
  );
};

export const ArtfolioReelComponent: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#08111d" }}>
      <Sequence durationInFrames={136} from={0} layout="none">
        <SceneFade durationInFrames={136}>
          <ArtworkView
            durationInFrames={136}
            endFocusX={45}
            endFocusY={31}
            endScale={1.13}
            focusX={51}
            focusY={35}
            scale={1.04}
          />
          <AbsoluteFill style={{ backgroundColor: "rgba(2, 7, 15, 0.18)" }} />
          <div
            style={{
              bottom: 360,
              color: "#f7f0df",
              fontFamily: serif,
              fontSize: 82,
              fontWeight: 400,
              left: 76,
              letterSpacing: -2.5,
              lineHeight: 1.06,
              maxWidth: 690,
              position: "absolute",
              textShadow: "0 3px 22px rgba(0, 0, 0, 0.42)",
            }}
          >
            Why does this painting feel alive?
          </div>
          <div
            style={{
              color: "rgba(247, 240, 223, 0.8)",
              fontFamily: sans,
              fontSize: 19,
              left: 80,
              letterSpacing: 4.4,
              position: "absolute",
              textTransform: "uppercase",
              top: 126,
            }}
          >
            An Artfolio study
          </div>
        </SceneFade>
      </Sequence>

      <Sequence durationInFrames={226} from={104} layout="none">
        <SceneFade durationInFrames={226}>
          <ArtworkView
            durationInFrames={226}
            endFocusX={50}
            endFocusY={50}
            endScale={1.035}
            focusX={50}
            focusY={50}
            framed
            scale={0.98}
          />
          <div
            style={{
              bottom: 360,
              color: "#f3ead7",
              left: 76,
              position: "absolute",
              right: 76,
            }}
          >
            <div
              style={{
                fontFamily: sans,
                fontSize: 24,
                fontWeight: 500,
                letterSpacing: 1.8,
                marginBottom: 20,
                textTransform: "uppercase",
              }}
            >
              Vincent van Gogh
            </div>
            <div
              style={{
                fontFamily: serif,
                fontSize: 57,
                letterSpacing: -1,
                lineHeight: 1.1,
              }}
            >
              The Starry Night, 1889
            </div>
          </div>
          <div
            style={{
              backgroundColor: "#d4ab47",
              height: 2,
              left: 76,
              position: "absolute",
              top: 250,
              width: 82,
            }}
          />
        </SceneFade>
      </Sequence>

      <Sequence durationInFrames={226} from={314} layout="none">
        <SceneFade durationInFrames={226}>
          <ArtworkView
            durationInFrames={226}
            endFocusX={72}
            endFocusY={26}
            endScale={1.28}
            focusX={66}
            focusY={30}
            scale={1.16}
          />
          <div
            style={{
              backgroundColor: "rgba(5, 13, 27, 0.8)",
              bottom: 430,
              color: "#f6eddd",
              fontFamily: serif,
              fontSize: 68,
              left: 64,
              letterSpacing: -1.7,
              lineHeight: 1.08,
              maxWidth: 710,
              padding: "32px 38px 36px",
              position: "absolute",
            }}
          >
            The sky doesn&apos;t sit still.
          </div>
          <div
            style={{
              bottom: 338,
              color: "rgba(246, 237, 221, 0.84)",
              fontFamily: sans,
              fontSize: 22,
              left: 104,
              letterSpacing: 0.4,
              position: "absolute",
            }}
          >
            Van Gogh turns light into movement.
          </div>
        </SceneFade>
      </Sequence>

      <Sequence durationInFrames={256} from={524} layout="none">
        <SceneFade durationInFrames={256}>
          <ArtworkView
            durationInFrames={256}
            endFocusX={34}
            endFocusY={47}
            endScale={1.15}
            focusX={42}
            focusY={51}
            scale={1.06}
          />
          <div
            style={{
              color: "rgba(244, 235, 216, 0.7)",
              fontFamily: sans,
              fontSize: 18,
              letterSpacing: 3.4,
              left: 80,
              position: "absolute",
              textTransform: "uppercase",
              top: 198,
            }}
          >
            June 1889
          </div>
          <div
            style={{
              backgroundColor: "rgba(5, 12, 23, 0.82)",
              color: "#f5eddc",
              fontFamily: serif,
              fontSize: 60,
              left: 64,
              letterSpacing: -1.1,
              lineHeight: 1.14,
              maxWidth: 700,
              padding: "35px 40px 39px",
              position: "absolute",
              top: 290,
            }}
          >
            Van Gogh painted The Starry Night.
          </div>
          <div
            style={{
              backgroundColor: "rgba(5, 12, 23, 0.72)",
              color: "rgba(245, 237, 220, 0.9)",
              fontFamily: sans,
              fontSize: 27,
              left: 88,
              lineHeight: 1.38,
              maxWidth: 720,
              padding: "22px 28px 25px",
              position: "absolute",
              top: 510,
            }}
          >
            while staying at Saint-Paul-de-Mausole in Saint-Rémy.
          </div>
        </SceneFade>
      </Sequence>

      <Sequence durationInFrames={256} from={764} layout="none">
        <SceneFade durationInFrames={256}>
          <ArtworkView
            durationInFrames={256}
            endFocusX={58}
            endFocusY={70}
            endScale={1.16}
            focusX={51}
            focusY={66}
            scale={1.06}
          />
          <div
            style={{
              backgroundColor: "rgba(3, 10, 18, 0.8)",
              bottom: 420,
              color: "#f7eee0",
              fontFamily: serif,
              fontSize: 64,
              left: 64,
              letterSpacing: -1.8,
              lineHeight: 1.08,
              maxWidth: 790,
              padding: "31px 37px 36px",
              position: "absolute",
            }}
          >
            The view began outside his window.
          </div>
          <div
            style={{
              bottom: 324,
              color: "rgba(247, 238, 224, 0.86)",
              fontFamily: sans,
              fontSize: 22,
              left: 102,
              letterSpacing: 0.3,
              position: "absolute",
            }}
          >
            But the village below was largely imagined.
          </div>
        </SceneFade>
      </Sequence>

      <Sequence durationInFrames={256} from={1004} layout="none">
        <SceneFade durationInFrames={256}>
          <ArtworkView
            durationInFrames={256}
            endFocusX={26}
            endFocusY={52}
            endScale={1.22}
            focusX={31}
            focusY={55}
            scale={1.09}
          />
          <div
            style={{
              backgroundColor: "rgba(3, 10, 18, 0.78)",
              color: "#f3ead8",
              fontFamily: serif,
              fontSize: 64,
              left: 76,
              letterSpacing: -1.4,
              lineHeight: 1.06,
              maxWidth: 700,
              padding: "31px 37px 36px",
              position: "absolute",
              top: 280,
            }}
          >
            The cypress rises like a dark flame.
          </div>
          <div
            style={{
              color: "rgba(243, 234, 216, 0.86)",
              fontFamily: sans,
              fontSize: 22,
              left: 116,
              letterSpacing: 1,
              position: "absolute",
              top: 545,
            }}
          >
            Earth below. Sky above.
          </div>
        </SceneFade>
      </Sequence>

      <Sequence durationInFrames={286} from={1244} layout="none">
        <SceneFade durationInFrames={286}>
          <ArtworkView
            durationInFrames={286}
            endFocusX={50}
            endFocusY={56}
            endScale={1.1}
            focusX={47}
            focusY={53}
            scale={1.02}
          />
          <div
            style={{
              backgroundColor: "rgba(3, 10, 18, 0.78)",
              bottom: 390,
              color: "#f7eee0",
              fontFamily: serif,
              fontSize: 68,
              left: 64,
              letterSpacing: -1.7,
              lineHeight: 1.08,
              maxWidth: 745,
              padding: "31px 37px 36px",
              position: "absolute",
            }}
          >
            The village is quiet.<br />The sky is not.
          </div>
        </SceneFade>
      </Sequence>

      <Sequence durationInFrames={286} from={1514} layout="none">
        <SceneFade durationInFrames={286} holdAtEnd>
          <ArtworkView
            durationInFrames={286}
            endFocusX={50}
            endFocusY={50}
            endScale={1.025}
            focusX={50}
            focusY={50}
            framed
            scale={0.97}
          />
          <div
            style={{
              bottom: 390,
              color: "#f3ead8",
              left: 76,
              position: "absolute",
            }}
          >
            <div
              style={{
                fontFamily: serif,
                fontSize: 62,
                letterSpacing: -1.4,
                lineHeight: 1.03,
                marginBottom: 22,
              }}
            >
              The Starry Night
            </div>
            <div
              style={{
                fontFamily: sans,
                fontSize: 22,
                letterSpacing: 1.1,
                lineHeight: 1.65,
              }}
            >
              Vincent van Gogh
              <br />
              1889
              <br />
              Museum of Modern Art, New York
            </div>
          </div>
          <div
            style={{
              bottom: 290,
              color: "rgba(244, 235, 216, 0.76)",
              fontFamily: sans,
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: 7,
              position: "absolute",
              right: 72,
            }}
          >
            ARTFOLIO
          </div>
        </SceneFade>
      </Sequence>
    </AbsoluteFill>
  );
};
