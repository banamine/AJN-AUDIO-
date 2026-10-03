import type { Episode } from './playerStore';

export type EpisodeOrder = 'newest' | 'oldest';
export type EpisodeSort = EpisodeOrder | 'longest' | 'shortest';

/** Same key order as the server (air date, publish date, hour, id), in either direction, so the grid is right even if a server ignores `order`. */
export function sortEpisodes(list: Episode[], sort: EpisodeSort | EpisodeOrder): Episode[] {
  if (sort === 'longest' || sort === 'shortest') {
    // Length sort. The AJN feeds publish no durations, so when two episodes have none this compares the audio file
    // size from the feed (same encoder, so size tracks length). Episodes with neither always go last; ties keep newest first.
    const sign = sort === 'longest' ? -1 : 1;
    return [...sortEpisodes(list, 'newest')].sort((a, b) => {
      if (a.durationSeconds && b.durationSeconds) return sign * (a.durationSeconds - b.durationSeconds);
      if (a.sizeBytes && b.sizeBytes) return sign * (a.sizeBytes - b.sizeBytes);
      return (a.durationSeconds || a.sizeBytes ? 0 : 1) - (b.durationSeconds || b.sizeBytes ? 0 : 1);
    });
  }
  const direction = sort === 'oldest' ? -1 : 1;
  return [...list].sort((a, b) => direction * ((b.airDate ?? '').localeCompare(a.airDate ?? '') || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || (b.hourNumber ?? -1) - (a.hourNumber ?? -1)) || a.id.localeCompare(b.id));
}
