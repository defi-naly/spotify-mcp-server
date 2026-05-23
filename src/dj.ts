import { z } from 'zod';
import { getTrackBpm } from './bpm.js';
import { addTracksToPlaylistCore, createPlaylistCore } from './play.js';
import { getSimilarArtists } from './similar.js';
import type { SpotifyHandlerExtra, tool } from './types.js';
import { spotifyFetch } from './utils.js';

interface SpotifyArtistRef {
  id: string;
  name: string;
}

interface SpotifyTrackFull {
  id: string;
  name: string;
  artists: SpotifyArtistRef[];
  duration_ms: number;
  external_ids?: { isrc?: string };
}

async function fetchTrack(trackId: string): Promise<SpotifyTrackFull> {
  return spotifyFetch<SpotifyTrackFull>(`tracks/${trackId}`);
}

async function fetchArtistTopTracks(
  artistId: string,
  market: string,
): Promise<SpotifyTrackFull[]> {
  const data = await spotifyFetch<{ tracks: SpotifyTrackFull[] }>(
    `artists/${artistId}/top-tracks`,
    { query: { market } },
  );
  return data.tracks ?? [];
}

async function searchArtistByName(
  name: string,
): Promise<SpotifyArtistRef | null> {
  const data = await spotifyFetch<{
    artists?: { items?: SpotifyArtistRef[] };
  }>('search', {
    query: { q: name, type: 'artist', limit: 1 },
  });
  return data.artists?.items?.[0] ?? null;
}

// Half-time / double-time matches are musically compatible for DJ mixing.
function bpmWithinTolerance(
  candidate: number,
  seed: number,
  tolerance: number,
): boolean {
  return (
    Math.abs(candidate - seed) <= tolerance ||
    Math.abs(candidate - seed * 2) <= tolerance ||
    Math.abs(candidate - seed / 2) <= tolerance
  );
}

const getTrackBpmTool: tool<{ trackId: z.ZodString }> = {
  name: 'getTrackBpm',
  description:
    'Look up the BPM (tempo) of a Spotify track via getsongbpm.com, with AcousticBrainz fallback by ISRC. Requires getSongBpmApiKey in config (and optionally nothing for AcousticBrainz).',
  schema: { trackId: z.string().describe('The Spotify track ID') },
  handler: async ({ trackId }, _extra: SpotifyHandlerExtra) => {
    try {
      const track = await fetchTrack(trackId);
      const artist = track.artists[0]?.name ?? '';
      const result = await getTrackBpm(
        artist,
        track.name,
        track.external_ids?.isrc,
      );
      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: `No BPM found for "${track.name}" by ${artist}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `${result.bpm} BPM — "${track.name}" by ${artist} (source: ${result.source})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error looking up BPM: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getSimilarArtistsForTrack: tool<{
  trackId: z.ZodString;
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getSimilarArtistsForTrack',
  description:
    "Get artists similar to a Spotify track's primary artist via Last.fm. Requires lastFmApiKey in config.",
  schema: {
    trackId: z.string().describe('The Spotify track ID'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('How many similar artists to return (default 20)'),
  },
  handler: async ({ trackId, limit = 20 }, _extra: SpotifyHandlerExtra) => {
    try {
      const track = await fetchTrack(trackId);
      const primary = track.artists[0];
      if (!primary) {
        return {
          content: [{ type: 'text', text: 'Track has no primary artist' }],
        };
      }
      const similar = await getSimilarArtists(primary.name, limit);
      if (similar.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No similar artists found for ${primary.name}`,
            },
          ],
        };
      }
      const lines = similar.map(
        (a, i) =>
          `${i + 1}. ${a.name}${a.match ? ` (match ${a.match.toFixed(2)})` : ''}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: `# Artists similar to ${primary.name}\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching similar artists: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getArtistTopTracksTool: tool<{
  artistId: z.ZodString;
  market: z.ZodOptional<z.ZodString>;
}> = {
  name: 'getArtistTopTracks',
  description: "Get an artist's top tracks on Spotify (up to 10)",
  schema: {
    artistId: z.string().describe('The Spotify artist ID'),
    market: z
      .string()
      .length(2)
      .optional()
      .describe('ISO 3166-1 alpha-2 market code (defaults to US)'),
  },
  handler: async ({ artistId, market = 'US' }, _extra: SpotifyHandlerExtra) => {
    try {
      const tracks = await fetchArtistTopTracks(artistId, market);
      if (tracks.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No top tracks found for this artist' },
          ],
        };
      }
      const lines = tracks.map((t, i) => {
        const artists = t.artists.map((a) => a.name).join(', ');
        return `${i + 1}. "${t.name}" by ${artists} - ID: ${t.id}`;
      });
      return {
        content: [
          {
            type: 'text',
            text: `# Top tracks (market: ${market})\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching top tracks: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const buildBpmMatchedPlaylist: tool<{
  seedTrackId: z.ZodString;
  playlistName: z.ZodString;
  bpmTolerance: z.ZodOptional<z.ZodNumber>;
  targetSize: z.ZodOptional<z.ZodNumber>;
  similarArtistLimit: z.ZodOptional<z.ZodNumber>;
  market: z.ZodOptional<z.ZodString>;
  isPublic: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'buildBpmMatchedPlaylist',
  description:
    'Build a Spotify playlist of tracks BPM-matched to a seed track, sourced from artists similar to the seed artist. Half- and double-time matches are accepted. Requires getSongBpmApiKey and lastFmApiKey in config.',
  schema: {
    seedTrackId: z.string().describe('The Spotify track ID to seed from'),
    playlistName: z.string().describe('Name for the new playlist'),
    bpmTolerance: z
      .number()
      .min(0)
      .max(20)
      .optional()
      .describe('BPM tolerance window (default 5)'),
    targetSize: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Target playlist size (default 30)'),
    similarArtistLimit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('How many similar artists to pull from (default 20)'),
    market: z
      .string()
      .length(2)
      .optional()
      .describe('ISO market code for top-tracks lookup (default US)'),
    isPublic: z
      .boolean()
      .optional()
      .describe('Whether to create the playlist as public (default false)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const {
      seedTrackId,
      playlistName,
      bpmTolerance = 5,
      targetSize = 30,
      similarArtistLimit = 20,
      market = 'US',
      isPublic = false,
    } = args;

    try {
      // 1. Seed
      const seed = await fetchTrack(seedTrackId);
      const seedArtist = seed.artists[0];
      if (!seedArtist) throw new Error('Seed track has no primary artist');
      const seedBpmResult = await getTrackBpm(
        seedArtist.name,
        seed.name,
        seed.external_ids?.isrc,
      );
      if (!seedBpmResult) {
        return {
          content: [
            {
              type: 'text',
              text: `Couldn't find BPM for seed "${seed.name}" — can't filter without it. Try a different seed or add BPM data.`,
            },
          ],
        };
      }
      const seedBpm = seedBpmResult.bpm;

      // 2. Similar artists
      const similar = await getSimilarArtists(
        seedArtist.name,
        similarArtistLimit,
      );

      // 3. Resolve each similar artist to a Spotify ID + fetch their top tracks
      const candidates: SpotifyTrackFull[] = [];
      // Include the seed artist's own top tracks too — common mixing pattern.
      const seedTopTracks = await fetchArtistTopTracks(seedArtist.id, market);
      candidates.push(...seedTopTracks);

      for (const s of similar) {
        const resolved = await searchArtistByName(s.name);
        if (!resolved) continue;
        const top = await fetchArtistTopTracks(resolved.id, market);
        candidates.push(...top);
      }

      // 4. Dedupe candidates, exclude seed itself
      const byId = new Map<string, SpotifyTrackFull>();
      for (const c of candidates) {
        if (!c?.id || c.id === seed.id) continue;
        if (!byId.has(c.id)) byId.set(c.id, c);
      }

      // 5. BPM-filter
      const matched: Array<{
        track: SpotifyTrackFull;
        bpm: number;
      }> = [];
      let missingBpm = 0;
      const bpmHistogram = new Map<number, number>();

      for (const track of byId.values()) {
        if (matched.length >= targetSize) break;
        const artistName = track.artists[0]?.name ?? '';
        const lookup = await getTrackBpm(
          artistName,
          track.name,
          track.external_ids?.isrc,
        );
        if (!lookup) {
          missingBpm++;
          continue;
        }
        if (bpmWithinTolerance(lookup.bpm, seedBpm, bpmTolerance)) {
          matched.push({ track, bpm: lookup.bpm });
          bpmHistogram.set(lookup.bpm, (bpmHistogram.get(lookup.bpm) ?? 0) + 1);
        }
      }

      if (matched.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No tracks matched within ±${bpmTolerance} BPM of ${seedBpm}. Checked ${byId.size} candidates, ${missingBpm} missing BPM data. Try a wider tolerance.`,
            },
          ],
        };
      }

      // 6. Create playlist + add tracks
      const description = `BPM-matched to "${seed.name}" by ${seedArtist.name} (seed ${seedBpm} BPM, tolerance ±${bpmTolerance}). Generated by spotify-mcp DJ tools.`;
      const playlist = await createPlaylistCore({
        name: playlistName,
        description,
        isPublic,
      });

      await addTracksToPlaylistCore({
        playlistId: playlist.id,
        trackIds: matched.map((m) => m.track.id),
      });

      // 7. Summary
      const histLines = [...bpmHistogram.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bpm, count]) => `  ${bpm} BPM: ${count}`)
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text:
              `# Playlist created: "${playlistName}"\n\n` +
              `**URL**: ${playlist.external_urls.spotify}\n` +
              `**Seed**: "${seed.name}" by ${seedArtist.name} @ ${seedBpm} BPM\n` +
              `**Tolerance**: ±${bpmTolerance} BPM (half/double-time also accepted)\n` +
              `**Candidates checked**: ${byId.size}\n` +
              `**Missing BPM data**: ${missingBpm}\n` +
              `**Matched & added**: ${matched.length}\n\n` +
              `**BPM distribution**:\n${histLines}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error building playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

export const djTools = [
  getTrackBpmTool,
  getSimilarArtistsForTrack,
  getArtistTopTracksTool,
  buildBpmMatchedPlaylist,
];
