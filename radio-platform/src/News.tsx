import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';

export type NewsItem = { id: string; title: string; url: string; source: string; excerpt: string | null; publishedAt: string | null };
export type NewsDigest = { date: string | null; updatedAt: string | null; top: NewsItem[]; bySource: Array<{ source: string; items: NewsItem[] }> };
type NewsState = { status: 'loading' | 'ready' | 'error'; digest: NewsDigest | null };

/** Loads /api/news and refreshes it every 10 minutes. Failures keep the last good digest. */
export function useNews(): NewsState {
  const [state, setState] = useState<NewsState>({ status: 'loading', digest: null });
  useEffect(() => {
    let mounted = true;
    const load = () => fetch('/api/news').then(response => { if (!response.ok) throw new Error('News unavailable'); return response.json() as Promise<NewsDigest>; })
      .then(digest => { if (mounted) setState({ status: 'ready', digest }); })
      .catch(error => { console.error('News request failed', error); if (mounted) setState(current => ({ status: current.digest ? 'ready' : 'error', digest: current.digest })); });
    void load();
    const timer = setInterval(() => { void load(); }, 10 * 60_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  return state;
}

function timeLabel(iso: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function NewsTicker({ news }: { news: NewsState }) {
  const items = news.digest?.top ?? [];
  if (!items.length) return null;
  const row = (suffix: string) => items.map(item => <a key={`${item.id}${suffix}`} className="ticker-item" href={item.url} target="_blank" rel="noopener noreferrer"><b>{item.source}</b>{item.title}</a>);
  return <div className="news-ticker" role="region" aria-label="News headlines">
    <span className="ticker-label">NEWS</span>
    <div className="ticker-window"><div className="ticker-track">{row('')}<span aria-hidden="true" className="ticker-copy">{row('-copy')}</span></div></div>
  </div>;
}

export function NewsSection({ news }: { news: NewsState }) {
  const [source, setSource] = useState<string | null>(null);
  const digest = news.digest;
  const items = useMemo(() => !digest ? [] : source ? digest.bySource.find(group => group.source === source)?.items ?? [] : digest.top, [digest, source]);
  return <section className="news-section" id="news">
    <div className="section-heading"><div><div className="section-label">{digest?.date ? `THE DAILY BRIEFING · ${digest.date}` : 'THE DAILY BRIEFING'}</div><h2>Read the <em>news.</em></h2></div></div>
    {news.status === 'loading' && <p className="catalog-status" role="status">Loading news…</p>}
    {news.status === 'error' && <p className="catalog-status" role="status">The news could not be loaded right now.</p>}
    {digest && <>
      <div className="episode-filters" role="group" aria-label="News sources">
        <button type="button" aria-pressed={source === null} className={`filter-chip ${source === null ? 'selected' : ''}`} onClick={() => setSource(null)}>TOP STORIES</button>
        {digest.bySource.map(group => <button key={group.source} type="button" aria-pressed={source === group.source} className={`filter-chip ${source === group.source ? 'selected' : ''}`} onClick={() => setSource(group.source)}>{group.source.toUpperCase()}</button>)}
      </div>
      <div className="news-grid">{items.map(item => <a key={item.id} className="news-card" href={item.url} target="_blank" rel="noopener noreferrer">
        <span className="news-meta">{item.source.toUpperCase()}{item.publishedAt ? ` · ${timeLabel(item.publishedAt)}` : ''}</span>
        <span className="news-title">{item.title}<ArrowUpRight size={14} aria-hidden="true"/></span>
        {item.excerpt && <span className="news-excerpt">{item.excerpt}</span>}
      </a>)}</div>
    </>}
  </section>;
}
