// Daily News Digest: normalizes the published digest JSON into plain headlines for the ticker and news list.
export type NewsItem = { id: string; title: string; url: string; source: string; excerpt: string | null; publishedAt: string | null };
export type NewsDigest = { date: string | null; updatedAt: string | null; top: NewsItem[]; bySource: Array<{ source: string; items: NewsItem[] }> };

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export const decodeEntities = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
  if (body[0] === '#') { const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match; }
  return NAMED[body.toLowerCase()] ?? match;
});
const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = decodeEntities(decodeEntities(value.replace(/<[^>]*>/g, ' '))).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};
const safeUrl = (value: unknown): string | null => {
  try { const url = new URL(String(value)); return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null; } catch { return null; }
};
function toItem(raw: Record<string, unknown>): NewsItem | null {
  const title = clean(raw.headline ?? raw.title, 300);
  const url = safeUrl(raw.url ?? raw.link);
  if (!title || !url) return null; // a headline without a working link is not shown
  const published = typeof raw.published === 'string' ? new Date(raw.published) : null;
  return {
    id: String(raw.id ?? url), title, url, source: clean(raw.feedName ?? raw.feed ?? raw.author, 80) ?? 'News',
    excerpt: clean(raw.excerpt ?? raw.summary, 400), publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
  };
}

export function parseNewsDigest(json: unknown): NewsDigest {
  if (!json || typeof json !== 'object') throw new Error('news digest is not an object');
  const data = json as Record<string, unknown>;
  const list = (value: unknown) => (Array.isArray(value) ? value : []).map(entry => (entry && typeof entry === 'object' ? toItem(entry as Record<string, unknown>) : null)).filter((item): item is NewsItem => item !== null);
  const top = list(data.stories);
  const all = list(data.rss_feeds_articles);
  if (!top.length && !all.length) throw new Error('news digest had no usable stories');
  const groups = new Map<string, NewsItem[]>();
  for (const item of all.length ? all : top) groups.set(item.source, [...(groups.get(item.source) ?? []), item]);
  for (const items of groups.values()) items.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  return {
    date: typeof data.date === 'string' ? data.date : null,
    updatedAt: typeof data.last_updated === 'string' ? data.last_updated : null,
    top: top.length ? top : all.slice(0, 8),
    bySource: [...groups.entries()].map(([source, items]) => ({ source, items })),
  };
}
