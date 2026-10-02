import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';

export async function seedDemoData(prisma: PrismaClient) {
  const afterHours = await prisma.channel.upsert({
    where: { slug: 'after-hours' },
    update: {},
    create: {
      slug: 'after-hours', name: 'After Hours', genre: 'Jazz · Soul · Downtempo', city: 'Brooklyn, NY', frequency: '88.7',
      description: 'A late-night, always-on broadcast, shared by every listener.', type: 'SIMULATED', cycleStart: new Date('2026-09-28T00:00:00.000Z'),
    },
  });
  const tracks = [
    ['Blue in Green', 'Miles Davis', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 372],
    ['Peace Piece', 'Bill Evans', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', 415],
    ['Open Eye Signal', 'Jon Hopkins', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', 390],
    ['The Creator Has a Master Plan', 'Pharoah Sanders', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', 426],
  ] as const;
  for (const [position, [title, artist, audioUrl, durationSeconds]] of tracks.entries()) {
    await prisma.radioSegment.upsert({
      where: { channelId_position: { channelId: afterHours.id, position } },
      update: { title, artist, audioUrl, durationSeconds },
      create: { channelId: afterHours.id, position, title, artist, audioUrl, durationSeconds },
    });
  }

  const liveStations = [
    { slug: 'daylight-fm', name: 'Daylight FM', genre: 'Indie · Electronic', city: 'Los Angeles, CA', frequency: '94.2', currentTitle: 'On the Regular', currentArtist: 'Shamir', currentAlbum: 'Ratchet', streamUrl: 'https://ice1.somafm.com/indiepop-128-mp3' },
    { slug: 'forma', name: 'Forma', genre: 'Ambient · Modern Classical', city: 'Copenhagen, DK', frequency: '101.3', currentTitle: 'Weightless', currentArtist: 'Marconi Union', currentAlbum: 'Weightless', streamUrl: 'https://ice1.somafm.com/dronezone-128-mp3' },
    { slug: 'sundown-club', name: 'Sundown Club', genre: 'Disco · House', city: 'London, UK', frequency: '107.8', currentTitle: 'Music Sounds Better With You', currentArtist: 'Stardust', currentAlbum: 'Music Sounds Better With You', streamUrl: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  ];
  for (const station of liveStations) {
    await prisma.channel.upsert({ where: { slug: station.slug }, update: station, create: { ...station, type: 'LIVE' } });
  }

  const podcasts = await prisma.channel.upsert({
    where: { slug: 'ajn-podcasts' }, update: {},
    create: { slug: 'ajn-podcasts', name: 'AJN Podcasts', genre: 'Culture · Conversations', city: 'Studio Series', frequency: 'ON DEMAND', description: 'Long-form conversations from the studio.', type: 'ON_DEMAND' },
  });
  const episodes = [
    ['The Art of Listening', 'An hour on the records that change the feeling of a room.', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', new Date('2026-09-26T18:00:00Z'), 3600],
    ['After the Last Train', 'A late-night conversation about music and memory.', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', new Date('2026-09-19T18:00:00Z'), 3600],
  ] as const;
  for (const [title, description, audioUrl, publishedAt, durationSeconds] of episodes) {
    await prisma.podcastEpisode.upsert({
      where: { id: `${podcasts.id}-${title.toLowerCase().replaceAll(' ', '-')}` }, update: {},
      create: { id: `${podcasts.id}-${title.toLowerCase().replaceAll(' ', '-')}`, channelId: podcasts.id, title, description, audioUrl, publishedAt, durationSeconds },
    });
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to seed the radio catalog');
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  try { await seedDemoData(prisma); }
  finally { await prisma.$disconnect(); }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/prisma/seed.ts')) {
  void main().catch(error => { console.error('Failed to seed radio catalog', error); process.exitCode = 1; });
}
