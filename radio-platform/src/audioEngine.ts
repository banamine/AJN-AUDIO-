import type { Segment } from './playerStore';

export class RadioAudioEngine {
  private active: HTMLAudioElement;
  private warm: HTMLAudioElement;
  private volume = 0.72;
  private warmedUrl: string | null = null;

  constructor(active: HTMLAudioElement, warm: HTMLAudioElement) {
    this.active = active;
    this.warm = warm;
    this.active.preload = 'auto';
    this.warm.preload = 'auto';
  }

  setVolume(volume: number) {
    this.volume = Math.min(1, Math.max(0, volume));
    this.active.volume = this.volume;
    this.warm.volume = this.volume;
  }

  pause() { this.active.pause(); }

  playStream(url: string) { return this.playUrl(url); }

  playEpisode(url: string) { return this.playUrl(url); }

  warmNext(segment: Segment | undefined) {
    if (!segment) return;
    const url = this.absoluteUrl(segment.audioUrl);
    if (this.warmedUrl === url && this.warm.src === url) return;
    this.warmedUrl = url;
    this.warm.src = url;
    this.warm.volume = this.volume;
    this.warm.load();
  }

  async promoteWarm(segment: Segment, offsetSeconds: number, onEnded: () => void, onError: (error: unknown) => void) {
    const url = this.absoluteUrl(segment.audioUrl);
    if (this.warmedUrl !== url || this.warm.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      try {
        await this.loadFile(segment.audioUrl, offsetSeconds);
        this.active.onended = onEnded;
      } catch (error) { onError(error); }
      return;
    }
    const previous = this.active;
    this.active = this.warm;
    this.warm = previous;
    this.active.volume = this.volume;
    this.active.currentTime = this.clamp(offsetSeconds);
    this.active.onended = null;
    this.active.onloadedmetadata = null;
    this.warmedUrl = null;
    try {
      await this.active.play();
      this.warm.pause();
      this.warm.removeAttribute('src');
      this.warm.load();
      this.active.onended = onEnded;
    } catch (error) { onError(error); }
  }

  dispose() { this.active.pause(); this.warm.pause(); this.active.onloadedmetadata = null; this.active.onended = null; }

  private playUrl(url: string) {
    this.active.onended = null;
    const source = this.absoluteUrl(url);
    if (this.active.src !== source) {
      this.active.onloadedmetadata = null;
      this.active.src = source;
      this.active.load();
    }
    this.active.volume = this.volume;
    return this.active.play();
  }

  private playFile(url: string, offsetSeconds: number, onError: (error: unknown) => void) {
    const source = this.absoluteUrl(url);
    this.active.onended = null;
    this.active.onloadedmetadata = null;
    this.active.volume = this.volume;
    if (this.active.src === source && this.active.readyState >= HTMLMediaElement.HAVE_METADATA) {
      if (Math.abs(this.active.currentTime - offsetSeconds) > 3) this.active.currentTime = this.clamp(offsetSeconds);
      void this.active.play().catch(onError);
      return;
    }
    this.active.onloadedmetadata = () => {
      this.active.currentTime = this.clamp(offsetSeconds);
      this.active.volume = this.volume;
      void this.active.play().catch(onError);
    };
    this.active.src = source;
    this.active.load();
  }

  private loadFile(url: string, offsetSeconds: number) {
    const source = this.absoluteUrl(url);
    if (this.active.src === source && this.active.readyState >= HTMLMediaElement.HAVE_METADATA) {
      this.active.currentTime = this.clamp(offsetSeconds);
      this.active.volume = this.volume;
      return this.active.play();
    }
    return new Promise<void>((resolve, reject) => {
      const audio = this.active;
      const cleanup = () => { audio.removeEventListener('loadedmetadata', onLoaded); audio.removeEventListener('error', onError); };
      const onLoaded = () => {
        cleanup();
        audio.currentTime = this.clamp(offsetSeconds);
        audio.volume = this.volume;
        void audio.play().then(resolve, reject);
      };
      const onError = () => { cleanup(); reject(new Error(`Unable to load audio file: ${url}`)); };
      audio.onended = null;
      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.src = source;
      audio.load();
    });
  }

  playSimulatedSegment(segment: Segment, offsetSeconds: number, onEnded: () => void, onError: (error: unknown) => void) {
    this.active.onended = null;
    if (this.active.src === this.absoluteUrl(segment.audioUrl) && this.active.readyState >= HTMLMediaElement.HAVE_METADATA) {
      if (Math.abs(this.active.currentTime - offsetSeconds) > 3) this.active.currentTime = this.clamp(offsetSeconds);
    } else {
      this.playFile(segment.audioUrl, offsetSeconds, onError);
    }
    this.active.onended = onEnded;
  }

  private clamp(seconds: number) {
    return Math.min(Math.max(0, seconds), Number.isFinite(this.active.duration) ? Math.max(0, this.active.duration - 0.2) : seconds);
  }

  private absoluteUrl(url: string) { return new URL(url, document.baseURI).toString(); }
}
