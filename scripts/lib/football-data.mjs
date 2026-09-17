/**
 * Client for football-data.org (https://www.football-data.org) — built for
 * third-party developers, not a scraping target. Free tier covers exactly
 * the five leagues below for fixtures and results, rate-limited to 10
 * requests/minute (not a daily cap).
 *
 * One request per league returns that competition's full match list —
 * finished results and scheduled fixtures together — so recent team form
 * and upcoming fixtures both come from the same response. No per-team
 * calls needed, unlike API-Football.
 */

const BASE = 'https://api.football-data.org/v4';

export const COMPETITIONS = [
  { code: 'PL', name: 'Premier League', country: 'England' },
  { code: 'PD', name: 'La Liga', country: 'Spain' },
  { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
  { code: 'SA', name: 'Serie A', country: 'Italy' },
  { code: 'FL1', name: 'Ligue 1', country: 'France' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(token, path, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { headers: { 'X-Auth-Token': token } });
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`football-data.org ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return res.json();
  }
}

/**
 * @returns {{ fixtures: object[], matchesByTeam: Map<number, {venue, gf, ga}[]> }}
 */
export async function fetchCompetition(token, competition) {
  const body = await apiGet(token, `/competitions/${competition.code}/matches`);
  const matches = body.matches || [];

  const fixtures = [];
  const matchesByTeam = new Map();
  const addMatch = (teamId, entry) => {
    if (!matchesByTeam.has(teamId)) matchesByTeam.set(teamId, []);
    matchesByTeam.get(teamId).push(entry);
  };

  for (const m of matches) {
    if (m.status === 'FINISHED' && m.score?.fullTime?.home != null && m.score?.fullTime?.away != null) {
      const gh = m.score.fullTime.home;
      const ga = m.score.fullTime.away;
      addMatch(m.homeTeam.id, { venue: 'home', gf: gh, ga });
      addMatch(m.awayTeam.id, { venue: 'away', gf: ga, ga: gh });
    } else if (m.status === 'SCHEDULED' || m.status === 'TIMED') {
      fixtures.push({
        id: m.id,
        date: m.utcDate,
        league: competition.name,
        leagueCountry: competition.country,
        home: { id: m.homeTeam.id, name: m.homeTeam.name || m.homeTeam.shortName },
        away: { id: m.awayTeam.id, name: m.awayTeam.name || m.awayTeam.shortName },
      });
    }
  }

  // The API returns matches in chronological order, so the tail of each
  // team's list is already its most recent matches — cap it to keep the
  // form calculation focused on current form rather than the whole season.
  for (const [id, list] of matchesByTeam) {
    matchesByTeam.set(id, list.slice(-15));
  }

  return { fixtures, matchesByTeam };
}
