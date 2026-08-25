import { type MusicSuggestion, musicTrackIdentity, normalizeMusicIdentityPart } from "./reel-plan";

export const RECENT_MUSIC_REEL_LIMIT = 20;

export type RecentMusicContext = {
  tracks: Array<Pick<MusicSuggestion, "artist" | "title">>;
  frequentArtists: string[];
};

export const EMPTY_RECENT_MUSIC_CONTEXT: RecentMusicContext = { tracks: [], frequentArtists: [] };

export const recentMusicTrackIdentities = (context: RecentMusicContext): Set<string> =>
  new Set(context.tracks.map(musicTrackIdentity));

export const findRecentMusicDuplicates = (
  suggestions: readonly MusicSuggestion[],
  context: RecentMusicContext,
): MusicSuggestion[] => {
  const recent = recentMusicTrackIdentities(context);
  return suggestions.filter((suggestion) => recent.has(musicTrackIdentity(suggestion)));
};

export const formatRecentMusicContext = (context: RecentMusicContext): string => {
  if (context.tracks.length === 0 && context.frequentArtists.length === 0) {
    return "RECENT MUSIC — AVOID REPETITION\nNo recent music recommendations are recorded.";
  }
  const tracks = context.tracks.length > 0
    ? context.tracks.map((track) => `- ${track.artist} — ${track.title}`).join("\n")
    : "- None recorded";
  const artists = context.frequentArtists.length > 0 ? context.frequentArtists.join(", ") : "None repeated";
  return `RECENT MUSIC — AVOID REPETITION\nTracks recently suggested (do not reuse):\n${tracks}\nFrequently used recent artists/composers (soft avoidance, not a permanent ban):\n${artists}`;
};

export const normalizedMusicArtist = (artist: string): string => normalizeMusicIdentityPart(artist);
