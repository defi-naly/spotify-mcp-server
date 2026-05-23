import { loadSpotifyConfig } from './utils.js';

export interface SimilarArtist {
  name: string;
  mbid?: string;
  match: number; // 0..1, Last.fm "match" score
}

export interface ArtistTag {
  name: string;
  count: number;
}

const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';

async function lastFm<T>(params: Record<string, string>): Promise<T | null> {
  const config = loadSpotifyConfig();
  if (!config.lastFmApiKey) {
    throw new Error(
      'Last.fm API key not configured. Add lastFmApiKey to spotify-config.json (signup: https://www.last.fm/api/account/create).',
    );
  }
  const qs = new URLSearchParams({
    ...params,
    api_key: config.lastFmApiKey,
    format: 'json',
  });
  try {
    const res = await fetch(`${LASTFM_BASE}?${qs.toString()}`, {
      headers: { 'User-Agent': 'spotify-mcp-server-dj-fork/1.0' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getSimilarArtists(
  artistName: string,
  limit = 20,
): Promise<SimilarArtist[]> {
  const data = await lastFm<{
    similarartists?: {
      artist?: Array<{
        name: string;
        mbid?: string;
        match?: string;
      }>;
    };
  }>({
    method: 'artist.getSimilar',
    artist: artistName,
    limit: String(limit),
    autocorrect: '1',
  });
  const arr = data?.similarartists?.artist ?? [];
  return arr.map((a) => ({
    name: a.name,
    mbid: a.mbid || undefined,
    match: a.match ? Number.parseFloat(a.match) : 0,
  }));
}

export async function getArtistTopTags(
  artistName: string,
): Promise<ArtistTag[]> {
  const data = await lastFm<{
    toptags?: {
      tag?: Array<{ name: string; count?: number | string }>;
    };
  }>({
    method: 'artist.getTopTags',
    artist: artistName,
    autocorrect: '1',
  });
  const arr = data?.toptags?.tag ?? [];
  return arr.map((t) => ({
    name: t.name,
    count:
      typeof t.count === 'string'
        ? Number.parseInt(t.count, 10)
        : (t.count ?? 0),
  }));
}
