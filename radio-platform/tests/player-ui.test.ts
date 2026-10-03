import assert from 'node:assert/strict';
import test from 'node:test';
import { liveUsesCors } from '../src/audioEngine.ts';
import { sortEpisodes } from '../src/episodeSort.ts';
import { usePlayerStore, type Episode } from '../src/playerStore.ts';
import { decorativeLevel } from '../src/visualizerMath.ts';

const ep = (id: string, airDate: string | null, sizeBytes: number | null, durationSeconds: number | null = null): Episode => ({ id, title: id, audioUrl: `https://archive.alexjoneslive.com/${id}.mp3`, durationSeconds, sizeBytes, airDate });

test('sortEpisodes orders by date and by length (file size when no duration), unknown last', () => {
  const list = [ep('b', '2026-09-02', 600), ep('a', '2026-09-01', 3600), ep('c', '2026-09-03', null), ep('d', '2026-09-03', 1800)];
  assert.deepEqual(sortEpisodes(list, 'newest').map(item => item.id), ['c', 'd', 'b', 'a']);
  assert.deepEqual(sortEpisodes(list, 'oldest').map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortEpisodes(list, 'longest').map(item => item.id), ['a', 'd', 'b', 'c']);
  assert.deepEqual(sortEpisodes(list, 'shortest').map(item => item.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(list.map(item => item.id), ['b', 'a', 'c', 'd'], 'input is not mutated');
});

test('only verified CORS hosts use the spectrum tap', () => {
  assert.equal(liveUsesCors('https://stream.alexjones.media/warroom/', true), true);
  assert.equal(liveUsesCors('https://stream.alexjones.media/warroom/', false), false);
  assert.equal(liveUsesCors('https://audio.alexjoneslive.com:8443/alexjonesshow.aac', true), false);
  assert.equal(liveUsesCors('not a url', true, 'not a base'), false);
});

test('decorative levels stay within range', () => {
  for (let index = 0; index < 32; index++) for (const time of [0, 1.3, 9.9]) {
    const level = decorativeLevel(index, time);
    assert.ok(level >= 0.06 && level <= 1, `${index}@${time} = ${level}`);
  }
});

test('episode progress is remembered per episode and ignores implausible updates', () => {
  const store = usePlayerStore;
  const episode = ep('x', '2026-09-01', null, 1000);
  store.setState({ activeEpisode: episode, episodeProgress: {} });
  store.getState().setProgress(0.4, 1000);
  assert.deepEqual(store.getState().episodeProgress, {}, 'under one second is ignored');
  store.getState().setProgress(300, 5000);
  assert.deepEqual(store.getState().episodeProgress, {}, 'a stale timeupdate from a different file is ignored');
  store.getState().setProgress(300, 1000);
  assert.deepEqual(store.getState().episodeProgress.x, { position: 300, duration: 1000 });
  store.setState({ activeEpisode: null });
  store.getState().setProgress(50, 1000);
  assert.equal(Object.keys(store.getState().episodeProgress).length, 1, 'live audio (no episode) is never recorded');
});

test('feed parsing keeps the enclosure file size and ignores junk lengths', async () => {
  const { parseFeedXml } = await import('../server/sources/ajn.ts');
  const xml = `<rss><channel><item><title>a</title><guid>a</guid><enclosure url="https://archive.alexjoneslive.com/a.mp3" length="43188647" type="audio/mpeg"/></item><item><title>b</title><guid>b</guid><enclosure url="https://archive.alexjoneslive.com/b.mp3" length="oops"/></item></channel></rss>`;
  assert.deepEqual(parseFeedXml(xml).map(item => item.enclosureBytes), [43188647, null]);
});
