import { useEffect, useRef, useState } from 'react';
import { BARS, decorativeLevel } from './visualizerMath';

type VisualizerProps = {
  /** Returns the live spectrum tap when one exists (live streams on CORS-enabled hosts); null otherwise. */
  getAnalyser: () => AnalyserNode | null;
  playing: boolean;
  accent: string;
};

const SILENT_FRAMES_BEFORE_FALLBACK = 90; // about 1.5 s of all-zero data means the browser is not giving us real audio

export default function Visualizer({ getAnalyser, playing, accent }: VisualizerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'real' | 'decorative' | 'idle'>('idle');
  const latest = useRef({ getAnalyser, playing, accent });
  latest.current = { getAnalyser, playing, accent };

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const levels = new Array<number>(BARS).fill(0.06);
    let data: Uint8Array<ArrayBuffer> | null = null;
    let silentFrames = 0;
    let frame = 0;
    let shown: 'real' | 'decorative' | 'idle' = 'idle';
    let width = 0, height = 0;

    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = element.clientWidth; height = element.clientHeight;
      element.width = Math.max(1, Math.round(width * ratio)); element.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(element);

    const tick = (now: number) => {
      const { getAnalyser: analyserOf, playing: isPlaying, accent: color } = latest.current;
      let next: 'real' | 'decorative' | 'idle' = isPlaying ? 'decorative' : 'idle';
      const analyser = isPlaying && !reduced ? analyserOf() : null;
      let real: number[] | null = null;
      if (analyser) {
        if (!data || data.length !== analyser.frequencyBinCount) data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        let total = 0;
        for (const value of data) total += value;
        silentFrames = total === 0 ? silentFrames + 1 : 0;
        if (silentFrames < SILENT_FRAMES_BEFORE_FALLBACK) {
          next = 'real';
          // Speech lives in the lower bins: use the first ~70% so the right side is not always flat.
          const usable = Math.max(BARS, Math.floor(data.length * 0.7));
          real = Array.from({ length: BARS }, (_, index) => {
            const from = Math.floor((index / BARS) * usable), to = Math.max(from + 1, Math.floor(((index + 1) / BARS) * usable));
            let peak = 0;
            for (let bin = from; bin < to; bin++) peak = Math.max(peak, data![bin]);
            return peak / 255;
          });
        }
      } else silentFrames = 0;
      const seconds = now / 1000;
      for (let index = 0; index < BARS; index++) {
        const target = next === 'real' ? Math.max(0.04, real![index]) : next === 'decorative' ? decorativeLevel(index, seconds) : 0.05;
        levels[index] += (target - levels[index]) * (next === 'real' ? 0.5 : 0.12);
      }
      if (next !== shown) { shown = next; setMode(next); }
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      const slot = width / BARS, barWidth = Math.max(2, slot * 0.58);
      for (let index = 0; index < BARS; index++) {
        const barHeight = Math.max(2, levels[index] * height);
        context.globalAlpha = 0.35 + levels[index] * 0.65;
        context.fillRect(index * slot + (slot - barWidth) / 2, height - barHeight, barWidth, barHeight);
      }
      context.globalAlpha = 1;
      // Reduced motion: draw one static frame per state change instead of animating.
      if (!reduced) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [playing]);

  return <canvas ref={canvas} className="visualizer" data-mode={mode} aria-hidden="true" />;
}
