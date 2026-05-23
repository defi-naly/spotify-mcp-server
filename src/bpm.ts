import { loadSpotifyConfig } from './utils.js';

export interface BpmLookup {
  bpm: number;
  source: 'getsongbpm' | 'acousticbrainz';
}

const cache = new Map<string, BpmLookup | null>();

function cacheKey(artist: string, title: string): string {
  return `${artist.toLowerCase()}|${title.toLowerCase()}`;
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function lookupGetSongBpm(
  artist: string,
  title: string,
  apiKey: string,
): Promise<number | null> {
  const lookup = `song:${title} artist:${artist}`;
  const url = `https://api.getsongbpm.com/search/?api_key=${encodeURIComponent(
    apiKey,
  )}&type=both&lookup=${encodeURIComponent(lookup)}`;

  const data = await fetchJson<{
    search?: Array<{ tempo?: string | number }> | { error?: string };
  }>(url, {
    headers: { 'User-Agent': 'spotify-mcp-server-dj-fork/1.0' },
  });
  if (!(data && Array.isArray(data.search)) || data.search.length === 0) {
    return null;
  }
  const tempo = data.search[0]?.tempo;
  const n = typeof tempo === 'string' ? Number.parseFloat(tempo) : tempo;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

async function lookupAcousticBrainzByISRC(
  isrc: string,
): Promise<number | null> {
  // ISRC -> MusicBrainz recording MBID
  const mb = await fetchJson<{ recordings?: Array<{ id: string }> }>(
    `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(isrc)}?fmt=json`,
    { headers: { 'User-Agent': 'spotify-mcp-server-dj-fork/1.0' } },
  );
  const mbid = mb?.recordings?.[0]?.id;
  if (!mbid) return null;

  // MBID -> AcousticBrainz low-level features
  // AcousticBrainz stopped accepting new submissions ~2022 but data remains
  // available for archived MBIDs. Coverage is patchy for newer tracks.
  const ab = await fetchJson<{ rhythm?: { bpm?: number } }>(
    `https://acousticbrainz.org/${mbid}/low-level`,
  );
  const bpm = ab?.rhythm?.bpm;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return null;
  return Math.round(bpm);
}

export async function getTrackBpm(
  artist: string,
  title: string,
  isrc?: string,
): Promise<BpmLookup | null> {
  const key = cacheKey(artist, title);
  if (cache.has(key)) return cache.get(key) ?? null;

  const config = loadSpotifyConfig();
  let result: BpmLookup | null = null;

  if (config.getSongBpmApiKey) {
    const bpm = await lookupGetSongBpm(artist, title, config.getSongBpmApiKey);
    if (bpm !== null) result = { bpm, source: 'getsongbpm' };
  }

  if (!result && isrc) {
    const bpm = await lookupAcousticBrainzByISRC(isrc);
    if (bpm !== null) result = { bpm, source: 'acousticbrainz' };
  }

  cache.set(key, result);
  return result;
}

// Exposed for the orchestrator so it can prime / inspect the cache.
export function bpmCacheStats(): { entries: number; hits: number } {
  let hits = 0;
  for (const v of cache.values()) if (v) hits++;
  return { entries: cache.size, hits };
}
