import type { Segment } from './playerStore';

export type LiveStatus = 'connecting' | 'playing' | 'reconnecting';
export type LiveHandlers = { onStatus?: (status: LiveStatus) => void; onGiveUp?: () => void };
export type EngineTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  random: () => number;
};

export const MAX_LIVE_RECONNECT_ATTEMPTS = 8;
/**
 * Hosts verified to send `Access-Control-Allow-Origin: *`. Only these live streams are loaded in CORS mode so the
 * spectrum can read them; setting crossOrigin on a host without that header would stop the audio from loading at all.
 */
export const CORS_LIVE_HOSTS: ReadonlySet<string> = new Set(['stream.alexjones.media']);
type CapturableElement = HTMLAudioElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
const captureOf = (element: HTMLAudioElement) => { const capturable = element as CapturableElement; return capturable.captureStream ?? capturable.mozCaptureStream; };

export function liveUsesCors(url: string, canCapture: boolean, base = 'https://example.invalid/') {
  if (!canCapture) return false;
  try { return CORS_LIVE_HOSTS.has(new URL(url, base).hostname); } catch { return false; }
}
export const LIVE_STALL_TIMEOUT_MS = 10_000;

/** Exponential backoff with jitter for reconnecting a dropped live stream. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random) {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  return Math.round(base * (0.75 + random() * 0.5));
}

type LiveSession = {
  url: string;
  handlers: LiveHandlers;
  element: HTMLAudioElement;
  attempt: number;
  cors: boolean;
  retryTimer: unknown;
  stallTimer: unknown;
  remove: () => void;
};

const defaultTimers: EngineTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export class RadioAudioEngine {
  private active: HTMLAudioElement;
  private warm: HTMLAudioElement;
  private volume = 0.72;
  private warmedUrl: string | null = null;
  private live: LiveSession | null = null;
  private timers: EngineTimers;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private tap: { session: LiveSession; node: MediaStreamAudioSourceNode } | null = null;

  constructor(active: HTMLAudioElement, warm: HTMLAudioElement, timers: Partial<EngineTimers> = {}) {
    this.active = active;
    this.warm = warm;
    this.timers = { ...defaultTimers, ...timers };
    this.active.preload = 'auto';
    this.warm.preload = 'auto';
  }

  setVolume(volume: number) {
    this.volume = Math.min(1, Math.max(0, volume));
    this.active.volume = this.volume;
    this.warm.volume = this.volume;
  }

  pause() {
    this.stopLive();
    this.active.pause();
  }

  /**
   * Plays a live stream and keeps it alive: errors, unexpected ends, and stalls longer than
   * LIVE_STALL_TIMEOUT_MS trigger a reconnect with backoff. Every call reloads the stream so
   * that resuming after a pause returns to the live edge instead of replaying a stale buffer.
   */
  playStream(url: string, handlers: LiveHandlers = {}) {
    this.beginLive(url, handlers);
    handlers.onStatus?.('connecting');
    return this.loadLive(this.live!);
  }

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
    this.stopLive();
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

  /**
   * A read-only spectrum tap for the live stream that is playing, or null when none is available (recorded audio,
   * a host without CORS, a browser without captureStream, or playback not started yet). It listens to a copy of the
   * element's output and is never connected to the speakers, so it cannot change what the listener hears.
   */
  getAnalyser(): AnalyserNode | null {
    const session = this.live;
    if (!session || !session.cors || session.element.paused) return null;
    if (this.tap?.session === session) return this.analyser;
    this.dropTap();
    try {
      const capture = captureOf(session.element);
      const Context = globalThis.AudioContext;
      if (!capture || !Context) return null;
      const stream = capture.call(session.element);
      if (stream.getAudioTracks().length === 0) return null; // tracks appear once playback has really started; try again next frame
      this.audioContext ??= new Context();
      if (this.audioContext.state === 'suspended') void this.audioContext.resume().catch(() => undefined);
      this.analyser ??= Object.assign(this.audioContext.createAnalyser(), { fftSize: 256, smoothingTimeConstant: 0.82 });
      const node = this.audioContext.createMediaStreamSource(stream);
      node.connect(this.analyser);
      this.tap = { session, node };
      return this.analyser;
    } catch { return null; }
  }

  private dropTap() {
    try { this.tap?.node.disconnect(); } catch { /* already disconnected */ }
    this.tap = null;
  }

  dispose() {
    this.stopLive();
    this.dropTap();
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.analyser = null;
    this.active.pause();
    this.warm.pause();
    this.active.onloadedmetadata = null;
    this.active.onended = null;
  }

  private beginLive(url: string, handlers: LiveHandlers) {
    this.stopLive();
    const element = this.active;
    element.onended = null;
    const session: LiveSession = { url, handlers, element, attempt: 0, cors: liveUsesCors(url, Boolean(captureOf(element)), document.baseURI), retryTimer: null, stallTimer: null, remove: () => undefined };
    const clearStall = () => {
      if (session.stallTimer === null) return;
      this.timers.clearTimeout(session.stallTimer);
      session.stallTimer = null;
    };
    const onPlaying = () => { clearStall(); session.attempt = 0; handlers.onStatus?.('playing'); };
    const onTrouble = () => this.retryLive(session);
    const onStall = () => {
      if (session.stallTimer !== null) return;
      session.stallTimer = this.timers.setTimeout(() => { session.stallTimer = null; this.retryLive(session); }, LIVE_STALL_TIMEOUT_MS);
    };
    const listeners: Array<[string, () => void]> = [
      ['playing', onPlaying], ['timeupdate', clearStall], ['error', onTrouble],
      ['ended', onTrouble], ['stalled', onStall], ['waiting', onStall],
    ];
    for (const [type, listener] of listeners) element.addEventListener(type, listener);
    session.remove = () => { for (const [type, listener] of listeners) element.removeEventListener(type, listener); };
    this.live = session;
  }

  private stopLive() {
    const session = this.live;
    if (!session) return;
    this.live = null;
    this.dropTap();
    session.remove();
    if (session.retryTimer !== null) this.timers.clearTimeout(session.retryTimer);
    if (session.stallTimer !== null) this.timers.clearTimeout(session.stallTimer);
  }

  private retryLive(session: LiveSession) {
    if (this.live !== session || session.retryTimer !== null) return;
    if (session.stallTimer !== null) { this.timers.clearTimeout(session.stallTimer); session.stallTimer = null; }
    if (session.attempt >= MAX_LIVE_RECONNECT_ATTEMPTS) {
      const giveUp = session.handlers.onGiveUp;
      this.stopLive();
      giveUp?.();
      return;
    }
    if (session.attempt >= 1) session.cors = false; // still failing: fall back to plain playback (no spectrum) rather than risk a CORS-blocked load
    session.handlers.onStatus?.('reconnecting');
    const delay = reconnectDelayMs(session.attempt++, this.timers.random);
    session.retryTimer = this.timers.setTimeout(() => {
      session.retryTimer = null;
      if (this.live !== session) return;
      void this.loadLive(session).catch(() => this.retryLive(session));
    }, delay);
  }

  private loadLive(session: LiveSession) {
    const element = session.element;
    element.onended = null;
    element.onloadedmetadata = null;
    element.removeAttribute('src'); // drop the stale buffer so playback resumes at the live edge
    element.load();
    this.dropTap();
    this.setCors(element, session.cors);
    element.src = this.absoluteUrl(session.url);
    element.load();
    element.volume = this.volume;
    return element.play();
  }

  private setCors(element: HTMLAudioElement, enabled: boolean) {
    if (enabled) element.crossOrigin = 'anonymous';
    else element.removeAttribute('crossorigin');
  }

  private playUrl(url: string) {
    this.stopLive();
    this.setCors(this.active, false);
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
    this.setCors(this.active, false);
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
    this.setCors(this.active, false);
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
    this.stopLive();
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
