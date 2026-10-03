import { create } from 'zustand';

export type ChannelType = 'live' | 'simulated' | 'on_demand';
export type Segment = { id?: string; position: number; title: string; artist: string | null; audioUrl: string; durationSeconds: number };
export type Episode = {
  id: string; title: string; description?: string | null; audioUrl: string; durationSeconds: number | null; sizeBytes?: number | null; publishedAt?: string | null;
  airDate?: string | null; showSlug?: string | null; showType?: string | null; hourNumber?: number | null; variant?: string | null; needsReview?: boolean; videoUrl?: string | null;
};
export type Channel = {
  id: string; slug: string; name: string; description?: string | null; genre?: string | null;
  city?: string | null; frequency?: string | null; type: ChannelType; streamUrl?: string | null;
  cycleStart?: string | null; currentTitle?: string | null; currentArtist?: string | null; currentAlbum?: string | null;
  segments: Segment[]; episodes: Episode[];
};
export type NowPlaying = { type?: ChannelType; title?: string | null; artist?: string | null; album?: string | null; segment?: Segment; segmentIndex?: number; offsetSeconds?: number; cycleOffsetSeconds?: number; totalDurationSeconds?: number; serverTime?: string; metadataUpdatedAt?: string | null; /** performance.now() timestamp when this payload arrived */ receivedAt?: number };

export type EpisodeProgress = { position: number; duration: number };
const PROGRESS_KEY = 'ajn-radio-episode-progress-v1';
const PROGRESS_LIMIT = 300;
/** An episode counts as finished (no "partially played" bar) from this fraction onward. */
export const FINISHED_FRACTION = 0.97;

function loadProgress(): Record<string, EpisodeProgress> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(PROGRESS_KEY) ?? '{}') as Record<string, EpisodeProgress>;
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => value && value.duration > 0 && value.position >= 0));
  } catch { return {}; }
}
function saveProgress(progress: Record<string, EpisodeProgress>) {
  try {
    const entries = Object.entries(progress);
    const kept = entries.length > PROGRESS_LIMIT ? entries.slice(entries.length - PROGRESS_LIMIT) : entries;
    globalThis.localStorage?.setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* Private mode or blocked storage: progress just lasts for this visit. */ }
}

type PlayerState = {
  channels: Channel[];
  currentChannel: Channel | null;
  playing: boolean;
  volume: number;
  nowPlaying: NowPlaying | null;
  activeEpisode: Episode | null;
  position: number;
  duration: number;
  /** Last known play position of each episode this listener has played, by episode id. */
  episodeProgress: Record<string, EpisodeProgress>;
  setChannels: (channels: Channel[]) => void;
  mergeChannel: (slug: string, updates: Partial<Channel>) => void;
  tune: (channel: Channel) => void;
  setPlaying: (playing: boolean) => void;
  setVolume: (volume: number) => void;
  setNowPlaying: (metadata: NowPlaying | null) => void;
  setEpisode: (episode: Episode) => void;
  setProgress: (position: number, duration: number) => void;
};

export const usePlayerStore = create<PlayerState>()(set => ({
  channels: [], currentChannel: null, playing: false, volume: 0.72, nowPlaying: null,
  activeEpisode: null, position: 0, duration: 0, episodeProgress: loadProgress(),
  setChannels: channels => set(state => ({ channels, currentChannel: state.currentChannel ? channels.find(item => item.id === state.currentChannel?.id) ?? channels[0] ?? null : channels[0] ?? null })),
  mergeChannel: (slug, updates) => set(state => {
    const channels = state.channels.map(channel => channel.slug === slug ? { ...channel, ...updates } : channel);
    return { channels, currentChannel: state.currentChannel?.slug === slug ? { ...state.currentChannel, ...updates } : state.currentChannel };
  }),
  tune: channel => set(state => ({ currentChannel: channel, nowPlaying: null, activeEpisode: null, position: 0, duration: 0, playing: state.playing })),
  setPlaying: playing => set({ playing }),
  setVolume: volume => set({ volume: Math.max(0, Math.min(1, volume)) }),
  setNowPlaying: nowPlaying => set({ nowPlaying }),
  setEpisode: episode => set(state => ({ activeEpisode: episode, nowPlaying: { title: episode.title, artist: 'AJN Podcasts', album: state.currentChannel?.name }, position: 0, duration: episode.durationSeconds ?? 0, playing: true })),
  setProgress: (position, duration) => set(state => {
    const episode = state.activeEpisode;
    // Only remember real progress of the episode on screen: skip live audio, unknown length, a stale timeupdate
    // from the previous file (length far from the episode's own), and the first fraction of a second.
    const plausible = episode && duration > 0 && position >= 1 && (!episode.durationSeconds || Math.abs(duration - episode.durationSeconds) <= Math.max(10, episode.durationSeconds * 0.1));
    if (!plausible) return { position, duration };
    const previous = state.episodeProgress[episode.id];
    if (previous && Math.floor(previous.position) === Math.floor(position) && previous.duration === duration) return { position, duration };
    const episodeProgress = { ...state.episodeProgress };
    delete episodeProgress[episode.id]; // re-insert last so the oldest entries are the ones trimmed
    episodeProgress[episode.id] = { position, duration };
    if (Math.floor(position) % 5 === 0 || position / duration >= FINISHED_FRACTION) saveProgress(episodeProgress);
    return { position, duration, episodeProgress };
  }),
}));
