import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { DESIGN, VIDEO } from "./design";
import { type CameraSettings, type DetailPoint, type TargetRegion } from "./schema";

export type CameraState = { startScale: number; endScale: number; focalX: number; focalY: number; endFocalX: number; endFocalY: number };
export type ArtworkDimensions = { imageWidth?: number; imageHeight?: number; orientation?: "portrait" | "landscape" | "panorama" };
export type Framing = {
  imageWidth: number; imageHeight: number; left: number; top: number; renderedWidth: number; renderedHeight: number;
  contain: boolean;
  targetBounds?: { left: number; top: number; width: number; height: number };
};
export type ContainTransform = {
  left: number; top: number; width: number; height: number; scale: number; translateX: number; translateY: number;
};

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
const OUTPUT_RATIO = VIDEO.width / VIDEO.height;
const TARGET_ENTER_MAX_FRAMES = 18;
const TARGET_REGION_PADDING = 0.08;
const CONTAIN_PAN_STRENGTH = 0.25;
const CONTAIN_MAX_PAN_FRACTION = 0.025;
const CONTAIN_MAX_ZOOM_DELTA = 0.03;

type ContainPadding = string | number;
type ResolvedPadding = { top: number; right: number; bottom: number; left: number };

const finiteOr = (value: number | undefined, fallback: number): number => Number.isFinite(value) ? (value as number) : fallback;
const containPanOffset = (focal: number | undefined, extent: number): number => clamp(
  -(finiteOr(focal, 0.5) - 0.5) * extent * CONTAIN_PAN_STRENGTH,
  -extent * CONTAIN_MAX_PAN_FRACTION,
  extent * CONTAIN_MAX_PAN_FRACTION,
);
const resolveContainPadding = (padding: ContainPadding): ResolvedPadding => {
  const values = typeof padding === "number"
    ? [Math.max(0, finiteOr(padding, 0))]
    : padding.trim().split(/\s+/).map((value) => Number.parseFloat(value)).filter(Number.isFinite).map((value) => Math.max(0, value));
  const [top = 0, right = top, bottom = top, left = right] = values;
  if (values.length === 2) return { top, right, bottom: top, left: right };
  if (values.length === 3) return { top, right, bottom, left: right };
  return { top, right, bottom, left };
};

/** Ambient contain motion uses the whole scene, independently of detail-target establishment timing. */
export const getContainCameraProgress = (frame: number, durationInFrames: number): number => {
  if (durationInFrames <= 1) return 0;
  const progress = clamp(finiteOr(frame, 0) / Math.max(1, finiteOr(durationInFrames, 1) - 1));
  return progress * progress * (3 - 2 * progress);
};

/** Pure contain-mode geometry. Safe ambient endpoints are derived before full-scene interpolation. */
export const resolveContainTransform = (
  artwork: ArtworkDimensions,
  state: CameraState,
  progress: number,
  move: CameraSettings["move"] = "none",
  padding: ContainPadding = "300px 52px 500px",
  viewport = VIDEO,
): ContainTransform => {
  const viewportWidth = Math.max(1, finiteOr(viewport.width, VIDEO.width));
  const viewportHeight = Math.max(1, finiteOr(viewport.height, VIDEO.height));
  const resolvedPadding = resolveContainPadding(padding);
  const availableWidth = Math.max(1, viewportWidth - resolvedPadding.left - resolvedPadding.right);
  const availableHeight = Math.max(1, viewportHeight - resolvedPadding.top - resolvedPadding.bottom);
  const { imageWidth: rawWidth, imageHeight: rawHeight } = dimensionsFor(artwork);
  const imageWidth = Math.max(1, finiteOr(rawWidth, 1));
  const imageHeight = Math.max(1, finiteOr(rawHeight, 1));
  const fit = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
  const fittedWidth = imageWidth * fit;
  const fittedHeight = imageHeight * fit;

  // Historically `none` ignored contain-camera coordinates. Keep that centered and exactly static.
  const motionProgress = move === "none" ? 0 : clamp(finiteOr(progress, 0));
  const requestedStartScale = Math.max(0.001, finiteOr(state.startScale, 1));
  const requestedEndScale = move === "none" ? requestedStartScale : Math.max(0.001, finiteOr(state.endScale, requestedStartScale));
  const maxRequestedScale = Math.max(requestedStartScale, requestedEndScale);
  const safeStartScale = clamp(requestedStartScale / maxRequestedScale, 1 - CONTAIN_MAX_ZOOM_DELTA, 1);
  const safeEndScale = move === "none"
    ? safeStartScale
    : clamp(requestedEndScale / maxRequestedScale, 1 - CONTAIN_MAX_ZOOM_DELTA, 1);
  const scale = safeStartScale + (safeEndScale - safeStartScale) * motionProgress;
  const width = fittedWidth * scale;
  const height = fittedHeight * scale;
  const safePanEndpoint = (focal: number | undefined, extent: number, fittedExtent: number, endpointScale: number): number => {
    const endpointSlack = Math.max(0, (extent - fittedExtent * endpointScale) / 2);
    return clamp(containPanOffset(focal, extent), -endpointSlack, endpointSlack);
  };
  const startTranslateX = move === "none" ? 0 : safePanEndpoint(state.focalX, availableWidth, fittedWidth, safeStartScale);
  const endTranslateX = move === "none" ? 0 : safePanEndpoint(state.endFocalX, availableWidth, fittedWidth, safeEndScale);
  const startTranslateY = move === "none" ? 0 : safePanEndpoint(state.focalY, availableHeight, fittedHeight, safeStartScale);
  const endTranslateY = move === "none" ? 0 : safePanEndpoint(state.endFocalY, availableHeight, fittedHeight, safeEndScale);
  const translateX = startTranslateX + (endTranslateX - startTranslateX) * motionProgress;
  const translateY = startTranslateY + (endTranslateY - startTranslateY) * motionProgress;

  return {
    left: resolvedPadding.left + (availableWidth - width) / 2 + translateX,
    top: resolvedPadding.top + (availableHeight - height) / 2 + translateY,
    width,
    height,
    scale,
    translateX,
    translateY,
  };
};

/** Centralized rhythm policy: establish selected framing promptly, then hold it. */
export const getTargetHoldStartFrame = (durationInFrames: number): number =>
  Math.max(1, Math.min(TARGET_ENTER_MAX_FRAMES, Math.round(durationInFrames * 0.3)));

const fallbackDimensions = (orientation: ArtworkDimensions["orientation"]): Required<Pick<ArtworkDimensions, "imageWidth" | "imageHeight">> => {
  if (orientation === "portrait") return { imageWidth: 3, imageHeight: 4 };
  if (orientation === "panorama") return { imageWidth: 2.2, imageHeight: 1 };
  return { imageWidth: 3, imageHeight: 2 };
};
const dimensionsFor = (artwork: ArtworkDimensions): Required<Pick<ArtworkDimensions, "imageWidth" | "imageHeight">> => ({
  imageWidth: artwork.imageWidth ?? fallbackDimensions(artwork.orientation).imageWidth,
  imageHeight: artwork.imageHeight ?? fallbackDimensions(artwork.orientation).imageHeight,
});
const targetBounds = (target: DetailPoint): TargetRegion => target.targetRegion ?? { x: target.focalX, y: target.focalY, width: 0, height: 0 };
const targetCenter = (target: DetailPoint): { x: number; y: number } => {
  const region = targetBounds(target);
  return { x: region.x + region.width / 2, y: region.y + region.height / 2 };
};
const visibleArtworkAtScale = (artwork: ArtworkDimensions, scale: number): { width: number; height: number } => {
  const { imageWidth, imageHeight } = dimensionsFor(artwork);
  const imageRatio = imageWidth / imageHeight;
  return { width: Math.min(1, OUTPUT_RATIO / imageRatio) / scale, height: Math.min(1, imageRatio / OUTPUT_RATIO) / scale };
};

export const targetRequiresContain = (artwork: ArtworkDimensions, target: DetailPoint): boolean => {
  if (!target.targetRegion) return false;
  const visibleAtOne = visibleArtworkAtScale(artwork, 1);
  return target.targetRegion.width + TARGET_REGION_PADDING > visibleAtOne.width || target.targetRegion.height + TARGET_REGION_PADDING > visibleAtOne.height;
};

/** Caps planner guidance before a selected region can be cropped out. */
export const getSafeTargetScale = (artwork: ArtworkDimensions, target: DetailPoint, requestedScale: number): number => {
  const region = target.targetRegion;
  if (!region) return clamp(requestedScale, 1, 2.5);
  const visibleAtOne = visibleArtworkAtScale(artwork, 1);
  const maxScale = Math.min(
    visibleAtOne.width / Math.min(1, region.width + TARGET_REGION_PADDING),
    visibleAtOne.height / Math.min(1, region.height + TARGET_REGION_PADDING),
    2.5,
  );
  return clamp(requestedScale, 1, Math.max(1, maxScale));
};

/** A scene target owns focal coordinates; planner camera coordinates cannot override it. */
export const resolveTargetCamera = (camera: Partial<CameraSettings> | undefined, target: DetailPoint, artwork: ArtworkDimensions): Partial<CameraSettings> => {
  // Early V2 reels serialized CameraSchema's old default scale of 1. Target
  // guidance must still win for those saved artifacts.
  const requestedScale = Math.max(target.scale, camera?.endScale ?? camera?.startScale ?? target.scale);
  const safeScale = getSafeTargetScale(artwork, target, requestedScale);
  const requestedMove = camera?.move ?? "detail-hold";
  const move = target.targetType === "RELATION" || ["detail-hold", "zoom-in", "full-to-detail", "reveal", "none"].includes(requestedMove)
    ? requestedMove
    : "detail-hold";
  const zooming = ["zoom-in", "full-to-detail", "reveal"].includes(move);
  return {
    move,
    focalX: target.focalX,
    focalY: target.focalY,
    endFocalX: target.focalX,
    endFocalY: target.focalY,
    startScale: safeScale,
    endScale: getSafeTargetScale(artwork, target, zooming ? safeScale + 0.04 : safeScale),
  };
};

export const resolveCameraState = (camera: Partial<CameraSettings> = {}): CameraState => {
  const focalX = camera.focalX ?? 0.5;
  const focalY = camera.focalY ?? 0.5;
  const startScale = camera.startScale ?? 1;
  const move = camera.move ?? "none";
  const fallbackEndScale = move === "zoom-in" || move === "full-to-detail" || move === "reveal" ? startScale + 0.1
    : move === "zoom-out" || move === "detail-to-full" ? Math.max(1, startScale - 0.1) : startScale;
  const pan = move === "pan-left" ? [-0.08, 0] : move === "pan-right" ? [0.08, 0]
    : move === "pan-up" ? [0, -0.08] : move === "pan-down" ? [0, 0.08] : [0, 0];
  return { startScale, endScale: camera.endScale ?? fallbackEndScale, focalX, focalY, endFocalX: camera.endFocalX ?? clamp(focalX + pan[0]), endFocalY: camera.endFocalY ?? clamp(focalY + pan[1]) };
};

/** Explicit cover-crop geometry. CSS objectPosition cannot guarantee this invariant after scaling. */
export const resolveArtworkFraming = (artwork: ArtworkDimensions, scale: number, focalX: number, focalY: number, target?: DetailPoint): Framing => {
  const { imageWidth, imageHeight } = dimensionsFor(artwork);
  const region = target ? targetBounds(target) : undefined;
  if (target && targetRequiresContain(artwork, target)) {
    const fitRegion = region as TargetRegion;
    const containScale = Math.min(VIDEO.width / imageWidth, VIDEO.height / imageHeight);
    const renderedWidth = imageWidth * containScale;
    const renderedHeight = imageHeight * containScale;
    const left = (VIDEO.width - renderedWidth) / 2;
    const top = (VIDEO.height - renderedHeight) / 2;
    return {
      imageWidth, imageHeight, left, top, renderedWidth, renderedHeight, contain: true,
      targetBounds: {
        left: left + fitRegion.x * renderedWidth,
        top: top + fitRegion.y * renderedHeight,
        width: Math.max(fitRegion.width * renderedWidth, 2),
        height: Math.max(fitRegion.height * renderedHeight, 2),
      },
    };
  }
  const baseScale = Math.max(VIDEO.width / imageWidth, VIDEO.height / imageHeight);
  const renderedWidth = imageWidth * baseScale * scale;
  const renderedHeight = imageHeight * baseScale * scale;
  const visible = visibleArtworkAtScale(artwork, scale);
  const focus = target ? targetCenter(target) : { x: focalX, y: focalY };
  // Observation copy lives in the lower safe area; selected targets are placed above it when artwork bounds allow.
  const cropX = clamp(focus.x, visible.width / 2, 1 - visible.width / 2);
  const cropY = clamp(focus.y + 0.1 * visible.height, visible.height / 2, 1 - visible.height / 2);
  const left = VIDEO.width / 2 - cropX * renderedWidth;
  const top = VIDEO.height / 2 - cropY * renderedHeight;
  return {
    imageWidth, imageHeight, left, top, renderedWidth, renderedHeight, contain: false,
    targetBounds: region ? {
      left: left + region.x * renderedWidth,
      top: top + region.y * renderedHeight,
      width: Math.max(region.width * renderedWidth, 2),
      height: Math.max(region.height * renderedHeight, 2),
    } : undefined,
  };
};

export const targetNeedsTopText = (framing: Framing): boolean => Boolean(framing.targetBounds && framing.targetBounds.top + framing.targetBounds.height > VIDEO.height * 0.64);

const TargetOverlay: React.FC<{ target: DetailPoint; framing: Framing; scale: number }> = ({ target, framing, scale }) => {
  const bounds = framing.targetBounds;
  if (!bounds) return null;
  const compact = !target.targetRegion;
  return <>
    {compact ? <><div style={{ backgroundColor: "#F4F2ED", height: 2, left: bounds.left - 22, position: "absolute", top: bounds.top, width: 44 }} /><div style={{ backgroundColor: "#F4F2ED", height: 44, left: bounds.left, position: "absolute", top: bounds.top - 22, width: 2 }} /></> : <div style={{ border: "3px solid #F4F2ED", boxSizing: "border-box", height: bounds.height, left: bounds.left, position: "absolute", top: bounds.top, width: bounds.width }} />}
    <div style={{ backgroundColor: "rgba(17,20,23,0.82)", color: "#F4F2ED", fontFamily: DESIGN.font.sans, fontSize: 18, left: clamp(bounds.left / VIDEO.width, 0.01, 0.78) * VIDEO.width, letterSpacing: 1.2, padding: "8px 10px", position: "absolute", textTransform: "uppercase", top: Math.max(12, bounds.top + 18) }}>{`${target.id} · ${scale.toFixed(2)}×`}</div>
  </>;
};

export const ArtworkCamera: React.FC<{
  src: string; durationInFrames: number; camera?: Partial<CameraSettings>; artwork?: ArtworkDimensions; target?: DetailPoint;
  debugTargetOverlay?: boolean; contain?: boolean; containPadding?: string | number; darkBackdrop?: boolean;
}> = ({ src, durationInFrames, camera, artwork = {}, target, debugTargetOverlay = false, contain = false, containPadding = "300px 52px 500px", darkBackdrop = false }) => {
  const frame = useCurrentFrame();
  const configuredCamera = target ? resolveTargetCamera(camera, target, artwork) : camera;
  const state = resolveCameraState(configuredCamera);
  const options = { easing: Easing.bezier(0.25, 0.1, 0.25, 1), extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
  const targetEnter = target ? getTargetHoldStartFrame(durationInFrames) : durationInFrames - 1;
  const scale = target ? interpolate(frame, [0, targetEnter, durationInFrames - 1], [state.startScale, state.endScale, state.endScale], options) : interpolate(frame, [0, durationInFrames - 1], [state.startScale, state.endScale], options);
  const x = interpolate(frame, [0, durationInFrames - 1], [state.focalX, state.endFocalX], options);
  const y = interpolate(frame, [0, durationInFrames - 1], [state.focalY, state.endFocalY], options);
  const cameraProgress = getContainCameraProgress(frame, durationInFrames);
  const resolvedSrc = src.startsWith("http") || src.startsWith("/") ? src : staticFile(src);
  const framing = contain ? undefined : resolveArtworkFraming(artwork, scale, x, y, target);
  const useContain = contain || framing?.contain;
  const containMove = configuredCamera?.move ?? "none";
  const containTransform = contain && !framing?.contain && containMove !== "none"
    ? resolveContainTransform(artwork, state, cameraProgress, containMove, containPadding)
    : undefined;
  return <AbsoluteFill style={{ backgroundColor: "#111417", overflow: "hidden" }}>
    {darkBackdrop ? <Img src={resolvedSrc} style={{ filter: "blur(32px) brightness(0.25) saturate(0.65)", height: "100%", objectFit: "cover", opacity: 0.5, position: "absolute", scale: 1.12, width: "100%" }} /> : null}
    {useContain && !framing?.contain ? containTransform
      ? <Img src={resolvedSrc} style={{ boxShadow: "0 24px 70px rgba(0,0,0,0.35)", height: containTransform.height, left: containTransform.left, objectFit: "contain", position: "absolute", top: containTransform.top, width: containTransform.width }} />
      : <AbsoluteFill style={{ alignItems: "center", display: "flex", justifyContent: "center", padding: containPadding }}><Img src={resolvedSrc} style={{ boxShadow: "0 24px 70px rgba(0,0,0,0.35)", height: "100%", objectFit: "contain", width: "100%" }} /></AbsoluteFill>
      : <Img src={resolvedSrc} style={{ height: framing?.renderedHeight, left: framing?.left, position: "absolute", top: framing?.top, width: framing?.renderedWidth }} />}
    {debugTargetOverlay && target && framing ? <TargetOverlay target={target} framing={framing} scale={scale} /> : null}
  </AbsoluteFill>;
};
