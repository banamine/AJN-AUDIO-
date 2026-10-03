export const BARS = 32;

/** Calm decorative bar height (0..1) used when no real spectrum is available. */
export function decorativeLevel(index: number, time: number) {
  const phase = index * 0.61;
  const wave = Math.sin(time * 1.7 + phase) * 0.5 + Math.sin(time * 2.9 + phase * 1.9) * 0.3 + Math.sin(time * 0.8 + phase * 0.5) * 0.2;
  const envelope = 0.55 + 0.45 * Math.sin((index / (BARS - 1)) * Math.PI); // tallest in the middle
  return Math.max(0.06, (wave * 0.5 + 0.5) * envelope);
}

