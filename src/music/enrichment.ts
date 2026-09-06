import { resolve } from "node:path";
import { type ReelProductionHistory } from "../planner/production-history";
import { ReelDataSchema, type ReelData } from "../v2/schema";
import { defaultAfmRoot, localizeAfmTrack, scanAfmCatalog, type LocalizedAfmTrack } from "./afm";
import { selectMusicForCompletedReel, type MusicSelection } from "./selector";

export type MusicPlaybackConfig = {
  volume: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
};

export type MusicEnrichmentResult = {
  reel: ReelData;
  selection?: MusicSelection;
  localization?: LocalizedAfmTrack;
  warning?: string;
};

export type CompletedReelMusicEnricher = (reel: ReelData, history: ReelProductionHistory) => Promise<MusicEnrichmentResult>;

const configuredNumber = (name: string, fallback: number, maximum: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`${name} must be between 0 and ${maximum}`);
  return value;
};

export const getMusicPlaybackConfig = (): MusicPlaybackConfig => ({
  volume: configuredNumber("ARTFOLIO_MUSIC_VOLUME", 0.18, 1),
  fadeInSeconds: configuredNumber("ARTFOLIO_MUSIC_FADE_IN_SECONDS", 0.6, 10),
  fadeOutSeconds: configuredNumber("ARTFOLIO_MUSIC_FADE_OUT_SECONDS", 1.5, 10),
});

export const attachMusic = (
  visualReel: ReelData,
  selection: MusicSelection,
  localization: LocalizedAfmTrack,
  playback = getMusicPlaybackConfig(),
): ReelData => ReelDataSchema.parse({
  ...visualReel,
  music: {
    src: localization.publicPath,
    trackId: selection.track.id,
    subfamily: selection.track.subfamilyCode,
    volume: playback.volume,
    start: 0,
    durationSeconds: selection.track.durationSeconds,
    fadeIn: playback.fadeInSeconds,
    fadeOut: playback.fadeOutSeconds,
  },
});

/** Post-QC enrichment boundary. AFM absence is non-fatal unless a track was explicitly forced. */
export const enrichCompletedReelWithAfm = async (
  visualReel: ReelData,
  history: ReelProductionHistory,
  options: { afmRoot?: string; publicDirectory?: string; forcedTrackId?: string } = {},
): Promise<MusicEnrichmentResult> => {
  const forcedTrackId = options.forcedTrackId ?? process.env.ARTFOLIO_AFM_TRACK_ID;
  const afmRoot = options.afmRoot ?? defaultAfmRoot();
  try {
    const catalog = await scanAfmCatalog(afmRoot);
    if (!catalog.available) {
      if (forcedTrackId) throw new Error(`Forced AFM track cannot be resolved because the library is unavailable: ${forcedTrackId}`);
      return { reel: visualReel, warning: catalog.warnings.join("; ") };
    }
    const selection = selectMusicForCompletedReel(visualReel, catalog.tracks, history, { forcedTrackId });
    if (!selection) {
      if (forcedTrackId) throw new Error(`Forced AFM track is unavailable: ${forcedTrackId}`);
      return { reel: visualReel, warning: "AFM has no accepted production-ready WAV candidates" };
    }
    const localization = await localizeAfmTrack(selection.track, options.publicDirectory ?? resolve("public/reel-audio"));
    return { reel: attachMusic(visualReel, selection, localization), selection, localization };
  } catch (error) {
    if (forcedTrackId) throw error;
    return { reel: visualReel, warning: `AFM music unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
};
