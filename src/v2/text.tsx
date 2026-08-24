import { Easing, interpolate, useCurrentFrame } from "remotion";
import { DESIGN } from "./design";

export type EditorialTextKind = "hook" | "title" | "observation" | "metadata" | "label";

export const assertEditorialText = (text: string, maxWords: number, field: string): void => {
  if (text.trim().split(/\s+/).filter(Boolean).length > maxWords) {
    throw new Error(`${field} exceeds its ${maxWords}-word editorial limit`);
  }
};

/**
 * Gives dense copy a restrained, deterministic font-size reduction before it
 * wraps. The renderer never clips or line-clamps approved editorial copy.
 */
export const getSafeEditorialFontSize = (
  text: string,
  kind: EditorialTextKind,
  maxWidth: number,
  preferredLines: number,
): number => {
  const baseSize = DESIGN.type[kind];
  const characters = Math.max(text.replace(/\s/g, "").length, 1);
  const averageGlyphWidth = kind === "metadata" || kind === "label" ? 0.5 : 0.54;
  const estimatedFit = Math.floor((maxWidth * preferredLines) / (characters * averageGlyphWidth));
  const minimumReadableSize = Math.ceil(baseSize * 0.8);

  return Math.max(minimumReadableSize, Math.min(baseSize, estimatedFit));
};

export const getEditorialRevealProgress = (frame: number, revealStartFrame = 0): number =>
  interpolate(frame, [revealStartFrame, revealStartFrame + 14], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

export const EditorialText: React.FC<{
  children: string;
  kind: EditorialTextKind;
  maxWidth: number;
  maxLines: number;
  revealStartFrame?: number;
  style?: React.CSSProperties;
}> = ({ children, kind, maxWidth, maxLines, revealStartFrame = 0, style }) => {
  const frame = useCurrentFrame();
  const reveal = getEditorialRevealProgress(frame, revealStartFrame);
  const fontSize = getSafeEditorialFontSize(children, kind, maxWidth, maxLines);
  return (
    <div
      style={{
        color: DESIGN.color.lightText,
        display: "block",
        fontFamily: kind === "hook" || kind === "title" || kind === "observation" ? DESIGN.font.serif : DESIGN.font.sans,
        fontSize,
        letterSpacing: kind === "label" ? 4.2 : kind === "metadata" ? 0.5 : -1.4,
        lineHeight: kind === "metadata" ? 1.45 : 1.07,
        maxWidth,
        opacity: reveal,
        overflowWrap: "anywhere",
        textTransform: kind === "label" ? "uppercase" : undefined,
        translate: `0 ${interpolate(reveal, [0, 1], [18, 0])}px`,
        whiteSpace: kind === "metadata" ? "pre-line" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
