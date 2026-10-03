import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { decodeEntities, parseNewsDigest } from '../server/news.ts';
import { FEEDS, LIVE_CHANNELS, NEWS_URL, app, getText, refresh, refreshMinutes, store } from '../server/lite.ts';

const feedXml = (name: string) => readFileSync(new URL(`./fixtures/feeds/${name}.sample.xml`, import.meta.url), 'utf8');
const digest = {
  date: '2026-10-02', last_updated: '2026-10-02T11:51:24+00:00',
  stories: [{ id: 'a', headline: 'M&amp;S shoplifter &amp;nbsp;caught', url: 'https://example.test/a', excerpt: '<b>Hi</b>&nbsp;there', feedName: 'BBC World News', published: 'Fri, 02 Oct 2026 09:08:06 GMT' }, { id: 'bad', headline: 'No link', url: 'javascript:alert(1)' }],
  rss_feeds_articles: [
    { id: 'a', headline: 'M&amp;S shoplifter caught', url: 'https://example.test/a', feedName: 'BBC World News', published: 'Fri, 02 Oct 2026 09:08:06 GMT' },
    { id: 'c', headline: 'Second', url: 'https://example.test/c', feedName: 'Hot Air', published: 'Fri, 02 Oct 2026 10:00:00 GMT' },
  ],
};

test('news digest: entities decoded, tags stripped, unsafe or link-less items dropped, grouped by source', () => {
  assert.equal(decodeEntities('M&amp;S&nbsp;&#8217;x&#x41;'), 'M&S ’xA');
  const parsed = parseNewsDigest(digest);
  assert.equal(parsed.top.length, 1);
  assert.equal(parsed.top[0].title, 'M&S shoplifter caught');
  assert.equal(parsed.top[0].excerpt, 'Hi there');
  assert.deepEqual(parsed.bySource.map(group => group.source), ['BBC World News', 'Hot Air']);
  assert.throws(() => parseNewsDigest({ stories: [], rss_feeds_articles: [] }));
  assert.throws(() => parseNewsDigest('nope'));
});

test('lite server: serves episodes and news from fetched sources, isolates a failing feed, keeps old data on failure', async () => {
  const files: Record<string, string> = { 'Alex.xml': feedXml('Alex'), 'WarRoom.xml': feedXml('WarRoom'), 'SundayLive.xml': feedXml('SundayLive'), 'AJNHourlyAudio.xml': feedXml('AJNHourlyAudio') };
  let broken = false;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === NEWS_URL) return new Response(JSON.stringify(digest), { status: 200 });
    const name = url.split('/').pop()!;
    if (broken && name === 'WarRoom.xml') return new Response('nope', { status: 500 });
    return files[name] ? new Response(files[name], { status: 200 }) : new Response('missing', { status: 404 });
  }) as typeof fetch;

  await refresh(fetchImpl);
  const total = store.episodes.length;
  assert.ok(total > 0);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const channels = await (await fetch(`${base}/api/channels`)).json() as { channels: Array<{ slug: string; type: string }> };
    assert.deepEqual(channels.channels.filter(channel => channel.type === 'on_demand').map(channel => channel.slug).sort(), ['ajn-exclusive', 'ajn-radio']);
    const live = (channels.channels as Array<{ slug: string; type: string; streamUrl: string | null; name: string }>).filter(channel => channel.type === 'live');
    assert.deepEqual(live.map(channel => channel.name), ['Alex Jones Show (AAC)', 'Alex Jones Show (MP3)', 'Alex Jones Show (OPUS)', 'Alex Jones Show (alternate AAC)', 'War Room with Harrison Smith', 'Network Feed - All Live Shows']);
    assert.ok(live.every((channel, index) => channel.streamUrl === LIVE_CHANNELS[index].url && channel.streamUrl.startsWith('https://')));
    const nowPlaying = await fetch(`${base}/api/channels/live-warroom/now-playing`);
    assert.deepEqual([nowPlaying.status, (await nowPlaying.json() as { type: string; title: unknown }).title], [200, null]); // nothing invented
    assert.equal((await fetch(`${base}/api/channels/live-warroom/events`)).status, 204);
    assert.equal((await fetch(`${base}/api/channels/ajn-radio/now-playing`)).status, 404);
    assert.equal((await fetch(`${base}/api/channels/live-warroom/episodes`)).status, 404);
    const page = await (await fetch(`${base}/api/channels/ajn-radio/episodes?limit=5`)).json() as { episodes: Array<{ audioUrl: string; airDate: string | null; title: string }>; nextCursor: string | null };
    assert.equal(page.episodes.length, 5);
    assert.ok(page.episodes.every(episode => episode.audioUrl.startsWith('https://archive.alexjoneslive.com/')));
    assert.ok(page.nextCursor);
    const second = await (await fetch(`${base}/api/channels/ajn-radio/episodes?limit=5&cursor=${page.nextCursor}`)).json() as { episodes: Array<{ title: string }> };
    assert.ok(second.episodes.length > 0 && second.episodes[0].title !== page.episodes[0].title);
    assert.equal((await fetch(`${base}/api/channels/ajn-radio/episodes?type=bogus`)).status, 400);
    assert.equal((await fetch(`${base}/api/channels/nope/episodes`)).status, 404);
    assert.equal((await fetch(`${base}/api/channels/ajn-radio/episodes?cursor=does-not-exist`)).status, 400);
    const healthy = await (await fetch(`${base}/api/health`)).json() as { status: string; content: string; failing: string[] };
    assert.deepEqual([healthy.status, healthy.content, healthy.failing], ['ok', 'ok', []]);
    const facets = await (await fetch(`${base}/api/channels/ajn-radio/episodes/facets`)).json() as { facets: Array<{ count: number }> };
    assert.ok(facets.facets.length > 0);
    const news = await (await fetch(`${base}/api/news`)).json() as { top: Array<{ title: string }>; fetchedAt: string | null; stale: boolean };
    assert.ok(news.fetchedAt && news.stale === false);
    assert.equal(news.top[0].title, 'M&S shoplifter caught');
    assert.equal((await fetch(`${base}/api/health`)).headers.get('x-robots-tag'), 'noindex, nofollow');

    broken = true; // one feed fails: its previous episodes stay, the others still refresh, status says so
    await refresh(fetchImpl);
    assert.equal(store.episodes.length, total);
    const sources = await (await fetch(`${base}/api/sources`)).json() as { sources: Array<{ slug: string; lastStatus: string; lastError: string | null }> };
    assert.equal(sources.sources.find(source => source.slug === 'ajn-warroom')?.lastStatus, 'error');
    assert.equal(sources.sources.find(source => source.slug === 'ajn-alex')?.lastStatus, 'ok');
    const degraded = await (await fetch(`${base}/api/health`)).json() as { status: string; content: string; failing: string[] };
    assert.deepEqual([degraded.status, degraded.content, degraded.failing], ['ok', 'degraded', ['ajn-warroom']]); // liveness stays ok, content says degraded
    assert.ok(FEEDS.length === 4);
  } finally { server.close(); server.closeAllConnections?.(); }
});

test('config and limits: invalid REFRESH_MINUTES falls back, https-only links, oversized bodies are cut off while streaming', async () => {
  assert.equal(refreshMinutes(undefined), 15);
  assert.equal(refreshMinutes('abc'), 15);
  assert.equal(refreshMinutes('0'), 15);
  assert.equal(refreshMinutes('99999'), 15);
  assert.equal(refreshMinutes('5'), 5);
  const parsed = parseNewsDigest({ stories: [{ id: 'h', headline: 'Plain http', url: 'http://example.test/h' }, { id: 's', headline: 'Secure', url: 'https://example.test/s' }] });
  assert.deepEqual(parsed.top.map(item => item.id), ['s']);
  const big = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600)); controller.enqueue(new Uint8Array(600)); controller.close(); } }), { status: 200 })) as typeof fetch;
  await assert.rejects(getText('https://rss.alexjones.media/x.xml', big, 1000), /too large/);
  const small = (async () => new Response('hello', { status: 200 })) as typeof fetch;
  assert.equal(await getText('https://rss.alexjones.media/x.xml', small, 1000), 'hello');
});
