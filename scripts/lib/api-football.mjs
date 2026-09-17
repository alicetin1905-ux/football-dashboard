/**
 * Client for API-Football, direct from API-SPORTS (https://dashboard.api-football.com),
 * not through the RapidAPI marketplace — one unambiguous provider, no risk of
 * subscribing to a different, similarly-named API by mistake (as happened
 * with a SofaScore-wrapper API found while searching RapidAPI's hub).
 *
 * The key still lives in the RAPIDAPI_KEY secret/env var for continuity with
 * the rest of this project, even though it's now an api-football.com key,
 * sent as x-apisports-key rather than the RapidAPI headers.
 *
 * Free tier is ~100 requests/day, so keep FOOTBALL_NEXT and FOOTBALL_RECENT
 * modest — five leagues × ~10 teams with fixtures in the window is already
 * 40-60 calls per refresh.
 */

const BASE = 'https://v3.football.api-sports.io';

export const LEAGUES = [
  { id: 39, name: 'Premier League', country: 'England' },
  { id: 140, name: 'La Liga', country: 'Spain' },
  { id: 78, name: 'Bundesliga', country: 'Germany' },
  { id: 135, name: 'Serie A', country: 'Italy' },
  { id: 61, name: 'Ligue 1', country: 'France' },
];

/** European season labels run by start year (e.g. "2025" for 2025/26). */
export function currentSeason(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month >= 7 ? year : year - 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retries on 429 with backoff, in case the free tier throttles request bursts. */
async function apiGet(key, path, params, retries = 3) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'x-apisports-key': key },
    });
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`API-Football ${path} -> HTTP ${res.status}`);
    const body = await res.json();
    const errCount = Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors || {}).length;
    if (errCount) throw new Error(`API-Football ${path} -> ${JSON.stringify(body.errors)}`);
    return body.response;
  }
}

export async function fetchUpcomingFixtures(key, { leagueId, season, next = 10 }) {
  const rows = await apiGet(key, '/fixtures', { league: leagueId, season, next });
  return rows.map((r) => ({
    id: r.fixture.id,
    date: r.fixture.date,
    league: r.league.name,
    leagueCountry: r.league.country,
    home: { id: r.teams.home.id, name: r.teams.home.name },
    away: { id: r.teams.away.id, name: r.teams.away.name },
  }));
}

/** Recent finished matches for one team, normalised to {venue, gf, ga}. */
export async function fetchRecentMatches(key, teamId, last = 10) {
  const rows = await apiGet(key, '/fixtures', { team: teamId, last });
  return rows
    .filter((r) => r.fixture.status?.short === 'FT')
    .map((r) => {
      const isHome = r.teams.home.id === teamId;
      const gf = isHome ? r.goals.home : r.goals.away;
      const ga = isHome ? r.goals.away : r.goals.home;
      return { venue: isHome ? 'home' : 'away', gf, ga };
    })
    .filter((m) => m.gf != null && m.ga != null);
}
